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
  unclosedThinking: "Answer **first**.\n<thinking>never closed, secret",
  hardBreaks: "Line one  \nLine two\n\n\n\nPara.",
};

async function streamThroughRuntime(runtime: MotebitRuntime, parts: string[], full: string) {
  mockRunTurnStreaming.mockReturnValue(chunks(parts, full));
  const out: string[] = [];
  for await (const c of runtime.sendMessageStreaming("q") as AsyncGenerator<StreamChunk>) {
    if (c.type === "text") out.push(c.text);
  }
  return out.join("");
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
});
