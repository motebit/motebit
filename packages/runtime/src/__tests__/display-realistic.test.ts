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

/**
 * Main's tag chain output, then the markdown steps (cues, folds); trimmed.
 * Where the chain removed nothing that is exact; where it removed a block,
 * the branch also folds the whitespace the removal left, so the comparison
 * there ignores whitespace — nothing main's chain keeps may be missing.
 */
function expected(chainOut: string, partial = false): string {
  return renderDisplayText(chainOut, [], { partial }).trim();
}

const squash = (s: string): string => s.replace(/\s+/g, "");

/** [path, branch output, main's chain output, expected] for every display path. */
function paths(input: string): Array<[string, string, string, string]> {
  const rand = mulberry32(input.length);
  const streamChain = mainStreamChainOnly(input);
  const streamWant = expected(streamChain);
  const stripChain = mainStripTagsChainOnly(input);
  const internalChain = mainStripInternalTags(input);
  return [
    ["stripTags", stripTags(input), stripChain, expected(stripChain)],
    ["stripInternalTags", stripInternalTags(input).trim(), internalChain, internalChain.trim()],
    [
      "stripInternalTagsForDisplay",
      stripInternalTagsForDisplay(input),
      internalChain,
      expected(internalChain),
    ],
    [
      "stripPartialActionTag",
      stripPartialActionTag(input),
      internalChain,
      expected(internalChain, true),
    ],
    ["final", renderDisplayText(input, STREAM_TAG_PATTERNS).trim(), streamChain, streamWant],
    ["stream whole", stream([input]), streamChain, streamWant],
    ["stream per-char", stream([...input]), streamChain, streamWant],
    ["stream random", stream(randomSplit(input, rand)), streamChain, streamWant],
  ];
}

function check(input: string): void {
  for (const [path, out, chain, want] of paths(input)) {
    if (chain === input) expect({ path, out }).toEqual({ path, out: want });
    else expect({ path, out: squash(out) }).toEqual({ path, out: squash(want) });
  }
}

describe("realistic answers", () => {
  it("corpus is large enough", () => {
    expect(REALISTIC_ANSWERS.length).toBeGreaterThanOrEqual(40);
  });

  it.each(REALISTIC_ANSWERS.map((a) => [a]))(
    "displays as main's tag chain keeps it: %j",
    (input) => {
      check(input);
    },
  );

  it.each(REALISTIC_ANSWERS.flatMap((a) => TRAILING_INTERNAL.map((t) => [a + t])))(
    "still hides a real trailing internal tag: %j",
    (input) => {
      check(input);
      for (const [, out] of paths(input)) {
        expect(out).not.toContain("SECRET_MEM");
        expect(out).not.toContain("<state ");
      }
    },
  );
});
