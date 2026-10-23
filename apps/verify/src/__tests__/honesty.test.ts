import { describe, it, expect } from "vitest";
import { honesty } from "../honesty.js";

describe("honesty", () => {
  it("states the three proves and the limits — a key commitment adds the authorization limit", () => {
    const h = honesty({ integrity: true, binding: "key-commitment" });
    expect(h.proves).toHaveLength(3);
    expect(h.proves.join(" ")).toContain("held the private key");
    expect(h.proves.join(" ")).toContain("unaltered");
    expect(h.proves[2]).toContain("minted a second ago");
    expect(h.proves[2]).toContain("original key");
    expect(h.proves.join(" ")).not.toMatch(/sovereign/i);
    const not = h.doesNotProve.join(" ");
    expect(not).toContain("correct or true");
    expect(not).toContain("operates the agent");
    expect(not).toContain("Reputation or trustworthiness");
    expect(not).toContain("rotation and revocation were not established");
    expect(not).toContain("revocation was not established");
  });

  it("the key-compromise line follows whether revocation was established", () => {
    const h = honesty({ integrity: true, binding: "pinned", revocation: "not_revoked" });
    expect(h.doesNotProve.join(" ")).toContain(
      "no revocation memo naming it, at any date, is at the anchor address the relay declares",
    );
    // N2: the scope is one address, never the whole chain.
    expect(h.doesNotProve.join(" ")).not.toContain("found on-chain");
    expect(h.doesNotProve.join(" ")).toContain("served the whole chain");
    expect(h.proves[2]).toContain("pinned");
    const n = honesty({ integrity: true, binding: "pinned", revocation: "not_established" });
    expect(n.doesNotProve.join(" ")).toContain("revocation was not established");
  });

  it("a key commitment whose served chain did not bind says so, not 'not established'", () => {
    const h = honesty({ integrity: true, binding: "key-commitment", chainCheck: "not_active" });
    const not = h.doesNotProve.join(" ");
    expect(not).toContain(
      "the identity chain the relay served does not bind the key even at that claimed time",
    );
    expect(not).not.toContain("rotation and revocation were not established");
  });

  it("a reported revocation is not proof of revocation", () => {
    const h = honesty({ integrity: true, binding: "revoked", revocation: "revoked" });
    expect(h.doesNotProve.join(" ")).toContain("the revocation memo is unauthenticated");
  });

  it("integrity-only says the id is only a claim; invalid proves nothing", () => {
    expect(honesty({ integrity: true, binding: "integrity-only" }).proves[2]).toContain(
      "only a claim",
    );
    expect(honesty({ integrity: false, binding: "unverified" }).proves[0]).toContain("Nothing");
  });
});
