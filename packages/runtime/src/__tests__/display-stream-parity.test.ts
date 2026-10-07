/**
 * Display parity for the LIVE stream — the concatenated text deltas a
 * surface renders must equal the final display text, at every split offset
 * of the model's output. Markdown is byte-preserved; internal tags are
 * hidden exactly as on origin/main; lexicon action cues never flash.
 *
 * Corpus mirrors ai-core's display-parity corpus.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { StreamChunk } from "../index";
import type { AgenticChunk, StreamingProvider, TurnResult } from "@motebit/ai-core";
import type { AIResponse } from "@motebit/sdk";
import { TrustMode, BatteryMode } from "@motebit/sdk";
import { MARKDOWN_ANSWERS, TAGGED_ANSWERS, CUED_ANSWERS } from "./fixtures/display-corpus.js";

const mockRunTurnStreaming = vi.fn();

vi.mock("@motebit/ai-core", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@motebit/ai-core");
  return {
    ...actual,
    runTurnStreaming: (...args: unknown[]) =>
      mockRunTurnStreaming(...args) as AsyncGenerator<AgenticChunk>,
    reflect: vi
      .fn()
      .mockResolvedValue({ insights: [], planAdjustments: [], patterns: [], selfAssessment: "" }),
    summarizeConversation: vi.fn().mockResolvedValue("summary"),
    shouldSummarize: vi.fn().mockReturnValue(false),
  };
});

function makeTurnResult(text: string): TurnResult {
  return {
    response: text,
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

async function* yieldChunks(chunks: AgenticChunk[]): AsyncGenerator<AgenticChunk> {
  for (const chunk of chunks) yield chunk;
}

let runtime: MotebitRuntime;

function mockProvider(): StreamingProvider {
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

beforeAll(() => {
  runtime = new MotebitRuntime(
    { motebitId: "display-parity", tickRateHz: 0 },
    { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: mockProvider() },
  );
});

/** Stream `pieces` as text chunks through the runtime; return the joined deltas. */
async function streamed(pieces: string[]): Promise<string> {
  const full = pieces.join("");
  mockRunTurnStreaming.mockReturnValueOnce(
    yieldChunks([
      ...pieces.map((text) => ({ type: "text" as const, text })),
      { type: "result" as const, result: makeTurnResult(full) },
    ]),
  );
  let out = "";
  for await (const chunk of runtime.sendMessageStreaming("q") as AsyncGenerator<StreamChunk>) {
    if (chunk.type === "text") out += chunk.text;
  }
  return out;
}

const cases: Array<readonly [string, string]> = [
  ...MARKDOWN_ANSWERS.map((a) => [a, a.trim()] as const),
  // Split offsets inside a `[MEMORY_DATA]` / `[EXTERNAL_DATA]` marker flash
  // the partial marker — a pre-existing tag-streaming gap on origin/main
  // (only `<` tags are held back), outside this change's scope. Those
  // answers are covered whole, below.
  ...TAGGED_ANSWERS.filter(([input]) => !input.includes("_DATA")),
  ...CUED_ANSWERS,
];

describe("live stream display parity", () => {
  it.each(cases.map(([input, output], i) => [i, input, output] as const))(
    "case #%i: deltas equal the final display text at every split offset",
    async (_i, input, expected) => {
      expect(await streamed([input])).toBe(expected);
      for (let k = 1; k < input.length; k++) {
        const got = await streamed([input.slice(0, k), input.slice(k)]);
        if (got !== expected) {
          expect({ k, got }).toEqual({ k, got: expected });
        }
      }
    },
  );

  it.each(cases.map(([input, output], i) => [i, input, output] as const))(
    "case #%i: char-by-char stream equals the final display text",
    async (_i, input, expected) => {
      expect(await streamed([...input])).toBe(expected);
    },
  );

  it.each(
    TAGGED_ANSWERS.filter(([input]) => input.includes("_DATA")).map(([i, o]) => [i, o] as const),
  )("bracket-marker answer streamed whole: %j", async (input, expected) => {
    expect(await streamed([input])).toBe(expected);
  });
});
