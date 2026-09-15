/**
 * Crash durability, for real: a child process, a file-backed SQLite
 * database, and SIGKILL — delivered after a recovered approved call's
 * external effect succeeded but BEFORE its completion row and the run's
 * outcome were recorded. The next process must hold that action as
 * "prepared; effect unknown" and must not execute the approval again.
 *
 * The in-memory tests in scheduler-durable.test.ts model this state by
 * hand; this one produces it by actually killing the process.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMotebitDatabase } from "@motebit/persistence";
import { RiskLevel } from "@motebit/sdk";
import { GoalScheduler } from "../scheduler.js";
import type { MotebitRuntime, StreamChunk } from "@motebit/runtime";

const here = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(here, "fixtures", "crash-child.ts");
// Run the child as a single node process (`node --import tsx`), not through
// the tsx bin wrapper: killing a wrapper would orphan the real process and
// the exit signal would not be the child's own.
const CLI_ROOT = path.join(here, "..", "..");

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("durable execution — a real process death after the effect, before the record", () => {
  it("the next process holds the action as unknown and does not execute the approval again", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "motebit-crash-"));
    const dbPath = path.join(dir, "motebit.db");
    const marker = path.join(dir, "effect.marker");
    try {
      const child = spawn(process.execPath, ["--import", "tsx", CHILD, dbPath, marker], {
        cwd: CLI_ROOT,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
        child.on("exit", (code, signal) => r({ code, signal })),
      );

      // Wait for the external effect to have happened.
      const deadline = Date.now() + 25_000;
      while (!existsSync(marker)) {
        if (Date.now() > deadline) throw new Error(`child never reached the effect: ${stderr}`);
        if (child.exitCode != null) throw new Error(`child exited early: ${stderr}`);
        await sleep(50);
      }
      // Kill it there — effect done, nothing recorded.
      child.kill("SIGKILL");
      const { signal } = await exited;
      expect(signal).toBe("SIGKILL");

      // The on-disk state a real death leaves: a `running` run, an `approved`
      // approval, a decision row with no completion row.
      const db = createMotebitDatabase(dbPath);
      const [approval] = db.approvalStore.listAll("mote-crash");
      expect(approval!.status).toBe("approved");
      const runBefore = db.goalRunStore.getByApproval(approval!.approval_id)!;
      expect(runBefore.status).toBe("running");

      // Next process.
      const invoked: string[] = [];
      let streams = 0;
      const noop = async (): Promise<void> => undefined;
      const runtime = {
        hasPendingApproval: false,
        pendingApprovalInfo: null,
        async *sendMessageStreaming(): AsyncGenerator<StreamChunk> {
          streams++;
          yield { type: "text" as const, text: "done" };
        },
        async *resumeAfterApproval(): AsyncGenerator<StreamChunk> {},
        async invokeLocalTool(name: string) {
          invoked.push(name);
          return { ok: true };
        },
        events: { getLatestClock: async () => 0, append: noop },
        goals: { created: noop, executed: noop, progress: noop, completed: noop, removed: noop },
        setGoalStatusResolver: () => undefined,
        getToolRegistry: () => ({ register: () => undefined, replace: () => undefined }),
        stop: () => undefined,
        consolidationCycle: noop,
      } as unknown as MotebitRuntime;
      const s = new GoalScheduler(
        runtime,
        db.goalStore,
        db.approvalStore,
        db.goalOutcomeStore,
        db.goalRunStore,
        db.toolAuditSink,
        "mote-crash",
        RiskLevel.R3_EXECUTE,
      );
      s.registerGoalTools();
      s.recoverInterruptedRuns();
      await s.tickOnce();
      await s.tickOnce();

      expect(invoked).toEqual([]); // the approval is NOT executed a second time
      expect(streams).toBe(0); // the goal is held
      const run = db.goalRunStore.get(runBefore.run_id)!;
      expect(run.status).toBe("interrupted");
      expect(run.reviewed_at).toBeNull();
      expect(run.uncertain_actions?.map((u) => u.call_id)).toEqual(["call-crash"]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
