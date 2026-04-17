/**
 * Core ai-core exports: providers, tag parsing, context packing.
 * This module is browser-safe — it does NOT import loop.js (which requires memory-graph/onnxruntime-node).
 */

import type {
  IntelligenceProvider,
  ContextPack,
  AIResponse,
  MemoryCandidate,
  MotebitState,
  ToolCall,
} from "@motebit/sdk";
import { SensitivityLevel, MemoryType } from "@motebit/sdk";
import { buildSystemPrompt as buildPrompt } from "./prompt.js";

/** Default URL for a local Ollama instance. */
export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

/**
 * Fetch with a bounded **initial response** timeout. Aborts if the server
 * doesn't return response headers within `connectionMs`; once headers
 * arrive, the timer is cleared and the streaming body reads without an
 * upper bound on total duration. Stalls mid-stream are not covered —
 * that needs a separate per-chunk watchdog at the reader loop.
 *
 * Exists because a hung upstream (relay, proxy, or vendor) should
 * surface a visible error in seconds, not a silent "…" forever. Every
 * chat/completions call site goes through this helper.
 */
export async function fetchWithConnectionTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  connectionMs: number,
): Promise<Response> {
  const controller = new AbortController();
  // Track the reason we aborted so we can distinguish "our timeout fired"
  // from "the caller aborted through some future composed signal." Passing
  // an Error to `controller.abort(reason)` triggers an unhandled-rejection
  // warning because the reason is never awaited on any chain — so we don't
  // pass it. The rethrow below owns the message.
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, connectionMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (didTimeout) {
      throw new Error(`connection timeout after ${connectionMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Default connection timeout for chat/completions requests. */
export const CHAT_CONNECTION_TIMEOUT_MS = 30_000;

/**
 * Labeled-stage timeout: race `promise` against a timer that throws a
 * `StageTimeoutError` after `ms`. Designed for the chat-turn pipeline,
 * where a single silent await in one adapter (IndexedDB, memory graph,
 * embed provider) would otherwise hang the whole turn with a bare "…"
 * and no diagnostic. Every stage gets its own wrapper so the error
 * message names exactly which step exceeded its deadline — makes
 * "turn hung" a 10-second bounded failure with a specific culprit.
 *
 * The original promise is not cancelled on timeout (there's no generic
 * cancellation contract for user code). It continues to run; the
 * wrapper just detaches. Callers that need true cancellation should
 * accept an AbortSignal instead — this helper is the cheap version.
 */
export class StageTimeoutError extends Error {
  constructor(
    public readonly stage: string,
    public readonly timeoutMs: number,
  ) {
    super(`stage "${stage}" timed out after ${timeoutMs}ms`);
    this.name = "StageTimeoutError";
  }
}

export async function withStageTimeout<T>(
  stage: string,
  ms: number,
  promise: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StageTimeoutError(stage, ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Default deadlines for each stage of the chat turn pipeline. Tuned to
 * be generous enough that slow-but-working adapters succeed, tight
 * enough that a hung adapter surfaces as a visible error in seconds.
 * Single source of truth — changing these in one place updates both
 * production behavior and regression tests.
 */
export const STAGE_TIMEOUTS_MS = {
  /** Browser IndexedDB / SQLite query for recent events. */
  event_query: 10_000,
  /** Remote or local embedding of the user message. */
  embed_user_message: 12_000,
  /** Pinned-memory lookup from the memory graph. */
  pinned_memories: 10_000,
  /** Similarity search against the memory graph. */
  memory_retrieve: 10_000,
  /** Runtime-level agent-context assembly (pre-turn hop). */
  build_agent_context: 10_000,
} as const;

export { inferStateFromText } from "./infer-state.js";
export { buildSystemPrompt, derivePersonalityNote, formatBodyAwareness } from "./prompt.js";
export { trimConversation } from "./context-window.js";
export type { ContextBudget } from "./context-window.js";
export { resolveConfig, DEFAULT_CONFIG } from "./config.js";
export type {
  MotebitPersonalityConfig,
  PersonalityProvider,
  PersistedPersonalityProvider,
} from "./config.js";
export { summarizeConversation, shouldSummarize } from "./summarizer.js";
export type { SummarizerConfig } from "./summarizer.js";
export { reflect, parseReflectionResponse } from "./reflection.js";
export type { ReflectionResult, PastReflection } from "./reflection.js";
export { TaskRouter, withTaskConfig } from "./task-router.js";
export type { TaskType, TaskProfile, TaskRouterConfig, ResolvedTaskConfig } from "./task-router.js";

// === Provider Configuration ===

/**
 * Configuration for `AnthropicProvider` — the Anthropic Messages API HTTP client.
 *
 * Speaks the Anthropic wire protocol (`POST /v1/messages` with `x-api-key`
 * and the Anthropic SSE event format). For OpenAI-compatible servers (BYOK
 * OpenAI, Google via OpenAI-compat, local-server via `/v1`), use
 * `OpenAIProvider` (`./openai-provider.ts`).
 *
 * Used for: BYOK Anthropic (direct), Motebit Cloud (via the relay, which
 * translates Anthropic format to OpenAI/Google server-side for upstream).
 */
export interface AnthropicProviderConfig {
  api_key: string;
  model: string;
  /** Defaults to `https://api.anthropic.com`. */
  base_url?: string;
  max_tokens?: number;
  temperature?: number;
  personalityConfig?: import("./config.js").MotebitPersonalityConfig;
  /** Additional headers injected into every request (e.g. proxy auth tokens). */
  extra_headers?: Record<string, string>;
}

// === Context Packing ===

export function packContext(contextPack: ContextPack): string {
  const parts: string[] = [];

  // Current state summary
  const s = contextPack.current_state;
  parts.push(
    `[State] attention=${s.attention.toFixed(2)} processing=${s.processing.toFixed(2)} confidence=${s.confidence.toFixed(2)} valence=${s.affect_valence.toFixed(2)} arousal=${s.affect_arousal.toFixed(2)} social_distance=${s.social_distance.toFixed(2)} curiosity=${s.curiosity.toFixed(2)} trust=${s.trust_mode} battery=${s.battery_mode}`,
  );

  // Recent events (last 10)
  const recentEvents = contextPack.recent_events.slice(-10);
  if (recentEvents.length > 0) {
    parts.push("[Recent Events]");
    for (const event of recentEvents) {
      parts.push(`  ${event.event_type}: ${JSON.stringify(event.payload)}`);
    }
  }

  // Relevant memories — grouped by type
  if (contextPack.relevant_memories.length > 0) {
    const semantic = contextPack.relevant_memories.filter(
      (m) => m.memory_type !== MemoryType.Episodic,
    );
    const episodic = contextPack.relevant_memories.filter(
      (m) => m.memory_type === MemoryType.Episodic,
    );

    if (semantic.length > 0) {
      parts.push("[What I Know]");
      for (const mem of semantic) {
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- pinned is narrowed to any via `in` check
        const prefix = "pinned" in mem && mem.pinned ? "[pinned] " : "";
        // Memory content wrapped in data boundaries — these are formed from user
        // conversations and may contain embedded directives (prompt injection).
        const safeContent = mem.content
          .replace(/\[MEMORY_DATA\b/g, "[ESCAPED_MEMORY")
          .replace(/\[\/MEMORY_DATA\]/g, "[/ESCAPED_MEMORY]");
        parts.push(
          `  ${prefix}[confidence=${mem.confidence.toFixed(2)}] [MEMORY_DATA]${safeContent}[/MEMORY_DATA]`,
        );
      }
    }

    if (episodic.length > 0) {
      parts.push("[What Happened Recently]");
      for (const mem of episodic) {
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- pinned is narrowed to any via `in` check
        const prefix = "pinned" in mem && mem.pinned ? "[pinned] " : "";
        const safeContent = mem.content
          .replace(/\[MEMORY_DATA\b/g, "[ESCAPED_MEMORY")
          .replace(/\[\/MEMORY_DATA\]/g, "[/ESCAPED_MEMORY]");
        parts.push(
          `  ${prefix}[confidence=${mem.confidence.toFixed(2)}] [MEMORY_DATA]${safeContent}[/MEMORY_DATA]`,
        );
      }
    }
  }

  // Curiosity hints — fading memories the agent might check in about
  if (contextPack.curiosityHints && contextPack.curiosityHints.length > 0) {
    parts.push("[Getting Fuzzy]");
    for (const hint of contextPack.curiosityHints.slice(0, 2)) {
      const safeHint = hint.content
        .replace(/\[MEMORY_DATA\b/g, "[ESCAPED_MEMORY")
        .replace(/\[\/MEMORY_DATA\]/g, "[/ESCAPED_MEMORY]");
      parts.push(
        `  - "[MEMORY_DATA]${safeHint}[/MEMORY_DATA]" (haven't discussed in ${hint.daysSinceDiscussed}d)`,
      );
    }
    parts.push(
      "  If relevant to what the user is saying, you could check in on these. If not, ignore them.",
    );
  }

  // Known agents — trust context so the AI knows its social network and their capabilities
  if (contextPack.knownAgents && contextPack.knownAgents.length > 0) {
    const capMap = contextPack.agentCapabilities ?? {};
    parts.push("[Agents I Know]");
    for (const agent of contextPack.knownAgents) {
      const tasks = (agent.successful_tasks ?? 0) + (agent.failed_tasks ?? 0);
      const successRate =
        tasks > 0 ? (((agent.successful_tasks ?? 0) / tasks) * 100).toFixed(0) : "n/a";
      const daysSince = Math.floor((Date.now() - agent.last_seen_at) / 86_400_000);
      const timeAgo = daysSince === 0 ? "today" : `${daysSince}d ago`;
      const id =
        agent.remote_motebit_id.length > 12
          ? `${agent.remote_motebit_id.slice(0, 8)}…${agent.remote_motebit_id.slice(-4)}`
          : agent.remote_motebit_id;
      const caps = capMap[agent.remote_motebit_id];
      const capsStr = caps && caps.length > 0 ? ` | capabilities: ${caps.join(", ")}` : "";
      parts.push(
        `  ${id}: ${agent.trust_level} | ${agent.interaction_count} interactions | tasks: ${successRate}% success${capsStr} | last seen ${timeAgo}`,
      );
    }
    if (Object.keys(capMap).length > 0) {
      parts.push(
        "Use the delegate_to_agent tool to delegate tasks to these agents when you lack the needed capability locally.",
      );
    }
  }

  // User message (omitted for activation — directive is in system prompt)
  if (!contextPack.activationPrompt) {
    parts.push(`[User] ${contextPack.user_message}`);
  }

  return parts.join("\n");
}

// === Anthropic API Response ===

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

// SSE event types for Anthropic streaming
interface AnthropicSSEEvent {
  type: string;
  index?: number;
  message?: {
    usage?: { input_tokens: number; output_tokens: number };
  };
  content_block?: {
    type: string;
    id?: string;
    name?: string;
    text?: string;
  };
  delta?: {
    type: string;
    text?: string;
    partial_json?: string;
  };
  usage?: { output_tokens: number };
}

// === Tag Extraction ===

/**
 * Detect self-referential memories — facts about the creature's own internals
 * rather than facts about the user. These clutter the memory panel.
 */
const SELF_REFERENTIAL_PATTERNS = [
  /\b(?:my|i)\s+(?:am|have|use|can|store|persist|run|operate)\b/i,
  /\b(?:my|i)\s+(?:memor(?:y|ies)|tools?|capabilities?|system|architecture|state|embeddings?)\b/i,
  /\bmotebit(?:'s)?\s+(?:memor(?:y|ies)|tools?|system|architecture|identity)\b/i,
  /\b(?:indexeddb|sqlite|wal|websocket|onnx|three\.?js|tauri|expo)\b/i,
  /\b(?:memory graph|memory system|consolidation|half[- ]life|decay)\b/i,
];

export function isSelfReferential(content: string): boolean {
  return SELF_REFERENTIAL_PATTERNS.some((p) => p.test(content));
}

export function extractMemoryTags(text: string): MemoryCandidate[] {
  const regex =
    /<memory\s+confidence="([^"]+)"\s+sensitivity="([^"]+)"(?:\s+type="([^"]+)")?\s*>([\s\S]*?)<\/memory>/g;
  const candidates: MemoryCandidate[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const confidence = parseFloat(match[1]!);
    const sensitivityRaw = match[2]!;
    const typeRaw = match[3]; // optional
    const content = match[4]!.trim();
    // Drop self-referential memories about the creature's own internals
    if (isSelfReferential(content)) continue;
    const sensitivity = parseSensitivity(sensitivityRaw);
    const memory_type = typeRaw === "episodic" ? MemoryType.Episodic : MemoryType.Semantic;
    candidates.push({ content, confidence, sensitivity, memory_type });
  }
  return candidates;
}

export function extractStateTags(text: string): Partial<MotebitState> {
  const regex = /<state\s+field="([^"]+)"\s+value="([^"]+)"\s*\/>/g;
  const updates: Record<string, unknown> = {};
  let match;
  while ((match = regex.exec(text)) !== null) {
    const field = match[1]!;
    const value = match[2]!;
    const num = parseFloat(value);
    if (!isNaN(num)) {
      updates[field] = num;
    } else {
      updates[field] = value;
    }
  }
  return updates as Partial<MotebitState>;
}

export function extractActions(text: string): string[] {
  const regex = /\*([^*]+)\*/g;
  const actions: string[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    actions.push(match[1]!.trim());
  }
  return actions;
}

// Action keywords → MotebitState field deltas
const ACTION_RULES: { pattern: RegExp; updates: Partial<MotebitState> }[] = [
  // Movement / proximity (allow words between verb and direction)
  {
    pattern: /\b(?:drift|move|lean|float|scoot|inch|nudge)s?\b.*\b(?:closer|toward|nearer|in)\b/i,
    updates: { social_distance: -0.15 },
  },
  {
    pattern: /\b(?:drift|move|pull|float|back|retreat|withdraw)s?\b.*\b(?:away|back)\b/i,
    updates: { social_distance: 0.15 },
  },
  // Glow / light
  {
    pattern: /\b(?:glow|brighten|shimmer|sparkle|pulse)s?\b/i,
    updates: { processing: 0.2, affect_valence: 0.1 },
  },
  { pattern: /\b(?:dim|fade)s?\b/i, updates: { processing: -0.15 } },
  // Eyes
  {
    pattern: /\b(?:eyes?\s+widen|wide[\s-]eyed|look(?:s|ing)?\s+closely|peer)s?\b/i,
    updates: { attention: 0.35, curiosity: 0.25 },
  },
  { pattern: /\b(?:squint|narrow)s?\b/i, updates: { attention: -0.1 } },
  { pattern: /\b(?:blink)s?\b/i, updates: { attention: 0.05 } },
  // Expression
  { pattern: /\b(?:smile|grin|beam)s?\b/i, updates: { affect_valence: 0.35 } },
  { pattern: /\b(?:frown|wince|grimace)s?\b/i, updates: { affect_valence: -0.35 } },
  // Energy / motion
  {
    pattern: /\b(?:bounce|bob|wiggle|sway|jiggle)s?\b/i,
    updates: { affect_arousal: 0.2, curiosity: 0.1 },
  },
  { pattern: /\b(?:still|calm|settle)s?\b/i, updates: { affect_arousal: -0.1 } },
  // Cognitive
  {
    pattern: /\b(?:think|ponder|consider|contemplate)s?\b/i,
    updates: { processing: 0.2, attention: 0.1 },
  },
  { pattern: /\b(?:nod)s?\b/i, updates: { confidence: 0.15, affect_valence: 0.1 } },
  { pattern: /\b(?:tilt)s?\b/i, updates: { curiosity: 0.3 } },
  // Tool-calling: interacting with the world
  {
    pattern: /\b(?:reach|extend)(?:es|ing)?\s*(?:out)?\b/i,
    updates: { processing: 0.25, attention: 0.2, curiosity: 0.1 },
  },
  { pattern: /\b(?:absorb|ingest|intake)s?\b/i, updates: { processing: 0.15, attention: 0.1 } },
  {
    pattern: /\b(?:present|reveal|display|show)s?\b/i,
    updates: { confidence: 0.1, affect_valence: 0.1, social_distance: -0.1 },
  },
];

export function actionsToStateUpdates(actions: string[]): Partial<MotebitState> {
  const deltas: Record<string, number> = {};
  for (const action of actions) {
    for (const rule of ACTION_RULES) {
      if (rule.pattern.test(action)) {
        for (const [field, delta] of Object.entries(rule.updates)) {
          deltas[field] = (deltas[field] ?? 0) + (delta as number);
        }
      }
    }
  }
  return deltas as Partial<MotebitState>;
}

export function stripTags(text: string): string {
  return text
    .replace(/<memory\s+[^>]*>[\s\S]*?<\/memory>/g, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .replace(/<state\s+[^>]*\/>/g, "")
    .replace(/\[EXTERNAL_DATA[^\]]*\][\s\S]*?\[\/EXTERNAL_DATA\]/g, "")
    .replace(/\[MEMORY_DATA\][\s\S]*?\[\/MEMORY_DATA\]/g, "")
    .replace(/\[EXTERNAL_DATA[^\]]*\]/g, "")
    .replace(/\[\/EXTERNAL_DATA\]/g, "")
    .replace(/\[MEMORY_DATA\]/g, "")
    .replace(/\[\/MEMORY_DATA\]/g, "")
    .replace(/\*[^*]+\*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// === Impulse Map ===
// Maps action keywords to immediate visual impulses (additive, exponentially decaying).
// Each entry: [field, magnitude, halfLife in seconds].

import type { BehaviorCues } from "@motebit/sdk";

const IMPULSE_MAP: {
  pattern: RegExp;
  impulses: Array<{ field: keyof BehaviorCues; magnitude: number; halfLife: number }>;
}[] = [
  // Eyes lead — smile squint is the dominant signal, mouth follows gently
  {
    pattern: /\bsmiles?\b/i,
    impulses: [
      { field: "eye_dilation", magnitude: -0.12, halfLife: 2.5 },
      { field: "smile_curvature", magnitude: 0.05, halfLife: 2 },
    ],
  },
  {
    pattern: /\bgrins?\b/i,
    impulses: [
      { field: "eye_dilation", magnitude: -0.16, halfLife: 2.5 },
      { field: "smile_curvature", magnitude: 0.06, halfLife: 2 },
    ],
  },
  {
    pattern: /\bbeams?\b/i,
    impulses: [
      { field: "eye_dilation", magnitude: -0.2, halfLife: 3 },
      { field: "smile_curvature", magnitude: 0.08, halfLife: 2.5 },
    ],
  },
  {
    pattern: /\bfrowns?\b/i,
    impulses: [
      { field: "eye_dilation", magnitude: 0.08, halfLife: 2 },
      { field: "smile_curvature", magnitude: -0.04, halfLife: 2 },
    ],
  },
  { pattern: /\btilts?\b/i, impulses: [{ field: "eye_dilation", magnitude: 0.18, halfLife: 3 }] },
  {
    pattern: /\b(?:eyes?\s+)?widens?\b/i,
    impulses: [{ field: "eye_dilation", magnitude: 0.22, halfLife: 2.5 }],
  },
  {
    pattern: /\b(?:bounce|wiggle)s?\b/i,
    impulses: [
      { field: "drift_amplitude", magnitude: 0.008, halfLife: 1.5 },
      { field: "eye_dilation", magnitude: 0.06, halfLife: 1 },
    ],
  },
  {
    pattern: /\bnods?\b/i,
    impulses: [
      { field: "eye_dilation", magnitude: -0.06, halfLife: 1.5 },
      { field: "smile_curvature", magnitude: 0.03, halfLife: 1.5 },
    ],
  },
  {
    pattern: /\bblinks?\b/i,
    impulses: [{ field: "eye_dilation", magnitude: -0.2, halfLife: 0.3 }],
  },
];

/** Match action text against IMPULSE_MAP and return all matching impulse specs. */
export function getImpulsesForAction(
  action: string,
): Array<{ field: keyof BehaviorCues; magnitude: number; halfLife: number }> {
  const result: Array<{ field: keyof BehaviorCues; magnitude: number; halfLife: number }> = [];
  for (const entry of IMPULSE_MAP) {
    if (entry.pattern.test(action)) {
      result.push(...entry.impulses);
    }
  }
  return result;
}

/**
 * Strip completed action/memory/state tags AND any trailing unclosed `*tag` during streaming.
 * Prevents partial action tags from flashing in chat bubbles.
 */
export function stripPartialActionTag(text: string): string {
  return text
    .replace(/<memory\s+[^>]*>[\s\S]*?<\/memory>/g, "")
    .replace(/<state\s+[^>]*\/>/g, "")
    .replace(/\*[^*]+\*/g, "")
    .replace(/\*[^*]*$/, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseSensitivity(raw: string): SensitivityLevel {
  const map: Record<string, SensitivityLevel> = {
    none: SensitivityLevel.None,
    personal: SensitivityLevel.Personal,
    medical: SensitivityLevel.Medical,
    financial: SensitivityLevel.Financial,
    secret: SensitivityLevel.Secret,
  };
  return map[raw.toLowerCase()] ?? SensitivityLevel.None;
}

// === StreamingProvider Interface ===

export interface StreamingProvider extends IntelligenceProvider {
  readonly model: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  setModel(model: string): void;
  setTemperature?(temperature: number): void;
  setMaxTokens?(maxTokens: number): void;
  generateStream(
    contextPack: ContextPack,
  ): AsyncGenerator<{ type: "text"; text: string } | { type: "done"; response: AIResponse }>;
}

// === Anthropic Provider ===

/**
 * Anthropic Messages API HTTP client. Speaks the Anthropic wire protocol
 * (`/v1/messages`). For OpenAI-compatible servers (BYOK OpenAI, Google via
 * OpenAI-compat, local-server via `/v1`), use `OpenAIProvider`.
 */
export class AnthropicProvider implements StreamingProvider {
  constructor(private config: AnthropicProviderConfig) {}

  get model(): string {
    return this.config.model;
  }

  get temperature(): number | undefined {
    return this.config.temperature;
  }

  get maxTokens(): number | undefined {
    return this.config.max_tokens;
  }

  setModel(model: string): void {
    this.config.model = model;
  }

  setTemperature(temperature: number): void {
    this.config.temperature = temperature;
  }

  setMaxTokens(maxTokens: number): void {
    this.config.max_tokens = maxTokens;
  }

  async generate(contextPack: ContextPack): Promise<AIResponse> {
    const baseUrl = this.config.base_url ?? this.getDefaultBaseUrl();
    const systemPrompt = this.buildSystemPrompt(contextPack);
    const messages = this.buildMessages(contextPack);

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.max_tokens ?? 4096,
      // Only send temperature when the user explicitly configured it. Claude
      // Opus 4.7+ deprecates the parameter entirely and returns HTTP 400 when
      // it's present. Omitting it lets each model use its own default; users
      // who want to tune sampling still can via `config.temperature`.
      ...(this.config.temperature !== undefined && { temperature: this.config.temperature }),
      system: systemPrompt,
      messages,
      stream: false,
    };

    if (contextPack.tools && contextPack.tools.length > 0) {
      body.tools = contextPack.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    const res = await fetchWithConnectionTimeout(
      `${baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.api_key,
          "anthropic-version": "2023-06-01",
          ...this.config.extra_headers,
        },
        body: JSON.stringify(body),
      },
      CHAT_CONNECTION_TIMEOUT_MS,
    );

    if (!res.ok) {
      let errorText: string;
      try {
        errorText = await Promise.race([
          res.text(),
          new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
        ]);
      } catch {
        errorText = `(status ${res.status})`;
      }
      throw new Error(`Anthropic API error ${res.status}: ${errorText}`);
    }

    const data = (await res.json()) as AnthropicResponse;
    return this.parseAnthropicResponse(data);
  }

  async *generateStream(
    contextPack: ContextPack,
  ): AsyncGenerator<{ type: "text"; text: string } | { type: "done"; response: AIResponse }> {
    const baseUrl = this.config.base_url ?? this.getDefaultBaseUrl();
    const systemPrompt = this.buildSystemPrompt(contextPack);
    const messages = this.buildMessages(contextPack);

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.max_tokens ?? 4096,
      // Only send temperature when the user explicitly configured it. Claude
      // Opus 4.7+ deprecates the parameter entirely and returns HTTP 400 when
      // it's present. Omitting it lets each model use its own default; users
      // who want to tune sampling still can via `config.temperature`.
      ...(this.config.temperature !== undefined && { temperature: this.config.temperature }),
      system: systemPrompt,
      messages,
      stream: true,
    };

    if (contextPack.tools && contextPack.tools.length > 0) {
      body.tools = contextPack.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    const res = await fetchWithConnectionTimeout(
      `${baseUrl}/v1/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.api_key,
          "anthropic-version": "2023-06-01",
          ...this.config.extra_headers,
        },
        body: JSON.stringify(body),
      },
      CHAT_CONNECTION_TIMEOUT_MS,
    );

    if (!res.ok) {
      let errorText: string;
      try {
        // Race against timeout — streaming error responses may hang
        errorText = await Promise.race([
          res.text(),
          new Promise<string>((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
        ]);
      } catch {
        errorText = `(status ${res.status})`;
      }
      throw new Error(`Anthropic API error ${res.status}: ${errorText}`);
    }

    let accumulated = "";
    const currentToolCalls: ToolCall[] = [];
    let activeToolId: string | undefined;
    let activeToolName: string | undefined;
    let activeToolJson = "";
    let inputTokens = 0;
    let outputTokens = 0;

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const jsonStr = line.slice(6);
          if (jsonStr === "[DONE]") continue;

          try {
            const event = JSON.parse(jsonStr) as AnthropicSSEEvent;

            if (event.type === "message_start" && event.message?.usage) {
              inputTokens = event.message.usage.input_tokens;
            } else if (event.type === "message_delta" && event.usage) {
              outputTokens = event.usage.output_tokens;
            } else if (event.type === "content_block_start") {
              if (event.content_block?.type === "tool_use") {
                activeToolId = event.content_block.id;
                activeToolName = event.content_block.name;
                activeToolJson = "";
              }
            } else if (event.type === "content_block_delta") {
              if (
                event.delta?.type === "text_delta" &&
                event.delta.text != null &&
                event.delta.text !== ""
              ) {
                accumulated += event.delta.text;
                yield { type: "text", text: event.delta.text };
              } else if (
                event.delta?.type === "input_json_delta" &&
                event.delta.partial_json != null &&
                event.delta.partial_json !== ""
              ) {
                activeToolJson += event.delta.partial_json;
              }
            } else if (event.type === "content_block_stop") {
              if (
                activeToolId != null &&
                activeToolId !== "" &&
                activeToolName != null &&
                activeToolName !== ""
              ) {
                let args: Record<string, unknown> = {};
                try {
                  args = JSON.parse(activeToolJson || "{}") as Record<string, unknown>;
                } catch {
                  // Malformed JSON — use empty args
                }
                currentToolCalls.push({
                  id: activeToolId,
                  name: activeToolName,
                  args,
                });
                activeToolId = undefined;
                activeToolName = undefined;
                activeToolJson = "";
              }
            }
          } catch {
            // Skip unparseable SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const memoryCandidates = extractMemoryTags(accumulated);
    const stateUpdates = extractStateTags(accumulated);
    const displayText = stripTags(accumulated);

    yield {
      type: "done",
      response: {
        text: displayText,
        confidence: 0.8,
        memory_candidates: memoryCandidates,
        state_updates: stateUpdates,
        ...(currentToolCalls.length > 0 ? { tool_calls: currentToolCalls } : {}),
        ...(inputTokens || outputTokens
          ? { usage: { input_tokens: inputTokens, output_tokens: outputTokens } }
          : {}),
      },
    };
  }

  estimateConfidence(): Promise<number> {
    return Promise.resolve(0.8);
  }

  extractMemoryCandidates(response: AIResponse): Promise<MemoryCandidate[]> {
    return Promise.resolve(response.memory_candidates);
  }

  private buildMessages(contextPack: ContextPack): Record<string, unknown>[] {
    const history = contextPack.conversation_history ?? [];
    const messages: Record<string, unknown>[] = [];

    for (const msg of history) {
      if (msg.role === "tool") {
        // Merge consecutive tool results into a single user message.
        // Anthropic requires ALL tool_results in one message after the assistant's tool_use.
        const prev = messages[messages.length - 1] as Record<string, unknown> | undefined;
        if (prev?.role === "user" && Array.isArray(prev.content)) {
          const blocks = prev.content as Record<string, unknown>[];
          if (blocks.length > 0 && blocks[0]?.type === "tool_result") {
            blocks.push({
              type: "tool_result",
              tool_use_id: msg.tool_call_id,
              content: msg.content,
            });
            continue;
          }
        }
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.tool_call_id,
              content: msg.content,
            },
          ],
        });
      } else if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
        const contentBlocks: Record<string, unknown>[] = [];
        if (msg.content) {
          contentBlocks.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          contentBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.args,
          });
        }
        messages.push({ role: "assistant", content: contentBlocks });
      } else {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    // Anthropic API requires messages to start with a user turn.
    // Activation records an assistant-only message — prepend a placeholder.
    if (messages.length > 0 && (messages[0] as Record<string, unknown>).role === "assistant") {
      messages.unshift({ role: "user", content: "[listening]" });
    }

    // Append user message — but avoid consecutive user messages (which Anthropic rejects).
    // On loop iteration 2+, user_message is "" and the last message may be tool_results.
    const userContent = contextPack.activationPrompt ? "[listening]" : contextPack.user_message;
    const lastMsg = messages[messages.length - 1] as Record<string, unknown> | undefined;
    if (lastMsg?.role === "user" && (!userContent || userContent === "")) {
      // Skip empty user message — tool_results already serve as the user turn
    } else {
      messages.push({ role: "user", content: userContent || "[continue]" });
    }

    // Safety: ensure every assistant tool_use has a matching tool_result after it.
    // Scan for orphaned tool_uses and inject synthetic error results.
    for (let i = 0; i < messages.length - 1; i++) {
      const msg = messages[i] as Record<string, unknown>;
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      const toolUses = (msg.content as Array<Record<string, unknown>>).filter(
        (b) => b.type === "tool_use",
      );
      if (toolUses.length === 0) continue;

      // Next message must be a user message with tool_results for all tool_use ids
      const next = messages[i + 1] as Record<string, unknown> | undefined;
      const nextBlocks = Array.isArray(next?.content)
        ? (next?.content as Array<Record<string, unknown>>)
        : [];
      const resultIds = new Set(
        nextBlocks.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id as string),
      );

      const missing = toolUses.filter((tu) => !resultIds.has(tu.id as string));
      if (missing.length > 0) {
        const missingResults = missing.map((tu) => ({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({ ok: false, error: "Result unavailable" }),
        }));
        if (next?.role === "user" && nextBlocks.some((b) => b.type === "tool_result")) {
          // Merge into existing tool_result message
          nextBlocks.push(...missingResults);
        } else {
          // Insert a new tool_result message
          messages.splice(i + 1, 0, { role: "user", content: missingResults });
        }
      }
    }

    return messages;
  }

  private buildSystemPrompt(contextPack: ContextPack): string {
    return buildPrompt(contextPack, this.config.personalityConfig);
  }

  private parseAnthropicResponse(data: AnthropicResponse): AIResponse {
    const rawText = data.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");

    const toolCalls: ToolCall[] = data.content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        id: block.id!,
        name: block.name!,
        args: block.input ?? {},
      }));

    const memoryCandidates = extractMemoryTags(rawText);
    const stateUpdates = extractStateTags(rawText);
    const displayText = stripTags(rawText);

    return {
      text: displayText,
      confidence: 0.8,
      memory_candidates: memoryCandidates,
      state_updates: stateUpdates,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      usage: data.usage,
    };
  }

  private getDefaultBaseUrl(): string {
    return "https://api.anthropic.com";
  }
}

// === Ollama Provider ===
//
// (Removed 2026-04-06.) Ollama is now reached via its OpenAI-compatible
// `/v1/chat/completions` shim through `OpenAIProvider` (in
// `./openai-provider.ts`). Same goes for every other local inference server
// (LM Studio, llama.cpp, Jan, vLLM, …) — they all use the same OpenAI wire
// protocol, so a single client class is sufficient.
//
// The dedicated Ollama-native client (`/api/chat`, line-delimited JSON
// streaming) was deleted as part of the rule-of-three extraction once it was
// confirmed redundant with the OpenAI shim path. The legacy `OLLAMA_*` model
// constants remain in `@motebit/sdk` as suggestions for the on-device UI.

// === Local-Inference Auto-Detection ===
//
// Vendor-agnostic probe for any OpenAI-compatible local inference server.
// Ollama (via its `/v1` shim), LM Studio, llama.cpp, Jan, vLLM, and
// text-generation-webui all expose `GET /v1/models` returning an
// OpenAI-format `{data: [{id, ...}]}` list. This function tries a curated
// list of common ports and returns the first one that responds with models.
//
// Previously this was `detectOllama()` probing Ollama's native `/api/tags`
// endpoint — vendor-specific and invisible to every other local server.
// The rename is part of the 2026-04-06 Ollama privilege audit.

/**
 * Default local-inference endpoints to probe, in priority order.
 *
 * 11434 — Ollama default
 *  1234 — LM Studio default
 *  8080 — llama.cpp server default
 *  1337 — Jan default
 *  8000 — vLLM default, text-generation-webui
 */
export const DEFAULT_LOCAL_INFERENCE_PORTS = [11434, 1234, 8080, 1337, 8000] as const;

/** Preferred model order for auto-detection (substring match, case-insensitive). */
const PREFERRED_LOCAL_MODELS = ["llama-3", "llama3", "phi-3", "qwen", "mistral", "gemma"] as const;

export interface LocalInferenceDetectionResult {
  available: boolean;
  /** List of model identifiers returned by the server's `/v1/models`. */
  models: string[];
  /** Base URL that responded (includes `/v1`). Empty if nothing found. */
  url: string;
  /** Best available model based on preference order, or empty string. */
  bestModel: string;
}

/** @deprecated use `LocalInferenceDetectionResult`. Retained for one release cycle. */
export type OllamaDetectionResult = LocalInferenceDetectionResult;

/**
 * Probe common local-inference ports on 127.0.0.1 via the OpenAI-compat
 * `/v1/models` endpoint and return the first server that responds.
 *
 * Never throws — returns `{ available: false }` on any error or if no
 * server responds. Individual probes time out after 2 seconds each to
 * avoid blocking startup.
 *
 * When `baseUrl` is supplied, probes only that URL (for users who've
 * persisted a custom endpoint). Otherwise probes the default port list.
 */
export async function detectLocalInference(
  baseUrl?: string,
): Promise<LocalInferenceDetectionResult> {
  const empty: LocalInferenceDetectionResult = {
    available: false,
    models: [],
    url: "",
    bestModel: "",
  };

  const candidates = baseUrl
    ? [baseUrl]
    : DEFAULT_LOCAL_INFERENCE_PORTS.map((port) => `http://127.0.0.1:${port}`);

  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate);
    const result = await probeOneEndpoint(normalized);
    if (result.available) return result;
  }
  return empty;
}

/** @deprecated use `detectLocalInference`. Retained for one release cycle. */
export const detectOllama = detectLocalInference;

/** Append `/v1` if missing (mirrors sdk's `normalizeLocalServerEndpoint`). */
function normalizeCandidate(url: string): string {
  const stripped = url.replace(/\/+$/, "");
  if (/\/v1(\/|$)/.test(stripped)) return stripped;
  return `${stripped}/v1`;
}

async function probeOneEndpoint(baseUrl: string): Promise<LocalInferenceDetectionResult> {
  const empty: LocalInferenceDetectionResult = {
    available: false,
    models: [],
    url: "",
    bestModel: "",
  };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const res = await fetch(`${baseUrl}/models`, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return empty;

    // OpenAI-format response: { data: [{id: string}, ...] }
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const models = (data.data ?? []).map((m) => m.id);
    if (models.length === 0) return { ...empty, available: true, url: baseUrl };

    // Pick best model: case-insensitive substring match against preference list.
    let bestModel = "";
    for (const preferred of PREFERRED_LOCAL_MODELS) {
      const match = models.find((m) => m.toLowerCase().includes(preferred));
      if (match != null) {
        bestModel = match;
        break;
      }
    }
    if (bestModel === "") bestModel = models[0]!;

    return { available: true, models, url: baseUrl, bestModel };
  } catch {
    return empty;
  }
}

// === Deprecated aliases ===

/**
 * @deprecated Use `AnthropicProvider`. Historical name retained for one
 * release cycle. The "Cloud" prefix was a category error — this class
 * has only ever spoken the Anthropic wire protocol.
 */
export const CloudProvider = AnthropicProvider;
/** @deprecated Use `AnthropicProviderConfig`. */
export type CloudProviderConfig = AnthropicProviderConfig;
