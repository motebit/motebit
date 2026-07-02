/**
 * Tests for the producer of `AIResponse.reasoning` — the interior-cognition
 * capture that stops motebit from DESTROYING the model's `<thinking>` trace
 * before it can reach the owner-facing `mind` organ.
 *
 * Producer = `extractReasoningTags` in `core.ts`. It is the counterpart to
 * `extractNarrationTag`, but with three deliberate differences that pin the
 * interior-vs-chrome distinction:
 *   - narration is current-state (LAST tag wins, ~80-char cap, chrome register);
 *   - reasoning is the cumulative interior trace (ALL blocks concatenated, no
 *     cap, `mind` register — interior, owner-only).
 *
 * The load-bearing invariant: reasoning is captured but STILL stripped from the
 * visible `text` (via `stripTags`) — the chat register stays clean; the trace
 * feeds the interior organ, never the conversation.
 */

import { describe, it, expect } from "vitest";
import { extractReasoningTags, stripTags } from "../core.js";

describe("extractReasoningTags", () => {
  it("returns null when no <thinking> tag is present", () => {
    expect(extractReasoningTags("Just some visible text")).toBeNull();
    expect(extractReasoningTags("")).toBeNull();
  });

  it("captures the reasoning content of a single tag", () => {
    expect(extractReasoningTags("<thinking>I should read the page first</thinking>Done")).toBe(
      "I should read the page first",
    );
  });

  it("concatenates ALL blocks in order (cumulative trace, unlike last-wins narration)", () => {
    const text =
      "<thinking>First, weigh the options</thinking>ok<thinking>Now commit to A</thinking>";
    expect(extractReasoningTags(text)).toBe("First, weigh the options\n\nNow commit to A");
  });

  it("trims whitespace and skips empty blocks", () => {
    expect(extractReasoningTags("<thinking>  padded  </thinking>")).toBe("padded");
    expect(extractReasoningTags("<thinking>   </thinking>real<thinking>kept</thinking>")).toBe(
      "kept",
    );
    expect(extractReasoningTags("<thinking></thinking>")).toBeNull();
  });

  it("does NOT cap length — the interior organ holds the full trace (unlike the calm chrome)", () => {
    const long = "x".repeat(5000);
    expect(extractReasoningTags(`<thinking>${long}</thinking>`)).toBe(long);
  });

  it("preserves multi-line reasoning verbatim", () => {
    const body = "line one\nline two\n- a bullet";
    expect(extractReasoningTags(`<thinking>${body}</thinking>`)).toBe(body);
  });

  it("INTERIOR-ONLY: the captured reasoning is still stripped from the visible chat text", () => {
    const raw = "<thinking>secret deliberation about the plan</thinking>Here is the answer.";
    // Captured for the mind organ...
    expect(extractReasoningTags(raw)).toBe("secret deliberation about the plan");
    // ...but never in the conversation register.
    const visible = stripTags(raw);
    expect(visible).not.toContain("secret deliberation");
    expect(visible.trim()).toBe("Here is the answer.");
  });
});
