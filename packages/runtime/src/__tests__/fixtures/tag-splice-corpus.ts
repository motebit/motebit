/**
 * Tag-splice corpus — generated inputs where internal tags sit inside
 * other tags' names, split `_DATA` markers, nest, and repeat, mixed with
 * markdown and action cues. Mirrors ai-core's copy
 * (`packages/ai-core/src/__tests__/fixtures/tag-splice-corpus.ts`).
 *
 * origin/main hides tags by applying its regexes in sequence, each replaced
 * with "", so one removal can splice the text around it into a new tag that
 * a later regex then hides. Display paths must reproduce that exactly.
 * Every internal block's content is a unique `SECRET<n>` token, so a leak
 * is a token that main hides and a display path shows.
 */

/** The two review repros: [input, main's display output]. */
export const SPLICE_REPROS: readonly (readonly [string, string])[] = [
  ['[MEMORY_<state a="1"/>DATA]secret[/MEMORY_DATA]', ""],
  ["[EXTERNAL_<thinking>x</thinking>DATA src=y]evil[/EXTERNAL_DATA] ok", "ok"],
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MARKDOWN = [
  "**bold**",
  "*italic*",
  "*nods*",
  "*smiles softly*",
  "`*x*`",
  "```\n*nods*\n```\n",
  "\n\n\n",
  "  \n",
  "\n",
  "- item\n",
  "- *smiles*\n",
  " ",
  "  ",
  "text",
  "a*b*c",
  "1. step\n",
  "> quote\n",
];

const LONE = [
  "[MEMORY_DATA]",
  "[/MEMORY_DATA]",
  "[EXTERNAL_DATA src=z]",
  "[/EXTERNAL_DATA]",
  "<thinking>",
  "</thinking>",
  '<memory confidence="0.5"',
  "<state",
  "<",
];

/** Generate `count` deterministic inputs from `seed`. */
export function generateSpliceCorpus(count: number, seed = 0x5eed): string[] {
  const rand = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  let n = 0;
  const secret = (): string => `SECRET${n++}`;

  // [opener, closer] pairs; the secret goes between them.
  const blocks = (): Array<[string, string]> => [
    ["<thinking>", "</thinking>"],
    ['<memory confidence="0.9" sensitivity="none">', "</memory>"],
    ["<narration>", "</narration>"],
    ["[MEMORY_DATA]", "[/MEMORY_DATA]"],
    ['[EXTERNAL_DATA source="web"]', "[/EXTERNAL_DATA]"],
    ['<parameter name="q">', "</parameter>"],
  ];

  /** A self-contained tag that hides cleanly on its own. */
  const inner = (depth: number): string => {
    const r = rand();
    if (r < 0.3) return `<state field="curiosity" value="0.${Math.floor(rand() * 9)}"/>`;
    if (r < 0.4) return pick(["[MEMORY_DATA]", "[/MEMORY_DATA]", "[/EXTERNAL_DATA]"]);
    return block(depth + 1);
  };

  /** Split `s` at a random interior point and insert a tag there. */
  const splice = (s: string, depth: number): string => {
    if (s.length < 2 || depth > 2) return s;
    const at = 1 + Math.floor(rand() * (s.length - 1));
    return s.slice(0, at) + inner(depth) + s.slice(at);
  };

  const block = (depth: number): string => {
    const [open, close] = pick(blocks());
    let o = open;
    let c = close;
    if (rand() < 0.5) o = splice(o, depth);
    if (rand() < 0.4) c = splice(c, depth);
    let body = secret();
    if (rand() < 0.25 && depth < 2) body += block(depth + 1) + secret();
    return o + body + c;
  };

  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const parts: string[] = [];
    const len = 1 + Math.floor(rand() * 10);
    for (let k = 0; k < len; k++) {
      const r = rand();
      if (r < 0.45) parts.push(block(0));
      else if (r < 0.55) parts.push(pick(LONE));
      else parts.push(pick(MARKDOWN));
    }
    out.push(parts.join(""));
  }
  return out;
}

/** Every `SECRET<n>` token in `text`. */
export function secretsIn(text: string): string[] {
  return [...text.matchAll(/SECRET\d+/g)].map((m) => m[0]);
}
