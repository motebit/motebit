/**
 * Durable execution ledger — the intent/completion pair on the tool audit log.
 *
 * `PolicyGate.validate` writes a decision row BEFORE execution and returns
 * its `callId`; `recordResult` closes that row after execution. An allowed
 * decision with no completion is an action whose external effect is
 * UNKNOWN (the process died between dispatch and recording) — it proves
 * preparation, never that the call happened. `findUnresolvedActions` is
 * the recovery-side reading of that state.
 */
import { describe, it, expect } from "vitest";
import { RiskLevel } from "@motebit/protocol";
import type { ToolAuditEntry, ToolDefinition } from "@motebit/protocol";
import {
  PolicyGate,
  InMemoryAuditSink,
  ChainedAuditSink,
  AuditLogger,
  findUnresolvedActions,
  countCompletedActions,
} from "../index.js";

const readTool: ToolDefinition = {
  name: "read_thing",
  description: "read",
  inputSchema: { type: "object" },
  riskHint: { risk: RiskLevel.R0_READ },
};

function gateWithSink() {
  const sink = new InMemoryAuditSink();
  const gate = new PolicyGate({ maxRiskLevel: RiskLevel.R3_EXECUTE }, sink);
  return { gate, sink };
}

describe("PolicyGate — intent row before execution, completion row after", () => {
  it("validate returns the callId of the decision row it wrote", () => {
    const { gate, sink } = gateWithSink();
    const ctx = gate.createTurnContext("run-1");
    const decision = gate.validate(readTool, { q: "x" }, ctx);

    expect(decision.allowed).toBe(true);
    expect(typeof decision.callId).toBe("string");
    const rows = sink.getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.callId).toBe(decision.callId);
    expect(rows[0]!.runId).toBe("run-1");
    expect(rows[0]!.result).toBeUndefined();
  });

  it("recordResult closes the SAME row — keyed by callId, carrying the tool's verdict", () => {
    const { gate, sink } = gateWithSink();
    const ctx = gate.createTurnContext("run-1");
    const decision = gate.validate(readTool, { q: "x" }, ctx);
    gate.recordResult(ctx, decision, readTool.name, { q: "x" }, true, 12);

    const rows = sink.getAll().filter((r) => r.callId === decision.callId);
    expect(rows.some((r) => r.result?.ok === true && r.result.durationMs === 12)).toBe(true);
    expect(findUnresolvedActions(sink.getAll())).toEqual([]);
    expect(countCompletedActions(sink.getAll())).toBe(1);
  });

  it("recordApprovalSatisfied turns a paused decision into an open intent until the completion lands", () => {
    const sink = new InMemoryAuditSink();
    const gate = new PolicyGate(
      { maxRiskLevel: RiskLevel.R3_EXECUTE, requireApprovalAbove: RiskLevel.R0_READ },
      sink,
    );
    const writeTool: ToolDefinition = {
      ...readTool,
      name: "write_thing",
      riskHint: { risk: RiskLevel.R2_WRITE },
    };
    const ctx = gate.createTurnContext("run-2");
    const decision = gate.validate(writeTool, {}, ctx);
    expect(decision.requiresApproval).toBe(true);
    // Paused only: the approval queue owns it — not unresolved here.
    expect(findUnresolvedActions(sink.getAll())).toEqual([]);

    gate.recordApprovalSatisfied(ctx, decision, writeTool.name, {}, "human-approved");
    const open = findUnresolvedActions(sink.getAll());
    expect(open.map((e) => e.callId)).toEqual([decision.callId]);
    expect(open[0]!.decision.reason).toBe("approval_satisfied:human-approved");

    gate.recordResult(ctx, decision, writeTool.name, {}, true, 3);
    expect(findUnresolvedActions(sink.getAll())).toEqual([]);
  });

  it("recordResult is a no-op for a decision that never went through validate (no callId)", () => {
    const { gate, sink } = gateWithSink();
    const ctx = gate.createTurnContext();
    gate.recordResult(ctx, { allowed: true, requiresApproval: false }, "x", {}, true, 1);
    expect(sink.getAll()).toHaveLength(0);
  });

  it("a completion row redacts sensitive args the same way the decision row did", () => {
    const sink = new InMemoryAuditSink();
    const logger = new AuditLogger(sink);
    const decision = { allowed: true, requiresApproval: false };
    logger.logResult("t", "c", "call_api", { api_key: "sk-secret", q: "ok" }, decision, true, 1);
    const row = sink.getAll()[0]!;
    expect(row.args.api_key).not.toBe("sk-secret");
    expect(row.args.q).toBe("ok");
  });
});

function entry(over: Partial<ToolAuditEntry> & { callId: string }): ToolAuditEntry {
  return {
    turnId: "t",
    runId: "run-1",
    tool: "write_thing",
    args: {},
    decision: { allowed: true, requiresApproval: false },
    timestamp: 1,
    ...over,
  };
}

describe("findUnresolvedActions — the crash-window reading of the ledger", () => {
  it("an allowed decision with no completion is unresolved", () => {
    const out = findUnresolvedActions([entry({ callId: "a" })]);
    expect(out.map((e) => e.callId)).toEqual(["a"]);
  });

  it("any completion row for the call resolves it (in-memory sinks keep both rows)", () => {
    const out = findUnresolvedActions([
      entry({ callId: "a" }),
      entry({ callId: "a", result: { ok: false, durationMs: 3 } }),
    ]);
    expect(out).toEqual([]);
  });

  it("denied decisions were never intended", () => {
    const out = findUnresolvedActions([
      entry({ callId: "d", decision: { allowed: false, requiresApproval: false } }),
    ]);
    expect(out).toEqual([]);
  });

  it("approval-gated decisions are not unresolved here — the approval queue owns their state", () => {
    const out = findUnresolvedActions([
      entry({ callId: "p", decision: { allowed: true, requiresApproval: true } }),
    ]);
    expect(out).toEqual([]);
  });

  it("injection annotation rows are not intents", () => {
    const out = findUnresolvedActions([
      entry({
        callId: "i",
        decision: { allowed: true, requiresApproval: false, reason: "injection_warned" },
        injection: { detected: true, patterns: ["x"] },
      }),
    ]);
    expect(out).toEqual([]);
  });

  it("countCompletedActions counts distinct calls that recorded a completion", () => {
    const rows = [
      entry({ callId: "a" }),
      entry({ callId: "a", result: { ok: true, durationMs: 1 } }),
      entry({ callId: "b", result: { ok: false, durationMs: 1 } }),
      entry({ callId: "c" }),
    ];
    expect(countCompletedActions(rows)).toBe(2);
    expect(findUnresolvedActions(rows).map((e) => e.callId)).toEqual(["c"]);
  });
});

describe("one entry per call — completions merge instead of duplicating", () => {
  it("InMemoryAuditSink keeps a single entry per callId after the completion and counts stats once", () => {
    const sink = new InMemoryAuditSink();
    const logger = new AuditLogger(sink);
    const decision = { allowed: true, requiresApproval: false };
    logger.logDecision("t", "c1", "write_thing", {}, decision);
    logger.logResult("t", "c1", "write_thing", {}, decision, true, 7);
    logger.logDecision("t", "c2", "write_thing", {}, decision);
    logger.logResult("t", "c2", "write_thing", {}, decision, false, 7);

    expect(sink.getAll()).toHaveLength(2);
    const stats = sink.queryStatsSince(0);
    expect(stats.totalToolCalls).toBe(2);
    expect(stats.succeeded).toBe(1);
    expect(stats.failed).toBe(1);
    expect(findUnresolvedActions(sink.getAll())).toEqual([]);
  });

  it("ChainedAuditSink merges in the inner store but appends the completion as its own chain link", async () => {
    const inner = new InMemoryAuditSink();
    const chained = new ChainedAuditSink({ inner });
    const logger = new AuditLogger(chained);
    const decision = { allowed: true, requiresApproval: false };
    logger.logDecision("t", "c1", "write_thing", {}, decision);
    logger.logResult("t", "c1", "write_thing", {}, decision, true, 7);
    await chained.drainChain();
    expect(inner.getAll()).toHaveLength(1);
    expect(inner.getAll()[0]!.result?.ok).toBe(true);
    expect(await chained.getChainEntries()).toHaveLength(2);
  });
});
