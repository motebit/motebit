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
 *   goalSummary  — a scheduled goal run's saved outcome summary (read by the next run)
 *   subGoal      — a sub-goal prompt the model wrote during a Secret goal run
 *
 * Entry points (`ENTRY_POINTS`) — every runtime method that can reach a
 * provider. The static lock at the bottom enumerates every provider call
 * site in packages/ and apps/ — TYPE-AWARE (`provider-egress-lock.ts`: any
 * access, element access, destructuring, any/unknown erasure, or narrowing
 * into a slot not typed as a provider, of a provider-typed value, and the
 * erasure of a container that carries one; its header names the aperture)
 * — and fails when one is not listed in
 * `COVERED_CALL_SITES` with the entry point(s) that drive it here.
 *
 * Built-in tools that read the interior (list_events, search_conversations,
 * recall_memories, self_reflect) are registered exactly as the surfaces wire
 * them and driven as entry points; remote embeddings are covered by
 * `egress-embed-canary.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// Deterministic, offline embeddings (no model load).
vi.mock("@motebit/memory-graph", async () => {
  const actual =
    await vi.importActual<typeof import("@motebit/memory-graph")>("@motebit/memory-graph");
  return { ...actual, embedText: (text: string) => Promise.resolve(actual.embedTextHash(text)) };
});

import {
  MotebitRuntime,
  NullRenderer,
  SovereignTierRequiredError,
  TurnPrincipal,
  createInMemoryStorage,
} from "../index";
import { registerBrowserSafeBuiltins } from "@motebit/tools/web-safe";
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
import {
  AgentTaskStatus,
  EventType,
  MemoryType,
  PlanStatus,
  RiskLevel,
  SensitivityLevel,
  StepStatus,
} from "@motebit/sdk";
import type { InMemoryPlanStore } from "@motebit/planner";
import { InMemoryPlanStore as InMemoryPlanStoreImpl, PlanEngine } from "@motebit/planner";
import { createSubGoalDefinition } from "@motebit/tools/web-safe";
import type { GoalRunScope } from "../index";
import { generateKeypair } from "@motebit/encryption";
import { findProviderSites } from "./provider-egress-lock";

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
  goalSummary: "CNRYGOALSUMMARY16",
  subGoal: "CNRYSUBGOAL17",
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

/**
 * The built-in tools that READ the owner interior, with the args the model
 * calls them with — each query is aimed at the seeded canaries.
 */
const BUILTIN_TOOL_ARGS: Record<string, Record<string, unknown>> = {
  list_events: { limit: 500 },
  search_conversations: { query: "my code is pin vault", limit: 50 },
  recall_memories: { query: "door code vault consolidated fading pin", limit: 50 },
  self_reflect: {},
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
  aboveContextSafe: () => boolean = () => true,
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
    // Canaries are produced only on-device at a seeding tier (medical+): a
    // BYOK or context-safe-tier response never mints one, so any canary in
    // such a request leaked.
    const live = mode() === "on-device" && aboveContextSafe();
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
    // Built-in interior-reading tools: one call, then answer from the result.
    const builtin = /^use tool ([a-z_]+)$/.exec(um)?.[1];
    if (builtin != null && !history.includes(`t-${builtin}`))
      return plain("", {
        tool_calls: [{ id: `t-${builtin}`, name: builtin, args: BUILTIN_TOOL_ARGS[builtin] ?? {} }],
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
    if (um.startsWith("You are executing a scheduled goal")) {
      if (um.includes(CANARY.goal) && live && !history.includes("t-subgoal"))
        return plain("", {
          tool_calls: [
            { id: "t-subgoal", name: "create_sub_goal", args: { prompt: `sub ${c("subGoal")}` } },
          ],
        });
      return plain(`run done ${c("goalSummary")}`);
    }
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
  const store = conversationStore();
  let rt: MotebitRuntime | null = null;
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
      storage: { ...createInMemoryStorage(), conversationStore: store },
      renderer: new NullRenderer(),
      ai: recordingProvider(
        sent,
        () => mode,
        () => entry,
        () =>
          rt == null || ![SensitivityLevel.None, SensitivityLevel.Personal].includes(tierOf(rt)),
      ),
    },
  );
  rt = runtime;
  runtime.getToolRegistry().register(
    PROBE,
    vi.fn(async () => ({
      ok: true,
      data: `result ${tierOf(runtime) === SensitivityLevel.Secret ? CANARY.tool : "plain"}`,
    })),
  );
  // The built-in tools, wired EXACTLY as the surfaces wire them
  // (apps/desktop/src/desktop-tools.ts, web-app.ts, mobile-app.ts, cli
  // runtime-factory.ts) — the harness drives the real handlers.
  registerBrowserSafeBuiltins(runtime.getToolRegistry(), {
    memorySearchFn: (query, opts) =>
      runtime.recallMemoriesForTool(query, opts, TurnPrincipal.OWNER),
    eventQueryFn: (limit, eventType) => runtime.queryEventsForTool(limit, eventType),
    reflectFn: () => runtime.reflect(),
    conversationSearchFn: (query, limit) => runtime.searchConversations(query, limit),
  });
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
  return { runtime, sent, setMode, setEntry, planId: "", target, toTarget, store };
}

const tierOf = (runtime: MotebitRuntime): SensitivityLevel =>
  (
    runtime as unknown as { getEffectiveSessionSensitivity(): SensitivityLevel }
  ).getEffectiveSessionSensitivity();

const settle = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Scheduled goals — the goal-scheduler shape every surface shares (desktop
// goal-scheduler.ts, cli scheduler.ts, mobile goal-scheduler.ts): a goal
// store, saved run outcomes, a create_sub_goal tool, and a tick that builds
// each run's prompt through `runtime.beginGoalRun`. The surfaces' own
// schedulers are driven against a real runtime in their app tests
// (`goal-egress-canary.test.ts` in apps/desktop, apps/cli, apps/mobile).
// ---------------------------------------------------------------------------

interface HarnessGoal {
  goal_id: string;
  prompt: string;
  mode: string;
  sensitivity?: SensitivityLevel;
  parent_goal_id?: string | null;
}
interface HarnessOutcome {
  goal_id: string;
  ran_at: number;
  status: string;
  summary: string | null;
  error_message: string | null;
  sensitivity?: SensitivityLevel;
}

function goalBook(runtime: MotebitRuntime) {
  const goals: HarnessGoal[] = [];
  const outcomes: HarnessOutcome[] = [];
  let current: { goalId: string; run: GoalRunScope } | null = null;
  runtime.getToolRegistry().register(
    { ...createSubGoalDefinition, riskHint: { risk: RiskLevel.R0_READ } },
    vi.fn(async (args: Record<string, unknown>) => {
      if (current == null) return { ok: false, error: "No active goal context" };
      goals.push({
        goal_id: `sub-${goals.length}`,
        prompt: String(args.prompt),
        mode: "recurring",
        parent_goal_id: current.goalId,
        sensitivity: current.run.outcomeSensitivity(),
      });
      return { ok: true, data: "created" };
    }),
  );
  /** One scheduler tick: every goal runs once; refusals are recorded as failed outcomes. */
  const tick = async (planEngine?: PlanEngine): Promise<{ refused: string[] }> => {
    const refused: string[] = [];
    for (const goal of [...goals]) {
      const prior = outcomes
        .filter((o) => o.goal_id === goal.goal_id)
        .sort((a, b) => b.ran_at - a.ran_at)
        .slice(0, 3);
      let run: GoalRunScope;
      try {
        run = runtime.beginGoalRun(goal);
      } catch (err) {
        if (!(err instanceof SovereignTierRequiredError)) throw err;
        refused.push(goal.goal_id);
        continue;
      }
      current = { goalId: goal.goal_id, run };
      let text = "";
      try {
        if (planEngine != null && goal.parent_goal_id == null && goal.mode === "plan") {
          const created = await planEngine.createPlan(
            goal.goal_id,
            "owner",
            { goalPrompt: goal.prompt, previousOutcomes: run.planOutcomes(prior) },
            runtime.getLoopDeps()!,
          );
          for await (const chunk of planEngine.executePlan(
            created.plan.plan_id,
            runtime.getLoopDeps()!,
          ))
            if (chunk.type === "step_completed") text += chunk.step.result_summary ?? "";
        } else {
          for await (const chunk of runtime.sendMessageStreaming(
            run.prompt(goal, prior, Date.now()),
          ))
            if ((chunk as { type: string }).type === "text")
              text += (chunk as { text: string }).text;
        }
      } finally {
        run.end();
        current = null;
      }
      outcomes.push({
        goal_id: goal.goal_id,
        ran_at: Date.now() + outcomes.length,
        status: "completed",
        summary: text.slice(0, 200),
        error_message: null,
        sensitivity: run.outcomeSensitivity(),
      });
      runtime.resetConversation();
    }
    return { refused };
  };
  return { goals, outcomes, tick };
}

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
  ...Object.fromEntries(
    Object.keys(BUILTIN_TOOL_ARGS).map((tool) => [
      `built-in tool: ${tool}`,
      async (h: Harness) => {
        const before = h.sent.length;
        await drain(h.runtime.sendMessageStreaming(`use tool ${tool}`));
        // The tool ran and its result reached the provider (the request after it).
        const toolResultId = JSON.stringify(`t-${tool}`);
        expect(
          h.sent.slice(before).some((s) => s.seen.includes(`"tool_call_id":${toolResultId}`)),
          `${tool}'s result never reached a request — the tool did not run`,
        ).toBe(true);
      },
    ]),
  ),
  "goal scheduler tick (goals, outcomes and sub-goals written at Secret)": async (h) => {
    // Seed on-device at Secret: a goal written at Secret, a goal written at
    // Personal, one Secret-tier run of each (the Secret goal's run writes a
    // sub-goal), and a legacy unstamped outcome.
    const book = goalBook(h.runtime);
    h.setMode("on-device");
    h.runtime.setSessionSensitivity(SensitivityLevel.Secret);
    book.goals.push({
      goal_id: "g-secret",
      prompt: `goal ${CANARY.goal}`,
      mode: "recurring",
      sensitivity: h.runtime.goalCreationSensitivity(),
    });
    book.goals.push({
      goal_id: "g-plain",
      prompt: "tidy the desk",
      mode: "recurring",
      sensitivity: SensitivityLevel.Personal,
    });
    book.goals.push({ goal_id: "g-plan", prompt: "plan the week", mode: "plan" });
    const planEngine = new PlanEngine(new InMemoryPlanStoreImpl());
    await book.tick(planEngine);
    book.outcomes.push({
      goal_id: "g-plain",
      ran_at: 1,
      status: "completed",
      summary: `legacy ${CANARY.goalSummary}`,
      error_message: null,
    });
    book.outcomes.push({
      goal_id: "g-plan",
      ran_at: 2,
      status: "completed",
      summary: `planned ${CANARY.goalSummary}`,
      error_message: null,
      sensitivity: SensitivityLevel.Secret,
    });
    expect(book.goals.some((g) => g.parent_goal_id === "g-secret")).toBe(true);
    h.toTarget();
    const { refused } = await book.tick(planEngine);
    if (!h.target.onDevice) {
      // The Secret goal and its sub-goal refuse on BYOK; the Personal goals run.
      expect(refused.sort()).toEqual(["g-secret", "sub-3"]);
    } else {
      expect(refused).toEqual([]);
    }
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
  let refused: unknown = null;
  try {
    await ENTRY_POINTS[name]!(h);
  } catch (err) {
    if (!(err instanceof SovereignTierRequiredError)) throw err;
    refused = err;
  }
  await settle();
  const mode = onDevice ? "on-device" : "byok";
  const sends = h.sent.slice(before).filter((s) => s.mode === mode);
  const leaked = new Set<CanaryKey>();
  for (const s of sends) for (const k of CANARY_KEYS) if (s.seen.includes(CANARY[k])) leaked.add(k);
  return { sends, leaked: [...leaked].sort(), h, refused };
}

/**
 * Entry points whose whole content is a DERIVED artifact produced at Secret
 * (the paused turn, the plan's steps): on BYOK the only safe outcome is the
 * gate's refusal before any request — the call is a send at the artifact's
 * tier. On-device they run.
 */
const REFUSED_ON_BYOK = new Set([
  "resumeAfterApproval (turn started at Secret)",
  "resumePlan (plan created at Secret)",
]);

describe("egress canary: every entry point on BYOK at Personal carries no Secret-tier interior", () => {
  for (const name of Object.keys(ENTRY_POINTS)) {
    it(name, async () => {
      const { sends, leaked, refused } = await runEntry(name, false);
      if (REFUSED_ON_BYOK.has(name)) {
        expect(refused, `${name} must be refused on BYOK (its content is Secret)`).toBeInstanceOf(
          SovereignTierRequiredError,
        );
      } else {
        expect(refused, `${name} was refused`).toBeNull();
        expect(
          sends.length,
          `${name} made no provider request — the entry point is not driven`,
        ).toBeGreaterThan(0);
      }
      expect(leaked, `${name} sent these Secret canaries to BYOK`).toEqual([]);
    });
  }
});

describe("egress canary: an interior-reading tool returns only what the CURRENT send tier permits", () => {
  // On-device below Secret: the request is not external, but everything it
  // carries can come back in the reply, which is stamped at the turn's tier
  // and then rides history into a later BYOK request. So the tool's result is
  // held to the send tier, not to the provider — the same rule as the
  // context pack.
  for (const tool of Object.keys(BUILTIN_TOOL_ARGS)) {
    it(`${tool} on-device at Personal carries no Secret canary`, async () => {
      const h = await makeRuntime();
      await seedAtSecret(h);
      h.setMode("on-device");
      h.runtime.setSessionSensitivity(SensitivityLevel.Personal);
      h.setEntry(`tier:${tool}`);
      const before = h.sent.length;
      await drain(h.runtime.sendMessageStreaming(`use tool ${tool}`));
      const sends = h.sent.slice(before);
      expect(sends.some((s) => s.seen.includes(`"tool_call_id":"t-${tool}"`))).toBe(true);
      const leaked = CANARY_KEYS.filter((k) => sends.some((s) => s.seen.includes(CANARY[k])));
      expect(leaked, `${tool} at Personal returned Secret canaries`).toEqual([]);
    });
  }
});

/**
 * Stores no provider request reads at ANY tier — listed so the liveness
 * check below stays exact. Each must say why.
 */
const NO_PROVIDER_CHANNEL: Partial<Record<CanaryKey, string>> = {};

describe("egress canary: the seeds are live — on-device at Secret sees them", () => {
  it("every canary reaches the on-device provider through some entry point", async () => {
    const seen = new Set<CanaryKey>();
    for (const name of Object.keys(ENTRY_POINTS)) {
      const { leaked, refused } = await runEntry(name, true);
      expect(refused, `${name} was refused on-device at Secret`).toBeNull();
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

describe("egress canary: a legacy (unstamped) derived artifact fails closed", () => {
  const LEGACY = "LEGACYDERIVED99";

  async function byokConversation() {
    const h = await makeRuntime();
    h.setMode("byok");
    h.runtime.setSessionSensitivity(SensitivityLevel.Personal);
    await drain(h.runtime.sendMessageStreaming("hello"));
    const id = h.runtime.getConversationId()!;
    return { h, id };
  }
  async function trimmedTurnSees(h: Harness, text: string): Promise<boolean> {
    const before = h.sent.length;
    for (let i = 0; i < 8; i++) await drain(h.runtime.sendMessageStreaming(`long ${i} ${LONG}`));
    return h.sent.slice(before).some((s) => s.seen.includes(text));
  }

  it("an unstamped summary is held to its conversation's stored messages — Personal: sent", async () => {
    const { h, id } = await byokConversation();
    h.store.updateSummary(id, `legacy ${LEGACY}`);
    expect(await trimmedTurnSees(h, LEGACY)).toBe(true);
  });

  it("an unstamped summary over a Secret message is withheld", async () => {
    const { h, id } = await byokConversation();
    h.store.appendMessage(id, "owner", {
      role: "user",
      content: "synced from elsewhere",
      sensitivity: SensitivityLevel.Secret,
    });
    h.store.updateSummary(id, `legacy ${LEGACY}`);
    expect(await trimmedTurnSees(h, LEGACY)).toBe(false);
  });

  it("an unstamped summary over an unstamped message is withheld (unknowable)", async () => {
    const { h, id } = await byokConversation();
    h.store.appendMessage(id, "owner", { role: "user", content: "pre-floor message" });
    h.store.updateSummary(id, `legacy ${LEGACY}`);
    expect(await trimmedTurnSees(h, LEGACY)).toBe(false);
  });

  it("an unstamped history message (pre-floor row, older sync peer) is withheld from BYOK; sent on-device at Secret", async () => {
    for (const [mode, tier, expected] of [
      ["byok", SensitivityLevel.Personal, false],
      ["on-device", SensitivityLevel.Personal, false],
      ["on-device", SensitivityLevel.Secret, true],
    ] as const) {
      const h = await makeRuntime();
      const id = h.store.createConversation("owner");
      h.store.appendMessage(id, "owner", { role: "user", content: `old ${LEGACY}` });
      h.store.appendMessage(id, "owner", {
        role: "assistant",
        content: "stamped reply",
        sensitivity: SensitivityLevel.Personal,
      });
      h.runtime.loadConversation(id);
      h.setMode(mode);
      h.runtime.setSessionSensitivity(tier);
      const before = h.sent.length;
      await drain(h.runtime.sendMessageStreaming("hello"));
      const sends = h.sent.slice(before);
      expect(
        sends.some((s) => s.seen.includes(LEGACY)),
        `${mode} at ${tier}`,
      ).toBe(expected);
      // A Personal-stamped message is context-safe: it rides every request.
      expect(
        sends.some((s) => s.seen.includes("stamped reply")),
        `${mode} at ${tier}`,
      ).toBe(true);
    }
  });

  it("a Personal-stamped message rides a request at the default (none) tier — the ceiling, not the raw tier", async () => {
    const h = await makeRuntime();
    const id = h.store.createConversation("owner");
    h.store.appendMessage(id, "owner", {
      role: "user",
      content: "earlier PERSONALCTX",
      sensitivity: SensitivityLevel.Personal,
    });
    h.runtime.loadConversation(id);
    h.setMode("byok");
    h.runtime.setSessionSensitivity(SensitivityLevel.None);
    const before = h.sent.length;
    await drain(h.runtime.sendMessageStreaming("hello"));
    expect(h.sent.slice(before).some((s) => s.seen.includes("PERSONALCTX"))).toBe(true);
  });

  it("an unstamped plan is refused on BYOK and runs on-device", async () => {
    const h = await makeRuntime();
    const planStore = (h.runtime as unknown as { planStore: InMemoryPlanStore }).planStore;
    planStore.savePlan({
      plan_id: "legacy-plan",
      goal_id: "g",
      motebit_id: "owner",
      title: "legacy",
      status: PlanStatus.Active,
      created_at: Date.now(),
      updated_at: Date.now(),
      current_step_index: 0,
      total_steps: 1,
    } as never);
    planStore.saveStep({
      step_id: "legacy-step",
      plan_id: "legacy-plan",
      ordinal: 0,
      description: "d",
      prompt: `do ${LEGACY}`,
      depends_on: [],
      optional: false,
      status: StepStatus.Pending,
      result_summary: null,
      error_message: null,
      tool_calls_made: 0,
      started_at: null,
      completed_at: null,
      retry_count: 0,
      updated_at: Date.now(),
    } as never);
    h.setMode("byok");
    h.runtime.setSessionSensitivity(SensitivityLevel.Personal);
    await expect(drain(h.runtime.resumePlan("legacy-plan"))).rejects.toBeInstanceOf(
      SovereignTierRequiredError,
    );
    expect(h.sent.some((s) => s.seen.includes(LEGACY))).toBe(false);

    h.setMode("on-device");
    await drain(h.runtime.resumePlan("legacy-plan"));
    expect(h.sent.some((s) => s.mode === "on-device" && s.seen.includes(LEGACY))).toBe(true);
  });

  it("a reflection restored without a stamp never enters a BYOK prompt; a Personal one does", async () => {
    for (const [stamp, expected] of [
      [undefined, false],
      [SensitivityLevel.Personal, true],
    ] as const) {
      const h = await makeRuntime();
      await h.runtime.events.appendWithClock({
        event_id: crypto.randomUUID(),
        motebit_id: "owner",
        timestamp: Date.now(),
        event_type: EventType.ReflectionCompleted,
        payload: {
          insights: [`restored ${LEGACY}`],
          ...(stamp != null ? { sensitivity: stamp } : {}),
        },
        tombstoned: false,
      });
      await (
        h.runtime as unknown as {
          gradientManager: { restoreLastReflection(): Promise<void> };
        }
      ).gradientManager.restoreLastReflection();
      h.setMode("byok");
      h.runtime.setSessionSensitivity(SensitivityLevel.Personal);
      await drain(h.runtime.sendMessageStreaming("hello"));
      expect(h.sent.some((s) => s.seen.includes(LEGACY))).toBe(expected);
    }
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
  "packages/ai-core/src/task-router.ts": {
    count: 2,
    coveredBy:
      "erasure in the isConfigurable type guard — reads only setModel / model, never a request method",
  },
  "packages/planner/src/decompose.ts": { count: 1, coveredBy: "executePlan (new goal)" },
  "packages/planner/src/reflect.ts": {
    count: 1,
    coveredBy: "executePlan / resumePlan (post-plan reflection)",
  },
  "packages/runtime/src/consolidation-cycle.ts": { count: 1, coveredBy: "consolidationCycle" },
  "packages/runtime/src/motebit-runtime.ts": {
    count: 2,
    coveredBy:
      "generateCompletion (also the conversation's title dep: autoTitle; spatial heartbeat); memory consolidation classify (memory-formation turn)",
  },
  "packages/runtime/src/secret-redacting-provider.ts": {
    count: 2,
    coveredBy: "provider wrapper — forwards the caller's pack; covered by its callers",
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

/**
 * Provider egress sites per file (`provider-egress-lock.ts`: type-aware —
 * property access, element access, destructuring, any/unknown erasure and
 * narrowing of a provider-typed value, and erasure of a container that
 * carries one), over every packages/<pkg>/src and
 * apps/<app>/src non-test source file under `root`.
 */
export function scanProviderCallSites(root: string): Record<string, number> {
  return scanProviderCallSitesWithAperture(root).counts;
}

function scanProviderCallSitesWithAperture(root: string): {
  counts: Record<string, number>;
  scanned: number;
} {
  const files: string[] = [];
  for (const top of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(root, top))) {
      const src = join(root, top, pkg, "src");
      try {
        if (!statSync(src).isDirectory()) continue;
      } catch {
        continue;
      }
      sourceFiles(src, files);
    }
  }
  const counts: Record<string, number> = {};
  for (const site of findProviderSites(files)) {
    const rel = relative(root, site.file);
    counts[rel] = (counts[rel] ?? 0) + 1;
  }
  return { counts, scanned: files.length };
}

describe("egress canary: static completeness lock", () => {
  it(
    "every provider call site in packages/ and apps/ is covered by an entry point above",
    { timeout: 120_000 },
    () => {
      const { counts: found, scanned } = scanProviderCallSitesWithAperture(ROOT);
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
        // Aperture (gate-repair-instructions.md): what this green covers —
        // and, in provider-egress-lock.ts's header, what it cannot see.
        `examined ${scanned} source files under packages/*/src and apps/*/src; ` +
          `${Object.keys(found).length} carry provider sites (access, element, destructure, ` +
          `erasure, narrowing, container erasure). Not seen: names-only narrowing, containers ` +
          `> 3 hops or via getters, untyped JS, tests/scripts/services`,
      ).toEqual([]);
    },
  );
});

describe("egress canary: the static lock sees through syntax", () => {
  // Every way to reach a provider's request methods must count as a call
  // site — the lock is about the value's TYPE, not the spelling.
  const PROVIDER_DECL = `
interface ContextPack { user_message?: string }
interface AIResponse { text: string }
export interface IntelligenceProvider {
  generate(contextPack: ContextPack): Promise<AIResponse>;
  estimateConfidence(): Promise<number>;
  extractMemoryCandidates(response: AIResponse): Promise<unknown[]>;
}
export interface StreamingProvider extends IntelligenceProvider {
  readonly model: string;
  generateStream(contextPack: ContextPack): AsyncGenerator<unknown>;
}
`;
  const PROBES: Record<string, string> = {
    "dot.ts": `export async function f(p: IntelligenceProvider) { return p.generate({}); }`,
    "element.ts": `export async function f(p: IntelligenceProvider) { return p["generate"]({}); }`,
    "element-dynamic.ts": `export async function f(p: StreamingProvider, k: "generate") { return p[k]({}); }`,
    "destructure.ts": `export async function f(p: IntelligenceProvider) { const { generate } = p; return generate({}); }`,
    "destructure-param.ts": `export async function f({ generateStream }: StreamingProvider) { return generateStream({}); }`,
    "any-alias.ts": `export async function f(p: IntelligenceProvider) { const q: any = p; return q.generate({}); }`,
    "as-any.ts": `export async function f(p: StreamingProvider) { return (p as unknown as { generate(c: object): unknown }).generate({}); }`,
    "class-impl.ts": `class P implements IntelligenceProvider { async generate() { return { text: "" }; } async estimateConfidence() { return 1; } async extractMemoryCandidates() { return []; } }
export async function f(p: P) { return p.generate(); }`,
    // Narrowing: the provider flows into a slot not typed as one; past it
    // the checker sees only the slot's type, so the flow is the site.
    "narrow-interface.ts": `interface Gen { generate(c: ContextPack): Promise<AIResponse> }
function use(g: Gen) { return g.generate({}); }
export function f(p: IntelligenceProvider) { return use(p); }`,
    "narrow-pick.ts": `function use(g: Pick<IntelligenceProvider, "generate">) { return g.generate({}); }
export function f(p: IntelligenceProvider) { return use(p); }`,
    "narrow-unknown-param.ts": `function use(g: unknown) { return (g as { generate(c: object): unknown }).generate({}); }
export function f(p: StreamingProvider) { return use(p); }`,
    "narrow-generic.ts": `function use<T extends object>(g: T) { return g; }
export function f(p: IntelligenceProvider) { return use(p); }`,
    "narrow-reflect.ts": `export function f(p: IntelligenceProvider) { return Reflect.get(p, "gen" + "erate"); }`,
    "narrow-object-values.ts": `export function f(p: IntelligenceProvider) { return Object.values(p); }`,
    "narrow-typed-decl.ts": `export function f(p: IntelligenceProvider) { const g: { generate(c: object): unknown } = p; return g.generate({}); }`,
    "narrow-object-prop.ts": `export function f(p: IntelligenceProvider) { const deps: { gen: { generate(c: object): unknown } } = { gen: p }; return deps; }`,
    "narrow-shorthand.ts": `export function f(gen: IntelligenceProvider) { const deps: { gen: { generate(c: object): unknown } } = { gen }; return deps; }`,
    "narrow-return.ts": `export function f(p: IntelligenceProvider): { generate(c: object): unknown } { return p; }`,
    // Container erasure: the provider is never named — a CONTAINER whose
    // property chain reaches one is erased to any / unknown / an any-valued
    // record, and the request method is reached through the erased chain.
    "container-any-param.ts": `interface Deps { provider: IntelligenceProvider }
function use(d: any) { return d.provider.generate({}); }
export function f(deps: Deps) { return use(deps); }`,
    "container-as-any.ts": `interface Deps { provider: IntelligenceProvider }
export function f(d: Deps) { return (d as any).provider.generate({}); }`,
    "container-record-any.ts": `interface Deps { provider: IntelligenceProvider }
export function f(d: Deps, k: string) { return (d as Record<string, any>)[k].generate({}); }`,
    "container-nested-any.ts": `interface Outer { deps: { ai: StreamingProvider } }
export function f(o: Outer) { const x: unknown = o; return (x as { deps: { ai: { generateStream(c: object): unknown } } }).deps.ai.generateStream({}); }`,
    "container-this-any.ts": `class Host { constructor(private readonly provider: IntelligenceProvider) {}
  run() { return (this as any).provider.generate({}); } }
export const h = Host;`,
  };

  it("counts every probe as a provider call site", { timeout: 60_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "egress-lock-"));
    const src = join(root, "packages", "probe", "src");
    mkdirSync(src, { recursive: true });
    mkdirSync(join(root, "apps"));
    for (const [name, body] of Object.entries(PROBES))
      writeFileSync(join(src, name), `${PROVIDER_DECL}\n${body}\n`);
    // Benign files: a non-provider \`.generate(\` is not a call site, and a
    // provider passed to a slot typed as a provider is not a narrowing.
    writeFileSync(
      join(src, "benign.ts"),
      `const ids = { generate: () => "id" };\nexport const x = ids.generate();\n`,
    );
    writeFileSync(
      join(src, "benign-provider-slot.ts"),
      `${PROVIDER_DECL}\nfunction keep(p: IntelligenceProvider) { return p.estimateConfidence(); }\nexport function f(p: StreamingProvider) { const q: IntelligenceProvider = p; return [keep(p), keep(q), { inner: p as IntelligenceProvider }]; }\n`,
    );
    // A container passed to a slot typed as the same container (or one
    // that still carries the provider) is not an erasure.
    writeFileSync(
      join(src, "benign-container-slot.ts"),
      `${PROVIDER_DECL}\ninterface Deps { provider: IntelligenceProvider; name: string }\nfunction keep(d: Deps) { return d.name; }\nfunction keepPick(d: Pick<Deps, "provider">) { return d.provider.estimateConfidence(); }\nfunction nameOf(d: { name: string }) { return d.name; }\nexport function f(d: Deps) { return [keep(d), keepPick(d), nameOf(d), { inner: d as Deps }]; }\n`,
    );
    const found = scanProviderCallSites(root);
    const missed = Object.keys(PROBES).filter(
      (name) => !(found[`packages/probe/src/${name}`] ?? 0),
    );
    expect(missed, "probes the lock did not see").toEqual([]);
    expect(found["packages/probe/src/benign.ts"] ?? 0, "a non-provider generate()").toBe(0);
    expect(
      found["packages/probe/src/benign-provider-slot.ts"] ?? 0,
      "a provider passed to a provider-typed slot",
    ).toBe(0);
    expect(
      found["packages/probe/src/benign-container-slot.ts"] ?? 0,
      "a container passed to a slot that keeps (or never reaches) its provider",
    ).toBe(0);
  });
});
