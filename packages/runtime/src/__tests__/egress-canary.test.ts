/**
 * EXHAUSTIVE egress canary: owner interior enters an external provider
 * request only at its send tier — including every artifact DERIVED from
 * interior content.
 *
 * Earlier rounds closed one channel at a time (history, then recent events /
 * memory index / reflection / curiosity) and each round's review found the
 * channel it missed. This harness inverts that: it seeds a DISTINCT canary
 * into every owner-interior store and derivation reachable on the on-device
 * provider at Secret tier, drops to BYOK at Personal, drives EVERY runtime
 * entry point that calls a provider, and asserts no canary appears anywhere
 * in any BYOK request (the context pack AND the system prompt built from it).
 * The same seeding with the on-device provider kept at Secret must see the
 * canaries — the seeds are live, not dead.
 *
 * Canary stores (`CANARY`):
 *   message      — a conversation message (user turn)
 *   summary      — the stored conversation summary (summarizeCurrentConversation)
 *   title        — the AI conversation title (autoTitle)
 *   memFormed    — a memory formed by a turn (Medical: the governor never stores a Secret turn candidate)
 *   memDirect    — a Secret memory formed directly
 *   pinned       — a pinned Secret memory
 *   consolidated — a consolidation-derived Secret memory
 *   tool         — a tool result (tool_used event + intermediate history)
 *   housekeeping — a housekeeping completion (housekeeping_run event)
 *   insight      — a reflection's insights (stored reflection + last-reflection self-awareness)
 *   curiosity    — a curiosity target
 *   goal         — a goal prompt (goal / plan events, plan title)
 *   stepResult   — a plan step's result (accumulated into later steps)
 *   planStep     — a plan step's prompt (derived by decomposition)
 *   approvalArgs — a pending approval's tool arguments
 *
 * Entry points (`ENTRY_POINTS`) — every runtime method that can reach a
 * provider. The static lock at the bottom enumerates every provider call
 * site in packages/ and apps/ and fails when one is not listed in
 * `COVERED_CALL_SITES` with the entry point(s) that drive it here.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Deterministic, offline embeddings (no model load).
vi.mock("@motebit/memory-graph", async () => {
  const actual =
    await vi.importActual<typeof import("@motebit/memory-graph")>("@motebit/memory-graph");
  return { ...actual, embedText: (text: string) => Promise.resolve(actual.embedTextHash(text)) };
});

import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import { buildSystemPrompt } from "@motebit/ai-core";
import { embedTextHash } from "@motebit/memory-graph";
import type {
  AIResponse,
  AgentTask,
  ContextPack,
  ConversationStoreAdapter,
  ToolDefinition,
} from "@motebit/sdk";
import { AgentTaskStatus, MemoryType, RiskLevel, SensitivityLevel } from "@motebit/sdk";
import { generateKeypair } from "@motebit/encryption";

const CANARY = {
  message: "CNRYMESSAGE01",
  summary: "CNRYSUMMARY02",
  title: "CNRYTITLE03",
  memFormed: "CNRYMEMFORMED04",
  memDirect: "CNRYMEMDIRECT05",
  pinned: "CNRYPINNED06",
  consolidated: "CNRYCONSOL07",
  tool: "CNRYTOOL08",
  housekeeping: "CNRYHOUSEKEEP09",
  insight: "CNRYINSIGHT10",
  curiosity: "CNRYCURIOUS11",
  goal: "CNRYGOAL12",
  stepResult: "CNRYSTEPRESULT13",
  planStep: "CNRYPLANSTEP14",
  approvalArgs: "CNRYAPPROVAL15",
} as const;
type CanaryKey = keyof typeof CANARY;
const CANARY_KEYS = Object.keys(CANARY) as CanaryKey[];

const PROBE: ToolDefinition = {
  name: "probe",
  mode: "api",
  description: "Read a value",
  inputSchema: { type: "object", properties: {} },
  riskHint: { risk: RiskLevel.R0_READ },
};
const EXT_WRITE: ToolDefinition = {
  name: "ext_write",
  mode: "api",
  description: "Store a record in the external store",
  inputSchema: { type: "object", properties: { v: { type: "string" } } },
  riskHint: { risk: RiskLevel.R2_WRITE },
};

interface Sent {
  mode: string;
  entry: string;
  seen: string;
}

const LONG = "x".repeat(2400);

/** Answers by prompt shape; records everything the model sees. */
function recordingProvider(
  sent: Sent[],
  mode: () => string,
  entry: () => string,
): StreamingProvider {
  const plain = (text: string, extra: Partial<AIResponse> = {}): AIResponse => ({
    text,
    confidence: 0.8,
    memory_candidates: [],
    state_updates: {},
    ...extra,
  });
  const gen = (ctx: ContextPack): AIResponse => {
    let prompt = "";
    try {
      prompt = buildSystemPrompt(ctx);
    } catch {
      /* a minimal pack may not build a prompt — the JSON still records it */
    }
    sent.push({ mode: mode(), entry: entry(), seen: `${JSON.stringify(ctx)}\n${prompt}` });
    const um = ctx.user_message ?? "";
    // Canaries are produced only on-device at the seeding tier: a BYOK
    // response never mints one, so any canary in a BYOK request leaked.
    const live = mode() === "on-device";
    const c = (k: CanaryKey) => (live ? CANARY[k] : "plain");
    const history = JSON.stringify(ctx.conversation_history ?? []);
    if (um.includes("Generate a very short title")) return plain(`Title ${c("title")}`);
    if (um.includes("Summarize the following episodic")) return plain("a consolidated fact");
    if (
      um.includes("Summarize this conversation") ||
      um.includes("Update the existing conversation summary")
    )
      return plain(`summary ${c("summary")}`);
    if (um.includes("INSIGHTS"))
      return plain(
        `INSIGHTS:\n- insight ${c("insight")}\nADJUSTMENTS:\n- adjust ${c("insight")}\nPATTERNS:\n- pattern\nASSESSMENT:\nfine`,
      );
    if (history.includes("planning engine"))
      return plain(
        JSON.stringify({
          title: "Plan",
          steps: [
            { description: "gather", prompt: "gather the facts" },
            {
              description: "store",
              prompt: um.includes(CANARY.goal) ? `store x ${c("planStep")}` : "store x",
            },
          ],
        }),
      );
    if (um.includes('"summary"') && um.includes("memoryCandidates"))
      return plain(JSON.stringify({ summary: "plan done", memoryCandidates: [] }));
    if (um.includes("gather the facts")) return plain(`step result ${c("stepResult")}`);
    if (um.includes("store x") && !history.includes("tool_result"))
      return plain("", {
        tool_calls: [
          {
            id: "w1",
            name: "ext_write",
            args: { v: um.includes(CANARY.approvalArgs) ? CANARY.approvalArgs : "x" },
          },
        ],
      });
    if (um === "look it up" && !history.includes("tool_result"))
      return plain("", { tool_calls: [{ id: "p1", name: "probe", args: {} }] });
    if (um === "remember the pin")
      return plain("noted", {
        memory_candidates: [
          {
            content: `user pin is ${c("memFormed")}`,
            confidence: 0.9,
            sensitivity: SensitivityLevel.Medical,
          },
        ],
      });
    if (um === "remember the vault")
      return plain("noted", {
        memory_candidates: [
          {
            content: "vault location noted",
            confidence: 0.9,
            sensitivity: SensitivityLevel.Personal,
          },
        ],
      });
    if (um.startsWith("You are a memory consolidation engine")) return plain('{"action":"add"}');
    if (um.startsWith("long")) return plain(LONG);
    return plain("ok");
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

async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

/** A conversation store that keeps messages, summaries and titles. */
function conversationStore(): ConversationStoreAdapter {
  const convs = new Map<
    string,
    { startedAt: number; lastActiveAt: number; summary: string | null; title: string | null }
  >();
  const messages = new Map<string, ReturnType<ConversationStoreAdapter["loadMessages"]>>();
  let active: string | null = null;
  let n = 0;
  return {
    createConversation: () => {
      const id = `conv-${++n}`;
      const now = Date.now();
      convs.set(id, { startedAt: now, lastActiveAt: now, summary: null, title: null });
      messages.set(id, []);
      active = id;
      return id;
    },
    appendMessage: (conversationId, motebitId, msg) => {
      const list = messages.get(conversationId) ?? [];
      list.push({
        messageId: `m-${list.length}`,
        conversationId,
        motebitId,
        role: msg.role,
        content: msg.content,
        toolCalls: null,
        toolCallId: null,
        createdAt: Date.now(),
        tokenEstimate: 1,
        ...(msg.sensitivity != null ? { sensitivity: msg.sensitivity } : {}),
      });
      messages.set(conversationId, list);
    },
    loadMessages: (conversationId) => [...(messages.get(conversationId) ?? [])],
    getActiveConversation: () => {
      if (active == null) return null;
      const c = convs.get(active)!;
      return {
        conversationId: active,
        startedAt: c.startedAt,
        lastActiveAt: c.lastActiveAt,
        summary: c.summary,
      };
    },
    updateSummary: (id, s) => {
      const c = convs.get(id);
      if (c) c.summary = s;
    },
    updateTitle: (id, t) => {
      const c = convs.get(id);
      if (c) c.title = t;
    },
    listConversations: () =>
      [...convs.entries()].map(([conversationId, c]) => ({
        conversationId,
        startedAt: c.startedAt,
        lastActiveAt: c.lastActiveAt,
        title: c.title,
        messageCount: messages.get(conversationId)?.length ?? 0,
      })),
    deleteConversation: (id) => {
      convs.delete(id);
      messages.delete(id);
    },
  };
}

type Harness = Awaited<ReturnType<typeof makeRuntime>>;

async function makeRuntime() {
  const sent: Sent[] = [];
  let mode = "on-device";
  let entry = "seed";
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
      storage: { ...createInMemoryStorage(), conversationStore: conversationStore() },
      renderer: new NullRenderer(),
      ai: recordingProvider(
        sent,
        () => mode,
        () => entry,
      ),
    },
  );
  runtime.getToolRegistry().register(
    PROBE,
    vi.fn(async () => ({
      ok: true,
      data: `result ${tierOf(runtime) === SensitivityLevel.Secret ? CANARY.tool : "plain"}`,
    })),
  );
  runtime.getToolRegistry().register(
    EXT_WRITE,
    vi.fn(async () => ({ ok: true, data: "stored" })),
  );
  const setMode = (m: "on-device" | "byok") => {
    mode = m;
    runtime.setProviderMode(m);
  };
  const setEntry = (e: string) => {
    entry = e;
  };
  /** Return to the mode/tier the run under test drives (set by `runEntry`). */
  const target = { onDevice: false };
  const toTarget = () => {
    setMode(target.onDevice ? "on-device" : "byok");
    runtime.setSessionSensitivity(
      target.onDevice ? SensitivityLevel.Secret : SensitivityLevel.Personal,
    );
  };
  return { runtime, sent, setMode, setEntry, planId: "", target, toTarget };
}

const tierOf = (runtime: MotebitRuntime): SensitivityLevel =>
  (
    runtime as unknown as { getEffectiveSessionSensitivity(): SensitivityLevel }
  ).getEffectiveSessionSensitivity();

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Seed every interior store at Secret on the on-device provider. */
async function seedAtSecret(h: Harness): Promise<void> {
  const { runtime } = h;
  h.setMode("on-device");
  h.setEntry("seed");
  runtime.setSessionSensitivity(SensitivityLevel.Secret);

  // First, so its housekeeping_run event is inside the recent-events window.
  await runtime.generateCompletion(`classify ${CANARY.housekeeping}`);
  await drain(runtime.sendMessageStreaming(`my code is ${CANARY.message}`));
  await settle(); // the AI title (fire-and-forget from pushExchange)
  await drain(runtime.sendMessageStreaming("look it up"));
  runtime.setSessionSensitivity(SensitivityLevel.Medical);
  await drain(runtime.sendMessageStreaming("remember the pin"));
  await runtime.awaitPendingMemoryFormation?.();
  runtime.setSessionSensitivity(SensitivityLevel.Secret);

  const emb = (s: string) => embedTextHash(s);
  await runtime.memory.formMemory(
    {
      content: `door code ${CANARY.memDirect}`,
      confidence: 0.95,
      sensitivity: SensitivityLevel.Secret,
      source: "user_stated",
    },
    emb("door code"),
  );
  const pinned = await runtime.memory.formMemory(
    {
      content: `vault ${CANARY.pinned}`,
      confidence: 0.95,
      sensitivity: SensitivityLevel.Secret,
      source: "user_stated",
    },
    emb("vault location noted"),
  );
  await runtime.memory.pinMemory(pinned.node_id, true);
  // A context-safe neighbor of the pinned Secret memory, so a later
  // memory-formation turn reaches the consolidation classifier at all.
  await runtime.memory.formMemory(
    {
      content: "the vault is in the hall",
      confidence: 0.9,
      sensitivity: SensitivityLevel.Personal,
      source: "user_stated",
    },
    emb("vault location noted"),
  );
  await runtime.memory.formMemory(
    {
      content: `consolidated ${CANARY.consolidated}`,
      confidence: 0.9,
      sensitivity: SensitivityLevel.Secret,
      source: "consolidation_derived",
      memory_type: MemoryType.Semantic,
    },
    emb("consolidated"),
  );
  const curious = await runtime.memory.formMemory(
    {
      content: `fading ${CANARY.curiosity}`,
      confidence: 0.6,
      sensitivity: SensitivityLevel.Secret,
      source: "user_stated",
    },
    emb("fading"),
  );
  (
    runtime as unknown as { gradientManager: { setCuriosityTargets(t: unknown[]): void } }
  ).gradientManager.setCuriosityTargets([
    { node: curious, curiosityScore: 1, decayedConfidence: 0.5, daysSinceAccess: 3 },
  ]);

  await runtime.summarizeCurrentConversation();
  await runtime.reflect();

  // A plan created at Secret: step 1 completes, step 2 waits on approval.
  const chunks = (await drain(runtime.executePlan("goal-1", `goal ${CANARY.goal}`))) as Array<{
    type: string;
    plan?: { plan_id: string };
  }>;
  h.planId = chunks.find((c) => c.plan != null)?.plan?.plan_id ?? "";
  await settle();
}

/** Every runtime entry point that can reach a provider, driven on BYOK at Personal. */
const ENTRY_POINTS: Record<string, (h: Harness) => Promise<void>> = {
  "sendMessageStreaming (normal turn)": async ({ runtime }) => {
    await drain(runtime.sendMessageStreaming("hello there"));
  },
  "sendMessage (non-streaming turn)": async ({ runtime }) => {
    await runtime.sendMessage("hello again");
  },
  "sendMessageStreaming (long conversation, history trimmed)": async ({ runtime }) => {
    for (let i = 0; i < 12; i++) await drain(runtime.sendMessageStreaming(`long ${i} ${LONG}`));
  },
  "sendMessageStreaming (tool turn)": async ({ runtime }) => {
    await drain(runtime.sendMessageStreaming("look it up"));
  },
  "sendMessageStreaming (memory formation: consolidation classify)": async (h) => {
    await drain(h.runtime.sendMessageStreaming("remember the vault"));
    await h.runtime.awaitPendingMemoryFormation();
    // The classifier request was made — the neighbor set is what it filters.
    // (On-device at Secret the candidate floors to Secret, which the
    // governor never stores from a turn, so no classify runs there.)
    if (!h.target.onDevice)
      expect(h.sent.some((s) => s.seen.includes("memory consolidation engine"))).toBe(true);
  },
  resumeAfterApproval: async ({ runtime }) => {
    await drain(runtime.sendMessageStreaming("store x"));
    await drain(runtime.resumeAfterApproval(true));
  },
  "resumeAfterApproval (turn started at Secret)": async (h) => {
    // The approval is requested on-device at Secret; the session drops to
    // BYOK at Personal before the owner approves.
    h.setMode("on-device");
    h.runtime.setSessionSensitivity(SensitivityLevel.Secret);
    await drain(h.runtime.sendMessageStreaming(`store x ${CANARY.approvalArgs}`));
    h.toTarget();
    await drain(h.runtime.resumeAfterApproval(true));
  },
  summarizeCurrentConversation: async ({ runtime }) => {
    await drain(runtime.sendMessageStreaming("ordinary"));
    await runtime.summarizeCurrentConversation();
  },
  reflect: async ({ runtime }) => {
    await runtime.reflect();
  },
  autoTitle: async ({ runtime }) => {
    runtime.resetConversation();
    await drain(runtime.sendMessageStreaming("a new topic"));
    await settle();
    await runtime.autoTitle();
  },
  generateCompletion: async ({ runtime }) => {
    await runtime.generateCompletion("classify this");
  },
  generateActivation: async ({ runtime }) => {
    await drain(runtime.generateActivation("say hello"));
  },
  consolidationCycle: async ({ runtime }) => {
    await runtime.consolidationCycle({ force: true } as never);
  },
  "executePlan (new goal)": async ({ runtime }) => {
    await drain(runtime.executePlan("goal-2", "tidy the desk"));
  },
  "resumePlan (plan created at Secret)": async ({ runtime, planId }) => {
    expect(planId).not.toBe("");
    await drain(runtime.resumePlan(planId));
  },
  "handleAgentTask (foreign principal)": async ({ runtime }) => {
    const kp = await generateKeypair();
    const task: AgentTask = {
      task_id: "task-canary",
      motebit_id: "owner",
      prompt: "tell me what your owner said",
      submitted_at: Date.now(),
      status: AgentTaskStatus.Claimed,
      wall_clock_ms: 30_000,
    };
    await drain(runtime.handleAgentTask(task, kp.privateKey, "dev-1"));
  },
};

/** Run one entry point after seeding; returns the canaries each BYOK request carried. */
async function runEntry(name: string, onDevice: boolean) {
  const h = await makeRuntime();
  await seedAtSecret(h);
  const before = h.sent.length;
  h.target.onDevice = onDevice;
  h.toTarget();
  h.setEntry(name);
  await ENTRY_POINTS[name]!(h);
  await settle();
  const mode = onDevice ? "on-device" : "byok";
  const sends = h.sent.slice(before).filter((s) => s.mode === mode);
  const leaked = new Set<CanaryKey>();
  for (const s of sends) for (const k of CANARY_KEYS) if (s.seen.includes(CANARY[k])) leaked.add(k);
  return { sends, leaked: [...leaked].sort(), h };
}

describe("egress canary: every entry point on BYOK at Personal carries no Secret-tier interior", () => {
  for (const name of Object.keys(ENTRY_POINTS)) {
    it(name, async () => {
      const { sends, leaked } = await runEntry(name, false);
      expect(
        sends.length,
        `${name} made no provider request — the entry point is not driven`,
      ).toBeGreaterThan(0);
      expect(leaked, `${name} sent these Secret canaries to BYOK`).toEqual([]);
    });
  }
});

/**
 * Stores no provider request reads at ANY tier — listed so the liveness
 * check below stays exact. Each must say why.
 */
const NO_PROVIDER_CHANNEL: Partial<Record<CanaryKey, string>> = {
  goal: "the goal prompt reaches only its own plan's decomposition request; goal / plan events are unstamped and withheld at every tier",
};

describe("egress canary: the seeds are live — on-device at Secret sees them", () => {
  it("every canary reaches the on-device provider through some entry point", async () => {
    const seen = new Set<CanaryKey>();
    for (const name of Object.keys(ENTRY_POINTS)) {
      const { leaked } = await runEntry(name, true);
      for (const k of leaked) seen.add(k as CanaryKey);
    }
    const expected = CANARY_KEYS.filter((k) => !(k in NO_PROVIDER_CHANNEL));
    expect([...seen].sort()).toEqual([...expected].sort());
  });

  it("the derived summary rides the trimmed history on-device", async () => {
    const { sends } = await runEntry(
      "sendMessageStreaming (long conversation, history trimmed)",
      true,
    );
    expect(
      sends.some((s) =>
        s.seen.includes(`[Earlier in this conversation: summary ${CANARY.summary}`),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Static completeness lock: every provider call site is covered above.
// ---------------------------------------------------------------------------

/**
 * Every provider request call site in packages/ and apps/ (non-test source),
 * keyed `path` → the number of call sites in that file, with the entry
 * point(s) in `ENTRY_POINTS` that drive them (or why none is needed).
 */
const COVERED_CALL_SITES: Record<string, { count: number; coveredBy: string }> = {
  "packages/ai-core/src/loop.ts": {
    count: 2,
    coveredBy:
      "every turn entry point (sendMessage*, resumeAfterApproval, generateActivation, plan steps, handleAgentTask)",
  },
  "packages/ai-core/src/summarizer.ts": { count: 1, coveredBy: "summarizeCurrentConversation" },
  "packages/ai-core/src/reflection.ts": { count: 1, coveredBy: "reflect" },
  "packages/planner/src/decompose.ts": { count: 1, coveredBy: "executePlan (new goal)" },
  "packages/planner/src/reflect.ts": {
    count: 1,
    coveredBy: "executePlan / resumePlan (post-plan reflection)",
  },
  "packages/runtime/src/consolidation-cycle.ts": { count: 1, coveredBy: "consolidationCycle" },
  "packages/runtime/src/motebit-runtime.ts": {
    count: 3,
    coveredBy:
      "generateCompletion; the conversation's title dep (autoTitle); memory consolidation classify (memory-formation turn)",
  },
  "packages/runtime/src/conversation.ts": { count: 1, coveredBy: "autoTitle" },
  "packages/runtime/src/secret-redacting-provider.ts": {
    count: 2,
    coveredBy: "provider wrapper — forwards the caller's pack; covered by its callers",
  },
  "apps/desktop/src/conversation-manager.ts": {
    count: 0,
    coveredBy: "desktop /summarize routes to summarizeCurrentConversation",
  },
  "apps/spatial/src/heartbeat.ts": {
    count: 1,
    coveredBy: "generateCompletion (a fixed prompt: no interior)",
  },
  "apps/web/src/providers.ts": {
    count: 1,
    coveredBy: "provider implementation (generate → own generateStream)",
  },
  "apps/spatial/src/providers.ts": {
    count: 1,
    coveredBy: "provider implementation (generate → own generateStream)",
  },
  "apps/mobile/src/adapters/local-inference.ts": {
    count: 1,
    coveredBy: "provider implementation (generate → own generateStream)",
  },
};

const CALL_SITE = /\.(generate|generateStream|generateCompletion)\(/g;
const ROOT = join(__dirname, "../../../..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__tests__" || name.startsWith("."))
      continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec|d)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Call sites per file, comments stripped. */
export function scanProviderCallSites(root: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const top of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(root, top))) {
      const src = join(root, top, pkg, "src");
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of sourceFiles(src)) {
        const code = readFileSync(file, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
        const n = (code.match(CALL_SITE) ?? []).length;
        if (n > 0) counts[relative(root, file)] = n;
      }
    }
  }
  return counts;
}

describe("egress canary: static completeness lock", () => {
  it("every provider call site in packages/ and apps/ is covered by an entry point above", () => {
    const found = scanProviderCallSites(ROOT);
    const problems: string[] = [];
    for (const [file, n] of Object.entries(found)) {
      const covered = COVERED_CALL_SITES[file];
      if (covered == null || covered.count !== n) {
        problems.push(
          `${file}: ${n} provider call site(s), table lists ${covered?.count ?? 0}. ` +
            `Repair: drive the new call site's runtime entry point in ENTRY_POINTS of ` +
            `packages/runtime/src/__tests__/egress-canary.test.ts (seeded canaries must not reach BYOK), ` +
            `then record it in COVERED_CALL_SITES with the entry point that covers it.`,
        );
      }
    }
    for (const [file, c] of Object.entries(COVERED_CALL_SITES)) {
      if (c.count > 0 && found[file] == null)
        problems.push(
          `${file}: listed with ${c.count} call site(s) but none found — update COVERED_CALL_SITES.`,
        );
    }
    expect(
      problems,
      `examined ${Object.keys(found).length} files with provider call sites`,
    ).toEqual([]);
  });
});
