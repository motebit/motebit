/**
 * AgentGraphManager — direct unit tests for the runtime's algebraic
 * routing substrate.
 *
 * The semiring trust routing brain lives in the runtime, not the relay.
 * These tests prove the wiring between async stores and the synchronous
 * `addDelegationEdges` callback works end-to-end: trust records and
 * latency stats are pre-fetched once for the receipt tree, then read
 * from prebuilt maps when the semiring asks for them.
 *
 * Before the fix, async trust stores (including the default
 * InMemoryAgentTrustStore) hit a 0.1 placeholder fallback in
 * addReceiptEdges, and latency was hardcoded to 3000ms. The semiring
 * was being fed mock data on every multi-hop receipt update.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { ExecutionReceipt, AgentTrustRecord } from "@motebit/sdk";
import { AgentTrustLevel, asMotebitId, asDeviceId } from "@motebit/sdk";
import { trustLevelToScore } from "@motebit/semiring";

import { AgentGraphManager } from "../agent-graph.js";
import { InMemoryAgentTrustStore } from "../in-memory-agent-trust-store.js";

const SELF = asMotebitId("self-mote");

function makeReceipt(
  motebitId: string,
  delegationReceipts: ExecutionReceipt[] = [],
): ExecutionReceipt {
  return {
    task_id: `task-${motebitId}`,
    motebit_id: asMotebitId(motebitId),
    device_id: asDeviceId("dev-1"),
    submitted_at: Date.now() - 1000,
    completed_at: Date.now(),
    status: "completed",
    result: "ok",
    tools_used: [],
    memories_formed: 0,
    prompt_hash: "p",
    result_hash: "r",
    signature: "sig",
    delegation_receipts: delegationReceipts.length > 0 ? delegationReceipts : undefined,
  };
}

async function seedTrust(
  store: InMemoryAgentTrustStore,
  motebitId: string,
  level: AgentTrustLevel,
): Promise<void> {
  const record: AgentTrustRecord = {
    motebit_id: SELF,
    remote_motebit_id: asMotebitId(motebitId),
    trust_level: level,
    first_seen_at: Date.now() - 10000,
    last_seen_at: Date.now(),
    interaction_count: 5,
    successful_tasks: 5,
    failed_tasks: 0,
  };
  await store.setAgentTrust(record);
}

describe("AgentGraphManager.addReceiptEdges — async store + latency wiring", () => {
  let trustStore: InMemoryAgentTrustStore;

  beforeEach(() => {
    trustStore = new InMemoryAgentTrustStore();
  });

  it("uses real trust scores from an async store (not the 0.1 fallback)", async () => {
    // Seed two known agents at different trust levels.
    await seedTrust(trustStore, "verified-agent", AgentTrustLevel.Verified);
    await seedTrust(trustStore, "first-contact-agent", AgentTrustLevel.FirstContact);

    const mgr = new AgentGraphManager(SELF, trustStore, null, null);

    // A receipt where verified-agent delegated a sub-task to first-contact-agent.
    const receipt = makeReceipt("verified-agent", [makeReceipt("first-contact-agent")]);
    await mgr.addReceiptEdges(receipt);

    const snapshot = await mgr.getGraphSnapshot();

    // Self → verified-agent edge: should reflect Verified trust, not 0.1
    const verifiedEdge = snapshot.edges.find((e) => e.to === "verified-agent");
    expect(verifiedEdge).toBeDefined();
    const verifiedScore = trustLevelToScore(AgentTrustLevel.Verified);
    expect(verifiedEdge!.weight.trust).toBeCloseTo(verifiedScore, 5);
    // Sanity: Verified should not be the 0.1 placeholder
    expect(verifiedEdge!.weight.trust).toBeGreaterThan(0.15);

    // verified-agent → first-contact-agent edge: should reflect FirstContact trust
    const firstContactEdge = snapshot.edges.find(
      (e) => e.from === "verified-agent" && e.to === "first-contact-agent",
    );
    expect(firstContactEdge).toBeDefined();
    const firstContactScore = trustLevelToScore(AgentTrustLevel.FirstContact);
    expect(firstContactEdge!.weight.trust).toBeCloseTo(firstContactScore, 5);
  });

  it("falls back to 0.1 for unknown agents (not in the trust store)", async () => {
    // Seed only the top-level agent — sub-delegation target is unknown.
    await seedTrust(trustStore, "known-agent", AgentTrustLevel.Trusted);

    const mgr = new AgentGraphManager(SELF, trustStore, null, null);

    const receipt = makeReceipt("known-agent", [makeReceipt("totally-unknown-agent")]);
    await mgr.addReceiptEdges(receipt);

    const snapshot = await mgr.getGraphSnapshot();
    const unknownEdge = snapshot.edges.find((e) => e.to === "totally-unknown-agent");
    expect(unknownEdge).toBeDefined();
    expect(unknownEdge!.weight.trust).toBeCloseTo(0.1, 5);
  });

  it("uses real latency stats from the latency store (not the 3000ms hardcoded fallback)", async () => {
    // addDelegationEdges adds edges from a delegator to its sub-delegations,
    // querying getLatency for each SUB. Test on sub-delegation edges.
    const latencyStore = {
      getStats: (_self: string, remote: string): Promise<{ avg_ms: number } | null> => {
        if (remote === "fast-sub") return Promise.resolve({ avg_ms: 250 });
        if (remote === "slow-sub") return Promise.resolve({ avg_ms: 8000 });
        return Promise.resolve(null);
      },
    };

    const mgr = new AgentGraphManager(SELF, trustStore, null, latencyStore);

    // Top-level "delegator" with two distinct sub-delegations
    const receipt = makeReceipt("delegator", [makeReceipt("fast-sub"), makeReceipt("slow-sub")]);
    await mgr.addReceiptEdges(receipt);

    const snapshot = await mgr.getGraphSnapshot();

    const fastEdge = snapshot.edges.find((e) => e.from === "delegator" && e.to === "fast-sub");
    const slowEdge = snapshot.edges.find((e) => e.from === "delegator" && e.to === "slow-sub");
    expect(fastEdge).toBeDefined();
    expect(slowEdge).toBeDefined();

    // Real latency stats flow through to the edge weight, not the 3000ms
    // placeholder that the old hardcoded getLatency would have produced.
    expect(fastEdge!.weight.latency).toBe(250);
    expect(slowEdge!.weight.latency).toBe(8000);
  });

  it("falls back to 3000ms when the latency store has no data for an agent", async () => {
    const latencyStore = {
      getStats: (_self: string, remote: string): Promise<{ avg_ms: number } | null> => {
        if (remote === "with-stats") return Promise.resolve({ avg_ms: 500 });
        return Promise.resolve(null);
      },
    };

    const mgr = new AgentGraphManager(SELF, trustStore, null, latencyStore);

    const receipt = makeReceipt("delegator", [
      makeReceipt("with-stats"),
      makeReceipt("without-stats"),
    ]);
    await mgr.addReceiptEdges(receipt);

    const snapshot = await mgr.getGraphSnapshot();
    const withStats = snapshot.edges.find((e) => e.from === "delegator" && e.to === "with-stats");
    const withoutStats = snapshot.edges.find(
      (e) => e.from === "delegator" && e.to === "without-stats",
    );
    expect(withStats!.weight.latency).toBe(500);
    expect(withoutStats!.weight.latency).toBe(3000);
  });

  it("walks the entire receipt tree to pre-fetch trust + latency in one pass", async () => {
    // 3-deep delegation chain: top → mid → leaf
    await seedTrust(trustStore, "top", AgentTrustLevel.Trusted);
    await seedTrust(trustStore, "mid", AgentTrustLevel.Verified);
    await seedTrust(trustStore, "leaf", AgentTrustLevel.FirstContact);

    let getStatsCalls = 0;
    const latencyStore = {
      getStats: (_self: string, _remote: string): Promise<{ avg_ms: number } | null> => {
        getStatsCalls++;
        return Promise.resolve({ avg_ms: 1000 });
      },
    };

    const mgr = new AgentGraphManager(SELF, trustStore, null, latencyStore);

    const receipt = makeReceipt("top", [makeReceipt("mid", [makeReceipt("leaf")])]);
    await mgr.addReceiptEdges(receipt);

    // All three motebits should have been fetched exactly once
    expect(getStatsCalls).toBe(3);

    const snapshot = await mgr.getGraphSnapshot();
    const topEdge = snapshot.edges.find((e) => e.to === "top");
    const midEdge = snapshot.edges.find((e) => e.to === "mid");
    const leafEdge = snapshot.edges.find((e) => e.to === "leaf");
    expect(topEdge!.weight.trust).toBeCloseTo(trustLevelToScore(AgentTrustLevel.Trusted), 5);
    expect(midEdge!.weight.trust).toBeCloseTo(trustLevelToScore(AgentTrustLevel.Verified), 5);
    expect(leafEdge!.weight.trust).toBeCloseTo(trustLevelToScore(AgentTrustLevel.FirstContact), 5);
  });

  it("handles a null trust store and null latency store gracefully", async () => {
    const mgr = new AgentGraphManager(SELF, null, null, null);
    const receipt = makeReceipt("anyone", [makeReceipt("anyone-else")]);
    await mgr.addReceiptEdges(receipt);
    const snapshot = await mgr.getGraphSnapshot();
    // Both edges fall back to defaults but exist
    expect(snapshot.edges.length).toBeGreaterThan(0);
  });
});
