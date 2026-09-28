/**
 * #893 — every turn entry hands the loop deps that say whose words the turn
 * runs. Memory formation reads `deps.foreignPrincipal` (ai-core
 * `turnMemorySource`); these lock the runtime half: the value is set per
 * turn on the deps the loop receives, including the continuation that
 * resumes a foreign turn's paused approval — which re-runs that principal's
 * prompt after the task that raised it has returned.
 *
 * Tamper check: drop the `foreignPrincipal` capture from the pending
 * approval, or pass `loopDeps` unchanged to the resumed
 * `runTurnStreaming` — the resume case goes red.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { StreamChunk } from "../index";
import type { StreamingProvider, AgenticChunk, TurnResult } from "@motebit/ai-core";
import type { AIResponse, ContextPack } from "@motebit/sdk";
import { TrustMode, BatteryMode } from "@motebit/sdk";

const mockRunTurnStreaming = vi.fn();

vi.mock("@motebit/ai-core", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@motebit/ai-core");
  return {
    ...actual,
    runTurnStreaming: (...args: unknown[]) =>
      mockRunTurnStreaming(...args) as AsyncGenerator<AgenticChunk>,
  };
});

function provider(): StreamingProvider {
  const response: AIResponse = {
    text: "ok",
    confidence: 0.8,
    memory_candidates: [],
    state_updates: {},
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn<(ctx: ContextPack) => Promise<AIResponse>>().mockResolvedValue(response),
    estimateConfidence: vi.fn<() => Promise<number>>().mockResolvedValue(0.8),
    extractMemoryCandidates: vi.fn<(r: AIResponse) => Promise<never[]>>().mockResolvedValue([]),
    async *generateStream(_ctx: ContextPack) {
      yield { type: "text" as const, text: "ok" };
      yield { type: "done" as const, response };
    },
  };
}

function turnResult(): TurnResult {
  return {
    response: "ok",
    memoriesFormed: [],
    memoriesRetrieved: [],
    stateAfter: {
      attention: 0.5,
      processing: 0.1,
      confidence: 0.7,
      affect_valence: 0,
      affect_arousal: 0,
      social_distance: 0.5,
      curiosity: 0.3,
      trust_mode: TrustMode.Guarded,
      battery_mode: BatteryMode.Normal,
    },
    cues: {
      hover_distance: 0.4,
      drift_amplitude: 0.02,
      glow_intensity: 0.3,
      eye_dilation: 0.3,
      smile_curvature: 0,
      speaking_activity: 0,
    },
    iterations: 1,
    toolCallsSucceeded: 0,
    toolCallsBlocked: 0,
    toolCallsFailed: 0,
  };
}

async function* chunks(...cs: AgenticChunk[]): AsyncGenerator<AgenticChunk> {
  for (const c of cs) yield c;
}

async function drain(gen: AsyncGenerator<StreamChunk>): Promise<void> {
  for await (const _c of gen) {
    /* consume */
  }
}

/** The `foreignPrincipal` on the deps of the Nth `runTurnStreaming` call. */
function foreignOnCall(n: number): unknown {
  const deps = mockRunTurnStreaming.mock.calls[n]![0] as { foreignPrincipal?: boolean };
  return deps.foreignPrincipal;
}

describe("#893 — the turn's loop deps carry whose words it runs", () => {
  let runtime: MotebitRuntime;

  beforeEach(() => {
    mockRunTurnStreaming.mockReset();
    runtime = new MotebitRuntime(
      { motebitId: "owner-mote", tickRateHz: 0 },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: provider() },
    );
  });

  it("an owner turn's deps say owner; a foreign turn's deps say foreign", async () => {
    mockRunTurnStreaming.mockReturnValueOnce(chunks({ type: "result", result: turnResult() }));
    await drain(runtime.sendMessageStreaming("mine"));
    mockRunTurnStreaming.mockReturnValueOnce(chunks({ type: "result", result: turnResult() }));
    await drain(runtime.sendMessageStreaming("theirs", undefined, { foreignPrincipal: true }));
    mockRunTurnStreaming.mockReturnValueOnce(chunks({ type: "result", result: turnResult() }));
    await drain(runtime.sendMessageStreaming("mine again"));

    expect(foreignOnCall(0)).toBe(false);
    expect(foreignOnCall(1)).toBe(true);
    // Per-turn, never sticky: the next owner turn is the owner's.
    expect(foreignOnCall(2)).toBe(false);
  });

  it("the resume of a foreign turn's paused approval runs with foreign deps", async () => {
    runtime
      .getToolRegistry()
      .register({ name: "safe_tool", description: "safe", inputSchema: {} }, async () => ({
        ok: true,
        data: "done",
      }));
    mockRunTurnStreaming.mockReturnValueOnce(
      chunks(
        { type: "approval_request", tool_call_id: "tc-1", name: "safe_tool", args: {} },
        { type: "result", result: turnResult() },
      ),
    );
    await drain(runtime.sendMessageStreaming("theirs", undefined, { foreignPrincipal: true }));
    expect(runtime.hasPendingApproval).toBe(true);

    mockRunTurnStreaming.mockReturnValueOnce(chunks({ type: "result", result: turnResult() }));
    await drain(runtime.resumeAfterApproval(true));

    expect(mockRunTurnStreaming).toHaveBeenCalledTimes(2);
    expect(foreignOnCall(1)).toBe(true);
  });

  it("the resume of an owner turn's paused approval runs with owner deps", async () => {
    runtime
      .getToolRegistry()
      .register({ name: "safe_tool", description: "safe", inputSchema: {} }, async () => ({
        ok: true,
        data: "done",
      }));
    mockRunTurnStreaming.mockReturnValueOnce(
      chunks(
        { type: "approval_request", tool_call_id: "tc-2", name: "safe_tool", args: {} },
        { type: "result", result: turnResult() },
      ),
    );
    await drain(runtime.sendMessageStreaming("mine"));
    mockRunTurnStreaming.mockReturnValueOnce(chunks({ type: "result", result: turnResult() }));
    await drain(runtime.resumeAfterApproval(true));

    expect(foreignOnCall(1)).toBe(false);
  });
});
