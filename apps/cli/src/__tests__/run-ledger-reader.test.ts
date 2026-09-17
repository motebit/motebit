import { describe, it, expect } from "vitest";
import { createRunLedgerReader } from "../run-ledger-reader.js";
import type { MotebitDatabase } from "@motebit/persistence";

/**
 * The daemon's side of the return view.
 *
 * Every assertion here is about a record that would otherwise say
 * something untrue: a refused call reported as maybe-executed, a
 * pointer counted as checkable with no digest to check, a page of held
 * runs standing in for "what happened while you were away".
 */
const MOTEBIT = "mb-1";

interface Row {
  run_id: string;
  goal_id: string;
  motebit_id: string;
  status: string;
  started_at: number;
  note: string | null;
  reviewed_at?: number | null;
  completed_actions: number;
  uncertain_actions?: string[];
}

function run(id: string, startedAt: number, note: string | null = null, status = "completed"): Row {
  return {
    run_id: id,
    goal_id: `goal-${id}`,
    motebit_id: MOTEBIT,
    status,
    started_at: startedAt,
    note,
    reviewed_at: null,
    completed_actions: 1,
  };
}

function dbWith(opts: {
  blocking?: Row[];
  recent?: Row[];
  calls?: Array<{
    tool: string;
    decision: { allowed: boolean; requiresApproval?: boolean };
    result?: { ok: boolean };
  }>;
  evidence?: Array<{ tool: string; withheld_reason?: string; provenance?: unknown }>;
}): MotebitDatabase {
  const blocking = opts.blocking ?? [];
  const recent = opts.recent ?? [];
  return {
    goalRunStore: {
      // The store returns held runs OLDEST first — the ordering the
      // reader has to correct, asserted by reproducing it here.
      listBlocking: () => [...blocking].sort((a, b) => a.started_at - b.started_at),
      listRecent: (_m: string, limit: number) =>
        [...recent].sort((a, b) => b.started_at - a.started_at).slice(0, limit),
      get: (id: string) => [...blocking, ...recent].find((r) => r.run_id === id) ?? null,
    },
    goalOutcomeStore: { listForRun: () => [], get: () => null },
    runEvidenceStore: {
      listForRun: () =>
        (opts.evidence ?? []).map((e) => ({
          tool: e.tool,
          withheld_reason: e.withheld_reason ?? null,
          evidence: { ref: "https://example.gov/x", provenance: e.provenance ?? null },
        })),
    },
    toolAuditSink: { queryByRunId: () => opts.calls ?? [] },
  } as unknown as MotebitDatabase;
}

const PROVENANCE = { digest: { algorithm: "sha-256", value: "a".repeat(64) } };

describe("run ledger reader", () => {
  it("reports a REFUSED call as refused, not as 'effect unknown'", () => {
    // The gate writes its audit row BEFORE execution, so a denied call
    // has a decision and never a result. Reading the result alone told
    // a returning owner the outside world may have been touched by a
    // call the gate refused before it ran.
    const reader = createRunLedgerReader(
      dbWith({
        recent: [run("r1", 100)],
        calls: [
          { tool: "send_payment", decision: { allowed: false } },
          { tool: "read_url", decision: { allowed: true }, result: { ok: true } },
          { tool: "write_file", decision: { allowed: true } },
        ],
      }),
      MOTEBIT,
    );
    const found = reader.get("r1");
    expect(found.kind).toBe("found");
    if (found.kind !== "found") return;
    expect(found.run.tool_calls[0]?.verdict).toContain("refused");
    expect(found.run.tool_calls[0]?.verdict).not.toContain("unknown");
    expect(found.run.tool_calls[1]?.verdict).toBe("ok");
    // Allowed and never completed IS the unknown — a crash between the
    // pre-call row and the result. That one keeps its honest answer.
    expect(found.run.tool_calls[2]?.verdict).toContain("unknown");
  });

  it("a call the OWNER refused is not reported as 'effect unknown' either", () => {
    // The gate appends `recordApprovalSatisfied` under the same call id
    // when a person approves, and the table replaces on that key — so a
    // row that still says it is waiting is a call whose approval was
    // never satisfied. Waiting or refused, it did not run, and that is
    // the refusal that matters most to report correctly.
    const reader = createRunLedgerReader(
      dbWith({
        recent: [run("r1", 100)],
        calls: [{ tool: "send_payment", decision: { allowed: true, requiresApproval: true } }],
      }),
      MOTEBIT,
    );
    const found = reader.get("r1");
    if (found.kind !== "found") throw new Error("expected found");
    expect(found.run.tool_calls[0]?.verdict).toContain("never executed");
    expect(found.run.tool_calls[0]?.verdict).not.toContain("unknown");
  });

  it("does not count a pointer with no provenance as checkable", () => {
    // The detail prose says "re-fetch the source and hash its text" —
    // an instruction to verify something that was never recorded.
    const reader = createRunLedgerReader(
      dbWith({
        recent: [run("r1", 100)],
        evidence: [
          { tool: "read_url", provenance: PROVENANCE },
          { tool: "read_url" },
          { tool: "read_url", withheld_reason: "credential_in_span" },
        ],
      }),
      MOTEBIT,
    );
    const found = reader.get("r1");
    if (found.kind !== "found") throw new Error("expected found");
    expect(found.run.evidence_count).toBe(1);
    expect(found.run.evidence).toHaveLength(1);
    expect(found.run.evidence[0]?.digest).not.toBe("");
    // Not silently folded into the withheld set either: withholding is
    // a decision, an absent pointer is an absence.
    expect(found.run.withheld_count).toBe(1);
  });

  it("a page of held runs never crowds out everything that happened", () => {
    // Held runs were prepended unbounded before one slice, so a motebit
    // with ten or more waiting answered "what happened while you were
    // away" with ten held runs and nothing that happened.
    const blocking = Array.from({ length: 12 }, (_, i) =>
      run(`h${i}`, 1000 + i, null, "awaiting_approval"),
    );
    const recent = Array.from({ length: 6 }, (_, i) => run(`c${i}`, 2000 + i));
    const reader = createRunLedgerReader(dbWith({ blocking, recent }), MOTEBIT);
    const list = reader.listRecent(10);
    expect(list).toHaveLength(10);
    expect(list.some((r) => r.run_id.startsWith("c"))).toBe(true);
    // And the held group is newest first, like the reader documents —
    // the store hands them back oldest first.
    expect(list[0]?.run_id).toBe("h11");
    expect(list[0]?.holding).toBe(true);
    expect(list.at(-1)?.holding).toBe(false);
  });

  it("a run that is still RUNNING is not marked as needing a person", () => {
    // `listBlocking` returns `running` rows too — they block the goal
    // and ask nothing of anyone. Marked "needs you" and raised to the
    // top, an in-flight nightly goal sent its owner looking for an
    // acknowledgement that does not exist, and a stale `running` row
    // from an unrecovered crash read identically.
    const running = run("r-running", 200, null, "running");
    const reader = createRunLedgerReader(
      dbWith({
        // The real store returns a `running` row from BOTH — it blocks
        // its goal and it is also one of the recent runs.
        blocking: [running, run("r-waiting", 100, null, "awaiting_approval")],
        recent: [running],
      }),
      MOTEBIT,
    );
    const list = reader.listRecent(10);
    expect(list.find((r) => r.run_id === "r-running")?.holding).toBe(false);
    expect(list.find((r) => r.run_id === "r-waiting")?.holding).toBe(true);
  });

  it("a RUNNING run does not take the priority group either, only the mark", () => {
    // Fixing the label and leaving the priority group as `listBlocking`
    // half-fixed it: five stale `running` rows from unrecovered crashes
    // still took the top of the page, saying nothing and asking
    // nothing, and pushed five finished runs off it. The group and the
    // mark are the same fact and read the same predicate.
    const stale = Array.from({ length: 6 }, (_, i) => run(`s${i}`, 500 + i, null, "running"));
    const done = Array.from({ length: 6 }, (_, i) => run(`c${i}`, 2000 + i));
    const reader = createRunLedgerReader(
      dbWith({ blocking: stale, recent: [...stale, ...done] }),
      MOTEBIT,
    );
    const list = reader.listRecent(6);
    expect(list.every((r) => r.holding === false)).toBe(true);
    // Newest first, with nothing hoisted: the finished runs are newer.
    expect(list.every((r) => r.run_id.startsWith("c"))).toBe(true);
  });

  it("marks which runs are holding, because status cannot say it", () => {
    const reader = createRunLedgerReader(
      dbWith({
        blocking: [run("h1", 100, null, "awaiting_approval")],
        recent: [run("c1", 200)],
      }),
      MOTEBIT,
    );
    const list = reader.listRecent(10);
    expect(list.find((r) => r.run_id === "h1")?.holding).toBe(true);
    expect(list.find((r) => r.run_id === "c1")?.holding).toBe(false);
    const found = reader.get("h1");
    if (found.kind !== "found") throw new Error("expected found");
    expect(found.run.holding).toBe(true);
  });
});
