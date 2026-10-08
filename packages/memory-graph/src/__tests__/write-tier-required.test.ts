/**
 * Memory formation takes the tier by type and refuses a write whose stamp
 * was erased. A memory formed without its tier — or defaulted to `none` —
 * is recalled into every later request, whatever tier it was derived at
 * (round-5 finding: CLI plan-reflection learnings formed at `none` after a
 * Secret run reached a BYOK request). The `@ts-expect-error` lines are the
 * static half: typecheck fails if `sensitivity` becomes optional on any
 * formation entry point.
 */
import { describe, it, expect } from "vitest";
import { EventStore, InMemoryEventStore } from "@motebit/event-log";
import { SensitivityLevel } from "@motebit/sdk";
import { InMemoryMemoryStorage, MemoryGraph, formMemoriesFromCandidates } from "../index.js";
import type { ConsolidationProvider } from "../consolidation.js";

const EMB = [1, 0, 0, 0, 0, 0, 0, 0];
const embed = async (): Promise<number[]> => EMB;

function graph(): MemoryGraph {
  return new MemoryGraph(
    new InMemoryMemoryStorage(),
    new EventStore(new InMemoryEventStore()),
    "m",
    undefined,
    embed,
  );
}

describe("memory formation requires a tier", () => {
  it("formMemory: no stamp, no node", async () => {
    const g = graph();
    await expect(
      // @ts-expect-error — `sensitivity` is required at formation
      g.formMemory({ content: "c", confidence: 0.7, source: "agent_inferred" }, EMB),
    ).rejects.toThrow(/sensitivity/);
    await expect(
      g.formMemory(
        {
          content: "c",
          confidence: 0.7,
          sensitivity: "bogus" as SensitivityLevel,
          source: "agent_inferred",
        },
        EMB,
      ),
    ).rejects.toThrow(/sensitivity/);
    expect((await g.exportAll()).nodes).toEqual([]);
    const node = await g.formMemory(
      {
        content: "c",
        confidence: 0.7,
        sensitivity: SensitivityLevel.Secret,
        source: "agent_inferred",
      },
      EMB,
    );
    expect(node.sensitivity).toBe(SensitivityLevel.Secret);
  });

  it("consolidateAndForm and formMemoriesFromCandidates take the same typed candidate", async () => {
    const g = graph();
    const provider = {} as ConsolidationProvider; // never reached: the stamp is checked first
    await expect(
      g.consolidateAndForm(
        // @ts-expect-error — `sensitivity` is required at formation
        { content: "c", confidence: 0.7, source: "agent_inferred" },
        EMB,
        provider,
      ),
    ).rejects.toThrow(/sensitivity/);
    await expect(
      formMemoriesFromCandidates(
        { memoryGraph: g, mode: "isolated_add" },
        // @ts-expect-error — `sensitivity` is required at formation
        [{ content: "c", confidence: 0.7, source: "agent_inferred" }],
        [],
      ),
    ).rejects.toThrow(/sensitivity/);
    expect((await g.exportAll()).nodes).toEqual([]);
  });
});
