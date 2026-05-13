/**
 * Tests for the task-step narration runtime validator — the third
 * graduation of `runtime-invariants-over-prompt-rules.md`. Sibling of
 * `dishonest-closing.test.ts`; different shape (text-vs-typed-truth,
 * not field-vs-typed-truth), same doctrinal pattern.
 *
 * Three layers of pin:
 *   - Pass-through cases: empty narration, no hostname mention, no
 *     navigate result. Validator must not falsify when no
 *     contradiction is detectable.
 *   - Falsify cases: hostname mention contradicts last-navigate URL.
 *     Validator must replace with runtime-templated fallback.
 *   - Truthful narration: hostname mention matches last-navigate URL.
 *     Validator must pass through unchanged.
 *
 * The validator's bias is to MISS contradictions (pass through when
 * unsure) rather than to OVER-FIRE (falsify when the model was
 * actually correct). False-falsify is the worse failure mode — it
 * trains users to distrust the chrome's narration even when the
 * model was honest.
 */

import { describe, it, expect } from "vitest";
import { validateTaskStepNarration } from "../narration-validation.js";

describe("validateTaskStepNarration — pass-through cases", () => {
  it("empty narration passes through", () => {
    const result = validateTaskStepNarration({
      proposedNarration: "",
      toolResultsLog: [],
    });
    expect(result.valid).toBe(true);
    expect(result.narration).toBe("");
  });

  it("undefined narration passes through (chrome handles absence)", () => {
    const result = validateTaskStepNarration({
      proposedNarration: undefined,
      toolResultsLog: [],
    });
    expect(result.valid).toBe(true);
  });

  it("whitespace-only narration passes through", () => {
    const result = validateTaskStepNarration({
      proposedNarration: "   ",
      toolResultsLog: [],
    });
    expect(result.valid).toBe(true);
  });

  it("narration with no hostname mention passes through (no URL claim to validate)", () => {
    const result = validateTaskStepNarration({
      proposedNarration: "Reading the page",
      toolResultsLog: [
        {
          name: "computer",
          ok: true,
          data: { kind: "navigate", ok: true, url: "https://google.com/" },
          errorReason: null,
        },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.narration).toBe("Reading the page");
  });

  it("narration with hostname mention but empty tool log passes through (no wire truth to compare)", () => {
    const result = validateTaskStepNarration({
      proposedNarration: "Reading apple.com",
      toolResultsLog: [],
    });
    expect(result.valid).toBe(true);
    expect(result.narration).toBe("Reading apple.com");
  });

  it("narration with hostname mention but no navigate-class entries passes through", () => {
    const result = validateTaskStepNarration({
      proposedNarration: "Reading apple.com",
      toolResultsLog: [
        {
          name: "recall_memories",
          ok: true,
          data: { matches: [] },
          errorReason: null,
        },
      ],
    });
    expect(result.valid).toBe(true);
  });
});

describe("validateTaskStepNarration — falsify cases (the load-bearing trust contract)", () => {
  it("hostname mismatch with last-navigate URL falsifies", () => {
    // Load-bearing case from the doctrine memo: model says "Reading
    // apple.com" while the page is actually google.com. The chrome
    // would render a lie if validation didn't fire.
    const result = validateTaskStepNarration({
      proposedNarration: "Reading apple.com",
      toolResultsLog: [
        {
          name: "computer",
          ok: true,
          data: { kind: "navigate", ok: true, url: "https://google.com/" },
          errorReason: null,
        },
      ],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.narration).toBe("Reading google.com");
      expect(result.originalProposal).toBe("Reading apple.com");
      expect(result.reason).toContain("apple.com");
      expect(result.reason).toContain("google.com");
    }
  });

  it("falsifies even when narration uses full URL form", () => {
    const result = validateTaskStepNarration({
      proposedNarration: "Looking at https://apple.com/products",
      toolResultsLog: [
        {
          name: "computer",
          ok: true,
          data: { kind: "navigate", ok: true, url: "https://google.com/" },
          errorReason: null,
        },
      ],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.narration).toBe("Reading google.com");
    }
  });

  it("walks back to the most recent navigate entry, not the first", () => {
    // Multiple navigates; only the most recent matters.
    const result = validateTaskStepNarration({
      proposedNarration: "Reading apple.com",
      toolResultsLog: [
        {
          name: "computer",
          ok: true,
          data: { kind: "navigate", ok: true, url: "https://apple.com/" },
          errorReason: null,
        },
        {
          name: "computer",
          ok: true,
          data: { kind: "navigate", ok: true, url: "https://google.com/" },
          errorReason: null,
        },
      ],
    });
    // Last navigate is google.com; narration claims apple.com →
    // contradiction.
    expect(result.valid).toBe(false);
  });
});

describe("validateTaskStepNarration — truthful narration passes through", () => {
  it("matching hostname passes through", () => {
    const result = validateTaskStepNarration({
      proposedNarration: "Reading google.com",
      toolResultsLog: [
        {
          name: "computer",
          ok: true,
          data: { kind: "navigate", ok: true, url: "https://google.com/search?q=motebit" },
          errorReason: null,
        },
      ],
    });
    expect(result.valid).toBe(true);
    expect(result.narration).toBe("Reading google.com");
  });

  it("www-prefix variant matches (canonicalization)", () => {
    const result = validateTaskStepNarration({
      proposedNarration: "Reading google.com",
      toolResultsLog: [
        {
          name: "computer",
          ok: true,
          data: { kind: "navigate", ok: true, url: "https://www.google.com/" },
          errorReason: null,
        },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it("case-insensitive match", () => {
    const result = validateTaskStepNarration({
      proposedNarration: "Reading Google.com",
      toolResultsLog: [
        {
          name: "computer",
          ok: true,
          data: { kind: "navigate", ok: true, url: "https://google.com/" },
          errorReason: null,
        },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it("subdomain stays distinct (mail.google.com ≠ google.com)", () => {
    // The canonicalization strips leading www. but preserves other
    // subdomains. mail.google.com should NOT match google.com.
    const result = validateTaskStepNarration({
      proposedNarration: "Reading mail.google.com",
      toolResultsLog: [
        {
          name: "computer",
          ok: true,
          data: { kind: "navigate", ok: true, url: "https://google.com/" },
          errorReason: null,
        },
      ],
    });
    // Narration says mail.google.com; actual is google.com. Different
    // subdomains → contradiction. (If you're on mail.google.com you
    // ARE on a different page than google.com.)
    expect(result.valid).toBe(false);
  });
});

describe("validateTaskStepNarration — defensive cases", () => {
  it("passes through when wire URL is malformed (best-effort)", () => {
    // If the wire URL is malformed, can't compare. Pass-through
    // rather than falsifying — the bias is to miss rather than
    // over-fire.
    const result = validateTaskStepNarration({
      proposedNarration: "Reading apple.com",
      toolResultsLog: [
        {
          name: "computer",
          ok: true,
          data: { kind: "navigate", ok: true, url: "not-a-real-url" },
          errorReason: null,
        },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it("ignores failed tool calls when looking for the last navigate URL", () => {
    // A failed call has no URL data; the validator walks past it to
    // the previous successful navigate.
    const result = validateTaskStepNarration({
      proposedNarration: "Reading google.com",
      toolResultsLog: [
        {
          name: "computer",
          ok: true,
          data: { kind: "navigate", ok: true, url: "https://google.com/" },
          errorReason: null,
        },
        {
          name: "computer",
          ok: false,
          data: null,
          errorReason: "frame_stale",
        },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it("does not match version numbers as hostnames (false-positive guard)", () => {
    // "version 1.2.3" looks token-shaped but isn't a hostname.
    // Conservative regex avoids matching it.
    const result = validateTaskStepNarration({
      proposedNarration: "Looking at version 1.2.3 of the spec",
      toolResultsLog: [
        {
          name: "computer",
          ok: true,
          data: { kind: "navigate", ok: true, url: "https://google.com/" },
          errorReason: null,
        },
      ],
    });
    // No hostname extracted → pass-through.
    expect(result.valid).toBe(true);
  });
});
