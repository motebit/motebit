/**
 * Display fuzz corpus — seeded, deterministic inputs for the differential
 * display harness (`display-fuzz.test.ts`): closed and UNCLOSED internal
 * blocks (incl. spliced openers), asterisks around and inside tags,
 * cue-only bullets, `<` that never becomes a tag, CRLF, code fences, and
 * unicode. Every closed block's content is a unique `SECRET<n>` token;
 * text after an unclosed opener is a unique `SECRETU<n>` token — a leak is
 * a token shown by a display path.
 *
 * Origin/main's display functions are reproduced verbatim below as the
 * differential baseline (copied from origin/main at 67574f954).
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every `SECRET<n>` / `SECRETU<n>` token in `text`. */
export function secretsIn(text: string): string[] {
  return [...text.matchAll(/SECRETU?\d+/g)].map((m) => m[0]);
}

/** Every unclosed-block token (`SECRETU<n>`) in `text`. */
export function unclosedSecretsIn(text: string): string[] {
  return [...text.matchAll(/SECRETU\d+/g)].map((m) => m[0]);
}

const BLOCKS: ReadonlyArray<readonly [string, string]> = [
  ["<thinking>", "</thinking>"],
  ['<memory confidence="0.9" sensitivity="none">', "</memory>"],
  ["<narration>", "</narration>"],
  ["[MEMORY_DATA]", "[/MEMORY_DATA]"],
  ['[EXTERNAL_DATA source="web"]', "[/EXTERNAL_DATA]"],
  ['<parameter name="q">', "</parameter>"],
];

/** Openers left unclosed: everything after them is internal. */
const UNCLOSED_OPENERS: readonly string[] = [
  "<thinking>",
  '<memory confidence="0.9" sensitivity="none">',
  '<memory confidence="0.5"',
  "<narration>",
  '<parameter name="q">',
  "[MEMORY_DATA]",
  '[EXTERNAL_DATA source="w"]',
];

const MARKDOWN: readonly string[] = [
  "**bold**",
  "*italic phrase*",
  "***both***",
  "`*x*`",
  "```\n*nods*\n```\n",
  "```js\nconst a = b < c;\n```\n",
  "~~~\n<thinking> in a fence\n~~~\n",
  "\n\n\n",
  "  \n",
  "\n",
  "\r\n",
  "- item\n",
  "* star item\n",
  "1. step\n",
  "> quote\n",
  "| a | b |\n| --- | --- |\n",
  " ",
  "text",
  "a*b*c",
  "Footnote*",
  "if x < y then",
  "a<b",
  "<3",
  "< ",
  "é ünïcödé",
  "日本語のテキスト",
  "🚀✨",
  "​",
  "[link](https://e.com/a*b)",
  "[not a marker]",
];

const CUES: readonly string[] = [
  "*nods*",
  "*smiles softly*",
  "*tilts head*",
  "- *nods*\n",
  "- *smiles*",
  "* *nods*\n",
  "1. *glows softly*\n",
  "Sure.\n- *nods*",
];

const LONE: readonly string[] = [
  "[MEMORY_DATA]",
  "[/MEMORY_DATA]",
  "[EXTERNAL_DATA src=z]",
  "[/EXTERNAL_DATA]",
  "</thinking>",
  "</memory>",
  "<state",
  '<state field="x" value="0.1"/>',
  "<",
  "*",
  "**",
];

/**
 * Generate `count` deterministic tagged inputs from `seed`. Each input is
 * a concatenation of closed blocks (optionally spliced), unclosed openers,
 * markdown, cues, lone fragments, and asterisks around/inside tags.
 */
export function generateFuzzCorpus(count: number, seed = 0xd15e): string[] {
  const rand = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  let n = 0;

  const inner = (depth: number): string => {
    const r = rand();
    if (r < 0.3) return `<state field="curiosity" value="0.${Math.floor(rand() * 9)}"/>`;
    if (r < 0.4) return pick(["[MEMORY_DATA]", "[/MEMORY_DATA]", "[/EXTERNAL_DATA]"]);
    return block(depth + 1);
  };

  const splice = (s: string, depth: number): string => {
    if (s.length < 2 || depth > 2) return s;
    const at = 1 + Math.floor(rand() * (s.length - 1));
    return s.slice(0, at) + inner(depth) + s.slice(at);
  };

  const block = (depth: number): string => {
    const [open, close] = pick(BLOCKS);
    let o = open;
    let c = close;
    if (rand() < 0.3) o = splice(o, depth);
    if (rand() < 0.3) c = splice(c, depth);
    let body = `SECRET${n++}`;
    if (rand() < 0.15) body = `*${body}*`;
    if (rand() < 0.2 && depth < 2) body += block(depth + 1) + `SECRET${n++}`;
    return o + body + c;
  };

  const unclosed = (): string => {
    let o = pick(UNCLOSED_OPENERS);
    const r = rand();
    if (r < 0.25) o = `*${o}`;
    else if (r < 0.4) o = `**${o}`;
    let body = `SECRETU${n++}`;
    if (rand() < 0.3) body += "*";
    if (rand() < 0.3) body += pick([" more", "\n- item", " *nods*", "\r\nline"]);
    return o + body;
  };

  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const parts: string[] = [];
    const len = 1 + Math.floor(rand() * 8);
    for (let k = 0; k < len; k++) {
      const r = rand();
      let part: string;
      if (r < 0.3) part = block(0);
      else if (r < 0.42) part = unclosed();
      else if (r < 0.52) part = pick(LONE);
      else if (r < 0.62) part = pick(CUES);
      else part = pick(MARKDOWN);
      if (rand() < 0.08) part = `*${part}*`;
      parts.push(part);
    }
    out.push(parts.join(""));
  }
  return out;
}

const PLAIN_MARKDOWN: readonly string[] = MARKDOWN.filter((m) => !m.includes("<thinking>"));

/**
 * Generate `count` markdown-only inputs: no internal tags, no action cues.
 * Every display path must return these byte-for-byte (modulo trim).
 */
export function generateMarkdownCorpus(count: number, seed = 0x3d3d): string[] {
  const rand = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const parts: string[] = [];
    const len = 1 + Math.floor(rand() * 8);
    for (let k = 0; k < len; k++) parts.push(pick(PLAIN_MARKDOWN));
    out.push(parts.join(""));
  }
  return out;
}

/** Split `text` into 1–5 random pieces. */
export function randomSplit(text: string, rand: () => number): string[] {
  const cuts = new Set<number>();
  const k = Math.floor(rand() * 5);
  for (let i = 0; i < k && text.length > 1; i++)
    cuts.add(1 + Math.floor(rand() * (text.length - 1)));
  const sorted = [...cuts].sort((a, b) => a - b);
  const pieces: string[] = [];
  let prev = 0;
  for (const c of sorted) {
    pieces.push(text.slice(prev, c));
    prev = c;
  }
  pieces.push(text.slice(prev));
  return pieces;
}

// === origin/main baseline (verbatim) ===

/** origin/main `stripTags`. */
export function mainStripTags(text: string): string {
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
    .replace(/\[\/MEMORY_DATA\]/g, "")
    .replace(/\*[^*]+\*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** origin/main `stripInternalTags`. */
export function mainStripInternalTags(text: string): string {
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

/** origin/main `stripPartialActionTag`. */
export function mainStripPartialActionTag(text: string): string {
  return mainStripInternalTags(text)
    .replace(/\*[^*]+\*/g, "")
    .replace(/\*[^*]*$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** origin/main streaming.ts `stripDisplayTags`. */
function mainStripDisplayTags(text: string): { clean: string; pending: string } {
  const clean = text
    .replace(/<memory\s+[^>]*>[\s\S]*?<\/memory>/g, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .replace(/<narration>[\s\S]*?<\/narration>/g, "")
    .replace(/<state\s+[^>]*\/>/g, "")
    .replace(/<parameter\s+[^>]*>[\s\S]*?<\/parameter>/g, "")
    .replace(/<\/?(?:artifact|function_calls|invoke|antml)[^>]*>/g, "")
    .replace(/\[EXTERNAL_DATA[^\]]*\][\s\S]*?\[\/EXTERNAL_DATA\]/g, "")
    .replace(/\[MEMORY_DATA\][\s\S]*?\[\/MEMORY_DATA\]/g, "")
    .replace(/\[EXTERNAL_DATA[^\]]*\]/g, "")
    .replace(/\[\/EXTERNAL_DATA\]/g, "")
    .replace(/\[MEMORY_DATA\]/g, "")
    .replace(/\[\/MEMORY_DATA\]/g, "")
    .replace(/\*{1,3}/g, "")
    .replace(/ {2,}/g, " ");

  for (const tag of ["<memory", "<thinking", "<parameter", "<narration"]) {
    const lastOpen = clean.lastIndexOf(tag);
    if (lastOpen !== -1) {
      const closeTag = `</${tag.slice(1)}>`;
      const afterOpen = clean.slice(lastOpen);
      if (!afterOpen.includes(closeTag)) {
        return { clean: clean.slice(0, lastOpen), pending: clean.slice(lastOpen) };
      }
    }
  }

  const lastOpen = clean.lastIndexOf("<");
  if (lastOpen !== -1 && !clean.includes(">", lastOpen)) {
    return { clean: clean.slice(0, lastOpen), pending: clean.slice(lastOpen) };
  }
  return { clean, pending: "" };
}

/** origin/main's live stream: the concatenated text deltas for `pieces`. */
export function mainStream(pieces: readonly string[]): string {
  let accumulated = "";
  let yieldedCleanLength = 0;
  let out = "";
  for (const piece of pieces) {
    accumulated += piece;
    const clean = mainStripDisplayTags(accumulated).clean.trimStart();
    const delta = clean.slice(yieldedCleanLength);
    if (delta) {
      yieldedCleanLength += clean.slice(yieldedCleanLength).length;
      out += delta;
    }
  }
  return out;
}
