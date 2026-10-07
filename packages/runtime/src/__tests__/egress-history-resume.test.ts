/**
 * Every path that sends conversation history to a provider sends the SAME
 * history a normal turn would: filtered to the session's effective tier at
 * send time, then sized to the model's window (`ConversationManager.trimmed`).
 *
 * Reproduces the cold-review leak end-to-end through `MotebitRuntime`: an
 * exchange at Secret tier on the on-device provider, then the session drops
 * to Personal on a BYOK provider, N ordinary exchanges, then a tool call that
 * needs approval. The continuation after `resumeAfterApproval` used to carry
 * the raw live history — the Secret exchange included — to the BYOK
 * provider, and to overflow a small window on a long conversation.
 *
 * HARNESS: every case is `it.fails` — the leak and the overflow reproduce at
 * this commit; the fix flips them to `it`.
 */
import { describe, it, expect, vi } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { StreamChunk } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import { estimateTokens, measureNonHistoryTokens } from "@motebit/ai-core";
import type {
  AIResponse,
  ContextPack,
  ConversationStoreAdapter,
  ToolDefinition,
} from "@motebit/sdk";
import { RiskLevel, SensitivityLevel } from "@motebit/sdk";

const SECRET = "SECRETDX";

const EXT_WRITE: ToolDefinition = {
  name: "ext_write",
  mode: "api",
  description: "Store a record in the external store",
  inputSchema: { type: "object", properties: { v: { type: "string" } } },
  riskHint: { risk: RiskLevel.R2_WRITE },
};

interface Sent {
  mode: string;
  ctx: ContextPack;
}

/** Answers ordinary messages; asks for `ext_write` on "store x" until a tool result is in history. */
function recordingProvider(sent: Sent[], mode: () => string, reply: string): StreamingProvider {
  const gen = (ctx: ContextPack): AIResponse => {
    sent.push({ mode: mode(), ctx });
    const history = JSON.stringify(ctx.conversation_history ?? []);
    if (ctx.user_message === "store x" && !history.includes("tool_result")) {
      return {
        text: "",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
        tool_calls: [{ id: "c1", name: "ext_write", args: { v: "x" } }],
      };
    }
    return { text: reply, confidence: 0.8, memory_candidates: [], state_updates: {} };
  };
  return {
    model: "mock-model",
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

async function drain(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

/** Minimal one-conversation store: enough for summarization and titling to run. */
function conversationStore(): ConversationStoreAdapter {
  let summary: string | null = null;
  let created = false;
  const startedAt = Date.now();
  return {
    createConversation: () => {
      created = true;
      return "conv-1";
    },
    appendMessage: () => {},
    loadMessages: () => [],
    getActiveConversation: () =>
      created ? { conversationId: "conv-1", startedAt, lastActiveAt: startedAt, summary } : null,
    updateSummary: (_id, s) => {
      summary = s;
    },
    updateTitle: () => {},
    listConversations: () =>
      created
        ? [
            {
              conversationId: "conv-1",
              startedAt,
              lastActiveAt: startedAt,
              title: null,
              messageCount: 0,
            },
          ]
        : [],
    deleteConversation: () => {},
  };
}

function makeRuntime(opts: { contextWindowTokens?: number; reply?: string } = {}) {
  const sent: Sent[] = [];
  let mode = "on-device";
  const runtime = new MotebitRuntime(
    {
      motebitId: "owner",
      tickRateHz: 0,
      ...(opts.contextWindowTokens != null
        ? { contextWindowTokens: opts.contextWindowTokens }
        : {}),
      policy: {
        operatorMode: true,
        maxRiskLevel: RiskLevel.R3_EXECUTE,
        requireApprovalAbove: RiskLevel.R1_DRAFT,
        denyAbove: RiskLevel.R3_EXECUTE,
      },
    },
    {
      storage: { ...createInMemoryStorage(), conversationStore: conversationStore() },
      renderer: new NullRenderer(),
      ai: recordingProvider(sent, () => mode, opts.reply ?? "ok"),
    },
  );
  const extWrite = vi.fn(async () => ({ ok: true, data: "stored" }));
  runtime.getToolRegistry().register(EXT_WRITE, extWrite);
  const setMode = (m: "on-device" | "byok") => {
    mode = m;
    runtime.setProviderMode(m);
  };
  return { runtime, sent, setMode, extWrite };
}

function historyText(ctx: ContextPack): string {
  return JSON.stringify(ctx.conversation_history ?? []);
}

describe("approval resume sends filtered, budgeted history", () => {
  for (const n of [1, 5, 25]) {
    it.fails(
      `a Secret exchange never reaches the BYOK provider on the continuation (N=${n})`,
      async () => {
        const { runtime, sent, setMode, extWrite } = makeRuntime();
        setMode("on-device");
        runtime.setSessionSensitivity(SensitivityLevel.Secret);
        await drain(runtime.sendMessageStreaming(`my code is ${SECRET}`));
        expect(sent.length).toBeGreaterThan(0);

        setMode("byok");
        runtime.setSessionSensitivity(SensitivityLevel.Personal);
        for (let i = 0; i < n; i++) await drain(runtime.sendMessageStreaming(`ordinary ${i}`));

        const before = sent.length;
        const chunks = await drain(runtime.sendMessageStreaming("store x"));
        expect(chunks.some((c) => c.type === "approval_request")).toBe(true);
        await drain(runtime.resumeAfterApproval(true));
        expect(extWrite).toHaveBeenCalledTimes(1);

        const continuation = sent
          .slice(before)
          .filter((s) => historyText(s.ctx).includes("tool_result"));
        expect(continuation.length).toBeGreaterThan(0);
        for (const s of sent.filter((x) => x.mode === "byok")) {
          expect(historyText(s.ctx)).not.toContain(SECRET);
        }
      },
    );
  }

  it.fails(
    "the continuation on a long conversation fits the model's window",
    async () => {
      const WINDOW = 32_768;
      const reply = "r".repeat(400);
      const { runtime, sent, setMode } = makeRuntime({ contextWindowTokens: WINDOW, reply });
      setMode("byok");
      runtime.setSessionSensitivity(SensitivityLevel.Personal);
      for (let i = 0; i < 150; i++) {
        await drain(runtime.sendMessageStreaming(`message ${i} ${"u".repeat(400)}`));
      }
      const before = sent.length;
      await drain(runtime.sendMessageStreaming("store x"));
      await drain(runtime.resumeAfterApproval(true));

      const continuation = sent
        .slice(before)
        .filter((s) => historyText(s.ctx).includes("tool_result"));
      expect(continuation.length).toBeGreaterThan(0);
      for (const s of continuation) {
        const history = (s.ctx.conversation_history ?? []).reduce(
          (sum, m) => sum + estimateTokens(typeof m.content === "string" ? m.content : ""),
          0,
        );
        const system = measureNonHistoryTokens(s.ctx, "mock-model");
        expect(history + system).toBeLessThanOrEqual(WINDOW);
      }
    },
    60_000,
  );
});

describe("history-reading completions send filtered history", () => {
  async function secretThenByok() {
    const r = makeRuntime();
    r.setMode("on-device");
    r.runtime.setSessionSensitivity(SensitivityLevel.Secret);
    await drain(r.runtime.sendMessageStreaming(`my code is ${SECRET}`));
    r.setMode("byok");
    r.runtime.setSessionSensitivity(SensitivityLevel.Personal);
    await drain(r.runtime.sendMessageStreaming("ordinary"));
    return r;
  }

  it.fails("summarization never sends a Secret exchange to the BYOK provider", async () => {
    const { runtime, sent } = await secretThenByok();
    const before = sent.length;
    await runtime.summarizeCurrentConversation();
    expect(sent.length).toBeGreaterThan(before);
    for (const s of sent.filter((x) => x.mode === "byok")) {
      expect(JSON.stringify(s.ctx)).not.toContain(SECRET);
    }
  });

  it.fails("reflection never sends a Secret exchange to the BYOK provider", async () => {
    const { runtime, sent } = await secretThenByok();
    const before = sent.length;
    await runtime.reflect();
    expect(sent.length).toBeGreaterThan(before);
    for (const s of sent.filter((x) => x.mode === "byok")) {
      expect(JSON.stringify(s.ctx)).not.toContain(SECRET);
    }
  });
});
