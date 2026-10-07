/**
 * Display parity — the text a user SEES must be the model's markdown,
 * byte-for-byte, minus internal tags and lexicon action cues.
 *
 * A benchmark scored displayed answers 4.23/10 against 7.73 for the
 * identical model output: `stripTags` deleted every `*…*` span (eating
 * **bold** and *italic*) and collapsed all whitespace (destroying lists,
 * newlines, code indentation).
 *
 * Three properties, each against the corpus:
 *   (i)   markdown is byte-preserved by every display strip;
 *   (ii)  internal-tag removal is IDENTICAL to origin/main's (differential
 *         oracle: main's regex chains verbatim, tag lines only), compared
 *         modulo whitespace — the only thing this change may alter;
 *   (iii) cue extraction (`extractActions` → `actionsToStateUpdates`) is
 *         identical to main's.
 */
import { describe, it, expect } from "vitest";
import {
  stripTags,
  stripPartialActionTag,
  stripInternalTags,
  stripActionCues,
  stripInternalTagsForDisplay,
  isActionCue,
  extractActions,
  actionsToStateUpdates,
} from "../core.js";
import { MARKDOWN_ANSWERS, TAGGED_ANSWERS, CUED_ANSWERS } from "./fixtures/display-corpus.js";

// --- Oracles: origin/main verbatim, applied to tags only ---------------------

/** origin/main `stripTags`, minus its `*` deletion and whitespace collapse. */
function mainStripTagsTagsOnly(text: string): string {
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
function mainStripInternalTags(text: string): string {
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

/** origin/main `extractActions`, verbatim. */
function mainExtractActions(text: string): string[] {
  const regex = /\*([^*]+)\*/g;
  const actions: string[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    actions.push(match[1]!.trim());
  }
  return actions;
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

// Tag-heavy inputs for the oracle, including adversarial placements
// (tags inside code are still hidden — fail-closed, never code-aware).
const TAG_ORACLE_INPUTS: readonly string[] = [
  ...TAGGED_ANSWERS.map(([input]) => input),
  '```\n<state field="x" value="1"/>\n```',
  "`<thinking>inline</thinking>` still hidden",
  '<memory confidence="0.5" sensitivity="personal" type="episodic">multi\nline\nmemory</memory>after',
  '[EXTERNAL_DATA source="a"]unclosed opener then text',
  "text then [/EXTERNAL_DATA] stray closer",
  "<thinking>a</thinking><thinking>b</thinking>\n\n\n<narration >n</narration >end",
  'partial at end <memory confidence="0.9"',
];

describe("display parity (i): markdown is byte-preserved", () => {
  it.each(MARKDOWN_ANSWERS.map((a, i) => [i, a] as const))(
    "stripTags preserves markdown answer #%i",
    (_i, answer) => {
      expect(stripTags(answer)).toBe(answer.trim());
    },
  );

  it.each(MARKDOWN_ANSWERS.map((a, i) => [i, a] as const))(
    "stripPartialActionTag preserves markdown answer #%i",
    (_i, answer) => {
      expect(stripPartialActionTag(answer)).toBe(answer.trim());
    },
  );

  it.each(MARKDOWN_ANSWERS.map((a, i) => [i, a] as const))(
    "stripActionCues preserves markdown answer #%i",
    (_i, answer) => {
      expect(stripActionCues(answer)).toBe(answer.trim());
    },
  );

  it.each(TAGGED_ANSWERS.map(([i, o]) => [i, o] as const))(
    "stripTags hides tags and keeps the markdown around them: %j",
    (input, output) => {
      expect(stripTags(input)).toBe(output);
    },
  );

  it.each(CUED_ANSWERS.map(([i, o]) => [i, o] as const))(
    "stripTags removes lexicon cues only: %j",
    (input, output) => {
      expect(stripTags(input)).toBe(output);
      expect(stripPartialActionTag(input)).toBe(output);
    },
  );
});

describe("display parity (ii): internal-tag removal matches origin/main", () => {
  it.each(TAG_ORACLE_INPUTS.map((t) => [t] as const))("stripTags ≡ main tags-only: %j", (input) => {
    expect(squash(stripTags(input))).toBe(squash(mainStripTagsTagsOnly(input)));
  });

  it.each(TAG_ORACLE_INPUTS.map((t) => [t] as const))(
    "stripInternalTags is main's verbatim: %j",
    (input) => {
      expect(stripInternalTags(input)).toBe(mainStripInternalTags(input));
    },
  );

  it.each(TAG_ORACLE_INPUTS.map((t) => [t] as const))(
    "stripPartialActionTag ≡ main stripInternalTags (tags only): %j",
    (input) => {
      expect(squash(stripPartialActionTag(input))).toBe(squash(mainStripInternalTags(input)));
    },
  );
});

describe("display parity (iii): cue extraction is unchanged", () => {
  const all = [
    ...MARKDOWN_ANSWERS,
    ...TAGGED_ANSWERS.map(([i]) => i),
    ...CUED_ANSWERS.map(([i]) => i),
  ];
  it.each(all.map((t) => [t] as const))("extractActions ≡ main: %j", (input) => {
    expect(extractActions(input)).toEqual(mainExtractActions(input));
    expect(actionsToStateUpdates(extractActions(input))).toEqual(
      actionsToStateUpdates(mainExtractActions(input)),
    );
  });

  it("every stripped cue is one that drives creature state", () => {
    for (const [input] of CUED_ANSWERS) {
      const output = stripTags(input);
      const removed = [...input.matchAll(/(?<!\*)\*([^*\n]+)\*(?!\*)/g)]
        .filter((m) => !output.includes(m[0]))
        .map((m) => m[1]!);
      expect(removed.length > 0).toBe(output !== input.trim());
      for (const cue of removed) {
        expect(Object.keys(actionsToStateUpdates([cue])).length).toBeGreaterThan(0);
      }
    }
  });
});

describe("action cue boundaries", () => {
  it("isActionCue: lexicon lead verb, short, single line", () => {
    expect(isActionCue("smiles")).toBe(true);
    expect(isActionCue("gently nods")).toBe(true);
    expect(isActionCue("eyes widen")).toBe(true);
    expect(isActionCue("")).toBe(false);
    expect(isActionCue("smiles\nagain")).toBe(false);
    expect(isActionCue("smiles `x`")).toBe(false);
    expect(isActionCue("smiles at the user for a very long while now")).toBe(false);
    expect(isActionCue("really")).toBe(false);
    expect(isActionCue("happily ever after")).toBe(false);
  });

  it("never strips across a space-padded closer, a word-bound closer, or code", () => {
    for (const text of [
      "*smiles *",
      "*smiles*ly",
      "a *nods `x`* b",
      "``code *nods* still code`` and `x`",
      "* nods*",
    ]) {
      expect(stripActionCues(text)).toBe(text);
    }
  });

  it("an unmatched backtick opens code to the end of its paragraph only", () => {
    expect(stripActionCues("`open *nods*\n\n*nods* after")).toBe("`open *nods*\n\nafter");
  });

  it("partial mode holds a cue that may still be forming", () => {
    expect(stripPartialActionTag("Okay. *")).toBe("Okay.");
    expect(stripPartialActionTag("Okay. *smi")).toBe("Okay.");
    expect(stripPartialActionTag("Okay. *smiles*")).toBe("Okay.");
    expect(stripPartialActionTag("Okay. *smiles* now")).toBe("Okay. now");
    // too long to be a cue — not held
    expect(stripPartialActionTag("x *a b c d e f g h i j")).toBe("x *a b c d e f g h i j");
    // not at the end of the text — a closed line is settled
    expect(stripPartialActionTag("x *smi\nnext")).toBe("x *smi\nnext");
  });

  it("stripInternalTagsForDisplay hides tags and cues, keeps markdown", () => {
    expect(
      stripInternalTagsForDisplay("<thinking>t</thinking>*nods* **Yes**:\n\n- a\n    - b"),
    ).toBe("**Yes**:\n\n- a\n    - b");
  });

  it("removal never collides with private-use characters already in the text", () => {
    let all = "";
    for (let c = 0xe000; c <= 0xf8ff; c++) all += String.fromCharCode(c);
    const text = `${all} *nods* **ok**`;
    expect(stripActionCues(text)).toBe(`${all} **ok**`);
  });
});
