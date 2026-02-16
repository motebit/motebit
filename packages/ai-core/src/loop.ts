import type { BehaviorCues, MoteState, MemoryNode } from "@mote/sdk";
import { EventType } from "@mote/sdk";
import type { EventStore } from "@mote/event-log";
import type { MemoryGraph } from "@mote/memory-graph";
import { embedText } from "@mote/memory-graph";
import type { StateVectorEngine } from "@mote/state-vector";
import type { BehaviorEngine } from "@mote/behavior-engine";
import type { CloudProvider } from "./index.js";

// === Types ===

export interface MoteLoopDependencies {
  moteId: string;
  eventStore: EventStore;
  memoryGraph: MemoryGraph;
  stateEngine: StateVectorEngine;
  behaviorEngine: BehaviorEngine;
  cloudProvider: CloudProvider;
}

export interface TurnResult {
  response: string;
  memoriesFormed: MemoryNode[];
  stateAfter: MoteState;
  cues: BehaviorCues;
}

// === Orchestrator ===

export async function runTurn(
  deps: MoteLoopDependencies,
  userMessage: string,
): Promise<TurnResult> {
  const {
    moteId,
    eventStore,
    memoryGraph,
    stateEngine,
    behaviorEngine,
    cloudProvider,
  } = deps;

  // 1. Query recent events
  const recentEvents = await eventStore.query({
    mote_id: moteId,
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
  const clock = await eventStore.getLatestClock(moteId);
  await eventStore.append({
    event_id: crypto.randomUUID(),
    mote_id: moteId,
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
