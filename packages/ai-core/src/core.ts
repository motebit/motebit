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
import {
  SensitivityLevel,
  MemoryType,
  MEMORY_SOURCE_MARKERS,
  MEMORY_SOURCE_MARKER_UNKNOWN,
  isMemorySource,
} from "@motebit/sdk";
import type { MemorySource } from "@motebit/sdk";
import { buildSystemPromptCacheable as buildPromptCacheable } from "./prompt.js";

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
  /**
   * Optional duration sink — called with the wall-clock ms the stage took,
   * on both the success and timeout paths. Used for TTFT instrumentation
   * (single source for per-stage timing); never affects control flow.
   */
  onDuration?: (elapsedMs: number) => void,
): Promise<T> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StageTimeoutError(stage, ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onDuration) onDuration(Date.now() - start);
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
  /** Cheap "has any memory?" probe (limit:1) that gates embed + retrieval. */
  memory_probe: 10_000,
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
  /**
   * Enable Anthropic extended thinking. OFF by default (undefined) — the entire
   * feature is inert unless set, so behavior is byte-identical for existing
   * deployments. When set, the request carries `thinking: { type: "enabled",
   * budget_tokens }`, `temperature` is omitted (extended thinking requires the
   * default), `max_tokens` is bumped above the budget, and thinking blocks are
   * preserved across tool-use turns (`ThinkingBlock`). `budgetTokens` must be
   * ≥ 1024. Only applied on models that support it (`modelSupportsExtendedThinking`);
   * silently omitted otherwise so a mixed model fleet never 400s. The operator is
   * responsible for validating cost/behavior on their model before enabling.
   */
  extendedThinking?: { budgetTokens: number };
  /**
   * Fired when a response carries `X-Motebit-Routing-Reason`. The
   * motebit-cloud proxy emits this header alongside the proxied
   * Anthropic response to surface the auto-routing decision the
   * proxy made (model + reason) — sibling-shape of
   * `X-Motebit-Content-Manifest` on the state-export surface.
   * Anthropic's own API and BYOK passthroughs don't emit this
   * header, so the callback fires only for cloud-mode users.
   *
   * Doctrine: `docs/doctrine/auto-routing-as-protocol-primitive.md`
   * § "PR 4 — chrome narration of routing decisions". The consumer
   * mirror of the producer-side header (PR 4a). Surfaces that wire
   * the callback get the same routing-chip narration BYOK + on-device
   * already render via `formatRoutingChip(decision)`, closing the
   * three-tier (BYOK / on-device / cloud) chip-availability asymmetry.
   */
  onRoutingReason?: (reason: string) => void;
}

// === Context Packing ===

/**
 * Escape data-boundary and provenance markers embedded in memory
 * content. Content is formed from conversations and tool output and may
 * carry injected directives — it must not be able to fabricate its own
 * `[MEMORY_DATA]` boundary OR spoof a `[from:user]` provenance marker
 * (the marker renders OUTSIDE the boundary; this escape forecloses an
 * in-content fake).
 */
function escapeMemoryContent(content: string): string {
  return content
    .replace(/\[MEMORY_DATA\b/g, "[ESCAPED_MEMORY")
    .replace(/\[\/MEMORY_DATA\]/g, "[/ESCAPED_MEMORY]")
    .replace(/\[from:/g, "[escaped-from:");
}

/**
 * One memory line: provenance marker + confidence OUTSIDE the data
 * boundary, content inside. `[from:user]` is the only marker that
 * records a direct user statement; everything else is an absorbed
 * claim the prompt teaches the model to weigh accordingly
 * (docs/doctrine/memory-provenance.md). Any source that is NOT a known
 * `MemorySource` member — absent, or present-but-corrupt (a malformed enum
 * from a tampered/forward-version store) — renders honestly as `unknown`,
 * never `[from:undefined]` and never fabricated. The `isMemorySource` guard
 * (not a non-null check) is what makes the render fail closed: the type says
 * `MemorySource`, but the bytes on disk are not type-checked, so the marker is
 * derived only after re-validating the value at the boundary where it becomes
 * a claim to the model.
 */
function renderMemoryLine(mem: {
  content: string;
  confidence: number;
  source?: MemorySource;
}): string {
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- pinned is narrowed to any via `in` check
  const prefix = "pinned" in mem && (mem as { pinned?: boolean }).pinned ? "[pinned] " : "";
  const marker = isMemorySource(mem.source)
    ? MEMORY_SOURCE_MARKERS[mem.source]
    : MEMORY_SOURCE_MARKER_UNKNOWN;
  return `  ${prefix}[from:${marker}] [confidence=${mem.confidence.toFixed(2)}] [MEMORY_DATA]${escapeMemoryContent(mem.content)}[/MEMORY_DATA]`;
}

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
        parts.push(renderMemoryLine(mem));
      }
    }

    if (episodic.length > 0) {
      parts.push("[What Happened Recently]");
      for (const mem of episodic) {
        parts.push(renderMemoryLine(mem));
      }
    }
  }

  // Curiosity hints — fading memories the agent might check in about
  if (contextPack.curiosityHints && contextPack.curiosityHints.length > 0) {
    parts.push("[Getting Fuzzy]");
    for (const hint of contextPack.curiosityHints.slice(0, 2)) {
      const safeHint = escapeMemoryContent(hint.content);
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
  /** Extended-thinking block content (`type === "thinking"`). */
  thinking?: string;
  /** Cryptographic signature of a thinking block — required to round-trip it. */
  signature?: string;
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
    /** Extended-thinking streaming delta (`type === "thinking_delta"`). */
    thinking?: string;
    /** Signature streaming delta (`type === "signature_delta"`). */
    signature?: string;
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

/**
 * Maximum length for a task-step narration. Caps the chrome's
 * narration strip at a width that reads as calm-software (a single
 * line, not a paragraph). The model's prompt clause already targets
 * ~80 chars; this is the runtime ceiling. Narrations longer than
 * this get truncated to the ceiling minus the ellipsis (we don't
 * want to drop information, but we also don't want the chrome to
 * line-wrap into a multi-line block).
 */
const TASK_STEP_NARRATION_MAX_CHARS = 80;

/**
 * Extract the task-step narration tag from the model's response
 * text. Returns the trimmed content of the LAST `<narration>` tag,
 * or null when no tag is present.
 *
 * **Multiple-tag policy: take the LAST.** Asymmetric with
 * `extractMemoryTags` (which takes ALL because memory is cumulative).
 * Narration is about the model's CURRENT task-step — last tag is the
 * most recent thought; first tag would represent stale state. The
 * prompt clause instructs single-tag emission per turn; last-wins is
 * the right default if the model violates the instruction.
 *
 * Producer for the `task_step_narration` typed-truth triple. Wire
 * field on `AIResponse` (in `@motebit/sdk`); prompt clause in
 * `PERCEPTION_DOCTRINE`; runtime validation in
 * `narration-validation.ts`. This is the missing fourth part — the
 * EXPLICIT producer that bridges model text → AIResponse field.
 *
 * Doctrine: `chrome-as-state-render.md` § "Hybrid narration source"
 * + the four-part typed-truth-triple structure (wire + prompt +
 * producer + validator) — see project memory note
 * `architecture_typed_truth_four_parts.md` for the asymmetry between
 * implicit (tool-result) and explicit (narration) producers.
 */
export function extractNarrationTag(text: string): string | null {
  const regex = /<narration\s*>([\s\S]*?)<\/narration\s*>/g;
  let lastContent: string | null = null;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const content = match[1]!.trim();
    if (content !== "") {
      lastContent = content;
    }
  }
  if (lastContent === null) return null;
  // Cap to the chrome's calm-software ceiling. Truncate with an
  // ellipsis rather than dropping the whole field — partial truth
  // beats no truth in the chrome's narration register.
  if (lastContent.length > TASK_STEP_NARRATION_MAX_CHARS) {
    return lastContent.slice(0, TASK_STEP_NARRATION_MAX_CHARS - 1) + "…";
  }
  return lastContent;
}

// Narration tags strip via `stripTags` above (alongside <memory>,
// <state>, <thinking>) — keeps the visible-text strip in one place
// per the existing tag-handling convention. The narration BELONGS
// to the slab's chrome register (`motebit × virtual_browser` cell),
// not to the mote-conversation register; visible-text strip
// enforces the registers stay distinct (`goals → chat`, `task-steps
// → chrome` per `chrome-as-state-render.md` and
// `goals-vs-tasks.md`).

/**
 * Producer for `AIResponse.reasoning` — the model's interior cognition
 * (`<thinking>`), captured for the owner-facing `mind` embodiment organ
 * (`render-engine` `EMBODIMENT_MODE_CONTRACTS.mind`: `source:"interior"`,
 * `observer:"self"`, `consent:"always-permitted"`).
 *
 * Until now `<thinking>` was `stripTags`-ped out of the visible text and
 * captured NOWHERE — the reasoning trace was destroyed before it could reach
 * the one surface built to hold it. Stripping it from the mote-conversation
 * register is correct-calm (interior cognition must not clutter the chat); but
 * DESTROYING it starves the `mind` organ. This extractor is the missing
 * producer: it captures what the strip discards, so the interior is legible to
 * the OWNER without cluttering the conversation (`felt-interior.md` — "an
 * interior the sovereign cannot feel is, to them, no interior").
 *
 * INTERIOR-ONLY. Unlike `task_step_narration` (a bounded chrome string) this is
 * the full reasoning trace, and it is owner-facing by construction: it MUST NOT
 * be synced, egressed, persisted to a shared surface, or sent to an external
 * AI. The `mind` contract's `observer:"self"` is the boundary.
 *
 * Concatenates ALL `<thinking>` blocks in emission order (a turn may reason in
 * several passes) — no length cap: the organ is interior, not the calm chrome
 * strip. Returns `null` when the model emitted no reasoning (fail-closed: no
 * interior cognition → no `reasoning` field → the organ renders empty), which
 * keeps the field purely additive.
 */
export function extractReasoningTags(text: string): string | null {
  const regex = /<thinking\s*>([\s\S]*?)<\/thinking\s*>/g;
  const parts: string[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    const content = match[1]!.trim();
    if (content !== "") parts.push(content);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Merge the two interior-reasoning sources into `AIResponse.reasoning`:
 * `native` is the model's NATIVE reasoning stream (Anthropic extended-thinking
 * `thinking_delta` / `thinking` blocks; OpenAI-compat `reasoning_content`),
 * accumulated raw off the wire; `tagged` is `extractReasoningTags` over the
 * visible text (the `<thinking>`-tag convention). A model reasons via one
 * mechanism or the other — rarely both — so this prefers native and appends
 * tagged only if also present, returning `null` when neither produced anything
 * (the fail-closed default: no reasoning → no field → no disclosure).
 */
export function mergeReasoning(native: string, tagged: string | null): string | null {
  const n = native.trim();
  if (n === "") return tagged;
  return tagged ? `${n}\n\n${tagged}` : n;
}

/**
 * Whether a model supports Anthropic extended thinking — the safety net that
 * keeps a mixed model fleet from 400-ing when `extendedThinking` is configured.
 * Extended thinking is a Claude 3.7 Sonnet + Claude 4/5-family (Sonnet/Opus)
 * capability; Haiku and pre-3.7 models don't support it. Operator opt-in still
 * gates the whole feature; this only prevents applying it where it's known-bad.
 */
export function modelSupportsExtendedThinking(model: string): boolean {
  return /claude-(?:3-7-sonnet|(?:opus|sonnet)-(?:[4-9]|\d\d))/i.test(model);
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
    .replace(/<narration\s*>[\s\S]*?<\/narration\s*>/g, "")
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
 * Strip every internal tag and prompt-injection boundary marker the runtime
 * emits into streaming output — including partial fragments mid-stream.
 *
 * Canonical chat-surface primitive: every surface that renders streaming
 * assistant text (desktop, web, mobile, spatial, cli TUI) routes through
 * this function. The set of tags/markers evolves with the runtime —
 * adding a new one (e.g. a future `<plan>…</plan>` narration envelope)
 * lands in one place and every surface picks it up.
 *
 * What's stripped:
 *
 *   - `<state key="value" />`              — state update narration
 *   - `<thinking>…</thinking>`             — model reasoning traces
 *   - `<memory key="…">…</memory>`         — memory-formation narration
 *   - `[EXTERNAL_DATA source="…"]…[/EXTERNAL_DATA]` — tool-result boundaries
 *   - `[MEMORY_DATA]…[/MEMORY_DATA]`       — recalled-memory boundaries
 *   - Any of the above in partial/unclosed form (streaming mid-tag)
 *
 * Does NOT strip the `*action*` asterisk pattern used in creature action
 * syntax — that is a plain-text-surface concern composed on top of this
 * function (see {@link stripPartialActionTag}).
 *
 * Before this primitive was centralized, `apps/web/src/ui/chat.ts` had
 * its own copy of the full set while desktop's `stripPartialActionTag`
 * only handled `<memory>` + `<state/>`. Runtime chunks carrying
 * `<thinking>` or `[EXTERNAL_DATA]` markers rendered as visible chat
 * content on desktop. One primitive, one regex set, surfaces converge.
 */
export function stripInternalTags(text: string): string {
  return (
    text
      // Completed tag/marker pairs
      .replace(/<state\s+[^>]*\/>/g, "")
      .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
      .replace(/<memory\s+[^>]*>[\s\S]*?<\/memory>/g, "")
      .replace(/\[EXTERNAL_DATA[^\]]*\][\s\S]*?\[\/EXTERNAL_DATA\]/g, "")
      .replace(/\[MEMORY_DATA\][\s\S]*?\[\/MEMORY_DATA\]/g, "")
      // Partial fragments — opener or closer alone, mid-stream
      .replace(/\[EXTERNAL_DATA[^\]]*\]/g, "")
      .replace(/\[\/EXTERNAL_DATA\]/g, "")
      .replace(/\[MEMORY_DATA\]/g, "")
      .replace(/\[\/MEMORY_DATA\]/g, "")
      .replace(/<(?:state|thinking|memory)[^>]*$/g, "")
  );
}

/**
 * Strip internal tags plus the creature's `*action*` asterisk syntax and
 * normalize whitespace. Used by plain-text chat surfaces (desktop) that
 * render `bubble.textContent` directly — markdown surfaces (web) use
 * `stripInternalTags` alone because their `*italic*` asterisks are
 * rendered by the markdown pass, not stripped.
 */
export function stripPartialActionTag(text: string): string {
  return stripInternalTags(text)
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
  setTemperature?(temperature: number | undefined): void;
  setMaxTokens?(maxTokens: number): void;
  generateStream(
    contextPack: ContextPack,
  ): AsyncGenerator<{ type: "text"; text: string } | { type: "done"; response: AIResponse }>;
}

// === Tool-result image content (vision-2) ===

/**
 * Convert a tool-result content string to Anthropic's tool_result content
 * shape, splitting embedded screenshot bytes into a separate `image`
 * content block when the upstream gate (`projectForAi` —
 * `packages/ai-core/src/loop.ts`) let bytes pass through.
 *
 * **Why this lives here.** `projectForAi` is the AI-perception
 * boundary — the policy decision about whether bytes reach the AI.
 * It composes provider mode + sensitivity + pixel consent into a
 * pass-or-strip decision and writes the result into the
 * conversation history's `tool_result` content as a JSON-stringified
 * envelope (`{ ok, data: {...bytes_base64...} }`).
 *
 * **The gap vision-2 closes.** A JSON string containing base64 is
 * not pixels. Anthropic's vision API requires a structured
 * `image` content block (`{type:"image", source:{type:"base64",
 * media_type, data}}`). Without this conversion the model receives
 * a string with a long base64 substring and treats it as text —
 * the gate authorized passage but the model still couldn't see.
 *
 * **What this does.** Parses the tool-result envelope. If the data
 * carries a `screenshot` or `navigate` kind with `bytes_base64`,
 * splits the content into two blocks:
 *
 *   1. `text` — the JSON envelope WITH `bytes_base64` stripped (the
 *      metadata, no payload duplication).
 *   2. `image` — the bytes as a base64 image block in the format
 *      Anthropic expects.
 *
 * If the bytes weren't passed (gate stripped them) or the result
 * doesn't carry a screenshot, returns the original string unchanged.
 *
 * **Provider scope.** Anthropic-only. OpenAI's tool-result content
 * does not natively accept image blocks (its vision uses image_url
 * blocks in user messages, not tool_results); OpenAI vision is a
 * deferred slice. local-server providers go through OpenAIProvider
 * and inherit the same deferral.
 *
 * **Privacy invariants preserved.** This function is a pure
 * downstream re-shape — it never re-introduces bytes that were
 * already stripped upstream. The decision about whether bytes are
 * present at all is the projectForAi gate; this helper only
 * unflattens what's already in the envelope.
 */
/**
 * Attach `cache_control` to the final content block of the last message, so the
 * conversation prefix (history + within-turn tool rounds) caches. A string
 * content is promoted to a one-element text block to carry the marker; an
 * already-structured content array marks its last block. No-op on empty content
 * (Anthropic rejects empty text blocks, and there's nothing worth caching). The
 * marker moves to the newest message every request — Anthropic reads the longest
 * matching prefix and only (re)creates cache for the delta.
 */
function markLastMessageCacheable(messages: Record<string, unknown>[]): void {
  const last = messages[messages.length - 1];
  if (!last) return;
  const content = last.content;
  if (typeof content === "string") {
    if (content.length === 0) return;
    last.content = [{ type: "text", text: content, cache_control: { type: "ephemeral" } }];
    return;
  }
  if (Array.isArray(content) && content.length > 0) {
    const lastBlock = content[content.length - 1] as Record<string, unknown>;
    content[content.length - 1] = { ...lastBlock, cache_control: { type: "ephemeral" } };
  }
}

function buildToolResultContentForAnthropic(
  content: string,
): string | Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (parsed === null || typeof parsed !== "object") return content;
  const envelope = parsed as { data?: unknown };
  const data = envelope.data;
  if (data === null || typeof data !== "object") return content;
  const d = data as Record<string, unknown>;
  if (
    (d.kind === "screenshot" || d.kind === "navigate") &&
    typeof d.bytes_base64 === "string" &&
    d.bytes_base64.length > 0
  ) {
    // Anthropic supports png, jpeg, gif, webp. Default to png; jpeg
    // when the wire format declares it. The cloud-browser sandbox
    // emits png today (per services/browser-sandbox); accept jpeg
    // for forward-compat with future encoders.
    const formatHint = typeof d.image_format === "string" ? d.image_format : "png";
    const mediaType =
      formatHint === "jpeg" || formatHint === "jpg"
        ? "image/jpeg"
        : formatHint === "gif"
          ? "image/gif"
          : formatHint === "webp"
            ? "image/webp"
            : "image/png";
    // Strip bytes from the text portion — the bytes already live in
    // the image block; duplicating them would waste tokens (the
    // base64 string is still ~50KB) and force the model to choose
    // which copy is canonical.
    const { bytes_base64: _b, ...metadata } = d;
    const textEnvelope = JSON.stringify({ ...envelope, data: metadata });
    return [
      { type: "text", text: textEnvelope },
      {
        type: "image",
        source: { type: "base64", media_type: mediaType, data: d.bytes_base64 },
      },
    ];
  }
  return content;
}

// Exposed for unit tests in the same package.
export const __test_buildToolResultContentForAnthropic = buildToolResultContentForAnthropic;

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

  setTemperature(temperature: number | undefined): void {
    // Undefined clears the field → request body omits it → model uses its
    // default (required for Claude Opus 4.7+, which rejects the parameter).
    this.config.temperature = temperature;
  }

  setMaxTokens(maxTokens: number): void {
    this.config.max_tokens = maxTokens;
  }

  async generate(contextPack: ContextPack): Promise<AIResponse> {
    const baseUrl = this.config.base_url ?? this.getDefaultBaseUrl();
    const messages = this.buildMessages(contextPack);

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.max_tokens ?? 4096,
      // Only send temperature when the user explicitly configured it. Claude
      // Opus 4.7+ deprecates the parameter entirely and returns HTTP 400 when
      // it's present. Omitting it lets each model use its own default; users
      // who want to tune sampling still can via `config.temperature`.
      ...(this.config.temperature !== undefined && { temperature: this.config.temperature }),
      // Cacheable system blocks (see buildSystemBlocks) — the static prefix
      // caches at 1/10th input cost, the lever for cost on the agentic loop.
      system: this.buildSystemBlocks(contextPack),
      messages,
      stream: false,
    };

    const tools = this.buildCacheableTools(contextPack);
    if (tools) {
      body.tools = tools;
    }

    this.applyExtendedThinking(body);

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

    this.emitRoutingReason(res);

    const data = (await res.json()) as AnthropicResponse;
    return this.parseAnthropicResponse(data);
  }

  /**
   * Surface `X-Motebit-Routing-Reason` if the response carries it.
   * Non-cloud responses (direct Anthropic / BYOK passthrough) lack
   * the header — the callback simply doesn't fire. Best-effort —
   * a throwing callback must not break the AI call, so wrap in
   * try/catch and log via the runtime's logger when the callback
   * surfaces an error.
   */
  private emitRoutingReason(res: Response): void {
    if (!this.config.onRoutingReason) return;
    const reason = res.headers.get("X-Motebit-Routing-Reason");
    if (reason === null || reason === "") return;
    try {
      this.config.onRoutingReason(reason);
    } catch {
      // Routing narration is observability surface, never load-bearing
      // for the call itself. Swallow callback errors so a misbehaving
      // consumer can't crash the turn.
    }
  }

  async *generateStream(
    contextPack: ContextPack,
  ): AsyncGenerator<{ type: "text"; text: string } | { type: "done"; response: AIResponse }> {
    const baseUrl = this.config.base_url ?? this.getDefaultBaseUrl();
    const messages = this.buildMessages(contextPack);

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: this.config.max_tokens ?? 4096,
      // Only send temperature when the user explicitly configured it. Claude
      // Opus 4.7+ deprecates the parameter entirely and returns HTTP 400 when
      // it's present. Omitting it lets each model use its own default; users
      // who want to tune sampling still can via `config.temperature`.
      ...(this.config.temperature !== undefined && { temperature: this.config.temperature }),
      // Cacheable system blocks (see buildSystemBlocks) — same caching lever as
      // generate(); the streaming path is the one the chat surface actually uses.
      system: this.buildSystemBlocks(contextPack),
      messages,
      stream: true,
    };

    const tools = this.buildCacheableTools(contextPack);
    if (tools) {
      body.tools = tools;
    }

    this.applyExtendedThinking(body);

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

    this.emitRoutingReason(res);

    let accumulated = "";
    let nativeReasoning = "";
    const currentToolCalls: ToolCall[] = [];
    let activeToolId: string | undefined;
    let activeToolName: string | undefined;
    let activeToolJson = "";
    let inputTokens = 0;
    let outputTokens = 0;
    // Extended-thinking block assembly: text arrives as thinking_delta and the
    // signature as signature_delta within one content block; both are pushed at
    // content_block_stop for tool-use round-tripping.
    const thinkingBlocks: Array<{ thinking: string; signature: string }> = [];
    let currentThinking: { thinking: string; signature: string } | null = null;

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
              } else if (event.content_block?.type === "thinking") {
                currentThinking = { thinking: "", signature: "" };
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
              } else if (
                event.delta?.type === "thinking_delta" &&
                event.delta.thinking != null &&
                event.delta.thinking !== ""
              ) {
                // Native extended-thinking → interior reasoning for the `mind`
                // register. Accumulated raw off the wire, never into `accumulated`
                // (the visible text) — interior-only, and it never enters chat.
                nativeReasoning += event.delta.thinking;
                if (currentThinking) currentThinking.thinking += event.delta.thinking;
              } else if (
                event.delta?.type === "signature_delta" &&
                event.delta.signature != null &&
                event.delta.signature !== ""
              ) {
                if (currentThinking) currentThinking.signature += event.delta.signature;
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
              } else if (currentThinking != null) {
                // Close the thinking block. Only signature-bearing blocks are
                // round-trippable (Anthropic requires the signature on replay).
                if (currentThinking.signature !== "") thinkingBlocks.push(currentThinking);
                currentThinking = null;
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
    const taskStepNarration = extractNarrationTag(accumulated);
    const displayText = stripTags(accumulated);
    const reasoning = mergeReasoning(nativeReasoning, extractReasoningTags(accumulated));

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
        ...(taskStepNarration !== null ? { task_step_narration: taskStepNarration } : {}),
        ...(reasoning !== null ? { reasoning } : {}),
        ...(thinkingBlocks.length > 0 ? { thinking_blocks: thinkingBlocks } : {}),
      },
    };
  }

  estimateConfidence(): Promise<number> {
    return Promise.resolve(0.8);
  }

  extractMemoryCandidates(response: AIResponse): Promise<MemoryCandidate[]> {
    return Promise.resolve(response.memory_candidates);
  }

  /**
   * Apply Anthropic extended thinking to the request body when configured AND
   * the model supports it. Inert (no-op) otherwise — the whole feature is
   * off-by-default. When applied: enables thinking with the configured budget,
   * bumps `max_tokens` above the budget (thinking tokens count toward it, so the
   * response needs headroom), and removes `temperature` (the API rejects a
   * custom temperature alongside thinking). Thinking-block preservation across
   * tool-use turns is handled in `buildMessages` + the loop.
   */
  private applyExtendedThinking(body: Record<string, unknown>): void {
    const et = this.config.extendedThinking;
    if (!et || !modelSupportsExtendedThinking(this.config.model)) return;
    const budget = Math.max(1024, Math.floor(et.budgetTokens));
    body.thinking = { type: "enabled", budget_tokens: budget };
    const configured = typeof body.max_tokens === "number" ? body.max_tokens : 4096;
    body.max_tokens = Math.max(configured, budget + 4096);
    delete body.temperature;
  }

  private buildMessages(contextPack: ContextPack): Record<string, unknown>[] {
    const history = contextPack.conversation_history ?? [];
    const messages: Record<string, unknown>[] = [];

    for (const msg of history) {
      if (msg.role === "tool") {
        // Merge consecutive tool results into a single user message.
        // Anthropic requires ALL tool_results in one message after the assistant's tool_use.
        const prev = messages[messages.length - 1] as Record<string, unknown> | undefined;
        const resultContent = buildToolResultContentForAnthropic(msg.content);
        if (prev?.role === "user" && Array.isArray(prev.content)) {
          const blocks = prev.content as Record<string, unknown>[];
          if (blocks.length > 0 && blocks[0]?.type === "tool_result") {
            blocks.push({
              type: "tool_result",
              tool_use_id: msg.tool_call_id,
              content: resultContent,
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
              content: resultContent,
            },
          ],
        });
      } else if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
        const contentBlocks: Record<string, unknown>[] = [];
        // Extended thinking: preserved thinking blocks MUST come first (before
        // text/tool_use) and carry their signature, or Anthropic rejects the
        // tool-use continuation. Present only when extended thinking is enabled;
        // absent by default, so this is a no-op for existing deployments.
        for (const tb of msg.thinking_blocks ?? []) {
          contentBlocks.push({ type: "thinking", thinking: tb.thinking, signature: tb.signature });
        }
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

    // Incremental conversation caching: mark the final content block so
    // Anthropic caches the whole message prefix (history + within-turn tool
    // rounds). Each agentic-loop iteration and each new turn then READS the
    // prior prefix at 1/10th cost instead of re-paying it; Anthropic matches the
    // longest cached prefix and only creates cache for the newest delta. This is
    // the third cache breakpoint (with the static system block + last tool —
    // Anthropic's ceiling is 4).
    markLastMessageCacheable(messages);

    return messages;
  }

  /**
   * System prompt as structured content blocks with `cache_control` on the
   * static prefix, so Anthropic caches it (~3K tokens of identity + doctrine +
   * injection defense) at 1/10th input cost on every subsequent turn within the
   * 5-minute TTL. Critical for the agentic loop, where each tool round-trip is a
   * fresh request that would otherwise re-pay the full static prefix. The
   * dynamic suffix (state, memories, events) is a separate, uncached block.
   *
   * Anthropic accepts `system` as either a string or a block array; sending
   * blocks is the ONLY way to attach `cache_control` (a top-level `cache_control`
   * is silently ignored). When this provider talks to the motebit-cloud proxy,
   * the proxy passes the blocks through to its Anthropic upstream and flattens
   * them to a string for OpenAI/Google/Groq upstreams.
   */
  private buildSystemBlocks(
    contextPack: ContextPack,
  ): Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> {
    return buildPromptCacheable(contextPack, this.config.personalityConfig);
  }

  /**
   * Tool definitions with a `cache_control` breakpoint on the LAST tool, marking
   * the end of the (static) tools block as cacheable. Anthropic builds its cache
   * prefix in order tools → system → messages, so this breakpoint + the static
   * system block form the stable cached prefix; the schemas don't change between
   * turns, so they're re-paid at 1/10th cost. Returns undefined when no tools.
   */
  private buildCacheableTools(contextPack: ContextPack): Record<string, unknown>[] | undefined {
    if (!contextPack.tools || contextPack.tools.length === 0) return undefined;
    const tools: Record<string, unknown>[] = contextPack.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
    const lastIdx = tools.length - 1;
    tools[lastIdx] = { ...tools[lastIdx], cache_control: { type: "ephemeral" } };
    return tools;
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
    const taskStepNarration = extractNarrationTag(rawText);
    const displayText = stripTags(rawText);
    // Native extended-thinking blocks + the <thinking>-tag convention →
    // interior reasoning for the `mind` register. Interior-only.
    const thinkingContentBlocks = data.content.filter((block) => block.type === "thinking");
    const nativeReasoning = thinkingContentBlocks.map((block) => block.thinking ?? "").join("");
    const reasoning = mergeReasoning(nativeReasoning, extractReasoningTags(rawText));
    // Round-trippable thinking blocks (signature-bearing) for tool-use
    // continuation. Only present when extended thinking is enabled.
    const thinkingBlocks = thinkingContentBlocks
      .filter((block) => block.signature != null && block.signature !== "")
      .map((block) => ({ thinking: block.thinking ?? "", signature: block.signature! }));

    return {
      text: displayText,
      confidence: 0.8,
      memory_candidates: memoryCandidates,
      state_updates: stateUpdates,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      usage: data.usage,
      ...(taskStepNarration !== null ? { task_step_narration: taskStepNarration } : {}),
      ...(reasoning !== null ? { reasoning } : {}),
      ...(thinkingBlocks.length > 0 ? { thinking_blocks: thinkingBlocks } : {}),
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
// The rename from the original `detectOllama()` (probing Ollama's native
// `/api/tags`) to vendor-neutral OpenAI-compat probing landed in the
// 2026-04-06 Ollama privilege audit.

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
