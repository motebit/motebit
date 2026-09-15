/**
 * The write side of "a paid failure weighs more": `bumpTrustFromReceipt`
 * records extra pseudo-failures in the capability bucket, scaled by what was
 * paid, integer, capped — and a free failure writes none (byte-identical to
 * before). docs/doctrine/paid-failure-recourse.md.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { AgentTrustLevel } from "@motebit/sdk";
import type { ExecutionReceipt } from "@motebit/protocol";
import {
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
  InMemoryAgentTrustStore,
} from "../index";
import type { PlatformAdapters } from "../index";
import {
  paidFailureWeight,
  PAID_FAILURE_WEIGHT_CAP,
  UNSCOPED_PENALTY_BUCKET,
} from "../agent-trust.js";

const SELF = "test-mote";
const WORKER = "worker-1";
const failed = (id: string): ExecutionReceipt =>
  ({
    task_id: id,
    motebit_id: WORKER,
    device_id: "d",
    submitted_at: 1,
    completed_at: 2,
    status: "failed",
    result: "",
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "p",
    result_hash: "r",
    signature: "sig",
  }) as unknown as ExecutionReceipt;

describe("paidFailureWeight", () => {
  it("is 1 for free/unknown, scales by $0.01 steps, caps at 5", () => {
    expect(paidFailureWeight(undefined)).toBe(1);
    expect(paidFailureWeight(0)).toBe(1);
    expect(paidFailureWeight(-1)).toBe(1);
    expect(paidFailureWeight(Number.NaN)).toBe(1);
    expect(paidFailureWeight(0.003)).toBe(2);
    expect(paidFailureWeight(0.01)).toBe(2);
    expect(paidFailureWeight(0.02)).toBe(3);
    expect(paidFailureWeight(0.25)).toBe(PAID_FAILURE_WEIGHT_CAP);
    expect(paidFailureWeight(100)).toBe(PAID_FAILURE_WEIGHT_CAP);
  });
});

describe("bumpTrustFromReceipt — paid failures write a capability-bucket penalty", () => {
  let runtime: MotebitRuntime;
  let trustStore: InMemoryAgentTrustStore;
  beforeEach(() => {
    trustStore = new InMemoryAgentTrustStore();
    const adapters: PlatformAdapters = {
      storage: { ...createInMemoryStorage(), agentTrustStore: trustStore },
      renderer: new NullRenderer(),
    };
    runtime = new MotebitRuntime({ motebitId: SELF, tickRateHz: 0 }, adapters);
  });
  const bucket = async (key: string) =>
    (await trustStore.getAgentTrust(SELF as never, WORKER as never))?.capability_stats?.[key];

  it("a free failure writes failed_tasks +1 and NO penalty (unchanged behaviour)", async () => {
    await runtime.bumpTrustFromReceipt(failed("t1"), true, "web_search");
    expect(await bucket("web_search")).toEqual({ successful_tasks: 0, failed_tasks: 1 });
  });

  it("a $0.25 paid failure writes failed_tasks +1 and penalty +4 (weight 5); a $0.003 one adds +1 more", async () => {
    await runtime.bumpTrustFromReceipt(failed("t1"), true, "web_search", 0.25);
    expect(await bucket("web_search")).toEqual({
      successful_tasks: 0,
      failed_tasks: 1,
      paid_failure_penalty: 4,
    });
    await runtime.bumpTrustFromReceipt(failed("t2"), true, "web_search", 0.003);
    expect(await bucket("web_search")).toEqual({
      successful_tasks: 0,
      failed_tasks: 2,
      paid_failure_penalty: 5,
    });
    // The pairwise relationship is untouched by the penalty: level transitions read raw counts.
    const rec = await trustStore.getAgentTrust(SELF as never, WORKER as never);
    expect(rec?.failed_tasks).toBe(2);
    expect(rec?.trust_level).toBe(AgentTrustLevel.FirstContact);
  });

  it("a paid failure with no known capability lands in the `*` bucket rather than being dropped", async () => {
    await runtime.bumpTrustFromReceipt(failed("t1"), true, undefined, 0.05);
    expect(await bucket(UNSCOPED_PENALTY_BUCKET)).toEqual({
      successful_tasks: 0,
      failed_tasks: 0,
      paid_failure_penalty: 4,
    });
    const rec = await trustStore.getAgentTrust(SELF as never, WORKER as never);
    expect(rec?.failed_tasks).toBe(1);
  });

  it("an unverified receipt writes nothing, paid or not", async () => {
    await runtime.bumpTrustFromReceipt(failed("t1"), false, "web_search", 0.25);
    expect(await trustStore.getAgentTrust(SELF as never, WORKER as never)).toBeNull();
  });
});
