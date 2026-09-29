/**
 * #943 round 8 — another principal's turn is not the owner's behaviour.
 *
 * `accumulateTurnStats` shapes the owner's self-model: behavioural stats,
 * the precision weights recomputed from them, a cold-start gradient
 * bootstrap, and a reflection over the owner's interior every 5th turn. A
 * foreign turn (`motebit_query` on either door, a `motebit_task`) must
 * touch none of it; the owner's own turn still does.
 *
 * Tamper: delete `if (principal.foreign) return;` at the top of
 * `accumulateTurnStats` — red.
 */
import { describe, it, expect, vi } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import type { StreamingProvider } from "@motebit/ai-core";
import type { AIResponse } from "@motebit/sdk";

function provider(): StreamingProvider {
  const response: AIResponse = {
    text: "ok",
    confidence: 0.9,
    memory_candidates: [],
    state_updates: {},
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn(async () => response),
    estimateConfidence: vi.fn(async () => 0.9),
    extractMemoryCandidates: vi.fn(async () => []),
    async *generateStream() {
      yield { type: "text" as const, text: "ok" };
      yield { type: "done" as const, response };
    },
  };
}

type Internals = {
  gradientManager: {
    behavioralStats: { turnCount: number };
    recomputePrecisionFromStats(): void;
    computeGradientNow(): Promise<unknown>;
  };
  reflectAndStore(): Promise<unknown>;
};

describe("#943 — foreign turns leave the owner's self-model untouched", () => {
  it("five foreign turns (both doors): no stats, no precision, no gradient, no reflection; the owner's turn still counts", async () => {
    const runtime = new MotebitRuntime(
      { motebitId: "owner-mote", tickRateHz: 0 },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: provider() },
    );
    const internals = runtime as unknown as Internals;
    const recompute = vi.spyOn(internals.gradientManager, "recomputePrecisionFromStats");
    const gradient = vi
      .spyOn(internals.gradientManager, "computeGradientNow")
      .mockResolvedValue(undefined);
    const reflect = vi.spyOn(internals, "reflectAndStore").mockResolvedValue(undefined);

    for (let i = 0; i < 3; i++) {
      await runtime.sendMessage(`stranger ${i}`, undefined, { foreignPrincipal: true });
    }
    for (let i = 0; i < 2; i++) {
      for await (const _c of runtime.sendMessageStreaming(`stranger s${i}`, undefined, {
        foreignPrincipal: true,
      })) {
        /* consume */
      }
    }
    expect(internals.gradientManager.behavioralStats.turnCount).toBe(0);
    expect(recompute).not.toHaveBeenCalled();
    expect(gradient).not.toHaveBeenCalled();
    expect(reflect).not.toHaveBeenCalled();

    await runtime.sendMessage("owner");
    expect(internals.gradientManager.behavioralStats.turnCount).toBe(1);
    expect(recompute).toHaveBeenCalled();
  });
});
