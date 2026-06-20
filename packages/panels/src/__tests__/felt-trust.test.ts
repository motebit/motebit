/**
 * felt-trust — the trust resting record (felt-interior.md §6).
 *
 * Enforces the relational-axis honesty model behaviorally: proven-only
 * (Known edges, blocked excluded), present-shape-not-trend, no inward global
 * score, money counts-only.
 */
import { describe, it, expect } from "vitest";
import {
  resolveFeltTrust,
  type FeltTrustRecord,
  type AgentRecord,
  type AgentEconomicSummary,
  type AgentPeerEconomics,
} from "../index";

function edge(id: string, trust_level: string, extra: Partial<AgentRecord> = {}): AgentRecord {
  return {
    remote_motebit_id: id,
    trust_level,
    first_seen_at: 1_000,
    last_seen_at: 2_000,
    interaction_count: 1,
    ...extra,
  };
}

function peerEcon(peer_id: string, settled_count: number, net_micro = 0): AgentPeerEconomics {
  return {
    peer_id,
    earned_micro: 0,
    paid_micro: 0,
    net_micro,
    fee_micro: 0,
    settled_count,
    p2p_count: 0,
    first_at: 1_000,
    last_at: 2_000,
  };
}

function summary(peers: AgentPeerEconomics[]): AgentEconomicSummary {
  return {
    motebit_id: "self",
    peers,
    unattributed: { earned_micro: 0, fee_micro: 0, settled_count: 0 },
  };
}

describe("resolveFeltTrust", () => {
  it("an empty graph is forming, not failed — calm headline, all zero", () => {
    const r = resolveFeltTrust([]);
    expect(r.known).toBe(0);
    expect(r.trusted).toBe(0);
    expect(r.hardwareBacked).toBe(0);
    expect(r.settledWith).toBe(0);
    expect(r.shape).toEqual([]);
    expect(r.headline).toMatch(/still forming/i);
  });

  it("projects the present tier shape (the held graph, not a trend)", () => {
    const r = resolveFeltTrust([
      edge("a", "first_contact"),
      edge("b", "verified"),
      edge("c", "verified"),
      edge("d", "trusted"),
    ]);
    expect(r.known).toBe(4);
    // trusted (the earned depth) = verified + trusted tiers
    expect(r.trusted).toBe(3);
    expect(r.shape).toEqual([
      { kind: "first_contact", count: 1 },
      { kind: "verified", count: 2 },
      { kind: "trusted", count: 1 },
    ]);
    expect(r.headline).toMatch(/3 you've come to trust/);
  });

  it("a forming graph with no earned depth reads as first contact", () => {
    const r = resolveFeltTrust([edge("a", "first_contact"), edge("b", "unknown")]);
    expect(r.trusted).toBe(0);
    expect(r.headline).toMatch(/at first contact/i);
  });

  it("blocked is not trust held — excluded from the mass and every count", () => {
    const r = resolveFeltTrust([
      edge("a", "verified"),
      edge("blk", "blocked", { hardware_attestation: { platform: "secure_enclave", score: 1 } }),
    ]);
    expect(r.known).toBe(1);
    expect(r.trusted).toBe(1);
    // the blocked edge's hardware attestation must not count either
    expect(r.hardwareBacked).toBe(0);
    expect(r.shape).toEqual([{ kind: "verified", count: 1 }]);
  });

  it("`unknown` collapses into first_contact (an early edge you've met)", () => {
    const r = resolveFeltTrust([edge("a", "unknown"), edge("b", "first_contact")]);
    expect(r.shape).toEqual([{ kind: "first_contact", count: 2 }]);
  });

  it("hardware-rooted counts real attestation surfaces, never the software sentinel", () => {
    const r = resolveFeltTrust([
      edge("a", "verified", { hardware_attestation: { platform: "secure_enclave", score: 1 } }),
      edge("b", "verified", { hardware_attestation: { platform: "tpm", score: 1 } }),
      edge("c", "verified", { hardware_attestation: { platform: "software", score: 0.1 } }),
      edge("d", "verified"),
    ]);
    expect(r.hardwareBacked).toBe(2);
  });

  it("money is counts-only — settledWith counts held peers with settled work, never an amount", () => {
    const known = [edge("a", "verified"), edge("b", "trusted")];
    const econ = summary([peerEcon("a", 3, 2_500_000), peerEcon("b", 0, 0)]);
    const r = resolveFeltTrust(known, econ);
    expect(r.settledWith).toBe(1); // only `a` has settled_count > 0
    // No amount/net field leaks onto the felt record — counts only.
    expect(Object.keys(r)).not.toContain("net_micro");
    expect(Object.keys(r)).not.toContain("amount");
  });

  it("proven-only: an economic peer NOT in the held graph never counts toward settledWith", () => {
    const known = [edge("a", "verified")];
    // `ghost` settled but is not a Known/held edge (e.g. a stale or blocked id)
    const econ = summary([peerEcon("a", 1), peerEcon("ghost", 5)]);
    const r = resolveFeltTrust(known, econ);
    expect(r.settledWith).toBe(1);
  });

  it("settledWith excludes a blocked peer even if it has settled history", () => {
    const known = [edge("a", "verified"), edge("blk", "blocked")];
    const econ = summary([peerEcon("a", 2), peerEcon("blk", 9)]);
    const r = resolveFeltTrust(known, econ);
    expect(r.settledWith).toBe(1);
  });

  it("no economic summary → settledWith is zero, never fabricated", () => {
    const r = resolveFeltTrust([edge("a", "verified")]);
    expect(r.settledWith).toBe(0);
    const r2 = resolveFeltTrust([edge("a", "verified")], null);
    expect(r2.settledWith).toBe(0);
  });

  it("carries no inward global score — the record is shape + counts only", () => {
    const r: FeltTrustRecord = resolveFeltTrust([edge("a", "trusted")]);
    const keys = Object.keys(r);
    for (const forbidden of ["score", "reputation", "rank", "ranking", "aggregate", "global"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("singular vs plural peer wording in the headline", () => {
    expect(resolveFeltTrust([edge("a", "first_contact")]).headline).toMatch(/1 peer\b/);
    expect(
      resolveFeltTrust([edge("a", "first_contact"), edge("b", "first_contact")]).headline,
    ).toMatch(/2 peers\b/);
  });
});
