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

  it("uses a shared store when given one — a sibling process must see the same replay", () => {
    // `motebit run` and `motebit serve` both announce
    // `unattended_runtime`; the relay may route to either. A purely
    // in-memory guard would let a replayed `resume` sail through the
    // sibling of the process that saw the original.
    const rows = new Map<string, number>();
    const store = {
      isReplay: (sig: string, now: number, windowMs: number) => {
        for (const [k, at] of rows) if (now - at > windowMs) rows.delete(k);
        if (rows.has(sig)) return true;
        rows.set(sig, now);
        return false;
      },
    };
    const processA = new CommandReplayGuard(600_000, store);
    const processB = new CommandReplayGuard(600_000, store);
    expect(processA.isReplay("sig-A")).toBe(false);
    expect(processB.isReplay("sig-A")).toBe(true);
  });

  it("a failing store refuses rather than degrading to the per-process set", () => {
    // This test asserted the opposite, and the comment it asserted said
    // the fallback was "narrower, never wider". It is wider exactly
    // where it matters: the shared store exists to catch a replay
    // landing on the SIBLING process, which a per-process set cannot
    // see at all. A busy database would have let a captured `resume`
    // accepted by `motebit run` be replayed to `motebit serve` inside
    // the freshness window, lifting a halt the sovereign had applied.
    const store = {
      isReplay: () => {
        throw new Error("database is locked");
      },
    };
    const g = new CommandReplayGuard(600_000, store);
    expect(g.isReplay("sig-A")).toBe(true);
    expect(g.isReplay("sig-never-seen")).toBe(true);
  });

  it("a refusal says WHICH refusal it is", () => {
    // "You already sent this" and "I could not check" mean opposite
    // things to whoever sent the command, and reporting the first for
    // the second is a confident wrong diagnosis on the one vocabulary
    // where being told nothing happened matters most.
    const seen = new CommandReplayGuard(600_000);
    expect(seen.check("sig-A")).toEqual({ accepted: true });
    expect(seen.check("sig-A")).toMatchObject({ accepted: false, reason: "replay" });

    const broken = new CommandReplayGuard(600_000, {
      isReplay: () => {
        throw new Error("database is locked");
      },
    });
    const verdict = broken.check("sig-A");
    expect(verdict).toMatchObject({ accepted: false, reason: "store_unavailable" });
    expect(verdict.accepted === false && verdict.message).toContain("database is locked");
  });

  it("does not grow without bound", () => {
    const g = new CommandReplayGuard(1000);
    for (let i = 0; i < 50; i++) g.isReplay(`sig-${i}`, 1_000_000 + i);
    expect(g.inMemorySize).toBe(50);
    // One call past the window prunes everything older.
    g.isReplay("later", 1_000_000 + 5000);
    expect(g.inMemorySize).toBe(1);
  });
});
