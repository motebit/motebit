import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { SyncRelay } from "../index.js";
import { EventType, PlanStatus, StepStatus, asMotebitId, asGoalId, asPlanId } from "@motebit/sdk";
import type { EventLogEntry, Plan, PlanStep } from "@motebit/sdk";
import { fromBase64Url } from "@motebit/encryption";
import {
  verifyContentArtifact,
  CONTENT_ARTIFACT_SUITE,
  type ContentArtifactManifest,
} from "@motebit/crypto";
import { AUTH_HEADER, createTestRelay as _createTestRelay } from "./test-helpers.js";

// === Helpers ===

const MOTEBIT_ID = "test-mote-ledger";
const GOAL_ID = "goal-ledger-1";
const PLAN_ID = "plan-ledger-1";

const createTestRelay = () => _createTestRelay({ enableDeviceAuth: false });

function makeEvent(
  motebitId: string,
  clock: number,
  eventType: string,
  payload: Record<string, unknown>,
): EventLogEntry {
  return {
    event_id: crypto.randomUUID(),
    motebit_id: motebitId,
    device_id: "test-device",
    timestamp: 1000 + clock * 100,
    event_type: eventType as EventType,
    payload,
    version_clock: clock,
    tombstoned: false,
  };
}

async function pushEvents(relay: SyncRelay, motebitId: string, events: EventLogEntry[]) {
  const res = await relay.app.request(`/sync/${motebitId}/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({ events }),
  });
  expect(res.status).toBe(200);
}

/** Save a plan directly to the persistence planStore (the table the execution endpoint reads). */
function savePlan(relay: SyncRelay, overrides?: Partial<Plan>): Plan {
  const plan: Plan = {
    plan_id: asPlanId(PLAN_ID),
    goal_id: asGoalId(GOAL_ID),
    motebit_id: asMotebitId(MOTEBIT_ID),
    title: "Test execution plan",
    status: PlanStatus.Completed,
    created_at: 1000,
    updated_at: 2000,
    current_step_index: 1,
    total_steps: 2,
    ...overrides,
  };
  relay.moteDb.planStore.savePlan(plan);
  return plan;
}

/** Save a step directly to the persistence planStore. */
function saveStep(relay: SyncRelay, ordinal: number, overrides?: Partial<PlanStep>): PlanStep {
  const step: PlanStep = {
    step_id: `step-${ordinal}`,
    plan_id: asPlanId(PLAN_ID),
    ordinal,
    description: `Step ${ordinal} description`,
    prompt: `Do step ${ordinal}`,
    depends_on: [],
    optional: false,
    status: StepStatus.Completed,
    result_summary: `Step ${ordinal} done`,
    error_message: null,
    tool_calls_made: 1,
    started_at: 1000 + ordinal * 500,
    completed_at: 1000 + ordinal * 500 + 400,
    retry_count: 0,
    updated_at: 1000 + ordinal * 500 + 400,
    ...overrides,
  };
  relay.moteDb.planStore.saveStep(step);
  return step;
}

// Response shape for the execution ledger endpoint
interface ExecutionLedgerResponse {
  spec: string;
  motebit_id: string;
  goal_id: string;
  plan_id: string;
  started_at: number;
  completed_at: number;
  status: string;
  timeline: Array<{ timestamp: number; type: string; payload: Record<string, unknown> }>;
  steps: Array<Record<string, unknown>>;
  delegation_receipts: Array<Record<string, unknown>>;
  content_hash: string;
}

// === Tests ===

describe("Execution Ledger Reconstruction — GET /api/v1/execution/:motebitId/:goalId", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  // --- 1. Full lifecycle reconstruction ---

  it("reconstructs a complete execution ledger from plan + lifecycle events", async () => {
    // Save plan and steps to persistence planStore
    savePlan(relay);
    saveStep(relay, 0);
    saveStep(relay, 1);

    // Push lifecycle events
    const events = [
      makeEvent(MOTEBIT_ID, 1, EventType.GoalCreated, {
        goal_id: GOAL_ID,
        description: "Test goal",
      }),
      makeEvent(MOTEBIT_ID, 2, EventType.PlanCreated, {
        plan_id: PLAN_ID,
        goal_id: GOAL_ID,
        title: "Test execution plan",
        total_steps: 2,
      }),
      makeEvent(MOTEBIT_ID, 3, EventType.PlanStepStarted, {
        plan_id: PLAN_ID,
        step_id: "step-0",
        ordinal: 0,
        description: "Step 0 description",
      }),
      makeEvent(MOTEBIT_ID, 4, EventType.PlanStepCompleted, {
        plan_id: PLAN_ID,
        step_id: "step-0",
        ordinal: 0,
        tool_calls_made: 1,
      }),
      makeEvent(MOTEBIT_ID, 5, EventType.PlanStepStarted, {
        plan_id: PLAN_ID,
        step_id: "step-1",
        ordinal: 1,
        description: "Step 1 description",
      }),
      makeEvent(MOTEBIT_ID, 6, EventType.PlanStepCompleted, {
        plan_id: PLAN_ID,
        step_id: "step-1",
        ordinal: 1,
        tool_calls_made: 1,
      }),
      makeEvent(MOTEBIT_ID, 7, EventType.PlanCompleted, {
        plan_id: PLAN_ID,
      }),
      makeEvent(MOTEBIT_ID, 8, EventType.GoalCompleted, {
        goal_id: GOAL_ID,
        status: "completed",
      }),
    ];
    await pushEvents(relay, MOTEBIT_ID, events);

    // GET the execution ledger
    const res = await relay.app.request(`/api/v1/execution/${MOTEBIT_ID}/${GOAL_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ExecutionLedgerResponse;

    // Verify top-level structure
    expect(body.spec).toBe("motebit/execution-ledger@1.0");
    expect(body.motebit_id).toBe(MOTEBIT_ID);
    expect(body.goal_id).toBe(GOAL_ID);
    expect(body.plan_id).toBe(PLAN_ID);
    expect(body.status).toBe("completed");
    expect(body.started_at).toBeTypeOf("number");
    expect(body.completed_at).toBeTypeOf("number");
    expect(body.content_hash).toBeTypeOf("string");
    expect(body.content_hash).toHaveLength(64); // SHA-256 hex

    // Verify timeline ordering and types
    expect(body.timeline.length).toBeGreaterThanOrEqual(6);
    const types = body.timeline.map((t) => t.type);
    expect(types[0]).toBe("goal_started");
    expect(types).toContain("plan_created");
    expect(types).toContain("step_started");
    expect(types).toContain("step_completed");
    expect(types).toContain("plan_completed");
    expect(types[types.length - 1]).toBe("goal_completed");

    // Verify timeline is sorted by timestamp
    for (let i = 1; i < body.timeline.length; i++) {
      expect(body.timeline[i]!.timestamp).toBeGreaterThanOrEqual(body.timeline[i - 1]!.timestamp);
    }

    // Verify step summaries
    expect(body.steps).toHaveLength(2);
    expect(body.steps[0]!.step_id).toBe("step-0");
    expect(body.steps[0]!.ordinal).toBe(0);
    expect(body.steps[0]!.status).toBe("completed");
    expect(body.steps[0]!.description).toBe("Step 0 description");
    expect(body.steps[1]!.step_id).toBe("step-1");
    expect(body.steps[1]!.ordinal).toBe(1);

    // Verify delegation_receipts is empty for non-delegated execution
    expect(body.delegation_receipts).toEqual([]);
  });

  // --- 2. 404 when no plan exists ---

  it("returns 404 when no plan exists for the goal", async () => {
    const res = await relay.app.request(`/api/v1/execution/${MOTEBIT_ID}/nonexistent-goal`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(404);
  });

  it("returns 404 when plan exists but motebit_id does not match", async () => {
    savePlan(relay);

    const res = await relay.app.request(`/api/v1/execution/wrong-motebit-id/${GOAL_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(404);
  });

  // --- 3. Delegation events ---

  it("includes delegation events and receipt summaries in the ledger", async () => {
    const delegationTaskId = "task-delegated-1";

    savePlan(relay, { total_steps: 1 });
    saveStep(relay, 0, { delegation_task_id: delegationTaskId });

    // Push lifecycle events including delegation
    const events = [
      makeEvent(MOTEBIT_ID, 1, EventType.GoalCreated, {
        goal_id: GOAL_ID,
      }),
      makeEvent(MOTEBIT_ID, 2, EventType.PlanCreated, {
        plan_id: PLAN_ID,
        goal_id: GOAL_ID,
        title: "Delegated plan",
        total_steps: 1,
      }),
      makeEvent(MOTEBIT_ID, 3, EventType.PlanStepDelegated, {
        plan_id: PLAN_ID,
        step_id: "step-0",
        ordinal: 0,
        task_id: delegationTaskId,
      }),
      makeEvent(MOTEBIT_ID, 4, EventType.AgentTaskCompleted, {
        task_id: delegationTaskId,
        goal_id: GOAL_ID,
        status: "completed",
        tools_used: ["web_search", "read_url"],
        receipt: {
          motebit_id: "delegate-mote",
          device_id: "delegate-device",
          completed_at: 1400,
          signature: "abc123deadbeef",
        },
      }),
      makeEvent(MOTEBIT_ID, 5, EventType.PlanStepCompleted, {
        plan_id: PLAN_ID,
        step_id: "step-0",
        ordinal: 0,
        tool_calls_made: 0,
      }),
      makeEvent(MOTEBIT_ID, 6, EventType.GoalCompleted, {
        goal_id: GOAL_ID,
        status: "completed",
      }),
    ];
    await pushEvents(relay, MOTEBIT_ID, events);

    const res = await relay.app.request(`/api/v1/execution/${MOTEBIT_ID}/${GOAL_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ExecutionLedgerResponse;

    // Timeline should include step_delegated
    const types = body.timeline.map((t) => t.type);
    expect(types).toContain("step_delegated");

    // Delegation receipts should contain the receipt info
    expect(body.delegation_receipts).toHaveLength(1);
    const receipt = body.delegation_receipts[0]!;
    expect(receipt.task_id).toBe(delegationTaskId);
    expect(receipt.motebit_id).toBe("delegate-mote");
    expect(receipt.device_id).toBe("delegate-device");
    expect(receipt.status).toBe("completed");
    expect(receipt.tools_used).toEqual(["web_search", "read_url"]);
    expect(receipt.signature_prefix).toBe("abc123deadbeef");
  });

  // --- 4. Step summaries include delegation info ---

  it("step summaries include delegation task_id and receipt_hash", async () => {
    const delegationTaskId = "task-del-summary";

    savePlan(relay, { total_steps: 1 });
    saveStep(relay, 0, { delegation_task_id: delegationTaskId });

    // Push agent_task_completed event with receipt
    const events = [
      makeEvent(MOTEBIT_ID, 1, EventType.GoalCreated, {
        goal_id: GOAL_ID,
      }),
      makeEvent(MOTEBIT_ID, 2, EventType.AgentTaskCompleted, {
        task_id: delegationTaskId,
        goal_id: GOAL_ID,
        status: "completed",
        tools_used: [],
        receipt: {
          motebit_id: "delegate-mote",
          device_id: "delegate-device",
          completed_at: 1500,
          signature: "sig-hash-value",
        },
      }),
    ];
    await pushEvents(relay, MOTEBIT_ID, events);

    const res = await relay.app.request(`/api/v1/execution/${MOTEBIT_ID}/${GOAL_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ExecutionLedgerResponse;

    // Step summary should include delegation info
    expect(body.steps).toHaveLength(1);
    const step = body.steps[0]! as Record<string, unknown>;
    expect(step.delegation).toBeDefined();
    const delegation = step.delegation as { task_id: string; receipt_hash: string };
    expect(delegation.task_id).toBe(delegationTaskId);
    expect(delegation.receipt_hash).toBe("sig-hash-value");
  });

  // --- 5. Content hash is consistent ---

  it("content_hash is consistent for the same timeline data", async () => {
    savePlan(relay);
    saveStep(relay, 0);

    const events = [
      makeEvent(MOTEBIT_ID, 1, EventType.GoalCreated, {
        goal_id: GOAL_ID,
      }),
      makeEvent(MOTEBIT_ID, 2, EventType.PlanCreated, {
        plan_id: PLAN_ID,
        goal_id: GOAL_ID,
        title: "Hash test",
        total_steps: 1,
      }),
      makeEvent(MOTEBIT_ID, 3, EventType.GoalCompleted, {
        goal_id: GOAL_ID,
      }),
    ];
    await pushEvents(relay, MOTEBIT_ID, events);

    // Fetch twice — hash must be identical
    const res1 = await relay.app.request(`/api/v1/execution/${MOTEBIT_ID}/${GOAL_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    const body1 = (await res1.json()) as ExecutionLedgerResponse;

    const res2 = await relay.app.request(`/api/v1/execution/${MOTEBIT_ID}/${GOAL_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    const body2 = (await res2.json()) as ExecutionLedgerResponse;

    expect(body1.content_hash).toBe(body2.content_hash);
    expect(body1.content_hash).toHaveLength(64);
  });

  // --- 6. Timeline field filtering (no raw payload leak) ---

  it("timeline entries contain only mapped fields, not raw event payloads", async () => {
    savePlan(relay);
    saveStep(relay, 0);

    const events = [
      makeEvent(MOTEBIT_ID, 1, EventType.GoalCreated, {
        goal_id: GOAL_ID,
        description: "Test goal",
        secret_internal_field: "should_not_leak",
      }),
      makeEvent(MOTEBIT_ID, 2, EventType.PlanCreated, {
        plan_id: PLAN_ID,
        goal_id: GOAL_ID,
        title: "Filtered plan",
        total_steps: 1,
        internal_data: "should_not_leak",
      }),
      makeEvent(MOTEBIT_ID, 3, EventType.PlanStepStarted, {
        plan_id: PLAN_ID,
        step_id: "step-0",
        ordinal: 0,
        description: "Do something",
        private_info: "should_not_leak",
      }),
    ];
    await pushEvents(relay, MOTEBIT_ID, events);

    const res = await relay.app.request(`/api/v1/execution/${MOTEBIT_ID}/${GOAL_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ExecutionLedgerResponse;

    // Verify no leaked fields in any timeline entry
    for (const entry of body.timeline) {
      expect(entry.payload).not.toHaveProperty("secret_internal_field");
      expect(entry.payload).not.toHaveProperty("internal_data");
      expect(entry.payload).not.toHaveProperty("private_info");
    }

    // Verify the plan_created entry has only the mapped fields
    const planCreated = body.timeline.find((t) => t.type === "plan_created");
    expect(planCreated).toBeDefined();
    expect(planCreated!.payload.plan_id).toBe(PLAN_ID);
    expect(planCreated!.payload.title).toBe("Filtered plan");
    expect(planCreated!.payload.total_steps).toBe(1);
  });

  // --- 7. Plan with no events still returns structure ---

  it("returns ledger with minimal timeline when plan exists but no events", async () => {
    savePlan(relay);
    saveStep(relay, 0);

    const res = await relay.app.request(`/api/v1/execution/${MOTEBIT_ID}/${GOAL_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ExecutionLedgerResponse;

    expect(body.spec).toBe("motebit/execution-ledger@1.0");
    expect(body.plan_id).toBe(PLAN_ID);
    expect(body.timeline).toEqual([]);
    expect(body.steps).toHaveLength(1);
    expect(body.delegation_receipts).toEqual([]);
    expect(body.content_hash).toHaveLength(64);
    // started_at/completed_at fall back to plan timestamps when timeline is empty
    expect(body.started_at).toBe(1000); // plan.created_at
    expect(body.completed_at).toBe(2000); // plan.updated_at
  });

  // --- 8. Status mapping ---

  it("maps plan status correctly to ledger status", async () => {
    savePlan(relay, { status: PlanStatus.Active });
    saveStep(relay, 0, { status: StepStatus.Running });

    const res = await relay.app.request(`/api/v1/execution/${MOTEBIT_ID}/${GOAL_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ExecutionLedgerResponse;
    expect(body.status).toBe("active");
  });

  it("maps failed plan status to failed ledger status", async () => {
    const failedGoalId = "goal-failed-1";
    const failedPlanId = "plan-failed-1";

    savePlan(relay, {
      plan_id: asPlanId(failedPlanId),
      goal_id: asGoalId(failedGoalId),
      status: PlanStatus.Failed,
    });
    saveStep(relay, 0, {
      plan_id: asPlanId(failedPlanId),
      status: StepStatus.Failed,
      error_message: "Something went wrong",
    });

    const res = await relay.app.request(`/api/v1/execution/${MOTEBIT_ID}/${failedGoalId}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ExecutionLedgerResponse;
    expect(body.status).toBe("failed");
  });

  // --- 9. agent_task_failed delegation events ---

  it("includes agent_task_failed in delegation receipts", async () => {
    const taskId = "task-failed-delegation";

    savePlan(relay, { status: PlanStatus.Failed, total_steps: 1 });
    saveStep(relay, 0, { delegation_task_id: taskId, status: StepStatus.Failed });

    const events = [
      makeEvent(MOTEBIT_ID, 1, EventType.GoalCreated, {
        goal_id: GOAL_ID,
      }),
      makeEvent(MOTEBIT_ID, 2, EventType.AgentTaskFailed, {
        task_id: taskId,
        goal_id: GOAL_ID,
        status: "failed",
        tools_used: [],
        receipt: {
          motebit_id: "failed-delegate",
          device_id: "failed-device",
          completed_at: 1300,
          signature: "failed-sig",
        },
      }),
    ];
    await pushEvents(relay, MOTEBIT_ID, events);

    const res = await relay.app.request(`/api/v1/execution/${MOTEBIT_ID}/${GOAL_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ExecutionLedgerResponse;

    expect(body.delegation_receipts).toHaveLength(1);
    expect(body.delegation_receipts[0]!.task_id).toBe(taskId);
    expect(body.delegation_receipts[0]!.status).toBe("failed");
    expect(body.delegation_receipts[0]!.motebit_id).toBe("failed-delegate");
  });

  // --- 10. step_failed in timeline ---

  it("includes step_failed and plan_failed events in the timeline", async () => {
    savePlan(relay, { status: PlanStatus.Failed, total_steps: 1 });
    saveStep(relay, 0, { status: StepStatus.Failed, error_message: "Timeout" });

    const events = [
      makeEvent(MOTEBIT_ID, 1, EventType.GoalCreated, {
        goal_id: GOAL_ID,
      }),
      makeEvent(MOTEBIT_ID, 2, EventType.PlanStepFailed, {
        plan_id: PLAN_ID,
        step_id: "step-0",
        ordinal: 0,
        error: "Timeout",
      }),
      makeEvent(MOTEBIT_ID, 3, EventType.PlanFailed, {
        plan_id: PLAN_ID,
        reason: "Step failed",
      }),
    ];
    await pushEvents(relay, MOTEBIT_ID, events);

    const res = await relay.app.request(`/api/v1/execution/${MOTEBIT_ID}/${GOAL_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ExecutionLedgerResponse;

    const types = body.timeline.map((t) => t.type);
    expect(types).toContain("step_failed");
    expect(types).toContain("plan_failed");

    const stepFailed = body.timeline.find((t) => t.type === "step_failed");
    expect(stepFailed!.payload.error).toBe("Timeout");

    const planFailed = body.timeline.find((t) => t.type === "plan_failed");
    expect(planFailed!.payload.reason).toBe("Step failed");
  });

  // --- 11. Tool audit entries in timeline ---

  it("includes tool_invoked and tool_result entries from audit sink", async () => {
    savePlan(relay);
    saveStep(relay, 0);

    // Push tool audit entries directly to the in-memory audit sink
    relay.moteDb.toolAuditSink.append({
      turnId: "turn-1",
      runId: PLAN_ID, // queryByRunId matches on plan_id
      callId: "call-1",
      tool: "web_search",
      args: { query: "test" },
      decision: { allowed: true, requiresApproval: false, reason: "auto-approved" },
      result: { ok: true, durationMs: 150 },
      timestamp: 1050,
    });
    relay.moteDb.toolAuditSink.append({
      turnId: "turn-1",
      runId: PLAN_ID,
      callId: "call-2",
      tool: "read_file",
      args: { path: "/tmp/test" },
      decision: { allowed: true, requiresApproval: false, reason: "auto-approved" },
      result: { ok: false, durationMs: 50 },
      timestamp: 1200,
    });
    // A denied tool call should NOT appear in timeline
    relay.moteDb.toolAuditSink.append({
      turnId: "turn-1",
      runId: PLAN_ID,
      callId: "call-3",
      tool: "dangerous_tool",
      args: {},
      decision: { allowed: false, requiresApproval: false, reason: "blocked by policy" },
      timestamp: 1300,
    });

    const events = [
      makeEvent(MOTEBIT_ID, 1, EventType.GoalCreated, {
        goal_id: GOAL_ID,
      }),
    ];
    await pushEvents(relay, MOTEBIT_ID, events);

    const res = await relay.app.request(`/api/v1/execution/${MOTEBIT_ID}/${GOAL_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ExecutionLedgerResponse;

    const types = body.timeline.map((t) => t.type);
    // Two allowed tool calls produce tool_invoked + tool_result each
    expect(types.filter((t) => t === "tool_invoked")).toHaveLength(2);
    expect(types.filter((t) => t === "tool_result")).toHaveLength(2);

    // Verify tool_invoked payload
    const invocations = body.timeline.filter((t) => t.type === "tool_invoked");
    expect(invocations[0]!.payload.tool).toBe("web_search");
    expect(invocations[0]!.payload.call_id).toBe("call-1");
    expect(invocations[1]!.payload.tool).toBe("read_file");

    // Verify tool_result payload
    const results = body.timeline.filter((t) => t.type === "tool_result");
    expect(results[0]!.payload.ok).toBe(true);
    expect(results[0]!.payload.duration_ms).toBe(150);
    expect(results[1]!.payload.ok).toBe(false);

    // Denied tool should not appear
    const denied = body.timeline.filter(
      (t) => t.type === "tool_invoked" && t.payload.tool === "dangerous_tool",
    );
    expect(denied).toHaveLength(0);
  });

  // --- 12. Step summaries include tools_used from audit entries ---

  it("step summaries list tools_used from audit entries within step time window", async () => {
    savePlan(relay, { total_steps: 1 });
    // Step runs from 1000 to 1400
    saveStep(relay, 0, { started_at: 1000, completed_at: 1400 });

    // Tool call within the step time window
    relay.moteDb.toolAuditSink.append({
      turnId: "turn-1",
      runId: PLAN_ID,
      callId: "call-window",
      tool: "file_read",
      args: {},
      decision: { allowed: true, requiresApproval: false, reason: "ok" },
      result: { ok: true, durationMs: 100 },
      timestamp: 1100, // within [1000, 1400]
    });
    // Tool call outside the step time window (should not appear in step summary)
    relay.moteDb.toolAuditSink.append({
      turnId: "turn-2",
      runId: PLAN_ID,
      callId: "call-outside",
      tool: "outside_tool",
      args: {},
      decision: { allowed: true, requiresApproval: false, reason: "ok" },
      result: { ok: true, durationMs: 10 },
      timestamp: 2000, // after step completed_at
    });

    const res = await relay.app.request(`/api/v1/execution/${MOTEBIT_ID}/${GOAL_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as ExecutionLedgerResponse;

    expect(body.steps).toHaveLength(1);
    const step = body.steps[0]!;
    expect(step.tools_used).toEqual(["file_read"]);
  });
});

// === Layered content-provenance — relay-asserted outer manifest =============
//
// The reconstructive endpoint wraps the spec-1.0-compliant inner body in a
// `ContentArtifactManifest` signed by the relay's identity, transported via
// the `X-Motebit-Content-Manifest` HTTP header (C2PA-shape sidecar).
//
// Witness-composition: relay attests "this is what I assembled from my
// event log at time T," signed by `relayIdentity`. Each rejection mode
// below pins one of the layered invariants — body tamper, header tamper,
// producer-key swap.

function decodeManifestHeader(headerValue: string | null): ContentArtifactManifest {
  if (headerValue == null || headerValue === "") {
    throw new Error("X-Motebit-Content-Manifest header missing");
  }
  const manifestBytes = fromBase64Url(headerValue);
  const manifestJson = new TextDecoder().decode(manifestBytes);
  return JSON.parse(manifestJson) as ContentArtifactManifest;
}

describe("Execution Ledger — relay-asserted outer manifest (X-Motebit-Content-Manifest)", () => {
  let relay: SyncRelay;

  beforeEach(async () => {
    relay = await createTestRelay();
  });

  afterEach(async () => {
    await relay.close();
  });

  async function fetchLedgerWithManifest(): Promise<{
    bodyBytes: Uint8Array;
    manifest: ContentArtifactManifest;
  }> {
    savePlan(relay);
    saveStep(relay, 0);
    await pushEvents(relay, MOTEBIT_ID, [
      makeEvent(MOTEBIT_ID, 1, EventType.GoalCreated, { goal_id: GOAL_ID }),
      makeEvent(MOTEBIT_ID, 2, EventType.PlanCreated, {
        plan_id: PLAN_ID,
        goal_id: GOAL_ID,
        total_steps: 1,
      }),
      makeEvent(MOTEBIT_ID, 3, EventType.PlanStepCompleted, {
        plan_id: PLAN_ID,
        step_id: "step-0",
        ordinal: 0,
        tool_calls_made: 1,
      }),
      makeEvent(MOTEBIT_ID, 4, EventType.GoalCompleted, { goal_id: GOAL_ID }),
    ]);

    const res = await relay.app.request(`/api/v1/execution/${MOTEBIT_ID}/${GOAL_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const bodyBytes = new Uint8Array(await res.arrayBuffer());
    const manifest = decodeManifestHeader(res.headers.get("X-Motebit-Content-Manifest"));
    return { bodyBytes, manifest };
  }

  it("emits a manifest header that round-trips verify against the response body", async () => {
    const { bodyBytes, manifest } = await fetchLedgerWithManifest();

    expect(manifest.suite).toBe(CONTENT_ARTIFACT_SUITE);
    expect(manifest.artifact_type).toBe("execution-ledger");
    expect(manifest.claim_generator).toMatch(/^motebit-relay\//);
    expect(manifest.producer).toMatch(/^did:key:/);
    expect(manifest.producer_public_key).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.signature).toMatch(/^[A-Za-z0-9_-]+$/);

    const result = await verifyContentArtifact(manifest, bodyBytes);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("rejects with content_hash_mismatch when the response body is tampered", async () => {
    const { bodyBytes, manifest } = await fetchLedgerWithManifest();
    // Flip one byte in the body — verifier hashes the received bytes,
    // computed hash diverges from manifest.content_hash, fail-closed.
    const tampered = new Uint8Array(bodyBytes);
    tampered[0] = tampered[0]! ^ 0x01;
    const result = await verifyContentArtifact(manifest, tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("content_hash_mismatch");
  });

  it("rejects with signature_invalid when the manifest claim is tampered", async () => {
    const { bodyBytes, manifest } = await fetchLedgerWithManifest();
    // Mutate the claim_generator — content_hash still matches (we
    // didn't touch the body) but the signature was over the original
    // manifest body.
    const tamperedManifest: ContentArtifactManifest = {
      ...manifest,
      claim_generator: "motebit-relay/9.9.9-evil",
    };
    const result = await verifyContentArtifact(tamperedManifest, bodyBytes);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature_invalid");
  });

  it("rejects with signature_invalid when the declared producer key is swapped", async () => {
    const { bodyBytes, manifest } = await fetchLedgerWithManifest();
    // Replace the producer key with a different all-zeros key —
    // verifyBySuite computes against the wrong key and fails.
    const swapped: ContentArtifactManifest = {
      ...manifest,
      producer_public_key: "0".repeat(64),
    };
    const result = await verifyContentArtifact(swapped, bodyBytes);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature_invalid");
  });

  it("inner spec-1.0 body remains parseable as JSON alongside the outer manifest", async () => {
    const { bodyBytes } = await fetchLedgerWithManifest();
    // Reading the body as JSON must still work — the manifest is in
    // the header, not the payload. Existing consumers that only read
    // the body are unaffected by the layered signing.
    const parsed = JSON.parse(new TextDecoder().decode(bodyBytes)) as ExecutionLedgerResponse;
    expect(parsed.spec).toBe("motebit/execution-ledger@1.0");
    expect(parsed.motebit_id).toBe(MOTEBIT_ID);
    expect(parsed.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("response Content-Type stays application/json (no breaking transport change)", async () => {
    savePlan(relay);
    saveStep(relay, 0);
    await pushEvents(relay, MOTEBIT_ID, [
      makeEvent(MOTEBIT_ID, 1, EventType.GoalCreated, { goal_id: GOAL_ID }),
      makeEvent(MOTEBIT_ID, 2, EventType.GoalCompleted, { goal_id: GOAL_ID }),
    ]);
    const res = await relay.app.request(`/api/v1/execution/${MOTEBIT_ID}/${GOAL_ID}`, {
      method: "GET",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/application\/json/);
  });
});
