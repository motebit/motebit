/**
 * Differential display fuzz — every display path (final answer, live stream,
 * plain-text and markdown surfaces) against origin/main's, over seeded
 * generated inputs with closed and UNCLOSED internal blocks, asterisks
 * around and inside tags, cue-only bullets, `<` that never becomes a tag,
 * CRLF, code fences, unicode; streams split per character and at random.
 *
 * Properties, for every input:
 *   (1) HIDING SUPERSET — every secret main's output hides, the branch's
 *       final and stream outputs hide; text after an unclosed internal
 *       opener is never shown.
 *   (2) STREAM == FINAL — the concatenated stream deltas equal the final
 *       display text exactly, at every split.
 *   (3) markdown with no tags and no cues is byte-preserved (trimmed).
 *
 * Default run: a few thousand inputs. Full run (>=200k):
 *   DISPLAY_FUZZ_COUNT=200000 pnpm --filter @motebit/runtime exec vitest run display-fuzz
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
  generateFuzzCorpus,
  generateMarkdownCorpus,
  mainStream,
  mainStripInternalTags,
  mainStripPartialActionTag,
  mainStripTags,
  mulberry32,
  randomSplit,
  secretsIn,
  unclosedSecretsIn,
} from "./fixtures/display-fuzz-corpus.js";

const COUNT = Number(process.env.DISPLAY_FUZZ_COUNT ?? 4000);
/** Per-character streaming on every Nth input (it is O(n²) per input). */
const PER_CHAR_EVERY = 8;

/** The branch's live stream: concatenated deltas for `pieces`, final flush included. */
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

/** The final display text of a complete streamed answer. */
function finalDisplay(text: string): string {
  return renderDisplayText(text, STREAM_TAG_PATTERNS).trim();
}

/** Secrets in `input` that `mainOut` hides but `out` shows. */
function leaks(input: string, mainOut: string, out: string): string[] {
  const mainShown = new Set(secretsIn(mainOut));
  const shown = new Set(secretsIn(out));
  const unclosed = unclosedSecretsIn(out);
  return [
    ...new Set([...secretsIn(input).filter((s) => !mainShown.has(s) && shown.has(s)), ...unclosed]),
  ];
}

interface Failure {
  property: string;
  path: string;
  input: string;
  detail: unknown;
}

function report(failures: Failure[]): void {
  if (failures.length === 0) return;
  const byKey = new Map<string, Failure[]>();
  for (const f of failures) {
    const key = `${f.property} / ${f.path}`;
    byKey.set(key, [...(byKey.get(key) ?? []), f]);
  }
  const summary = [...byKey.entries()].map(([key, fs]) => ({
    key,
    count: fs.length,
    examples: fs.slice(0, 3).map((f) => ({ input: f.input, detail: f.detail })),
  }));
  expect(summary).toEqual([]);
}

describe("display repros (review of b80928a8d)", () => {
  it.each([
    ["*<thinking>SECRET1*"],
    ["Hi *[MEMORY_DATA]SECRET1*"],
    ["**<thinking>SECRET1"],
    ['*[EXTERNAL_DATA source="w"]SECRET1'],
    ["<thinking>SECRET1"],
    ['Ok. <memory confidence="0.5"SECRET1'],
  ])("(A) unclosed internal block hides to end: %j", (input) => {
    for (const out of [
      stripTags(input),
      stripPartialActionTag(input),
      stripInternalTags(input),
      stripInternalTagsForDisplay(input),
      finalDisplay(input),
      stream([input]),
      stream([...input]),
    ]) {
      expect(out).not.toContain("SECRET");
    }
  });

  it("(B) a cue-only bullet streams exactly as the final text", () => {
    const input = "Sure.\n- *nods*";
    expect(finalDisplay(input)).toBe("Sure.");
    expect(stream([...input])).toBe("Sure.");
    for (let k = 1; k < input.length; k++) {
      expect(stream([input.slice(0, k), input.slice(k)])).toBe("Sure.");
    }
  });

  it("(C) a `<` that never becomes a tag is released at end of stream", () => {
    expect(stream(["if x < y", " then"])).toBe("if x < y then");
    expect(stream([..."if x < y then"])).toBe("if x < y then");
    expect(stream(["a <", "3"])).toBe("a <3");
  });
});

describe("differential display fuzz", () => {
  it(`tagged corpus (${COUNT} inputs): hiding superset of main, stream == final`, () => {
    const corpus = generateFuzzCorpus(COUNT);
    const rand = mulberry32(0xf1a7);
    const failures: Failure[] = [];
    const leak = (path: string, input: string, mainOut: string, out: string): void => {
      const l = leaks(input, mainOut, out);
      if (l.length > 0) failures.push({ property: "hiding", path, input, detail: { out, l } });
    };

    corpus.forEach((input, i) => {
      leak("stripTags", input, mainStripTags(input), stripTags(input));
      leak(
        "stripPartialActionTag",
        input,
        mainStripPartialActionTag(input),
        stripPartialActionTag(input),
      );
      leak("stripInternalTags", input, mainStripInternalTags(input), stripInternalTags(input));
      leak(
        "stripInternalTagsForDisplay",
        input,
        mainStripInternalTags(input),
        stripInternalTagsForDisplay(input),
      );

      const final = finalDisplay(input);
      const splits: string[][] = [[input], randomSplit(input, rand), randomSplit(input, rand)];
      if (i % PER_CHAR_EVERY === 0) splits.push([...input]);
      for (const pieces of splits) {
        const out = stream(pieces);
        const mainOut = mainStream(pieces);
        leak("stream", input, mainOut, out);
        // Desktop renders stripPartialActionTag over the stream's deltas.
        leak("desktop", input, mainStripPartialActionTag(mainOut), stripPartialActionTag(out));
        if (out !== final) {
          failures.push({
            property: "stream==final",
            path: "stream",
            input,
            detail: { pieces, out, final },
          });
        }
      }
    });
    report(failures);
  }, 600_000);

  it(`markdown corpus (${COUNT} inputs): byte-preserved on every path`, () => {
    const corpus = generateMarkdownCorpus(COUNT);
    const rand = mulberry32(0x0dd);
    const failures: Failure[] = [];
    corpus.forEach((input, i) => {
      const want = input.trim();
      const paths: Array<[string, string]> = [
        ["stripTags", stripTags(input)],
        ["stripPartialActionTag", stripPartialActionTag(input)],
        ["stripInternalTags", stripInternalTags(input).trim()],
        ["stripInternalTagsForDisplay", stripInternalTagsForDisplay(input)],
        ["final", finalDisplay(input)],
        ["stream", stream(randomSplit(input, rand))],
      ];
      if (i % PER_CHAR_EVERY === 0) paths.push(["stream per-char", stream([...input])]);
      for (const [path, out] of paths) {
        if (out !== want)
          failures.push({ property: "markdown", path, input, detail: { out, want } });
      }
    });
    report(failures);
  }, 600_000);
});
