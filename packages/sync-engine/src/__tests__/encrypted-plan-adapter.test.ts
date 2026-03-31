import { describe, it, expect } from "vitest";
import { EncryptedPlanSyncAdapter } from "../encrypted-plan-adapter.js";
import { generateKey } from "@motebit/crypto";
import type { SyncPlan, SyncPlanStep } from "@motebit/sdk";
import type { PlanSyncRemoteAdapter } from "../plan-sync.js";

// ---------------------------------------------------------------------------
// In-memory mock adapter
// ---------------------------------------------------------------------------

class InMemoryPlanAdapter implements PlanSyncRemoteAdapter {
  plans: SyncPlan[] = [];
  steps: SyncPlanStep[] = [];

  async pushPlans(_motebitId: string, plans: SyncPlan[]): Promise<number> {
    this.plans.push(...plans);
    return plans.length;
  }

  async pullPlans(_motebitId: string, _since: number): Promise<SyncPlan[]> {
    return this.plans;
  }

  async pushSteps(_motebitId: string, steps: SyncPlanStep[]): Promise<number> {
    this.steps.push(...steps);
    return steps.length;
  }

  async pullSteps(_motebitId: string, _since: number): Promise<SyncPlanStep[]> {
    return this.steps;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOTEBIT_ID = "motebit-plan-enc-test";

function makePlan(overrides: Partial<SyncPlan> = {}): SyncPlan {
  return {
    plan_id: "plan-1",
    motebit_id: MOTEBIT_ID,
    title: "Test plan title",
    status: "running",
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  } as SyncPlan;
}

function makeStep(overrides: Partial<SyncPlanStep> = {}): SyncPlanStep {
  return {
    step_id: "step-1",
    plan_id: "plan-1",
    motebit_id: MOTEBIT_ID,
    ordinal: 0,
    description: "Search for information",
    prompt: "Find details about topic X",
    status: "completed",
    result_summary: "Found 3 relevant results",
    error_message: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  } as SyncPlanStep;
}

function makeAdapter(inner?: InMemoryPlanAdapter, key?: Uint8Array) {
  const store = inner ?? new InMemoryPlanAdapter();
  const k = key ?? generateKey();
  const adapter = new EncryptedPlanSyncAdapter({ inner: store, key: k });
  return { adapter, store, key: k };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EncryptedPlanSyncAdapter", () => {
  it("round-trips plan title through encrypt/decrypt", async () => {
    const { adapter } = makeAdapter();
    const plan = makePlan({ title: "Secret plan about finances" });

    await adapter.pushPlans(MOTEBIT_ID, [plan]);
    const results = await adapter.pullPlans(MOTEBIT_ID, 0);

    expect(results).toHaveLength(1);
    expect(results[0]!.title).toBe("Secret plan about finances");
  });

  it("encrypts plan title in the inner store", async () => {
    const store = new InMemoryPlanAdapter();
    const { adapter } = makeAdapter(store);
    const plan = makePlan({ title: "Confidential" });

    await adapter.pushPlans(MOTEBIT_ID, [plan]);

    // Inner store should have encrypted (not plaintext) title
    expect(store.plans[0]!.title).not.toBe("Confidential");
    expect(store.plans[0]!.title).toContain("\0ENC:");
  });

  it("round-trips step fields through encrypt/decrypt", async () => {
    const { adapter } = makeAdapter();
    const step = makeStep({
      description: "Sensitive step description",
      prompt: "Search medical records",
      result_summary: "Found patient data",
      error_message: null,
    });

    await adapter.pushSteps(MOTEBIT_ID, [step]);
    const results = await adapter.pullSteps(MOTEBIT_ID, 0);

    expect(results).toHaveLength(1);
    expect(results[0]!.description).toBe("Sensitive step description");
    expect(results[0]!.prompt).toBe("Search medical records");
    expect(results[0]!.result_summary).toBe("Found patient data");
    expect(results[0]!.error_message).toBeNull();
  });

  it("encrypts step sensitive fields in inner store", async () => {
    const store = new InMemoryPlanAdapter();
    const { adapter } = makeAdapter(store);
    const step = makeStep({
      description: "Secret",
      prompt: "Find secrets",
      result_summary: "Got them",
    });

    await adapter.pushSteps(MOTEBIT_ID, [step]);

    const stored = store.steps[0]!;
    expect(stored.description).toContain("\0ENC:");
    expect(stored.prompt).toContain("\0ENC:");
    expect(stored.result_summary).toContain("\0ENC:");
    // Cleartext fields preserved
    expect(stored.step_id).toBe("step-1");
    expect(stored.plan_id).toBe("plan-1");
    expect(stored.status).toBe("completed");
  });

  it("handles null/empty values gracefully", async () => {
    const { adapter } = makeAdapter();
    const step = makeStep({
      result_summary: null,
      error_message: null,
    });

    await adapter.pushSteps(MOTEBIT_ID, [step]);
    const results = await adapter.pullSteps(MOTEBIT_ID, 0);

    expect(results[0]!.result_summary).toBeNull();
    expect(results[0]!.error_message).toBeNull();
  });

  it("passes through plaintext on pull (backward compat)", async () => {
    const store = new InMemoryPlanAdapter();
    const { adapter } = makeAdapter(store);

    // Push plaintext directly to inner store (simulates pre-encryption data)
    store.plans.push(makePlan({ title: "Plaintext title" }));

    const results = await adapter.pullPlans(MOTEBIT_ID, 0);
    expect(results[0]!.title).toBe("Plaintext title");
  });

  it("different keys cannot decrypt each other's data", async () => {
    const store = new InMemoryPlanAdapter();
    const key1 = generateKey();
    const key2 = generateKey();

    const adapter1 = new EncryptedPlanSyncAdapter({ inner: store, key: key1 });
    const adapter2 = new EncryptedPlanSyncAdapter({ inner: store, key: key2 });

    await adapter1.pushPlans(MOTEBIT_ID, [makePlan({ title: "Key1 secret" })]);

    // Adapter2 with different key should fail to decrypt
    await expect(adapter2.pullPlans(MOTEBIT_ID, 0)).rejects.toThrow();
  });

  it("handles multiple plans and steps", async () => {
    const { adapter } = makeAdapter();

    await adapter.pushPlans(MOTEBIT_ID, [
      makePlan({ plan_id: "p1", title: "Plan A" }),
      makePlan({ plan_id: "p2", title: "Plan B" }),
    ]);
    await adapter.pushSteps(MOTEBIT_ID, [
      makeStep({ step_id: "s1", description: "Step 1" }),
      makeStep({ step_id: "s2", description: "Step 2" }),
      makeStep({ step_id: "s3", description: "Step 3" }),
    ]);

    const plans = await adapter.pullPlans(MOTEBIT_ID, 0);
    const steps = await adapter.pullSteps(MOTEBIT_ID, 0);

    expect(plans).toHaveLength(2);
    expect(plans[0]!.title).toBe("Plan A");
    expect(plans[1]!.title).toBe("Plan B");
    expect(steps).toHaveLength(3);
    expect(steps[2]!.description).toBe("Step 3");
  });
});
