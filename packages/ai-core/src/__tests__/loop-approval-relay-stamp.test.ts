/**
 * The relay stamp on `approval_request` (design runtime-relay-binding 4b
 * §2 "Recovered approvals carry their relay"; §3 change 1).
 *
 * Both emit sites in the loop — the policy-gate pause and the legacy
 * `requiresApproval` pause — read `deps.relayIdentity()` synchronously at
 * the pause and record whether the tool is relay-bound from
 * `deps.isRelayBoundTool` (the runtime registry's flag). A deps object
 * without the callback stamps `relay: null` (fail-closed).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@motebit/memory-graph", async () => {
  const actual =
    await vi.importActual<typeof import("@motebit/memory-graph")>("@motebit/memory-graph");
  return { ...actual, embedText: (text: string) => Promise.resolve(actual.embedTextHash(text)) };
});

import { runTurnStreaming } from "../loop";
import type { AgenticChunk, ApprovalRelayIdentity, MotebitLoopDependencies } from "../loop";
import type { SensitivityCleared } from "@motebit/sdk";
import type { StreamingProvider } from "../index";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { MemoryGraph, InMemoryMemoryStorage } from "@motebit/memory-graph";
import { StateVectorEngine } from "@motebit/state-vector";
import { BehaviorEngine } from "@motebit/behavior-engine";
import { SensitivityLevel } from "@motebit/sdk";
import type { AIResponse, ToolDefinition, ToolRegistry, ToolResult } from "@motebit/sdk";

const A: ApprovalRelayIdentity = { pinKey: "https://relay-a.invalid", publicKey: "aa" };
const B: ApprovalRelayIdentity = { pinKey: "https://relay-b.invalid", publicKey: null };

const DELEGATE: ToolDefinition = {
  name: "delegate_to_agent",
  description: "Delegate",
  inputSchema: { type: "object", properties: {} },
};

function provider(toolName: string): StreamingProvider {
  const response: AIResponse = {
    text: "",
    confidence: 0.8,
    memory_candidates: [],
    state_updates: {},
    tool_calls: [{ id: "tc-1", name: toolName, args: { prompt: "x" } }],
  };
  return {
    model: "test-model",
    setModel: vi.fn(),
    generate: async () => response,
    async *generateStream() {
      yield { type: "done" as const, response };
    },
    estimateConfidence: () => Promise.resolve(0.8),
    extractMemoryCandidates: () => Promise.resolve([]),
  };
}

function registry(def: ToolDefinition): ToolRegistry {
  return {
    list: () => [def],
    execute: async (): Promise<ToolResult> => ({ ok: true }),
    register: () => undefined,
  };
}

/** A gate that pauses every call for approval. */
const pausingGate = {
  filterTools: (t: ToolDefinition[]) => t,
  createTurnContext: () => ({ turnId: "t", toolCallCount: 0, turnStartMs: 0, costAccumulated: 0 }),
  validate: () => ({ allowed: true, requiresApproval: true, callId: "call-1" }),
  classify: () => ({ risk: 2, dataClass: "public", sideEffect: "reversible" }),
  recordToolCall: (ctx: unknown) => ctx,
  sanitizeAndCheck: (result: ToolResult) => ({
    result,
    injectionDetected: false,
    injectionPatterns: [],
  }),
  sanitizeResult: (result: ToolResult) => result,
  logInjection: () => undefined,
};

function deps(
  extra: Partial<MotebitLoopDependencies>,
  opts: { gate: boolean; def?: ToolDefinition },
): SensitivityCleared<MotebitLoopDependencies> {
  const eventStore = new EventStore(new InMemoryEventStore());
  const def = opts.def ?? DELEGATE;
  return {
    motebitId: "m",
    eventStore,
    memoryGraph: new MemoryGraph(new InMemoryMemoryStorage(), eventStore, "m"),
    stateEngine: new StateVectorEngine(),
    behaviorEngine: new BehaviorEngine(),
    provider: provider(def.name),
    tools: registry(def),
    getEffectiveSensitivity: () => SensitivityLevel.None,
    ...(opts.gate ? { policyGate: pausingGate } : {}),
    ...extra,
  } as unknown as SensitivityCleared<MotebitLoopDependencies>;
}

async function firstApproval(
  d: SensitivityCleared<MotebitLoopDependencies>,
): Promise<Extract<AgenticChunk, { type: "approval_request" }>> {
  for await (const chunk of runTurnStreaming(d, "go")) {
    if (chunk.type === "approval_request") return chunk;
  }
  throw new Error("no approval_request");
}

describe.each([
  ["policy-gate pause", true],
  ["legacy requiresApproval pause", false],
] as const)("approval_request relay stamp (%s)", (_label, gate) => {
  const def: ToolDefinition = gate ? DELEGATE : { ...DELEGATE, requiresApproval: true };

  it("stamps the relay identity read at the pause and the registry's relay-bound flag", async () => {
    let current: ApprovalRelayIdentity | null = A;
    const seen: string[] = [];
    const chunk = await firstApproval(
      deps(
        {
          relayIdentity: () => current,
          isRelayBoundTool: (name) => {
            seen.push(name);
            return name === "delegate_to_agent";
          },
        },
        { gate, def },
      ),
    );
    // A rebind after the pause does not change what the chunk recorded.
    current = B;
    expect(chunk.relay).toEqual(A);
    expect(chunk.relay_bound).toBe(true);
    expect(seen).toEqual(["delegate_to_agent"]);
  });

  it("stamps relay_bound false for a tool the registry does not flag", async () => {
    const chunk = await firstApproval(
      deps(
        { relayIdentity: () => B, isRelayBoundTool: () => false },
        { gate, def: { ...def, name: "write_note" } },
      ),
    );
    expect(chunk.relay).toEqual(B);
    expect(chunk.relay_bound).toBe(false);
  });

  it("stamps relay null when unbound or unpinnable", async () => {
    const chunk = await firstApproval(
      deps({ relayIdentity: () => null, isRelayBoundTool: () => true }, { gate, def }),
    );
    expect(chunk.relay).toBeNull();
    expect(chunk.relay_bound).toBe(true);
  });

  it("stamps relay null and no relay_bound when the deps carry no callbacks", async () => {
    const chunk = await firstApproval(deps({}, { gate, def }));
    expect(chunk.relay).toBeNull();
    expect("relay_bound" in chunk).toBe(false);
  });
});
