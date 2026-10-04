/**
 * @vitest-environment jsdom
 *
 * renderResult: CLAIM first, then PROOF (verdict + one row per rung), then the
 * honesty block. Asserts the classes and honesty-critical labels — an
 * integrity-only result labels the motebit_id a CLAIM ("claims to be"), a bound
 * one says "motebit", and pasted content is escaped (textContent), never HTML.
 */
import { describe, it, expect } from "vitest";
import type { ReceiptDocumentVerification } from "@motebit/state-export-client";
import { renderResult } from "../render.js";
import type { RelayContext } from "../ladder.js";

const view = (over: Partial<ReceiptDocumentVerification> = {}): ReceiptDocumentVerification => ({
  integrity: true,
  binding: "integrity-only",
  signerDid: "did:key:zABC",
  motebitId: "mote-x",
  taskId: "t-1",
  ...over,
});
const OFFLINE: RelayContext = { kind: "offline", reason: "offline — test" };
const receipt = {
  task_id: "t-1",
  motebit_id: "mote-x",
  status: "completed",
  result: "<img src=x onerror=alert(1)>",
  submitted_at: 1790000000000,
  completed_at: 1790000002000,
  tools_used: ["read_url"],
  memories_formed: 2,
};

describe("renderResult", () => {
  it("shows Claim FIRST, then Proof, then the honesty block", () => {
    const el = renderResult(view(), { receipt, ctx: OFFLINE });
    const titles = Array.from(el.querySelectorAll("h2")).map((h) => h.textContent);
    expect(titles).toEqual(["Claim", "Proof"]);
    const sections = Array.from(el.children).map((c) => c.className);
    expect(sections).toEqual(["claim", "proof", "honesty"]);
  });

  it("renders the claim in plain words, escaped", () => {
    const el = renderResult(view(), { receipt, ctx: OFFLINE });
    const claim = el.querySelector(".claim")!;
    expect(claim.textContent).toContain("completed");
    expect(claim.textContent).toContain("read_url");
    expect(claim.textContent).toContain("2026-09-21T"); // ISO alongside local time
    expect(claim.querySelector("img")).toBeNull(); // escaped, not parsed
    expect(claim.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("integrity-only → INTEGRITY ONLY grade, motebit_id labelled a CLAIM, binding rung —", () => {
    const el = renderResult(view(), { receipt, ctx: OFFLINE });
    expect(el.classList.contains("tone-integrity")).toBe(true);
    expect(el.querySelector(".grade-badge")?.textContent).toBe("INTEGRITY ONLY");
    expect(el.textContent).toContain("claims to be");
    expect(el.querySelector('[data-rung="integrity"] .check-mark.ok')).not.toBeNull();
    expect(el.querySelector('[data-rung="binding"] .check-mark.skip')).not.toBeNull();
    expect(el.querySelector('[data-rung="revocation"]')?.textContent).toContain(
      "not checked: offline — test",
    );
  });

  it("sovereign → bound tone, motebit proven, sovereign rung ✓", () => {
    const el = renderResult(view({ binding: "sovereign" }), { receipt, ctx: OFFLINE });
    expect(el.classList.contains("tone-bound")).toBe(true);
    const labels = Array.from(el.querySelectorAll(".field-label")).map((n) => n.textContent);
    expect(labels).toContain("motebit");
    expect(labels).not.toContain("claims to be");
    expect(el.querySelector('[data-rung="binding"]')?.textContent).toContain("sovereign");
    expect(el.querySelector('[data-rung="binding"] .check-mark.ok')).not.toBeNull();
  });

  it("revoked → failed tone, REVOKED grade + chip, revocation rung ✗", () => {
    const el = renderResult(view({ binding: "revoked", revokedAt: 1500, revocation: "revoked" }), {
      receipt,
      ctx: { kind: "resolved" },
    });
    expect(el.querySelector(".grade-badge")?.textContent).toBe("REVOKED");
    expect(el.querySelector(".claim .chip")?.textContent).toBe("REVOKED");
    expect(el.querySelector('[data-rung="revocation"] .check-mark.fail')).not.toBeNull();
  });

  it("invalid → INVALID chip, unsigned note, honesty says nothing is proven", () => {
    const el = renderResult(
      view({ integrity: false, binding: "unverified", reason: "signature_invalid" }),
      { receipt, ctx: OFFLINE },
    );
    expect(el.querySelector(".claim .chip")?.textContent).toBe("INVALID");
    expect(el.querySelector(".unsigned-note")).not.toBeNull();
    expect(el.querySelector('[data-rung="integrity"] .check-mark.fail')).not.toBeNull();
    expect(el.querySelector(".honesty .proves")?.textContent).toContain("Nothing");
  });

  it("delegations render as an expandable tree, each with its own verdict and ladder", () => {
    const child = { task_id: "t-child", motebit_id: "m-c", status: "completed", result: "ok" };
    const el = renderResult(
      view({
        delegations: [{ integrity: false, binding: "unverified", taskId: "t-child" }],
      }),
      { receipt: { ...receipt, delegation_receipts: [child] }, ctx: OFFLINE },
    );
    expect(el.querySelector(".delegation-block .sub-title")?.textContent).toContain("(1)");
    const node = el.querySelector("details.delegation")!;
    expect(node.querySelector("summary .chip")?.textContent).toBe("INVALID");
    expect(node.querySelector('[data-rung="integrity"] .check-mark.fail')).not.toBeNull();
  });

  it("a long result is truncated with a keyboard-native expander", () => {
    const long = "x".repeat(1000);
    const el = renderResult(view(), { receipt: { ...receipt, result: long }, ctx: OFFLINE });
    const details = el.querySelector(".result-expand")!;
    expect(details.tagName).toBe("DETAILS");
    expect(details.querySelector(".result-full")?.textContent).toBe(long);
  });
});
