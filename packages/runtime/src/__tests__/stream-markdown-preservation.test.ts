/**
 * The live stream preserves markdown; internal-tag hiding is unchanged.
 *
 * The STREAM chain (`stripDisplayTags` in streaming.ts) used to delete every
 * `*`, `**`, `***` and collapse runs of spaces, destroying bold/italic,
 * `2*3*4`, and list/code indentation. No production path consumes asterisk
 * cues (docs/design/out-of-band-interior-channel.md on branch
 * design/out-of-band-interior-channel), so the asterisk step is gone.
 *
 * Locked here, through the real `sendMessageStreaming` path:
 *   1. A markdown corpus survives byte-for-byte (after folding 3+ newlines
 *      to 2 and trimming) as the concatenation of yielded deltas, at every
 *      split point.
 *   2. Differential: for a generated corpus of internal tags, the yielded
 *      text equals what origin/main's tag chain + incomplete-tag hold
 *      (minus the asterisk step) yields — byte-identical tag hiding.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { StreamChunk } from "../index";
import type { AgenticChunk, StreamingProvider, TurnResult } from "@motebit/ai-core";
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

function createMockProvider(): StreamingProvider {
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
  };
}

function makeTurnResult(response: string): TurnResult {
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

async function* yieldText(parts: string[]): AsyncGenerator<AgenticChunk> {
  for (const text of parts) yield { type: "text", text };
  yield { type: "result", result: makeTurnResult(parts.join("")) };
}

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

// Byte copy of origin/main's STREAM tag chain + incomplete-tag hold, with
// the `\*{1,3}` step and the post-asterisk ` {2,}` collapse removed and the
// 3+-newline fold added (the same normalization every display path uses).
function mainStreamChain(text: string): string {
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
    .replace(/\n{3,}/g, "\n\n");
  for (const tag of ["<memory", "<thinking", "<parameter", "<narration"]) {
    const lastOpen = clean.lastIndexOf(tag);
    if (lastOpen !== -1 && !clean.slice(lastOpen).includes(`</${tag.slice(1)}>`)) {
      return clean.slice(0, lastOpen);
    }
  }
  const lastOpen = clean.lastIndexOf("<");
  if (lastOpen !== -1 && !clean.includes(">", lastOpen)) return clean.slice(0, lastOpen);
  return clean;
}

/** Reference stream: the runtime's prefix-delta loop over the main chain. */
function referenceStream(parts: string[]): string {
  let acc = "";
  let out = "";
  for (const p of parts) {
    acc += p;
    const clean = mainStreamChain(acc).trimStart();
    out += clean.slice(out.length);
  }
  return out;
}

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
  '<parameter name="q">*query*</parameter>',
  "<artifact>",
  "</function_calls>",
  '[EXTERNAL_DATA source="web"]fetched **content**[/EXTERNAL_DATA]',
  "[MEMORY_DATA]recalled *fact*[/MEMORY_DATA]",
  '[EXTERNAL_DATA source="x"]',
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

function generateTagCorpus(n: number, seed: number): string[] {
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

describe("live stream display", () => {
  let runtime: MotebitRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = new MotebitRuntime(
      { motebitId: "stream-md-test", tickRateHz: 0 },
      {
        storage: createInMemoryStorage(),
        renderer: new NullRenderer(),
        ai: createMockProvider(),
      },
    );
  });

  async function streamed(parts: string[]): Promise<string> {
    mockRunTurnStreaming.mockReturnValue(yieldText(parts));
    let out = "";
    for await (const c of runtime.sendMessageStreaming("hi") as AsyncGenerator<StreamChunk>) {
      if (c.type === "text") out += c.text;
    }
    return out;
  }

  for (const [i, md] of MARKDOWN_CORPUS.entries()) {
    it(`concatenated deltas byte-preserve corpus[${i}] at every split`, async () => {
      for (let k = 0; k <= md.length; k++) {
        const got = await streamed([md.slice(0, k), md.slice(k)]);
        expect(got.trimEnd()).toBe(norm(md));
      }
      // And one character per chunk.
      expect((await streamed([...md])).trimEnd()).toBe(norm(md));
    });
  }

  it("hides exactly what main's tag chain + hold hides on a generated corpus", async () => {
    const rand = mulberry32(0xc0ffee);
    for (const s of generateTagCorpus(200, 0x5eed)) {
      const cut1 = Math.floor(rand() * (s.length + 1));
      const cut2 = cut1 + Math.floor(rand() * (s.length - cut1 + 1));
      for (const parts of [[s], [s.slice(0, cut1), s.slice(cut1, cut2), s.slice(cut2)], [...s]]) {
        expect(await streamed(parts)).toBe(referenceStream(parts));
      }
    }
  });
});
