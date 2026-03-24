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

export { inferStateFromText } from "./infer-state.js";
export { buildSystemPrompt, derivePersonalityNote, formatBodyAwareness } from "./prompt.js";
export { trimConversation } from "./context-window.js";
export type { ContextBudget } from "./context-window.js";
export { resolveConfig, DEFAULT_CONFIG } from "./config.js";
export type { MotebitPersonalityConfig } from "./config.js";
export { summarizeConversation, shouldSummarize } from "./summarizer.js";
export type { SummarizerConfig } from "./summarizer.js";
export { reflect, parseReflectionResponse } from "./reflection.js";
export type { ReflectionResult, PastReflection } from "./reflection.js";
export { TaskRouter, withTaskConfig } from "./task-router.js";
export type { TaskType, TaskProfile, TaskRouterConfig, ResolvedTaskConfig } from "./task-router.js";

// === Provider Configuration ===

export interface CloudProviderConfig {
  provider: "openai" | "anthropic" | "custom";
  api_key: string;
  model: string;
  base_url?: string;
  max_tokens?: number;
  temperature?: number;
  personalityConfig?: import("./config.js").MotebitPersonalityConfig;
}

export interface HybridProviderConfig {
  cloud: CloudProviderConfig;
  /** Ollama config for streaming-capable local fallback. */
  ollama?: OllamaProviderConfig;
  fallback_to_local: boolean;
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

// === Cloud Provider ===

export class CloudProvider implements StreamingProvider {
  constructor(private config: CloudProviderConfig) {}

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
      temperature: this.config.temperature ?? 0.7,
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

    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.api_key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
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
      temperature: this.config.temperature ?? 0.7,
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

    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.api_key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorText = await res.text();
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

    if (contextPack.activationPrompt) {
      messages.push({ role: "user", content: "[listening]" });
    } else {
      messages.push({ role: "user", content: contextPack.user_message });
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
    switch (this.config.provider) {
      case "openai":
        return "https://api.openai.com";
      case "anthropic":
        return "https://api.anthropic.com";
      default:
        return this.config.base_url ?? "";
    }
  }
}

// === Hybrid Provider ===

export class HybridProvider implements StreamingProvider {
  private cloud: CloudProvider;
  private local: OllamaProvider | null;
  private config: HybridProviderConfig;

  constructor(config: HybridProviderConfig) {
    this.config = config;
    this.cloud = new CloudProvider(config.cloud);
    this.local = config.ollama ? new OllamaProvider(config.ollama) : null;
  }

  get model(): string {
    return this.cloud.model;
  }

  get temperature(): number | undefined {
    return this.cloud.temperature;
  }

  get maxTokens(): number | undefined {
    return this.cloud.maxTokens;
  }

  setModel(model: string): void {
    this.cloud.setModel(model);
  }

  setTemperature(temperature: number): void {
    this.cloud.setTemperature(temperature);
  }

  setMaxTokens(maxTokens: number): void {
    this.cloud.setMaxTokens(maxTokens);
  }

  async generate(contextPack: ContextPack): Promise<AIResponse> {
    try {
      return await this.cloud.generate(contextPack);
    } catch (err: unknown) {
      if (this.config.fallback_to_local && this.local !== null) {
        return this.local.generate(contextPack);
      }
      throw new Error("Cloud provider failed and no local fallback available", { cause: err });
    }
  }

  async *generateStream(
    contextPack: ContextPack,
  ): AsyncGenerator<{ type: "text"; text: string } | { type: "done"; response: AIResponse }> {
    try {
      yield* this.cloud.generateStream(contextPack);
    } catch (err: unknown) {
      if (this.config.fallback_to_local && this.local !== null) {
        yield* this.local.generateStream(contextPack);
      } else {
        throw new Error("Cloud provider failed and no local fallback available", { cause: err });
      }
    }
  }

  async estimateConfidence(): Promise<number> {
    try {
      return await this.cloud.estimateConfidence();
    } catch {
      if (this.local !== null) {
        return this.local.estimateConfidence();
      }
      return 0;
    }
  }

  extractMemoryCandidates(response: AIResponse): Promise<MemoryCandidate[]> {
    return this.cloud.extractMemoryCandidates(response);
  }
}

// === Ollama Provider ===

export interface OllamaProviderConfig {
  model: string;
  base_url?: string;
  max_tokens?: number;
  temperature?: number;
  personalityConfig?: import("./config.js").MotebitPersonalityConfig;
}

export class OllamaProvider implements StreamingProvider {
  private config: OllamaProviderConfig;

  constructor(config: OllamaProviderConfig) {
    this.config = config;
  }

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
    const baseUrl = this.config.base_url ?? DEFAULT_OLLAMA_URL;
    const messages = this.buildMessages(contextPack);

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream: false,
      options: {
        temperature: this.config.temperature ?? 0.7,
        num_predict: this.config.max_tokens ?? 4096,
      },
    };

    if (contextPack.tools && contextPack.tools.length > 0) {
      body.tools = contextPack.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
        throw new Error(
          `Cannot connect to Ollama at ${baseUrl}. Is Ollama running? Start it with: ollama serve`,
          { cause: err },
        );
      }
      throw err;
    }

    if (!res.ok) {
      const errorText = await res.text();
      if (res.status === 404) {
        throw new Error(
          `Ollama model "${this.config.model}" not found. Run: ollama pull ${this.config.model}`,
        );
      }
      throw new Error(`Ollama API error ${res.status}: ${errorText}`);
    }

    const data = (await res.json()) as {
      message: {
        content: string;
        tool_calls?: Array<{
          function: { name: string; arguments: Record<string, unknown> };
        }>;
      };
    };

    const response = this.parseResponse(data.message.content);
    if (data.message.tool_calls && data.message.tool_calls.length > 0) {
      response.tool_calls = data.message.tool_calls.map((tc) => ({
        id: crypto.randomUUID(),
        name: tc.function.name,
        args: tc.function.arguments,
      }));
    }
    return response;
  }

  async *generateStream(
    contextPack: ContextPack,
  ): AsyncGenerator<{ type: "text"; text: string } | { type: "done"; response: AIResponse }> {
    const baseUrl = this.config.base_url ?? DEFAULT_OLLAMA_URL;
    const messages = this.buildMessages(contextPack);

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      stream: true,
      options: {
        temperature: this.config.temperature ?? 0.7,
        num_predict: this.config.max_tokens ?? 4096,
      },
    };

    if (contextPack.tools && contextPack.tools.length > 0) {
      body.tools = contextPack.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
        throw new Error(
          `Cannot connect to Ollama at ${baseUrl}. Is Ollama running? Start it with: ollama serve`,
          { cause: err },
        );
      }
      throw err;
    }

    if (!res.ok) {
      const errorText = await res.text();
      if (res.status === 404) {
        throw new Error(
          `Ollama model "${this.config.model}" not found. Run: ollama pull ${this.config.model}`,
        );
      }
      throw new Error(`Ollama API error ${res.status}: ${errorText}`);
    }

    let accumulated = "";
    const collectedToolCalls: ToolCall[] = [];
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
          if (line.trim() === "") continue;

          try {
            const chunk = JSON.parse(line) as {
              message?: {
                content: string;
                tool_calls?: Array<{
                  function: { name: string; arguments: Record<string, unknown> };
                }>;
              };
              done: boolean;
            };
            if (chunk.message?.content != null && chunk.message.content !== "") {
              accumulated += chunk.message.content;
              yield { type: "text", text: chunk.message.content };
            }
            if (chunk.message?.tool_calls) {
              for (const tc of chunk.message.tool_calls) {
                collectedToolCalls.push({
                  id: crypto.randomUUID(),
                  name: tc.function.name,
                  args: tc.function.arguments,
                });
              }
            }
          } catch {
            // Skip unparseable NDJSON lines
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
        ...(collectedToolCalls.length > 0 ? { tool_calls: collectedToolCalls } : {}),
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
    const systemPrompt = this.buildSystemPrompt(contextPack);
    const history = contextPack.conversation_history ?? [];
    const messages: Record<string, unknown>[] = [{ role: "system", content: systemPrompt }];

    for (const msg of history) {
      if (msg.role === "tool") {
        messages.push({ role: "tool", content: msg.content });
      } else {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    if (contextPack.activationPrompt) {
      messages.push({ role: "user", content: "[listening]" });
    } else {
      messages.push({ role: "user", content: contextPack.user_message });
    }
    return messages;
  }

  private buildSystemPrompt(contextPack: ContextPack): string {
    return buildPrompt(contextPack, this.config.personalityConfig);
  }

  private parseResponse(rawText: string): AIResponse {
    const memoryCandidates = extractMemoryTags(rawText);
    const stateUpdates = extractStateTags(rawText);
    const displayText = stripTags(rawText);

    return {
      text: displayText,
      confidence: 0.8,
      memory_candidates: memoryCandidates,
      state_updates: stateUpdates,
    };
  }
}

// === Ollama Auto-Detection ===

/** Preferred model order for auto-detection. */
const PREFERRED_OLLAMA_MODELS = ["llama3.1", "llama3", "mistral", "gemma2"];

export interface OllamaDetectionResult {
  available: boolean;
  models: string[];
  url: string;
  /** Best available model based on preference order, or empty string. */
  bestModel: string;
}

/**
 * Probe a local Ollama instance and return available models.
 * Never throws — returns `{ available: false }` on any error.
 * Times out after 2 seconds to avoid blocking startup.
 */
export async function detectOllama(baseUrl = DEFAULT_OLLAMA_URL): Promise<OllamaDetectionResult> {
  const empty: OllamaDetectionResult = { available: false, models: [], url: "", bestModel: "" };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const res = await fetch(`${baseUrl}/api/tags`, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return empty;

    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const models = (data.models ?? []).map((m) => m.name);
    if (models.length === 0) return { ...empty, available: true, url: baseUrl };

    // Pick best model: try preferred list first (match base name ignoring :tag)
    let bestModel = "";
    for (const preferred of PREFERRED_OLLAMA_MODELS) {
      const match = models.find((m) => m === preferred || m.startsWith(`${preferred}:`));
      if (match != null) {
        bestModel = match;
        break;
      }
    }
    // Fall back to first available model
    if (bestModel === "") bestModel = models[0]!;

    return { available: true, models, url: baseUrl, bestModel };
  } catch {
    return empty;
  }
}
