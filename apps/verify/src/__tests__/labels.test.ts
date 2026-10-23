import { describe, it, expect } from "vitest";
import { resultLabels } from "../labels.js";
import { PROXY_LABEL, type DisplayVerdict } from "../assess.js";

const ok = (over: Partial<DisplayVerdict> = {}): DisplayVerdict => ({
  integrity: true,
  binding: "integrity-only",
  ...over,
});

describe("resultLabels", () => {
  it("integrity-only NEVER claims verified identity", () => {
    const l = resultLabels(ok({ binding: "integrity-only" }));
    expect(l.tone).toBe("integrity");
    expect(l.headline).toContain("identity not anchored");
    expect(l.detail).toContain("not that the key belongs to this motebit");
    // The whole product requirement: do not say "verified" in the identity sense.
    expect(l.headline.toLowerCase()).not.toContain("identity anchored");
  });

  it("pinned claims identity against the chain the relay served, tone bound — never 'non-equivocable' or 'supplied by you'", () => {
    const l = resultLabels(ok({ binding: "pinned", chainRoot: "relay-record" }));
    expect(l.tone).toBe("bound");
    expect(l.headline).toContain("pinned");
    expect(l.detail).not.toContain(PROXY_LABEL);
    expect(l.detail).toContain("the succession chain the relay served");
    expect(l.detail).toContain("commits to no key");
    expect(l.detail).toContain("a later rotation the relay did not serve would not show here");
    expect(l.detail).not.toMatch(/non-equivocable|supplied by you/);
    const sov = resultLabels(ok({ binding: "pinned", chainRoot: "id-commitment" }));
    expect(sov.detail).toContain("whose genesis key is the one this motebit_id commits to");
    expect(sov.detail).not.toMatch(/sovereign/i);
  });

  it("pinned because the anchor was read only via the proxy says so", () => {
    const l = resultLabels(ok({ binding: "pinned", anchorViaProxy: true }));
    expect(l.grade).toBe("PINNED");
    expect(l.detail).toContain(PROXY_LABEL);
    expect(l.detail).toContain("anchored rung is not claimed");
  });

  it("a key commitment is lower assurance: integrity tone, never SOVEREIGN, never current authorization", () => {
    const l = resultLabels(ok({ binding: "key-commitment" }));
    expect(l.tone).toBe("integrity");
    expect(l.grade).toBe("KEY COMMITMENT");
    expect(`${l.grade} ${l.headline} ${l.detail}`).not.toMatch(/sovereign/i);
    expect(l.headline).toContain("current authorization not established");
    expect(l.detail).toContain("identity commitment matches the motebit's original key");
    expect(l.detail).toContain("no succession check ran");
    expect(l.detail).toContain("minted a second ago");
    expect(l.detail).toContain("not trust");
    // When a succession check DID run against a served chain, the copy says so.
    const ran = resultLabels(ok({ binding: "key-commitment", chainCheck: "not_active" }));
    expect(ran.detail).toContain("A succession check ran");
    expect(ran.detail).toContain("not active at the time this receipt claims");
    expect(ran.detail).not.toContain("no succession check ran");
  });

  it("integrity-only with a served chain names why the chain did not bind", () => {
    const l = resultLabels(ok({ chainCheck: "recovery_unverifiable" }));
    expect(l.detail).toContain("guardian-recovery link");
    expect(l.detail).not.toContain("No trust anchor was provided");
  });

  it("anchored names the independent RPC and does not say 'confirmed on-chain'", () => {
    const l = resultLabels(ok({ binding: "anchored" }));
    expect(l.tone).toBe("bound");
    expect(l.grade).toBe("ANCHORED");
    expect(l.detail).toContain("RPC the operator does not run");
    expect(l.detail).not.toMatch(/confirmed on-chain/i);
  });

  it("a revocation memo is the loudest verdict, failed tone — but REPORTED (unauthenticated), never 'Key revoked'", () => {
    const l = resultLabels(ok({ binding: "revoked", revokedAt: 1500, chainSource: "independent" }));
    expect(l.tone).toBe("failed");
    expect(l.grade).toBe("REVOCATION REPORTED");
    expect(l.headline).toContain("REVOCATION REPORTED (unauthenticated)");
    expect(l.headline).toContain("do not rely");
    expect(l.headline).not.toMatch(/Key revoked/);
    expect(l.detail).toContain("unauthenticated");
    expect(l.detail).toContain("does not prove the key was revoked");
    expect(l.detail).toContain("through an RPC the operator does not run");
    expect(l.detail).not.toContain(PROXY_LABEL);
    const viaProxy = resultLabels(
      ok({ binding: "revoked", revokedAt: 1500, chainSource: "operator-proxy" }),
    );
    expect(viaProxy.grade).toBe("REVOCATION REPORTED");
    expect(viaProxy.detail).toContain(PROXY_LABEL);
  });

  it("failed signature reads as altered/forged, not a vague error", () => {
    const l = resultLabels({
      integrity: false,
      binding: "unverified",
      reason: "signature_invalid",
    });
    expect(l.tone).toBe("failed");
    expect(l.detail).toContain("altered or forged");
  });

  it("malformed input gets an actionable JSON message", () => {
    const l = resultLabels({ integrity: false, binding: "unverified", reason: "malformed_json" });
    expect(l.tone).toBe("failed");
    expect(l.detail).toContain("valid JSON");
  });

  it("missing reason falls back to a generic failure", () => {
    const l = resultLabels({ integrity: false, binding: "unverified" });
    expect(l.tone).toBe("failed");
    expect(l.detail).toBe("Verification failed.");
  });
});

describe("canonical form (round 4)", () => {
  it("integrity-only names each field not in canonical form; the suite reads 'not recognized'", () => {
    const key = resultLabels(ok({ noncanonical: ["public_key"] }));
    expect(key.grade).toBe("INTEGRITY ONLY");
    expect(key.detail).toContain("signing key (public_key) is not in canonical form");
    const suite = resultLabels(ok({ noncanonical: ["suite", "signature"] }));
    expect(suite.detail).toContain("Suite not recognized");
    expect(suite.detail).toContain("signature is not in canonical form");
  });

  it("an unverifiable re-spelled key or signature is never called forged", () => {
    for (const f of ["public_key", "signature"] as const) {
      const l = resultLabels({
        integrity: false,
        binding: "unverified",
        reason: "signature_invalid",
        noncanonical: [f],
      });
      expect(l.grade).toBe("INVALID");
      expect(l.detail).toContain("not in canonical form");
      expect(l.detail).not.toMatch(/forg/i);
    }
  });

  it("a memo date outside the displayable range is reported undated, never thrown on", () => {
    for (const at of [1e17, 8.64e15 + 1, Infinity]) {
      const l = resultLabels(ok({ binding: "revoked", revocation: "revoked", revokedAt: at }));
      expect(l.grade).toBe("REVOCATION REPORTED");
      expect(l.detail).not.toMatch(/dated \S+ by its poster/);
      expect(l.detail).toContain("a memo naming this signing key as revoked was found");
    }
  });
});
