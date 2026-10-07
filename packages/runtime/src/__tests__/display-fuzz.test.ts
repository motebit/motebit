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
 *       opener is never shown. One exemption, counted and bounded: a token
 *       of a block main's own TAG CHAIN shows (main reads a stray closer
 *       spliced into another tag's name as a real closer) that main hides
 *       only by its `\*[^*]+\*` markdown strip or its never-released `<`
 *       hold — the two behaviours this branch removes by design. Tokens
 *       main's stream hides only by holding from an unclosed `<parameter`
 *       forever, and tokens off the stream that main's chain shows (its
 *       chains never match `<parameter …>` there), are not counted.
 *   (2) STREAM == FINAL — the concatenated stream deltas equal the final
 *       display text exactly, at every split.
 *   (3) markdown with no tags and no cues is byte-preserved (trimmed).
 *
 * Default run: a few thousand inputs. Full run (>=200k):
 *   DISPLAY_FUZZ_COUNT=200000 pnpm --filter @motebit/runtime exec vitest run display-fuzz
 * (`DISPLAY_FUZZ_SEED=<n>` explores another corpus.)
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
  MAIN_HOLD_TAGS,
  mainStream,
  mainStripInternalTags,
  mainStripPartialActionTag,
  mainStreamChainOnly,
  mainStripTags,
  mainStripTagsChainOnly,
  mulberry32,
  randomSplit,
  secretsIn,
  unclosedSecretsIn,
} from "./fixtures/display-fuzz-corpus.js";

const COUNT = Number(process.env.DISPLAY_FUZZ_COUNT ?? 4000);
/** Corpus seed; the default is the committed, deterministic one. */
const SEED = Number(process.env.DISPLAY_FUZZ_SEED ?? 0xd15e);
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

/**
 * The input's secret tokens `text` shows. A token followed by digits from
 * adjacent text (`SECRET12` + `1. step` reads `SECRET121`) is still the
 * input's token: trailing digits are dropped until it names one.
 */
function tokensIn(text: string, known: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (let token of secretsIn(text)) {
    while (!known.has(token) && /\d\d$/.test(token)) token = token.slice(0, -1);
    out.add(token);
  }
  return out;
}

/**
 * Secrets in `input` that `mainOut` hides but `out` shows, plus any
 * unclosed-block secret `out` shows; `exempt` collects closed-block secrets
 * main's own tag chain (`mainChain`) shows.
 */
function leaks(
  input: string,
  mainOut: string,
  mainChain: string,
  out: string,
  exempt: Set<string>,
): string[] {
  const known = new Set(secretsIn(input));
  const mainShown = tokensIn(mainOut, known);
  const chainShown = tokensIn(mainChain, known);
  const shown = tokensIn(out, known);
  const found = new Set(unclosedSecretsIn(out));
  for (const s of secretsIn(input)) {
    if (mainShown.has(s) || !shown.has(s) || found.has(s)) continue;
    if (chainShown.has(s)) exempt.add(s);
    else found.add(s);
  }
  return [...found];
}

/** Upper bound on inputs carrying an exempt token (see property 1). */
const MAX_EXEMPT_RATE = 0.002;

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

  it.each([
    ['[x]*<memory confidence="0.9">m *nods*</memory>[y]*tilts head*', "[x]*[y]"],
    ["** star item\n*[not a marker]*nods*", "** star item\n*[not a marker]"],
  ])("a `*` that ends a prefix can still open a cue: %j", (input, expected) => {
    expect(finalDisplay(input)).toBe(expected);
    expect(stream([...input])).toBe(expected);
  });

  it("(C) a `<` that never becomes a tag is released at end of stream", () => {
    expect(stream(["if x < y", " then"])).toBe("if x < y then");
    expect(stream([..."if x < y then"])).toBe("if x < y then");
    expect(stream(["a <", "3"])).toBe("a <3");
  });
});

describe("differential display fuzz", () => {
  it(`tagged corpus (${COUNT} inputs): hiding superset of main, stream == final`, () => {
    const corpus = generateFuzzCorpus(COUNT, SEED);
    const rand = mulberry32(0xf1a7);
    const failures: Failure[] = [];
    let exemptInputs = 0;

    corpus.forEach((input, i) => {
      const exempt = new Set<string>();
      // Off the stream, main's chains never match `<parameter …>`, so a
      // token their chain shows there is shown by definition (the bar is
      // main's tag chain): exempt, but not counted toward the bound.
      const uncounted = new Set<string>();
      const leak = (
        path: string,
        mainOut: string,
        mainChain: string,
        out: string,
        explained = "",
      ): void => {
        const counted = path === "stream" || path === "desktop";
        const found = new Set<string>();
        const l = leaks(input, mainOut, mainChain, out, found);
        // A token main's stream hides only by holding from an unclosed
        // `<parameter` forever — not an opener in main's chain grammar —
        // is shown by the chain by definition: uncounted.
        const shownWithoutHold = tokensIn(explained, new Set(secretsIn(input)));
        for (const s of found) (counted && !shownWithoutHold.has(s) ? exempt : uncounted).add(s);
        if (l.length > 0) failures.push({ property: "hiding", path, input, detail: { out, l } });
      };
      const internalChain = mainStripInternalTags(input);
      const streamChain = mainStreamChainOnly(input);
      leak("stripTags", mainStripTags(input), mainStripTagsChainOnly(input), stripTags(input));
      leak(
        "stripPartialActionTag",
        mainStripPartialActionTag(input),
        internalChain,
        stripPartialActionTag(input),
      );
      leak("stripInternalTags", internalChain, internalChain, stripInternalTags(input));
      leak(
        "stripInternalTagsForDisplay",
        internalChain,
        internalChain,
        stripInternalTagsForDisplay(input),
      );

      const final = finalDisplay(input);
      const splits: string[][] = [[input], randomSplit(input, rand), randomSplit(input, rand)];
      if (i % PER_CHAR_EVERY === 0) splits.push([...input]);
      // Main's split stream yields `clean.slice(yielded)` of a string that
      // can change behind the cursor, so text it drops there is lost by
      // accident, not hidden. Its baseline is what main shows on the split
      // OR on the whole text.
      const mainWhole = mainStream([input]);
      const noParamHold = MAIN_HOLD_TAGS.filter((t) => t !== "<parameter");
      for (const pieces of splits) {
        const out = stream(pieces);
        const mainSplit = mainStream(pieces);
        const unheldSplit = mainStream(pieces, noParamHold);
        const unheldWhole = mainStream([input], noParamHold);
        const explained = `${unheldSplit}\n${unheldWhole}`;
        leak("stream", `${mainSplit}\n${mainWhole}`, streamChain, out, explained);
        // Desktop renders stripPartialActionTag over the stream's deltas.
        const mainDesktop = `${mainStripPartialActionTag(mainSplit)}\n${mainStripPartialActionTag(mainWhole)}`;
        const explainedDesktop = `${mainStripPartialActionTag(unheldSplit)}\n${mainStripPartialActionTag(unheldWhole)}`;
        leak("desktop", mainDesktop, streamChain, stripPartialActionTag(out), explainedDesktop);
        if (out !== final) {
          failures.push({
            property: "stream==final",
            path: "stream",
            input,
            detail: { pieces, out, final },
          });
        }
      }
      if (exempt.size > 0) exemptInputs++;
    });
    report(failures);
    expect(exemptInputs / COUNT).toBeLessThanOrEqual(MAX_EXEMPT_RATE);
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
