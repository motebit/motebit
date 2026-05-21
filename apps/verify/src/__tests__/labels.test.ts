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
