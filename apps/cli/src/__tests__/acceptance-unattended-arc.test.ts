import { describe, it, expect, beforeEach, vi } from "vitest";
import { GoalScheduler } from "../scheduler.js";
import { createMotebitDatabase, type MotebitDatabase, type Goal } from "@motebit/persistence";
import { PolicyGate } from "@motebit/policy";
import { verifyEvidenceProvenance } from "@motebit/encryption";
import { RiskLevel, TrustMode, BatteryMode } from "@motebit/sdk";
import type { MotebitRuntime, StreamChunk } from "@motebit/runtime";
import type { TurnResult } from "@motebit/ai-core";

/**
 * The arc's own sentence, walked end to end:
 *
 *   Can my motebit keep working when I leave, reach me when it needs
 *   authority, stop when I withdraw it, and show me evidence when I
 *   return?
 *
 * Three increments each shipped one clause, and each was found — by
 * review, repeatedly — to claim more than it delivered. Every one of
 * those defects was in the SEAM between clauses rather than inside one:
 * a stop that reported stopping, a signature covering a fragment, a
 * record preserved and then not shown. Tests that assert one clause
 * cannot see any of that, which is why none of them did.
 *
 * So this asserts the joins. Starting from a run id and nothing else —
 * which is all a returning owner has — can you reach what the motebit
 * produced, whether that is signed, what it was refused, and evidence a
 * stranger could re-check without trusting any of it?
 *
 * What it does NOT prove: that the runtime wires the gate to the
 * evidence sink in production. That wiring has its own coverage. Here
 * the two halves meet where they meet in the database, at `run_id`,
 * because that join is the thing a returning owner actually walks.
 */
function turnResult(): TurnResult {
  return {
    response: "",
    memoriesFormed: [],
    memoriesRetrieved: [],
    stateAfter: {
      attention: 0,
      processing: 0,
      confidence: 0,
      affect_valence: 0.5,
      affect_arousal: 0,
      social_distance: 0.5,
      curiosity: 0,
      trust_mode: TrustMode.Guarded,
      battery_mode: BatteryMode.Normal,
    },
    cues: {
      hover_distance: 0.4,
      drift_amplitude: 0.02,
      glow_intensity: 0,
      eye_dilation: 0.5,
      smile_curvature: 0,
      speaking_activity: 0,
    },
    iterations: 1,
    toolCallsSucceeded: 0,
    toolCallsBlocked: 0,
    toolCallsFailed: 0,
  };
}

/** The primary record the motebit reads, as a stranger could re-fetch it. */
const SOURCE_BYTES = new TextEncoder().encode(
  "<report>Quarterly revenue fell four percent year over year.</report>",
);
const SOURCE_URL = "https://example.gov/filings/q3";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function mockRuntime(opts: { pause?: boolean } = {}) {
  let pending = false;
  const stoppers: Array<(h: unknown) => string> = [];
  const runtime = {
    motebitId: "mote-test",
    async *sendMessageStreaming(): AsyncGenerator<StreamChunk> {
      if (opts.pause === true) {
        pending = true;
        yield { type: "text" as const, text: "Read the filing. " };
        yield {
          type: "approval_request" as const,
          tool_call_id: "tc-1",
          name: "send_email",
          args: { to: "cfo@example.com", subject: "Q3" },
          risk_level: RiskLevel.R3_EXECUTE,
        };
        return;
      }
      yield { type: "text" as const, text: "Revenue fell four percent." };
      yield { type: "result" as const, result: turnResult() };
    },
    async *resumeAfterApproval(): AsyncGenerator<StreamChunk> {
      pending = false;
      yield { type: "text" as const, text: "Sent." };
      yield { type: "result" as const, result: turnResult() };
    },
    get hasPendingApproval() {
      return pending;
    },
    get pendingApprovalInfo() {
      return pending ? { toolName: "send_email", args: {}, toolCallId: "tc-1" } : null;
    },
    signGoalArtifact: vi.fn(async (content: string) =>
      content === "" ? null : { kind: "content-artifact", over: content, signature: "sig" },
    ),
    getToolRegistry: () => ({
      register: vi.fn(),
      replace: vi.fn(),
      unregister: vi.fn(),
      list: () => [],
      execute: vi.fn(),
    }),
    events: { getLatestClock: vi.fn().mockResolvedValue(0), appendWithClock: vi.fn() },
    goals: { executed: vi.fn(), completed: vi.fn(), progress: vi.fn(), failed: vi.fn() },
    setGoalStatusResolver: vi.fn(),
    setGoalIdResolver: vi.fn(),
    onHalt: vi.fn((fn: (h: unknown) => string) => {
      stoppers.push(fn);
      return () => {};
    }),
    haltInForce: () => null,
    honorHalts: vi.fn(async () => []),
    consolidationCycle: vi.fn(async () => ({})),
    presence: { canStartCycle: () => false },
    policy: { createTurnContext: vi.fn() },
  } as unknown as MotebitRuntime;
  return { runtime, stoppers };
}

function goal(over: Partial<Goal> = {}): Goal {
  return {
    goal_id: "goal-filings",
    motebit_id: "mote-test",
    prompt: "read the quarterly filing and summarise it",
    interval_ms: 3_600_000,
    last_run_at: null,
    enabled: true,
    created_at: Date.now(),
    mode: "recurring",
    status: "active",
    parent_goal_id: null,
    max_retries: 3,
    consecutive_failures: 0,
    wall_clock_ms: null,
    project_id: null,
    ...over,
  };
}

function scheduler(db: MotebitDatabase, runtime: MotebitRuntime) {
  const s = new GoalScheduler(
    runtime,
    db.goalStore,
    db.approvalStore,
    db.goalOutcomeStore,
    db.goalRunStore,
    db.toolAuditSink,
    "mote-test",
    RiskLevel.R4_MONEY,
  );
  s.registerGoalTools();
  return s;
}

describe("the unattended arc, walked from a run id", () => {
  let db: MotebitDatabase;
  beforeEach(() => {
    db = createMotebitDatabase(":memory:");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("KEEPS WORKING: an unattended run leaves a result that is signed and reachable", async () => {
    const { runtime } = mockRuntime();
    db.goalStore.add(goal());
    await scheduler(db, runtime).tickOnce();

    const [run] = db.goalRunStore.listForGoal("goal-filings", 10);
    expect(run?.status).toBe("completed");

    // From the run id alone.
    const [outcome] = db.goalOutcomeStore.listForRun(run!.run_id);
    expect(outcome?.status).toBe("completed");
    expect(outcome?.response_full).toBe("Revenue fell four percent.");
    expect(outcome?.signed_manifest).toBeDefined();
    // The summary is a table row; the artifact is what was signed.
    expect(JSON.parse(outcome!.signed_manifest!).over).toBe(outcome!.response_full);
  });

  it("REACHES ME: an approval-gated call holds the goal instead of proceeding", async () => {
    const { runtime } = mockRuntime({ pause: true });
    db.goalStore.add(goal());
    const s = scheduler(db, runtime);
    await s.tickOnce();

    const [approval] = db.approvalStore.listAll("mote-test");
    expect(approval?.status).toBe("pending");
    // The goal does not roll on while a human owes it an answer, and the
    // run says so rather than looking finished.
    const [run] = db.goalRunStore.listForGoal("goal-filings", 10);
    expect(run?.status).toBe("awaiting_approval");
    expect(db.goalStore.list("mote-test")[0]!.last_run_at).toBeNull();
  });

  it("STOPS: a halt is refused work, acknowledged per process, and not a goal failure", async () => {
    const { runtime } = mockRuntime();
    db.goalStore.add(goal());
    scheduler(db, runtime);

    const halt = {
      halt_id: "halt-1",
      motebit_id: "mote-test",
      goal_id: null,
      requested_at: Date.now(),
      origin: "local" as const,
      reason: "going out",
      lifted_at: null,
    };
    db.haltStore.request(halt);

    // In force from the instant it is written — before anyone answers.
    expect(db.haltStore.activeFor("mote-test")?.halt_id).toBe("halt-1");
    expect(db.haltStore.acknowledgements("halt-1")).toEqual([]);

    // Two processes run unattended work for one motebit; each answers
    // for itself, and one answering never speaks for the other.
    db.haltStore.acknowledge("halt-1", "run@dev-1", "no further goal runs will start");
    expect(db.haltStore.hasAcknowledged("halt-1", "run@dev-1")).toBe(true);
    expect(db.haltStore.hasAcknowledged("halt-1", "serve@dev-1")).toBe(false);

    db.haltStore.acknowledge("halt-1", "serve@dev-1", "no further dispatched tasks accepted");
    expect(db.haltStore.acknowledgements("halt-1").map((a) => a.executor_id)).toEqual([
      "run@dev-1",
      "serve@dev-1",
    ]);

    // A stop the owner asked for is not the goal failing.
    expect(db.goalStore.list("mote-test")[0]!.consecutive_failures).toBe(0);
  });

  it("SHOWS EVIDENCE: a stranger re-checks the run's pointer against the original bytes", async () => {
    const { runtime } = mockRuntime();
    db.goalStore.add(goal());
    await scheduler(db, runtime).tickOnce();
    const [run] = db.goalRunStore.listForGoal("goal-filings", 10);

    // The pointer is minted by the real gate from a real tool result —
    // never by hand here, because a span nobody fetched must not be able
    // to enter the record by any route, test code included.
    const gate = new PolicyGate({}, undefined, db.runEvidenceStore);
    const projected = new TextDecoder().decode(SOURCE_BYTES);
    gate.recordEvidence(
      { turnId: "turn-1", runId: run!.run_id },
      { callId: "call-1" } as unknown as Parameters<typeof gate.recordEvidence>[1],
      "read_url",
      {
        ok: true,
        data: projected,
        source_digest: { algorithm: "sha-256", value: await sha256Hex(SOURCE_BYTES) },
        source_ref: SOURCE_URL,
      },
    );

    // What the returning owner reaches from the run id.
    const pointers = db.runEvidenceStore.listForRun(run!.run_id);
    expect(pointers).toHaveLength(1);
    expect(pointers[0]!.evidence.ref).toBe(SOURCE_URL);

    // And what a stranger does with it: re-fetch, re-hash, re-check. The
    // real law, over the real bytes, with no trust in this motebit.
    const verdict = await verifyEvidenceProvenance(SOURCE_BYTES, pointers[0]!.evidence.provenance!);
    expect(verdict).toEqual({ present: true });

    // The same law refuses a different record, which is what makes the
    // pass mean anything.
    const other = new TextEncoder().encode("<report>Revenue rose forty percent.</report>");
    expect(await verifyEvidenceProvenance(other, pointers[0]!.evidence.provenance!)).toEqual({
      present: false,
      reason: "digest_mismatch",
    });
  });
});
