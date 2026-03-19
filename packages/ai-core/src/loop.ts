import type {
  BehaviorCues,
  MotebitState,
  MemoryNode,
  MemoryCandidate,
  ToolRegistry,
  ToolDefinition,
  ToolResult,
  ToolRiskProfile,
  PolicyDecision,
  TurnContext,
  ConversationMessage,
} from "@motebit/sdk";
import { EventType, RelationType, SensitivityLevel } from "@motebit/sdk";
import type { EventStore } from "@motebit/event-log";
import type { MemoryGraph, ConsolidationProvider } from "@motebit/memory-graph";
import { embedText, cosineSimilarity } from "@motebit/memory-graph";
import type { StateVectorEngine } from "@motebit/state-vector";
import type { BehaviorEngine } from "@motebit/behavior-engine";
import type { StreamingProvider } from "./index.js";
import { inferStateFromText } from "./infer-state.js";

// === Constants ===

const MAX_TOOL_ITERATIONS = 10;

// === Missed-memory heuristic detection ===

const PREFERENCE_RE = /\b(?:i\s+(?:like|prefer|love|enjoy|hate|dislike|can't stand))\s+(.{3,60})/gi;
const PERSONAL_FACT_RE =
  /\b(?:i(?:'m|\s+am)\s+from|i\s+live\s+in|i\s+work\s+at|my\s+name\s+is|i(?:'m|\s+am)\s+a\b)\s+(.{2,60})/gi;
const GOAL_RE =
  /\b(?:i\s+want\s+to|i(?:'m|\s+am)\s+planning\s+to|i\s+need\s+to|i(?:'m|\s+am)\s+trying\s+to|my\s+goal\s+is)\s+(.{3,80})/gi;
const CORRECTION_RE =
  /\b(?:actually,?\s+i\s+meant|no,?\s+i\s+(?:said|mean)|i\s+meant\s+to\s+say)\s+(.{3,80})/gi;

/**
 * Lightweight heuristic check for memory-worthy patterns in conversation text
 * that the model did not tag with <memory>. For audit/logging only — does NOT
 * create memories (false positive risk is too high for automatic formation).
 */
export function detectUntaggedMemoryPatterns(
  userMessage: string,
  aiResponse: string,
  taggedMemories: MemoryCandidate[],
): string[] {
  const taggedLower = taggedMemories.map((m) => m.content.toLowerCase());

  function isAlreadyCaptured(matchText: string): boolean {
    const lower = matchText.toLowerCase().trim();
    return taggedLower.some((t) => t.includes(lower) || lower.includes(t));
  }

  const patterns: { label: string; re: RegExp; source: string }[] = [
    { label: "preference", re: PREFERENCE_RE, source: userMessage },
    { label: "personal_fact", re: PERSONAL_FACT_RE, source: userMessage },
    { label: "goal", re: GOAL_RE, source: userMessage },
    { label: "correction", re: CORRECTION_RE, source: userMessage },
    // Also scan AI response for preferences/facts it acknowledged but didn't tag
    { label: "preference_in_response", re: PREFERENCE_RE, source: aiResponse },
  ];

  const detected: string[] = [];

  for (const { label, re, source } of patterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const captured = match[1]?.trim();
      if (captured != null && captured !== "" && !isAlreadyCaptured(captured)) {
        detected.push(`${label}: "${match[0].trim()}"`);
      }
    }
  }

  return detected;
}

// === Inline boundary wrapping (no dependency on @motebit/policy) ===

const EXTERNAL_DATA_START = "[EXTERNAL_DATA source=";
const EXTERNAL_DATA_END = "[/EXTERNAL_DATA]";

function wrapExternalData(data: unknown, toolName: string): string {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  const escaped = text
    .replace(/\[EXTERNAL_DATA\b/g, "[ESCAPED_DATA")
    .replace(/\[\/EXTERNAL_DATA\]/g, "[/ESCAPED_DATA]");
  const safeName = toolName.replace(/[[\]"\\]/g, "_").slice(0, 100);
  return `${EXTERNAL_DATA_START}"tool:${safeName}"]\n${escaped}\n${EXTERNAL_DATA_END}`;
}

// === Types ===

/**
 * Minimal policy interface for the agentic loop.
 * ai-core does NOT depend on @motebit/policy — PolicyGate satisfies this
 * through structural typing.
 */
export interface LoopPolicyGate {
  filterTools(tools: ToolDefinition[]): ToolDefinition[];
  validate(tool: ToolDefinition, args: Record<string, unknown>, ctx: TurnContext): PolicyDecision;
  classify(tool: ToolDefinition): ToolRiskProfile;
  sanitizeResult(result: ToolResult, toolName: string): ToolResult;
  sanitizeAndCheck?(
    result: ToolResult,
    toolName: string,
  ): {
    result: ToolResult;
    injectionDetected: boolean;
    injectionPatterns: string[];
    directiveDensity?: number;
    structuralFlags?: string[];
  };
  logInjection?(
    turnId: string,
    callId: string,
    tool: string,
    args: Record<string, unknown>,
    injection: {
      detected: boolean;
      patterns: string[];
      directiveDensity?: number;
      structuralFlags?: string[];
    },
    blocked: boolean,
    runId?: string,
  ): void;
  createTurnContext(runId?: string): TurnContext;
  recordToolCall(ctx: TurnContext, cost?: number): TurnContext;
}

/**
 * Minimal memory governance interface for the agentic loop.
 * MemoryGovernor from @motebit/policy satisfies this through structural typing.
 */
export interface LoopMemoryGovernor {
  evaluate(
    candidates: MemoryCandidate[],
  ): { candidate: MemoryCandidate; memoryClass: string; reason: string }[];
}

export interface MotebitLoopDependencies {
  motebitId: string;
  eventStore: EventStore;
  memoryGraph: MemoryGraph;
  stateEngine: StateVectorEngine;
  behaviorEngine: BehaviorEngine;
  provider: StreamingProvider;
  tools?: ToolRegistry;
  policyGate?: LoopPolicyGate;
  memoryGovernor?: LoopMemoryGovernor;
  consolidationProvider?: ConsolidationProvider;
}

export interface TurnResult {
  response: string;
  memoriesFormed: MemoryNode[];
  memoriesRetrieved: MemoryNode[];
  stateAfter: MotebitState;
  cues: BehaviorCues;
  /** Total token usage across all LLM calls in this turn, if available. */
  totalTokens?: number;
  /** Number of agentic loop iterations used in this turn. */
  iterations: number;
  /** Number of tool calls that executed successfully. */
  toolCallsSucceeded: number;
  /** Number of tool calls blocked by policy or requiring approval. */
  toolCallsBlocked: number;
  /** Number of tool calls that failed during execution. */
  toolCallsFailed: number;
}

export interface TurnOptions {
  conversationHistory?: ConversationMessage[];
  previousCues?: BehaviorCues;
  runId?: string;
  /** Session resumption info — set when the runtime loaded a persisted conversation. */
  sessionInfo?: { continued: boolean; lastActiveAt: number };
  /** Fading memories the agent might want to check in about, if relevant to conversation. */
  curiosityHints?: Array<{ content: string; daysSinceDiscussed: number }>;
  /** Known agents this motebit has interacted with — trust context for the AI. */
  knownAgents?: import("@motebit/sdk").AgentTrustRecord[];
  /** Active inference precision context string — injected into system prompt to modulate behavior. */
  precisionContext?: string;
  /** Delegation scope — restricts tool calls to tools within this scope set. */
  delegationScope?: string;
}

export type AgenticChunk =
  | { type: "text"; text: string }
  | { type: "tool_status"; name: string; status: "calling" | "done"; result?: unknown }
  | {
      type: "approval_request";
      tool_call_id: string;
      name: string;
      args: Record<string, unknown>;
      risk_level?: number;
      quorum?: { required: number; approvers: string[]; collected: string[] };
    }
  | { type: "injection_warning"; tool_name: string; patterns: string[] }
  | { type: "result"; result: TurnResult };

// === Orchestrator ===

export async function runTurn(
  deps: MotebitLoopDependencies,
  userMessage: string,
  options?: TurnOptions,
): Promise<TurnResult> {
  let result: TurnResult | undefined;

  for await (const chunk of runTurnStreaming(deps, userMessage, options)) {
    switch (chunk.type) {
      case "result":
        result = chunk.result;
        break;
      case "approval_request":
        // Non-streaming callers cannot handle interactive approval — auto-deny.
        // The streaming loop already pushes "Awaiting approval" into conversation
        // history, so the model will see the denial on the next iteration.
        break;
      case "injection_warning":
        // Logged by the streaming loop; nothing to surface in non-streaming mode.
        break;
      // "text" and "tool_status" chunks are intermediate — ignore.
    }
  }

  if (!result) {
    throw new Error("runTurnStreaming ended without producing a result");
  }

  return result;
}

export async function* runTurnStreaming(
  deps: MotebitLoopDependencies,
  userMessage: string,
  options?: TurnOptions,
): AsyncGenerator<AgenticChunk> {
  const { motebitId, eventStore, memoryGraph, stateEngine, behaviorEngine, provider } = deps;

  // 1. Query recent events
  const recentEvents = await eventStore.query({
    motebit_id: motebitId,
    limit: 10,
  });

  // 2. Embed user message and retrieve relevant memories (two-bucket: pinned + similarity)
  // Sensitivity gate: only include None and Personal memories in context sent to
  // external AI providers. Medical, Financial, and Secret memories stay local.
  const CONTEXT_SAFE_SENSITIVITY = [SensitivityLevel.None, SensitivityLevel.Personal];

  const queryEmbedding = await embedText(userMessage);
  const pinnedMemories = (await memoryGraph.getPinnedMemories()).filter((m) =>
    CONTEXT_SAFE_SENSITIVITY.includes(m.sensitivity),
  );
  const similarityMemories = await memoryGraph.retrieve(queryEmbedding, {
    limit: 5,
    strengthenCoRetrieved: true,
    sensitivityFilter: CONTEXT_SAFE_SENSITIVITY,
  });

  // Merge: pinned first (cap 5), then similarity (deduplicated)
  const pinnedIds = new Set(pinnedMemories.map((m) => m.node_id));
  const dedupedSimilarity = similarityMemories.filter((m) => !pinnedIds.has(m.node_id));
  const relevantMemories = [...pinnedMemories.slice(0, 5), ...dedupedSimilarity];

  // 3. Pack context and stream from provider (agentic loop)
  const currentState = stateEngine.getState();
  const rawToolDefs = deps.tools ? deps.tools.list() : undefined;
  const toolDefs =
    rawToolDefs && deps.policyGate ? deps.policyGate.filterTools(rawToolDefs) : rawToolDefs;

  let turnCtx = deps.policyGate?.createTurnContext(options?.runId);
  if (turnCtx && options?.delegationScope !== undefined) {
    turnCtx = { ...turnCtx, delegationScope: options.delegationScope };
  }

  const conversationHistory: ConversationMessage[] = [...(options?.conversationHistory ?? [])];

  let finalText = "";
  let finalResponse;
  let iteration = 0;
  let toolCallsSucceeded = 0;
  let toolCallsBlocked = 0;
  let toolCallsFailed = 0;

  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration++;

    const contextPack = {
      recent_events: recentEvents,
      relevant_memories: relevantMemories,
      current_state: currentState,
      user_message: iteration === 1 ? userMessage : "",
      conversation_history:
        iteration === 1
          ? conversationHistory.length > 0
            ? conversationHistory
            : undefined
          : conversationHistory,
      behavior_cues: options?.previousCues,
      tools: toolDefs,
      sessionInfo: options?.sessionInfo,
      curiosityHints: iteration === 1 ? options?.curiosityHints : undefined,
      knownAgents: iteration === 1 ? options?.knownAgents : undefined,
      precisionContext: iteration === 1 ? options?.precisionContext : undefined,
    };

    // On continuation turns, the user_message is empty and the conversation
    // history carries the context (including tool results). Adjust:
    if (iteration > 1) {
      contextPack.user_message = userMessage;
    }

    let aiResponse;
    for await (const chunk of provider.generateStream(contextPack)) {
      if (chunk.type === "text") {
        yield { type: "text", text: chunk.text };
      } else {
        aiResponse = chunk.response;
      }
    }

    if (!aiResponse) {
      throw new Error("Stream ended without a final response");
    }

    // Accumulate token usage on turn context for budget enforcement
    if (aiResponse.usage && turnCtx) {
      const tokens = aiResponse.usage.input_tokens + aiResponse.usage.output_tokens;
      turnCtx = { ...turnCtx, costAccumulated: turnCtx.costAccumulated + tokens };
    }

    finalText = aiResponse.text;
    finalResponse = aiResponse;

    // If no tool calls or no tool registry, exit the loop
    if (!aiResponse.tool_calls || aiResponse.tool_calls.length === 0 || !deps.tools) {
      break;
    }

    // Process tool calls
    const assistantMsg: ConversationMessage = {
      role: "assistant",
      content: aiResponse.text,
      tool_calls: aiResponse.tool_calls,
    };
    conversationHistory.push(assistantMsg);

    const toolDefsMap = new Map((toolDefs ?? []).map((t) => [t.name, t]));

    let allBlocked = true;

    for (const toolCall of aiResponse.tool_calls) {
      const toolDef = toolDefsMap.get(toolCall.name);

      // Policy gate enforcement (when present)
      if (deps.policyGate && toolDef && turnCtx) {
        const decision = deps.policyGate.validate(toolDef, toolCall.args, turnCtx);

        if (!decision.allowed) {
          toolCallsBlocked++;
          yield {
            type: "tool_status",
            name: toolCall.name,
            status: "done",
            result: decision.reason,
          };
          conversationHistory.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ ok: false, error: decision.reason }),
          });
          continue;
        }

        if (decision.requiresApproval) {
          toolCallsBlocked++;
          const profile = deps.policyGate.classify(toolDef);
          yield {
            type: "approval_request",
            tool_call_id: toolCall.id,
            name: toolCall.name,
            args: toolCall.args,
            risk_level: profile.risk,
            ...(decision.quorum ? { quorum: decision.quorum } : {}),
          };
          conversationHistory.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ ok: false, error: "Awaiting approval" }),
          });
          continue;
        }

        // Allowed — execute and record
        allBlocked = false;
        yield { type: "tool_status", name: toolCall.name, status: "calling" };

        let result: ToolResult;
        try {
          result = await deps.tools.execute(toolCall.name, toolCall.args);
        } catch (err: unknown) {
          toolCallsFailed++;
          const msg = err instanceof Error ? err.message : String(err);
          yield { type: "tool_status", name: toolCall.name, status: "done", result: msg };
          conversationHistory.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ ok: false, error: msg }),
          });
          continue;
        }
        turnCtx = deps.policyGate.recordToolCall(turnCtx);

        // Use sanitizeAndCheck if available (duck-typed), otherwise fall back
        let sanitized: ToolResult;
        if (typeof deps.policyGate.sanitizeAndCheck === "function") {
          const check = deps.policyGate.sanitizeAndCheck(result, toolCall.name);
          sanitized = check.result;
          if (check.injectionDetected) {
            yield {
              type: "injection_warning",
              tool_name: toolCall.name,
              patterns: check.injectionPatterns,
            };

            // Fail-closed: block on high-confidence injection (regex match or structural flag)
            const highConfidence =
              check.injectionPatterns.length > 0 || (check.structuralFlags ?? []).length > 0;
            const injectionData = {
              detected: true,
              patterns: check.injectionPatterns,
              directiveDensity: check.directiveDensity,
              structuralFlags: check.structuralFlags,
            };

            // Log to audit trail
            if (turnCtx != null && typeof deps.policyGate.logInjection === "function") {
              deps.policyGate.logInjection(
                turnCtx.turnId,
                toolCall.id,
                toolCall.name,
                toolCall.args,
                injectionData,
                highConfidence,
                turnCtx.runId,
              );
            }

            if (highConfidence) {
              toolCallsBlocked++;
              const reason = `Injection detected — tool result blocked (${[...check.injectionPatterns, ...(check.structuralFlags ?? [])].join(", ")})`;
              yield { type: "tool_status", name: toolCall.name, status: "done", result: reason };
              conversationHistory.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: JSON.stringify({ ok: false, error: reason }),
              });
              continue;
            }
            // Low-confidence (directive density only): warn but allow through (boundary-wrapped)
          }
        } else {
          sanitized = deps.policyGate.sanitizeResult(result, toolCall.name);
        }

        toolCallsSucceeded++;
        yield {
          type: "tool_status",
          name: toolCall.name,
          status: "done",
          result: sanitized.data ?? sanitized.error,
        };

        conversationHistory.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(sanitized),
        });
        continue;
      }

      // Policy gate filtered this tool out — do NOT execute.
      // The tool may still exist in the registry, but policy excluded it for a reason.
      if (deps.policyGate && !toolDef) {
        toolCallsBlocked++;
        yield {
          type: "tool_status",
          name: toolCall.name,
          status: "done",
          result: "Tool not available",
        };
        conversationHistory.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({ ok: false, error: "Tool not available" }),
        });
        continue;
      }

      // Fallback: no policy gate — use legacy requiresApproval check
      if (toolDef?.requiresApproval === true) {
        toolCallsBlocked++;
        yield {
          type: "approval_request",
          tool_call_id: toolCall.id,
          name: toolCall.name,
          args: toolCall.args,
        };
        conversationHistory.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({ ok: false, error: "Awaiting approval" }),
        });
        continue;
      }

      allBlocked = false;
      yield { type: "tool_status", name: toolCall.name, status: "calling" };
      let result: ToolResult;
      try {
        result = await deps.tools.execute(toolCall.name, toolCall.args);
      } catch (err: unknown) {
        toolCallsFailed++;
        const msg = err instanceof Error ? err.message : String(err);
        yield { type: "tool_status", name: toolCall.name, status: "done", result: msg };
        conversationHistory.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({ ok: false, error: msg }),
        });
        continue;
      }
      toolCallsSucceeded++;
      yield {
        type: "tool_status",
        name: toolCall.name,
        status: "done",
        result: result.data ?? result.error,
      };

      // Fallback path: no PolicyGate — wrap in boundaries AND detect injection
      let wrappedResult = result;
      if (result.data != null) {
        const dataStr = typeof result.data === "string" ? result.data : JSON.stringify(result.data);
        // Lightweight injection detection (subset of @motebit/policy sanitizer)
        const injectionHints: string[] = [];
        if (/ignore\s+(previous|all|above)\s+(instructions|prompts)/i.test(dataStr))
          injectionHints.push("ignore-instructions");
        if (/you\s+are\s+now|new\s+instructions|system\s*:/i.test(dataStr))
          injectionHints.push("identity-override");
        if (/<\|im_start\|>|<\|im_end\|>/i.test(dataStr))
          injectionHints.push("chat-template-markers");
        if (injectionHints.length > 0) {
          yield {
            type: "injection_warning",
            tool_name: toolCall.name,
            patterns: injectionHints,
          };
        }
        wrappedResult = { ...result, data: wrapExternalData(result.data, toolCall.name) };
      }
      conversationHistory.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(wrappedResult),
      });
    }

    // If all tool calls were blocked (denied or approval-gated), don't loop again
    if (allBlocked) {
      break;
    }
  }

  if (!finalResponse) {
    throw new Error("No response generated");
  }

  // 4. Form memories from candidates (governed if governor present)
  // Cap confidence for tool-derived memories: when tool calls occurred in this turn,
  // memory candidates may be influenced by attacker-controlled tool output.
  const MAX_TOOL_TURN_CONFIDENCE = 0.6;
  const memoriesFormed: MemoryNode[] = [];
  let rawCandidates = finalResponse.memory_candidates;
  if (toolCallsSucceeded > 0) {
    rawCandidates = rawCandidates.map((c) => ({
      ...c,
      confidence: Math.min(c.confidence, MAX_TOOL_TURN_CONFIDENCE),
    }));
  }
  const candidates = deps.memoryGovernor
    ? rawCandidates.filter((c) => {
        const decisions = deps.memoryGovernor!.evaluate([c]);
        return decisions[0]?.memoryClass === "persistent";
      })
    : rawCandidates;

  for (const candidate of candidates) {
    const embedding = await embedText(candidate.content);
    if (deps.consolidationProvider) {
      const { node } = await memoryGraph.consolidateAndForm(
        candidate,
        embedding,
        deps.consolidationProvider,
      );
      if (node) memoriesFormed.push(node);
    } else {
      const node = await memoryGraph.formMemory(candidate, embedding);
      memoriesFormed.push(node);
    }
  }

  // 4a. Link related memories — connect new nodes to retrieved context and to each other
  const EDGE_SIMILARITY_THRESHOLD = 0.7;
  if (memoriesFormed.length > 0) {
    // Link new memories to retrieved memories from this turn
    for (const newNode of memoriesFormed) {
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- defensive: embedding is required but guard against malformed nodes
      if (!newNode.embedding) continue;
      for (const retrieved of relevantMemories) {
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- defensive: embedding is required but guard against malformed nodes
        if (!retrieved.embedding) continue;
        const sim = cosineSimilarity(newNode.embedding, retrieved.embedding);
        if (sim >= EDGE_SIMILARITY_THRESHOLD) {
          await memoryGraph.link(newNode.node_id, retrieved.node_id, RelationType.Related, sim);
        }
      }
    }
    // Link new memories to each other when multiple form in one turn
    for (let i = 0; i < memoriesFormed.length; i++) {
      for (let j = i + 1; j < memoriesFormed.length; j++) {
        const a = memoriesFormed[i]!;
        const b = memoriesFormed[j]!;
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- defensive: embedding is required but guard against malformed nodes
        if (!a.embedding || !b.embedding) continue;
        const sim = cosineSimilarity(a.embedding, b.embedding);
        if (sim >= EDGE_SIMILARITY_THRESHOLD) {
          await memoryGraph.link(a.node_id, b.node_id, RelationType.Related, sim);
        }
      }
    }
  }

  // 4b. Audit: detect memory-worthy patterns the model missed
  const untaggedPatterns = detectUntaggedMemoryPatterns(
    userMessage,
    finalText,
    finalResponse.memory_candidates,
  );
  if (untaggedPatterns.length > 0) {
    const auditClock = await eventStore.getLatestClock(motebitId);
    await eventStore.append({
      event_id: crypto.randomUUID(),
      motebit_id: motebitId,
      timestamp: Date.now(),
      event_type: EventType.MemoryAudit,
      payload: {
        missed_patterns: untaggedPatterns,
        turn_message: userMessage.slice(0, 200),
      },
      version_clock: auditClock + 1,
      tombstoned: false,
    });
  }

  // 5. Push state updates (explicit tags win; fall back to text inference)
  if (Object.keys(finalResponse.state_updates).length > 0) {
    stateEngine.pushUpdate(finalResponse.state_updates);
  } else {
    const inferred = inferStateFromText(finalResponse.text, stateEngine.getState());
    if (Object.keys(inferred).length > 0) {
      stateEngine.pushUpdate(inferred);
    }
  }

  // 6. Log interaction event
  const clock = await eventStore.getLatestClock(motebitId);
  await eventStore.append({
    event_id: crypto.randomUUID(),
    motebit_id: motebitId,
    timestamp: Date.now(),
    event_type: EventType.StateUpdated,
    payload: {
      user_message: userMessage,
      response: finalText,
      memories_formed: memoriesFormed.length,
    },
    version_clock: clock + 1,
    tombstoned: false,
  });

  // 7. Compute behavior cues
  const stateAfter = stateEngine.getState();
  const cues = behaviorEngine.compute(stateAfter);

  yield {
    type: "result",
    result: {
      response: finalText,
      memoriesFormed,
      memoriesRetrieved: relevantMemories,
      stateAfter,
      cues,
      iterations: iteration,
      toolCallsSucceeded,
      toolCallsBlocked,
      toolCallsFailed,
      ...(turnCtx && turnCtx.costAccumulated > 0 ? { totalTokens: turnCtx.costAccumulated } : {}),
    },
  };
}
