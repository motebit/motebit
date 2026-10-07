/**
 * Differential tag-hiding harness — internal-tag removal on every display
 * path is BYTE-IDENTICAL to origin/main's sequential regex chains, including
 * the splice behaviour (a removal joining its neighbours into a new tag that
 * a later regex hides). Markdown handling may differ from main; tag hiding
 * may not.
 *
 * Two properties over a generated corpus (`generateSpliceCorpus`):
 *   (a) step 1 of rendering (`applyTagChain`) equals main's chain verbatim;
 *   (b) no display output contains a secret that main's chain hides.
 */
import { describe, it, expect } from "vitest";
import {
  applyTagChain,
  STRIP_TAG_PATTERNS,
  INTERNAL_TAG_PATTERNS,
  stripTags,
  stripPartialActionTag,
  stripInternalTags,
  stripInternalTagsForDisplay,
} from "../core.js";
import { SPLICE_REPROS, generateSpliceCorpus, secretsIn } from "./fixtures/tag-splice-corpus.js";

/** origin/main `stripTags`, tag-removal steps only (verbatim, in order). */
function stripTagsMainTagChainOnly(text: string): string {
  return text
    .replace(/<memory\s+[^>]*>[\s\S]*?<\/memory>/g, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .replace(/<state\s+[^>]*\/>/g, "")
    .replace(/<narration\s*>[\s\S]*?<\/narration\s*>/g, "")
    .replace(/\[EXTERNAL_DATA[^\]]*\][\s\S]*?\[\/EXTERNAL_DATA\]/g, "")
    .replace(/\[MEMORY_DATA\][\s\S]*?\[\/MEMORY_DATA\]/g, "")
    .replace(/\[EXTERNAL_DATA[^\]]*\]/g, "")
    .replace(/\[\/EXTERNAL_DATA\]/g, "")
    .replace(/\[MEMORY_DATA\]/g, "")
    .replace(/\[\/MEMORY_DATA\]/g, "");
}

/** origin/main `stripInternalTags`, verbatim. */
function stripInternalTagsMain(text: string): string {
  return text
    .replace(/<state\s+[^>]*\/>/g, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .replace(/<memory\s+[^>]*>[\s\S]*?<\/memory>/g, "")
    .replace(/\[EXTERNAL_DATA[^\]]*\][\s\S]*?\[\/EXTERNAL_DATA\]/g, "")
    .replace(/\[MEMORY_DATA\][\s\S]*?\[\/MEMORY_DATA\]/g, "")
    .replace(/\[EXTERNAL_DATA[^\]]*\]/g, "")
    .replace(/\[\/EXTERNAL_DATA\]/g, "")
    .replace(/\[MEMORY_DATA\]/g, "")
    .replace(/\[\/MEMORY_DATA\]/g, "")
    .replace(/<(?:state|thinking|memory)[^>]*$/g, "");
}

const CORPUS = generateSpliceCorpus(3000);

/** Secrets present in `input` that `hidden` (main's chain output) does not show. */
function hiddenSecrets(input: string, hidden: string): string[] {
  const shown = new Set(secretsIn(hidden));
  return secretsIn(input).filter((s) => !shown.has(s));
}

describe("tag splice: the review repros", () => {
  it.each(SPLICE_REPROS.map(([i, o]) => [i, o] as const))("%j hides as on main", (input, out) => {
    expect(stripTags(input)).toBe(out);
    expect(stripPartialActionTag(input)).toBe(out);
    expect(stripInternalTagsForDisplay(input)).toBe(out);
  });
});

describe("tag splice: differential against origin/main's chains", () => {
  it("the corpus exercises splices", () => {
    // Sanity: main's chain hides more than a marker-substituting chain would.
    const spliced = CORPUS.filter((x) => /(MEMORY|EXTERNAL)_[<[]/.test(x));
    expect(spliced.length).toBeGreaterThan(100);
  });

  it("step 1 of stripTags is main's tag chain, byte for byte", () => {
    for (const x of CORPUS) {
      const got = applyTagChain(x, STRIP_TAG_PATTERNS);
      if (got !== stripTagsMainTagChainOnly(x)) {
        expect({ x, got }).toEqual({ x, got: stripTagsMainTagChainOnly(x) });
      }
    }
  });

  it("step 1 of the internal-tag paths is main's stripInternalTags, byte for byte", () => {
    for (const x of CORPUS) {
      const want = stripInternalTagsMain(x);
      const got = applyTagChain(x, INTERNAL_TAG_PATTERNS);
      if (got !== want) expect({ x, got }).toEqual({ x, got: want });
    }
  });

  it("stripInternalTags only ever hides more than main's chain", () => {
    // Every char it shows is one main's chain shows, in order: internal
    // blocks the chain leaves visible (unclosed, nested, spliced) go too.
    const isSubsequence = (sub: string, of: string): boolean => {
      let i = 0;
      for (const ch of of) if (i < sub.length && sub[i] === ch) i++;
      return i === sub.length;
    };
    for (const x of CORPUS) {
      const got = stripInternalTags(x);
      if (!isSubsequence(got, stripInternalTagsMain(x))) {
        expect({ x, got }).toEqual({ x, got: stripInternalTagsMain(x) });
      }
    }
  });

  it("no display output shows a secret main hides", () => {
    for (const x of CORPUS) {
      const viaStripTags = hiddenSecrets(x, stripTagsMainTagChainOnly(x));
      const viaInternal = hiddenSecrets(x, stripInternalTagsMain(x));
      const outputs: Array<[string, string[]]> = [
        [stripTags(x), viaStripTags],
        [stripPartialActionTag(x), viaInternal],
        [stripInternalTagsForDisplay(x), viaInternal],
      ];
      for (const [out, hidden] of outputs) {
        const leaked = hidden.filter((s) => secretsIn(out).includes(s));
        if (leaked.length > 0) expect({ x, out, leaked }).toEqual({ x, out, leaked: [] });
      }
    }
  });
});
