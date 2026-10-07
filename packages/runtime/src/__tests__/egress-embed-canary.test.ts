/**
 * Embeddings are egress. On web (always) and mobile (cloud mode) the surface
 * points `embedText` at the proxy's /v1/embed — an EXTERNAL service — so every
 * text the runtime embeds is POSTed off the device: the user's turn (the recall
 * query), every memory candidate, the recall tool's query, reflection insights,
 * consolidation summaries. This harness seeds medical+ interior on the
 * on-device provider, captures every remote-embed request body with a fetch
 * mock, and asserts no canary is in any of them — while context-safe text at
 * Personal still embeds remotely (the backend is live, not dead).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

// The local model never loads → the local path is the deterministic hash fallback.
vi.mock("@xenova/transformers", () => {
  throw new Error("no local model in tests");
});

import { embedTextHash, setRemoteEmbedUrl } from "@motebit/memory-graph";
import type { StreamingProvider } from "@motebit/ai-core";
import type { AIResponse, ContextPack } from "@motebit/sdk";
import { SensitivityLevel } from "@motebit/sdk";
import { MotebitRuntime, NullRenderer, TurnPrincipal, createInMemoryStorage } from "../index";

const EMBED_URL = "https://proxy.example/v1/embed";
const CANARY = {
  turn: "EMBCNRYTURN01",
  memory: "EMBCNRYMEMORY02",
  query: "EMBCNRYQUERY03",
  insight: "EMBCNRYINSIGHT04",
} as const;

function provider(): StreamingProvider {
  const plain = (text: string, extra: Partial<AIResponse> = {}): AIResponse => ({
    text,
    confidence: 0.8,
    memory_candidates: [],
    state_updates: {},
    ...extra,
  });
  const gen = (ctx: ContextPack): AIResponse => {
    const um = ctx.user_message ?? "";
    if (um.includes("INSIGHTS"))
      return plain(
        `INSIGHTS:\n- User Alice prefers ${CANARY.insight} reports\nADJUSTMENTS:\n- none\nPATTERNS:\n- none\nASSESSMENT:\nfine`,
      );
    if (um.includes(CANARY.turn))
      return plain("noted", {
        memory_candidates: [
          {
            content: `user diagnosis ${CANARY.memory}`,
            confidence: 0.9,
            sensitivity: SensitivityLevel.Medical,
          },
        ],
      });
    if (um.startsWith("You are a memory consolidation engine")) return plain('{"action":"add"}');
    if (um.includes("EMBLIVE"))
      return plain("noted", {
        memory_candidates: [
          {
            content: "user likes EMBLIVEMEM tea",
            confidence: 0.9,
            sensitivity: SensitivityLevel.Personal,
          },
        ],
      });
    return plain("ok");
  };
  return {
    model: "mock",
    setModel: vi.fn(),
    generate: vi.fn(async (ctx: ContextPack) => gen(ctx)),
    estimateConfidence: vi.fn(async () => 0.8),
    extractMemoryCandidates: vi.fn(async () => []),
    async *generateStream(ctx: ContextPack) {
      const response = gen(ctx);
      if (response.text) yield { type: "text" as const, text: response.text };
      yield { type: "done" as const, response };
    },
  };
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) void _;
}

function captureEmbedRequests(): string[] {
  const bodies: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const body = String(init?.body ?? "");
    if (String(input) === EMBED_URL) bodies.push(body);
    // A distinct vector per text (the hash embedding, padded to 384), so
    // memory formation does not merge unrelated texts.
    const text = (JSON.parse(body || "{}") as { texts?: string[] }).texts?.[0] ?? "";
    const vec = [...embedTextHash(text), ...new Array<number>(384 - 128).fill(0)];
    return new Response(JSON.stringify({ ok: true, embeddings: [vec] }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  return bodies;
}

describe("egress canary: the remote embedding backend receives only context-safe text", () => {
  afterEach(() => {
    setRemoteEmbedUrl(null);
    vi.restoreAllMocks();
  });

  it("medical+ turns, memories, recall queries and insights never reach /v1/embed; Personal text does", async () => {
    const bodies = captureEmbedRequests();
    setRemoteEmbedUrl(EMBED_URL);
    const runtime = new MotebitRuntime(
      { motebitId: "owner", tickRateHz: 0 },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: provider() },
    );

    // Seed on-device at Medical (the governor never stores a Secret turn's
    // candidate): the turn's text is the recall query the loop embeds; its
    // Medical candidate is embedded by memory formation.
    runtime.setProviderMode("on-device");
    // A prior memory, so the turn takes the recall path (it embeds the turn).
    await runtime.memory.formMemory(
      {
        content: "user likes tea",
        confidence: 0.9,
        sensitivity: SensitivityLevel.Personal,
        source: "user_stated",
      },
      [...embedTextHash("user likes tea"), ...new Array<number>(384 - 128).fill(0)],
    );
    runtime.setSessionSensitivity(SensitivityLevel.Medical);
    await drain(runtime.sendMessageStreaming(`my result is ${CANARY.turn}`));
    await runtime.awaitPendingMemoryFormation();
    runtime.setSessionSensitivity(SensitivityLevel.Secret);
    await runtime.recallMemoriesForTool(
      `what about ${CANARY.query}`,
      { limit: 5 },
      TurnPrincipal.OWNER,
    );
    await runtime.reflect();
    await new Promise((r) => setTimeout(r, 50)); // insight persistence is fire-and-forget
    expect(
      (await runtime.memory.exportAll()).nodes.some((n) => n.content.includes(CANARY.memory)),
      "the Medical memory was formed (the seed is live)",
    ).toBe(true);

    // Liveness: context-safe text at Personal on BYOK embeds remotely.
    runtime.setProviderMode("byok");
    runtime.setSessionSensitivity(SensitivityLevel.Personal);
    await drain(runtime.sendMessageStreaming("ordinary EMBLIVE"));
    await runtime.awaitPendingMemoryFormation();

    const leaked = Object.entries(CANARY)
      .filter(([, c]) => bodies.some((b) => b.includes(c)))
      .map(([k]) => k);
    expect(leaked, "these medical+ texts were POSTed to the remote embed service").toEqual([]);
    expect(
      bodies.some((b) => b.includes("EMBLIVE")),
      "Personal text embeds remotely",
    ).toBe(true);
  });
});
