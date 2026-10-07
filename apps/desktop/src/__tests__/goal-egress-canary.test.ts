/**
 * Goal-scheduler egress canary (desktop): the REAL `GoalScheduler` ticks a
 * REAL `MotebitRuntime` over a fake Tauri goals database. Goals written at
 * Secret, saved run summaries produced at Secret, legacy unstamped
 * summaries and a sub-goal the model wrote during a Secret run must never
 * reach an external (BYOK) provider; the same seeding kept on-device at
 * Secret must reach it (the seeds are live). Sibling of the runtime's
 * `egress-canary.test.ts` (goal scheduler tick) and the CLI / mobile
 * `goal-egress-canary.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";

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
import { GoalScheduler } from "../goal-scheduler";
import type { InvokeFn } from "../tauri-storage";

const CANARY = {
  goal: "DCNRYGOAL01",
  summary: "DCNRYSUMMARY02",
  legacy: "DCNRYLEGACY03",
  subGoal: "DCNRYSUBGOAL04",
} as const;
const KEYS = Object.keys(CANARY) as Array<keyof typeof CANARY>;

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

type Row = Record<string, unknown>;

/** A fake of the goals / goal_outcomes tables behind `db_query` / `db_execute` / `goals_create`. */
function fakeDb() {
  const goals: Row[] = [];
  const outcomes: Row[] = [];
  const literal = (v: string): unknown => {
    const t = v.trim();
    if (t === "NULL") return null;
    if (/^'.*'$/.test(t)) return t.slice(1, -1);
    if (/^-?\d+$/.test(t)) return Number(t);
    return t;
  };
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
    const sql = String((args as { sql?: string } | undefined)?.sql ?? "").replace(/\s+/g, " ");
    const params = [...(((args as { params?: unknown[] } | undefined)?.params ?? []) as unknown[])];
    if (cmd === "goals_create") {
      goals.push({
        goal_id: args!.goal_id,
        motebit_id: args!.motebit_id,
        prompt: args!.prompt,
        interval_ms: args!.interval_ms,
        mode: args!.mode,
        status: "active",
        enabled: 1,
        last_run_at: null,
        parent_goal_id: null,
        max_retries: 3,
        consecutive_failures: 0,
        budget_tokens: null,
        sensitivity: null,
      });
      return undefined;
    }
    if (cmd === "db_query") {
      if (sql.includes("FROM goals WHERE goal_id = ?"))
        return goals.filter((g) => g.goal_id === params[0]).map((g) => ({ ...g }));
      if (sql.includes("FROM goals")) return goals.map((g) => ({ ...g }));
      if (sql.includes("SUM(tokens_used)")) return [{ spent: 0 }];
      if (sql.includes("FROM goal_outcomes WHERE goal_id = ?")) {
        const rows = outcomes
          .filter((o) => o.goal_id === params[0])
          .filter((o) => !sql.includes("status != 'running'") || o.status !== "running")
          .sort((a, b) => Number(b.ran_at) - Number(a.ran_at));
        const limit = /LIMIT (\d+)/.exec(sql);
        return (limit ? rows.slice(0, Number(limit[1])) : rows).map((o) => ({ ...o }));
      }
      return [];
    }
    if (cmd === "db_execute") {
      const ins = /INSERT OR REPLACE INTO goal_outcomes \(([^)]*)\) VALUES \((.*)\)$/.exec(
        sql.trim(),
      );
      if (ins) {
        const cols = ins[1]!.split(",").map((c) => c.trim());
        const vals = ins[2]!
          .split(",")
          .map((v) => (v.trim() === "?" ? params.shift() : literal(v)));
        const row: Row = {};
        cols.forEach((c, i) => (row[c] = vals[i]));
        const at = outcomes.findIndex((o) => o.outcome_id === row.outcome_id);
        if (at >= 0) outcomes[at] = row;
        else outcomes.push(row);
        return 1;
      }
      const upd = /^UPDATE goals SET (.*) WHERE goal_id = \?/.exec(sql.trim());
      if (upd) {
        const sets = upd[1]!.split(",").map((s) => s.split("=").map((x) => x.trim()));
        const values = sets.map(([, v]) => (v === "?" ? params.shift() : literal(v!)));
        const id = params.shift();
        const g = goals.find((x) => x.goal_id === id);
        if (g)
          sets.forEach(([c], i) => {
            if (!String(values[i]).includes("+")) g[c!] = values[i];
          });
        return 1;
      }
      return 1;
    }
    return undefined;
  });
  return { goals, outcomes, invoke: invoke as unknown as InvokeFn };
}

async function harness(withPlans: boolean) {
  const sent: Sent[] = [];
  let mode = "on-device";
  const runtime: MotebitRuntime = new MotebitRuntime(
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
        () => mode === "on-device" && sessionTier === SensitivityLevel.Secret,
      ),
    },
  );
  let sessionTier: SensitivityLevel = SensitivityLevel.None;
  const set = (m: "on-device" | "byok", tier: SensitivityLevel) => {
    mode = m;
    sessionTier = tier;
    runtime.setProviderMode(m);
    runtime.setSessionSensitivity(tier);
  };
  const planStore = new InMemoryPlanStore();
  const planEngine = new PlanEngine(planStore);
  const scheduler = new GoalScheduler({
    getRuntime: () => runtime,
    getMotebitId: () => "owner",
    getPlanEngine: () => (withPlans ? planEngine : null),
    getPlanStore: () => (withPlans ? planStore : null),
  });
  const db = fakeDb();
  scheduler.registerGoalTools(db.invoke);
  return { runtime, sent, set, scheduler, db };
}

async function seedAndRun(withPlans: boolean, target: "byok" | "on-device") {
  const h = await harness(withPlans);
  h.set("on-device", SensitivityLevel.Secret);
  const goal = (goal_id: string, prompt: string, sensitivity: SensitivityLevel | null) =>
    h.db.goals.push({
      goal_id,
      motebit_id: "owner",
      prompt,
      interval_ms: 60_000,
      mode: "recurring",
      status: "active",
      enabled: 1,
      last_run_at: null,
      parent_goal_id: null,
      max_retries: 9,
      consecutive_failures: 0,
      budget_tokens: null,
      sensitivity,
    });
  goal("g-secret", `goal ${CANARY.goal}`, SensitivityLevel.Secret);
  goal("g-plain", "tidy the desk", SensitivityLevel.Personal);
  await h.scheduler.runNow(h.db.invoke, "g-secret"); // writes the sub-goal + a Secret summary
  await h.scheduler.runNow(h.db.invoke, "g-plain"); // a Secret-tier run of a Personal goal
  h.db.outcomes.push({
    outcome_id: "legacy",
    goal_id: "g-plain",
    ran_at: 1,
    status: "completed",
    summary: `legacy ${CANARY.legacy}`,
    error_message: null,
  });
  const sub = h.db.goals.find((g) => g.parent_goal_id === "g-secret");
  expect(sub, "the Secret run wrote a sub-goal").toBeDefined();

  // Background work the Secret runs started (reflection after a run) finishes
  // on the provider it was cleared for before the provider changes — in
  // production a switch installs a different provider object; here one
  // recording provider plays both, so it must not straddle the switch.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  const before = h.sent.length;
  if (target === "byok") h.set("byok", SensitivityLevel.Personal);
  for (const g of [...h.db.goals]) await h.scheduler.runNow(h.db.invoke, String(g.goal_id));
  const sends = h.sent.slice(before).filter((s) => s.mode === target);
  const seen = KEYS.filter((k) => sends.some((s) => s.seen.includes(CANARY[k])));
  const failed = (id: unknown) =>
    h.db.outcomes.some(
      (o) =>
        o.goal_id === id && o.status === "failed" && String(o.error_message).includes("on-device"),
    );
  return { h, sends, seen, sub: sub!, failed };
}

for (const withPlans of [false, true]) {
  const path = withPlans ? "plan path" : "single-turn path";
  describe(`desktop goal scheduler egress canary (${path})`, () => {
    it("a tick on BYOK carries no goal, summary or sub-goal written at Secret", async () => {
      const { sends, seen, sub, failed, h } = await seedAndRun(withPlans, "byok");
      expect(seen, "Secret goal-scheduler canaries sent to BYOK").toEqual([]);
      // The Personal goal still ran on BYOK.
      expect(sends.length).toBeGreaterThan(0);
      // The Secret goal and the sub-goal written at Secret refuse with the gate's reason.
      expect(failed("g-secret")).toBe(true);
      expect(failed(sub.goal_id)).toBe(true);
      expect(failed("g-plain")).toBe(false);
      // What the Secret runs produced is stamped at the tier they ran at.
      expect(sub.sensitivity).toBe(SensitivityLevel.Secret);
      expect(
        h.db.outcomes
          .filter((o) => o.goal_id === "g-secret" && o.status === "completed")
          .map((o) => o.sensitivity),
      ).toEqual([SensitivityLevel.Secret]);
    });

    it("the seeds are live: on-device at Secret, the same tick sees every canary", async () => {
      const { seen } = await seedAndRun(withPlans, "on-device");
      expect(seen.sort()).toEqual([...KEYS].sort());
    });
  });
}
