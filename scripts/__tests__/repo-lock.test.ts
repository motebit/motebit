/**
 * scripts/lib/repo-lock.ts — the waiting per-worktree mutex
 * check-tests-typechecked serialises on. Liveness is token + heartbeat:
 * a dead holder is reclaimed at once, a reused pid (alive, never beating) once
 * its signature stops changing for `staleMs` on the waiter's monotonic clock,
 * and no wall-clock reading takes part (clock skew changes nothing).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { acquireRepoLock, assess, readOwner, type Observation } from "../lib/repo-lock.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TSX = join(REPO, "node_modules/.bin/tsx");

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
afterEach(() => {
  vi.useRealTimers();
});

function lockDir(): string {
  const d = mkdtempSync(join(tmpdir(), "repo-lock-test-"));
  dirs.push(d);
  return join(d, "gate.lock");
}

/** A pid that existed and is gone now. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf-8",
  });
  return Number(r.stdout);
}

/** Write a lock as a holder that never beats would leave it. */
function plantLock(dir: string, pid: number, beat: string | null = "planted 1"): void {
  mkdirSync(dir);
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid, host: hostname(), run: "planted" }));
  if (beat !== null) writeFileSync(join(dir, "beat"), beat);
}

describe("repo-lock", () => {
  it("reclaims a DEAD holder's lock at once (no wait for staleMs)", async () => {
    const dir = lockDir();
    plantLock(dir, deadPid());
    const t0 = Date.now();
    const release = await acquireRepoLock(dir, { budgetMs: 2_000, staleMs: 60_000, pollMs: 20 });
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(readOwner(dir)?.pid).toBe(process.pid);
    release();
    expect(existsSync(dir)).toBe(false);
  });

  it("PID reuse: a live pid that never beats (not the holder) goes stale after staleMs and is reclaimed", async () => {
    const dir = lockDir();
    // this very process is alive, but it is not beating for the planted token
    plantLock(dir, process.pid);
    const t0 = Date.now();
    const release = await acquireRepoLock(dir, { budgetMs: 5_000, staleMs: 400, pollMs: 20 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(350);
    expect(readOwner(dir)?.run).not.toBe("planted");
    release();
  });

  it("an ownerless lock dir (holder mid-acquire) is stale only after staleMs", async () => {
    const dir = lockDir();
    mkdirSync(dir);
    const t0 = Date.now();
    const release = await acquireRepoLock(dir, { budgetMs: 5_000, staleMs: 300, pollMs: 20 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    release();
  });

  it("a LIVE holder (beating, in another process) is never reclaimed: a short wait fails naming it, a long one acquires after release", async () => {
    const dir = lockDir();
    const script = join(dirname(dir), "holder.mts");
    writeFileSync(
      script,
      `import { acquireRepoLock } from ${JSON.stringify(join(REPO, "scripts/lib/repo-lock.ts"))};
const release = await acquireRepoLock(${JSON.stringify(dir)}, { budgetMs: 1000, heartbeatMs: 50 });
process.stdout.write("held\\n");
setTimeout(() => { release(); process.exit(0); }, 2500);
`,
    );
    const holder = spawn(TSX, [script], { stdio: ["ignore", "pipe", "inherit"] });
    const closed = new Promise((ok) => holder.on("close", ok));
    await new Promise<void>((ok) => holder.stdout.once("data", () => ok()));
    // staleMs far below the hold time: only the heartbeat keeps it live
    await expect(acquireRepoLock(dir, { budgetMs: 800, staleMs: 300, pollMs: 20 })).rejects.toThrow(
      /held by pid \d+ .*heartbeat live.*not released within 800ms/,
    );
    const release = await acquireRepoLock(dir, { budgetMs: 10_000, staleMs: 300, pollMs: 20 });
    expect(readOwner(dir)?.pid).toBe(process.pid);
    release();
    await closed;
  }, 20_000);

  /** A holder in another process that blocks its MAIN thread (as spawnSync does) for `blockMs`. */
  function blockingHolder(dir: string, blockMs: number, mainSilenceMs: number) {
    const script = join(dirname(dir), "blocking-holder.mts");
    writeFileSync(
      script,
      `import { acquireRepoLock, readOwner } from ${JSON.stringify(join(REPO, "scripts/lib/repo-lock.ts"))};
const release = await acquireRepoLock(${JSON.stringify(dir)}, { budgetMs: 1000, heartbeatMs: 50, mainSilenceMs: ${mainSilenceMs} });
process.stdout.write("held\\n");
await new Promise((r) => setTimeout(r, 200));
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${blockMs});
process.stdout.write("own " + (readOwner(${JSON.stringify(dir)})?.pid === process.pid) + "\\n");
release();
process.exit(0);
`,
    );
    const holder = spawn(TSX, [script], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    holder.stdout.on("data", (d: Buffer) => (out += d.toString()));
    const closed = new Promise((ok) => holder.on("close", ok));
    const held = new Promise<void>((ok) => holder.stdout.once("data", () => ok()));
    return { held, closed, out: () => out };
  }

  it("R8: the heartbeat survives a main thread blocked longer than staleMs (it beats on a worker thread); an uncapped waiter queues until release", async () => {
    const dir = lockDir();
    const h = blockingHolder(dir, 2_000, 60_000);
    await h.held;
    const waits: unknown[] = [];
    const release = await acquireRepoLock(dir, {
      budgetMs: Number.POSITIVE_INFINITY,
      staleMs: 400,
      pollMs: 20,
      onWait: (o) => waits.push(o),
    });
    await h.closed;
    expect(h.out(), "the blocked holder kept its lock").toMatch(/own true/);
    expect(waits).toHaveLength(1);
    expect(readOwner(dir)?.pid).toBe(process.pid);
    release();
  }, 20_000);

  it("R8: a holder whose main thread is wedged past mainSilenceMs stops beating and is reclaimed", async () => {
    const dir = lockDir();
    const h = blockingHolder(dir, 4_000, 300);
    await h.held;
    const t0 = performance.now();
    const release = await acquireRepoLock(dir, { budgetMs: 10_000, staleMs: 400, pollMs: 20 });
    expect(performance.now() - t0).toBeLessThan(3_500);
    release();
    await h.closed;
    expect(h.out()).toMatch(/own false/);
  }, 20_000);

  it("assess is deterministic on the injected monotonic clock and ignores wall-clock skew", () => {
    vi.useFakeTimers();
    const owner = { pid: process.pid, host: hostname(), run: "r" };
    const obs: Observation = { sig: null, since: 0 };
    const alive = (): boolean => true;
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    expect(assess(owner, "r 1", obs, 0, 1_000, alive).stale).toBe(false);
    // wall clock jumps FORWARD two hours: a beating holder stays live
    vi.setSystemTime(new Date("2026-10-01T02:00:00Z"));
    expect(assess(owner, "r 2", obs, 900, 1_000, alive).stale).toBe(false);
    expect(assess(owner, "r 3", obs, 1_800, 1_000, alive).stale).toBe(false);
    // wall clock jumps BACK a day: a holder that stopped beating still goes
    // stale exactly when the monotonic clock says so, never sooner, never later
    vi.setSystemTime(new Date("2026-09-30T00:00:00Z"));
    expect(assess(owner, "r 3", obs, 2_799, 1_000, alive).stale).toBe(false);
    expect(assess(owner, "r 3", obs, 2_800, 1_000, alive).stale).toBe(true);
    // a dead pid on this host is stale at once, whatever the clocks say
    const fresh: Observation = { sig: null, since: 0 };
    expect(assess(owner, "r 9", fresh, 0, 1_000, () => false).stale).toBe(true);
    // a holder on another host is judged by its beat alone (no pid probe)
    const remote = { ...owner, host: `not-${hostname()}` };
    const robs: Observation = { sig: null, since: 0 };
    expect(assess(remote, "r 1", robs, 0, 1_000, () => false).stale).toBe(false);
    expect(assess(remote, "r 1", robs, 1_000, 1_000, () => false).stale).toBe(true);
  });
});
