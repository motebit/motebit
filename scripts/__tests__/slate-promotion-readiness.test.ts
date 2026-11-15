/**
 * slate-promotion-readiness — the archetype slate's staging → prod promotion
 * is refused without five consecutive green SCHEDULED conformance runs
 * (docs/doctrine/agent-archetypes.md §4), at the one place the promotion
 * happens: `RUN=1 TARGET=prod scripts/deploy-archetype-slate.ts`.
 *
 * Three halves:
 *   1. the readiness decision (scripts/check-promotion-ready.ts) against an
 *      injected run lister, and its CLI's exit codes;
 *   2. the slate ceremony (`runSlate`) against a recording command runner:
 *      every flyctl call, relay read and readiness read lands in one ordered
 *      event list, so "refused before anything touched the world" is exact;
 *   3. the two scripts as PROGRAMS, with a fake `gh` and a fake `flyctl` on
 *      a PATH that holds nothing else: the default `gh run list` adapter and
 *      the real wiring of the refusal.
 *
 * Nothing here runs the real gh or flyctl, or reaches a network.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  CONFORMANCE_WORKFLOW,
  PROMOTION_REQUIRED_GREEN_RUNS,
  readPromotionReadiness,
  runCheckPromotionReady,
  type ConformanceRun,
  type ListRuns,
} from "../check-promotion-ready.js";
import {
  PROMOTION_READINESS_OVERRIDE_ENV,
  SLATE,
  realEffects,
  runSlate,
  type SlateEffects,
} from "../deploy-archetype-slate.js";

const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."));

/** The injected clock: a few hours after the newest fixture run. */
const NOW = new Date("2026-11-15T20:00:00Z");
const HOUR = 3_600_000;

/**
 * A scheduled run on main, first attempt, created at 14:17 UTC `daysAgo` days
 * before `base` (default: the fixed 2026-11-15).
 */
function run(
  daysAgo: number,
  conclusion: string | null,
  over: Partial<ConformanceRun> = {},
  base = new Date("2026-11-15T14:17:00Z"),
): ConformanceRun {
  return {
    attempt: 1,
    conclusion,
    createdAt: new Date(base.getTime() - daysAgo * 24 * HOUR).toISOString().replace(".000Z", "Z"),
    event: "schedule",
    headBranch: "main",
    status: conclusion === null ? "in_progress" : "completed",
    url: `https://github.example/runs/${1000 - daysAgo}`,
    ...over,
  };
}
/** Newest first, as `gh run list` answers. */
const history = (...conclusions: Array<string | null>): ConformanceRun[] =>
  conclusions.map((c, i) => run(i, c));
/** The same, dated against the REAL clock (newest: one hour ago), for the program tests. */
const liveHistory = (...conclusions: Array<string | null>): ConformanceRun[] => {
  const base = new Date(Math.floor((Date.now() - HOUR) / 1000) * 1000);
  return conclusions.map((c, i) => run(i, c, {}, base));
};

/** `readPromotionReadiness` on the injected clock. */
const read = (opts: Parameters<typeof readPromotionReadiness>[0]) =>
  readPromotionReadiness({ now: () => NOW, ...opts });

const FIVE_GREEN = history("success", "success", "success", "success", "success");
const ONE_RED = history("success", "success", "failure", "success", "success");
const THIN = history("success", "success", "success");
const GH_DOWN = new Error("spawnSync gh ENOENT");

// ---------------------------------------------------------------------------
// 1. the readiness decision
// ---------------------------------------------------------------------------

describe("readPromotionReadiness", () => {
  const lister =
    (rows: unknown): ListRuns =>
    (limit) =>
      Array.isArray(rows) ? rows.slice(0, limit) : rows;

  it("the required count is five", () => {
    expect(PROMOTION_REQUIRED_GREEN_RUNS).toBe(5);
    const asked: number[] = [];
    read({
      listRuns: (limit) => {
        asked.push(limit);
        return FIVE_GREEN;
      },
    });
    expect(asked).toEqual([5]);
  });

  it("five green scheduled runs: ready, with the run window", () => {
    const result = read({ listRuns: lister(FIVE_GREEN) });
    expect(result).toEqual({ ready: true, required: 5, runs: FIVE_GREEN });
  });

  it("gh unreadable (the lister throws): not ready, gh-unreadable", () => {
    const result = read({
      listRuns: () => {
        throw GH_DOWN;
      },
    });
    expect(result).toEqual({
      ready: false,
      reason: "gh-unreadable",
      required: 5,
      detail: "spawnSync gh ENOENT",
    });
  });

  it("an answer that is not a list of runs: not ready, gh-unreadable", () => {
    for (const answer of [
      { message: "Bad credentials" },
      null,
      "[]",
      [{ conclusion: "success" }],
    ]) {
      const result = read({ listRuns: lister(answer) });
      expect(result.ready).toBe(false);
      expect(result.ready === false && result.reason).toBe("gh-unreadable");
    }
  });

  it("a required count that is not a positive integer: not ready, the lister never asked", () => {
    for (const required of [0, -1, 2.5, Number.NaN]) {
      let asked = 0;
      const result = read({
        required,
        listRuns: () => {
          asked += 1;
          return FIVE_GREEN;
        },
      });
      expect(result.ready).toBe(false);
      expect(asked).toBe(0);
    }
  });

  it("thin history: not ready, thin-history", () => {
    const result = read({ listRuns: lister(THIN) });
    expect(result).toEqual({ ready: false, reason: "thin-history", required: 5, runs: THIN });
    expect(read({ listRuns: lister([]) })).toMatchObject({
      ready: false,
      reason: "thin-history",
    });
  });

  it("a failed, cancelled or pending run in the window: not ready, not-all-green, naming the runs", () => {
    for (const conclusion of ["failure", "cancelled", "timed_out", "skipped", null]) {
      const rows = history("success", conclusion, "success", "success", "success");
      const result = read({ listRuns: lister(rows) });
      expect(result).toEqual({
        ready: false,
        reason: "not-all-green",
        required: 5,
        runs: rows,
        failing: [rows[1]],
      });
    }
  });

  it("only scheduled runs count: a manual dispatch in the answer is thin history, never a green", () => {
    const dispatch = run(0, "success", { event: "workflow_dispatch" });
    const four = [1, 2, 3, 4].map((daysAgo) => run(daysAgo, "success"));
    const result = read({ listRuns: () => [dispatch, ...four] });
    expect(result).toMatchObject({ ready: false, reason: "thin-history", runs: four });
  });

  it("only the newest `required` runs count: an older red beyond the window does not block", () => {
    const rows = history("success", "success", "success", "success", "success", "failure");
    expect(read({ listRuns: () => rows })).toEqual({
      ready: true,
      required: 5,
      runs: rows.slice(0, 5),
    });
  });

  it("a re-run attempt is not an unattended green: not ready, rerun-attempt, naming the run", () => {
    // A scheduled run that failed and that someone re-ran to success.
    const rows = history("success", "success", "success", "success", "success");
    rows[1] = run(1, "success", { attempt: 2 });
    expect(read({ listRuns: lister(rows) })).toEqual({
      ready: false,
      reason: "rerun-attempt",
      required: 5,
      runs: rows,
      failing: [rows[1]],
    });
  });

  it("a run on another branch does not count: not ready, wrong-branch", () => {
    const rows = history("success", "success", "success", "success", "success");
    rows[4] = run(4, "success", { headBranch: "release/probe" });
    expect(read({ listRuns: lister(rows) })).toEqual({
      ready: false,
      reason: "wrong-branch",
      required: 5,
      runs: rows,
      failing: [rows[4]],
    });
  });

  it("a run that says success but is not completed does not count: not-all-green", () => {
    const rows = history("success", "success", "success", "success", "success");
    rows[0] = run(0, "success", { status: "in_progress" });
    expect(read({ listRuns: lister(rows) })).toMatchObject({
      ready: false,
      reason: "not-all-green",
      failing: [rows[0]],
    });
  });

  it("a stale newest run: five old greens do not stand in for a stopped schedule (48 hours)", () => {
    const newest = Date.parse(FIVE_GREEN[0]!.createdAt);
    const at = (hours: number) => () => new Date(newest + hours * HOUR);
    // Exactly 48 hours old still counts; past it does not.
    expect(readPromotionReadiness({ listRuns: lister(FIVE_GREEN), now: at(48) }).ready).toBe(true);
    const stale = readPromotionReadiness({ listRuns: lister(FIVE_GREEN), now: at(48.5) });
    expect(stale).toMatchObject({ ready: false, reason: "stale-history", runs: FIVE_GREEN });
    expect(stale.ready === false && stale.reason === "stale-history" && stale.newestAgeHours).toBe(
      48.5,
    );
    expect(
      readPromotionReadiness({ listRuns: lister(FIVE_GREEN), now: at(24 * 30) }),
    ).toMatchObject({ ready: false, reason: "stale-history" });
  });

  it("the answer's order is not trusted: an oldest-first answer with a newer red row is not ready", () => {
    // Six rows, oldest first; the red one is the NEWEST. Taking "the first
    // five" as given would count five greens.
    const newestFirst = history("failure", "success", "success", "success", "success", "success");
    const oldestFirst = [...newestFirst].reverse();
    expect(read({ listRuns: () => oldestFirst })).toEqual({
      ready: false,
      reason: "not-all-green",
      required: 5,
      runs: newestFirst.slice(0, 5),
      failing: [newestFirst[0]],
    });
    // And a shuffled all-green answer is ready, with the window newest first.
    const shuffled = [
      FIVE_GREEN[3]!,
      FIVE_GREEN[0]!,
      FIVE_GREEN[4]!,
      FIVE_GREEN[2]!,
      FIVE_GREEN[1]!,
    ];
    expect(read({ listRuns: () => shuffled })).toEqual({
      ready: true,
      required: 5,
      runs: FIVE_GREEN,
    });
  });

  it("extra rows change nothing: more than `required`, other events, in any order", () => {
    const older = [run(5, "failure"), run(6, "cancelled"), run(7, "success", { attempt: 3 })];
    const dispatches = [
      run(0, "failure", { event: "workflow_dispatch", createdAt: "2026-11-15T16:00:00Z" }),
      run(1, "failure", { event: "push" }),
    ];
    expect(read({ listRuns: () => [...older, ...dispatches, ...FIVE_GREEN] })).toEqual({
      ready: true,
      required: 5,
      runs: FIVE_GREEN,
    });
  });

  it("a run without the new fields, or with a date that does not parse, is an unreadable answer", () => {
    const { attempt: _a, ...noAttempt } = FIVE_GREEN[0]!;
    const { headBranch: _b, ...noBranch } = FIVE_GREEN[0]!;
    const { status: _s, ...noStatus } = FIVE_GREEN[0]!;
    const badDate = { ...FIVE_GREEN[0]!, createdAt: "yesterday" };
    for (const bad of [noAttempt, noBranch, noStatus, badDate]) {
      expect(read({ listRuns: () => [bad, ...FIVE_GREEN.slice(1)] })).toMatchObject({
        ready: false,
        reason: "gh-unreadable",
      });
    }
  });

  it("the window must be consecutive: no two counted runs more than 48 hours apart", () => {
    const t0 = Date.parse("2026-11-15T14:17:00Z");
    const at = (hoursAgo: number, n: number) =>
      run(0, "success", {
        createdAt: new Date(t0 - hoursAgo * HOUR).toISOString().replace(".000Z", "Z"),
        url: `https://github.example/runs/gap-${n}`,
      });
    // Gaps of exactly 48 hours count (GitHub's cron runs late, never to the minute).
    const boundary = [at(0, 0), at(48, 1), at(96, 2), at(144, 3), at(192, 4)];
    expect(read({ listRuns: () => boundary })).toEqual({
      ready: true,
      required: 5,
      runs: boundary,
    });

    // A 49 hour gap in the middle: daily, daily, then a hole.
    const hole = [at(0, 0), at(24, 1), at(48, 2), at(97, 3), at(121, 4)];
    expect(read({ listRuns: () => hole })).toEqual({
      ready: false,
      reason: "gap-in-history",
      required: 5,
      runs: hole,
      gap: { newer: hole[2], older: hole[3], hours: 49 },
    });

    // One green from today and four from August: the newest is fresh, the window is not.
    const august = [
      at(0, 0),
      run(0, "success", {
        createdAt: "2026-08-14T14:17:00Z",
        url: "https://github.example/runs/a1",
      }),
      run(0, "success", {
        createdAt: "2026-08-13T14:17:00Z",
        url: "https://github.example/runs/a2",
      }),
      run(0, "success", {
        createdAt: "2026-08-12T14:17:00Z",
        url: "https://github.example/runs/a3",
      }),
      run(0, "success", {
        createdAt: "2026-08-11T14:17:00Z",
        url: "https://github.example/runs/a4",
      }),
    ];
    const result = read({ listRuns: () => august });
    expect(result).toMatchObject({
      ready: false,
      reason: "gap-in-history",
      gap: { newer: august[0], older: august[1] },
    });
  });

  it("a run listed twice counts once: five copies of one green run are thin history", () => {
    const one = FIVE_GREEN[0]!;
    expect(read({ listRuns: () => [one, one, one, one, one] })).toEqual({
      ready: false,
      reason: "thin-history",
      required: 5,
      runs: [one],
    });
    // Duplicates beside a full window change nothing.
    expect(read({ listRuns: () => [...FIVE_GREEN, ...FIVE_GREEN] })).toEqual({
      ready: true,
      required: 5,
      runs: FIVE_GREEN,
    });
  });
});

// ---------------------------------------------------------------------------
// the check-promotion-ready CLI (injected lister): exit codes and text
// ---------------------------------------------------------------------------

function cli(env: Record<string, string | undefined>, rows: ConformanceRun[] | Error) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: number[] = [];
  const code = runCheckPromotionReady({
    env,
    listRuns: (limit) => {
      asked.push(limit);
      if (rows instanceof Error) throw rows;
      return rows.slice(0, limit);
    },
    now: () => NOW,
    log: (l) => out.push(l),
    error: (l) => err.push(l),
  });
  return { code, out: out.join("\n"), err: err.join("\n"), asked };
}

describe("check-promotion-ready CLI", () => {
  it("ready: exit 0, the green window, and a READY line that says what the slate command does and does not check", () => {
    const r = cli({}, FIVE_GREEN);
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toContain(
      "✓ check-promotion-ready: last 5 scheduled conformance runs all green (2026-11-11T14:17:00Z → 2026-11-15T14:17:00Z).",
    );
    expect(r.out).toContain("READY — the slate's prod command is: RUN=1 TARGET=prod");
    expect(r.out).toContain("re-checks this readiness itself");
    expect(r.out).toContain("refuses unless ready");
    expect(r.out).toContain("no CI gate and no GitHub environment reviewer applies to it");
    expect(r.out).not.toContain("does not re-check");
    expect(r.asked).toEqual([5]);
  });

  it("not all green: exit 1, the failing runs listed", () => {
    const r = cli({}, ONE_RED);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toBe(
      [
        "check-promotion-ready: 1/5 of the last scheduled runs did not succeed:",
        `  ${ONE_RED[2]!.createdAt}  failure  ${ONE_RED[2]!.url}`,
        "NOT READY.",
        "Fix: Fix what the runs listed above caught, then wait for the daily schedule to turn the window green (manual dispatches do not count).",
      ].join("\n"),
    );
  });

  it("a re-run, another branch, a stale window: exit 1, each named with its repair", () => {
    const rerun = history("success", "success", "success", "success", "success");
    rerun[2] = run(2, "success", { attempt: 2 });
    const a = cli({}, rerun);
    expect(a.code).toBe(1);
    expect(a.err).toBe(
      [
        "check-promotion-ready: 1/5 of the last scheduled runs are re-runs, not the scheduled attempt:",
        `  ${rerun[2]!.createdAt}  attempt 2  ${rerun[2]!.url}`,
        "NOT READY — a re-run someone started is not an unattended green.",
        "Fix: Wait for the daily schedule to replace the re-run runs with first attempts (do not `gh run rerun` a scheduled run: the re-run never counts).",
      ].join("\n"),
    );

    const branch = history("success", "success", "success", "success", "success");
    branch[0] = run(0, "success", { headBranch: "probe" });
    const b = cli({}, branch);
    expect(b.code).toBe(1);
    expect(b.err).toContain("1/5 of the last scheduled runs did not run on main:");
    expect(b.err).toContain(`  ${branch[0]!.createdAt}  probe  ${branch[0]!.url}`);
    expect(b.err).toContain("NOT READY — only scheduled runs on main count.");

    // The newest fixture run is 2026-11-15T14:17Z; NOW is 20:00Z the same day.
    const old = [3, 4, 5, 6, 7].map((daysAgo) => run(daysAgo, "success"));
    const c = cli({}, old);
    expect(c.code).toBe(1);
    expect(c.err).toContain(
      "check-promotion-ready: the newest scheduled run (2026-11-12T14:17:00Z) is 77 hours old; the limit is 48.",
    );
    expect(c.err).toContain(
      "NOT READY — old greens do not stand in for a schedule that has stopped.",
    );
    expect(c.err).toContain("gh workflow enable");
  });

  it("a run still in progress reads `in progress`, with the re-check repair: exit 1", () => {
    // gh reports a running run's conclusion as "" (older answers: null).
    for (const conclusion of ["", null]) {
      const rows = history("success", "success", "success", "success", "success");
      rows[0] = run(0, conclusion, { status: "in_progress" });
      const r = cli({}, rows);
      expect(r.code).toBe(1);
      expect(r.err).toBe(
        [
          "check-promotion-ready: 1/5 of the last scheduled runs did not succeed:",
          `  ${rows[0]!.createdAt}  in progress  ${rows[0]!.url}`,
          "NOT READY.",
          "Fix: A scheduled run is still in progress: re-check when it finishes.",
        ].join("\n"),
      );
    }
    // A run in progress beside a real failure keeps the failure's repair.
    const mixed = history("success", "failure", "success", "success", "success");
    mixed[0] = run(0, "", { status: "queued" });
    const m = cli({}, mixed);
    expect(m.code).toBe(1);
    expect(m.err).toContain("  in progress  ");
    expect(m.err).toContain("  failure  ");
    expect(m.err).toContain("Fix: Fix what the runs listed above caught");
  });

  it("a gap in the window: exit 1, named with its repair", () => {
    const rows = history("success", "success", "success", "success", "success");
    rows[4] = run(9, "success");
    const r = cli({}, rows);
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      [
        "check-promotion-ready: 144 hours passed between two consecutive counted runs (2026-11-06T14:17:00Z → 2026-11-12T14:17:00Z); the limit is 48.",
        "NOT READY — the window must be consecutive daily runs; greens from before a gap do not count toward it.",
        "Fix: Wait for the daily schedule to produce 5 consecutive runs with no more than 48 hours between any two (if the schedule was disabled, the window restarts from when it resumed).",
      ].join("\n"),
    );
  });

  it("an older gh that does not know a field: exit 1, and the repair is to upgrade gh", () => {
    const r = cli(
      {},
      new Error(
        'Command failed: gh run list --json attempt\nUnknown JSON field: "attempt"\nAvailable fields:\n  conclusion\n',
      ),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("NOT READY — unknown history is not green history.");
    expect(r.err).toContain("Fix: Upgrade gh (`gh --version`): this check needs the `attempt`");
    expect(r.err).not.toContain("gh auth status");
  });

  it("thin history: exit 1", () => {
    const r = cli({}, THIN);
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      [
        "check-promotion-ready: only 3/5 scheduled run(s) on record.",
        "NOT READY — thin history reads not-ready by design (new workflow / retention horizon / rename).",
        "Fix: Wait for the daily schedule to put enough runs on record (manual dispatches do not count).",
      ].join("\n"),
    );
  });

  it("gh unreadable: exit 1", () => {
    const r = cli({}, GH_DOWN);
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      [
        `check-promotion-ready: could not read ${CONFORMANCE_WORKFLOW} run history via gh (spawnSync gh ENOENT).`,
        "NOT READY — unknown history is not green history.",
        "Fix: Install and authenticate gh (`gh auth status`) so the history can be read.",
      ].join("\n"),
    );
  });

  it("REQUIRED changes the hand-run CLI's window; garbage REQUIRED is not ready", () => {
    expect(cli({ REQUIRED: "3" }, THIN)).toMatchObject({ code: 0, asked: [3] });
    expect(cli({ REQUIRED: "0" }, FIVE_GREEN)).toMatchObject({ code: 1, asked: [] });
    expect(cli({ REQUIRED: "many" }, FIVE_GREEN)).toMatchObject({ code: 1, asked: [] });
  });
});

// ---------------------------------------------------------------------------
// 2. the slate ceremony against a recording runner
// ---------------------------------------------------------------------------

const RELAY_KEY = "ab".repeat(32);
const LIVE = { RUN: "1", MOTEBIT_API_TOKEN: "operator-token", ANTHROPIC_API_KEY: "inference-key" };

function slate(env: Record<string, string | undefined>, rows: ConformanceRun[] | Error) {
  /** Every effect on the world, in order: `readiness <limit>`, `flyctl …`, `fetch <url>`. */
  const events: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "text/json" } });
  const effects: SlateEffects = {
    env,
    exec: (cmd, args) => {
      events.push(`${cmd} ${args.join(" ")}`);
      // No app exists yet: `flyctl status` fails, so the ceremony creates it.
      if (args[0] === "status") throw new Error("app not found");
      return "";
    },
    fetch: (url) => {
      events.push(`fetch ${url}`);
      if (url.endsWith("/.well-known/motebit.json")) {
        return Promise.resolve(json({ public_key: RELAY_KEY }));
      }
      return Promise.resolve(
        json({
          agents: SLATE.map((svc) => ({
            motebit_id: `id-${svc.name}`,
            endpoint_url: `https://motebit-${svc.name}.fly.dev`,
            capabilities: [svc.capability],
          })),
        }),
      );
    },
    sleep: () => Promise.resolve(),
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    table: () => undefined,
    now: () => NOW,
    listRuns: (limit) => {
      events.push(`readiness ${limit}`);
      if (rows instanceof Error) throw rows;
      return rows.slice(0, limit);
    },
  };
  return runSlate(effects).then((code) => ({
    code,
    events,
    flyctl: events.filter((e) => e.startsWith("flyctl ")),
    readiness: events.filter((e) => e.startsWith("readiness ")),
    out: out.join("\n"),
    err: err.join("\n"),
  }));
}

/** A refusal: exit 1 and NOTHING but the readiness read touched the world. */
function expectRefused(r: Awaited<ReturnType<typeof slate>>): void {
  expect(r.code).toBe(1);
  expect(r.flyctl).toEqual([]);
  expect(r.events.filter((e) => e.includes("secrets"))).toEqual([]);
  expect(r.events).toEqual(["readiness 5"]);
  expect(r.err).toContain("REFUSED: the archetype slate is not ready for production.");
  expect(r.err).toContain("re-check with: npx tsx scripts/check-promotion-ready.ts");
  expect(r.err).toContain("archetype-conformance.yml");
}

describe("deploy-archetype-slate: the promotion-readiness gate", () => {
  // A promotion needs the operator's pin of the relay key (the clerk's tests
  // below); here it is set and matches, so these tests are about readiness.
  const PROD = { ...LIVE, TARGET: "prod", MOTEBIT_RELAY_PUBLIC_KEY: RELAY_KEY };

  it("prod real run, ready: proceeds, and the first flyctl call comes after the readiness read", async () => {
    const r = await slate(PROD, FIVE_GREEN);
    expect(r.code).toBe(0);
    expect(r.readiness).toEqual(["readiness 5"]);
    expect(r.events[0]).toBe("readiness 5");
    expect(r.events.indexOf("readiness 5")).toBeLessThan(
      r.events.findIndex((e) => e.startsWith("flyctl ")),
    );
    // The whole slate deployed, to the PROD apps.
    const deploys = r.flyctl.filter((e) => e.startsWith("flyctl deploy "));
    expect(deploys).toHaveLength(SLATE.length);
    for (const svc of SLATE) {
      expect(deploys).toContain(
        `flyctl deploy --config services/${svc.name}/fly.toml -a motebit-${svc.name} --remote-only`,
      );
    }
    expect(r.out).toContain("last 5 scheduled conformance runs all green");
    expect(r.err).toBe("");
  });

  it("prod real run, not all green: refuses, zero flyctl calls, exit 1, naming the failing runs and the repair", async () => {
    const r = await slate(PROD, ONE_RED);
    expectRefused(r);
    expect(r.err).toContain("1/5 of the last scheduled runs did not succeed:");
    expect(r.err).toContain(`${ONE_RED[2]!.createdAt}  failure  ${ONE_RED[2]!.url}`);
    expect(r.err).toContain("Fix what the runs listed above caught");
  });

  it("prod real run, thin history: refuses, zero flyctl calls, exit 1, naming the repair", async () => {
    const r = await slate(PROD, THIN);
    expectRefused(r);
    expect(r.err).toContain("only 3/5 scheduled run(s) on record.");
    expect(r.err).toContain("Wait for the daily schedule");
  });

  it("prod real run, gh unreadable: refuses, zero flyctl calls, exit 1, naming the repair", async () => {
    const r = await slate(PROD, GH_DOWN);
    expectRefused(r);
    expect(r.err).toContain("could not read archetype-conformance.yml run history via gh");
    expect(r.err).toContain("spawnSync gh ENOENT");
    expect(r.err).toContain("gh auth status");
  });

  it("prod real run reads exactly five runs: one fresh green above a red one refuses, whatever REQUIRED says", async () => {
    const rows = history("success", "failure", "success", "success", "success");
    expectRefused(await slate(PROD, rows));
    expectRefused(await slate({ ...PROD, REQUIRED: "1" }, rows));
  });

  it("the refusal comes before the token checks: a prod run with no tokens still refuses on readiness", async () => {
    const r = await slate({ RUN: "1", TARGET: "prod" }, ONE_RED);
    expectRefused(r);
  });

  it("override with a reason: proceeds, printing the reason", async () => {
    const reason = "relay key rotation: every worker must repin today (incident 1290)";
    const r = await slate({ ...PROD, [PROMOTION_READINESS_OVERRIDE_ENV]: `  ${reason} ` }, ONE_RED);
    expect(r.code).toBe(0);
    expect(r.events[0]).toBe("readiness 5");
    expect(r.flyctl.filter((e) => e.startsWith("flyctl deploy "))).toHaveLength(SLATE.length);
    expect(r.err).toContain("PROMOTION READINESS OVERRIDDEN");
    expect(r.err).toContain(`reason (PROMOTION_READINESS_OVERRIDE_REASON): ${reason}`);
    expect(r.err).not.toContain("REFUSED");
  });

  it("override with a reason: prints the readiness result it overrode", async () => {
    const withReason = { ...PROD, [PROMOTION_READINESS_OVERRIDE_ENV]: "operator decision" };
    const red = await slate(withReason, ONE_RED);
    expect(red.code).toBe(0);
    expect(red.err).toContain("1/5 of the last scheduled runs did not succeed:");
    expect(red.err).toContain(`${ONE_RED[2]!.createdAt}  failure  ${ONE_RED[2]!.url}`);
    const down = await slate(withReason, GH_DOWN);
    expect(down.code).toBe(0);
    expect(down.err).toContain("could not read archetype-conformance.yml run history via gh");
    const thin = await slate(withReason, THIN);
    expect(thin.code).toBe(0);
    expect(thin.err).toContain("only 3/5 scheduled run(s) on record.");
  });

  it("override empty or whitespace: refuses", async () => {
    for (const value of ["", " ", "\t\n  "]) {
      expectRefused(await slate({ ...PROD, [PROMOTION_READINESS_OVERRIDE_ENV]: value }, ONE_RED));
      expectRefused(await slate({ ...PROD, [PROMOTION_READINESS_OVERRIDE_ENV]: value }, GH_DOWN));
    }
  });

  it("an override that is not needed overrides nothing and says so", async () => {
    const r = await slate(
      { ...PROD, [PROMOTION_READINESS_OVERRIDE_ENV]: "just in case" },
      FIVE_GREEN,
    );
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    expect(r.out).toContain("overrides nothing: readiness is green");
  });

  it("prod dry run: reports readiness, refuses nothing, runs no flyctl", async () => {
    const red = await slate({ TARGET: "prod" }, ONE_RED);
    expect(red.code).toBe(0);
    expect(red.flyctl).toEqual([]);
    expect(red.readiness).toEqual(["readiness 5"]);
    expect(red.out).toContain("promotion readiness (dry run: reported, nothing refused):");
    expect(red.out).toContain("1/5 of the last scheduled runs did not succeed:");
    expect(red.out).toContain("A real run (RUN=1) would REFUSE here");
    expect(red.out).toContain("[dry-run] flyctl deploy --config services/auditor/fly.toml");

    const down = await slate({ TARGET: "prod" }, GH_DOWN);
    expect(down.code).toBe(0);
    expect(down.flyctl).toEqual([]);
    expect(down.out).toContain("could not read archetype-conformance.yml run history via gh");

    const green = await slate({ TARGET: "prod" }, FIVE_GREEN);
    expect(green.code).toBe(0);
    expect(green.flyctl).toEqual([]);
    expect(green.out).toContain("last 5 scheduled conformance runs all green");
  });

  it("staging real run: no readiness read, and it deploys the -stg apps", async () => {
    // Red history and a dead gh change nothing on staging.
    for (const rows of [ONE_RED, GH_DOWN]) {
      const r = await slate(LIVE, rows);
      expect(r.code).toBe(0);
      expect(r.readiness).toEqual([]);
      const deploys = r.flyctl.filter((e) => e.startsWith("flyctl deploy "));
      expect(deploys).toHaveLength(SLATE.length);
      expect(deploys.every((e) => e.includes("fly.staging.toml") && e.includes("-stg "))).toBe(
        true,
      );
    }
  });

  it("staging dry run: no readiness read, no flyctl", async () => {
    const r = await slate({}, GH_DOWN);
    expect(r.code).toBe(0);
    expect(r.readiness).toEqual([]);
    expect(r.flyctl).toEqual([]);
  });

  it("prod real run, a re-run attempt or a stale window: refuses, naming the repair", async () => {
    const rerun = history("success", "success", "success", "success", "success");
    rerun[0] = run(0, "success", { attempt: 2 });
    const a = await slate(PROD, rerun);
    expectRefused(a);
    expect(a.err).toContain(`${rerun[0]!.createdAt}  attempt 2  ${rerun[0]!.url}`);
    expect(a.err).toContain("the re-run never counts");

    const b = await slate(
      PROD,
      [3, 4, 5, 6, 7].map((daysAgo) => run(daysAgo, "success")),
    );
    expectRefused(b);
    expect(b.err).toContain("is 77 hours old; the limit is 48.");
    expect(b.err).toContain("gh workflow enable");
  });

  it("a flag-like or too-short override is not a reason: refuses, and says why", async () => {
    for (const value of [
      "1",
      "true",
      "TRUE",
      "yes",
      "y",
      "ok",
      "Override",
      " override ",
      "because",
      "hotfix!!!",
    ]) {
      const r = await slate({ ...PROD, [PROMOTION_READINESS_OVERRIDE_ENV]: value }, ONE_RED);
      expectRefused(r);
      expect(r.err).toContain(
        'PROMOTION_READINESS_OVERRIDE_REASON is set but is not a reason, so it overrides nothing: it needs at least 10 characters saying why, and "1" / "true" / "yes" / "y" / "ok" / "override" are not reasons.',
      );
      expect(r.err).not.toContain("OVERRIDDEN");
    }
    // Ten characters is a reason.
    const ok = await slate({ ...PROD, [PROMOTION_READINESS_OVERRIDE_ENV]: "key repin." }, ONE_RED);
    expect(ok.code).toBe(0);
    expect(ok.err).toContain("reason (PROMOTION_READINESS_OVERRIDE_REASON): key repin.");
  });

  it("TARGET must be unset, staging or prod exactly: anything else refuses before anything runs", async () => {
    for (const target of ["PROD", "Prod", "prod ", " prod", "production", "prd", "", "stg"]) {
      for (const base of [LIVE, {}]) {
        const r = await slate({ ...base, TARGET: target }, FIVE_GREEN);
        expect(r.code).toBe(1);
        expect(r.events).toEqual([]);
        expect(r.out).toBe("");
        expect(r.err).toContain(`REFUSED: TARGET=${JSON.stringify(target)} is not a target.`);
        expect(r.err).toContain("TARGET=prod for production");
      }
    }
    // The explicit staging spelling is staging.
    const stg = await slate({ ...LIVE, TARGET: "staging" }, GH_DOWN);
    expect(stg.code).toBe(0);
    expect(stg.readiness).toEqual([]);
    expect(
      stg.flyctl.filter((e) => e.startsWith("flyctl deploy ")).every((e) => e.includes("-stg ")),
    ).toBe(true);
  });

  it("staging apps joined to the PRODUCTION relay are gated as a promotion", async () => {
    for (const relay of [
      "https://relay.motebit.com",
      "https://relay.motebit.com/",
      "https://RELAY.motebit.com",
      "https://relay.motebit.com.:443/",
      "https://motebit-sync.fly.dev",
    ]) {
      // Not ready: refused, nothing touched, for unset and explicit staging alike.
      for (const target of [{}, { TARGET: "staging" }]) {
        const refused = await slate({ ...LIVE, ...target, RELAY_URL: relay }, ONE_RED);
        expectRefused(refused);
        expect(refused.out).toContain("is the PRODUCTION relay");
      }
      expectRefused(await slate({ ...LIVE, RELAY_URL: relay }, GH_DOWN));
      // Ready: proceeds, with the readiness read first, deploying the -stg apps.
      const ok = await slate(
        { ...LIVE, RELAY_URL: relay, MOTEBIT_RELAY_PUBLIC_KEY: RELAY_KEY },
        FIVE_GREEN,
      );
      expect(ok.code).toBe(0);
      expect(ok.events[0]).toBe("readiness 5");
      expect(ok.flyctl.some((e) => e.includes("-a motebit-auditor-stg "))).toBe(true);
      // A dry run reports and refuses nothing.
      const dry = await slate({ RELAY_URL: relay }, ONE_RED);
      expect(dry.code).toBe(0);
      expect(dry.readiness).toEqual(["readiness 5"]);
      expect(dry.flyctl).toEqual([]);
    }
    // Any other relay on a staging run: no readiness read.
    const other = await slate({ ...LIVE, RELAY_URL: "https://relay.example.test" }, GH_DOWN);
    expect(other.code).toBe(0);
    expect(other.readiness).toEqual([]);
  });

  it("a RELAY_URL that is not an http(s) URL refuses before anything runs", async () => {
    // `relay.motebit.com:443` PARSES as a URL (scheme `relay.motebit.com:`,
    // empty host): without the scheme check it is neither refused nor gated.
    for (const relay of [
      "relay.motebit.com",
      "relay.motebit.com:443",
      "motebit-sync.fly.dev:443/",
      "ftp://relay.motebit.com",
      "file:///relay.motebit.com",
      "https://",
      "",
    ]) {
      for (const base of [LIVE, { ...LIVE, TARGET: "prod" }, {}]) {
        const r = await slate({ ...base, RELAY_URL: relay }, FIVE_GREEN);
        expect(r.code).toBe(1);
        expect(r.events).toEqual([]);
        expect(r.err).toContain(
          `REFUSED: RELAY_URL=${JSON.stringify(relay)} is not an http(s) URL.`,
        );
      }
    }
    // http is a URL (a local relay in a test rig); it is simply not the production relay.
    const local = await slate({ ...LIVE, RELAY_URL: "http://127.0.0.1:1" }, GH_DOWN);
    expect(local.code).toBe(0);
    expect(local.readiness).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the clerk's relay key: one secret, the operator's pin or the fetched key
// ---------------------------------------------------------------------------

describe("deploy-archetype-slate: the clerk's staged secrets", () => {
  /** The KEY=value pairs of the clerk's first `flyctl secrets set`. */
  async function clerkSecrets(env: Record<string, string | undefined>): Promise<string[]> {
    const r = await slate({ ...LIVE, ...env }, FIVE_GREEN);
    expect(r.code).toBe(0);
    const staged = r.flyctl.filter((e) =>
      e.startsWith("flyctl secrets set --stage -a motebit-clerk-stg MOTEBIT_SYNC_URL="),
    );
    expect(staged).toHaveLength(1);
    return staged[0]!.split(" ").slice(6);
  }
  const OPERATOR_PIN = "cd".repeat(32);

  it("operator env unset: the clerk is staged the relay key fetched from the well-known descriptor", async () => {
    const pairs = await clerkSecrets({});
    expect(pairs.filter((p) => p.startsWith("MOTEBIT_RELAY_PUBLIC_KEY="))).toEqual([
      `MOTEBIT_RELAY_PUBLIC_KEY=${RELAY_KEY}`,
    ]);
  });

  it("operator env set: the clerk is staged the operator's pin; empty counts as unset", async () => {
    const pinned = await clerkSecrets({ MOTEBIT_RELAY_PUBLIC_KEY: OPERATOR_PIN });
    expect(pinned.filter((p) => p.startsWith("MOTEBIT_RELAY_PUBLIC_KEY="))).toEqual([
      `MOTEBIT_RELAY_PUBLIC_KEY=${OPERATOR_PIN}`,
    ]);
    const empty = await clerkSecrets({ MOTEBIT_RELAY_PUBLIC_KEY: "" });
    expect(empty.filter((p) => p.startsWith("MOTEBIT_RELAY_PUBLIC_KEY="))).toEqual([
      `MOTEBIT_RELAY_PUBLIC_KEY=${RELAY_KEY}`,
    ]);
  });

  it("the operator's pin reaches the clerk only: every other worker gets the fetched key", async () => {
    const r = await slate({ ...LIVE, MOTEBIT_RELAY_PUBLIC_KEY: OPERATOR_PIN }, FIVE_GREEN);
    const withKey = r.flyctl.filter((e) => e.includes(" MOTEBIT_RELAY_PUBLIC_KEY="));
    expect(withKey).toHaveLength(SLATE.length);
    for (const e of withKey) {
      const expected = e.includes("-a motebit-clerk-stg ") ? OPERATOR_PIN : RELAY_KEY;
      expect(e).toContain(` MOTEBIT_RELAY_PUBLIC_KEY=${expected}`);
    }
  });

  const PROD = { ...LIVE, TARGET: "prod" };
  const clerkKeyOf = (r: Awaited<ReturnType<typeof slate>>, app: string): string[] =>
    r.flyctl
      .filter((e) => e.startsWith(`flyctl secrets set --stage -a ${app} MOTEBIT_SYNC_URL=`))
      .flatMap((e) => e.split(" ").filter((p) => p.startsWith("MOTEBIT_RELAY_PUBLIC_KEY=")));
  /** Refused after the relay key was fetched: nothing but reads touched the world. */
  function expectPinRefused(r: Awaited<ReturnType<typeof slate>>, promotion: boolean): void {
    expect(r.code).toBe(1);
    expect(r.flyctl).toEqual([]);
    expect(r.events.filter((e) => !e.startsWith("readiness "))).toHaveLength(1);
    expect(r.events.at(-1)).toMatch(/^fetch .*\/\.well-known\/motebit\.json$/);
    expect(r.readiness).toEqual(promotion ? ["readiness 5"] : []);
    expect(r.err).toContain("Nothing was deployed.");
  }

  it("operator pin set and matching the relay: one value staged, said plainly, on prod and staging", async () => {
    for (const [env, app] of [
      [PROD, "motebit-clerk"],
      [LIVE, "motebit-clerk-stg"],
    ] as const) {
      const r = await slate({ ...env, MOTEBIT_RELAY_PUBLIC_KEY: RELAY_KEY }, FIVE_GREEN);
      expect(r.code).toBe(0);
      expect(clerkKeyOf(r, app)).toEqual([`MOTEBIT_RELAY_PUBLIC_KEY=${RELAY_KEY}`]);
      expect(r.out).toContain(
        "clerk's relay key: the operator's MOTEBIT_RELAY_PUBLIC_KEY, which matches the fetched key above.",
      );
      expect(r.err).toBe("");
    }
  });

  it("operator pin unset on a PROMOTION: refused, zero flyctl calls; the fetched key is not a pin", async () => {
    // Unset, empty and whitespace-only alike; prod target, and staging apps on the prod relay.
    for (const value of [undefined, "", " ", " \n\t"]) {
      for (const env of [PROD, { ...LIVE, RELAY_URL: "https://relay.motebit.com" }]) {
        const r = await slate({ ...env, MOTEBIT_RELAY_PUBLIC_KEY: value }, FIVE_GREEN);
        expectPinRefused(r, true);
        expect(r.err).toContain(
          "REFUSED: a production promotion needs the clerk's relay key pinned by the operator, and MOTEBIT_RELAY_PUBLIC_KEY is not set.",
        );
        expect(r.err).toContain(
          "serves (abababab…abababab, shown only for comparison) is trust on first use, not a pin.",
        );
        expect(r.err).toContain("obtained out of band");
        // The full fetched key is not handed back, in the refusal or the log, as something to paste.
        expect(r.err).not.toContain(RELAY_KEY);
        expect(r.out).not.toContain(RELAY_KEY);
        expect(r.out).toContain("abababab…abababab (first and last 8 characters only");
      }
    }
    // The readiness override does not stand in for the pin.
    const overridden = await slate(
      { ...PROD, [PROMOTION_READINESS_OVERRIDE_ENV]: "relay key rotation in progress" },
      ONE_RED,
    );
    expectPinRefused(overridden, true);
  });

  it("operator pin unset on a prod DRY run: reports what a real run would refuse, refuses nothing", async () => {
    const dry = await slate({ TARGET: "prod" }, FIVE_GREEN);
    expect(dry.code).toBe(0);
    expect(dry.flyctl).toEqual([]);
    expect(dry.err).toContain(
      "!!! WARNING: a production promotion needs the clerk's relay key pinned by the operator, and MOTEBIT_RELAY_PUBLIC_KEY is not set.",
    );
    expect(dry.err).toContain("A real run (RUN=1) would REFUSE here, before any flyctl call.");
    expect(dry.err).not.toContain("REFUSED:");
  });

  it("operator pin unset on a staging run: the fetched key is staged, and the log calls it what it is", async () => {
    const r = await slate(LIVE, FIVE_GREEN);
    expect(r.code).toBe(0);
    expect(clerkKeyOf(r, "motebit-clerk-stg")).toEqual([`MOTEBIT_RELAY_PUBLIC_KEY=${RELAY_KEY}`]);
    expect(r.out).toContain(
      "clerk's relay key: the key above, fetched from the relay (trust on first use), not an operator pin (MOTEBIT_RELAY_PUBLIC_KEY is not set).",
    );
    expect(r.out).toContain("trust on first use: it is served by the relay it pins");
    expect(r.err).toBe("");
  });

  it("operator pin MISMATCH on a promotion: refused, zero flyctl calls, both keys named", async () => {
    // A stale staging key left exported in the shell, on a prod run.
    for (const env of [PROD, { ...LIVE, RELAY_URL: "https://relay.motebit.com" }]) {
      const r = await slate({ ...env, MOTEBIT_RELAY_PUBLIC_KEY: OPERATOR_PIN }, FIVE_GREEN);
      expectPinRefused(r, true);
      expect(r.err).toContain(
        "REFUSED: the operator's pin MOTEBIT_RELAY_PUBLIC_KEY (cdcdcdcd…cdcdcdcd) and the key the relay",
      );
      expect(r.err).toContain("serves (abababab…abababab) disagree.");
      expect(r.err).toContain("Do not deploy until one is corrected.");
    }
    // The readiness override does not carry a mismatched pin through.
    const overridden = await slate(
      {
        ...PROD,
        MOTEBIT_RELAY_PUBLIC_KEY: OPERATOR_PIN,
        [PROMOTION_READINESS_OVERRIDE_ENV]: "relay key rotation in progress",
      },
      ONE_RED,
    );
    expectPinRefused(overridden, true);
    // A prod DRY run reports what a real run would do, and refuses nothing.
    const dry = await slate({ TARGET: "prod", MOTEBIT_RELAY_PUBLIC_KEY: OPERATOR_PIN }, FIVE_GREEN);
    expect(dry.code).toBe(0);
    expect(dry.flyctl).toEqual([]);
    expect(dry.err).toContain("disagree. A real run (RUN=1) would REFUSE here");
  });

  it("operator pin MISMATCH on a staging run: warned loudly, proceeds with the operator's value", async () => {
    const r = await slate({ ...LIVE, MOTEBIT_RELAY_PUBLIC_KEY: OPERATOR_PIN }, FIVE_GREEN);
    expect(r.code).toBe(0);
    expect(clerkKeyOf(r, "motebit-clerk-stg")).toEqual([
      `MOTEBIT_RELAY_PUBLIC_KEY=${OPERATOR_PIN}`,
    ]);
    expect(r.err).toContain(
      "!!! WARNING: the operator's pin MOTEBIT_RELAY_PUBLIC_KEY (cdcdcdcd…cdcdcdcd) and the key the relay",
    );
    expect(r.err).toContain("PROCEEDS and stages the clerk the OPERATOR's pin");
    expect(r.err).not.toContain("REFUSED");
  });

  it("operator pin that is not 64 hex characters: refused on staging and prod alike, value not echoed", async () => {
    for (const bad of [
      "not-a-key",
      "ab".repeat(31),
      "ab".repeat(33),
      `${"ab".repeat(31)}zz`,
      "0x" + "ab".repeat(32),
    ]) {
      for (const [env, promotion] of [
        [LIVE, false],
        [PROD, true],
      ] as const) {
        const r = await slate({ ...env, MOTEBIT_RELAY_PUBLIC_KEY: bad }, FIVE_GREEN);
        expectPinRefused(r, promotion);
        expect(r.err).toContain(
          `REFUSED: MOTEBIT_RELAY_PUBLIC_KEY is set but is not a relay public key (64 hex characters; got ${bad.length} characters).`,
        );
        expect(r.err).not.toContain(bad);
      }
    }
  });

  it("operator pin of whitespace only behaves as unset: the fetched key is staged, nothing warned", async () => {
    // On a staging run. (On a promotion, unset refuses: the test above.)
    for (const blank of [" ", "\t", " \n "]) {
      const r = await slate({ ...LIVE, MOTEBIT_RELAY_PUBLIC_KEY: blank }, FIVE_GREEN);
      expect(r.code).toBe(0);
      expect(clerkKeyOf(r, "motebit-clerk-stg")).toEqual([`MOTEBIT_RELAY_PUBLIC_KEY=${RELAY_KEY}`]);
      expect(r.out).toContain("not an operator pin (MOTEBIT_RELAY_PUBLIC_KEY is not set)");
      expect(r.err).toBe("");
    }
  });

  it("operator pin in upper case or padded: normalised, matches, staged lower-case", async () => {
    for (const spelled of [
      RELAY_KEY.toUpperCase(),
      ` ${RELAY_KEY}\n`,
      `  ${RELAY_KEY.toUpperCase()} `,
    ]) {
      const r = await slate({ ...PROD, MOTEBIT_RELAY_PUBLIC_KEY: spelled }, FIVE_GREEN);
      expect(r.code).toBe(0);
      expect(clerkKeyOf(r, "motebit-clerk")).toEqual([`MOTEBIT_RELAY_PUBLIC_KEY=${RELAY_KEY}`]);
      expect(r.out).toContain("which matches the fetched key above");
      expect(r.err).toBe("");
    }
  });

  it("the Solana RPC URL is passed through when set and not staged when unset", async () => {
    expect((await clerkSecrets({})).filter((p) => p.startsWith("MOTEBIT_SOLANA_RPC_URL="))).toEqual(
      [],
    );
    expect(
      (await clerkSecrets({ MOTEBIT_SOLANA_RPC_URL: "https://rpc.example.test" })).filter((p) =>
        p.startsWith("MOTEBIT_SOLANA_RPC_URL="),
      ),
    ).toEqual(["MOTEBIT_SOLANA_RPC_URL=https://rpc.example.test"]);
  });
});

// ---------------------------------------------------------------------------
// 3. the scripts as programs: a fake gh and a fake flyctl, nothing else on PATH
// ---------------------------------------------------------------------------

describe("the scripts as programs (fake gh, fake flyctl)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /**
   * A PATH directory holding only a fake `gh` (records its argv, prints
   * `ghAnswer`, or is absent) and a fake `flyctl` (records its argv).
   */
  function sandbox(ghAnswer: ConformanceRun[] | "absent" | "fails" | "old") {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "slate-readiness-")));
    dirs.push(dir);
    const script = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    };
    if (ghAnswer === "fails") {
      script("gh", `echo "$@" >> "${dir}/gh.calls"\necho "gh: not logged in" >&2\nexit 4`);
    } else if (ghAnswer === "old") {
      // A gh from before `attempt` was a `run list --json` field.
      script(
        "gh",
        `echo "$@" >> "${dir}/gh.calls"\necho 'Unknown JSON field: "attempt"' >&2\necho 'Available fields:' >&2\necho '  conclusion' >&2\nexit 1`,
      );
    } else if (ghAnswer !== "absent") {
      writeFileSync(join(dir, "gh.json"), JSON.stringify(ghAnswer));
      // Records its argv and every GIT_* variable it was started with.
      script(
        "gh",
        `echo "$@" >> "${dir}/gh.calls"\nenv | grep '^GIT_' >> "${dir}/gh-git-env.calls"\ncat "${dir}/gh.json"`,
      );
    }
    script("flyctl", `echo "$@" >> "${dir}/flyctl.calls"`);
    const calls = (name: string): string[] =>
      existsSync(join(dir, `${name}.calls`))
        ? readFileSync(join(dir, `${name}.calls`), "utf8")
            .trim()
            .split("\n")
        : [];
    const runScript = (file: string, env: Record<string, string>) => {
      // As the operator runs them: through tsx (`npx tsx scripts/<file>`).
      const r = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", file)], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60_000,
        // Only the fakes and the base system: no real gh, no real flyctl. A
        // relay URL nothing listens on, so even a run the gate wrongly let
        // through could reach no network.
        env: { PATH: `${dir}:/bin:/usr/bin`, RELAY_URL: "http://127.0.0.1:1", ...env },
      });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };
    return { dir, calls, runScript };
  }

  const GH_ARGV =
    "run list --repo motebit/motebit --workflow archetype-conformance.yml --event schedule --limit 5 --json attempt,conclusion,createdAt,event,headBranch,status,url";
  const PROD_LIVE = { ...LIVE, TARGET: "prod" };
  // The programs read the real clock, so their histories are dated against it.
  const LIVE_GREEN = liveHistory("success", "success", "success", "success", "success");
  const LIVE_RED = liveHistory("success", "success", "failure", "success", "success");
  const LIVE_THIN = liveHistory("success", "success", "success");

  it("check-promotion-ready: asks gh for the last 5 SCHEDULED conformance runs; exit 0 ready, 1 not ready / thin / unreadable", () => {
    const green = sandbox(LIVE_GREEN);
    const ready = green.runScript("check-promotion-ready.ts", {});
    expect(ready.code).toBe(0);
    expect(ready.out).toContain("READY — the slate's prod command is");
    expect(green.calls("gh")).toEqual([GH_ARGV]);

    const red = sandbox(LIVE_RED).runScript("check-promotion-ready.ts", {});
    expect(red.code).toBe(1);
    expect(red.err).toContain("1/5 of the last scheduled runs did not succeed:");

    const thin = sandbox(LIVE_THIN).runScript("check-promotion-ready.ts", {});
    expect(thin.code).toBe(1);
    expect(thin.err).toContain("only 3/5 scheduled run(s) on record.");

    // Five greens dated 2020, against the real clock: stale.
    const stale = sandbox(
      FIVE_GREEN.map((r) => ({ ...r, createdAt: r.createdAt.replace("2026", "2020") })),
    );
    const old = stale.runScript("check-promotion-ready.ts", {});
    expect(old.code).toBe(1);
    expect(old.err).toContain("hours old; the limit is 48.");

    for (const broken of ["absent", "fails"] as const) {
      const r = sandbox(broken).runScript("check-promotion-ready.ts", {});
      expect(r.code).toBe(1);
      expect(r.err).toContain("NOT READY — unknown history is not green history.");
    }
  });

  it("the gh read names the repository and inherits no GIT_* variable, whatever the environment says", () => {
    const box = sandbox(LIVE_GREEN);
    const r = box.runScript("check-promotion-ready.ts", {
      GH_REPO: "someone/fork",
      GIT_DIR: "/nonexistent/.git",
      GIT_WORK_TREE: "/nonexistent",
    });
    expect(r.code).toBe(0);
    expect(box.calls("gh")).toEqual([GH_ARGV]);
    expect(box.calls("gh")[0]).toContain("--repo motebit/motebit ");
    expect(box.calls("gh-git-env")).toEqual([""]);
  });

  it("the slate's prod command, a red run on record: exit 1, flyctl never run", () => {
    const box = sandbox(LIVE_RED);
    const r = box.runScript("deploy-archetype-slate.ts", PROD_LIVE);
    expect(r.code).toBe(1);
    expect(r.err).toContain("REFUSED: the archetype slate is not ready for production.");
    expect(r.err).toContain(LIVE_RED[2]!.url);
    expect(box.calls("gh")).toEqual([GH_ARGV]);
    expect(box.calls("flyctl")).toEqual([]);
  });

  it("check-promotion-ready run WITHOUT the .ts extension still checks: exit 1 on a red history, 0 on green", () => {
    const red = sandbox(LIVE_RED);
    const r = red.runScript("check-promotion-ready", {});
    expect(r.err).toContain("1/5 of the last scheduled runs did not succeed:");
    expect(r.code).toBe(1);
    expect(red.calls("gh")).toEqual([GH_ARGV]);

    const green = sandbox(LIVE_GREEN);
    const ok = green.runScript("check-promotion-ready", {});
    expect(ok.out).toContain("READY — the slate's prod command is");
    expect(ok.code).toBe(0);
  });

  it("both scripts run by a .js name (tsx maps it to the .ts file) still run: exit 1 on a red history", () => {
    const check = sandbox(LIVE_RED);
    const c = check.runScript("check-promotion-ready.js", {});
    expect(c.err).toContain("1/5 of the last scheduled runs did not succeed:");
    expect(c.code).toBe(1);

    const box = sandbox(LIVE_RED);
    const s = box.runScript("deploy-archetype-slate.js", PROD_LIVE);
    expect(s.err).toContain("REFUSED: the archetype slate is not ready for production.");
    expect(s.code).toBe(1);
    expect(box.calls("flyctl")).toEqual([]);
  });

  it("an older gh that rejects the `attempt` field: not ready, and both scripts say to upgrade gh", () => {
    const check = sandbox("old").runScript("check-promotion-ready.ts", {});
    expect(check.code).toBe(1);
    expect(check.err).toContain('Unknown JSON field: "attempt"');
    expect(check.err).toContain("Fix: Upgrade gh (`gh --version`)");
    expect(check.err).not.toContain("gh auth status");

    const box = sandbox("old");
    const s = box.runScript("deploy-archetype-slate.ts", PROD_LIVE);
    expect(s.code).toBe(1);
    expect(s.err).toContain("REFUSED: the archetype slate is not ready for production.");
    expect(s.err).toContain("Upgrade gh (`gh --version`)");
    expect(box.calls("flyctl")).toEqual([]);
  });

  it("the slate's prod command run WITHOUT the .ts extension still gates: exit 1, flyctl never run", () => {
    const box = sandbox(LIVE_RED);
    const r = box.runScript("deploy-archetype-slate", PROD_LIVE);
    expect(r.err).toContain("REFUSED: the archetype slate is not ready for production.");
    expect(r.code).toBe(1);
    expect(box.calls("gh")).toEqual([GH_ARGV]);
    expect(box.calls("flyctl")).toEqual([]);
  });

  it("an entry that cannot be resolved is never read as 'imported': both scripts exit non-zero and say why", () => {
    for (const file of ["check-promotion-ready.ts", "deploy-archetype-slate.ts"]) {
      const box = sandbox(LIVE_GREEN);
      const r = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `process.argv[1] = "/nonexistent/entry"; await import(${JSON.stringify(join(ROOT, "scripts", file))}); console.log("did nothing");`,
        ],
        { cwd: ROOT, encoding: "utf8", timeout: 60_000, env: { PATH: `${box.dir}:/bin:/usr/bin` } },
      );
      expect(r.stdout).not.toContain("did nothing");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("cannot tell whether this script is being run or imported");
      expect(box.calls("flyctl")).toEqual([]);
    }
  });

  it("the slate's prod command refuses a mistyped TARGET as a program: exit 1, nothing run", () => {
    const box = sandbox(LIVE_GREEN);
    const r = box.runScript("deploy-archetype-slate.ts", { ...LIVE, TARGET: "PROD" });
    expect(r.code).toBe(1);
    expect(r.err).toContain('REFUSED: TARGET="PROD" is not a target.');
    expect(box.calls("gh")).toEqual([]);
    expect(box.calls("flyctl")).toEqual([]);
  });

  it("the slate's prod command, gh missing or failing: exit 1, flyctl never run", () => {
    for (const broken of ["absent", "fails"] as const) {
      const box = sandbox(broken);
      const r = box.runScript("deploy-archetype-slate.ts", PROD_LIVE);
      expect(r.code).toBe(1);
      expect(r.err).toContain("REFUSED: the archetype slate is not ready for production.");
      expect(r.err).toContain("gh auth status");
      expect(box.calls("flyctl")).toEqual([]);
    }
  });

  it("the real command runner returns stdout, stays quiet when asked, and throws on a non-zero exit", () => {
    const { exec } = realEffects();
    expect(exec("/bin/echo", ["deployed"])).toBe("deployed\n");
    expect(exec("/bin/echo", ["status"], { quiet: true })).toBe("");
    // `flyctl status` on an app that does not exist: the ceremony reads the throw as "create it".
    expect(() => exec("/bin/sh", ["-c", "exit 1"], { quiet: true })).toThrow();
  });

  it("importing either script runs nothing: no gh, no flyctl, no exit", () => {
    // This file imported both at the top and is still running; the fakes
    // prove the import itself spawned nothing.
    const box = sandbox(FIVE_GREEN);
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(join(ROOT, "scripts", "check-promotion-ready.ts"))});` +
          `await import(${JSON.stringify(join(ROOT, "scripts", "deploy-archetype-slate.ts"))});` +
          `console.log("imported");`,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 60_000,
        env: { PATH: `${box.dir}:/bin:/usr/bin`, RUN: "1", TARGET: "prod" },
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("imported");
    expect(box.calls("gh")).toEqual([]);
    expect(box.calls("flyctl")).toEqual([]);
  });
});
