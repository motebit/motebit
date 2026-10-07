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
  /** Code placements: the slot is always a mention. */
  code?: boolean;
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
    code: true,
  },
  {
    name: "double-backtick code span",
    template: "Write ``{X}`` literally, then *italic* and **bold**.",
    code: true,
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
          !p.code && tag.internal && (form === "closed" || tag.loneIsInternal === true);
        const kind = isReal ? "real" : "mentioned";
        cases.push({
          id: `${tag.name} × ${p.name} × ${form} (${kind})`,
          input,
          expected: isReal ? p.removed! : input,
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
