import type { ToolAuditEntry, PolicyDecision, InjectionWarning } from "@motebit/sdk";

/**
 * AuditLogger — records every policy decision and tool execution for
 * debugging, compliance, and replay.
 *
 * The invariant: every tool call is logged with full context, whether
 * it succeeded, failed, was denied, or required approval.
 */

export interface AuditStatsSince {
  distinctTurns: number;
  totalToolCalls: number;
  succeeded: number;
  blocked: number;
  failed: number;
}

export interface AuditLogSink {
  append(entry: ToolAuditEntry): void;
  query(turnId: string): ToolAuditEntry[];
  getAll(): ToolAuditEntry[];
  queryStatsSince(afterTimestamp: number): AuditStatsSince;
}

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

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
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
      args,
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
}
