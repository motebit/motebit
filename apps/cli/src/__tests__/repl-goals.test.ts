import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleSlashCommand, type ReplContext } from "../index.js";
import { createMotebitDatabase, type MotebitDatabase, type Goal } from "@motebit/persistence";
import type { MotebitRuntime } from "@motebit/runtime";

function makeRepl(moteDb: MotebitDatabase, motebitId = "mote-test"): ReplContext {
  return { moteDb, motebitId, mcpAdapters: [] };
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    goal_id: "goal-001",
    motebit_id: "mote-test",
    prompt: "check system health",
    interval_ms: 1_800_000,
    last_run_at: null,
    enabled: true,
    created_at: Date.now(),
    mode: "recurring",
    status: "active",
    parent_goal_id: null,
    max_retries: 3,
    consecutive_failures: 0,
    wall_clock_ms: null,
    project_id: null,
    ...overrides,
  };
}

// Stub runtime — goal/approval commands don't use it
const stubRuntime = null as unknown as MotebitRuntime;
const stubConfig = {
  provider: "anthropic" as const,
  model: "test",
  dbPath: undefined,
  noStream: false,
  syncUrl: undefined,
  syncToken: undefined,
  operator: false,
  allowedPaths: [],
  output: undefined,
  identity: undefined,
  every: undefined,
  once: false,
  wallClock: undefined,
  project: undefined,
  reason: undefined,
  destination: undefined,
  serveTransport: undefined,
  servePort: undefined,
  tools: undefined,
  selfTest: false,
  direct: false,
  allowedCommands: [],
  blockedCommands: [],
  json: false,
  presentation: false,
  version: false,
  help: false,
  positionals: [],
};

describe("REPL /goals command", () => {
  let moteDb: MotebitDatabase;

  beforeEach(() => {
    moteDb = createMotebitDatabase(":memory:");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("shows empty state message when no goals", async () => {
    const repl = makeRepl(moteDb);
    await handleSlashCommand("goals", "", stubRuntime, stubConfig, undefined, repl);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("No goals scheduled"));
  });

  it("lists goals with status icons", async () => {
    const repl = makeRepl(moteDb);
    moteDb.goalStore.add(makeGoal());
    moteDb.goalStore.add(
      makeGoal({
        goal_id: "goal-002",
        prompt: "send daily report",
        status: "paused",
        enabled: false,
      }),
    );

    await handleSlashCommand("goals", "", stubRuntime, stubConfig, undefined, repl);

    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(calls).toContain("[+]"); // active
    expect(calls).toContain("[~]"); // paused
    expect(calls).toContain("check system health");
    expect(calls).toContain("send daily report");
  });

  it("shows last outcome summary", async () => {
    const repl = makeRepl(moteDb);
    moteDb.goalStore.add(makeGoal());
    moteDb.goalOutcomeStore.add({
      outcome_id: "out-1",
      goal_id: "goal-001",
      motebit_id: "mote-test",
      ran_at: Date.now(),
      status: "completed",
      summary: "All systems nominal",
      tool_calls_made: 2,
      memories_formed: 1,
      error_message: null,
    });

    await handleSlashCommand("goals", "", stubRuntime, stubConfig, undefined, repl);

    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(calls).toContain("All systems nominal");
  });
});

describe("REPL /goal add command", () => {
  let moteDb: MotebitDatabase;

  beforeEach(() => {
    moteDb = createMotebitDatabase(":memory:");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("adds a recurring goal with quoted prompt", async () => {
    const repl = makeRepl(moteDb);
    await handleSlashCommand(
      "goal",
      'add "check emails" --every 30m',
      stubRuntime,
      stubConfig,
      undefined,
      repl,
    );

    const goals = moteDb.goalStore.list("mote-test");
    expect(goals).toHaveLength(1);
    expect(goals[0]!.prompt).toBe("check emails");
    expect(goals[0]!.interval_ms).toBe(30 * 60_000);
    expect(goals[0]!.mode).toBe("recurring");
  });

  it("adds a one-shot goal with --once flag", async () => {
    const repl = makeRepl(moteDb);
    await handleSlashCommand(
      "goal",
      'add "deploy once" --every 1h --once',
      stubRuntime,
      stubConfig,
      undefined,
      repl,
    );

    const goals = moteDb.goalStore.list("mote-test");
    expect(goals).toHaveLength(1);
    expect(goals[0]!.mode).toBe("once");
  });

  it("rejects add without --every", async () => {
    const repl = makeRepl(moteDb);
    await handleSlashCommand("goal", 'add "no interval"', stubRuntime, stubConfig, undefined, repl);

    const goals = moteDb.goalStore.list("mote-test");
    expect(goals).toHaveLength(0);

    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(calls).toContain("--every");
  });
});

describe("REPL /goal remove/pause/resume", () => {
  let moteDb: MotebitDatabase;

  beforeEach(() => {
    moteDb = createMotebitDatabase(":memory:");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("removes a goal by prefix", async () => {
    const repl = makeRepl(moteDb);
    moteDb.goalStore.add(makeGoal());

    await handleSlashCommand("goal", "remove goal-001", stubRuntime, stubConfig, undefined, repl);
    expect(moteDb.goalStore.list("mote-test")).toHaveLength(0);
  });

  it("pauses and resumes a goal", async () => {
    const repl = makeRepl(moteDb);
    moteDb.goalStore.add(makeGoal());

    await handleSlashCommand("goal", "pause goal-001", stubRuntime, stubConfig, undefined, repl);
    expect(moteDb.goalStore.get("goal-001")!.enabled).toBe(false);
    expect(moteDb.goalStore.get("goal-001")!.status).toBe("paused");

    await handleSlashCommand("goal", "resume goal-001", stubRuntime, stubConfig, undefined, repl);
    expect(moteDb.goalStore.get("goal-001")!.enabled).toBe(true);
    expect(moteDb.goalStore.get("goal-001")!.status).toBe("active");
  });

  it("reports not found for unknown goal id", async () => {
    const repl = makeRepl(moteDb);
    await handleSlashCommand(
      "goal",
      "remove nonexistent",
      stubRuntime,
      stubConfig,
      undefined,
      repl,
    );

    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(calls).toContain("No goal found");
  });
});

describe("REPL /goal outcomes", () => {
  let moteDb: MotebitDatabase;

  beforeEach(() => {
    moteDb = createMotebitDatabase(":memory:");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("shows outcomes for a goal", async () => {
    const repl = makeRepl(moteDb);
    moteDb.goalStore.add(makeGoal());
    moteDb.goalOutcomeStore.add({
      outcome_id: "out-1",
      goal_id: "goal-001",
      motebit_id: "mote-test",
      ran_at: Date.now() - 3_600_000,
      status: "completed",
      summary: "Checked inbox, found 2 emails",
      tool_calls_made: 3,
      memories_formed: 1,
      error_message: null,
    });
    moteDb.goalOutcomeStore.add({
      outcome_id: "out-2",
      goal_id: "goal-001",
      motebit_id: "mote-test",
      ran_at: Date.now() - 60_000,
      status: "failed",
      summary: null,
      tool_calls_made: 0,
      memories_formed: 0,
      error_message: "Connection timeout",
    });

    await handleSlashCommand("goal", "outcomes goal-001", stubRuntime, stubConfig, undefined, repl);

    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(calls).toContain("Checked inbox");
    expect(calls).toContain("Connection timeout");
  });

  it("shows empty message when no outcomes", async () => {
    const repl = makeRepl(moteDb);
    moteDb.goalStore.add(makeGoal());

    await handleSlashCommand("goal", "outcomes goal-001", stubRuntime, stubConfig, undefined, repl);

    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(calls).toContain("No outcomes");
  });
});

describe("REPL /approvals command", () => {
  let moteDb: MotebitDatabase;

  beforeEach(() => {
    moteDb = createMotebitDatabase(":memory:");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("shows empty state when no approvals", async () => {
    const repl = makeRepl(moteDb);
    await handleSlashCommand("approvals", "", stubRuntime, stubConfig, undefined, repl);

    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(calls).toContain("No pending approvals");
  });

  it("shows pending approvals", async () => {
    const repl = makeRepl(moteDb);
    const now = Date.now();
    moteDb.approvalStore.add({
      approval_id: "appr-001",
      motebit_id: "mote-test",
      goal_id: "goal-001",
      tool_name: "shell_exec",
      args_preview: '{"command":"ls -la"}',
      args_hash: "abc123",
      risk_level: 3,
      status: "pending",
      created_at: now,
      expires_at: now + 3_600_000,
      resolved_at: null,
      denied_reason: null,
    });

    await handleSlashCommand("approvals", "", stubRuntime, stubConfig, undefined, repl);

    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(calls).toContain("shell_exec");
    expect(calls).toContain("appr-001");
    expect(calls).toContain("Pending approvals (1)");
  });

  it("filters to only pending approvals", async () => {
    const repl = makeRepl(moteDb);
    const now = Date.now();
    moteDb.approvalStore.add({
      approval_id: "appr-resolved",
      motebit_id: "mote-test",
      goal_id: "goal-001",
      tool_name: "write_file",
      args_preview: "{}",
      args_hash: "def456",
      risk_level: 2,
      status: "approved",
      created_at: now - 60_000,
      expires_at: now + 3_600_000,
      resolved_at: now,
      denied_reason: null,
    });

    await handleSlashCommand("approvals", "", stubRuntime, stubConfig, undefined, repl);

    const calls = (console.log as ReturnType<typeof vi.fn>).mock.calls.flat().join("\n");
    expect(calls).toContain("No pending approvals");
    expect(calls).toContain("1 total");
  });
});
