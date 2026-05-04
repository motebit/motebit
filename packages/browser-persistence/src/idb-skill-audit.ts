/**
 * IndexedDB-backed `SkillAuditSink` for the `skill_audit` object store.
 *
 * Same append-only shape as `IdbToolAuditSink` — different domain.
 * Holds the audit-event stream emitted by `@motebit/skills`'
 * `SkillRegistry` (`skill_trust_grant` / `skill_trust_revoke` /
 * `skill_remove`) and by `@motebit/panels`'
 * `RegistryBackedSkillsPanelAdapter` (`skill_consent_granted`). One
 * sink per surface, two emitter paths into the same store; a
 * downstream auditor querying the log sees a unified stream of
 * skill-related operator acts.
 *
 * Use case for `record` failure: the adapter emits via a try/catch;
 * the registry emits via its `audit` option. A failure in either path
 * is non-blocking — losing an audit record is better than losing the
 * user's explicit operator act. Errors propagate so callers can log;
 * persistence is best-effort, not transactional.
 */

import type { SkillAuditEvent } from "@motebit/skills";
import { idbRequest } from "./idb.js";

/**
 * Bounded preload — the panel UI reads recent events for the audit-trail
 * view; the rest stay on disk and load on demand. A surface that's been
 * running for years could accumulate many thousands of trust-grant /
 * consent-granted entries; preloading all of them on bootstrap would be
 * wasteful. 1000 is enough for any plausible visible-recent window.
 */
const PRELOAD_LIMIT = 1000;

export class IdbSkillAuditSink {
  private _entries: SkillAuditEvent[] = []; // most-recent-first

  constructor(private readonly db: IDBDatabase) {}

  /**
   * Preload the most recent entries into memory. Optional — call from
   * bootstrap so the audit-trail panel reads land synchronously. The
   * sink works without preload (writes still persist; reads return
   * what's been observed since construction).
   */
  async preload(): Promise<void> {
    const tx = this.db.transaction("skill_audit", "readonly");
    const all = (await idbRequest(tx.objectStore("skill_audit").getAll())) as SkillAuditEvent[];
    this._entries = all.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, PRELOAD_LIMIT);
  }

  /**
   * Persist a single audit event. Bound as an arrow-function field so
   * hosts can pass it directly as `audit: sink.record` without
   * `.bind(sink)` boilerplate. Both the registry's `SkillRegistryOptions`
   * and the adapter's `RegistryBackedSkillsPanelAdapterOptions` accept
   * the same `SkillAuditSink` shape, so the same reference flows into
   * both.
   *
   * Throws on IDB failure — callers (the adapter, the registry's audit
   * dispatch) catch and log so the underlying user act isn't undone.
   */
  record = async (event: SkillAuditEvent): Promise<void> => {
    // In-memory cache: insert at front for most-recent-first order.
    this._entries.unshift({ ...event });
    if (this._entries.length > PRELOAD_LIMIT) {
      this._entries.length = PRELOAD_LIMIT;
    }
    // Persist. await rather than fire-and-forget — callers want to know
    // if the write failed so they can log; the registry/adapter's
    // try-catch wraps the call site.
    const tx = this.db.transaction("skill_audit", "readwrite");
    await idbRequest(tx.objectStore("skill_audit").add({ ...event }));
  };

  /** Return the cached recent-entries window — most-recent-first. */
  getAll(): SkillAuditEvent[] {
    return [...this._entries];
  }

  /** Filter cached entries by skill name (e.g. "what acts targeted X?"). */
  querySkill(skillName: string): SkillAuditEvent[] {
    return this._entries.filter((e) => e.skill_name === skillName);
  }
}
