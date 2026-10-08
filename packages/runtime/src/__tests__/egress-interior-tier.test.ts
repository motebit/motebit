/**
 * Every piece of owner-interior content that enters an EXTERNAL provider
 * request is filtered to the tier the request is sent at — the same rule
 * `egress-history-resume.test.ts` holds for conversation history, applied
 * to the other channels that carry the interior:
 *
 *   1. `[Recent Events]` — a `tool_used` result and a `memory_formed`
 *      memory from a Secret turn, after the session drops to Personal on
 *      a BYOK provider.
 *   2. The memory index — a Secret memory, with no tier drop at all.
 *   3. Reflection — `[Relevant Memories]` / `[Memory Audit]` built from a
 *      Secret memory.
 *   4. Curiosity hints — built from memory content.
 *
 * And the on-device provider at Secret tier still receives everything.
 */
import { describe, it, expect, vi } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { StreamChunk } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import type { AIResponse, ContextPack, MemoryNode, ToolDefinition } from "@motebit/sdk";
import { RiskLevel, SensitivityLevel } from "@motebit/sdk";

const TOOL_SECRET = "SECRETDX";
const MEM_SECRET = "MEMSECRET1";

const PROBE: ToolDefinition = {
  name: "probe",
  mode: "api",
  description: "Read a value",
  inputSchema: { type: "object", properties: {} },
  riskHint: { risk: RiskLevel.R0_READ },
};

interface Sent {
  mode: string;
  ctx: ContextPack;
}

/**
 * On "look it up": calls `probe`. On "remember the pin": answers with a
 * Medical memory candidate (the governor never stores a Secret candidate
 * from a turn, and the turn floors candidates to the session tier — so the
 * memory forms in a Medical turn; Medical is equally never-egress). Everything else: a plain reply.
 */
function recordingProvider(sent: Sent[], mode: () => string): StreamingProvider {
  const gen = (ctx: ContextPack): AIResponse => {
    sent.push({ mode: mode(), ctx });
    const history = JSON.stringify(ctx.conversation_history ?? []);
    if (ctx.user_message === "look it up" && !history.includes(TOOL_SECRET)) {
      return {
        text: "",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
        tool_calls: [{ id: "p1", name: "probe", args: {} }],
      };
    }
    if (ctx.user_message === "remember the pin") {
      return {
        text: "noted",
        confidence: 0.9,
        memory_candidates: [
          {
            content: `user pin is ${MEM_SECRET}`,
            confidence: 0.9,
            sensitivity: SensitivityLevel.Medical,
          },
        ],
        state_updates: {},
      };
    }
    return { text: "ok", confidence: 0.8, memory_candidates: [], state_updates: {} };
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

function makeRuntime() {
  const sent: Sent[] = [];
  let mode = "on-device";
  const runtime = new MotebitRuntime(
    {
      motebitId: "owner",
      tickRateHz: 0,
      policy: {
        operatorMode: true,
        maxRiskLevel: RiskLevel.R3_EXECUTE,
        requireApprovalAbove: RiskLevel.R1_DRAFT,
        denyAbove: RiskLevel.R3_EXECUTE,
      },
    },
    {
      storage: createInMemoryStorage(),
      renderer: new NullRenderer(),
      ai: recordingProvider(sent, () => mode),
    },
  );
  const probe = vi.fn(async () => ({ ok: true, data: `result ${TOOL_SECRET}` }));
  runtime.getToolRegistry().register(PROBE, probe);
  const setMode = (m: "on-device" | "byok") => {
    mode = m;
    runtime.setProviderMode(m);
  };
  return { runtime, sent, setMode, probe };
}

/** A Secret memory formed directly — no turn, no tier drop. */
async function formSecretMemory(runtime: MotebitRuntime): Promise<MemoryNode> {
  return runtime.memory.formMemory(
    {
      content: `user pin is ${MEM_SECRET}`,
      confidence: 0.95,
      sensitivity: SensitivityLevel.Secret,
      source: "user_stated",
    },
    new Array<number>(8).fill(0.1),
  );
}

function byokSends(sent: Sent[]): Sent[] {
  return sent.filter((s) => s.mode === "byok");
}

describe("recent events carry only content permitted at the send tier", () => {
  it("a Secret turn's tool_used and a Medical turn's memory_formed never reach the BYOK provider", async () => {
    const { runtime, sent, setMode, probe } = makeRuntime();
    setMode("on-device");
    runtime.setSessionSensitivity(SensitivityLevel.Secret);
    await drain(runtime.sendMessageStreaming("look it up"));
    expect(probe).toHaveBeenCalledTimes(1);
    runtime.setSessionSensitivity(SensitivityLevel.Medical);
    await drain(runtime.sendMessageStreaming("remember the pin"));
    const events = await runtime.events.query({ motebit_id: "owner" });
    expect(JSON.stringify(events)).toContain(TOOL_SECRET);
    expect(JSON.stringify(events)).toContain(MEM_SECRET);

    setMode("byok");
    runtime.setSessionSensitivity(SensitivityLevel.Personal);
    await drain(runtime.sendMessageStreaming("ordinary"));
    await drain(runtime.sendMessageStreaming("another"));

    const byok = byokSends(sent);
    expect(byok.length).toBeGreaterThan(0);
    for (const s of byok) {
      const events = JSON.stringify(s.ctx.recent_events);
      expect(events).not.toContain(TOOL_SECRET);
      expect(events).not.toContain(MEM_SECRET);
    }
    // The Personal-tier exchange is still there — the filter is a tier filter.
    const last = byok.find((s) => s.ctx.user_message === "another")!;
    expect(JSON.stringify(last.ctx.recent_events)).toContain("ordinary");
  });
});

describe("the memory index carries only memories permitted at the send tier", () => {
  it("a Secret memory never enters a BYOK turn's memory index (no tier drop)", async () => {
    const { runtime, sent, setMode } = makeRuntime();
    setMode("byok");
    runtime.setSessionSensitivity(SensitivityLevel.Personal);
    await formSecretMemory(runtime);
    await runtime.memory.formMemory(
      {
        content: "likes tea",
        confidence: 0.9,
        sensitivity: SensitivityLevel.None,
        source: "user_stated",
      },
      new Array<number>(8).fill(0.1),
    );
    await drain(runtime.sendMessageStreaming("hello"));

    const byok = byokSends(sent);
    expect(byok.length).toBeGreaterThan(0);
    expect(byok[0]!.ctx.memoryIndex ?? "").toContain("likes tea");
    for (const s of byok) expect(JSON.stringify(s.ctx)).not.toContain(MEM_SECRET);
  });
});

describe("reflection carries only memories permitted at the send tier", () => {
  it("a Secret memory never reaches the BYOK provider through reflection", async () => {
    const { runtime, sent, setMode } = makeRuntime();
    setMode("byok");
    runtime.setSessionSensitivity(SensitivityLevel.Personal);
    await formSecretMemory(runtime);
    const before = sent.length;
    await runtime.reflect();
    expect(sent.length).toBeGreaterThan(before);
    for (const s of byokSends(sent)) expect(JSON.stringify(s.ctx)).not.toContain(MEM_SECRET);
  });
});

describe("curiosity hints carry only memories permitted at the send tier", () => {
  it("a Secret curiosity target never reaches the BYOK provider", async () => {
    const { runtime, sent, setMode } = makeRuntime();
    setMode("byok");
    runtime.setSessionSensitivity(SensitivityLevel.Personal);
    const node = await formSecretMemory(runtime);
    (
      runtime as unknown as {
        gradientManager: { setCuriosityTargets(t: unknown[]): void };
      }
    ).gradientManager.setCuriosityTargets([
      { node, curiosityScore: 1, decayedConfidence: 0.5, daysSinceAccess: 3 },
    ]);
    await drain(runtime.sendMessageStreaming("hello"));
    const byok = byokSends(sent);
    expect(byok.length).toBeGreaterThan(0);
    for (const s of byok) expect(JSON.stringify(s.ctx)).not.toContain(MEM_SECRET);
  });
});

describe("the on-device provider at Secret tier still receives the interior", () => {
  it("recent events, the memory index and curiosity hints carry the Secret content", async () => {
    const { runtime, sent, setMode } = makeRuntime();
    setMode("on-device");
    runtime.setSessionSensitivity(SensitivityLevel.Secret);
    await drain(runtime.sendMessageStreaming("look it up"));
    await drain(runtime.sendMessageStreaming("remember the pin"));
    const node = await formSecretMemory(runtime);
    (
      runtime as unknown as {
        gradientManager: { setCuriosityTargets(t: unknown[]): void };
      }
    ).gradientManager.setCuriosityTargets([
      { node, curiosityScore: 1, decayedConfidence: 0.5, daysSinceAccess: 3 },
    ]);
    await drain(runtime.sendMessageStreaming("again"));
    const again = sent.find((s) => s.ctx.user_message === "again")!;
    expect(JSON.stringify(again.ctx.recent_events)).toContain(TOOL_SECRET);
    expect(JSON.stringify(again.ctx.recent_events)).toContain(MEM_SECRET);
    expect(again.ctx.memoryIndex ?? "").toContain(MEM_SECRET);
    expect(JSON.stringify(again.ctx.curiosityHints)).toContain(MEM_SECRET);

    const before = sent.length;
    await runtime.reflect();
    const reflection = sent.slice(before);
    expect(reflection.length).toBeGreaterThan(0);
    expect(JSON.stringify(reflection.map((s) => s.ctx))).toContain(MEM_SECRET);
  });
});
