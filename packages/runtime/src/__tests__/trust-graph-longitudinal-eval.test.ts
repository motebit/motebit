/**
 * Trust-graph longitudinal eval — thesis #2 ("more capable over time") on the TRUST
 * pillar, a different accumulated-trust surface than the three memory-graph evals
 * (see [[memory_compounding_eval]]). The memory evals measured whether retrieval compounds;
 * this measures whether BILATERAL TRUST compounds — does a pair that transacts successfully
 * climb the trust ladder over a stream of verified receipts, and does that accumulation
 * stay first-person (pairwise-earned, non-transitive) the way the sybil-resistance doctrine
 * (docs/doctrine/agents-as-first-person-trust-graph.md) requires?
 *
 * Drives the REAL pipeline: `bumpTrustFromReceipt` → the real InMemoryAgentTrustStore → the
 * real `evaluateTrustTransition` algebra (@motebit/semiring) → real event emission. signingKeys
 * is null so the best-effort credential-issuance paths are skipped — this isolates the trust
 * STATE machine (the accumulation), not credential crypto.
 *
 * Thresholds under test (REFERENCE_TRUST_THRESHOLDS): FirstContact on first verified receipt;
 * Verified at 5 successes / ≥0.8 rate; Trusted at 20 successes / ≥0.9 rate; demote at ≥3 tasks
 * / <0.5 rate (checked fail-fast, one level at a time).
 *
 * CLAIM-vs-CODE NOTE (surfaced by writing this eval): `bumpTrustFromReceipt`'s JSDoc said
 * "never auto-promotes to Trusted — requires explicit owner action." The algebra it calls
 * DOES auto-promote Verified → Trusted at 20/0.9 — and that is the DELIBERATE, separately
 * tested behavior (semiring trust-algebra.test.ts "Verified → Trusted at 20 successes") and
 * the doctrine ("the ladder … is promoted by my success rate with that peer"). So the JSDoc
 * was stale; this eval asserts the REAL ladder and the stale comment was corrected in the
 * same change. Explicit owner action (setAgentTrustLevel) is an ADDITIONAL path to Trusted,
 * not the only one.
 */
import { describe, it, expect } from "vitest";
import { bumpTrustFromReceipt, type AgentTrustDeps } from "../agent-trust";
import { AgentGraphManager } from "../agent-graph";
import { InMemoryAgentTrustStore } from "../in-memory-agent-trust-store";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { AgentTrustLevel } from "@motebit/sdk";
import type { ExecutionReceipt, MotebitId } from "@motebit/sdk";

const SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/** A high-quality completed receipt (length 1.0, tools 1.0 ⇒ resultQuality ≈ 0.94 ⇒ success). */
function goodReceipt(remoteId: string): ExecutionReceipt {
  const now = Date.now();
  return {
    task_id: "task",
    motebit_id: remoteId,
    device_id: "dev",
    submitted_at: now - 2000,
    completed_at: now,
    status: "completed",
    result: "x".repeat(600),
    tools_used: ["web_search", "read_url", "fetch"],
    memories_formed: 0,
    prompt_hash: "h",
    result_hash: "r",
    suite: SUITE,
    signature: "sig",
  } as ExecutionReceipt;
}

/** An explicit failure receipt. */
function failReceipt(remoteId: string): ExecutionReceipt {
  return { ...goodReceipt(remoteId), status: "failed", result: "" } as ExecutionReceipt;
}

/** A "completed" receipt with empty result + no tools — the QUALITY GATE reclassifies it as a
 *  failure (resultQuality < 0.2): "merely valid work" is not "good work". */
function emptyCompletedReceipt(remoteId: string): ExecutionReceipt {
  return {
    ...goodReceipt(remoteId),
    status: "completed",
    result: "",
    tools_used: [],
  } as ExecutionReceipt;
}

function makeDeps(
  motebitId: string,
  store: InMemoryAgentTrustStore,
  events: EventStore,
): AgentTrustDeps {
  return {
    motebitId,
    agentTrustStore: store,
    events,
    agentGraph: new AgentGraphManager(motebitId as MotebitId, store, null, null, null),
    signingKeys: null, // skip credential issuance — isolate the trust state machine
  };
}

const freshEvents = () => new EventStore(new InMemoryEventStore());

describe("trust-graph longitudinal eval", () => {
  it("PART 1 — the ladder climbs with accumulated verified outcomes (trust compounds)", async () => {
    const store = new InMemoryAgentTrustStore();
    const A = makeDeps("mote-A", store, freshEvents());

    const trajectory: AgentTrustLevel[] = [];
    for (let i = 1; i <= 20; i++) {
      await bumpTrustFromReceipt(A, goodReceipt("mote-B"), true);
      trajectory.push((await store.getAgentTrust("mote-A", "mote-B"))!.trust_level);
    }

    // eslint-disable-next-line no-console
    console.log(
      "[trust-longitudinal] A→B ladder over 20 verified receipts:",
      JSON.stringify(trajectory),
    );

    expect(trajectory[0]).toBe(AgentTrustLevel.FirstContact); // first contact
    expect(trajectory[3]).toBe(AgentTrustLevel.FirstContact); // 4 successes — below the bar
    expect(trajectory[4]).toBe(AgentTrustLevel.Verified); // 5 successes, rate 1.0 ⇒ Verified
    expect(trajectory[18]).toBe(AgentTrustLevel.Verified); // 19 successes — below the bar
    expect(trajectory[19]).toBe(AgentTrustLevel.Trusted); // 20 successes, rate 1.0 ⇒ Trusted

    const final = (await store.getAgentTrust("mote-A", "mote-B"))!;
    expect(final.interaction_count).toBe(20);
    expect(final.successful_tasks).toBe(20);
    expect(final.failed_tasks).toBe(0);
    expect(final.avg_quality ?? 0).toBeGreaterThan(0.8);
  });

  it("PART 2 — first-person & NON-TRANSITIVE: earned trust does not become a global score", async () => {
    const store = new InMemoryAgentTrustStore();
    const A = makeDeps("mote-A", store, freshEvents());
    for (let i = 0; i < 20; i++) await bumpTrustFromReceipt(A, goodReceipt("mote-B"), true);

    // A earned Trusted in B…
    expect((await store.getAgentTrust("mote-A", "mote-B"))!.trust_level).toBe(
      AgentTrustLevel.Trusted,
    );
    // …but that is A's FIRST-PERSON view of B. It does NOT travel:
    //  - a different observer C has not inherited it (no global "B is trusted")…
    expect(await store.getAgentTrust("mote-C", "mote-B")).toBeNull();
    //  - …and it is not symmetric — B has not earned trust in A from A's receipts.
    expect(await store.getAgentTrust("mote-B", "mote-A")).toBeNull();

    // C must EARN its own edge to B independently — and doing so leaves A's edge untouched.
    const C = makeDeps("mote-C", store, freshEvents());
    for (let i = 0; i < 5; i++) await bumpTrustFromReceipt(C, goodReceipt("mote-B"), true);
    expect((await store.getAgentTrust("mote-C", "mote-B"))!.trust_level).toBe(
      AgentTrustLevel.Verified,
    );

    const aStill = (await store.getAgentTrust("mote-A", "mote-B"))!;
    expect(aStill.trust_level).toBe(AgentTrustLevel.Trusted); // unaffected by C's activity
    expect(aStill.interaction_count).toBe(20); // pairwise — each edge counts only its own receipts
  });

  it("PART 3 — earned AND losable: the quality gate counts empty work as failure; sustained failure demotes", async () => {
    const store = new InMemoryAgentTrustStore();
    const A = makeDeps("mote-A", store, freshEvents());
    for (let i = 0; i < 5; i++) await bumpTrustFromReceipt(A, goodReceipt("mote-D"), true);
    expect((await store.getAgentTrust("mote-A", "mote-D"))!.trust_level).toBe(
      AgentTrustLevel.Verified,
    );

    // Quality gate: a "completed" receipt with empty result + no tools is reclassified as a
    // failure (resultQuality < 0.2) — "merely valid" ≠ "good work".
    await bumpTrustFromReceipt(A, emptyCompletedReceipt("mote-D"), true);
    const afterEmpty = (await store.getAgentTrust("mote-A", "mote-D"))!;
    expect(afterEmpty.failed_tasks).toBe(1);
    expect(afterEmpty.successful_tasks).toBe(5); // the empty one did NOT count as success
    expect(afterEmpty.trust_level).toBe(AgentTrustLevel.Verified); // rate 5/6 still ≥0.5

    // Sustained failure drags the rate below 0.5 (5 succ / 11 total = 0.45) → demote one level.
    for (let i = 0; i < 5; i++) await bumpTrustFromReceipt(A, failReceipt("mote-D"), true);
    const demoted = (await store.getAgentTrust("mote-A", "mote-D"))!;
    expect(demoted.failed_tasks).toBe(6);
    expect(demoted.trust_level).toBe(AgentTrustLevel.FirstContact); // Verified → FirstContact

    // …and an UNVERIFIED receipt never moves trust at all (verified-evidence-only).
    const before = (await store.getAgentTrust("mote-A", "mote-D"))!.interaction_count;
    await bumpTrustFromReceipt(A, goodReceipt("mote-D"), false);
    expect((await store.getAgentTrust("mote-A", "mote-D"))!.interaction_count).toBe(before);
  });
});
