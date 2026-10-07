/**
 * Display-parity corpus — real-shaped assistant answers carrying markdown,
 * internal tags, and action cues, for the live-stream parity test. Mirror
 * of `packages/ai-core/src/__tests__/fixtures/display-corpus.ts` (packages
 * may not import each other's tests); extend both together.
 *
 * `MARKDOWN_ANSWERS` contain no internal tags and no action cues: every
 * display path must return them byte-for-byte (modulo the whole-answer
 * trim). `TAGGED_ANSWERS` / `CUED_ANSWERS` pair an input with the exact
 * display output.
 */

export const MARKDOWN_ANSWERS: readonly string[] = [
  // bold, italic, bold-italic, nested lists, hard breaks
  "Here's the plan:\n\n1. **Install** the deps with `pnpm install`.\n2. Run *the* build:\n   - `pnpm build`\n   - then **`pnpm test`**\n3. ***Ship it***.\n\nLine one with a hard break  \nline two continues.",
  // headings, table, blockquote, emoji
  "## Summary\n\n| Option | Cost | Notes |\n| --- | ---: | --- |\n| A | $5 | *fast*, cheap |\n| B | $9 | **reliable** |\n\n> **Note:** prices change.\n> Check the *latest* sheet. 🚀\n\n### Next\n\nPick **A** unless you need *durability*.",
  // fenced code with asterisks, inline code with asterisks, indentation
  'Use a glob:\n\n```bash\nls *.ts **/*.md\nfor f in *; do\n    echo "$f"   # keep   spacing\ndone\n```\n\nIn Python `a*b*c` multiplies and `*args` unpacks:\n\n```python\ndef f(*args, **kwargs):\n    return 2 * 3 * 4\n\n\n# two blank lines above are preserved\n```',
  // a*b*c outside code, math-ish, stars in prose
  "The product a*b*c equals 24 when a=2, b=3, c=4. Rate: 5 * 3 = 15.\n\n* bullet using a star\n* another *emphasised* bullet\n\nFootnote*",
  // italic phrases that contain no lexicon cue + bold that does
  "That is *really* important. **Smiles all around** is the team motto, and *please do not* skip tests.\n\n- [ ] todo\n- [x] done",
  // mention of a cue-looking word inside code: never stripped
  "Call `*smiles*` in the template, or:\n\n```md\n*nods* — this is literal markdown\n```\n\nDone.",
  // multiple blank lines in prose (not caused by a tag) are preserved
  "First paragraph.\n\n\n\nSecond paragraph after three blank lines.\n\tTabbed line.",
  // nested emphasis and links
  "See [the **docs**](https://example.com/a*b) and _underscore italic_ plus __underscore bold__.\n\n1. One\n   1. One-a\n      - deep *ital*\n2. Two",
  // CRLF
  "Windows line one\r\nWindows **line** two\r\n\r\n- item\r\n",
  // single-word emphasis that is not a cue
  "*Note:* the cache is *not* cleared. *Important*: back up first.",
];

/** [input, exact display output] — internal tags only (no cues). */
export const TAGGED_ANSWERS: readonly (readonly [string, string])[] = [
  [
    '<thinking>plan the answer</thinking>**Bold** answer.\n\n- a\n  - b\n\n<state field="curiosity" value="0.4"/>',
    "**Bold** answer.\n\n- a\n  - b",
  ],
  [
    'Intro.\n\n<memory confidence="0.9" sensitivity="none">User likes Rust</memory>\n\n```rust\nfn main() {\n    println!("*hi*");\n}\n```',
    'Intro.\n\n```rust\nfn main() {\n    println!("*hi*");\n}\n```',
  ],
  [
    "Done. <narration>Checking npm</narration>The version is **1.11.0**.",
    "Done. The version is **1.11.0**.",
  ],
  ['- one\n<state field="processing" value="0.2"/>\n- two', "- one\n- two"],
  [
    'Result:\n\n[EXTERNAL_DATA source="web"]raw page[/EXTERNAL_DATA]\n\n*Italic* summary  \nwith a hard break.',
    "Result:\n\n*Italic* summary  \nwith a hard break.",
  ],
  [
    "Recall [MEMORY_DATA]secret note[/MEMORY_DATA] says hi.\n\n    indented code line",
    "Recall says hi.\n\n    indented code line",
  ],
];

/** [input, exact display output] — action cues from the lexicon (and some that are not). */
export const CUED_ANSWERS: readonly (readonly [string, string])[] = [
  ["*smiles* Hello there!", "Hello there!"],
  ["Sure! *nods* Here's **how**:\n\n1. Step", "Sure! Here's **how**:\n\n1. Step"],
  ["*drifts a little closer*\n\nWhat's on your mind?", "What's on your mind?"],
  ["I see. *tilts head*", "I see."],
  ["*eyes widen* Wow — *really*?", "Wow — *really*?"],
  ["Line one\n*glows softly*\nLine two", "Line one\nLine two"],
  ["**smiles** stays bold; ***nods*** stays too.", "**smiles** stays bold; ***nods*** stays too."],
  ["Use `*smiles*` and a*nods*b literally.", "Use `*smiles*` and a*nods*b literally."],
  ["*softly smiles* Okay.", "Okay."],
  ["*thinks for a moment*\n\n```\n*nods*\n```", "```\n*nods*\n```"],
];
