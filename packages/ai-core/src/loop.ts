import type { BehaviorCues, MotebitState, MemoryNode, MemoryCandidate, ToolRegistry, ToolDefinition, ToolResult, ToolRiskProfile, PolicyDecision, TurnContext, ConversationMessage } from "@motebit/sdk";
import { EventType } from "@motebit/sdk";
import type { EventStore } from "@motebit/event-log";
import type { MemoryGraph } from "@motebit/memory-graph";
import { embedText } from "@motebit/memory-graph";
import type { StateVectorEngine } from "@motebit/state-vector";
import type { BehaviorEngine } from "@motebit/behavior-engine";
import type { StreamingProvider } from "./index.js";
import { inferStateFromText } from "./infer-state.js";

// === Constants ===

const MAX_TOOL_ITERATIONS = 10;

// === Missed-memory heuristic detection ===

const PREFERENCE_RE = /\b(?:i\s+(?:like|prefer|love|enjoy|hate|dislike|can't stand))\s+(.{3,60})/gi;
const PERSONAL_FACT_RE = /\b(?:i(?:'m|\s+am)\s+from|i\s+live\s+in|i\s+work\s+at|my\s+name\s+is|i(?:'m|\s+am)\s+a\b)\s+(.{2,60})/gi;
const GOAL_RE = /\b(?:i\s+want\s+to|i(?:'m|\s+am)\s+planning\s+to|i\s+need\s+to|i(?:'m|\s+am)\s+trying\s+to|my\s+goal\s+is)\s+(.{3,80})/gi;
const CORRECTION_RE = /\b(?:actually,?\s+i\s+meant|no,?\s+i\s+(?:said|mean)|i\s+meant\s+to\s+say)\s+(.{3,80})/gi;

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
      if (captured && !isAlreadyCaptured(captured)) {
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
  const safeName = toolName.replace(/[\[\]"\\]/g, "_").slice(0, 100);
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
  sanitizeAndCheck?(result: ToolResult, toolName: string): {
    result: ToolResult;
    injectionDetected: boolean;
    injectionPatterns: string[];
  };
  createTurnContext(): TurnContext;
  recordToolCall(ctx: TurnContext, cost?: number): TurnContext;
}

/**
 * Minimal memory governance interface for the agentic loop.
 * MemoryGovernor from @motebit/policy satisfies this through structural typing.
 */
export interface LoopMemoryGovernor {
  evaluate(candidates: MemoryCandidate[]): { candidate: MemoryCandidate; memoryClass: string; reason: string }[];
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
}

export interface TurnResult {
  response: string;
  memoriesFormed: MemoryNode[];
  stateAfter: MotebitState;
  cues: BehaviorCues;
}

export interface TurnOptions {
  conversationHistory?: ConversationMessage[];
  previousCues?: BehaviorCues;
}

export type AgenticChunk =
  | { type: "text"; text: string }
  | { type: "tool_status"; name: string; status: "calling" | "done"; result?: unknown }
  | { type: "approval_request"; tool_call_id: string; name: string; args: Record<string, unknown>; risk_level?: number }
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
  const {
    motebitId,
    eventStore,
    memoryGraph,
    stateEngine,
    behaviorEngine,
    provider,
  } = deps;

  // 1. Query recent events
  const recentEvents = await eventStore.query({
    motebit_id: motebitId,
    limit: 10,
  });

  // 2. Embed user message and retrieve relevant memories
  const queryEmbedding = await embedText(userMessage);
  const relevantMemories = await memoryGraph.retrieve(queryEmbedding, {
    limit: 5,
  });

  // 3. Pack context and stream from provider (agentic loop)
  const currentState = stateEngine.getState();
  const rawToolDefs = deps.tools ? deps.tools.list() : undefined;
  const toolDefs = rawToolDefs && deps.policyGate
    ? deps.policyGate.filterTools(rawToolDefs)
    : rawToolDefs;

  let turnCtx = deps.policyGate?.createTurnContext();

  const conversationHistory: ConversationMessage[] = [
    ...(options?.conversationHistory ?? []),
  ];

  let finalText = "";
  let finalResponse;
  let iteration = 0;

  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration++;

    const contextPack = {
      recent_events: recentEvents,
      relevant_memories: relevantMemories,
      current_state: currentState,
      user_message: iteration === 1 ? userMessage : "",
      conversation_history: iteration === 1
        ? conversationHistory.length > 0 ? conversationHistory : undefined
        : conversationHistory,
      behavior_cues: options?.previousCues,
      tools: toolDefs,
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

    const toolDefsMap = new Map(
      (toolDefs ?? []).map((t) => [t.name, t]),
    );

    let allBlocked = true;

    for (const toolCall of aiResponse.tool_calls) {
      const toolDef = toolDefsMap.get(toolCall.name);

      // Policy gate enforcement (when present)
      if (deps.policyGate && toolDef && turnCtx) {
        const decision = deps.policyGate.validate(toolDef, toolCall.args, turnCtx);

        if (!decision.allowed) {
          yield { type: "tool_status", name: toolCall.name, status: "done", result: decision.reason };
          conversationHistory.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ ok: false, error: decision.reason }),
          });
          continue;
        }

        if (decision.requiresApproval) {
          const profile = deps.policyGate.classify(toolDef);
          yield {
            type: "approval_request",
            tool_call_id: toolCall.id,
            name: toolCall.name,
            args: toolCall.args,
            risk_level: profile.risk,
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
        const result = await deps.tools.execute(toolCall.name, toolCall.args);
        turnCtx = deps.policyGate.recordToolCall(turnCtx);

        // Use sanitizeAndCheck if available (duck-typed), otherwise fall back
        let sanitized: ToolResult;
        if (typeof deps.policyGate.sanitizeAndCheck === "function") {
          const check = deps.policyGate.sanitizeAndCheck(result, toolCall.name);
          sanitized = check.result;
          if (check.injectionDetected) {
            yield { type: "injection_warning", tool_name: toolCall.name, patterns: check.injectionPatterns };
          }
        } else {
          sanitized = deps.policyGate.sanitizeResult(result, toolCall.name);
        }

        yield { type: "tool_status", name: toolCall.name, status: "done", result: sanitized.data ?? sanitized.error };

        conversationHistory.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(sanitized),
        });
        continue;
      }

      // Fallback: no policy gate — use legacy requiresApproval check
      if (toolDef?.requiresApproval) {
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
      const result = await deps.tools.execute(toolCall.name, toolCall.args);
      yield { type: "tool_status", name: toolCall.name, status: "done", result: result.data ?? result.error };

      // Fallback path: no PolicyGate — still wrap in boundaries for defense-in-depth
      const wrappedResult = result.data != null
        ? { ...result, data: wrapExternalData(result.data, toolCall.name) }
        : result;
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
  const memoriesFormed: MemoryNode[] = [];
  const candidates = deps.memoryGovernor
    ? finalResponse.memory_candidates.filter((c) => {
        const decisions = deps.memoryGovernor!.evaluate([c]);
        return decisions[0]?.memoryClass === "persistent";
      })
    : finalResponse.memory_candidates;

  for (const candidate of candidates) {
    const embedding = await embedText(candidate.content);
    const node = await memoryGraph.formMemory(candidate, embedding);
    memoriesFormed.push(node);
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
      stateAfter,
      cues,
    },
  };
}
