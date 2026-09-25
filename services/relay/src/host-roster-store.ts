/**
 * The relay's half of the machine roster: it stores and observes, and it
 * never reduces.
 *
 * `docs/doctrine/machine-roster.md`, `spec/machine-roster-v1.md` §8/§9/§11,
 * `docs/proposals/machine-roster-relay-v1.md` (the design this implements).
 *
 * The one rule: **the relay holds the signed set, verbatim, and records
 * liveness per device. It never evaluates the roster law, never decides
 * membership, and never computes a quantity over machines.** Every consumer
 * that needs "the machines of this motebit" reduces the served set itself
 * (`verifyHostRoster`) under a key chain IT verified. A relay that cannot
 * compute a roster cannot compute a wrong one — so nothing in this file
 * imports the reduction, and a test holds it to that.
 *
 * **Membership** — `relay_host_roster_entries`. What the sovereign signed,
 * stored verbatim (canonical JSON, signature included), keyed by the law's
 * entry id. Ingest checks INTEGRITY only — the strict guard and wire schema,
 * the path motebit, and the signature under the key the entry names. There
 * is deliberately NO "is this one of the motebit's keys" check: this relay
 * has no trusted key chain for most identities, and it must hold entries
 * under rotated-away keys anyway (they are how a consumer sees the machine
 * that was cut off). No freshness window; entries are never pruned.
 *
 * **Liveness** — `relay_host_liveness`. ONE overwritten `last_seen_at` per
 * `(motebit_id, device_id, bound_under)`, where `bound_under` is the key the
 * socket's token verified under, captured at verification and never
 * re-read. Written only for verified sockets announcing `unattended_runtime`,
 * only through `observeHostConnection`.
 */
import type { DatabaseDriver } from "@motebit/persistence";
import { canonicalJson } from "@motebit/encryption";
import {
  verifyHostEnrollment,
  verifyHostRetirement,
  hostEnrollmentId,
  hostRetirementId,
} from "@motebit/crypto";
import type { HostEnrollment, HostRetirement } from "@motebit/protocol";
import { HostEnrollmentSchema, HostRetirementSchema } from "@motebit/wire-schemas";

/** Entries one presentation may carry. Clients chunk a larger set (proposal D8). */
export const MAX_ROSTER_ENTRIES_PER_REQUEST = 64;
/**
 * A signer key's OWN bucket: enrolments signed by the key the caller's
 * token verified under. Only a holder of that key can fill it, so a thief
 * of an old key fills only the old key's bucket, and a rotation moves the
 * sovereign to a new, empty one (proposal D2, review F2).
 */
export const MAX_OWN_ENROLLMENTS_PER_KEY = 512;
/**
 * Retirements in a key's own bucket, counted APART from enrolments: a
 * bucket filled by a daemon minting per start must still take the
 * retirement of a stolen machine.
 */
export const MAX_OWN_RETIREMENTS_PER_KEY = 2048;
/**
 * The ONE shared foreign bucket: every entry whose signer key is not the
 * key the caller verified under. It exists to replicate the lines of other
 * epochs, and any caller can exhaust it (anyone can mint entries under a
 * fresh keypair) — the stated residual: superseded lines stop replicating
 * through this relay. An ACTIVE line is signed by the current key and so
 * never lands here from its own holders.
 */
export const MAX_FOREIGN_ENTRIES_PER_MOTEBIT = 256;
/** How long a liveness row outlives its `last_seen_at` with no live socket. */
export const HOST_LIVENESS_RETENTION_DAYS = 90;
export const HOST_LIVENESS_RETENTION_MS = HOST_LIVENESS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
/** The capability a connection announces when it hosts unattended work. */
export const HOSTS_UNATTENDED_WORK = "unattended_runtime";

export type RosterEntryKind = "enrollment" | "retirement";
export type RosterRefusalReason = "malformed" | "wrong_motebit" | "bad_signature" | "roster_full";

export interface RosterIngestResult {
  accepted: Array<{ kind: RosterEntryKind; id: string; status: "stored" | "already_held" }>;
  refused: Array<{ kind: RosterEntryKind; index: number; reason: RosterRefusalReason }>;
}

/**
 * Take the idempotent union of a presentation (spec §9, §11).
 *
 * `callerKey` is the key the caller's token verified under (auth.ts
 * `onVerified`), lowercase hex. It decides only which cap bucket an entry
 * counts against — never whether the entry's key "belongs" to the motebit.
 */
export async function ingestHostRoster(
  db: DatabaseDriver,
  motebitId: string,
  callerKey: string,
  presented: { enrollments: readonly unknown[]; retirements: readonly unknown[] },
  now: number = Date.now(),
): Promise<RosterIngestResult> {
  const result: RosterIngestResult = { accepted: [], refused: [] };
  const insert = db.prepare(
    "INSERT OR IGNORE INTO relay_host_roster_entries (motebit_id, entry_id, kind, signer_key, body_json, received_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const held = db.prepare(
    "SELECT 1 FROM relay_host_roster_entries WHERE motebit_id = ? AND entry_id = ?",
  );
  // The per-signer-key cap counts. Counted at the moment of each write,
  // not once up front: verification is awaited between entries, and
  // concurrent presentations would all work from the same stale number.
  const ownCount = db.prepare(
    "SELECT COUNT(*) AS n FROM relay_host_roster_entries WHERE motebit_id = ? AND signer_key = ? AND kind = ?",
  );
  const foreignCount = db.prepare(
    "SELECT COUNT(*) AS n FROM relay_host_roster_entries WHERE motebit_id = ? AND signer_key != ?",
  );
  const caller = callerKey.toLowerCase();

  const take = async <T extends HostEnrollment | HostRetirement>(
    kind: RosterEntryKind,
    ownCap: number,
    items: readonly unknown[],
    parse: (v: unknown) => T | null,
    verify: (v: T) => Promise<boolean>,
    idOf: (v: T) => Promise<string>,
  ): Promise<void> => {
    for (let index = 0; index < items.length; index++) {
      const artifact = parse(items[index]);
      if (artifact == null) {
        result.refused.push({ kind, index, reason: "malformed" });
        continue;
      }
      if (artifact.motebit_id !== motebitId) {
        result.refused.push({ kind, index, reason: "wrong_motebit" });
        continue;
      }
      // Verify BEFORE hold (spec §9): the id excludes the signature, so an
      // unverified copy could squat the slot and make the authentic one a
      // no-op. Under the key the entry NAMES — integrity only.
      if (!(await verify(artifact))) {
        result.refused.push({ kind, index, reason: "bad_signature" });
        continue;
      }
      const id = await idOf(artifact);
      // Already held is a no-op BEFORE any cap: a surface re-presenting
      // its whole cached set must not be refused for what is already here.
      if (held.get(motebitId, id) != null) {
        result.accepted.push({ kind, id, status: "already_held" });
        continue;
      }
      const signer = artifact.public_key;
      const full =
        signer === caller
          ? (ownCount.get(motebitId, signer, kind) as { n: number }).n >= ownCap
          : (foreignCount.get(motebitId, caller) as { n: number }).n >=
            MAX_FOREIGN_ENTRIES_PER_MOTEBIT;
      if (full) {
        result.refused.push({ kind, index, reason: "roster_full" });
        continue;
      }
      // Canonical JSON, byte-stable: what is served back re-serialises to
      // the same signed body, so a consumer's verification does not depend
      // on anything this relay did to it.
      const written = insert.run(motebitId, id, kind, signer, canonicalJson(artifact), now);
      // Another presentation may have stored it between the look and the
      // write; say what actually happened.
      const stored = (written as { changes?: number } | undefined)?.changes !== 0;
      result.accepted.push({ kind, id, status: stored ? "stored" : "already_held" });
    }
  };

  await take(
    "enrollment",
    MAX_OWN_ENROLLMENTS_PER_KEY,
    presented.enrollments,
    (v) => {
      const p = HostEnrollmentSchema.safeParse(v);
      return p.success ? p.data : null;
    },
    // Called here by name, not passed by reference: that every inbound
    // signed artifact is VERIFIED before it is held is a property worth
    // being able to see at the call site (and one a gate checks for).
    (e) => verifyHostEnrollment(e),
    hostEnrollmentId,
  );
  await take(
    "retirement",
    MAX_OWN_RETIREMENTS_PER_KEY,
    presented.retirements,
    (v) => {
      const p = HostRetirementSchema.safeParse(v);
      return p.success ? p.data : null;
    },
    (r) => verifyHostRetirement(r),
    hostRetirementId,
  );
  return result;
}

export interface StoredHostRoster {
  enrollments: HostEnrollment[];
  retirements: HostRetirement[];
}

/**
 * The set, as stored — for GET serialisation only. Ordered by entry id,
 * never by time: a set has no order to imply.
 */
export function readHostRoster(db: DatabaseDriver, motebitId: string): StoredHostRoster {
  const rows = db
    .prepare(
      "SELECT kind, body_json FROM relay_host_roster_entries WHERE motebit_id = ? ORDER BY entry_id",
    )
    .all(motebitId) as Array<{ kind: RosterEntryKind; body_json: string }>;
  const out: StoredHostRoster = { enrollments: [], retirements: [] };
  for (const row of rows) {
    if (row.kind === "enrollment") {
      out.enrollments.push(JSON.parse(row.body_json) as HostEnrollment);
    } else {
      out.retirements.push(JSON.parse(row.body_json) as HostRetirement);
    }
  }
  return out;
}

/** The fields of a live connection the liveness record reads. */
export interface ObservedPeer {
  deviceId: string;
  deviceIdVerified?: boolean;
  /** The key the socket's token verified under, captured at verification. */
  boundUnder?: string;
  capabilities?: readonly string[];
}

/**
 * Is this socket BOUND — its signed token proved its device id, and the
 * key it verified under was captured from that device's row? The binding
 * is `(device_id, boundUnder)`; it says nothing about membership.
 */
export function boundKeyOf(peer: ObservedPeer): string | null {
  if (peer.deviceIdVerified !== true) return null;
  return typeof peer.boundUnder === "string" && peer.boundUnder !== "" ? peer.boundUnder : null;
}

/** Does this socket announce that it hosts unattended work? */
export function hostsUnattendedWork(peer: ObservedPeer): boolean {
  return peer.capabilities?.includes(HOSTS_UNATTENDED_WORK) === true;
}

/**
 * Observe one connection — the ONLY door to the liveness record, shared by
 * bind (`onPeerBound`), close (`onPeerClosed`), the periodic flush and the
 * shutdown flush.
 *
 * Writes one overwritten `last_seen_at` for `(motebit_id, device_id,
 * bound_under)` iff the socket is bound (verified device id + a key captured
 * at verification) AND it announces `unattended_runtime`. Phones, browsers
 * and desktops leave no stored record. The key is the one CAPTURED on the
 * peer — this function never reads a device row, so a socket verified under
 * an old key cannot light a row under the key a rotation wrote since.
 * Membership is not consulted: the relay does not decide it. Returns
 * whether a row was written.
 */
export function observeHostConnection(
  db: DatabaseDriver,
  motebitId: string,
  peer: ObservedPeer,
  observedBy: string,
  at: number = Date.now(),
): boolean {
  const boundUnder = boundKeyOf(peer);
  if (boundUnder == null || !hostsUnattendedWork(peer)) return false;
  db.prepare(
    `INSERT INTO relay_host_liveness (motebit_id, device_id, bound_under, last_seen_at, observed_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (motebit_id, device_id, bound_under)
     DO UPDATE SET last_seen_at = excluded.last_seen_at, observed_by = excluded.observed_by`,
  ).run(motebitId, peer.deviceId, boundUnder, at, observedBy);
  return true;
}

export interface PersistedLivenessRow {
  device_id: string;
  bound_under: string;
  last_seen_at: number;
}

export function readHostLiveness(db: DatabaseDriver, motebitId: string): PersistedLivenessRow[] {
  return db
    .prepare(
      "SELECT device_id, bound_under, last_seen_at FROM relay_host_liveness WHERE motebit_id = ? ORDER BY device_id, bound_under",
    )
    .all(motebitId) as PersistedLivenessRow[];
}

/**
 * When this relay began keeping liveness — the time the migration that
 * created the table was applied. A consumer needs it to tell "not observed
 * in the last 90 days" from "not observed since this relay started
 * observing".
 */
export function livenessRecordingSince(db: DatabaseDriver): number | null {
  const row = db
    .prepare("SELECT applied_at FROM relay_schema_migrations WHERE name = 'host_roster'")
    .get() as { applied_at: number } | undefined;
  return row?.applied_at ?? null;
}

/**
 * The TTL sweep: delete liveness rows whose `last_seen_at` is older than the
 * retention window, SKIPPING any row with a live bound socket — an idle
 * daemon that is connected must not age out. `isLive(motebitId, deviceId,
 * boundUnder)` answers from the live connection map. Returns the number of
 * rows deleted.
 */
export function sweepHostLiveness(
  db: DatabaseDriver,
  isLive: (motebitId: string, deviceId: string, boundUnder: string) => boolean,
  now: number = Date.now(),
): number {
  const cutoff = now - HOST_LIVENESS_RETENTION_MS;
  const stale = db
    .prepare(
      "SELECT motebit_id, device_id, bound_under FROM relay_host_liveness WHERE last_seen_at < ?",
    )
    .all(cutoff) as Array<{ motebit_id: string; device_id: string; bound_under: string }>;
  const del = db.prepare(
    "DELETE FROM relay_host_liveness WHERE motebit_id = ? AND device_id = ? AND bound_under = ? AND last_seen_at < ?",
  );
  let deleted = 0;
  for (const row of stale) {
    if (isLive(row.motebit_id, row.device_id, row.bound_under)) continue;
    const r = del.run(row.motebit_id, row.device_id, row.bound_under, cutoff) as
      { changes?: number } | undefined;
    deleted += r?.changes ?? 0;
  }
  return deleted;
}
