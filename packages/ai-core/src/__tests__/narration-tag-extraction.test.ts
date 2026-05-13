/**
 * Tests for the producer half of the `task_step_narration` typed-truth
 * triple — the missing fourth part of the four-part-triple structure
 * (wire + prompt + producer + validator) named in the project memory
 * note `architecture_typed_truth_four_parts.md`.
 *
 * Producer = `extractNarrationTag` in `core.ts` + `stripTags`
 * extension that strips `<narration>` tags from visible text. Without
 * the producer, the validator's pass-through branch would fire 100%
 * of the time and the chrome would render an always-empty register.
 *
 * Test pins:
 *   - tag present → field populated
 *   - tag absent → field absent (null)
 *   - multiple tags → take the LAST (asymmetric with extractMemoryTags
 *     which takes ALL; narration is current-state, not cumulative)
 *   - empty content → null (don't populate with whitespace)
 *   - malformed tag → null (defensive against partial XML)
 *   - over-cap content → truncated to TASK_STEP_NARRATION_MAX_CHARS
 *     with ellipsis (chrome stays calm-software single-line)
 *   - tag stripped from visible text via `stripTags` (narration
 *     belongs to the chrome register, not the chat register)
 */

import { describe, it, expect } from "vitest";
import { extractNarrationTag, stripTags } from "../core.js";

describe("extractNarrationTag", () => {
  it("returns null when no tag is present", () => {
    expect(extractNarrationTag("Just some text without tags")).toBeNull();
    expect(extractNarrationTag("")).toBeNull();
  });

  it("extracts the trimmed content of a single tag", () => {
    expect(extractNarrationTag("<narration>Reading the page</narration>")).toBe("Reading the page");
    expect(extractNarrationTag("Hello <narration>Filling in the form</narration> world")).toBe(
      "Filling in the form",
    );
  });

  it("trims whitespace inside the tag", () => {
    expect(extractNarrationTag("<narration>   Reading the page   </narration>")).toBe(
      "Reading the page",
    );
  });

  it("returns null for empty / whitespace-only tag content", () => {
    expect(extractNarrationTag("<narration></narration>")).toBeNull();
    expect(extractNarrationTag("<narration>   </narration>")).toBeNull();
  });

  it("multiple tags → takes the LAST (current-state semantics)", () => {
    // Asymmetric with extractMemoryTags (takes ALL). Narration is
    // about the model's CURRENT task-step; the last tag is the
    // most recent thought, the first tag would represent stale
    // state. Per the prompt's single-tag instruction; last-wins is
    // the right default if the model emits multiple.
    const text =
      "<narration>Reading the page</narration> some text <narration>Filling in the form</narration>";
    expect(extractNarrationTag(text)).toBe("Filling in the form");
  });

  it("multiple tags with empty interspersed → still takes last non-empty", () => {
    const text =
      "<narration>First step</narration> <narration></narration> <narration>Last step</narration>";
    expect(extractNarrationTag(text)).toBe("Last step");
  });

  it("ignores malformed tags (defensive against partial XML)", () => {
    // Unclosed tag — regex's `</narration>` literal won't match,
    // returns null.
    expect(extractNarrationTag("<narration>Reading the page")).toBeNull();
    // Mismatched closing tag — won't match.
    expect(extractNarrationTag("<narration>Reading the page</foo>")).toBeNull();
  });

  it("caps over-length content at the chrome's calm-software ceiling", () => {
    // Build a 200-char narration; truncate to 79 + ellipsis (80 cap).
    const long = "a".repeat(200);
    const result = extractNarrationTag(`<narration>${long}</narration>`);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(80);
    expect(result!.endsWith("…")).toBe(true);
    expect(result!.slice(0, 79)).toBe("a".repeat(79));
  });

  it("under-cap content passes through unchanged (no truncation)", () => {
    const short = "Reading the page";
    expect(extractNarrationTag(`<narration>${short}</narration>`)).toBe(short);
  });

  it("supports content with newlines (multi-line narration is unusual but possible)", () => {
    expect(extractNarrationTag("<narration>line one\nline two</narration>")).toBe(
      "line one\nline two",
    );
  });
});

describe("stripTags — narration tag stripping", () => {
  // The narration belongs to the slab's chrome register (`motebit ×
  // virtual_browser` cell), not to the chat / mote-conversation
  // register. Visible-text strip enforces the registers stay distinct
  // (`goals → chat`, `task-steps → chrome` per chrome-as-state-render
  // and goals-vs-tasks). If the tag leaked into the visible text, the
  // user would see "Reading the page" twice — once in the chrome and
  // once in the chat — which contradicts the register separation.

  it("strips a single narration tag from visible text", () => {
    const input = "Hello <narration>Reading the page</narration> world";
    expect(stripTags(input)).toBe("Hello world");
  });

  it("strips multiple narration tags", () => {
    const input = "<narration>First step</narration> hello <narration>Last step</narration> world";
    const result = stripTags(input);
    expect(result).not.toContain("<narration>");
    expect(result).not.toContain("First step");
    expect(result).not.toContain("Last step");
    expect(result).toContain("hello");
    expect(result).toContain("world");
  });

  it("does not affect text without narration tags", () => {
    expect(stripTags("Plain text response")).toBe("Plain text response");
  });

  it("composes with other tag stripping (memory + state + narration in one response)", () => {
    const input = `Visible response <memory confidence="0.8" sensitivity="personal">User likes coffee</memory> <state field="mood" value="happy" /> <narration>Talking to user</narration>`;
    const result = stripTags(input);
    expect(result).toBe("Visible response");
  });
});
