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

/** A scheduled run, `daysAgo` days before 2026-11-15. */
function run(daysAgo: number, conclusion: string | null, event = "schedule"): ConformanceRun {
  const day = String(15 - daysAgo).padStart(2, "0");
  return {
    conclusion,
    createdAt: `2026-11-${day}T14:17:00Z`,
    event,
    url: `https://github.example/runs/${1000 - daysAgo}`,
  };
}
/** Newest first, as `gh run list` answers. */
const history = (...conclusions: Array<string | null>): ConformanceRun[] =>
  conclusions.map((c, i) => run(i, c));

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
    readPromotionReadiness({
      listRuns: (limit) => {
        asked.push(limit);
        return FIVE_GREEN;
      },
    });
    expect(asked).toEqual([5]);
  });

  it("five green scheduled runs: ready, with the run window", () => {
    const result = readPromotionReadiness({ listRuns: lister(FIVE_GREEN) });
    expect(result).toEqual({ ready: true, required: 5, runs: FIVE_GREEN });
  });

  it("gh unreadable (the lister throws): not ready, gh-unreadable", () => {
    const result = readPromotionReadiness({
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
      const result = readPromotionReadiness({ listRuns: lister(answer) });
      expect(result.ready).toBe(false);
      expect(result.ready === false && result.reason).toBe("gh-unreadable");
    }
  });

  it("a required count that is not a positive integer: not ready, the lister never asked", () => {
    for (const required of [0, -1, 2.5, Number.NaN]) {
      let asked = 0;
      const result = readPromotionReadiness({
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
    const result = readPromotionReadiness({ listRuns: lister(THIN) });
    expect(result).toEqual({ ready: false, reason: "thin-history", required: 5, runs: THIN });
    expect(readPromotionReadiness({ listRuns: lister([]) })).toMatchObject({
      ready: false,
      reason: "thin-history",
    });
  });

  it("a failed, cancelled or pending run in the window: not ready, not-all-green, naming the runs", () => {
    for (const conclusion of ["failure", "cancelled", "timed_out", "skipped", null]) {
      const rows = history("success", conclusion, "success", "success", "success");
      const result = readPromotionReadiness({ listRuns: lister(rows) });
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
    const dispatch = run(0, "success", "workflow_dispatch");
    const four = history("success", "success", "success", "success");
    const result = readPromotionReadiness({ listRuns: () => [dispatch, ...four] });
    expect(result).toMatchObject({ ready: false, reason: "thin-history", runs: four });
  });

  it("only the newest `required` runs count: an older red beyond the window does not block", () => {
    const rows = history("success", "success", "success", "success", "success", "failure");
    expect(readPromotionReadiness({ listRuns: () => rows })).toEqual({
      ready: true,
      required: 5,
      runs: rows.slice(0, 5),
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
      ].join("\n"),
    );
  });

  it("a pending run reads `pending`: exit 1", () => {
    const r = cli({}, history(null, "success", "success", "success", "success"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("  pending  ");
  });

  it("thin history: exit 1", () => {
    const r = cli({}, THIN);
    expect(r.code).toBe(1);
    expect(r.err).toBe(
      [
        "check-promotion-ready: only 3/5 scheduled run(s) on record.",
        "NOT READY — thin history reads not-ready by design (new workflow / retention horizon / rename).",
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
  const PROD = { ...LIVE, TARGET: "prod" };

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
    expect(red.out).toContain("A real prod run (RUN=1 TARGET=prod) would REFUSE here");
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
  function sandbox(ghAnswer: ConformanceRun[] | "absent" | "fails") {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "slate-readiness-")));
    dirs.push(dir);
    const script = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    };
    if (ghAnswer === "fails") {
      script("gh", `echo "$@" >> "${dir}/gh.calls"\necho "gh: not logged in" >&2\nexit 4`);
    } else if (ghAnswer !== "absent") {
      writeFileSync(join(dir, "gh.json"), JSON.stringify(ghAnswer));
      script("gh", `echo "$@" >> "${dir}/gh.calls"\ncat "${dir}/gh.json"`);
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
    "run list --workflow archetype-conformance.yml --event schedule --limit 5 --json conclusion,createdAt,event,url";
  const PROD_LIVE = { ...LIVE, TARGET: "prod" };

  it("check-promotion-ready: asks gh for the last 5 SCHEDULED conformance runs; exit 0 ready, 1 not ready / thin / unreadable", () => {
    const green = sandbox(FIVE_GREEN);
    const ready = green.runScript("check-promotion-ready.ts", {});
    expect(ready.code).toBe(0);
    expect(ready.out).toContain("READY — the slate's prod command is");
    expect(green.calls("gh")).toEqual([GH_ARGV]);

    const red = sandbox(ONE_RED).runScript("check-promotion-ready.ts", {});
    expect(red.code).toBe(1);
    expect(red.err).toContain("1/5 of the last scheduled runs did not succeed:");

    const thin = sandbox(THIN).runScript("check-promotion-ready.ts", {});
    expect(thin.code).toBe(1);
    expect(thin.err).toContain("only 3/5 scheduled run(s) on record.");

    for (const broken of ["absent", "fails"] as const) {
      const r = sandbox(broken).runScript("check-promotion-ready.ts", {});
      expect(r.code).toBe(1);
      expect(r.err).toContain("NOT READY — unknown history is not green history.");
    }
  });

  it("the slate's prod command, a red run on record: exit 1, flyctl never run", () => {
    const box = sandbox(ONE_RED);
    const r = box.runScript("deploy-archetype-slate.ts", PROD_LIVE);
    expect(r.code).toBe(1);
    expect(r.err).toContain("REFUSED: the archetype slate is not ready for production.");
    expect(r.err).toContain(ONE_RED[2]!.url);
    expect(box.calls("gh")).toEqual([GH_ARGV]);
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
