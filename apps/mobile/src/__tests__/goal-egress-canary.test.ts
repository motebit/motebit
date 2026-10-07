/**
 * Goal-scheduler egress canary (mobile): the REAL `MobileGoalScheduler`
 * ticks a REAL `MotebitRuntime` over the real `ExpoGoalStore` (expo-sqlite
 * mocked onto an in-memory SQLite running the mobile migrations). Goals
 * written at Secret, saved run summaries produced at Secret, legacy
 * unstamped summaries and a sub-goal the model wrote during a Secret run
 * must never reach an external (BYOK) provider; the same seeding kept
 * on-device at Secret must reach it (the seeds are live). Sibling of the
 * runtime's `egress-canary.test.ts` (goal scheduler tick) and the desktop /
 * CLI `goal-egress-canary.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("expo-sqlite", () => ({ openDatabaseSync: vi.fn() }));
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
import { createSubGoalDefinition } from "@motebit/tools/web-safe";
import { ExpoGoalStore } from "../adapters/expo-sqlite.js";
import type { ExpoStorageResult } from "../adapters/expo-sqlite.js";
import { MOBILE_MIGRATIONS } from "../adapters/expo-sqlite-migrations.js";
import { MobileGoalScheduler } from "../goal-scheduler.js";

interface BetterDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...p: unknown[]): { changes: number };
    all(...p: unknown[]): unknown[];
    get(...p: unknown[]): unknown;
  };
}
// The mobile tsconfig carries no Node types (it targets React Native), so the
// Node built-in is loaded through a non-literal specifier.
const NODE_MODULE = "node:module";
const { createRequire } = (await import(/* @vite-ignore */ NODE_MODULE)) as {
  createRequire: (path: string) => (id: string) => unknown;
};
const requireFromPersistence = createRequire(
  decodeURIComponent(
    new URL("../../../../packages/persistence/package.json", import.meta.url).pathname,
  ),
);
const Database = requireFromPersistence("better-sqlite3") as new (path: string) => BetterDb;

function goalStore() {
  const db = new Database(":memory:");
  // The goals / goal_outcomes tables are created and altered by the
  // migrations; statements on tables outside them (created by the adapter's
  // base schema) are skipped.
  for (const m of MOBILE_MIGRATIONS)
    for (const sql of m.statements) {
      try {
        db.exec(sql);
      } catch {
        /* a table this harness does not need */
      }
    }
  const handle = {
    runSync: (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
    getAllSync: (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
    getFirstSync: (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) ?? null,
  };
  return { store: new ExpoGoalStore(handle as never), handle };
}

const CANARY = {
  goal: "MCNRYGOAL01",
  summary: "MCNRYSUMMARY02",
  legacy: "MCNRYLEGACY03",
  subGoal: "MCNRYSUBGOAL04",
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
  const { store, handle } = goalStore();
  const planStore = new InMemoryPlanStore();
  const planEngine = new PlanEngine(planStore);
  const sched = new MobileGoalScheduler({
    getRuntime: () => runtime,
    getMotebitId: () => "owner",
    getPlanEngine: () => (withPlans ? planEngine : null),
    getStorage: () => ({ goalStore: store, planStore }) as unknown as ExpoStorageResult,
  });
  // Wired as mobile-app.ts wires it.
  runtime
    .getToolRegistry()
    .register(createSubGoalDefinition, (args: Record<string, unknown>) =>
      sched.createSubGoal(args),
    );
  const tick = () => (sched as unknown as { goalTick(): Promise<void> }).goalTick();
  const addGoal = (id: string, prompt: string, sensitivity: string) =>
    handle.runSync(
      `INSERT INTO goals (goal_id, motebit_id, prompt, interval_ms, last_run_at, enabled, created_at, mode, status, parent_goal_id, max_retries, consecutive_failures, budget_tokens, sensitivity)
       VALUES (?, 'owner', ?, 0, NULL, 1, ?, 'recurring', 'active', NULL, 9, 0, NULL, ?)`,
      [id, prompt, Date.now(), sensitivity],
    );

  set("on-device", SensitivityLevel.Secret);
  addGoal("g-secret", `goal ${CANARY.goal}`, "secret");
  addGoal("g-plain", "tidy the desk", "personal");
  await tick();
  store.insertOutcome({
    outcome_id: "legacy",
    goal_id: "g-plain",
    motebit_id: "owner",
    ran_at: 1,
    status: "completed",
    summary: `legacy ${CANARY.legacy}`,
    tool_calls_made: 0,
    memories_formed: 0,
    error_message: null,
    tokens_used: null,
    response_full: null,
    signed_manifest: null,
  });
  const sub = store.listGoals("owner").find((g) => g.prompt.includes(CANARY.subGoal));
  expect(sub, "the Secret run wrote a sub-goal").toBeDefined();
  for (const g of store.listGoals("owner")) store.updateLastRun(g.goal_id, 0);

  // Background work the Secret runs started (reflection after a run) finishes
  // on the provider it was cleared for before the provider changes — in
  // production a switch installs a different provider object; here one
  // recording provider plays both, so it must not straddle the switch.
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  const before = sent.length;
  if (target === "byok") set("byok", SensitivityLevel.Personal);
  await tick();
  const sends = sent.slice(before).filter((s) => s.mode === target);
  const seen = KEYS.filter((k) => sends.some((s) => s.seen.includes(CANARY[k])));
  const failed = (id: string) =>
    store
      .getRecentOutcomes(id, 10)
      .some((o) => o.status === "failed" && String(o.error_message).includes("on-device"));
  return { store, sends, seen, sub: sub!, failed };
}

describe.each([false, true])("mobile goal scheduler egress canary (plans: %s)", (withPlans) => {
  it("a tick on BYOK carries no goal, summary or sub-goal written at Secret", async () => {
    const { sends, seen, sub, failed, store } = await seedAndRun(withPlans, "byok");
    expect(seen, "Secret goal-scheduler canaries sent to BYOK").toEqual([]);
    expect(sends.length).toBeGreaterThan(0);
    expect(failed("g-secret")).toBe(true);
    expect(failed(sub.goal_id)).toBe(true);
    expect(failed("g-plain")).toBe(false);
    expect(sub.sensitivity).toBe(SensitivityLevel.Secret);
    expect(
      store
        .getRecentOutcomes("g-secret", 10)
        .filter((o) => o.status === "completed")
        .map((o) => o.sensitivity),
    ).toEqual([SensitivityLevel.Secret]);
  });

  it("the seeds are live: on-device at Secret, the same tick sees every canary", async () => {
    const { seen } = await seedAndRun(withPlans, "on-device");
    expect(seen.sort()).toEqual([...KEYS].sort());
  });
});
