import type { BehaviorCues, MotebitState, MemoryNode } from "@motebit/sdk";
import { EventType } from "@motebit/sdk";
import type { EventStore } from "@motebit/event-log";
import type { MemoryGraph } from "@motebit/memory-graph";
import { embedText } from "@motebit/memory-graph";
import type { StateVectorEngine } from "@motebit/state-vector";
import type { BehaviorEngine } from "@motebit/behavior-engine";
import type { CloudProvider } from "./index.js";

// === Types ===

export interface MotebitLoopDependencies {
  motebitId: string;
  eventStore: EventStore;
  memoryGraph: MemoryGraph;
  stateEngine: StateVectorEngine;
  behaviorEngine: BehaviorEngine;
  cloudProvider: CloudProvider;
}

export interface TurnResult {
  response: string;
  memoriesFormed: MemoryNode[];
  stateAfter: MotebitState;
  cues: BehaviorCues;
}

export interface TurnOptions {
  conversationHistory?: { role: "user" | "assistant"; content: string }[];
}

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
    cloudProvider,
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

  // 3. Pack context and call CloudProvider
  const currentState = stateEngine.getState();
  const aiResponse = await cloudProvider.generate({
    recent_events: recentEvents,
    relevant_memories: relevantMemories,
    current_state: currentState,
    user_message: userMessage,
    conversation_history: options?.conversationHistory,
  });

  // 4. Form memories from candidates
  const memoriesFormed: MemoryNode[] = [];
  for (const candidate of aiResponse.memory_candidates) {
    const embedding = await embedText(candidate.content);
    const node = await memoryGraph.formMemory(candidate, embedding);
    memoriesFormed.push(node);
  }

  // 5. Push state updates
  if (Object.keys(aiResponse.state_updates).length > 0) {
    stateEngine.pushUpdate(aiResponse.state_updates);
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
): AsyncGenerator<
  { type: "text"; text: string } | { type: "result"; result: TurnResult }
> {
  const {
    motebitId,
    eventStore,
    memoryGraph,
    stateEngine,
    behaviorEngine,
    cloudProvider,
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

  // 3. Pack context and stream from CloudProvider
  const currentState = stateEngine.getState();
  const contextPack = {
    recent_events: recentEvents,
    relevant_memories: relevantMemories,
    current_state: currentState,
    user_message: userMessage,
    conversation_history: options?.conversationHistory,
  };

  let aiResponse;
  for await (const chunk of cloudProvider.generateStream(contextPack)) {
    if (chunk.type === "text") {
      yield { type: "text", text: chunk.text };
    } else {
      aiResponse = chunk.response;
    }
  }

  if (!aiResponse) {
    throw new Error("Stream ended without a final response");
  }

  // 4. Form memories from candidates
  const memoriesFormed: MemoryNode[] = [];
  for (const candidate of aiResponse.memory_candidates) {
    const embedding = await embedText(candidate.content);
    const node = await memoryGraph.formMemory(candidate, embedding);
    memoriesFormed.push(node);
  }

  // 5. Push state updates
  if (Object.keys(aiResponse.state_updates).length > 0) {
    stateEngine.pushUpdate(aiResponse.state_updates);
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

  yield {
    type: "result",
    result: {
      response: aiResponse.text,
      memoriesFormed,
      stateAfter,
      cues,
    },
  };
}
