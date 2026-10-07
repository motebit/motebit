/**
 * Goal-scheduler egress canary (CLI daemon): the REAL `GoalScheduler` ticks
 * a REAL `MotebitRuntime` over a real SQLite goal store. Goals written at
 * Secret, saved run summaries produced at Secret (and the goal-outcome
 * memories formed from them), legacy unstamped summaries, a sub-goal the
 * model wrote during a Secret run, and the parent / sibling context a
 * child goal's run reads must never reach an external (BYOK) provider; the
 * same seeding kept on-device at Secret must reach it (the seeds are live).
 * Sibling of the runtime's `egress-canary.test.ts` (goal scheduler tick) and
 * the desktop / mobile `goal-egress-canary.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@motebit/memory-graph", async () => {
  const actual =
    await vi.importActual<typeof import("@motebit/memory-graph")>("@motebit/memory-graph");
  return { ...actual, embedText: (text: string) => Promise.resolve(actual.embedTextHash(text)) };
});

import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "@motebit/runtime";
import type { StreamingProvider } from "@motebit/ai-core";
import type { AIResponse, ContextPack } from "@motebit/sdk";
import { RiskLevel, SensitivityLevel } from "@motebit/sdk";
import { InMemoryPlanStore, PlanEngine } from "@motebit/planner";
import { createMotebitDatabase, type Goal } from "@motebit/persistence";
import { GoalScheduler } from "../scheduler.js";

const CANARY = {
  goal: "CCNRYGOAL01",
  summary: "CCNRYSUMMARY02",
  legacy: "CCNRYLEGACY03",
  subGoal: "CCNRYSUBGOAL04",
  // A plan reflection's learning (`[goal_learning]` memory) produced by a
  // Secret run — reached a BYOK plan's recalled memories while it was
  // stamped `none` (round-5 finding 1). Only plan runs reflect.
  learning: "CCNRYLEARN05",
} as const;
type Key = keyof typeof CANARY;
const keysFor = (withPlans: boolean): Key[] =>
  (Object.keys(CANARY) as Key[]).filter((k) => withPlans || k !== "learning");

interface Sent {
  mode: string;
  seen: string;
}

function recordingProvider(
  sent: Sent[],
  mode: () => string,
  live: () => boolean,
): StreamingProvider {
  const plain = (text: string, extra: Partial<AIResponse> = {}): AIResponse => ({
    text,
    confidence: 0.8,
    memory_candidates: [],
    state_updates: {},
    ...extra,
  });
  const gen = (ctx: ContextPack): AIResponse => {
    sent.push({ mode: mode(), seen: JSON.stringify(ctx) });
    const um = ctx.user_message ?? "";
    const history = JSON.stringify(ctx.conversation_history ?? []);
    if (history.includes("reflecting on a completed plan"))
      return plain(
        JSON.stringify({
          summary: "reflected",
          memoryCandidates: [live() ? `learned ${CANARY.learning}` : "learned nothing new"],
        }),
      );
    if (history.includes("planning engine"))
      return plain(
        JSON.stringify({
          title: "Plan",
          steps: [{ description: "do", prompt: `do: ${um.slice(0, 40)}` }],
        }),
      );
    if (um.includes(CANARY.goal) && live() && !history.includes("t-subgoal"))
      return plain("", {
        tool_calls: [
          { id: "t-subgoal", name: "create_sub_goal", args: { prompt: `sub ${CANARY.subGoal}` } },
        ],
      });
    return plain(`run done ${live() ? CANARY.summary : "plain"}`);
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn(async (ctx: ContextPack) => gen(ctx)),
    estimateConfidence: vi.fn(async () => 0.8),
    extractMemoryCandidates: vi.fn(async () => []),
    async *generateStream(ctx: ContextPack) {
      const response = gen(ctx);
      if (response.text) yield { type: "text" as const, text: response.text };
      yield { type: "done" as const, response };
    },
  };
}

function goal(overrides: Partial<Goal> & { goal_id: string; prompt: string }): Goal {
  return {
    motebit_id: "owner",
    interval_ms: 0,
    last_run_at: null,
    enabled: true,
    created_at: Date.now(),
    mode: "recurring",
    status: "active",
    parent_goal_id: null,
    max_retries: 9,
    consecutive_failures: 0,
    wall_clock_ms: null,
    project_id: null,
    ...overrides,
  };
}

async function seedAndRun(withPlans: boolean, target: "byok" | "on-device") {
  const sent: Sent[] = [];
  let mode = "on-device";
  let tier: SensitivityLevel = SensitivityLevel.None;
  const runtime = new MotebitRuntime(
    {
      motebitId: "owner",
      tickRateHz: 0,
      policy: {
        operatorMode: true,
        maxRiskLevel: RiskLevel.R3_EXECUTE,
        requireApprovalAbove: RiskLevel.R2_WRITE,
        denyAbove: RiskLevel.R3_EXECUTE,
      },
    },
    {
      storage: createInMemoryStorage(),
      renderer: new NullRenderer(),
      ai: recordingProvider(
        sent,
        () => mode,
        () => mode === "on-device" && tier === SensitivityLevel.Secret,
      ),
    },
  );
  const set = (m: "on-device" | "byok", t: SensitivityLevel) => {
    mode = m;
    tier = t;
    runtime.setProviderMode(m);
    runtime.setSessionSensitivity(t);
  };
  const db = createMotebitDatabase(":memory:");
  const scheduler = new GoalScheduler(
    runtime,
    db.goalStore,
    db.approvalStore,
    db.goalOutcomeStore,
    db.goalRunStore,
    db.toolAuditSink,
    "owner",
    RiskLevel.R3_EXECUTE,
  );
  if (withPlans) {
    const planStore = new InMemoryPlanStore();
    scheduler.setPlanEngine(new PlanEngine(planStore), planStore);
  }
  scheduler.registerGoalTools();

  set("on-device", SensitivityLevel.Secret);
  db.goalStore.add(
    goal({
      goal_id: "g-secret",
      prompt: `goal ${CANARY.goal}`,
      sensitivity: SensitivityLevel.Secret,
    }),
  );
  db.goalStore.add(
    goal({ goal_id: "g-plain", prompt: "tidy the desk", sensitivity: SensitivityLevel.Personal }),
  );
  // A child the owner wrote at Personal under the Secret goal: its run reads
  // its parent's prompt and results and its siblings' (the Secret sub-goal).
  db.goalStore.add(
    goal({
      goal_id: "g-child",
      prompt: "water the plants",
      parent_goal_id: "g-secret",
      sensitivity: SensitivityLevel.Personal,
    }),
  );
  await scheduler.tickOnce();
  db.goalOutcomeStore.add({
    outcome_id: "legacy",
    goal_id: "g-plain",
    motebit_id: "owner",
    ran_at: 1,
    status: "completed",
    summary: `legacy ${CANARY.legacy}`,
    tool_calls_made: 0,
    memories_formed: 0,
    error_message: null,
  });
  const sub = db.goalStore.listChildren("g-secret").find((g) => g.goal_id !== "g-child");
  expect(sub, "the Secret run wrote a sub-goal").toBeDefined();

  // Background work the Secret runs started (reflection after a run) finishes
  // on the provider it was cleared for before the provider changes — in
  // production a switch installs a different provider object; here one
  // recording provider plays both, so it must not straddle the switch.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  const before = sent.length;
  if (target === "byok") set("byok", SensitivityLevel.Personal);
  await scheduler.tickOnce();
  const sends = sent.slice(before).filter((s) => s.mode === target);
  const seen = keysFor(withPlans).filter((k) => sends.some((s) => s.seen.includes(CANARY[k])));
  const failed = (id: string) =>
    db.goalOutcomeStore
      .listForGoal(id, 10)
      .some((o) => o.status === "failed" && String(o.error_message).includes("on-device"));
  const learnings = (await runtime.memory.exportAll()).nodes.filter((n) =>
    n.content.startsWith("[goal_learning]"),
  );
  return { db, sends, seen, sub: sub!, failed, learnings };
}

describe.each([false, true])("CLI goal scheduler egress canary (plans: %s)", (withPlans) => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("a tick on BYOK carries no goal, summary, outcome memory or sub-goal written at Secret", async () => {
    const { sends, seen, sub, failed, db, learnings } = await seedAndRun(withPlans, "byok");
    expect(seen, "Secret goal-scheduler canaries sent to BYOK").toEqual([]);
    // A plan reflection's learnings carry the tier of the run that reflected.
    if (withPlans) {
      const secret = learnings.filter((n) => n.content.includes(CANARY.learning));
      expect(secret.length, "the Secret run reflected a learning").toBeGreaterThan(0);
      expect(secret.map((n) => n.sensitivity)).toEqual(secret.map(() => SensitivityLevel.Secret));
    }
    expect(sends.length).toBeGreaterThan(0);
    expect(failed("g-secret")).toBe(true);
    expect(failed(sub.goal_id)).toBe(true);
    expect(failed("g-plain")).toBe(false);
    expect(failed("g-child")).toBe(false);
    expect(sub.sensitivity).toBe(SensitivityLevel.Secret);
    expect(
      db.goalOutcomeStore
        .listForGoal("g-secret", 10)
        .filter((o) => o.status === "completed")
        .map((o) => o.sensitivity),
    ).toEqual([SensitivityLevel.Secret]);
  });

  it("the seeds are live: on-device at Secret, the same tick sees every canary", async () => {
    const { seen } = await seedAndRun(withPlans, "on-device");
    expect(seen.sort()).toEqual(keysFor(withPlans).sort());
  });
});
