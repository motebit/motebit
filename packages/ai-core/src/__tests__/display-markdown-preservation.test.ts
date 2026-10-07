/**
 * Display strip preserves markdown; internal-tag hiding is unchanged.
 *
 * The display strip used to delete every `*...*` span as a creature
 * "action cue", which destroyed markdown bold/italic and — through the
 * trailing `\s{2,}` collapse — every paragraph break and list indent.
 * No production path consumes asterisk cues (see
 * docs/design/out-of-band-interior-channel.md on branch
 * design/out-of-band-interior-channel), so the asterisk step is gone and
 * the whitespace pass is reduced to trim + fold 3+ newlines to 2.
 *
 * Two properties are locked here:
 *   1. A markdown corpus is byte-preserved (modulo that normalization) by
 *      every display path, at every streaming prefix.
 *   2. Differential: on a generated corpus of internal tags, the display
 *      paths hide exactly what origin/main's tag chain (minus the asterisk
 *      step) hides — byte-identical tag hiding.
 */
import { describe, it, expect } from "vitest";
import { stripTags, stripPartialActionTag, stripInternalTags } from "../index";

const norm = (s: string): string => s.replace(/\n{3,}/g, "\n\n").trim();

const MARKDOWN_CORPUS: readonly string[] = [
  "This is **bold** and *italic* and ***both***.\n\nSecond paragraph with _underscore_.",
  "Steps:\n\n1. First\n   - nested *one*\n     - deeper **two**\n2. Second\n\n- bullet\n  * star bullet\n  * another",
  'Use this:\n\n```python\nx = a * b * c\nprint(f"{x}**2")\n```\n\nInline `a*b*c` too.',
  "2*3*4 = 24 and 5 * 6 = 30, plus 2**10 and a*b.",
  "| Name | Value |\n|------|-------|\n| **a** | *1* |\n| b | 2 |",
  "# Title\n\n## Sub *emphasis*\n\nBody text.\n\n### Third",
  "> quoted *text*\n> more **bold**\n\nAfter the quote.",
  "Indented code:\n\n    four  spaces   kept\n    *not emphasis*\n\nEnd.",
  "Line one\n\n\n\nLine after many blank lines.",
  "Ends with a lone star *",
];

// Byte copies of origin/main's tag regexes, in main's order, with the
// asterisk step and the post-asterisk whitespace collapse removed.
function mainStripTagsChain(text: string): string {
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

function mainInternalTagsChain(text: string): string {
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

// Deterministic PRNG so the generated corpus is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAG_BLOCKS: readonly string[] = [
  '<memory confidence="0.9" sensitivity="none">User likes *tea*</memory>',
  "<thinking>plan: **step** one\nthen two</thinking>",
  '<state field="curiosity" value="0.8"/>',
  "<narration>Reading the file</narration>",
  "<narration >spaced *opener*</narration >",
  '[EXTERNAL_DATA source="web"]fetched **content**[/EXTERNAL_DATA]',
  "[MEMORY_DATA]recalled *fact*[/MEMORY_DATA]",
  '[EXTERNAL_DATA source="x"]',
  "[/EXTERNAL_DATA]",
  "[MEMORY_DATA]",
  "[/MEMORY_DATA]",
];

const PROSE: readonly string[] = [
  "Hello",
  " there ",
  "**bold**",
  " *italic* ",
  "\n\n",
  "\n- item\n",
  "2*3*4",
  "  ",
  "\n\n\n",
];

function generateTagCorpus(n: number, seed = 0x5eed): string[] {
  const rand = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const parts: string[] = [];
    const len = 1 + Math.floor(rand() * 8);
    for (let j = 0; j < len; j++) parts.push(rand() < 0.5 ? pick(TAG_BLOCKS) : pick(PROSE));
    out.push(parts.join(""));
  }
  return out;
}

describe("display strip preserves markdown", () => {
  for (const [i, md] of MARKDOWN_CORPUS.entries()) {
    it(`stripTags byte-preserves corpus[${i}]`, () => {
      expect(stripTags(md)).toBe(norm(md));
    });

    it(`stripPartialActionTag byte-preserves corpus[${i}] at every streaming prefix`, () => {
      for (let k = 0; k <= md.length; k++) {
        const prefix = md.slice(0, k);
        expect(stripPartialActionTag(prefix)).toBe(norm(prefix));
      }
    });

    it(`stripInternalTags leaves corpus[${i}] untouched`, () => {
      expect(stripInternalTags(md)).toBe(md);
    });
  }
});

describe("display strip hides exactly what main's tag chain hides", () => {
  const corpus = generateTagCorpus(500);

  it("stripTags === norm(main tag chain) on the generated corpus", () => {
    for (const s of corpus) expect(stripTags(s)).toBe(norm(mainStripTagsChain(s)));
  });

  it("stripPartialActionTag === norm(main internal-tag chain) on the generated corpus", () => {
    for (const s of corpus) expect(stripPartialActionTag(s)).toBe(norm(mainInternalTagsChain(s)));
  });

  it("every generated input still contains no visible closed internal tag", () => {
    for (const s of corpus) {
      const shown = stripTags(s);
      expect(shown).not.toMatch(/<memory|<thinking|<state|<narration|EXTERNAL_DATA|MEMORY_DATA/);
    }
  });
});

describe("accepted cost: unclosed internal block inside asterisks", () => {
  it("is no longer incidentally hidden — same as an unclosed block without asterisks", () => {
    // Main deleted `*...*` spans, so an unclosed block that happened to sit
    // inside asterisks vanished. Main already showed the same unclosed
    // block without asterisks; the two cases now agree.
    const withStars = "Hi *<thinking>unclosed plan* there";
    const withoutStars = "Hi <thinking>unclosed plan there";
    expect(stripTags(withStars)).toBe(withStars);
    expect(stripTags(withoutStars)).toBe(withoutStars);
  });
});
