import { describe, it, expect, vi } from "vitest";
import {
  TauriConversationSyncStoreAdapter,
  TauriPlanSyncStoreAdapter,
} from "../tauri-sync-adapters";

// ---------------------------------------------------------------------------
// TauriConversationSyncStoreAdapter
// ---------------------------------------------------------------------------

describe("TauriConversationSyncStoreAdapter", () => {
  it("returns empty arrays before prefetch", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store: any = {
      upsertConversation: vi.fn(),
      upsertMessage: vi.fn(),
      getConversationsSince: vi.fn(async () => []),
      getMessagesSince: vi.fn(async () => []),
    };
    const adapter = new TauriConversationSyncStoreAdapter(store, "motebit-1");
    expect(adapter.getConversationsSince("motebit-1", 0)).toEqual([]);
    expect(adapter.getMessagesSince("c1", 0)).toEqual([]);
  });

  it("prefetch loads from store, filters by motebit_id + since", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store: any = {
      upsertConversation: vi.fn(),
      upsertMessage: vi.fn(),
      getConversationsSince: vi.fn(async () => [
        {
          conversation_id: "c1",
          motebit_id: "motebit-1",
          last_active_at: 100,
        },
        {
          conversation_id: "c2",
          motebit_id: "motebit-2", // different — filtered out
          last_active_at: 100,
        },
      ]),
      getMessagesSince: vi.fn(async () => [
        { message_id: "m1", conversation_id: "c1", created_at: 50 },
        { message_id: "m2", conversation_id: "c1", created_at: 200 },
      ]),
    };
    const adapter = new TauriConversationSyncStoreAdapter(store, "motebit-1");
    await adapter.prefetch(0);

    const convos = adapter.getConversationsSince("motebit-1", 50);
    expect(convos).toHaveLength(1);
    expect(convos[0]?.conversation_id).toBe("c1");

    const msgs = adapter.getMessagesSince("c1", 75);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.message_id).toBe("m2");
  });

  it("upsert methods forward to store", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store: any = {
      upsertConversation: vi.fn(async () => {}),
      upsertMessage: vi.fn(async () => {}),
      getConversationsSince: vi.fn(async () => []),
      getMessagesSince: vi.fn(async () => []),
    };
    const adapter = new TauriConversationSyncStoreAdapter(store, "m");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapter.upsertConversation({ conversation_id: "c", motebit_id: "m" } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    adapter.upsertMessage({ message_id: "msg", conversation_id: "c" } as any);
    expect(store.upsertConversation).toHaveBeenCalled();
    expect(store.upsertMessage).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TauriPlanSyncStoreAdapter
// ---------------------------------------------------------------------------

describe("TauriPlanSyncStoreAdapter", () => {
  function makeStore(overrides: Record<string, unknown> = {}) {
    const plans = new Map<string, Record<string, unknown>>();
    const steps = new Map<string, Record<string, unknown>>();
    return {
      savePlan: vi.fn((p: Record<string, unknown>) => {
        plans.set(p.plan_id as string, p);
      }),
      saveStep: vi.fn((s: Record<string, unknown>) => {
        steps.set(s.step_id as string, s);
      }),
      getPlan: vi.fn((id: string) => plans.get(id)),
      getStep: vi.fn((id: string) => steps.get(id)),
      listAllPlans: vi.fn(() => []),
      listActivePlans: vi.fn(() => []),
      getStepsForPlan: vi.fn(() => []),
      ...overrides,
    };
  }

  it("empty before prefetch", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new TauriPlanSyncStoreAdapter(makeStore() as any, "m1");
    expect(adapter.getPlansSince("m1", 0)).toEqual([]);
    expect(adapter.getStepsSince("m1", 0)).toEqual([]);
  });

  it("prefetch uses listAllPlans when available", async () => {
    const store = makeStore({
      listAllPlans: vi.fn(() => [
        {
          plan_id: "p1",
          goal_id: "g1",
          motebit_id: "m1",
          title: "t",
          status: "active",
          created_at: 1,
          updated_at: 10,
          current_step_index: 0,
          total_steps: 2,
          collaborative: false,
        },
      ]),
      getStepsForPlan: vi.fn(() => [
        {
          step_id: "s1",
          plan_id: "p1",
          ordinal: 0,
          description: "d",
          prompt: "p",
          depends_on: [],
          optional: false,
          status: "pending",
          tool_calls_made: 0,
          retry_count: 0,
          updated_at: 5,
        },
      ]),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new TauriPlanSyncStoreAdapter(store as any, "m1");
    await adapter.prefetch(0);
    expect(store.listAllPlans).toHaveBeenCalledWith("m1");
    expect(adapter.getPlansSince("m1", 0)).toHaveLength(1);
    expect(adapter.getStepsSince("m1", 0)).toHaveLength(1);
  });

  it("prefetch falls back to listActivePlans if listAllPlans missing", async () => {
    const store = {
      savePlan: vi.fn(),
      saveStep: vi.fn(),
      getPlan: vi.fn(),
      getStep: vi.fn(),
      listActivePlans: vi.fn(() => []),
      getStepsForPlan: vi.fn(() => []),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new TauriPlanSyncStoreAdapter(store as any, "m1");
    await adapter.prefetch(0);
    expect(store.listActivePlans).toHaveBeenCalled();
  });

  it("upsertPlan inserts new plan", () => {
    const store = makeStore();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new TauriPlanSyncStoreAdapter(store as any, "m1");
    adapter.upsertPlan({
      plan_id: "p1",
      goal_id: "g1",
      motebit_id: "m1",
      title: "t",
      status: "active",
      created_at: 1,
      updated_at: 10,
      current_step_index: 0,
      total_steps: 1,
      proposal_id: null,
      collaborative: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(store.savePlan).toHaveBeenCalled();
  });

  it("upsertPlan skips when existing plan is newer", () => {
    const store = makeStore({
      getPlan: vi.fn(() => ({ updated_at: 100 })),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new TauriPlanSyncStoreAdapter(store as any, "m1");
    adapter.upsertPlan({
      plan_id: "p1",
      goal_id: "g1",
      motebit_id: "m1",
      title: "t",
      status: "active",
      created_at: 1,
      updated_at: 50, // stale
      current_step_index: 0,
      total_steps: 1,
      proposal_id: null,
      collaborative: 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(store.savePlan).not.toHaveBeenCalled();
  });

  it("upsertStep enforces status monotonicity", () => {
    const store = makeStore({
      getStep: vi.fn(() => ({ status: "completed" })),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new TauriPlanSyncStoreAdapter(store as any, "m1");
    adapter.upsertStep({
      step_id: "s1",
      plan_id: "p1",
      motebit_id: "m1",
      ordinal: 0,
      description: "d",
      prompt: "p",
      depends_on: "[]",
      optional: false,
      status: "running", // regression — should be dropped
      required_capabilities: null,
      delegation_task_id: null,
      assigned_motebit_id: null,
      result_summary: null,
      error_message: null,
      tool_calls_made: 0,
      started_at: null,
      completed_at: null,
      retry_count: 0,
      updated_at: 200,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(store.saveStep).not.toHaveBeenCalled();
  });

  it("upsertStep allows forward progress", () => {
    const store = makeStore({
      getStep: vi.fn(() => ({ status: "pending" })),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new TauriPlanSyncStoreAdapter(store as any, "m1");
    adapter.upsertStep({
      step_id: "s1",
      plan_id: "p1",
      motebit_id: "m1",
      ordinal: 0,
      description: "d",
      prompt: "p",
      depends_on: "[]",
      optional: false,
      status: "running",
      required_capabilities: null,
      delegation_task_id: null,
      assigned_motebit_id: null,
      result_summary: null,
      error_message: null,
      tool_calls_made: 1,
      started_at: 100,
      completed_at: null,
      retry_count: 0,
      updated_at: 200,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(store.saveStep).toHaveBeenCalled();
  });

  it("upsertStep with no existing step inserts", () => {
    const store = makeStore({
      getStep: vi.fn(() => undefined),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new TauriPlanSyncStoreAdapter(store as any, "m1");
    adapter.upsertStep({
      step_id: "s1",
      plan_id: "p1",
      motebit_id: "m1",
      ordinal: 0,
      description: "d",
      prompt: "p",
      depends_on: "[]",
      optional: false,
      status: "pending",
      required_capabilities: '["web_search"]',
      delegation_task_id: "t1",
      assigned_motebit_id: "a1",
      result_summary: "summary",
      error_message: null,
      tool_calls_made: 0,
      started_at: null,
      completed_at: null,
      retry_count: 0,
      updated_at: 50,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(store.saveStep).toHaveBeenCalled();
    const saved = store.saveStep.mock.calls[0]?.[0] as { required_capabilities: unknown };
    expect(saved.required_capabilities).toEqual(["web_search"]);
  });

  it("getPlansSince + getStepsSince filter by updated_at", async () => {
    const store = makeStore({
      listAllPlans: vi.fn(() => [
        {
          plan_id: "p1",
          goal_id: "g",
          motebit_id: "m",
          title: "",
          status: "active",
          created_at: 0,
          updated_at: 100,
          current_step_index: 0,
          total_steps: 1,
          collaborative: true,
          proposal_id: "prop-1",
        },
        {
          plan_id: "p2",
          goal_id: "g",
          motebit_id: "m",
          title: "",
          status: "active",
          created_at: 0,
          updated_at: 50,
          current_step_index: 0,
          total_steps: 1,
          collaborative: false,
        },
      ]),
      getStepsForPlan: vi.fn(() => []),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = new TauriPlanSyncStoreAdapter(store as any, "m1");
    await adapter.prefetch(0);
    const plans = adapter.getPlansSince("m1", 75);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.plan_id).toBe("p1");
    expect(plans[0]?.collaborative).toBe(1);
    expect(plans[0]?.proposal_id).toBe("prop-1");
  });
});
