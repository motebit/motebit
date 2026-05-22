import { describe, it, expect } from "vitest";
import type { ReceiptDocumentVerification } from "@motebit/state-export-client";
import { resultLabels } from "../labels.js";

const ok = (over: Partial<ReceiptDocumentVerification> = {}): ReceiptDocumentVerification => ({
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

  it("pinned claims identity (against supplied material), tone bound", () => {
    const l = resultLabels(ok({ binding: "pinned" }));
    expect(l.tone).toBe("bound");
    expect(l.headline).toContain("pinned");
  });

  it("sovereign is the strongest rung — offline, no operator, tone bound", () => {
    const l = resultLabels(ok({ binding: "sovereign" }));
    expect(l.tone).toBe("bound");
    expect(l.headline.toLowerCase()).toContain("sovereign");
    expect(l.detail.toLowerCase()).toContain("no operator to trust");
  });

  it("anchored claims the strongest binding — on-chain, non-equivocable, tone bound", () => {
    const l = resultLabels(ok({ binding: "anchored" }));
    expect(l.tone).toBe("bound");
    expect(l.headline).toContain("anchored on-chain");
    expect(l.detail).toContain("on-chain");
    // Non-equivocation, stated in plain language (not the jargon "equivocate").
    expect(l.detail).toContain("two verifiers different chains");
  });

  it("revoked is the loudest verdict — failed tone, do-not-trust, even with valid integrity", () => {
    const l = resultLabels(ok({ binding: "revoked", revokedAt: 1500 }));
    expect(l.tone).toBe("failed");
    expect(l.headline.toLowerCase()).toContain("revoked");
    expect(l.headline.toLowerCase()).toContain("do not trust");
    expect(l.detail.toLowerCase()).toContain("revoked");
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
