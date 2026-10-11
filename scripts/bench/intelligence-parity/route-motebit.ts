/**
 * Route A — a turn through motebit's real runtime.
 *
 * The SAME code path a surface uses: `MotebitRuntime.sendMessageStreaming`
 * (system-prompt assembly, conversation trimming, memory recall + formation,
 * the agentic loop) over the provider adapter built the way the CLI builds it
 * (`resolveProviderSpec` byok → `AnthropicProvider` or `OpenAIProvider` by wire
 * protocol, with the personality default temperature). Nothing is reimplemented here and nothing in the
 * product is configured differently for the bench.
 *
 * What the bench supplies is only what a fresh install would have: a new
 * in-memory identity/store per run, and — for prompts that need it — prior
 * state put there through the product's own doors: memories through
 * `formMemoriesFromCandidates` (the formation pass the turn loop runs), prior
 * turns through a `ConversationStoreAdapter` + `runtime.loadConversation` (the
 * path a surface takes when it resumes a conversation).
 *
 * Tools: the deterministic, network-free subset of the CLI's builtins
 * (`current_time`, `recall_memories`, `recall_self`). Web search would make the
 * bench unrepeatable and is deliberately not offered; the report says so.
 */

import {
  MotebitRuntime,
  NullRenderer,
  TurnPrincipal,
  createInMemoryStorage,
} from "../../../packages/runtime/src/index.js";
import type { StreamChunk } from "../../../packages/runtime/src/index.js";
import {
  AnthropicProvider,
  DEFAULT_CONFIG,
  OpenAIProvider,
} from "../../../packages/ai-core/src/index.js";
import { SensitivityLevel, resolveProviderSpec } from "../../../packages/sdk/src/index.js";
import type { ConversationStoreAdapter, ResolverEnv } from "../../../packages/sdk/src/index.js";
import {
  InMemoryToolRegistry,
  currentTimeDefinition,
  createCurrentTimeHandler,
  recallMemoriesDefinition,
  createRecallMemoriesHandler,
  recallSelfDefinition,
  createRecallSelfHandler,
} from "../../../packages/tools/src/index.js";
import { querySelfKnowledge } from "../../../packages/self-knowledge/src/index.js";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { AttributedMemoryCandidate } from "../../../packages/sdk/src/index.js";
import { addUsage, ZERO_USAGE, type WireTap } from "./wire-tap.js";
import { captureRequests, freezeParams } from "./params.js";
import { messagesOf, stoppedForTools, systemPromptChars } from "./protocol.js";
import type {
  BenchPrompt,
  BenchProvider,
  RouteAResult,
  ScriptedMessage,
  Usage,
  WireExchange,
} from "./types.js";

/** The CLI's resolver env, minus on-device backends (BYOK only here). */
const BENCH_RESOLVER_ENV: ResolverEnv = {
  cloudBaseUrl: (_wire, canonical) => canonical,
  defaultLocalServerUrl: "http://localhost:11434",
  supportedBackends: new Set(),
};

/** ~4 chars/token — the same estimator the runtime's trimming uses, so retained/dropped are on its scale. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Minimal conversation store: holds the scripted prior turns so the runtime can resume them. */
export class BenchConversationStore implements ConversationStoreAdapter {
  private readonly rows: Array<{
    messageId: string;
    conversationId: string;
    motebitId: string;
    role: string;
    content: string;
    toolCalls: string | null;
    toolCallId: string | null;
    createdAt: number;
    tokenEstimate: number;
    sensitivity?: SensitivityLevel;
  }> = [];
  private readonly convos = new Map<
    string,
    { startedAt: number; lastActiveAt: number; summary: string | null; title: string | null }
  >();
  private seq = 0;

  createConversation(_motebitId: string): string {
    const id = `bench-convo-${++this.seq}`;
    const now = Date.now();
    this.convos.set(id, { startedAt: now, lastActiveAt: now, summary: null, title: null });
    return id;
  }
  appendMessage(
    conversationId: string,
    motebitId: string,
    msg: {
      role: string;
      content: string;
      toolCalls?: string;
      toolCallId?: string;
      sensitivity?: SensitivityLevel;
    },
  ): void {
    this.rows.push({
      messageId: `m${this.rows.length + 1}`,
      conversationId,
      motebitId,
      role: msg.role,
      content: msg.content,
      toolCalls: msg.toolCalls ?? null,
      toolCallId: msg.toolCallId ?? null,
      createdAt: Date.now(),
      tokenEstimate: estimateTokens(msg.content),
      ...(msg.sensitivity != null ? { sensitivity: msg.sensitivity } : {}),
    });
    const c = this.convos.get(conversationId);
    if (c) c.lastActiveAt = Date.now();
  }
  loadMessages(conversationId: string, limit?: number) {
    const rows = this.rows.filter((r) => r.conversationId === conversationId);
    return limit !== undefined ? rows.slice(-limit) : rows;
  }
  getActiveConversation(_motebitId: string) {
    const last = [...this.convos.entries()].at(-1);
    return last ? { conversationId: last[0], ...last[1] } : null;
  }
  updateSummary(conversationId: string, summary: string): void {
    const c = this.convos.get(conversationId);
    if (c) c.summary = summary;
  }
  updateTitle(conversationId: string, title: string): void {
    const c = this.convos.get(conversationId);
    if (c) c.title = title;
  }
  listConversations(_motebitId: string) {
    return [...this.convos.entries()].map(([conversationId, c]) => ({
      conversationId,
      startedAt: c.startedAt,
      lastActiveAt: c.lastActiveAt,
      title: c.title,
      messageCount: this.rows.filter((r) => r.conversationId === conversationId).length,
    }));
  }
  deleteConversation(conversationId: string): void {
    this.convos.delete(conversationId);
  }
}

interface MemoryFormationModule {
  formMemoriesFromCandidates(
    deps: { memoryGraph: MotebitRuntime["memory"]; mode: "consolidate" },
    candidates: readonly AttributedMemoryCandidate[],
    relevantMemories: readonly never[],
  ): Promise<unknown>;
}

let formationModule: Promise<MemoryFormationModule> | null = null;

/**
 * The formation pass, loaded from the SAME `@motebit/memory-graph` the runtime
 * links (its own dependency, resolved from packages/runtime) — so seeded
 * memories are embedded and formed by the module instance the turn loop
 * itself forms through, not a second copy loaded from source.
 */
function memoryFormation(): Promise<MemoryFormationModule> {
  formationModule ??= (async () => {
    const req = createRequire(new URL("../../../packages/runtime/package.json", import.meta.url));
    return (await import(
      pathToFileURL(req.resolve("@motebit/memory-graph")).href
    )) as MemoryFormationModule;
  })();
  return formationModule;
}

export interface MotebitRouteConfig {
  /** BYOK vendor under test. Default `anthropic`. */
  provider?: BenchProvider;
  apiKey: string;
  model: string;
  /** Override for tests (a fake server). Default: the resolver's canonical URL. */
  baseUrl?: string;
  tap: WireTap;
  clock?: () => number;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<Record<string, unknown>>)
    .map((b) => (typeof b["text"] === "string" ? b["text"] : ""))
    .join("");
}

/**
 * Split the turn's observed exchanges into model rounds of THE turn vs.
 * auxiliary calls. The agentic loop streams (`generateStream`); auxiliary
 * passes inside a turn (closing validation, consolidation classify, auto-title)
 * use the non-streaming `generate`. A round also continues round 1's
 * conversation — same first message. The system prompt is deliberately NOT
 * compared: the runtime re-assembles it per iteration (session state can change
 * mid-turn), so round 2's legitimately differs from round 1's. On the OpenAI
 * wire the system prompt is `system`-role messages, so those are skipped when
 * finding the conversation's first message.
 */
export function splitRounds(exchanges: readonly WireExchange[]): {
  rounds: WireExchange[];
  auxiliary: WireExchange[];
} {
  // Compared by role + text, not raw JSON: the adapter moves its
  // `cache_control` breakpoint to the LAST message each round, so round 1's
  // first message is re-serialized without it on round 2.
  const headOf = (m: Record<string, unknown> | undefined): string =>
    m ? `${String(m["role"])}:${contentText(m["content"])}` : "";
  const convo = (body: Record<string, unknown>) =>
    messagesOf(body).filter((m) => m["role"] !== "system");
  const first = exchanges.find((ex) => ex.request_body["stream"] === true);
  if (!first) return { rounds: [], auxiliary: [...exchanges] };
  const head = headOf(convo(first.request_body)[0]);
  const n = convo(first.request_body).length;
  const rounds: WireExchange[] = [];
  const auxiliary: WireExchange[] = [];
  for (const ex of exchanges) {
    const msgs = convo(ex.request_body);
    const isRound =
      ex.request_body["stream"] === true && headOf(msgs[0]) === head && msgs.length >= n;
    (isRound ? rounds : auxiliary).push(ex);
  }
  return { rounds, auxiliary };
}

/**
 * How much of the scripted history reached the model on round 1. Matched by
 * content against the request's messages (the runtime may prepend a synthetic
 * trim note, which is detected separately rather than counted as history).
 */
export function measureRetention(
  history: readonly ScriptedMessage[],
  round1Body: Record<string, unknown>,
): {
  retained: number;
  tokensRetained: number;
  trimNote: boolean;
} {
  // System-role messages (the OpenAI wire's system prompt) are not history.
  const sent = messagesOf(round1Body)
    .filter((m) => m["role"] !== "system")
    .map((m) => contentText(m["content"]));
  const trimNote = sent.some((t) =>
    /^\[(This conversation continues from earlier|Earlier in this conversation)/.test(t),
  );
  let retained = 0;
  let tokensRetained = 0;
  // Walk from the newest: trimming keeps a suffix, so the first miss ends it.
  let cursor = sent.length - 2; // last entry is the turn's own user message
  for (let i = history.length - 1; i >= 0 && cursor >= 0; i--) {
    const want = history[i]!.content.trim();
    if (!sent[cursor]!.includes(want) && !want.includes(sent[cursor]!.trim())) break;
    retained += 1;
    tokensRetained += estimateTokens(history[i]!.content);
    cursor -= 1;
  }
  return { retained, tokensRetained, trimNote };
}

export async function runMotebitRoute(
  prompt: BenchPrompt,
  repetition: number,
  cfg: MotebitRouteConfig,
): Promise<RouteAResult> {
  const clock = cfg.clock ?? (() => performance.now());
  const spec = resolveProviderSpec(
    {
      mode: "byok",
      vendor: cfg.provider ?? "anthropic",
      apiKey: cfg.apiKey,
      model: cfg.model,
      ...(cfg.baseUrl !== undefined ? { baseUrl: cfg.baseUrl } : {}),
    },
    BENCH_RESOLVER_ENV,
  );
  if (spec.kind !== "cloud") throw new Error(`unexpected provider spec kind ${spec.kind}`);
  // Mirrors apps/cli/src/runtime-factory.ts specToCliProvider: dispatch on
  // wire protocol, personality default temperature, resolver max_tokens
  // (undefined ⇒ the adapter default).
  const adapterConfig = {
    api_key: spec.apiKey,
    model: spec.model,
    base_url: spec.baseUrl,
    max_tokens: spec.maxTokens,
    temperature: spec.temperature ?? DEFAULT_CONFIG.temperature,
    extra_headers: spec.extraHeaders,
    personalityConfig: DEFAULT_CONFIG,
  };
  const provider =
    spec.wireProtocol === "openai"
      ? new OpenAIProvider(adapterConfig)
      : new AnthropicProvider(adapterConfig);

  const conversationStore = new BenchConversationStore();
  const motebitId = `bench-${prompt.id}-${repetition}-${crypto.randomUUID().slice(0, 8)}`;
  const tools = new InMemoryToolRegistry();
  const runtimeRef: { current: MotebitRuntime | null } = { current: null };
  tools.register(currentTimeDefinition, createCurrentTimeHandler());
  tools.register(
    recallMemoriesDefinition,
    createRecallMemoriesHandler(async (query, opts) =>
      runtimeRef.current
        ? runtimeRef.current.recallMemoriesForTool(query, opts, TurnPrincipal.OWNER)
        : [],
    ),
  );
  tools.register(
    recallSelfDefinition,
    createRecallSelfHandler((query, limit) =>
      Promise.resolve(
        querySelfKnowledge(query, { limit }).map((h) => ({
          source: h.source,
          title: h.title,
          content: h.content,
          score: h.score,
        })),
      ),
    ),
  );

  const runtime = new MotebitRuntime(
    { motebitId, tickRateHz: 0 },
    {
      storage: { ...createInMemoryStorage(), conversationStore },
      renderer: new NullRenderer(),
      ai: provider,
      tools,
    },
  );
  runtimeRef.current = runtime;

  // Prior session state, through the product's own doors.
  if (prompt.seed_memories && prompt.seed_memories.length > 0) {
    const { formMemoriesFromCandidates } = await memoryFormation();
    await formMemoriesFromCandidates(
      { memoryGraph: runtime.memory, mode: "consolidate" },
      prompt.seed_memories.map((m): AttributedMemoryCandidate => ({
        content: m.content,
        confidence: 0.9,
        sensitivity: (m.sensitivity ?? "personal") as AttributedMemoryCandidate["sensitivity"],
        memory_type: (m.memory_type ?? "semantic") as AttributedMemoryCandidate["memory_type"],
        // What a user told the assistant in an earlier session — the
        // provenance the turn loop stamps on a pure conversational turn.
        source: "user_stated",
      })),
      [],
    );
  }
  const history = prompt.history ?? [];
  if (history.length > 0) {
    const convoId = conversationStore.createConversation(motebitId);
    // Stamped as the runtime's write-side floor persists a turn at the
    // default session tier — an unstamped row fails closed and would never
    // reach the provider (conversation.ts egressHistory).
    for (const m of history)
      conversationStore.appendMessage(convoId, motebitId, {
        ...m,
        sensitivity: SensitivityLevel.Personal,
      });
    runtime.loadConversation(convoId);
  }

  const mark = cfg.tap.exchanges.length;
  const start = clock();
  let firstTextAt: number | undefined;
  let answer = "";
  let result: Extract<StreamChunk, { type: "result" }>["result"] | undefined;
  let error: string | undefined;
  try {
    for await (const chunk of runtime.sendMessageStreaming(prompt.prompt)) {
      if (chunk.type === "text") {
        if (firstTextAt === undefined && chunk.text.length > 0) firstTextAt = clock();
        answer += chunk.text;
      } else if (chunk.type === "result") {
        result = chunk.result;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const end = clock();
  await cfg.tap.settled();
  // Only what was SENT during the turn belongs to it — a post-turn auto-title
  // or deferred formation call is not the user's wait.
  const inTurn = cfg.tap.exchanges.slice(mark).filter((ex) => ex.started_at <= end);
  runtime.stop();

  const { rounds, auxiliary } = splitRounds(inTurn);
  const round1 = rounds[0]?.request_body ?? {};
  const usage: Usage = rounds.reduce((u, ex) => addUsage(u, ex.usage), { ...ZERO_USAGE });
  const auxUsage: Usage = auxiliary.reduce((u, ex) => addUsage(u, ex.usage), { ...ZERO_USAGE });
  const retention = measureRetention(history, round1);
  const toolCalls = rounds.flatMap((ex) =>
    ex.content
      .filter((b) => b["type"] === "tool_use")
      .map((b) => ({ name: String(b["name"]), input: b["input"] })),
  );

  return {
    route: "A",
    protocol: spec.wireProtocol,
    prompt_id: prompt.id,
    repetition,
    // The runtime's final response is the answer a surface renders (internal
    // tags stripped); the raw stream is the fallback when the turn errored.
    answer: (result?.response ?? answer).trim(),
    ttft_ms: firstTextAt !== undefined ? firstTextAt - start : null,
    total_ms: end - start,
    usage,
    model_rounds: rounds.length,
    tool_calls: toolCalls,
    requests: rounds.map((ex) => ex.request_body),
    captured: captureRequests(rounds),
    rounds_stopped_for_tools: rounds.map(stoppedForTools),
    params: freezeParams(round1, spec.wireProtocol),
    motebit: {
      ...(result?.latency ? { latency: { ...result.latency } } : {}),
      history_messages: history.length,
      history_retained: retention.retained,
      history_tokens_est: history.reduce((n, m) => n + estimateTokens(m.content), 0),
      history_tokens_retained_est: retention.tokensRetained,
      trim_note_injected: retention.trimNote,
      memories_retrieved: result?.memoriesRetrieved.length ?? 0,
      auxiliary_calls: auxiliary.length,
      auxiliary_usage: auxUsage,
      system_prompt_chars: systemPromptChars(round1),
    },
    ...(error !== undefined ? { error } : {}),
  };
}
