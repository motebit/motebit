import { describe, it, expect } from "vitest";
import { aggregateCredentialReputation, blendCredentialTrust } from "../credential-weight.js";
import type { CredentialReputation, ReputationVC } from "../credential-weight.js";

// ── Helpers ─────────────────────────────────────────────────────────

function makeRepVC(
  issuer: string,
  overrides?: Partial<ReputationVC["credentialSubject"]> & { validFrom?: string },
): ReputationVC {
  const now = new Date();
  return {
    type: ["VerifiableCredential", "AgentReputationCredential"],
    issuer,
    credentialSubject: {
      id: "did:motebit:subject-1",
      success_rate: 0.95,
      avg_latency_ms: 1200,
      task_count: 20,
      trust_score: 0.8,
      availability: 1.0,
      sample_size: 20,
      measured_at: now.getTime(),
      ...overrides,
    },
    validFrom: overrides?.validFrom ?? now.toISOString(),
  };
}

const highTrust = () => 0.9;
const lowTrust = () => 0.02;

// ── aggregateCredentialReputation ───────────────────────────────────

describe("aggregateCredentialReputation", () => {
  it("returns null for empty credentials array", () => {
    const result = aggregateCredentialReputation([], highTrust);
    expect(result).toBeNull();
  });

  it("returns null when all issuers below minimum trust", () => {
    const vc = makeRepVC("did:key:untrusted");
    const result = aggregateCredentialReputation([vc], lowTrust);
    expect(result).toBeNull();
  });

  it("aggregates a single credential from a trusted issuer", () => {
    const vc = makeRepVC("did:key:trusted-1");
    const result = aggregateCredentialReputation([vc], highTrust);

    expect(result).not.toBeNull();
    expect(result!.success_rate).toBeCloseTo(0.95);
    expect(result!.avg_latency_ms).toBeCloseTo(1200);
    expect(result!.issuer_count).toBe(1);
    expect(result!.total_weight).toBeGreaterThan(0);
  });

  it("weights higher-trust issuers more heavily", () => {
    const vcHigh = makeRepVC("did:key:high-trust", { success_rate: 1.0 });
    const vcLow = makeRepVC("did:key:low-trust", { success_rate: 0.5 });

    const getIssuerTrust = (did: string) => (did === "did:key:high-trust" ? 0.9 : 0.1);

    const result = aggregateCredentialReputation([vcHigh, vcLow], getIssuerTrust);

    expect(result).not.toBeNull();
    // Weighted toward high-trust issuer's 1.0, not the average 0.75
    expect(result!.success_rate).toBeGreaterThan(0.85);
  });

  it("applies freshness decay to old credentials", () => {
    const now = new Date();
    const fresh = makeRepVC("did:key:issuer", { success_rate: 0.9 });
    const stale = makeRepVC("did:key:issuer", {
      success_rate: 0.5,
      validFrom: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days ago
    });

    const result = aggregateCredentialReputation([fresh, stale], highTrust, {
      freshnessHalfLifeMs: 24 * 60 * 60 * 1000, // 1 day
    });

    expect(result).not.toBeNull();
    // Fresh credential (0.9) dominates over 7-day-old stale (0.5)
    expect(result!.success_rate).toBeGreaterThan(0.8);
  });

  it("applies sample-size confidence scaling", () => {
    const manyTasks = makeRepVC("did:key:issuer-a", { task_count: 100, success_rate: 0.7 });
    const fewTasks = makeRepVC("did:key:issuer-b", { task_count: 2, success_rate: 1.0 });

    const result = aggregateCredentialReputation([manyTasks, fewTasks], highTrust);

    expect(result).not.toBeNull();
    // The 100-task credential should dominate over the 2-task one
    expect(result!.success_rate).toBeLessThan(0.8);
  });

  it("counts distinct issuers", () => {
    const vc1 = makeRepVC("did:key:alice");
    const vc2 = makeRepVC("did:key:bob");
    const vc3 = makeRepVC("did:key:alice"); // duplicate issuer

    const result = aggregateCredentialReputation([vc1, vc2, vc3], highTrust);

    expect(result).not.toBeNull();
    expect(result!.issuer_count).toBe(2); // alice + bob
  });

  it("skips non-reputation credentials", () => {
    const repVC = makeRepVC("did:key:issuer");
    const nonRepVC = {
      ...makeRepVC("did:key:issuer"),
      type: ["VerifiableCredential", "AgentTrustCredential"],
    };

    const result = aggregateCredentialReputation([repVC, nonRepVC as ReputationVC], highTrust);

    expect(result).not.toBeNull();
    expect(result!.issuer_count).toBe(1); // Only the reputation VC counted
  });

  it("skips individual issuers below minTrust while keeping others", () => {
    const trustedVC = makeRepVC("did:key:trusted", { success_rate: 0.9 });
    const untrustedVC = makeRepVC("did:key:untrusted", { success_rate: 0.1 });

    // Map: trusted issuer gets 0.9, untrusted gets 0.01 (below default min 0.05)
    const getIssuerTrust = (did: string) => (did === "did:key:trusted" ? 0.9 : 0.01);

    const result = aggregateCredentialReputation([trustedVC, untrustedVC], getIssuerTrust);

    expect(result).not.toBeNull();
    // Only the trusted issuer should contribute
    expect(result!.issuer_count).toBe(1);
    expect(result!.success_rate).toBeCloseTo(0.9);
  });

  it("skips all issuers below custom minTrust threshold", () => {
    const vc1 = makeRepVC("did:key:a", { success_rate: 0.9 });
    const vc2 = makeRepVC("did:key:b", { success_rate: 0.8 });

    // Both issuers return 0.3, but minTrust is 0.5
    const getIssuerTrust = () => 0.3;

    const result = aggregateCredentialReputation([vc1, vc2], getIssuerTrust, {
      minIssuerTrust: 0.5,
    });

    // All issuers below threshold → null
    expect(result).toBeNull();
  });

  it("continues past low-trust issuers and aggregates remaining", () => {
    const vc1 = makeRepVC("did:key:low-trust", { success_rate: 0.1 });
    const vc2 = makeRepVC("did:key:medium-trust", { success_rate: 0.7 });
    const vc3 = makeRepVC("did:key:high-trust", { success_rate: 0.95 });

    const getIssuerTrust = (did: string) => {
      if (did === "did:key:low-trust") return 0.01; // below min
      if (did === "did:key:medium-trust") return 0.4;
      return 0.9;
    };

    const result = aggregateCredentialReputation([vc1, vc2, vc3], getIssuerTrust);

    expect(result).not.toBeNull();
    // Low-trust issuer skipped, only medium and high contribute
    expect(result!.issuer_count).toBe(2);
    // Weighted toward high-trust issuer
    expect(result!.success_rate).toBeGreaterThan(0.7);
  });
});

// ── blendCredentialTrust ────────────────────────────────────────────

describe("blendCredentialTrust", () => {
  it("returns static trust when no credential reputation", () => {
    expect(blendCredentialTrust(0.6, null)).toBe(0.6);
  });

  it("returns static trust when credential weight is zero", () => {
    const credRep: CredentialReputation = {
      success_rate: 1.0,
      avg_latency_ms: 100,
      effective_task_count: 50,
      trust_score: 1.0,
      availability: 1.0,
      issuer_count: 3,
      total_weight: 0,
    };
    expect(blendCredentialTrust(0.6, credRep)).toBe(0.6);
  });

  it("blends toward credential evidence with strong evidence", () => {
    const credRep: CredentialReputation = {
      success_rate: 1.0,
      avg_latency_ms: 100,
      effective_task_count: 50,
      trust_score: 1.0,
      availability: 1.0,
      issuer_count: 5, // diverse
      total_weight: 3, // strong
    };

    // Static trust 0.3 (low), but credentials say 1.0 (excellent)
    const blended = blendCredentialTrust(0.3, credRep);
    expect(blended).toBeGreaterThan(0.3); // Pulled up by credentials
    expect(blended).toBeLessThan(1.0); // But not fully overridden
  });

  it("respects maxBlend parameter", () => {
    const credRep: CredentialReputation = {
      success_rate: 1.0,
      avg_latency_ms: 100,
      effective_task_count: 50,
      trust_score: 1.0,
      availability: 1.0,
      issuer_count: 5,
      total_weight: 3,
    };

    const lowBlend = blendCredentialTrust(0.3, credRep, 0.1);
    const highBlend = blendCredentialTrust(0.3, credRep, 0.9);
    expect(highBlend).toBeGreaterThan(lowBlend);
  });

  it("single-issuer low-weight credentials barely affect score", () => {
    const credRep: CredentialReputation = {
      success_rate: 1.0,
      avg_latency_ms: 100,
      effective_task_count: 50,
      trust_score: 1.0,
      availability: 1.0,
      issuer_count: 1, // single issuer
      total_weight: 0.5, // low weight
    };

    const blended = blendCredentialTrust(0.3, credRep);
    // With 1 issuer and low weight, blend factor should be very small
    expect(blended).toBeCloseTo(0.3, 1);
  });

  it("result is always in [0,1]", () => {
    const credRep: CredentialReputation = {
      success_rate: 1.0,
      avg_latency_ms: 0,
      effective_task_count: 100,
      trust_score: 1.0,
      availability: 1.0,
      issuer_count: 10,
      total_weight: 10,
    };

    const result = blendCredentialTrust(1.0, credRep, 1.0);
    expect(result).toBeLessThanOrEqual(1.0);
    expect(result).toBeGreaterThanOrEqual(0.0);

    const resultLow = blendCredentialTrust(0.0, credRep, 1.0);
    expect(resultLow).toBeLessThanOrEqual(1.0);
    expect(resultLow).toBeGreaterThanOrEqual(0.0);
  });
});

// ── Integration: blending affects routing graph ─────────────────────

describe("credential reputation in routing graph", () => {
  it("candidate with credential reputation gets adjusted trust in graph", async () => {
    const { buildRoutingGraph } = await import("../graph-routing.js");
    const { asMotebitId } = await import("@motebit/sdk");

    const selfId = asMotebitId("self");
    const agentId = asMotebitId("agent-1");

    // Without credential reputation
    const candidateBase = {
      motebit_id: agentId,
      trust_record: null, // Unknown trust → 0.1
      listing: null,
      latency_stats: null,
      is_online: true,
    };

    const graphWithout = buildRoutingGraph(selfId, [candidateBase]);
    const edgeWithout = graphWithout.getEdge(selfId, agentId);

    // With strong credential reputation
    const candidateWithCred = {
      ...candidateBase,
      credential_reputation: {
        success_rate: 0.95,
        avg_latency_ms: 500,
        effective_task_count: 40,
        trust_score: 0.9,
        availability: 1.0,
        issuer_count: 4,
        total_weight: 2.5,
      },
    };

    const graphWith = buildRoutingGraph(selfId, [candidateWithCred]);
    const edgeWith = graphWith.getEdge(selfId, agentId);

    // Both should have edges
    expect(edgeWithout).not.toBeNull();
    expect(edgeWith).not.toBeNull();

    // Credential reputation should increase the trust edge weight
    expect(edgeWith!.trust).toBeGreaterThan(edgeWithout!.trust);
  });
});
