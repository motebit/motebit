/**
 * Realistic-answer parity — plausible model answers that contain NO real
 * internal block (C/C++ includes, generics, JSX/HTML/XML/SVG, templates,
 * shell redirects, math, tables, JSON, CRLF, prose mentioning memory /
 * thinking / state) display on EVERY path exactly as origin/main's tag
 * chain leaves them, followed by the markdown steps: nothing truncated or
 * removed that main's chain keeps. The same answers with a real trailing
 * `<state …/>` / `<memory …>…</memory>` still hide it.
 */
import { describe, it, expect } from "vitest";
import {
  renderDisplayText,
  stripInternalTags,
  stripInternalTagsForDisplay,
  stripPartialActionTag,
  stripTags,
} from "@motebit/ai-core";
import { DisplayStream, STREAM_TAG_PATTERNS } from "../streaming.js";
import {
  mainStreamChainOnly,
  mainStripInternalTags,
  mainStripTagsChainOnly,
  mulberry32,
  randomSplit,
} from "./fixtures/display-fuzz-corpus.js";
import { REALISTIC_ANSWERS, TRAILING_INTERNAL } from "./fixtures/realistic-answers.js";

function stream(pieces: readonly string[]): string {
  const display = new DisplayStream();
  let accumulated = "";
  let out = "";
  for (const piece of pieces) {
    accumulated += piece;
    out += display.next(accumulated);
  }
  return out + display.finish(accumulated);
}

/** Main's tag chain output, then the markdown steps (cues, folds); trimmed. */
function expected(chainOut: string, partial = false): string {
  return renderDisplayText(chainOut, [], { partial }).trim();
}

/** [path, branch output, expected] for every display path. */
function paths(input: string): Array<[string, string, string]> {
  const rand = mulberry32(input.length);
  const streamWant = expected(mainStreamChainOnly(input));
  return [
    ["stripTags", stripTags(input), expected(mainStripTagsChainOnly(input))],
    ["stripInternalTags", stripInternalTags(input).trim(), mainStripInternalTags(input).trim()],
    [
      "stripInternalTagsForDisplay",
      stripInternalTagsForDisplay(input),
      expected(mainStripInternalTags(input)),
    ],
    [
      "stripPartialActionTag",
      stripPartialActionTag(input),
      expected(mainStripInternalTags(input), true),
    ],
    ["final", renderDisplayText(input, STREAM_TAG_PATTERNS).trim(), streamWant],
    ["stream whole", stream([input]), streamWant],
    ["stream per-char", stream([...input]), streamWant],
    ["stream random", stream(randomSplit(input, rand)), streamWant],
  ];
}

describe("realistic answers", () => {
  it("corpus is large enough", () => {
    expect(REALISTIC_ANSWERS.length).toBeGreaterThanOrEqual(40);
  });

  it.each(REALISTIC_ANSWERS.map((a) => [a]))(
    "displays as main's tag chain keeps it: %j",
    (input) => {
      for (const [path, out, want] of paths(input)) {
        expect({ path, out }).toEqual({ path, out: want });
      }
    },
  );

  it.each(REALISTIC_ANSWERS.flatMap((a) => TRAILING_INTERNAL.map((t) => [a + t])))(
    "still hides a real trailing internal tag: %j",
    (input) => {
      for (const [path, out, want] of paths(input)) {
        expect({ path, out }).toEqual({ path, out: want });
        expect(out).not.toContain("SECRET_MEM");
        expect(out).not.toContain("<state ");
      }
    },
  );
});
