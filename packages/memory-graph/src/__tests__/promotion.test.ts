/**
 * Promotion — the tentative → absolute state transition.
 *
 * Pins:
 *   1. Threshold crossing is the trigger, not raw count. A memory that
 *      enters at 0.9 and receives one +0.1 boost (→ 1.0) should promote
 *      on the first reinforcement, not the third.
 *   2. `shouldPromote` is idempotent — a second call after the node is
 *      already above threshold returns false. This is what keeps
 *      `maybePromote` from re-emitting `memory_promoted` on every
 *      reinforcement past the crossing point.
 *   3. `estimateReinforcementCount` is informational, not load-bearing;
 *      the test locks the documented 0.7-baseline / 0.1-step formula so
 *      cross-implementation consumers can rely on the ballpark.
 */
import { describe, expect, it } from "vitest";
import {
  PROMOTION_CONFIDENCE_THRESHOLD,
  buildPromotionPayload,
  estimateReinforcementCount,
  shouldPromote,
} from "../promotion.js";
import type { MemoryNode, NodeId, MotebitId } from "@motebit/sdk";
import { SensitivityLevel, MemoryType } from "@motebit/sdk";

describe("shouldPromote — threshold crossing", () => {
  it("promotes when confidence crosses the threshold from below", () => {
    expect(shouldPromote(0.85, 0.95)).toBe(true);
    expect(shouldPromote(0.94, 1.0)).toBe(true);
    expect(shouldPromote(0.9, PROMOTION_CONFIDENCE_THRESHOLD)).toBe(true);
  });

  it("does not promote when both confidences are below the threshold", () => {
    expect(shouldPromote(0.5, 0.6)).toBe(false);
    expect(shouldPromote(0.7, 0.8)).toBe(false);
    expect(shouldPromote(0, 0.94)).toBe(false);
  });

  it("does not re-promote when prior was already above threshold (idempotency)", () => {
    expect(shouldPromote(0.95, 1.0)).toBe(false);
    expect(shouldPromote(1.0, 1.0)).toBe(false);
    expect(shouldPromote(0.96, 0.99)).toBe(false);
  });

  it("does not promote on a confidence decrease across the threshold", () => {
    // Guard: if some future consolidation reduces confidence, we don't
    // want a spurious "promotion" event just because the values
    // bracket the threshold in the wrong direction.
    expect(shouldPromote(0.99, 0.85)).toBe(false);
  });
});

describe("estimateReinforcementCount — 0.7 baseline, 0.1 step", () => {
  it("returns 0 at or below the baseline", () => {
    expect(estimateReinforcementCount(0.7)).toBe(0);
    expect(estimateReinforcementCount(0.5)).toBe(0);
    expect(estimateReinforcementCount(0)).toBe(0);
  });

  it("rounds (confidence - baseline) / step to the nearest integer, floor 1", () => {
    expect(estimateReinforcementCount(0.8)).toBe(1);
    expect(estimateReinforcementCount(0.9)).toBe(2);
    expect(estimateReinforcementCount(1.0)).toBe(3);
  });

  it("handles sub-step increments gracefully via rounding", () => {
    expect(estimateReinforcementCount(0.75)).toBe(1); // rounds up to 1 (min floor)
    expect(estimateReinforcementCount(0.84)).toBe(1);
    expect(estimateReinforcementCount(0.86)).toBe(2);
  });
});

describe("buildPromotionPayload — wire shape", () => {
  function makeNode(overrides: Partial<MemoryNode> = {}): MemoryNode {
    return {
      node_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" as NodeId,
      motebit_id: "mb-1" as MotebitId,
      content: "The user prefers TypeScript.",
      confidence: 1.0,
      sensitivity: SensitivityLevel.None,
      memory_type: MemoryType.Semantic,
      embedding: [],
      created_at: 0,
      last_accessed: 0,
      half_life: 30 * 24 * 60 * 60 * 1000,
      tombstoned: false,
      pinned: false,
      ...overrides,
    };
  }

  it("populates every required payload field", () => {
    const node = makeNode({ confidence: 0.95 });
    const payload = buildPromotionPayload(node, 0.85, 0.95, "reinforced");

    expect(payload).toEqual({
      node_id: node.node_id,
      from_confidence: 0.85,
      to_confidence: 0.95,
      reinforcement_count: 3,
      reason: "reinforced",
    });
  });

  it("carries the caller-supplied reason verbatim", () => {
    const node = makeNode();
    const payload = buildPromotionPayload(node, 0.9, 1.0, "user confirmed explicitly");
    expect(payload.reason).toBe("user confirmed explicitly");
  });
});
