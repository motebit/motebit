/**
 * Tests for the dishonest-closing intercept — graduates four typed-
 * truth fields from prompt-only teaching to runtime-enforced
 * correction.
 *
 * Three test pins per the reviewer's recommendation:
 *
 *   (1) Each of the four dishonesty-class fields triggers override on
 *       first-attempt failure — the structural floor.
 *   (2) Successful retry after first-attempt failure does NOT trigger
 *       override — the regression guard. The reviewer's gold: a naive
 *       intercept that scans the whole tool log and overrides on the
 *       first failure introduces a worse bug where the runtime
 *       contradicts a model that correctly recovered.
 *   (3) `submit_button_id` (affordance-class) does NOT trigger
 *       override — the register-distinction sanity check. Conflating
 *       affordance-class with dishonesty-class fields would trigger
 *       spurious overrides.
 *
 * Plus narrower unit tests on `classifyClosingClaim` to pin the
 * pattern boundaries — easier to debug a regression here than to
 * reverse-engineer it from a top-level intercept failure.
 */

import { describe, it, expect } from "vitest";
import {
  classifyClosingClaim,
  detectDishonestClosing,
  type ToolResultLogEntry,
} from "../dishonest-closing.js";

describe("classifyClosingClaim", () => {
  describe("submit-class patterns", () => {
    it("matches 'Submitted.' / 'I submitted'", () => {
      expect(classifyClosingClaim("Submitted.")).toBe("submit");
      expect(classifyClosingClaim("I submitted the form.")).toBe("submit");
      expect(classifyClosingClaim("I've submitted that.")).toBe("submit");
    });

    it("matches 'Searched for X' / 'I hit search'", () => {
      expect(classifyClosingClaim("Searched for motebit.")).toBe("submit");
      expect(classifyClosingClaim("I searched.")).toBe("submit");
      expect(classifyClosingClaim("I hit search.")).toBe("submit");
      expect(classifyClosingClaim("Hit enter.")).toBe("submit");
    });

    it("matches 'I sent the message'", () => {
      expect(classifyClosingClaim("Sent the message.")).toBe("submit");
      expect(classifyClosingClaim("I've sent it.")).toBe("submit");
    });
  });

  describe("type-class patterns", () => {
    it("matches 'Typed it.' / 'I typed motebit'", () => {
      expect(classifyClosingClaim("Typed it.")).toBe("type");
      expect(classifyClosingClaim("I typed motebit into the search box.")).toBe("type");
      expect(classifyClosingClaim("I've typed that.")).toBe("type");
    });

    it("matches 'Entered X' / 'Filled in'", () => {
      expect(classifyClosingClaim("Entered the value.")).toBe("type");
      expect(classifyClosingClaim("I filled in the field.")).toBe("type");
      expect(classifyClosingClaim("Filled in motebit.")).toBe("type");
    });
  });

  describe("view-class patterns", () => {
    it("matches 'I see X' / 'The page shows'", () => {
      expect(classifyClosingClaim("I see the search results.")).toBe("view");
      expect(classifyClosingClaim("I can see the page now.")).toBe("view");
      expect(classifyClosingClaim("The page shows the article.")).toBe("view");
    });

    it("matches 'Loaded' / 'Here's what I found'", () => {
      expect(classifyClosingClaim("Loaded.")).toBe("view");
      expect(classifyClosingClaim("Here's the page.")).toBe("view");
      expect(classifyClosingClaim("Here is what I found.")).toBe("view");
    });
  });

  describe("action-class patterns (generic Done)", () => {
    it("matches 'Done.' / 'Done!' / 'All set'", () => {
      expect(classifyClosingClaim("Done.")).toBe("action");
      expect(classifyClosingClaim("Done!")).toBe("action");
      expect(classifyClosingClaim("Done. Let me know what's next.")).toBe("action");
      expect(classifyClosingClaim("All set.")).toBe("action");
    });
  });

  describe("non-claims (must return null)", () => {
    it("does not match questions back to the user", () => {
      expect(classifyClosingClaim("What would you like me to do?")).toBeNull();
      expect(classifyClosingClaim("Should I try again?")).toBeNull();
    });

    it("does not match self-reported failures", () => {
      expect(
        classifyClosingClaim(
          "I tried but couldn't complete that — what would you like me to try next?",
        ),
      ).toBeNull();
      expect(classifyClosingClaim("That didn't work.")).toBeNull();
    });

    it("does not match narration of next steps", () => {
      expect(classifyClosingClaim("Let me try clicking that button next.")).toBeNull();
      expect(classifyClosingClaim("I'll re-read the page first.")).toBeNull();
    });

    it("does not match mid-sentence Done references", () => {
      expect(classifyClosingClaim("I almost said Done but checked the page first.")).toBeNull();
    });

    it("returns null for empty text", () => {
      expect(classifyClosingClaim("")).toBeNull();
      expect(classifyClosingClaim("   ")).toBeNull();
    });
  });
});

describe("detectDishonestClosing — three test pins", () => {
  // ── PIN (1): each dishonesty-class field triggers override ─────────
  describe("PIN 1 — each field triggers override on first-attempt failure", () => {
    it("navigation_triggered: false on click triggers correction", () => {
      const log: ToolResultLogEntry[] = [
        {
          name: "computer",
          ok: true,
          data: { kind: "click", ok: true, navigation_triggered: false },
          errorReason: null,
        },
      ];
      const correction = detectDishonestClosing({ finalText: "Done.", toolResultsLog: log });
      expect(correction).not.toBeNull();
      expect(correction).toContain("page didn't move");
    });

    it("navigation_triggered: false on key (Enter) triggers correction", () => {
      const log: ToolResultLogEntry[] = [
        {
          name: "computer",
          ok: true,
          data: { kind: "key", ok: true, navigation_triggered: false },
          errorReason: null,
        },
      ];
      const correction = detectDishonestClosing({
        finalText: "Submitted.",
        toolResultsLog: log,
      });
      expect(correction).not.toBeNull();
      expect(correction).toContain("page didn't move");
    });

    it("recovery_hint on type triggers correction", () => {
      const log: ToolResultLogEntry[] = [
        {
          name: "computer",
          ok: true,
          data: {
            kind: "type",
            ok: true,
            text_appeared: false,
            recovery_hint: "read_page_then_type_into",
          },
          errorReason: null,
        },
      ];
      const correction = detectDishonestClosing({
        finalText: "Typed motebit.",
        toolResultsLog: log,
      });
      expect(correction).not.toBeNull();
      expect(correction).toContain("text didn't appear");
    });

    it("bot_detection_detected on screenshot triggers correction", () => {
      const log: ToolResultLogEntry[] = [
        {
          name: "computer",
          ok: true,
          data: {
            kind: "screenshot",
            ok: true,
            bytes_base64: "AAAA",
            bot_detection_detected: true,
          },
          errorReason: null,
        },
      ];
      const correction = detectDishonestClosing({
        finalText: "Here's the page.",
        toolResultsLog: log,
      });
      expect(correction).not.toBeNull();
      expect(correction).toContain("CAPTCHA");
    });

    it("frame_stale error triggers correction on generic Done claim", () => {
      const log: ToolResultLogEntry[] = [
        {
          name: "computer",
          ok: false,
          data: null,
          errorReason: "frame_stale",
        },
      ];
      const correction = detectDishonestClosing({ finalText: "Done.", toolResultsLog: log });
      expect(correction).not.toBeNull();
      expect(correction).toContain("page navigated underneath");
    });

    it("non-frame_stale failure (policy_denied / session_closed) takes the count-based fallback, not the inspect branch", () => {
      // Comment in inspectDishonesty: failure reasons other than
      // `frame_stale` are surfaced via the count-based fallback
      // branches and don't need re-correction here. The function
      // returns null for those entries; the closing-text claim then
      // either matches a separate count-based rule or stays as-is.
      const log: ToolResultLogEntry[] = [
        {
          name: "computer",
          ok: false,
          data: null,
          errorReason: "policy_denied",
        },
      ];
      const correction = detectDishonestClosing({ finalText: "Done.", toolResultsLog: log });
      expect(correction).toBeNull();
    });

    // Sibling sweep pins (2026-05-12): blank_page_detected and
    // access_denied_detected. Same shape as bot_detection_detected,
    // distinct content-failure semantics. Persistent-state dishonesty
    // (page IS blank / IS denied), so the walk-back's last-relevant-
    // entry assumption holds cleanly.

    it("blank_page_detected on navigate triggers correction", () => {
      const log: ToolResultLogEntry[] = [
        {
          name: "computer",
          ok: true,
          data: {
            kind: "screenshot",
            ok: true,
            bytes_base64: "AAAA",
            blank_page_detected: true,
          },
          errorReason: null,
        },
      ];
      const correction = detectDishonestClosing({
        finalText: "Here's the page.",
        toolResultsLog: log,
      });
      expect(correction).not.toBeNull();
      expect(correction).toContain("blank");
    });

    it("access_denied_detected on navigate triggers correction", () => {
      const log: ToolResultLogEntry[] = [
        {
          name: "computer",
          ok: true,
          data: {
            kind: "screenshot",
            ok: true,
            bytes_base64: "AAAA",
            access_denied_detected: true,
          },
          errorReason: null,
        },
      ];
      const correction = detectDishonestClosing({
        finalText: "Loaded.",
        toolResultsLog: log,
      });
      expect(correction).not.toBeNull();
      expect(correction).toContain("access-denied");
    });
  });

  // ── PIN (2): retry-and-recover does NOT trigger override ───────────
  describe("PIN 2 — successful retry does NOT trigger override (regression guard)", () => {
    // The reviewer's gold. A naive intercept that scans the whole log
    // and overrides on the first failure introduces a worse bug: the
    // runtime contradicts a model that correctly recovered. The
    // walk-back finds the MOST RECENT terminal action of the relevant
    // kind; if that one succeeded, no override.

    it("key fails (navigation_triggered: false) then click succeeds — no override", () => {
      const log: ToolResultLogEntry[] = [
        {
          name: "computer",
          ok: true,
          data: { kind: "key", ok: true, navigation_triggered: false },
          errorReason: null,
        },
        {
          name: "computer",
          ok: true,
          data: { kind: "click", ok: true, navigation_triggered: true },
          errorReason: null,
        },
      ];
      const correction = detectDishonestClosing({ finalText: "Done.", toolResultsLog: log });
      expect(correction).toBeNull();
    });

    it("type fails (recovery_hint) then type succeeds — no override on action claim", () => {
      const log: ToolResultLogEntry[] = [
        {
          name: "computer",
          ok: true,
          data: {
            kind: "type",
            ok: true,
            text_appeared: false,
            recovery_hint: "read_page_then_type_into",
          },
          errorReason: null,
        },
        {
          name: "computer",
          ok: true,
          data: { kind: "type", ok: true, text_appeared: true },
          errorReason: null,
        },
      ];
      const correction = detectDishonestClosing({ finalText: "Done.", toolResultsLog: log });
      expect(correction).toBeNull();
    });

    it("screenshot returns CAPTCHA then re-screenshot returns clean — no override", () => {
      const log: ToolResultLogEntry[] = [
        {
          name: "computer",
          ok: true,
          data: {
            kind: "screenshot",
            ok: true,
            bytes_base64: "AAAA",
            bot_detection_detected: true,
          },
          errorReason: null,
        },
        {
          name: "computer",
          ok: true,
          data: { kind: "screenshot", ok: true, bytes_base64: "BBBB" },
          errorReason: null,
        },
      ];
      const correction = detectDishonestClosing({
        finalText: "Here's the page.",
        toolResultsLog: log,
      });
      expect(correction).toBeNull();
    });

    it("frame_stale then successful screenshot — no override on action claim", () => {
      const log: ToolResultLogEntry[] = [
        {
          name: "computer",
          ok: false,
          data: null,
          errorReason: "frame_stale",
        },
        {
          name: "computer",
          ok: true,
          data: { kind: "screenshot", ok: true, bytes_base64: "AAAA" },
          errorReason: null,
        },
      ];
      const correction = detectDishonestClosing({ finalText: "Done.", toolResultsLog: log });
      expect(correction).toBeNull();
    });

    // Retry-and-recover guards for the two new sibling rules.

    it("blank_page_detected then re-navigate returns clean — no override", () => {
      const log: ToolResultLogEntry[] = [
        {
          name: "computer",
          ok: true,
          data: {
            kind: "screenshot",
            ok: true,
            bytes_base64: "AAAA",
            blank_page_detected: true,
          },
          errorReason: null,
        },
        {
          name: "computer",
          ok: true,
          data: { kind: "screenshot", ok: true, bytes_base64: "BBBB" },
          errorReason: null,
        },
      ];
      const correction = detectDishonestClosing({
        finalText: "Here's the page.",
        toolResultsLog: log,
      });
      expect(correction).toBeNull();
    });

    it("access_denied_detected then re-navigate returns clean — no override", () => {
      const log: ToolResultLogEntry[] = [
        {
          name: "computer",
          ok: true,
          data: {
            kind: "screenshot",
            ok: true,
            bytes_base64: "AAAA",
            access_denied_detected: true,
          },
          errorReason: null,
        },
        {
          name: "computer",
          ok: true,
          data: { kind: "screenshot", ok: true, bytes_base64: "BBBB" },
          errorReason: null,
        },
      ];
      const correction = detectDishonestClosing({ finalText: "Loaded.", toolResultsLog: log });
      expect(correction).toBeNull();
    });
  });

  // ── PIN (3): submit_button_id (affordance) does NOT trigger ────────
  describe("PIN 3 — submit_button_id does NOT trigger override (register-distinction)", () => {
    // submit_button_id is affordance-class (a hint pointing at what
    // to click next), not dishonesty-class. Conflating it would
    // trigger spurious overrides on every successful key Enter where
    // the page also revealed a submit button.

    it("type result with submit_button_id present — no override", () => {
      const log: ToolResultLogEntry[] = [
        {
          name: "computer",
          ok: true,
          data: {
            kind: "type",
            ok: true,
            text_appeared: true,
            submit_button_id: "search-button-42",
          },
          errorReason: null,
        },
      ];
      const correction = detectDishonestClosing({
        finalText: "Typed motebit.",
        toolResultsLog: log,
      });
      expect(correction).toBeNull();
    });

    it("key result with submit_button_id present — no override (no navigation contradiction)", () => {
      const log: ToolResultLogEntry[] = [
        {
          name: "computer",
          ok: true,
          data: {
            kind: "key",
            ok: true,
            navigation_triggered: true,
            submit_button_id: "search-button-42",
          },
          errorReason: null,
        },
      ];
      const correction = detectDishonestClosing({ finalText: "Submitted.", toolResultsLog: log });
      expect(correction).toBeNull();
    });

    // Register-distinction pins for the two new rules. blank_page_detected
    // / access_denied_detected are dishonesty-class siblings of
    // bot_detection_detected; submit_button_id is affordance-class and
    // must NOT trigger an override even when co-occurring with the
    // dishonesty fields. (Pathological co-occurrence — in practice
    // submit_button_id appears on read_page results, not navigate
    // results — but encoding the register guarantee mechanically
    // means a future refactor that surfaces submit_button_id on
    // screenshot results wouldn't silently flip the register.)

    it("blank_page_detected: false + submit_button_id present — no override", () => {
      const log: ToolResultLogEntry[] = [
        {
          name: "computer",
          ok: true,
          data: {
            kind: "screenshot",
            ok: true,
            bytes_base64: "AAAA",
            blank_page_detected: false,
            submit_button_id: "search-button-42",
          },
          errorReason: null,
        },
      ];
      const correction = detectDishonestClosing({
        finalText: "Here's the page.",
        toolResultsLog: log,
      });
      expect(correction).toBeNull();
    });

    it("access_denied_detected: false + submit_button_id present — no override", () => {
      const log: ToolResultLogEntry[] = [
        {
          name: "computer",
          ok: true,
          data: {
            kind: "screenshot",
            ok: true,
            bytes_base64: "AAAA",
            access_denied_detected: false,
            submit_button_id: "search-button-42",
          },
          errorReason: null,
        },
      ];
      const correction = detectDishonestClosing({ finalText: "Loaded.", toolResultsLog: log });
      expect(correction).toBeNull();
    });
  });

  // ── Edge cases that the LAST-RELEVANT walk-back must handle ────────
  describe("walk-back semantics", () => {
    it("returns null when log is empty (no terminal action to inspect)", () => {
      const correction = detectDishonestClosing({ finalText: "Done.", toolResultsLog: [] });
      expect(correction).toBeNull();
    });

    it("returns null when no relevant action exists (claim register doesn't match log)", () => {
      const log: ToolResultLogEntry[] = [
        {
          name: "recall_memories",
          ok: true,
          data: { matches: [] },
          errorReason: null,
        },
      ];
      // Submit-class claim, but no submit-class action ever ran.
      const correction = detectDishonestClosing({
        finalText: "Submitted.",
        toolResultsLog: log,
      });
      expect(correction).toBeNull();
    });

    it("ignores non-browser tools when looking for action-class claims", () => {
      const log: ToolResultLogEntry[] = [
        {
          name: "web_search",
          ok: true,
          data: { results: [] },
          errorReason: null,
        },
      ];
      const correction = detectDishonestClosing({ finalText: "Done.", toolResultsLog: log });
      expect(correction).toBeNull();
    });

    it("submit-class claim picks navigation_triggered from a buried submit action when newer non-submit actions exist", () => {
      const log: ToolResultLogEntry[] = [
        {
          name: "computer",
          ok: true,
          data: { kind: "key", ok: true, navigation_triggered: false },
          errorReason: null,
        },
        // Newer actions of a different kind don't displace the submit
        // walk-back — the model is claiming submit succeeded, only
        // submit-kind typed-truth can confirm or contradict.
        {
          name: "computer",
          ok: true,
          data: { kind: "screenshot", ok: true, bytes_base64: "AAAA" },
          errorReason: null,
        },
      ];
      const correction = detectDishonestClosing({
        finalText: "Submitted.",
        toolResultsLog: log,
      });
      expect(correction).not.toBeNull();
      expect(correction).toContain("page didn't move");
    });
  });
});
