/**
 * @vitest-environment jsdom
 *
 * Membrane-out symmetry invariant — pins the doctrine-canonical
 * detach path that closes the perception-in / artifact-out
 * asymmetry named in `liquescentia-as-substrate.md` §"Cohesive
 * permeability."
 *
 * The slab's membrane is permeable in BOTH directions:
 *   - perception-in: drag-drop bytes cross signed via
 *     `UserActionAttestation` (already wired)
 *   - artifact-out: durable outputs cross signed via
 *     `ExecutionReceipt` / `ComputerSessionReceipt`, emerging
 *     FROM the slab through the pinch physics (this work)
 *
 * `renderDetachArtifact` is the bridge between the slab's pinch
 * phase and the scene artifact that settles. When the detach
 * carries a signed `ComputerSessionReceipt`, this function MUST
 * route through `buildComputerSessionReceiptArtifact` so the
 * canonical receipt DOM shape lands via the pinch path — the
 * same shape that the legacy `addArtifact` fallback produces.
 * One artifact shape, two emergence physics; the user feels the
 * pinch when the slab is up, falls through to direct placement
 * when it isn't.
 */

import { describe, it, expect, vi } from "vitest";
import { renderDetachArtifact } from "../ui/slab-items.js";
import type { SlabItem } from "@motebit/runtime";

function makeLiveBrowserItem(detachResult: unknown): SlabItem {
  return {
    id: "live-browser-1",
    kind: "live_browser",
    mode: "virtual_browser",
    phase: "pinching",
    phaseTime: 0,
    lastUpdatedAt: 1_700_000_000,
    payload: {
      __slabDetach: {
        artifactKind: "receipt",
        outcome: { kind: "completed", result: detachResult, detachAs: "receipt" },
      },
    },
  } as unknown as SlabItem;
}

const SIGNED_RECEIPT = {
  receipt_id: "csr-test-abc123",
  session_id: "sess-test-xyz789",
  embodiment_mode: "virtual_browser",
  actions_hash: "0xfeedfacecafebeef0001",
  signature: "sig-test-aabbccdd",
  motebit_id: "did:motebit:testtest000000000000000000000000",
  action_count: 3,
  outcomes_summary: { success: 3, failure: 0 },
  failure_breakdown: {},
  max_sensitivity: "none",
  was_halted: false,
  opened_at: 1_700_000_000_000,
  closed_at: 1_700_000_001_000,
  suite: "ed25519-2024",
  display_width: 1920,
  display_height: 1200,
  scaling_factor: 2,
};

describe("renderDetachArtifact — membrane-out symmetry (signed receipt emerges via slab-pinch)", () => {
  it("renders a receipt-shaped detach payload via buildComputerSessionReceiptArtifact — the canonical receipt DOM lands via the slab path", () => {
    const removeArtifact = vi.fn();
    const result = renderDetachArtifact(
      makeLiveBrowserItem(SIGNED_RECEIPT),
      "receipt",
      removeArtifact,
    );

    // Canonical receipt-artifact classes — proof we routed through
    // `buildComputerSessionReceiptArtifact`, not the generic card.
    expect(result.element.className).toContain("artifact-computer-session");
    expect(result.element.className).toContain("artifact-receipt");
    expect(result.kind).toBe("receipt");
    // The title carries the embodiment per the canonical builder.
    const title = result.element.querySelector(".spatial-artifact-title");
    expect(title?.textContent).toContain("computer session");
    expect(title?.textContent).toContain("virtual_browser");
  });

  it("wires the dismiss callback through the renderer's removeArtifact closure — one dismissal mechanism for both emergence physics", () => {
    const removeArtifact = vi.fn();
    const result = renderDetachArtifact(
      makeLiveBrowserItem(SIGNED_RECEIPT),
      "receipt",
      removeArtifact,
    );

    // Find the dismiss button (canonical builder's close affordance).
    const closeBtn = result.element.querySelector("button");
    expect(closeBtn).not.toBeNull();
    closeBtn?.dispatchEvent(new MouseEvent("click"));
    expect(removeArtifact).toHaveBeenCalledWith(result.id);
  });

  it("falls back to the generic card when artifactKind is 'receipt' but the result isn't receipt-shaped — defensive against payload drift", () => {
    // Defensive case: a future change might pass a non-receipt
    // result with detachAs:"receipt". The function must not crash;
    // it should fall back to the generic JSON-card render. The
    // duck-type is the only gate (no full receipt schema validation
    // here — that's the relay's concern).
    const result = renderDetachArtifact(
      makeLiveBrowserItem({ unexpected: "shape" }),
      "receipt",
      vi.fn(),
    );
    expect(result.element.className).toContain("slab-detach-artifact");
    expect(result.element.className).not.toContain("artifact-computer-session");
  });

  it("renders non-receipt artifact kinds via the generic card — the receipt path is artifactKind-gated, not result-shape-gated", () => {
    // Symmetric to the above: even if the result LOOKS receipt-
    // shaped, if artifactKind is not "receipt" we don't route
    // through the receipt builder. The artifact's kind is the
    // contract; the result is just the payload.
    const result = renderDetachArtifact(
      {
        id: "tool-call-1",
        kind: "tool_call",
        mode: "tool_result",
        phase: "pinching",
        phaseTime: 0,
        lastUpdatedAt: 1_700_000_000,
        payload: {
          __slabDetach: {
            artifactKind: "text",
            outcome: { kind: "completed", result: SIGNED_RECEIPT, detachAs: "text" },
          },
        },
      } as unknown as SlabItem,
      "text",
      vi.fn(),
    );
    expect(result.element.className).toContain("slab-detach-text");
    expect(result.element.className).not.toContain("artifact-computer-session");
  });
});
