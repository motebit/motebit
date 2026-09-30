/**
 * tamper-runner self-tests: LIFECYCLE. A signal mid-tamper kills the running
 * test and removes every copy; startup reaps the copies a killed run left
 * behind (owner dead, or directory gone) and never a live run's.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
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
import type { TamperEntry } from "../lib/tamper-runner";

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
  } catch {
    return false;
  }
  // A killed orphan can linger as a zombie until its reaper collects it.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return true;
  }
}

/** The owner record the runner writes into a slot base (owner.json). */
function ownerRecord(pid: number, over: { host?: string; pidns?: string | null } = {}): string {
  let pidns: string | null = null;
  try {
    pidns = readlinkSync("/proc/self/ns/pid");
  } catch {
    // no /proc
  }
  return JSON.stringify({ pid, host: hostname(), pidns, pgids: [], ...over });
}

function slowEntry(sentinel: string): TamperEntry {
  return {
    name: "slow",
    command: ["node", "slow.check.mjs", "TOKEN_SLOW", sentinel],
    redMarker: "never printed",
    edits: [{ file: SUM_FILE, from: "// marker: a comment", to: "// TOKEN_SLOW: a comment" }],
  };
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
    "a %s mid-tamper kills the running test (its whole process group) and removes every copy",
    async (sig) => {
      const sentinel = join(fx!.base, "slow.pid");
      const child = startDriver(fx!, [slowEntry(sentinel)], 1);
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
      if (owner != null) {
        writeFileSync(join(base, "owner.pid"), `${owner}\n`);
        writeFileSync(join(base, "owner.json"), ownerRecord(owner));
      }
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

  it("P-e: startup kills the process group a SIGKILLed run left running, then removes its copy", async () => {
    const sentinel = join(fx!.base, "slow.pid");
    const child = startDriver(fx!, [slowEntry(sentinel)], 1);
    const exited = new Promise<void>((r) => child.on("exit", () => r()));
    await until(
      () => existsSync(sentinel) && readFileSync(sentinel, "utf8") !== "",
      60_000,
      "the slow check",
    );
    const pid = Number(readFileSync(sentinel, "utf8"));
    child.kill("SIGKILL");
    await exited;
    // Nothing cleaned up: the detached test group outlives its runner.
    expect(alive(pid)).toBe(true);
    const d = drive(fx!, [{ name: "sum subtracts", ...SUM_TEST, edits: [BREAK_SUM] }], 1);
    expect(verdicts(d)).toEqual(["RED"]);
    await until(() => !alive(pid), 5_000, "the leftover test to die").catch(() => undefined);
    expect(alive(pid), d.out).toBe(false);
  });

  it("P-e: startup never reaps a dead-owner copy recorded by another host or pid namespace", () => {
    const dead = spawnSync("node", ["-e", ""]).pid!;
    const foreign = (tag: string, over: { host?: string; pidns?: string | null }): string => {
      const base = join(fx!.tmp, `motebit-tamper-${tag}`);
      mkdirSync(base);
      git(fx!, ["worktree", "add", "--detach", "--quiet", join(base, "slot-0"), "HEAD"]);
      writeFileSync(join(base, "owner.pid"), `${dead}\n`);
      writeFileSync(join(base, "owner.json"), ownerRecord(dead, over));
      return base;
    };
    const otherHost = foreign("host", { host: `not-${hostname()}` });
    const otherNs = foreign("ns", { pidns: "pid:[1]" });
    const d = drive(fx!, [{ name: "sum subtracts", ...SUM_TEST, edits: [BREAK_SUM] }], 1, {
      allowLeftovers: true,
    });
    expect(verdicts(d)).toEqual(["RED"]);
    expect(existsSync(join(otherHost, "slot-0")), d.out).toBe(true);
    expect(existsSync(join(otherNs, "slot-0")), d.out).toBe(true);
    for (const base of [otherHost, otherNs]) {
      execFileSync("git", ["worktree", "remove", "--force", join(base, "slot-0")], {
        cwd: fx!.repo,
      });
      rmSync(base, { recursive: true, force: true });
    }
  });
});
