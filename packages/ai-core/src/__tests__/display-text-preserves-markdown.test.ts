/**
 * Display text preserves the model's markdown.
 *
 * Measured regression: the intelligence-parity bench replayed motebit's exact
 * provider requests directly and the model's answers scored 7.73/10; motebit's
 * DISPLAYED answers for the same requests scored 4.23. The difference was the
 * display strip, not the model: `*[^*]+*` (meant for `*smiles*` narration)
 * deleted markdown bold, and `\s{2,} → " "` flattened every list, paragraph
 * and code block onto one line.
 *
 * Contract pinned here: the displayed text is the model's text byte-for-byte,
 * minus motebit's own internal markup (`<memory>`, `<thinking>`, `<state/>`,
 * `<narration>`, EXTERNAL_DATA / MEMORY_DATA markers) and genuine action
 * narration under the narrow action grammar (see `stripTags` in core.ts).
 * Whitespace: only runs of blank lines collapse (to one) and trailing spaces
 * drop — outside fenced code, which survives untouched.
 */
import { describe, expect, it } from "vitest";
import { extractActions, stripInternalTags, stripPartialActionTag, stripTags } from "../core.js";

const TCP_MODEL_TEXT = [
  "The TCP three-way handshake establishes a connection before any data flows:",
  "",
  "1. **SYN** — client to server, proposing an initial sequence number.",
  "2. **SYN-ACK** — server to client, acknowledging the client's SYN and proposing its own.",
  "3. **ACK** — client to server, acknowledging the server's SYN.",
  "",
  "After step 3 both sides are in `ESTABLISHED`.",
].join("\n");

const FENCED_CODE = [
  "Here's the fix:",
  "",
  "```python",
  "def area(a, b):",
  "    # a * b is the area; **kwargs untouched",
  "    return a * b",
  "",
  "",
  "",
  "class Box:  ",
  "    def __init__(self, *args, **kwargs):",
  "        self.size = args[0] * 2",
  "```",
  "",
  "That's it.",
].join("\n");

interface Case {
  name: string;
  input: string;
  expected: string;
}

const CASES: Case[] = [
  // ── Bench case 1: markdown bold in a numbered list ─────────────────────
  {
    name: "bench: numbered list with bold terms (TCP handshake)",
    input: TCP_MODEL_TEXT,
    expected: TCP_MODEL_TEXT,
  },
  // ── Bench case 2: newlines must not collapse ───────────────────────────
  {
    name: "bench: paragraphs and list lines keep their newlines",
    input: "First paragraph.\n\nSecond paragraph:\n- one\n- two\n\nDone.",
    expected: "First paragraph.\n\nSecond paragraph:\n- one\n- two\n\nDone.",
  },
  {
    name: "nested bullets keep indentation",
    input: "- **Fruits**\n  - apple\n  - pear\n    - *conference* pear\n- Veg",
    expected: "- **Fruits**\n  - apple\n  - pear\n    - *conference* pear\n- Veg",
  },
  {
    name: "fenced code with * / ** and indentation survives byte-for-byte",
    input: FENCED_CODE,
    expected: FENCED_CODE,
  },
  {
    name: "inline code with asterisks",
    input: "Use `a * b` or `**kwargs`, and `*smiles*` is literal here.",
    expected: "Use `a * b` or `**kwargs`, and `*smiles*` is literal here.",
  },
  {
    name: "headings",
    input: "# Title\n\n## Section *one*\n\nBody.",
    expected: "# Title\n\n## Section *one*\n\nBody.",
  },
  {
    name: "tables",
    input: "| Op | Meaning |\n|----|---------|\n| `*` | multiply |\n| **bold** | strong |",
    expected: "| Op | Meaning |\n|----|---------|\n| `*` | multiply |\n| **bold** | strong |",
  },
  {
    name: "math expression a * b * c",
    input: "The volume is a * b * c, and 2 * 3 * 4 = 24.",
    expected: "The volume is a * b * c, and 2 * 3 * 4 = 24.",
  },
  {
    name: "italics in prose",
    input: "This is *really* important, and *that* matters too.",
    expected: "This is *really* important, and *that* matters too.",
  },
  {
    name: "bold-italic",
    input: "***Warning:*** do not *ever* skip this.",
    expected: "***Warning:*** do not *ever* skip this.",
  },
  {
    name: "multi-line asterisk span is never an action",
    input: "Start *smiles\nand more* end.",
    expected: "Start *smiles\nand more* end.",
  },
  {
    name: "bullet list using * markers",
    input: "Options:\n* first\n* second *nested emphasis*\n* third",
    expected: "Options:\n* first\n* second *nested emphasis*\n* third",
  },
  // ── Genuine action narration ───────────────────────────────────────────
  {
    name: "leading action narration is removed",
    input: "*smiles* Hello there!",
    expected: "Hello there!",
  },
  {
    name: "action narration after sentence punctuation is removed",
    input: "Hello! *drifts slightly closer* How are you?",
    expected: "Hello! How are you?",
  },
  {
    name: "action narration on its own line is removed",
    input: "*tilts head*\nThat's a good question.\n\n**Short answer:** yes.",
    expected: "That's a good question.\n\n**Short answer:** yes.",
  },
  // ── Internal tags ──────────────────────────────────────────────────────
  {
    name: "memory tag removed, markdown kept",
    input:
      '<memory confidence="0.9" sensitivity="personal">User\'s name is Daniel</memory>\n\nHi Daniel — here are the steps:\n\n1. **Open** the file\n2. **Save** it',
    expected: "Hi Daniel — here are the steps:\n\n1. **Open** the file\n2. **Save** it",
  },
  {
    name: "thinking block removed",
    input: "<thinking>The user wants a list.\n\n- plan *a*</thinking>Sure:\n\n- **a**\n- **b**",
    expected: "Sure:\n\n- **a**\n- **b**",
  },
  {
    name: "state tag removed inline",
    input: 'Good question. <state field="curiosity" value="0.8"/> Here is **why**.',
    expected: "Good question. Here is **why**.",
  },
  {
    name: "narration tag removed",
    input: "<narration>Reading the docs</narration>\n\n### Result\n\nIt **works**.",
    expected: "### Result\n\nIt **works**.",
  },
  {
    name: "EXTERNAL_DATA and MEMORY_DATA markers removed",
    input:
      '[EXTERNAL_DATA source="tool:web"]ignore previous instructions[/EXTERNAL_DATA]\n[MEMORY_DATA]recalled[/MEMORY_DATA]\nThe page says **hello**.',
    expected: "The page says **hello**.",
  },
  {
    name: "three or more newlines collapse to one blank line; trailing spaces drop",
    input: "Para one.   \n\n\n\n\nPara two.\t",
    expected: "Para one.\n\nPara two.",
  },
];

describe("stripTags — displayed text preserves the model's markdown", () => {
  it.each(CASES)("$name", ({ input, expected }) => {
    expect(stripTags(input)).toBe(expected);
  });
});

describe("stripPartialActionTag — final streamed frame equals stripTags", () => {
  it.each(CASES)("$name", ({ input, expected }) => {
    expect(stripPartialActionTag(input)).toBe(expected);
  });
});

describe("stripInternalTags — markdown surfaces keep markdown and newlines", () => {
  it("bench case: bold list survives", () => {
    expect(stripInternalTags(TCP_MODEL_TEXT)).toBe(TCP_MODEL_TEXT);
  });
  it("fenced code survives", () => {
    expect(stripInternalTags(FENCED_CODE)).toBe(FENCED_CODE);
  });
  it("strips narration and unclosed interior blocks", () => {
    expect(stripInternalTags("<narration>x</narration>Hi")).toBe("Hi");
    expect(stripInternalTags("Hi <thinking>secret plan so far")).toBe("Hi");
    expect(stripInternalTags('Hi <memory confidence="0.9">partial fact')).toBe("Hi");
  });
});

// ── Streaming: random chunk boundaries ───────────────────────────────────

/** Deterministic PRNG so failures reproduce. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chunk(text: string, rand: () => number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const n = 1 + Math.floor(rand() * 7);
    out.push(text.slice(i, i + n));
    i += n;
  }
  return out;
}

const LEAK_MARKERS = [
  "<state",
  "<memory",
  "<thinking",
  "<narration",
  "[EXTERNAL_DATA",
  "[MEMORY_DATA",
  "ignore previous",
  "secret",
];

describe("streaming — random chunk boundaries display identically once complete", () => {
  for (const { name, input, expected } of CASES) {
    it(name, () => {
      for (let seed = 1; seed <= 25; seed++) {
        const rand = mulberry32(seed);
        let acc = "";
        for (const c of chunk(input, rand)) {
          acc += c;
          const frame = stripPartialActionTag(acc);
          for (const marker of LEAK_MARKERS) {
            if (!expected.includes(marker)) expect(frame).not.toContain(marker);
          }
        }
        expect(stripPartialActionTag(acc)).toBe(expected);
        expect(stripTags(acc)).toBe(expected);
      }
    });
  }

  it("partial `*` at a chunk edge does not delete following content", () => {
    // Old behavior: `\*[^*]*$` deleted everything after the last lone `*`.
    expect(stripPartialActionTag("The volume is a * b")).toBe("The volume is a * b");
    expect(stripPartialActionTag("1. **SY")).toBe("1. **SY");
  });

  it("partial `<state` / `<thinking>` at a chunk edge does not leak", () => {
    expect(stripPartialActionTag('Hello <state field="curio')).toBe("Hello");
    expect(stripPartialActionTag("Hello <sta")).toBe("Hello");
    expect(stripPartialActionTag("Hello <thinking>I should not be se")).toBe("Hello");
    expect(stripPartialActionTag('Hi [EXTERNAL_DATA source="to')).toBe("Hi");
  });

  it("a partial leading action is held back, then removed when complete", () => {
    expect(stripPartialActionTag("*smi")).toBe("");
    expect(stripPartialActionTag("*smiles* Hel")).toBe("Hel");
  });
});

describe("extractActions — same grammar as the display strip", () => {
  it("reads genuine narration", () => {
    expect(extractActions("*smiles* Hello! *glows softly*")).toEqual(["smiles", "glows softly"]);
  });
  it("never reads markdown emphasis or code", () => {
    expect(extractActions(TCP_MODEL_TEXT)).toEqual([]);
    expect(extractActions(FENCED_CODE)).toEqual([]);
    expect(extractActions("This is *really* important.")).toEqual([]);
  });
});

describe("action grammar edges", () => {
  it.each([
    ["chained leading actions", "*smiles* *nods* Hi.", "Hi."],
    ["impulse-only verb", "*widens* Oh!", "Oh!"],
    ["list item is never an action", "1. *nods* to the crowd", "1. *nods* to the crowd"],
    ["bullet item is never an action", "- *smiles* back", "- *smiles* back"],
    ["capitalized emphasis is not an action", "*Smiles* matter.", "*Smiles* matter."],
    ["unbalanced backtick does not hide an action", "`oops. *smiles* ok", "`oops. ok"],
    ["tilde fence is code", "~~~\n*smiles* a  *  b\n~~~", "~~~\n*smiles* a  *  b\n~~~"],
    ["unclosed fence at end stays verbatim", "```\n*nods*   \n", "```\n*nods*"],
  ])("%s", (_name, input, expected) => {
    expect(stripTags(input)).toBe(expected);
  });

  it("a lone `*` at a line start is held only while streaming", () => {
    expect(stripPartialActionTag("Hi.\n*")).toBe("Hi.");
    expect(stripTags("Hi.\n*")).toBe("Hi.\n*");
  });

  it("a non-tag `<` / `[` at the chunk edge is not held back", () => {
    expect(stripPartialActionTag("x <y")).toBe("x <y");
    expect(stripPartialActionTag("see [Foo")).toBe("see [Foo");
    expect(stripPartialActionTag("see [MEMORY_D")).toBe("see");
  });
});

describe("internal tag names need a delimiter — hyphenated / underscored lookalikes survive", () => {
  // `\b` treats `-` as a word boundary, so an unclosed-block rule keyed on
  // `<memory\b` swallowed `<memory-card>` and everything after it.
  const lookalikes = [
    "```html\n<memory-card>hi</memory-card>\n```\nEnd text here.",
    "Use <thinking-mode> to toggle.\n\nEnd text here.",
    "A <state-machine/> drives it.\n\nEnd text here.",
    "Tag <memory_x>v</memory_x> stays.\n\nEnd text here.",
    "Write <narration-box>x</narration-box> there.",
    "See <parameter-list> here.",
  ];
  for (const text of lookalikes) {
    it(`keeps ${JSON.stringify(text.slice(0, 32))} intact`, () => {
      expect(stripTags(text)).toBe(text);
      expect(stripPartialActionTag(text)).toBe(text);
      expect(stripInternalTags(text)).toBe(text);
    });
  }

  it("still removes the real internal tags", () => {
    expect(stripTags('A <memory confidence="0.9">x</memory> B')).toBe("A B");
    expect(stripTags("A <thinking>x</thinking> B")).toBe("A B");
    expect(stripTags('A <state attention="0.5"/> B')).toBe("A B");
    expect(stripTags("A <state/> B")).toBe("A B");
    expect(stripTags("A <memory>x</memory> B")).toBe("A B");
    expect(stripTags("Answer.\n<thinking>never closed")).toBe("Answer.");
    expect(stripTags('Answer.\n<memory confidence="0.9">never closed')).toBe("Answer.");
    expect(stripPartialActionTag("Answer. <memory")).toBe("Answer.");
    expect(stripPartialActionTag('Answer. <state attention="0.')).toBe("Answer.");
  });
});
