/**
 * Every goal row the CLI writes NOW carries a sensitivity stamp. The legacy
 * rule (`goalTextSensitivity` in @motebit/runtime: an unstamped top-level
 * goal is held at `personal`) exists only for rows that pre-date the
 * migration that added the column; a new unstamped row would silently take
 * that exception. Covers every top-level goal writer the CLI has: `motebit
 * goal add`, `/goal add` (repl-goals.test.ts), the scheduler's maintenance
 * goal, and `motebit up` routines (add and update).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("../config.js", async () => {
  const actual = await vi.importActual<typeof import("../config.js")>("../config.js");
  return {
    ...actual,
    loadFullConfig: () => ({ motebit_id: "owner" }),
    saveFullConfig: vi.fn(),
  };
});

import { RiskLevel, SensitivityLevel, isSensitivityLevel } from "@motebit/sdk";
import { openMotebitDatabase, type Goal } from "@motebit/persistence";
import type { CliConfig } from "../args.js";
import { handleGoalAdd } from "../subcommands/goals.js";
import { applyMotebitYaml } from "../subcommands/up.js";
import { GoalScheduler } from "../scheduler.js";
import { goalRunFakes } from "./goal-run-fakes.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "goal-stamp-"));
  dbPath = path.join(dir, "motebit.db");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

async function goals(): Promise<Goal[]> {
  const db = await openMotebitDatabase(dbPath);
  try {
    return db.goalStore.list("owner");
  } finally {
    db.close();
  }
}

function expectStamped(rows: Goal[]): void {
  expect(rows.length).toBeGreaterThan(0);
  for (const g of rows) {
    expect(isSensitivityLevel(g.sensitivity), `goal "${g.prompt}" is unstamped`).toBe(true);
  }
}

describe("new goal rows are stamped", () => {
  it("`motebit goal add` stamps the goal at the CLI session's tier", async () => {
    await handleGoalAdd({
      positionals: ["goal", "add", "check the inbox"],
      every: "1h",
      dbPath,
    } as unknown as CliConfig);
    const rows = await goals();
    expectStamped(rows);
    expect(rows[0]!.sensitivity).toBe(SensitivityLevel.Personal);
  });

  it("`motebit up` stamps routines on add and on update", async () => {
    const yamlPath = path.join(dir, "motebit.yaml");
    const write = (prompt: string) =>
      fs.writeFileSync(
        yamlPath,
        `version: 1\nroutines:\n  - id: digest\n    prompt: "${prompt}"\n    every: 24h\n`,
      );
    write("summarize pinned memories");
    const opts = { yamlPath, motebitId: "owner", dbPath, prune: false, dryRun: false };
    expect((await applyMotebitYaml(opts)).kind).toBe("applied");
    expectStamped(await goals());
    write("summarize pinned memories, briefly");
    expect((await applyMotebitYaml(opts)).kind).toBe("applied");
    const rows = await goals();
    expectStamped(rows);
    expect(rows.map((g) => g.sensitivity)).toEqual([SensitivityLevel.Personal]);
  });

  it("the scheduler's maintenance goal is stamped", async () => {
    const db = await openMotebitDatabase(dbPath);
    try {
      const scheduler = new GoalScheduler(
        goalRunFakes() as never,
        db.goalStore,
        db.approvalStore,
        db.goalOutcomeStore,
        db.goalRunStore,
        db.toolAuditSink,
        "owner",
        RiskLevel.R3_EXECUTE,
      );
      (scheduler as unknown as { ensureMaintenanceGoal(): void }).ensureMaintenanceGoal();
    } finally {
      db.close();
    }
    const rows = await goals();
    expectStamped(rows);
    expect(rows[0]!.sensitivity).toBe(SensitivityLevel.Personal);
  });
});
