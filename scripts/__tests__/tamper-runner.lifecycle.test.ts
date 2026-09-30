/**
 * tamper-runner self-tests: LIFECYCLE. A signal mid-tamper kills the running
 * test and removes every copy; startup reaps the copies a killed run left
 * behind (owner dead, or directory gone) and never a live run's.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BREAK_SUM,
  SUM_FILE,
  SUM_TEST,
  drive,
  git,
  leftovers,
  setupFixture,
  startDriver,
  teardownFixture,
  verdicts,
} from "./tamper-runner.harness";
import type { Fx } from "./tamper-runner.harness";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

let fx: Fx | undefined;
beforeEach(async () => {
  fx = await setupFixture();
});
afterEach(() => {
  teardownFixture(fx);
  fx = undefined;
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("tamper-runner lifecycle", () => {
  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)(
    "a %s mid-tamper kills the running test and removes every copy",
    async (sig) => {
      const sentinel = join(fx!.base, "slow.pid");
      const child = startDriver(
        fx!,
        [
          {
            name: "slow",
            command: ["node", "slow.check.mjs", "TOKEN_SLOW", sentinel],
            redMarker: "never printed",
            edits: [
              { file: SUM_FILE, from: "// marker: a comment", to: "// TOKEN_SLOW: a comment" },
            ],
          },
        ],
        1,
      );
      let out = "";
      child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr!.on("data", (d: Buffer) => (out += d.toString()));
      const exited = new Promise<void>((r) => child.on("exit", () => r()));
      await until(
        () => existsSync(sentinel) && readFileSync(sentinel, "utf8") !== "",
        60_000,
        "the slow check",
      );
      const pid = Number(readFileSync(sentinel, "utf8"));
      expect(leftovers(fx!).length).toBeGreaterThan(0);
      child.kill(sig);
      await exited;
      await until(() => !alive(pid), 5_000, "the running test to die").catch(() => undefined);
      expect(alive(pid), out).toBe(false);
      expect(leftovers(fx!), out).toEqual([]);
    },
  );

  it("startup removes stale copies whose owner is dead or whose directory is gone, and keeps a live one", () => {
    const stale = (tag: string, owner: number | null): string => {
      const base = join(fx!.tmp, `motebit-tamper-${tag}`);
      mkdirSync(base);
      const dir = join(base, "slot-0");
      git(fx!, ["worktree", "add", "--detach", "--quiet", dir, "HEAD"]);
      if (owner != null) writeFileSync(join(base, "owner.pid"), `${owner}\n`);
      return base;
    };
    const dead = spawnSync("node", ["-e", ""]).pid!;
    const deadBase = stale("dead", dead);
    const goneBase = stale("gone", dead);
    rmSync(goneBase, { recursive: true, force: true });
    const liveBase = stale("live", process.pid);

    const d = drive(fx!, [{ name: "sum subtracts", ...SUM_TEST, edits: [BREAK_SUM] }], 1, {
      allowLeftovers: true,
    });
    expect(verdicts(d)).toEqual(["RED"]);
    expect(existsSync(deadBase)).toBe(false);
    expect(leftovers(fx!)).toEqual([join(liveBase, "slot-0"), liveBase]);
    execFileSync("git", ["worktree", "remove", "--force", join(liveBase, "slot-0")], {
      cwd: fx!.repo,
    });
    rmSync(liveBase, { recursive: true, force: true });
  });
});
