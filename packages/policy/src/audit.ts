import type { ToolAuditEntry, PolicyDecision, InjectionWarning } from "@motebit/protocol";
import {
  appendAuditEntry,
  getChainHead,
  verifyAuditChain,
  InMemoryAuditChainStore,
  type AuditChainStore,
  type AuditEntry,
} from "./audit-chain.js";

/**
 * AuditLogger — records every policy decision and tool execution for
 * debugging, compliance, and replay.
 *
 * The invariant: every tool call is logged with full context, whether
 * it succeeded, failed, was denied, or required approval.
 */

export type { AuditStatsSince, AuditLogSink } from "@motebit/protocol";
import type { AuditStatsSince, AuditLogSink } from "@motebit/protocol";

// Audit dissolution axis of Liquescentia's persistence property — see
// docs/doctrine/dissolution-spectrum.md §5. Form: capacity-based FIFO
// (not time-based); a busy motebit can churn through the buffer in
// days. The hash-chained `AuditChainStore` (audit-chain.ts) is the
// future-direction replacement; that path replaces capacity-FIFO with
// merkle-anchored durable persistence. See project memory
// `audit_chain_signing_endgame` for the wiring trigger.
const DEFAULT_MAX_ENTRIES = 10_000;

export class InMemoryAuditSink implements AuditLogSink {
  private entries: ToolAuditEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  append(entry: ToolAuditEntry): void {
    this.entries.push(entry);
    // FIFO eviction when over capacity
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  query(turnId: string): ToolAuditEntry[] {
    return this.entries.filter((e) => e.turnId === turnId);
  }

  getAll(): ToolAuditEntry[] {
    return [...this.entries];
  }

  queryStatsSince(afterTimestamp: number): AuditStatsSince {
    const recent = this.entries.filter((e) => e.timestamp > afterTimestamp);
    const turns = new Set(recent.map((e) => e.turnId));
    let succeeded = 0;
    let blocked = 0;
    let failed = 0;
    for (const entry of recent) {
      if (!entry.decision.allowed) {
        blocked++;
      } else if (entry.result) {
        if (entry.result.ok) succeeded++;
        else failed++;
      }
    }
    return { distinctTurns: turns.size, totalToolCalls: recent.length, succeeded, blocked, failed };
  }

  queryByRunId(runId: string): ToolAuditEntry[] {
    return this.entries.filter((e) => e.runId === runId);
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }
}

/** Redact arg values whose keys look like secrets (keys, tokens, passwords, credentials). */
const SENSITIVE_KEY_RE = /key|token|password|secret|credential|auth|api.?key/i;

function redactSensitiveArgs(args: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (SENSITIVE_KEY_RE.test(k) && typeof v === "string" && v.length > 0) {
      redacted[k] = "[REDACTED]";
    } else {
      redacted[k] = v;
    }
  }
  return redacted;
}

/**
 * audit-chain-1 — `AuditLogSink` wrapper that adds a hash-chained
 * tamper-evident layer on top of any inner sink. Each appended
 * entry's hash references the previous entry's hash, forming a
 * Merkle-like chain — an attacker who compromises the runtime
 * cannot reorder, remove, or alter a single entry without breaking
 * the chain past that point.
 *
 * **Composes with existing surface sinks.** Each platform already
 * has its own `AuditLogSink` (`SqliteToolAuditSink` for cli/web,
 * `TauriToolAuditSink` for desktop, `ExpoToolAuditSink` for mobile)
 * that handles persistence + sync queries. ChainedAuditSink WRAPS
 * one of those — the inner sink keeps doing what it does
 * (persistence, queries, stats, retention), and the chain layer
 * runs in parallel for tamper-evidence. Append delegates to inner
 * synchronously; chain write is queued asynchronously so hash
 * linkage stays well-ordered even under fast append cadence.
 *
 * **Inner-sink agnostic.** ChainedAuditSink doesn't know whether
 * the inner sink is in-memory, SQLite, Tauri-bridge, or anything
 * else — it just calls `inner.append(...)` and then chains. Same
 * primitive works across every surface.
 *
 * **Closes the `audit_chain_signing_endgame` memory:** the chain
 * primitive (`audit-chain.ts`) had zero consumers; the wrap-style
 * sink is the first one. Runtime auto-wraps when an
 * `auditChainStore` adapter is supplied alongside the existing
 * `toolAuditSink` — every surface inherits tamper-evidence the
 * moment it provides a chain store.
 *
 * **Receipt-vs-chain layering:** `ToolInvocationReceipt` (per-entry
 * Ed25519-signed, in `@motebit/crypto`) gives single-entry
 * verifiability — anyone with the public key can verify that
 * receipt was produced by that motebit. `ChainedAuditSink` adds
 * chain-level integrity — any party can verify the entire trail
 * is internally consistent. Both compose: a chain entry whose
 * `data.receipt` field carries a signed receipt is BOTH per-entry
 * authentic AND chain-position authentic.
 */
export interface ChainedAuditSinkOptions {
  /**
   * The wrapped sink — receives every `append` synchronously
   * (preserving existing query semantics + persistence). Optional;
   * defaults to a fresh `InMemoryAuditSink` when omitted (useful
   * for in-tree tests and ephemeral sandboxes that just want
   * tamper-evidence without a backing store).
   */
  readonly inner?: AuditLogSink;
  /**
   * Capacity cap for the default inner sink — only used when
   * `inner` is not supplied. Ignored when wrapping a caller-
   * supplied sink (capacity is that sink's concern).
   */
  readonly maxEntries?: number;
  /**
   * Backing store for the hash-chained tail. Defaults to
   * `InMemoryAuditChainStore`. Production surfaces pass a
   * persistent store (`SqliteAuditChainStore`) so the chain
   * survives process restart.
   */
  readonly chainStore?: AuditChainStore;
  /**
   * Stamped as `actor_id` on each chain entry so verifiers know
   * which motebit produced the trail. Defaults to a literal
   * `"motebit"` when unset — visibly-broken so unset surfaces show
   * up in audit reads as obviously-unconfigured rather than
   * silently-anonymous.
   */
  readonly motebitId?: string;
}

export class ChainedAuditSink implements AuditLogSink {
  private readonly inner: AuditLogSink;
  private readonly chainStore: AuditChainStore;
  private readonly motebitId: string;
  /**
   * Sequenced promise — each chain-append awaits the previous to
   * preserve hash linkage under concurrent calls. Errors are
   * caught and logged; subsequent appends still run.
   */
  private chainQueue: Promise<void> = Promise.resolve();
  private chainErrors = 0;

  constructor(opts: ChainedAuditSinkOptions = {}) {
    this.inner = opts.inner ?? new InMemoryAuditSink(opts.maxEntries);
    this.chainStore = opts.chainStore ?? new InMemoryAuditChainStore();
    this.motebitId = opts.motebitId ?? "motebit";
  }

  /** The wrapped sink — exposed for surfaces that need direct access. */
  get innerSink(): AuditLogSink {
    return this.inner;
  }

  append(entry: ToolAuditEntry): void {
    // Sync delegation — inner sink handles persistence + sync
    // queries. ChainedAuditSink doesn't duplicate that work.
    this.inner.append(entry);
    // Async chain write — queued so order is preserved. Caller
    // doesn't await; verification consumers call `drainChain()`
    // before reading.
    this.chainQueue = this.chainQueue
      .then(() => this.appendToChain(entry))
      .catch((err) => {
        this.chainErrors++;
        // eslint-disable-next-line no-console -- defensive logging; chain failures shouldn't break the audit logger
        console.warn("[audit-chain] append failed:", err instanceof Error ? err.message : err);
      });
  }

  // === AuditLogSink methods — delegate to inner ===

  query(turnId: string): ToolAuditEntry[] {
    return this.inner.query(turnId);
  }

  getAll(): ToolAuditEntry[] {
    return this.inner.getAll();
  }

  queryStatsSince(afterTimestamp: number): AuditStatsSince {
    return this.inner.queryStatsSince(afterTimestamp);
  }

  queryByRunId(runId: string): ToolAuditEntry[] {
    return this.inner.queryByRunId?.(runId) ?? [];
  }

  enumerateForFlush(beforeTimestamp: number): ToolAuditEntry[] {
    return this.inner.enumerateForFlush?.(beforeTimestamp) ?? [];
  }

  private async appendToChain(entry: ToolAuditEntry): Promise<void> {
    // Convert ToolAuditEntry → AuditEntry. The chain entry's `data`
    // payload includes everything the in-memory mirror tracks, so
    // post-hoc verification can reproduce the audit row from the
    // chain alone. Sensitive fields (`args`) were already redacted
    // at AuditLogger.logDecision time before reaching the sink.
    const data: Record<string, unknown> = {
      tool: entry.tool,
      args: entry.args,
      decision: entry.decision,
    };
    if (entry.result) data["result"] = entry.result;
    if (entry.injection) data["injection"] = entry.injection;
    if (entry.runId) data["run_id"] = entry.runId;
    if (entry.turnId) data["turn_id"] = entry.turnId;
    await appendAuditEntry(this.chainStore, {
      entry_id: entry.callId,
      timestamp: entry.timestamp,
      event_type: "tool_call",
      actor_id: this.motebitId,
      data,
    });
  }

  /**
   * Wait for all pending chain writes to complete. Verification
   * consumers MUST call this before `getChainEntries` or
   * `verifyChain` — otherwise reads race ahead of in-flight writes.
   */
  async drainChain(): Promise<void> {
    await this.chainQueue;
  }

  /** Read the chain entries (drains pending writes first). */
  async getChainEntries(from?: number, to?: number): Promise<AuditEntry[]> {
    await this.drainChain();
    return this.chainStore.getEntries(from, to);
  }

  /**
   * Verify the chain's integrity. Returns `{valid: true}` if every
   * entry's hash matches its computed value AND every link to the
   * previous entry holds. Returns `{valid: false, brokenAt}` with
   * the chain index of the first inconsistency.
   *
   * Tamper-evidence contract: an attacker who modifies any entry's
   * `data` field invalidates that entry's hash AND every subsequent
   * entry's `previous_hash` reference. They can rebuild the tail,
   * but only if they have the original SHA-256 input shape — which
   * carries the full canonical entry. Removing entries leaves the
   * subsequent `previous_hash` references dangling. Reordering
   * shifts every subsequent `previous_hash` reference. All three
   * tamper modes are caught.
   */
  async verifyChain(): Promise<{ valid: true } | { valid: false; brokenAt: number }> {
    await this.drainChain();
    return verifyAuditChain(this.chainStore);
  }

  /**
   * Hash of the chain head — the cryptographic commitment to the
   * entire trail's contents. External anchoring (pinning to a
   * federation peer, a timestamping service, an L1 transaction —
   * audit-chain-2 follow-up) commits this single hash and gains
   * full-chain tamper-evidence as a derived property.
   */
  async getChainHead(): Promise<string> {
    await this.drainChain();
    return getChainHead(this.chainStore);
  }

  /**
   * Count of chain-write failures since construction. Production
   * surfaces watch this as a telemetry signal — if it ever rises
   * above zero, the chain has gaps and verification will fail.
   */
  get chainAppendErrorCount(): number {
    return this.chainErrors;
  }
}

export class AuditLogger {
  private sink: AuditLogSink;

  constructor(sink?: AuditLogSink) {
    this.sink = sink ?? new InMemoryAuditSink();
  }

  /**
   * Log a policy decision for a tool call.
   */
  logDecision(
    turnId: string,
    callId: string,
    tool: string,
    args: Record<string, unknown>,
    decision: PolicyDecision,
    runId?: string,
  ): void {
    this.sink.append({
      turnId,
      runId,
      callId,
      tool,
      args: redactSensitiveArgs(args),
      decision,
      timestamp: Date.now(),
    });
  }

  /**
   * Log the result of a tool execution (called after execution completes).
   */
  logResult(
    turnId: string,
    callId: string,
    tool: string,
    args: Record<string, unknown>,
    decision: PolicyDecision,
    ok: boolean,
    durationMs: number,
    runId?: string,
  ): void {
    this.sink.append({
      turnId,
      runId,
      callId,
      tool,
      args,
      decision,
      result: { ok, durationMs },
      timestamp: Date.now(),
    });
  }

  /**
   * Log an injection detection event for a tool call.
   */
  logInjection(
    turnId: string,
    callId: string,
    tool: string,
    args: Record<string, unknown>,
    injection: InjectionWarning,
    blocked: boolean,
    runId?: string,
  ): void {
    this.sink.append({
      turnId,
      runId,
      callId,
      tool,
      args,
      decision: {
        allowed: !blocked,
        requiresApproval: false,
        reason: blocked ? "injection_blocked" : "injection_warned",
      },
      injection,
      timestamp: Date.now(),
    });
  }

  /**
   * Get all audit entries for a specific turn.
   */
  queryTurn(turnId: string): ToolAuditEntry[] {
    return this.sink.query(turnId);
  }

  /**
   * Get all audit entries.
   */
  getAll(): ToolAuditEntry[] {
    return this.sink.getAll();
  }

  /**
   * audit-chain-1 — expose the underlying sink so callers can
   * access chain-level operations when the sink is a
   * `ChainedAuditSink`. Returns null when the sink is the default
   * (un-chained) shape — callers handle absence gracefully.
   *
   * Pattern: `const chained = logger.getChainedSink();
   * if (chained) await chained.verifyChain();` — compile-time-clean
   * narrow into the chained operations without forcing every
   * surface to know about chain primitives.
   */
  getChainedSink(): ChainedAuditSink | null {
    return this.sink instanceof ChainedAuditSink ? this.sink : null;
  }
}
