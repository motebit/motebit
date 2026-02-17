import type { BehaviorCues, MotebitState, MemoryNode, ToolRegistry, ConversationMessage } from "@motebit/sdk";
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

// === Types ===

export interface MotebitLoopDependencies {
  motebitId: string;
  eventStore: EventStore;
  memoryGraph: MemoryGraph;
  stateEngine: StateVectorEngine;
  behaviorEngine: BehaviorEngine;
  provider: StreamingProvider;
  tools?: ToolRegistry;
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
  | { type: "approval_request"; tool_call_id: string; name: string; args: Record<string, unknown> }
  | { type: "result"; result: TurnResult };

// === Orchestrator ===

export async function runTurn(
  deps: MotebitLoopDependencies,
  userMessage: string,
  options?: TurnOptions,
): Promise<TurnResult> {
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

  // 3. Pack context and call provider
  const currentState = stateEngine.getState();
  const aiResponse = await provider.generate({
    recent_events: recentEvents,
    relevant_memories: relevantMemories,
    current_state: currentState,
    user_message: userMessage,
    conversation_history: options?.conversationHistory,
    behavior_cues: options?.previousCues,
    tools: deps.tools ? deps.tools.list() : undefined,
  });

  // 4. Form memories from candidates
  const memoriesFormed: MemoryNode[] = [];
  for (const candidate of aiResponse.memory_candidates) {
    const embedding = await embedText(candidate.content);
    const node = await memoryGraph.formMemory(candidate, embedding);
    memoriesFormed.push(node);
  }

  // 5. Push state updates (explicit tags win; fall back to text inference)
  if (Object.keys(aiResponse.state_updates).length > 0) {
    stateEngine.pushUpdate(aiResponse.state_updates);
  } else {
    const inferred = inferStateFromText(aiResponse.text, stateEngine.getState());
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
      response: aiResponse.text,
      memories_formed: memoriesFormed.length,
    },
    version_clock: clock + 1,
    tombstoned: false,
  });

  // 7. Compute behavior cues
  const stateAfter = stateEngine.getState();
  const cues = behaviorEngine.compute(stateAfter);

  return {
    response: aiResponse.text,
    memoriesFormed,
    stateAfter,
    cues,
  };
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
  const toolDefs = deps.tools ? deps.tools.list() : undefined;

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

    for (const toolCall of aiResponse.tool_calls) {
      const toolDef = toolDefsMap.get(toolCall.name);

      // Check if tool requires approval
      if (toolDef?.requiresApproval) {
        yield {
          type: "approval_request",
          tool_call_id: toolCall.id,
          name: toolCall.name,
          args: toolCall.args,
        };
        // Skip execution — push a placeholder tool result so the conversation stays valid
        conversationHistory.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({ ok: false, error: "Awaiting approval" }),
        });
        continue;
      }

      yield { type: "tool_status", name: toolCall.name, status: "calling" };
      const result = await deps.tools.execute(toolCall.name, toolCall.args);
      yield { type: "tool_status", name: toolCall.name, status: "done", result: result.data ?? result.error };

      conversationHistory.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }

    // If all tool calls required approval, don't loop again
    const allNeedApproval = aiResponse.tool_calls.every(
      (tc) => toolDefsMap.get(tc.name)?.requiresApproval,
    );
    if (allNeedApproval) {
      break;
    }
  }

  if (!finalResponse) {
    throw new Error("No response generated");
  }

  // 4. Form memories from candidates
  const memoriesFormed: MemoryNode[] = [];
  for (const candidate of finalResponse.memory_candidates) {
    const embedding = await embedText(candidate.content);
    const node = await memoryGraph.formMemory(candidate, embedding);
    memoriesFormed.push(node);
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
