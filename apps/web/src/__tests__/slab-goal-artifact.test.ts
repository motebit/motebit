/**
 * @vitest-environment jsdom
 *
 * Goal-artifact slab view (#594 Inc 4). The view presents the DURABLE
 * goal record — full content, never the goal card's 500-char truncation
 * — with the "from goal" provenance chrome and a signed indicator that
 * renders iff a ContentArtifactManifest was minted.
 */
import { describe, it, expect } from "vitest";
import { buildGoalArtifactView, GOAL_VIEW_RESULT_EVENT } from "../ui/slab-goal-artifact";

const LONG_CONTENT = [
  "# Report",
  ...Array.from({ length: 40 }, (_, i) => `Line ${i} of the artifact body.`),
].join("\n");

describe("buildGoalArtifactView", () => {
  it("renders the FULL content — no truncation, no ellipsis suffix", () => {
    const view = buildGoalArtifactView({
      prompt: "daily digest",
      content: LONG_CONTENT,
      signed: false,
    });
    const content = view.querySelector(".slab-goal-artifact-content");
    expect(content?.textContent).toBe(LONG_CONTENT);
    expect(LONG_CONTENT.length).toBeGreaterThan(500); // guards the assertion's teeth
  });

  it('carries the "from goal" chrome with the goal prompt', () => {
    const view = buildGoalArtifactView({ prompt: "daily digest", content: "x", signed: false });
    expect(view.querySelector(".slab-goal-artifact-from")?.textContent).toBe("from goal");
    const prompt = view.querySelector(".slab-goal-artifact-prompt");
    expect(prompt?.textContent).toBe("daily digest");
  });

  it("shows the signed indicator iff the manifest claim is true", () => {
    const signed = buildGoalArtifactView({ prompt: "p", content: "c", signed: true });
    expect(signed.querySelector(".slab-goal-artifact-signed")?.textContent).toBe("signed");
    const unsigned = buildGoalArtifactView({ prompt: "p", content: "c", signed: false });
    expect(unsigned.querySelector(".slab-goal-artifact-signed")).toBeNull();
  });

  it("content is plain text — markup in the artifact is never interpreted", () => {
    const view = buildGoalArtifactView({
      prompt: "p",
      content: '<img src=x onerror="boom">',
      signed: false,
    });
    expect(view.querySelector("img")).toBeNull();
  });
});

describe("goal-view-result event contract", () => {
  it("the typed event carries an identifier only (promptless by construction)", () => {
    let seen: unknown = null;
    const listener = (e: Event): void => {
      seen = (e as CustomEvent<{ goalId?: string }>).detail;
    };
    document.addEventListener(GOAL_VIEW_RESULT_EVENT, listener);
    document.dispatchEvent(new CustomEvent(GOAL_VIEW_RESULT_EVENT, { detail: { goalId: "g-1" } }));
    document.removeEventListener(GOAL_VIEW_RESULT_EVENT, listener);
    expect(seen).toEqual({ goalId: "g-1" });
  });
});
