/**
 * molecule-prod-gate — the decision that stands between main and a molecule's
 * production Fly app (scripts/molecule-prod-gate.ts), and the seven workflows
 * that must route every deploy through it.
 *
 * Three halves:
 *   1. the decision, against scripted Actions API answers (a fake clock, so
 *      every wait and timeout is exact and instant);
 *   2. the CLI as the workflow runs it (outputs, exit codes, the `gh api`
 *      adapter);
 *   3. the REAL workflow files: every molecule prod deploy needs the gate,
 *      sits behind `production`, checks out the pinned sha, re-checks before
 *      `flyctl deploy`, serializes per service, and the only no-staging
 *      caller is code-review.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  CI_WORKFLOW,
  STAGING_WORKFLOW,
  decideGate,
  ghDeps,
  runCli,
  type GateDeps,
  type GateMode,
  type RunInfo,
} from "../molecule-prod-gate.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHA = "a".repeat(40);
const NEWER = "b".repeat(40);
const MIN = 60_000;
const RUN_ID = 5000;
/** A run of the same deploy workflow, for the newer head, created after RUN_ID. */
const NEWER_RUN: RunInfo = { id: 5001, status: "queued", conclusion: null };

type Answer = RunInfo | null | Error;
/** A run answer per poll; the last one repeats. */
type Script = Answer[];

function run(status: string, conclusion: string | null = null, id = 1): RunInfo {
  return { id, status, conclusion, html_url: `https://example.invalid/runs/${id}` };
}
const OK = run("completed", "success");

interface Fake {
  deps: GateDeps;
  calls: { ci: number; staging: number; head: number; newer: number };
  newerArgs: [string, string, number][];
}

/** `newer`: answers for "is there a newer run of this deploy workflow" (default: yes). */
function fake(
  ci: Script,
  staging: Script,
  head: (string | Error)[] = [SHA],
  newer: Script = [NEWER_RUN],
): Fake {
  let t = 0;
  const calls = { ci: 0, staging: 0, head: 0, newer: 0 };
  const newerArgs: [string, string, number][] = [];
  const pick = <T>(xs: T[], i: number): T => xs[Math.min(i, xs.length - 1)] as T;
  return {
    calls,
    newerArgs,
    deps: {
      async newerRun(workflow, sha, runId) {
        newerArgs.push([workflow, sha, runId]);
        const a = pick(newer, calls.newer++);
        if (a instanceof Error) throw a;
        return a;
      },
      async latestRun(workflow) {
        const a = workflow === CI_WORKFLOW ? pick(ci, calls.ci++) : pick(staging, calls.staging++);
        if (workflow !== CI_WORKFLOW && workflow !== STAGING_WORKFLOW)
          throw new Error(`unexpected workflow ${workflow}`);
        if (a instanceof Error) throw a;
        return a;
      },
      async mainHead() {
        const h = pick(head, calls.head++);
        if (h instanceof Error) throw h;
        return h;
      },
      async sleep(ms) {
        t += ms;
      },
      now: () => t,
    },
  };
}

function gate(f: Fake, mode: GateMode = "wait", stagingLeg = true, sha = SHA) {
  return decideGate(f.deps, {
    sha,
    service: "clerk",
    runId: RUN_ID,
    stagingLeg,
    mode,
    pollMs: 15_000,
  });
}

describe("decision: (a) CI on the exact sha", () => {
  it("CI success, head of main, staging success: deploy", async () => {
    const d = await gate(fake([OK], [OK]));
    expect(d.outcome).toBe("deploy");
    expect(d.deploy).toBe(true);
  });

  it("CI in progress is waited for, then success: deploy", async () => {
    const f = fake([run("queued"), run("in_progress"), run("in_progress"), OK], [OK]);
    const d = await gate(f);
    expect(d.outcome).toBe("deploy");
    expect(f.calls.ci).toBe(4);
  });

  it("CI failure: no deploy", async () => {
    const d = await gate(fake([run("completed", "failure")], [OK]));
    expect(d.outcome).toBe("fail");
    expect(d.deploy).toBe(false);
    expect(d.reason).toContain("failure");
  });

  it("CI cancelled: no deploy", async () => {
    const d = await gate(fake([run("in_progress"), run("completed", "cancelled")], [OK]));
    expect(d.outcome).toBe("fail");
    expect(d.deploy).toBe(false);
  });

  it("CI never concludes within the timeout: no deploy", async () => {
    const f = fake([run("in_progress")], [OK]);
    const d = await decideGate(f.deps, {
      sha: SHA,
      service: "clerk",
      runId: RUN_ID,
      stagingLeg: true,
      mode: "wait",
      pollMs: MIN,
      ciTimeoutMs: 10 * MIN,
    });
    expect(d.outcome).toBe("fail");
    expect(d.reason).toMatch(/did not conclude/);
    expect(f.calls.ci).toBe(11);
    expect(f.calls.head).toBe(0);
  });

  it("no CI run for the sha at all: times out, no deploy", async () => {
    const d = await decideGate(fake([null], [OK]).deps, {
      sha: SHA,
      service: "clerk",
      runId: RUN_ID,
      stagingLeg: true,
      mode: "wait",
      ciTimeoutMs: 2 * MIN,
    });
    expect(d.outcome).toBe("fail");
    expect(d.reason).toContain("no CI run found");
  });

  it("a transient API error while waiting is not evidence: keeps polling", async () => {
    const d = await gate(fake([new Error("502"), run("in_progress"), OK], [OK]));
    expect(d.outcome).toBe("deploy");
  });

  it("a malformed sha is refused before any lookup", async () => {
    const f = fake([OK], [OK]);
    const d = await gate(f, "wait", true, "main");
    expect(d.outcome).toBe("fail");
    expect(f.calls.ci).toBe(0);
  });
});

describe("decision: (b) the sha must still be the head of main", () => {
  it("superseded after CI: no deploy, outcome superseded (not fail), explained", async () => {
    const f = fake([OK], [OK], [NEWER]);
    const d = await gate(f);
    expect(d.outcome).toBe("superseded");
    expect(d.deploy).toBe(false);
    expect(d.summary).toContain("SUPERSEDED — nothing was deployed, and this is not a failure");
    expect(d.summary).toContain("A STRANDED or FAILED gate, by");
    expect(f.calls.staging).toBe(0);
  });

  it("superseded while staging ran: no deploy", async () => {
    const d = await gate(fake([OK], [run("in_progress"), OK], [SHA, NEWER]));
    expect(d.outcome).toBe("superseded");
    expect(d.deploy).toBe(false);
  });

  it("staging cancelled because main moved: superseded, not fail", async () => {
    const d = await gate(fake([OK], [run("completed", "cancelled")], [SHA, NEWER]));
    expect(d.outcome).toBe("superseded");
  });

  it("the head of main cannot be read: fail closed", async () => {
    const d = await gate(fake([OK], [OK], [new Error("boom")]));
    expect(d.outcome).toBe("fail");
    expect(d.deploy).toBe(false);
  });

  it("CI red on a superseded sha still reports the CI failure", async () => {
    const d = await gate(fake([run("completed", "failure")], [OK], [NEWER]));
    expect(d.outcome).toBe("fail");
  });
});

describe("decision: superseded only when a newer deploy run exists, else STRANDED", () => {
  it("a newer run of this deploy workflow exists: superseded (green), and it asked the right question", async () => {
    const f = fake([OK], [OK], [NEWER], [NEWER_RUN]);
    const d = await gate(f);
    expect(d.outcome).toBe("superseded");
    expect(f.newerArgs[0]).toEqual(["deploy-clerk.yml", SHA, RUN_ID]);
    expect(d.checks.some((c) => c.result.startsWith("yes:"))).toBe(true);
  });

  it("no newer run within the grace (main moved via out-of-path commits): STRANDED, red, with the dispatch repair", async () => {
    const f = fake([OK], [OK], [NEWER], [null]);
    const d = await gate(f);
    expect(d.outcome).toBe("stranded");
    expect(d.deploy).toBe(false);
    expect(d.reason).toContain(`main moved past ${SHA} via commits outside this workflow's paths`);
    expect(d.reason).toContain(`prod for clerk is not on ${SHA}`);
    expect(d.reason).toContain("gh workflow run deploy-clerk.yml --ref main");
    // clerk has a staging leg: the staging dispatch comes FIRST (the stranding head never ran staging).
    const st = d.reason.indexOf(`gh workflow run ${STAGING_WORKFLOW} --ref main`);
    expect(st).toBeGreaterThan(-1);
    expect(st).toBeLessThan(d.reason.indexOf("gh workflow run deploy-clerk.yml --ref main"));
    expect(d.reason).toContain("wait until that run is green for the current head");
    expect(d.annotations.join("\n")).toContain("::error title=Production deploy stranded (clerk)");
    expect(d.summary).toContain("STRANDED — not deployed, and no newer run will deploy");
    // The bounded retry that absorbs run-creation lag: 2 min at 15 s.
    expect(f.calls.newer).toBe(9);
  });

  it("stranded code-review (no staging leg): the repair is the deploy dispatch alone, no staging dispatch", async () => {
    const f = fake([OK], [null], [NEWER], [null]);
    const d = await decideGate(f.deps, {
      sha: SHA,
      service: "code-review",
      runId: RUN_ID,
      stagingLeg: false,
      mode: "wait",
    });
    expect(d.outcome).toBe("stranded");
    expect(d.reason).toContain("gh workflow run deploy-code-review.yml --ref main");
    expect(d.reason).not.toContain(STAGING_WORKFLOW);
    expect(f.newerArgs[0]?.[0]).toBe("deploy-code-review.yml");
  });

  it("a newer run that appears within the grace counts: superseded", async () => {
    const d = await gate(fake([OK], [OK], [NEWER], [null, null, NEWER_RUN]));
    expect(d.outcome).toBe("superseded");
  });

  it("the newer-run lookup errors: fail (red), never green", async () => {
    const d = await gate(fake([OK], [OK], [NEWER], [new Error("502")]));
    expect(d.outcome).toBe("fail");
    expect(d.deploy).toBe(false);
  });

  it("staging superseded with no newer run: stranded, not superseded", async () => {
    const d = await gate(fake([OK], [run("completed", "cancelled")], [SHA, NEWER], [null]));
    expect(d.outcome).toBe("stranded");
  });

  it("superseded at the final head check with no newer run: stranded", async () => {
    const d = await gate(fake([OK], [OK], [SHA, NEWER], [null]));
    expect(d.outcome).toBe("stranded");
  });

  it("approval granted after main moved via an out-of-path commit: recheck says stranded, no deploy", async () => {
    const d = await gate(fake([OK], [OK], [NEWER], [null]), "recheck");
    expect(d.outcome).toBe("stranded");
    expect(d.deploy).toBe(false);
  });
});

describe("decision: CI cancelled because main moved is supersession, not a CI failure", () => {
  it("CI cancelled on a sha main has left, newer run exists: superseded (green)", async () => {
    const d = await gate(fake([run("completed", "cancelled")], [OK], [NEWER]));
    expect(d.outcome).toBe("superseded");
    expect(d.reason).toContain("was cancelled because main moved on");
  });

  it("CI cancelled on a sha main has left, no newer run: stranded", async () => {
    const d = await gate(fake([run("completed", "cancelled")], [OK], [NEWER], [null]));
    expect(d.outcome).toBe("stranded");
  });

  it("CI cancelled and the head cannot be read: fail", async () => {
    const d = await gate(fake([run("completed", "cancelled")], [OK], [new Error("x")]));
    expect(d.outcome).toBe("fail");
  });

  it("CI timed_out on a superseded sha stays a CI failure", async () => {
    const d = await gate(fake([run("completed", "timed_out")], [OK], [NEWER]));
    expect(d.outcome).toBe("fail");
  });
});

describe("decision: (c) staging on the exact sha", () => {
  it("staging success: deploy", async () => {
    const d = await gate(fake([OK], [run("in_progress"), OK]));
    expect(d.outcome).toBe("deploy");
  });

  it("staging missing for the sha: FAIL with the repair instruction", async () => {
    const f = fake([OK], [null]);
    const d = await gate(f);
    expect(d.outcome).toBe("fail");
    expect(d.deploy).toBe(false);
    expect(d.reason).toContain("Staging is never silently skipped");
    const all = d.annotations.join("\n") + d.summary;
    expect(all).toContain(`gh workflow run ${STAGING_WORKFLOW} --ref main`);
    expect(all).toContain("re-run this deploy workflow's failed jobs");
    // It waited the grace for the run to appear, then gave up (not the full staging budget).
    expect(f.calls.staging).toBe(9);
  });

  it("a staging run that appears within the grace counts", async () => {
    const d = await gate(fake([OK], [null, null, run("queued"), OK]));
    expect(d.outcome).toBe("deploy");
  });

  it("staging failed: no deploy, repair printed", async () => {
    const d = await gate(fake([OK], [run("completed", "failure")]));
    expect(d.outcome).toBe("fail");
    expect(d.annotations.join("\n")).toContain("Repair: re-run staging");
  });

  it("staging never concludes: no deploy", async () => {
    const d = await decideGate(fake([OK], [run("in_progress")]).deps, {
      sha: SHA,
      service: "clerk",
      runId: RUN_ID,
      stagingLeg: true,
      mode: "wait",
      stagingTimeoutMs: 5 * MIN,
    });
    expect(d.outcome).toBe("fail");
    expect(d.reason).toMatch(/Staging did not conclude/);
  });

  it("staging_leg false: staging not required (never even queried), loud notice printed", async () => {
    const f = fake([OK], [null]);
    const d = await gate(f, "wait", false);
    expect(d.outcome).toBe("deploy");
    expect(f.calls.staging).toBe(0);
    expect(d.annotations.join("\n")).toContain("NO STAGING LEG");
    expect(d.summary).toContain("**NO** (explicit exception)");
    expect(d.summary).toContain("NOT REQUIRED — explicit no-staging-leg exception");
    expect(d.summary).toContain("add a staging leg (recommended)");
  });

  it("staging_leg true never prints the exception notice", async () => {
    const d = await gate(fake([OK], [OK]));
    expect(d.annotations.join("\n")).not.toContain("NO STAGING LEG");
  });
});

describe("decision: the post-approval re-check (recheck mode) never waits", () => {
  it("approval granted after main moved: no deploy", async () => {
    const d = await gate(fake([OK], [OK], [NEWER]), "recheck");
    expect(d.outcome).toBe("superseded");
    expect(d.deploy).toBe(false);
  });

  it("everything still green: deploy", async () => {
    const d = await gate(fake([OK], [OK]), "recheck");
    expect(d.outcome).toBe("deploy");
  });

  it("CI no longer a concluded success (re-run in progress): no deploy, no waiting", async () => {
    const f = fake([run("in_progress"), OK], [OK]);
    const d = await gate(f, "recheck");
    expect(d.outcome).toBe("fail");
    expect(f.calls.ci).toBe(1);
  });

  it("staging gone missing: no deploy, no grace wait", async () => {
    const f = fake([OK], [null, OK]);
    const d = await gate(f, "recheck");
    expect(d.outcome).toBe("fail");
    expect(f.calls.staging).toBe(1);
  });

  it("an API error during the re-check: fail closed", async () => {
    expect((await gate(fake([new Error("x")], [OK]), "recheck")).outcome).toBe("fail");
    expect((await gate(fake([OK], [new Error("x")]), "recheck")).outcome).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// CLI

function env(over: Record<string, string | undefined> = {}) {
  return {
    GATE_MODE: "wait",
    GATE_SHA: SHA,
    GATE_REPO: "motebit/motebit",
    GATE_SERVICE: "clerk",
    GATE_STAGING_LEG: "true",
    GITHUB_RUN_ID: String(RUN_ID),
    ...over,
  };
}

async function cli(e: Record<string, string | undefined>, f: Fake) {
  let out = "";
  let summary = "";
  const logs: string[] = [];
  const r = await runCli({
    env: e,
    deps: f.deps,
    log: (l) => logs.push(l),
    writeOutput: (t) => (out += t),
    writeSummary: (t) => (summary += t),
  });
  return { ...r, out, summary, logs };
}

describe("CLI: what the workflow sees", () => {
  it("deploy: exit 0, deploy=true and the pinned sha", async () => {
    const r = await cli(env(), fake([OK], [OK]));
    expect(r.code).toBe(0);
    expect(r.out).toBe(`deploy=true\noutcome=deploy\nsha=${SHA}\n`);
  });

  it("superseded: exit 0 (not red) but deploy=false", async () => {
    const r = await cli(env(), fake([OK], [OK], [NEWER]));
    expect(r.code).toBe(0);
    expect(r.out).toContain("deploy=false\noutcome=superseded\n");
  });

  it("fail: exit 1, deploy=false, error annotation", async () => {
    const r = await cli(env(), fake([run("completed", "failure")], [OK]));
    expect(r.code).toBe(1);
    expect(r.out).toContain("deploy=false\noutcome=fail\n");
    expect(r.logs.some((l) => l.startsWith("::error"))).toBe(true);
  });

  it("GATE_STAGING_LEG missing or not exactly true/false: refused, never defaulted", async () => {
    for (const v of [undefined, "", "yes", "TRUE"]) {
      const r = await cli(env({ GATE_STAGING_LEG: v }), fake([OK], [OK]));
      expect(r.code, String(v)).toBe(1);
      expect(r.out).toBe("deploy=false\noutcome=fail\n");
    }
  });

  it("stranded: exit 1 (red), deploy=false, outcome=stranded", async () => {
    const r = await cli(env(), fake([OK], [OK], [NEWER], [null]));
    expect(r.code).toBe(1);
    expect(r.out).toContain("deploy=false\noutcome=stranded\n");
  });

  it("GITHUB_RUN_ID must be the numeric run id", async () => {
    for (const v of [undefined, "", "abc", "0"]) {
      const r = await cli(env({ GITHUB_RUN_ID: v }), fake([OK], [OK]));
      expect(r.code, String(v)).toBe(1);
    }
  });

  it("the gh adapter's newer-run lookup: same workflow on main, push or dispatch, another sha, a later run id", async () => {
    const seen: string[][] = [];
    const deps = ghDeps("o/r", (args) => {
      seen.push(args);
      return JSON.stringify({
        workflow_runs: [
          { id: 4000, head_sha: NEWER, event: "push", status: "completed", conclusion: "success" },
          {
            id: 5002,
            head_sha: SHA,
            event: "workflow_dispatch",
            status: "queued",
            conclusion: null,
          },
          { id: 5003, head_sha: NEWER, event: "schedule", status: "queued", conclusion: null },
          { id: 5004, head_sha: NEWER, event: "push", status: "queued", conclusion: null },
          {
            id: 5005,
            head_sha: NEWER,
            event: "workflow_dispatch",
            status: "queued",
            conclusion: null,
          },
        ],
      });
    });
    expect((await deps.newerRun("deploy-clerk.yml", SHA, RUN_ID))?.id).toBe(5005);
    expect(seen[0]).toEqual(
      expect.arrayContaining(["repos/o/r/actions/workflows/deploy-clerk.yml/runs", "branch=main"]),
    );
    const none = ghDeps("o/r", () =>
      JSON.stringify({
        workflow_runs: [
          { id: 4000, head_sha: NEWER, event: "push", status: "completed", conclusion: "success" },
        ],
      }),
    );
    expect(await none.newerRun("deploy-clerk.yml", SHA, RUN_ID)).toBeNull();
  });

  it("GATE_MODE must be wait or recheck", async () => {
    expect((await cli(env({ GATE_MODE: "skip" }), fake([OK], [OK]))).code).toBe(1);
  });

  it("the gh adapter queries the exact sha on main and picks the newest run", async () => {
    const seen: string[][] = [];
    const deps = ghDeps("motebit/motebit", (args) => {
      seen.push(args);
      if (args[1] === "repos/motebit/motebit/git/ref/heads/main") return `${SHA}\n`;
      return JSON.stringify({
        workflow_runs: [
          {
            id: 1,
            head_sha: SHA,
            status: "completed",
            conclusion: "failure",
            created_at: "2026-11-14T10:00:00Z",
          },
          {
            id: 3,
            head_sha: NEWER,
            status: "completed",
            conclusion: "success",
            created_at: "2026-11-14T12:00:00Z",
          },
          {
            id: 2,
            head_sha: SHA,
            status: "completed",
            conclusion: "success",
            created_at: "2026-11-14T11:00:00Z",
          },
        ],
      });
    });
    const r = await deps.latestRun(STAGING_WORKFLOW, SHA);
    expect(r?.id).toBe(2);
    expect(seen[0]).toEqual(
      expect.arrayContaining([
        `repos/motebit/motebit/actions/workflows/${STAGING_WORKFLOW}/runs`,
        `head_sha=${SHA}`,
        "branch=main",
      ]),
    );
    expect(await deps.mainHead()).toBe(SHA);
  });

  it("the gh adapter returns null when no run exists for the sha", async () => {
    const deps = ghDeps("o/r", () => JSON.stringify({ workflow_runs: [] }));
    expect(await deps.latestRun(CI_WORKFLOW, SHA)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Manual dispatch: the same checks, the same approval, a pinned sha

describe("manual workflow_dispatch", () => {
  it("a dispatch that fails a check gives no deploy (gate fails, so the deploy job never runs)", async () => {
    const pre = await cli(env(), fake([OK], [null]));
    expect(pre.out).toContain("deploy=false");
    expect(pre.code).toBe(1);
  });

  it("a dispatch that passes every check and is approved deploys the pinned sha", async () => {
    const pre = await cli(env(), fake([OK], [OK]));
    expect(pre.out).toContain(`deploy=true\noutcome=deploy\nsha=${SHA}\n`);
    // After approval the deploy job re-checks that same pinned sha.
    const post = await cli(env({ GATE_MODE: "recheck", GATE_SHA: SHA }), fake([OK], [OK]));
    expect(post.out).toContain(`deploy=true\noutcome=deploy\nsha=${SHA}\n`);
  });

  it("a dispatch from a ref whose sha is not main's head gives no deploy", async () => {
    const pre = await cli(env(), fake([OK], [OK], [NEWER]));
    expect(pre.out).toContain("deploy=false");
  });
});

// ---------------------------------------------------------------------------
// The real workflow files

const MOLECULES: Record<string, boolean> = {
  "web-search": true,
  "read-url": true,
  summarize: true,
  research: true,
  auditor: true,
  clerk: true,
  "code-review": false, // the ONE named exception: no staging app
};

interface Step {
  uses?: string;
  run?: string;
  if?: string;
  id?: string;
  name?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}
interface Job {
  uses?: string;
  needs?: string | string[];
  if?: string;
  environment?: string | { name: string };
  concurrency?: { group: string; queue?: string; "cancel-in-progress"?: boolean };
  permissions?: Record<string, string>;
  with?: Record<string, unknown>;
  steps?: Step[];
}
interface Workflow {
  on: Record<string, unknown>;
  concurrency?: unknown;
  permissions?: Record<string, string>;
  jobs: Record<string, Job>;
}

function wf(file: string): Workflow {
  return parse(readFileSync(join(ROOT, ".github/workflows", file), "utf8")) as Workflow;
}

const RECHECK_IF = "steps.recheck.outputs.deploy == 'true'";

describe("the seven molecule prod workflows route every deploy through the gate", () => {
  for (const [svc, stagingLeg] of Object.entries(MOLECULES)) {
    describe(`deploy-${svc}.yml`, () => {
      const w = wf(`deploy-${svc}.yml`);

      it("the gate job calls the reusable gate with the service and an explicit staging_leg", () => {
        const g = w.jobs.gate;
        expect(g?.uses).toBe("./.github/workflows/molecule-prod-gate.yml");
        expect(g?.with).toEqual({ service: svc, staging_leg: stagingLeg });
        expect(g?.permissions).toEqual({ contents: "read", actions: "read" });
        expect(g?.if).toBeUndefined(); // no event-name bypass: dispatch is gated too
      });

      it("the deploy job needs the gate, runs only on deploy=='true', behind production", () => {
        const d = w.jobs.deploy;
        expect(d?.needs).toBe("gate");
        expect(d?.if).toBe("needs.gate.outputs.deploy == 'true'");
        expect(d?.environment).toBe("production");
        expect(d?.permissions).toEqual({ contents: "read", actions: "read" });
        expect(Object.keys(w.jobs).sort()).toEqual(["deploy", "gate"]);
      });

      it("promotions serialize per service, never cancelled, no queue key; no workflow-level group", () => {
        const c = w.jobs.deploy?.concurrency;
        expect(c).toEqual({
          group: `production-deploy-${svc}`,
          "cancel-in-progress": false,
        });
        expect(c).not.toHaveProperty("queue");
        expect(w.concurrency).toBeUndefined();
      });

      it("least privilege at the workflow level", () => {
        expect(w.permissions).toEqual({ contents: "read" });
      });

      it("workflow_dispatch stays available (and goes through the same jobs)", () => {
        expect(Object.keys(w.on)).toEqual(expect.arrayContaining(["push", "workflow_dispatch"]));
      });

      it("checks out the PINNED gated sha, never a floating ref", () => {
        const steps = w.jobs.deploy?.steps ?? [];
        const checkouts = steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
        expect(checkouts).toHaveLength(1);
        expect(checkouts[0]?.with?.ref).toBe("${{ needs.gate.outputs.sha }}");
      });

      it("the post-approval re-check runs before any Fly step, on the pinned sha, and every later step depends on it", () => {
        const steps = w.jobs.deploy?.steps ?? [];
        const i = steps.findIndex((s) => s.id === "recheck");
        expect(i).toBeGreaterThan(-1);
        // Only the checkout and the node setup it needs come first; neither touches Fly.
        expect(steps.slice(0, i).map((s) => s.uses?.split("@")[0])).toEqual([
          "actions/checkout",
          "actions/setup-node",
        ]);
        const r = steps[i];
        expect(r?.run).toBe("node scripts/molecule-prod-gate.ts");
        expect(r?.env).toMatchObject({
          GATE_MODE: "recheck",
          GATE_SHA: "${{ needs.gate.outputs.sha }}",
          GATE_SERVICE: svc,
          GATE_STAGING_LEG: stagingLeg ? "true" : "false",
        });
        const after = steps.slice(i + 1);
        expect(after.length).toBeGreaterThan(0);
        for (const s of after) expect(s.if ?? "", s.name ?? s.uses).toContain(RECHECK_IF);
        const deployIdx = steps.findIndex((s) => (s.run ?? "").includes("flyctl deploy"));
        expect(deployIdx).toBeGreaterThan(i);
        expect(steps[deployIdx]?.run).toContain(`--config services/${svc}/fly.toml`);
      });
    });
  }

  it("code-review is the ONLY caller without a staging leg", () => {
    const without = Object.keys(MOLECULES).filter(
      (s) => wf(`deploy-${s}.yml`).jobs.gate?.with?.staging_leg !== true,
    );
    expect(without).toEqual(["code-review"]);
  });

  it("every service with a staging leg is in the staging slate matrix", () => {
    const st = readFileSync(join(ROOT, ".github/workflows/deploy-archetype-staging.yml"), "utf8");
    for (const [svc, leg] of Object.entries(MOLECULES)) {
      const inMatrix = new RegExp(`^\\s+- ${svc}$`, "m").test(st);
      expect(inMatrix, svc).toBe(leg);
    }
  });
});

describe("the reusable gate workflow", () => {
  const w = wf("molecule-prod-gate.yml");
  const call = (
    w.on as {
      workflow_call: {
        inputs: Record<string, { required: boolean; type: string; default?: unknown }>;
        outputs: Record<string, unknown>;
      };
    }
  ).workflow_call;

  it("takes service and a REQUIRED staging_leg with no default", () => {
    expect(call.inputs.service).toMatchObject({ required: true, type: "string" });
    expect(call.inputs.staging_leg).toMatchObject({ required: true, type: "boolean" });
    expect(call.inputs.staging_leg?.default).toBeUndefined();
    expect(Object.keys(call.outputs).sort()).toEqual(["deploy", "outcome", "sha"]);
  });

  it("runs the script in wait mode on github.sha with least privilege", () => {
    const g = w.jobs.gate;
    expect(g?.permissions).toEqual({ contents: "read", actions: "read" });
    const step = g?.steps?.find((s) => s.id === "gate");
    expect(step?.run).toBe("node scripts/molecule-prod-gate.ts");
    expect(step?.env).toMatchObject({
      GATE_MODE: "wait",
      GATE_SHA: "${{ github.sha }}",
      GATE_SERVICE: "${{ inputs.service }}",
      GATE_STAGING_LEG: "${{ inputs.staging_leg }}",
    });
    const co = g?.steps?.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(co?.with?.ref).toBe("${{ github.sha }}");
  });
});
