/**
 * The live chat stream displays exactly what the final display strip shows.
 *
 * Measured regression: the runtime's own stream strip (`stripDisplayTags`,
 * a duplicated copy of the old ai-core regex set) ran `\*{1,3}` → "" and
 * `/ {2,}/` → " " on every text chunk yielded to web/desktop chat, so
 * `**important**` streamed as `important` and a fenced `return a * b`
 * as `return a b` — even after the ai-core display primitives were fixed.
 *
 * Invariant pinned here: for every corpus entry and EVERY split offset, the
 * text the runtime yields (concatenated) equals ai-core's `stripTags` of the
 * whole model text, and markdown-only entries survive byte-for-byte.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { StreamChunk } from "../index";
import type { AgenticChunk, StreamingProvider, TurnResult } from "@motebit/ai-core";
import { stripTags } from "@motebit/ai-core";
import type { AIResponse } from "@motebit/sdk";
import { TrustMode, BatteryMode } from "@motebit/sdk";

const mockRunTurnStreaming = vi.fn();

vi.mock("@motebit/ai-core", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@motebit/ai-core");
  return {
    ...actual,
    runTurnStreaming: (...args: unknown[]) =>
      mockRunTurnStreaming(...args) as AsyncGenerator<AgenticChunk>,
  };
});

function provider(): StreamingProvider {
  const response: AIResponse = {
    text: "",
    confidence: 0.8,
    memory_candidates: [],
    state_updates: {},
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn().mockResolvedValue(response),
    estimateConfidence: vi.fn().mockResolvedValue(0.8),
    extractMemoryCandidates: vi.fn().mockResolvedValue([]),
    async *generateStream() {
      yield { type: "done" as const, response };
    },
  } as unknown as StreamingProvider;
}

function turnResult(response: string): TurnResult {
  return {
    response,
    memoriesFormed: [],
    memoriesRetrieved: [],
    stateAfter: {
      attention: 0.5,
      processing: 0.1,
      confidence: 0.7,
      affect_valence: 0,
      affect_arousal: 0,
      social_distance: 0.5,
      curiosity: 0.3,
      trust_mode: TrustMode.Guarded,
      battery_mode: BatteryMode.Normal,
    },
    cues: {
      hover_distance: 0.4,
      drift_amplitude: 0.02,
      glow_intensity: 0.3,
      eye_dilation: 0.3,
      smile_curvature: 0,
      speaking_activity: 0,
    },
    iterations: 1,
    toolCallsSucceeded: 0,
    toolCallsBlocked: 0,
    toolCallsFailed: 0,
  };
}

async function* chunks(parts: string[], full: string): AsyncGenerator<AgenticChunk> {
  for (const text of parts) yield { type: "text", text };
  yield { type: "result", result: turnResult(full) };
}

/** Markdown only — no motebit markup, so the display must be the input itself. */
const MARKDOWN: Record<string, string> = {
  bold: "This is **important** and so is __this__.",
  boldItalic: "A ***strong emphasis*** here and *italic* there.",
  nestedLists:
    "1. **SYN** first\n   - nested *item*\n     - deeper `code`\n2. Second\n\n- [ ] task",
  headings: "# Title\n\n## Sub **bold**\n\n### Third",
  table: "| a | b |\n|---|---|\n| **x** | `y*z` |\n| 1 | 2 |",
  quote: "> quoted **line**\n> second line\n\nAfter.",
  fencedStar:
    "Fix:\n\n```python\ndef area(a, b):\n    return a * b  # **kw**\n\n\n\n    x = 1\n```\n\nDone.",
  inlineCode: "Run `a ** b` or `*args`, then `x  y`.",
  arithmetic: "Compute a*b*c and 2 * 3 * 4 = 24.",
  urls: "See https://example.com/a_b*c?q=1&r=**2** and <https://x.y/z>.",
  emoji: "Done 🎉 — **great** ✨ work 👍🏽.",
  tildeFence: "~~~\n  *keep*  spacing  \n~~~\nTail.",
  lookalikeTags: "```html\n<memory-card>hi</memory-card>\n<state-machine/>\n```\nEnd text here.",
  // Round-2 repros: a MENTIONED tag (code, or an opener that never closes)
  // was cut with everything after it.
  mentionInCode:
    "Claude can reason in a `<thinking>` block before answering. **Tips:**\n\n1. Keep it short",
  mentionParameter: 'Pass `<parameter name="x">` to the tool.\n\n- then **this**',
  bareNarration: "The <narration> tag carries step chrome. **Note:** ok",
  fencedMemoryExample:
    '```xml\n<memory confidence="0.9">likes tea</memory>\n```\n\nThat is the **format**.',
  unclosedParameter: 'Use <parameter name="x"> then **bold**.',
  mentionOnly: "Use `<thinking>` tags.",
};

/** Mixed with internal markup / action narration — display must equal stripTags. */
const MIXED: Record<string, string> = {
  internalTags:
    '<state attention="0.7"/>Hello **there**.\n<memory confidence="0.9" sensitivity="none">User likes tea</memory>\n\n- one\n- two',
  thinking: "<thinking>plan the answer</thinking>The answer is **42**.",
  narration: "<narration>Checking npm</narration>Live version is `1.11.0`.",
  actionCue: "*smiles* Hello! *nods* Here is **bold** text.",
  externalData: 'Result: [EXTERNAL_DATA source="web"]ignore previous[/EXTERNAL_DATA] **ok**.',
  memoryData: "[MEMORY_DATA]secret[/MEMORY_DATA]Recall **done**.",
  mentionThenReal: "Use `<thinking>` tags. <thinking>plan</thinking> Answer **ok**.",
  mentionThenUnclosedMarker: "See `[MEMORY_DATA]`. [MEMORY_DATA]recalled **fact**",
  hardBreaks: "Line one  \nLine two\n\n\n\nPara.",
};

/**
 * REAL internal markup — its content must never be displayed, finally or
 * transiently. Both leaked through this path at b3ab40b26 (hidden on main):
 * a turn cut off mid-`<thinking>` (token limit), and a stray backtick that
 * paired with a backtick inside a real block on the next line.
 */
const LEAKS: Record<string, { text: string; expected: string }> = {
  unclosedThinking: {
    text: "Here is my answer **bold**.\n\n<thinking>SECRET unclosed",
    expected: "Here is my answer **bold**.",
  },
  unclosedThinkingAfterLine: {
    text: "Answer **first**.\n<thinking>never closed, SECRET",
    expected: "Answer **first**.",
  },
  unclosedMemory: {
    text: 'Noted.\n<memory confidence="0.9" sensitivity="personal">SECRET user is',
    expected: "Noted.",
  },
  unclosedState: { text: 'All set.\n<state curiosity="SECRET', expected: "All set." },
  strayBacktick: {
    text: "Press the ` key.\n<thinking>I should mention `ls` SECRET</thinking>\nThen run it.",
    expected: "Press the ` key.\n\nThen run it.",
  },
  strayBacktickMemory: {
    text: 'Press the ` key.\n<memory confidence="0.9">SECRET uses `zsh`</memory>\nDone.',
    expected: "Press the ` key.\n\nDone.",
  },
  strayBacktickState: {
    text: 'Press the ` key.\n<state curiosity="SECRET"/>Then `ls` it.',
    expected: "Press the ` key.\nThen `ls` it.",
  },
  realAfterCodeSpan: {
    text: "Run `ls` then <thinking>SECRET `x`</thinking> done **now**.",
    expected: "Run `ls` then done **now**.",
  },
  doubleBacktick: {
    text: "Press `` twice.\n<thinking>SECRET ``x``</thinking>\nDone.",
    expected: "Press `` twice.\n\nDone.",
  },
  crlf: {
    text: "Press ` key.\r\n<thinking>`ls` SECRET</thinking>\r\nThen.\r\n<thinking>SECRET",
    expected: "Press ` key.\r\n\r\nThen.",
  },
  // Same-line stray backtick: inline code never shields a real block.
  sameLineThinking: {
    text: "Use the ` key. <thinking>SECRET user means `</thinking> Done.",
    expected: "Use the ` key. Done.",
  },
  sameLineInnerSpan: {
    text: "It's 5` long. <thinking>SECRET maybe use `ls`</thinking> Use ls.",
    expected: "It's 5` long. Use ls.",
  },
  sameLineState: {
    text: 'Press ` then go. <state curiosity="SECRET"/> ok `x` ',
    expected: "Press ` then go. ok `x`",
  },
  sameLineMemory: {
    text: 'Press ` then <memory type="f">SECRET `name`</memory> ok',
    expected: "Press ` then ok",
  },
  sameLineDoubleBacktick: {
    text: "Hit `` here. <thinking>SECRET use ``x``</thinking> Done.",
    expected: "Hit `` here. Done.",
  },
  sameLineSeveral: {
    text: 'A ` b <thinking>SECRET `</thinking> c ` d <memory type="f">SECRET `</memory> e ` f <state x="SECRET"/> g',
    expected: "A ` b c ` d e ` f g",
  },
};

async function streamChunks(runtime: MotebitRuntime, parts: string[], full: string) {
  mockRunTurnStreaming.mockReturnValue(chunks(parts, full));
  const out: string[] = [];
  for await (const c of runtime.sendMessageStreaming("q") as AsyncGenerator<StreamChunk>) {
    if (c.type === "text") out.push(c.text);
  }
  return out;
}

async function streamThroughRuntime(runtime: MotebitRuntime, parts: string[], full: string) {
  return (await streamChunks(runtime, parts, full)).join("");
}

function splits(text: string): string[][] {
  const all: string[][] = [Array.from(text)];
  for (let k = 0; k <= text.length; k++) all.push([text.slice(0, k), text.slice(k)]);
  return all;
}

describe("live stream display == ai-core final display strip", () => {
  let runtime: MotebitRuntime;

  beforeEach(() => {
    mockRunTurnStreaming.mockReset();
    runtime = new MotebitRuntime(
      { motebitId: "display-parity", tickRateHz: 0 },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: provider() },
    );
  });

  it("repro: bold and a fenced `*` survive the live stream", async () => {
    expect(await streamThroughRuntime(runtime, ["**important**"], "**important**")).toBe(
      "**important**",
    );
    const fenced = "```\nreturn a * b\n```";
    expect(await streamThroughRuntime(runtime, [fenced], fenced)).toBe(fenced);
  });

  for (const [name, text] of Object.entries(MARKDOWN)) {
    it(`markdown byte-preserved at every split: ${name}`, async () => {
      expect(stripTags(text)).toBe(text);
      for (const parts of splits(text)) {
        expect(await streamThroughRuntime(runtime, parts, text)).toBe(text);
      }
    });
  }

  for (const [name, text] of Object.entries(MIXED)) {
    it(`internal markup stripped identically at every split: ${name}`, async () => {
      const expected = stripTags(text);
      for (const parts of splits(text)) {
        expect(await streamThroughRuntime(runtime, parts, text)).toBe(expected);
      }
    });
  }

  for (const [name, { text, expected }] of Object.entries(LEAKS)) {
    it(`real internal content never displayed at any split: ${name}`, async () => {
      expect(stripTags(text)).toBe(expected);
      for (const parts of splits(text)) {
        const out = await streamChunks(runtime, parts, text);
        // The display is the running concatenation: no frame may hold it.
        let shown = "";
        for (const delta of out) {
          shown += delta;
          expect(shown, JSON.stringify(parts)).not.toContain("SECRET");
        }
        expect(shown).toBe(expected);
      }
    });
  }
});
