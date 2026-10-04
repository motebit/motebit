import { describe, it, expect } from "vitest";
import { honesty } from "../honesty.js";

describe("honesty", () => {
  it("states the three proves and the four limits", () => {
    const h = honesty({ integrity: true, binding: "sovereign" });
    expect(h.proves).toHaveLength(3);
    expect(h.proves.join(" ")).toContain("held the private key");
    expect(h.proves.join(" ")).toContain("unaltered");
    expect(h.proves[2]).toContain("minted a second ago");
    const not = h.doesNotProve.join(" ");
    expect(not).toContain("correct or true");
    expect(not).toContain("operates the agent");
    expect(not).toContain("Reputation or trustworthiness");
    expect(not).toContain("revocation was not checked");
  });

  it("the key-compromise line follows whether revocation was checked", () => {
    const h = honesty({ integrity: true, binding: "pinned", revocation: "not_revoked" });
    expect(h.doesNotProve.join(" ")).toContain("no revocation was published on-chain");
    expect(h.proves[2]).toContain("pinned");
  });

  it("integrity-only says the id is only a claim; invalid proves nothing", () => {
    expect(honesty({ integrity: true, binding: "integrity-only" }).proves[2]).toContain(
      "only a claim",
    );
    expect(honesty({ integrity: false, binding: "unverified" }).proves[0]).toContain("Nothing");
  });
});
