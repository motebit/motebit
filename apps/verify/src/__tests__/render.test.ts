/**
 * @vitest-environment jsdom
 *
 * renderResult turns the verification view model into DOM. The colors are CSS,
 * but the CLASSES that drive them and the honesty-critical labels are asserted
 * here — especially that an integrity-only result is labelled "claims to be"
 * (a claim) while only a bound result says "motebit" (proven identity).
 */
import { describe, it, expect } from "vitest";
import type { ReceiptDocumentVerification } from "@motebit/state-export-client";
import { renderResult } from "../render.js";

const view = (over: Partial<ReceiptDocumentVerification> = {}): ReceiptDocumentVerification => ({
  integrity: true,
  binding: "integrity-only",
  signerDid: "did:key:zABC",
  motebitId: "mote-x",
  taskId: "t-1",
  ...over,
});

describe("renderResult", () => {
  it("integrity-only → cyan tone, honest headline, motebit_id labelled as a CLAIM", () => {
    const el = renderResult(view());
    expect(el.classList.contains("tone-integrity")).toBe(true);
    expect(el.textContent).toContain("identity not anchored");
    expect(el.textContent).toContain("claims to be"); // NOT "motebit"
    expect(el.textContent).toContain("mote-x");
    expect(el.textContent).toContain("did:key:zABC");
  });

  it("bound → green tone, motebit_id labelled as proven identity", () => {
    const el = renderResult(view({ binding: "bound" }));
    expect(el.classList.contains("tone-bound")).toBe(true);
    expect(el.textContent).toContain("identity anchored");
    const labels = Array.from(el.querySelectorAll(".meta-label")).map((n) => n.textContent);
    expect(labels).toContain("motebit");
    expect(labels).not.toContain("claims to be");
  });

  it("failed → red tone, no identity meta shown", () => {
    const el = renderResult({
      integrity: false,
      binding: "unverified",
      reason: "signature_invalid",
    });
    expect(el.classList.contains("tone-failed")).toBe(true);
    expect(el.querySelector(".result-meta")).toBeNull();
    expect(el.textContent).toContain("altered or forged");
  });

  it("renders a delegation chain recursively", () => {
    const el = renderResult(
      view({ delegations: [view({ taskId: "t-child", motebitId: "mote-child" })] }),
    );
    expect(el.querySelector(".result-chain")).not.toBeNull();
    expect(el.textContent).toContain("delegation chain (1)");
    expect(el.textContent).toContain("t-child");
  });
});
