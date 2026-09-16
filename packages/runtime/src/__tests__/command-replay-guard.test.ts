/**
 * Replay defence on signed remote commands.
 *
 * Freshness alone was enough while the vocabulary was read-only. It is
 * not now that `resume` exists: a captured envelope replayed inside the
 * window would lift a halt the sovereign had just applied.
 */
import { describe, it, expect } from "vitest";
import { CommandReplayGuard } from "../command-replay-guard.js";

describe("CommandReplayGuard", () => {
  it("accepts an envelope once and refuses the same one again", () => {
    const g = new CommandReplayGuard();
    expect(g.isReplay("sig-A")).toBe(false);
    expect(g.isReplay("sig-A")).toBe(true);
    expect(g.isReplay("sig-A")).toBe(true);
  });

  it("two genuinely separate commands are not replays of each other", () => {
    const g = new CommandReplayGuard();
    expect(g.isReplay("sig-A")).toBe(false);
    expect(g.isReplay("sig-B")).toBe(false);
  });

  it("forgets outside the window — the verifier has already refused those", () => {
    const g = new CommandReplayGuard(1000);
    const t0 = 1_000_000;
    expect(g.isReplay("sig-A", t0)).toBe(false);
    // Still inside: remembered.
    expect(g.isReplay("sig-A", t0 + 999)).toBe(true);
    // Past the window: pruned, so it reads as new — which is safe
    // because the envelope's own freshness check rejects it first.
    expect(g.isReplay("sig-A", t0 + 2000)).toBe(false);
  });

  it("does not grow without bound", () => {
    const g = new CommandReplayGuard(1000);
    for (let i = 0; i < 50; i++) g.isReplay(`sig-${i}`, 1_000_000 + i);
    expect(g.size).toBe(50);
    // One call past the window prunes everything older.
    g.isReplay("later", 1_000_000 + 5000);
    expect(g.size).toBe(1);
  });
});
