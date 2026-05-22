/**
 * @vitest-environment jsdom
 *
 * renderResult turns the verification view model into a graded verdict DOM. The
 * colors are CSS, but the CLASSES that drive them and the honesty-critical labels
 * are asserted here — especially that an integrity-only result is labelled "claims
 * to be" (a claim) while a bound result says "motebit" (proven), and that the
 * grade badge + ladder scale reflect the rung reached.
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
  it("integrity-only → cyan tone, INTEGRITY ONLY grade, motebit_id labelled a CLAIM", () => {
    const el = renderResult(view());
    expect(el.classList.contains("tone-integrity")).toBe(true);
    expect(el.querySelector(".grade-badge")?.textContent).toBe("INTEGRITY ONLY");
    expect(el.textContent).toContain("claims to be"); // NOT "motebit"
    // signature integrity check is ok; identity binding is "not established" (skip).
    expect(el.querySelector(".check-mark.ok")?.textContent).toBe("✓");
    expect(el.querySelector(".checks")?.textContent).toContain("not established");
    // ladder scale present, integrity step is current.
    expect(el.querySelector(".scale-step.current.integrity")).not.toBeNull();
  });

  it("pinned → green tone, PINNED grade, motebit proven, binding ok", () => {
    const el = renderResult(view({ binding: "pinned" }));
    expect(el.classList.contains("tone-bound")).toBe(true);
    expect(el.querySelector(".grade-badge")?.textContent).toBe("PINNED");
    const labels = Array.from(el.querySelectorAll(".meta-label")).map((n) => n.textContent);
    expect(labels).toContain("motebit");
    expect(labels).not.toContain("claims to be");
    expect(el.querySelector(".checks")?.textContent).toContain("pinned");
    expect(el.querySelector(".scale-step.current")?.textContent).toBe("pinned");
  });

  it("anchored → ANCHORED grade, on-chain tx shown, ladder current=anchored", () => {
    const el = renderResult(view({ binding: "anchored", anchorTxHash: "5xTxHashAbc" }));
    expect(el.querySelector(".grade-badge")?.textContent).toBe("ANCHORED");
    const labels = Array.from(el.querySelectorAll(".meta-label")).map((n) => n.textContent);
    expect(labels).toContain("anchored in tx");
    expect(el.textContent).toContain("5xTxHashAbc");
    expect(el.querySelector(".scale-step.current")?.textContent).toBe("anchored");
  });

  it("sovereign → SOVEREIGN grade, strongest rung current, no warn marks", () => {
    const el = renderResult(view({ binding: "sovereign" }));
    expect(el.classList.contains("tone-bound")).toBe(true);
    expect(el.querySelector(".grade-badge")?.textContent).toBe("SOVEREIGN");
    expect(el.querySelector(".scale-step.current")?.textContent).toBe("sovereign");
    expect(el.querySelector(".checks")?.textContent).toContain("commits to the genesis key");
    const labels = Array.from(el.querySelectorAll(".meta-label")).map((n) => n.textContent);
    expect(labels).toContain("motebit");
  });

  it("revoked → red tone, REVOKED grade, fail mark, NO ladder scale, claim not proven", () => {
    const el = renderResult(view({ binding: "revoked", revokedAt: 1500 }));
    expect(el.classList.contains("tone-failed")).toBe(true);
    expect(el.querySelector(".grade-badge")?.textContent).toBe("REVOKED");
    expect(el.querySelector(".check-mark.fail")).not.toBeNull();
    expect(el.querySelector(".ladder-scale")).toBeNull(); // off-ladder
    const labels = Array.from(el.querySelectorAll(".meta-label")).map((n) => n.textContent);
    expect(labels).toContain("claims to be");
    expect(labels).not.toContain("motebit");
    expect(el.textContent).toContain("revoked");
  });

  it("failed signature → INVALID grade, red, no identity meta, no ladder", () => {
    const el = renderResult({
      integrity: false,
      binding: "unverified",
      reason: "signature_invalid",
    });
    expect(el.classList.contains("tone-failed")).toBe(true);
    expect(el.querySelector(".grade-badge")?.textContent).toBe("INVALID");
    expect(el.querySelector(".result-meta")).toBeNull();
    expect(el.querySelector(".ladder-scale")).toBeNull();
    expect(el.querySelector(".check-mark.fail")?.textContent).toBe("✗");
    expect(el.textContent).toContain("altered");
  });

  it("renders a delegation chain recursively + a delegation-chain check row", () => {
    const el = renderResult(
      view({ delegations: [view({ taskId: "t-child", motebitId: "mote-child" })] }),
    );
    expect(el.querySelector(".result-chain")).not.toBeNull();
    expect(el.textContent).toContain("delegation chain (1)");
    expect(el.textContent).toContain("t-child");
    expect(el.querySelector(".checks")?.textContent).toContain("Delegation chain");
  });
});
