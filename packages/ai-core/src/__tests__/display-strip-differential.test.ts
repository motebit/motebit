/**
 * Differential harness for the display strip: a generated corpus of
 * internal tags (and look-alikes) in every markdown placement, REAL vs
 * MENTIONED, checked against origin/main's functions as an oracle.
 *
 * Measured regression (twice, same class): an unclosed-block rule deleted
 * everything after an opener with no closer even when the tag was only
 * MENTIONED — "Claude can reason in a `<thinking>` block before answering.
 * **Tips:** …" displayed as "Claude can reason in a `". Round 1 was the same
 * truncation via `<memory-card>`. Hand-picked cases missed both, so the
 * corpus here is the cross product, not examples.
 *
 * Invariants, for every display function (`stripTags`, `stripInternalTags`,
 * `stripPartialActionTag`):
 *   1. Text outside a REAL internal block is preserved byte-exact.
 *   2. Never less non-internal content than origin/main's counterpart (and
 *      than main's `stripInternalTags`) for the same input.
 *   3. Real internal blocks are removed.
 * And for the live stream, at every prefix: the streaming frame is a prefix
 * of the final display (so the accumulated stream equals the final strip),
 * and no internal payload is ever shown transiently unless main showed it.
 * The live frame is `stripTagsLive` (the runtime's stream); the surface
 * functions must also leave the runtime's yielded text unchanged.
 */
import { describe, expect, it } from "vitest";
import { stripInternalTags, stripPartialActionTag, stripTags, stripTagsLive } from "../core.js";
import {
  mainStripInternalTags,
  mainStripPartialActionTag,
  mainStripTags,
} from "./fixtures/main-display-strip.js";

interface Tag {
  name: string;
  /** A real, well-formed internal block (or a look-alike's closed form). */
  closed: string;
  /** The opener alone — a mention, or a block whose closer never came. */
  unclosed: string;
  /** True for motebit's internal markup; false for look-alikes. */
  internal: boolean;
  /** A lone marker is internal markup even unclosed (main removed it too). */
  loneIsInternal?: boolean;
}

const SECRET = "SECRET";

const TAGS: Tag[] = [
  {
    name: "thinking",
    closed: `<thinking>${SECRET} plan the answer</thinking>`,
    unclosed: "<thinking>",
    internal: true,
  },
  {
    name: "memory",
    closed: `<memory confidence="0.9" sensitivity="none">${SECRET} likes tea</memory>`,
    unclosed: '<memory confidence="0.9">',
    internal: true,
  },
  { name: "state", closed: '<state attention="0.7"/>', unclosed: "<state>", internal: true },
  {
    name: "narration",
    closed: `<narration>${SECRET} checking npm</narration>`,
    unclosed: "<narration>",
    internal: true,
  },
  {
    name: "MEMORY_DATA",
    closed: `[MEMORY_DATA]${SECRET} recalled[/MEMORY_DATA]`,
    unclosed: "[MEMORY_DATA]",
    internal: true,
    loneIsInternal: true,
  },
  {
    name: "EXTERNAL_DATA",
    closed: `[EXTERNAL_DATA source="web"]${SECRET} payload[/EXTERNAL_DATA]`,
    unclosed: '[EXTERNAL_DATA source="web"]',
    internal: true,
    loneIsInternal: true,
  },
  {
    name: "memory-card",
    closed: "<memory-card>hi</memory-card>",
    unclosed: "<memory-card>",
    internal: false,
  },
  {
    name: "thinking-mode",
    closed: "<thinking-mode>on</thinking-mode>",
    unclosed: "<thinking-mode>",
    internal: false,
  },
  {
    name: "state-machine",
    closed: "<state-machine/>",
    unclosed: "<state-machine>",
    internal: false,
  },
  { name: "memory_x", closed: "<memory_x>v</memory_x>", unclosed: "<memory_x>", internal: false },
];

interface Placement {
  name: string;
  /** `{X}` is the slot. */
  template: string;
  /** The display when the slot is removed (only for prose placements). */
  removed?: string;
  /** Fenced code: the slot is always a mention. */
  code?: boolean;
  /**
   * Inline code: opaque only to a mention. A real closed pair or self-closing
   * tag is removed even here (inline code never shields real markup).
   */
  inline?: boolean;
}

const PLACEMENTS: Placement[] = [
  {
    name: "prose",
    template: "Here is the plan. {X} Then **bold** text.\n\n1. Keep it short",
    removed: "Here is the plan. Then **bold** text.\n\n1. Keep it short",
  },
  {
    name: "inline code span",
    template: "Claude can reason in a `{X}` block before answering. **Tips:**\n\n1. Keep it short",
    removed: "Claude can reason in a `` block before answering. **Tips:**\n\n1. Keep it short",
    inline: true,
  },
  {
    name: "double-backtick code span",
    template: "Write ``{X}`` literally, then *italic* and **bold**.",
    removed: "Write ```` literally, then *italic* and **bold**.",
    inline: true,
  },
  {
    name: "fenced code block",
    template: "Example:\n\n```\n{X}\n```\n\nDone **now**.",
    code: true,
  },
  {
    name: "fenced code block with attributes",
    template: '```xml title="example.xml"\n<root>\n  {X}\n</root>\n```\nAfter **this**.',
    code: true,
  },
  {
    name: "list item",
    template: "- first\n- {X}second **item**\n- third",
    removed: "- first\n- second **item**\n- third",
  },
  {
    name: "table cell",
    template: "| a | b |\n|---|---|\n| {X}x | `y*z` |\n| 1 | 2 |",
    removed: "| a | b |\n|---|---|\n| x | `y*z` |\n| 1 | 2 |",
  },
  {
    name: "blockquote",
    template: "> {X}quoted **line**\n> second line\n\nAfter.",
    removed: "> quoted **line**\n> second line\n\nAfter.",
  },
  {
    name: "heading",
    template: "## {X}Title **bold**\n\nBody text.",
    removed: "## Title **bold**\n\nBody text.",
  },
  {
    name: "end of text",
    template: "Final answer **42**. {X}",
    removed: "Final answer **42**.",
  },
  {
    name: "mention in code then real in prose",
    template: "Use `<thinking>` tags. {X} Answer **ok**.",
    removed: "Use `<thinking>` tags. Answer **ok**.",
  },
];

interface Case {
  id: string;
  input: string;
  /** What every final display function must return. */
  expected: string;
  /** The real internal markup in `input` (removed), if any. */
  real?: string;
}

function buildCorpus(): Case[] {
  const cases: Case[] = [];
  for (const tag of TAGS) {
    for (const p of PLACEMENTS) {
      for (const form of ["closed", "unclosed"] as const) {
        const x = form === "closed" ? tag.closed : tag.unclosed;
        const input = p.template.replace("{X}", x);
        const isReal =
          !p.code &&
          tag.internal &&
          (form === "closed" || (tag.loneIsInternal === true && !p.inline));
        const kind = isReal ? "real" : "mentioned";
        let expected = isReal ? p.removed! : input;
        // The mentioned `<thinking>` and the real block's closer form a real
        // closed pair; inline code does not shield it, so the cut starts at
        // the mention (hide when ambiguous).
        if (isReal && p.name === "mention in code then real in prose" && tag.name === "thinking")
          expected = "Use ` Answer **ok**.";
        cases.push({
          id: `${tag.name} × ${p.name} × ${form} (${kind})`,
          input,
          expected,
          real: isReal ? x : undefined,
        });
      }
    }
  }
  // The round-2 repros verbatim.
  const repro = (id: string, input: string) => cases.push({ id, input, expected: input });
  repro(
    "repro: `<thinking>` mentioned in prose code",
    "Claude can reason in a `<thinking>` block before answering. **Tips:**\n\n1. Keep it short",
  );
  repro(
    "repro: `<parameter>` mentioned",
    'Pass `<parameter name="x">` to the tool.\n\n- then **this**',
  );
  repro("repro: bare <narration> mention", "The <narration> tag carries step chrome. **Note:** ok");
  repro(
    "repro: fenced xml memory example",
    '```xml\n<memory confidence="0.9">likes tea</memory>\n```\n\nThat is the **format**.',
  );
  repro("repro: unclosed <parameter> in prose", 'Use <parameter name="x"> then **bold**.');
  return cases;
}

const CORPUS = buildCorpus();

interface Leak {
  id: string;
  input: string;
  /** stripTags of `input`. */
  expected: string;
}

/**
 * Real internal markup that reached the display through the real runtime
 * path at b3ab40b26 (and was hidden on main).
 *   1. An unclosed block at the start of a line — a turn cut off mid-
 *      thinking (token limit) — was kept as a "mention".
 *   2. A stray backtick before a real block containing a backtick paired
 *      with that inner backtick across lines, so the block read as inline
 *      code and was shown.
 */
const LEAKS: Leak[] = [
  {
    id: "repro: unclosed thinking at end of turn",
    input: "Here is my answer **bold**.\n\n<thinking>SECRET unclosed",
    expected: "Here is my answer **bold**.",
  },
  {
    id: "unclosed memory at line start",
    input: 'Noted.\n<memory confidence="0.9" sensitivity="personal">SECRET user is',
    expected: "Noted.",
  },
  {
    id: "unclosed state at line start, end of turn",
    input: 'All set.\n<state curiosity="SECRET',
    expected: "All set.",
  },
  {
    id: "unclosed thinking at start of text",
    input: "<thinking>SECRET planning **the** answer",
    expected: "",
  },
  {
    id: "unclosed thinking on an indented line",
    input: "Ok **done**.\n  <thinking>SECRET more",
    expected: "Ok **done**.",
  },
  {
    id: "unclosed thinking after removed markup on its line",
    input: 'Hi.\n<state attention="0.7"/><thinking>SECRET',
    expected: "Hi.",
  },
  {
    id: "unclosed MEMORY_DATA at line start",
    input: "Recall:\n[MEMORY_DATA]SECRET recalled fact",
    expected: "Recall:",
  },
  {
    id: "repro: stray backtick before a real block with a backtick",
    input: "Press the ` key.\n<thinking>I should mention `ls` SECRET</thinking>\nThen run it.",
    expected: "Press the ` key.\n\nThen run it.",
  },
  {
    id: "stray backtick before a real memory block",
    input: 'Press the ` key.\n<memory confidence="0.9">SECRET uses `zsh`</memory>\nDone **ok**.',
    expected: "Press the ` key.\n\nDone **ok**.",
  },
  {
    id: "stray backtick before a real state tag",
    input: 'Press the ` key.\n<state curiosity="SECRET"/>Then `ls` it.',
    expected: "Press the ` key.\nThen `ls` it.",
  },
  {
    id: "stray backtick before an unclosed block",
    input: "Press the ` key.\n<thinking>SECRET `ls",
    expected: "Press the ` key.",
  },
  {
    id: "real block after a closed inline code span on the same line",
    input: "Run `ls` then <thinking>SECRET `x`</thinking> done **now**.",
    expected: "Run `ls` then done **now**.",
  },
  {
    id: "real block after a double-backtick span",
    input: "Use ``a`b`` then <thinking>SECRET</thinking> ok.",
    expected: "Use ``a`b`` then ok.",
  },
  {
    id: "stray double backtick before a real block",
    input: "Press `` twice.\n<thinking>SECRET ``x``</thinking>\nDone.",
    expected: "Press `` twice.\n\nDone.",
  },
  {
    id: "CRLF: unclosed thinking at end of turn",
    input: "Answer **ok**.\r\n<thinking>SECRET unclosed",
    expected: "Answer **ok**.",
  },
  {
    id: "CRLF: stray backtick before a real block",
    input: "Press ` key.\r\n<thinking>`ls` SECRET</thinking>\r\nThen.",
    expected: "Press ` key.\r\n\r\nThen.",
  },
  // Round 5: a stray backtick paired with a backtick inside a real block on
  // the SAME line, so the block read as inline code and was shown (hidden on
  // main). Rule: inline code never shields a real closed pair, a real
  // self-closing tag or a data block; only fences are opaque.
  {
    id: "repro: stray backtick pairs with a backtick at the block's end",
    input: "Use the ` key. <thinking>SECRET user means `</thinking> Done.",
    expected: "Use the ` key. Done.",
  },
  {
    id: "repro: stray backtick pairs with an inner code span",
    input: "It's 5` long. <thinking>SECRET maybe use `ls`</thinking> Use ls.",
    expected: "It's 5` long. Use ls.",
  },
  {
    id: "repro: stray backtick shields a state tag",
    input: 'Press ` then go. <state curiosity="SECRET"/> ok `x` ',
    expected: "Press ` then go. ok `x`",
  },
  {
    id: "repro: stray backtick shields a memory block",
    input: 'Press ` then <memory type="f">SECRET `name`</memory> ok',
    expected: "Press ` then ok",
  },
  {
    id: "same line: stray double backtick before a real block",
    input: "Hit `` here. <thinking>SECRET use ``x``</thinking> Done.",
    expected: "Hit `` here. Done.",
  },
  {
    id: "same line: backtick inside the block only",
    input: "Plain. <thinking>SECRET ` stray</thinking> after `code` end.",
    expected: "Plain. after `code` end.",
  },
  {
    id: "same line: backtick after the block only",
    input: "Before <thinking>SECRET</thinking> then ` stray.",
    expected: "Before then ` stray.",
  },
  {
    id: "same line: several real blocks between stray backticks",
    input:
      'A ` b <thinking>SECRET `</thinking> c ` d <memory type="f">SECRET `</memory> e ` f <state x="SECRET"/> g',
    expected: "A ` b c ` d e ` f g",
  },
  {
    id: "same line: data block shielded by a stray backtick",
    input: "See ` here [MEMORY_DATA]SECRET `x`[/MEMORY_DATA] done.",
    expected: "See ` here done.",
  },
  {
    id: "accepted: a closed pair quoted in one inline code span is hidden",
    input: "`<thinking>SECRET</thinking>` is the syntax.",
    expected: "`` is the syntax.",
  },
];

/** Mentions that stay verbatim under the leak fix (rule: mid-line, or code). */
const KEPT_MENTIONS = [
  "Use <thinking> tags for **reasoning**.",
  "- <thinking> opens a block\n- then **more**",
  "`<thinking>` opens a block. **Note:** ok",
  "Use `<thinking>` alone to open a block.",
  'Example:\n\n```\n<thinking>\n```\n\n~~~~\n<memory a="1">\n~~~~\nDone.',
];

/** Non-whitespace characters, for the "never less content than main" check. */
const dense = (s: string) => s.replace(/\s+/g, "");

function isSubsequence(needle: string, hay: string): boolean {
  let j = 0;
  for (let i = 0; i < hay.length && j < needle.length; i++) if (hay[i] === needle[j]) j++;
  return j === needle.length;
}

const FUNCTIONS = [
  { name: "stripTags", fn: stripTags, main: mainStripTags },
  { name: "stripInternalTags", fn: stripInternalTags, main: mainStripInternalTags },
  { name: "stripPartialActionTag", fn: stripPartialActionTag, main: mainStripPartialActionTag },
];

/** Main's output minus the real internal markup main failed to remove. */
function mainNonInternal(out: string, real: string | undefined): string {
  return real ? out.split(real).join("") : out;
}

describe("display strip differential corpus", () => {
  it("corpus covers every tag × placement × form", () => {
    expect(CORPUS.length).toBe(TAGS.length * PLACEMENTS.length * 2 + 5);
  });

  for (const { name, fn, main } of FUNCTIONS) {
    describe(name, () => {
      for (const c of CORPUS) {
        it(c.id, () => {
          const out = fn(c.input);
          // 1 + 3: byte-exact outside real blocks; real blocks removed.
          expect(out).toBe(c.expected);
          if (c.real) expect(out).not.toContain(SECRET);
          // 2: never less non-internal content than main.
          for (const oracle of [main, mainStripInternalTags]) {
            const ref = dense(mainNonInternal(oracle(c.input), c.real));
            expect(isSubsequence(ref, dense(out))).toBe(true);
          }
        });
      }
    });
  }

  // Round-4 leaks: REAL internal markup shown on every display path.
  // The invariant here is absolute — no SECRET from a real block ever
  // appears in a final display or in any live-stream frame.
  describe("real internal markup never leaks", () => {
    for (const c of LEAKS) {
      it(c.id, () => {
        expect(stripTags(c.input)).toBe(c.expected);
        for (const { fn } of FUNCTIONS) expect(fn(c.input)).not.toContain(SECRET);
        const final = stripTags(c.input);
        for (let k = 0; k <= c.input.length; k++) {
          const prefix = c.input.slice(0, k);
          const frame = stripTagsLive(prefix);
          expect(frame, `prefix ${k}`).not.toContain(SECRET);
          expect(final.startsWith(frame), `prefix ${k}: ${JSON.stringify(frame)}`).toBe(true);
          expect(stripPartialActionTag(frame), `prefix ${k}`).not.toContain(SECRET);
          // A surface stripping a raw stream itself: no leak beyond main's.
          if (mainStripInternalTags(prefix).includes(SECRET)) continue;
          for (const fn of [stripPartialActionTag, stripInternalTags]) {
            expect(fn(prefix), `prefix ${k}`).not.toContain(SECRET);
          }
        }
      });
    }
  });

  describe("mentions the leak fix must keep", () => {
    for (const c of KEPT_MENTIONS) {
      it(c, () => {
        for (const { fn } of FUNCTIONS) {
          if (fn === stripTags || fn === stripInternalTags) expect(fn(c)).toBe(c);
        }
        for (let k = 0; k <= c.length; k++) {
          expect(c.startsWith(stripTagsLive(c.slice(0, k))), `prefix ${k}`).toBe(true);
        }
      });
    }
  });

  it("live stream: every prefix of 3000 seeded random token mixes", () => {
    // Token soup: backticks, fences, internal tags (paired, lone, partial),
    // markers, action cues, markdown — the arrangements no table lists.
    const TOKENS = [
      "`",
      "``",
      "```\n",
      "~~~\n",
      "\n",
      "\n\n",
      "<thinking>",
      "</thinking>",
      '<memory a="1">',
      "</memory>",
      "[MEMORY_DATA]",
      "[/MEMORY_DATA]",
      '[EXTERNAL_DATA s="w"]',
      "[/EXTERNAL_DATA]",
      '<state x="1"/>',
      "<narration>",
      "</narration>",
      '<parameter name="x">',
      "</parameter>",
      "<invoke>",
      "<sta",
      "<",
      "word ",
      "  ",
      "*smiles* ",
      "**b** ",
      "*",
      "- ",
      "> ",
      "| ",
    ];
    let seed = 0x5eed;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    for (let n = 0; n < 3000; n++) {
      let input = "";
      for (let t = 3 + Math.floor(rand() * 12); t > 0; t--) {
        input += TOKENS[Math.floor(rand() * TOKENS.length)];
      }
      const final = stripTags(input);
      for (let k = 0; k <= input.length; k++) {
        const frame = stripTagsLive(input.slice(0, k));
        expect(final.startsWith(frame), JSON.stringify({ input, k, frame })).toBe(true);
      }
    }
  });

  describe("live stream: every prefix", () => {
    for (const c of CORPUS) {
      it(c.id, () => {
        const final = stripTags(c.input);
        for (let k = 0; k <= c.input.length; k++) {
          const prefix = c.input.slice(0, k);
          const frame = stripTagsLive(prefix);
          // Every frame extends to the final display, so the accumulated
          // stream (deltas of frames) equals the final strip.
          expect(final.startsWith(frame), `prefix ${k}: ${JSON.stringify(frame)}`).toBe(true);
          // Desktop / mobile re-strip the runtime's yielded text each chunk.
          expect(final.startsWith(stripPartialActionTag(frame)), `prefix ${k}`).toBe(true);
          if (c.real) {
            expect(frame, `prefix ${k}`).not.toContain(SECRET);
            // A surface stripping a raw stream itself: no leak beyond main's
            // `stripInternalTags` (main's `stripPartialActionTag` hid some of
            // these only by deleting everything after any `*`).
            if (mainStripInternalTags(prefix).includes(SECRET)) continue;
            for (const fn of [stripPartialActionTag, stripInternalTags]) {
              expect(fn(prefix), `prefix ${k}`).not.toContain(SECRET);
            }
          }
        }
        // Surfaces re-strip the finished answer; it must be a fixed point.
        expect(stripPartialActionTag(final)).toBe(final);
        expect(stripInternalTags(final)).toBe(final);
      });
    }
  });
});
