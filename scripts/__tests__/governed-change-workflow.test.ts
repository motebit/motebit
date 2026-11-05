/**
 * governed-change workflow — the EXPAND state of `.github/workflows/governed-change.yml`
 * (docs/proposals/governed-repo-change-v1.md, "External enforcement"; build
 * step 5), read from the REAL file, and its report script
 * (`scripts/governed-change-report.ts`) end to end over real fixture
 * repositories and the real `motebit-verify repo-change` build.
 *
 * Defect class: a privileged `pull_request_target` workflow that executes or
 * trusts PR-controlled code or input (script injection, checking out the PR
 * head, credential exposure, over-broad permissions), or a governed-change
 * check that could silently become a merge gate during expand.
 *
 * The authority is the exact workflow shape (EXPECTED_WORKFLOW), as in
 * autonomy-tier-workflow.test.ts; the semantic tests below stay for their
 * readable failures. The end-to-end tests run the workflow's own fetch
 * command (its `run:` body, from the parsed file) against a fixture remote.
 * They need `packages/verify/dist` (CI's gate-self-tests job builds first).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  BUNDLES_DIR,
  JUDGED_EVENT,
  PHASE,
  fenced,
  main,
  renderSummary,
  touchesBundles,
} from "../governed-change-report.js";
import { BUNDLES_DIR as VERIFY_BUNDLES_DIR } from "../../packages/verify/src/git/state.js";
import {
  NOW,
  REPO,
  fixture,
  git,
  gitEnv,
} from "../../packages/verify/src/__tests__/helpers/repo-change-fixture.js";
import type {
  Fixture,
  FixtureOptions,
} from "../../packages/verify/src/__tests__/helpers/repo-change-fixture.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "governed-change.yml");
const AUTONOMY_WORKFLOW = path.join(ROOT, ".github", "workflows", "autonomy-tier.yml");
const VERIFY_CLI = path.join(ROOT, "packages", "verify", "dist", "cli.js");
const source = fs.readFileSync(WORKFLOW, "utf-8");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  "working-directory"?: string;
}
interface Job {
  if?: unknown;
  permissions?: unknown;
  steps: Step[];
}
const wf = parse(source) as {
  on: Record<string, { branches?: string[]; types?: string[] } | null>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const job = wf.jobs["governed-change"]!;
const checkouts = job.steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
const fetchStep = job.steps.find((s) => s.name?.startsWith("Fetch the change"));

// ── A minimal evaluator for this workflow's expressions ──────────────────────
// (string literals, context paths, ==, &&, ||; GitHub's value-returning && /
// ||, case-insensitive string ==). Anything else throws.
type Ctx = Record<string, unknown>;
function evaluate(expr: string, ctx: Ctx): unknown {
  const tokens = expr.match(/'[^']*'|==|&&|\|\||[A-Za-z_][A-Za-z0-9_.]*|\S/g) ?? [];
  let i = 0;
  const truthy = (v: unknown): boolean =>
    v !== null && v !== undefined && v !== "" && v !== false && v !== 0;
  const primary = (): unknown => {
    const t = tokens[i++];
    if (t === undefined) throw new Error(`unexpected end of ${expr}`);
    if (t.startsWith("'")) return t.slice(1, -1);
    if (/^[A-Za-z_]/.test(t)) {
      let v: unknown = ctx;
      for (const k of t.split(".")) {
        v = v !== null && typeof v === "object" ? (v as Ctx)[k] : undefined;
      }
      return v ?? null;
    }
    throw new Error(`unsupported token ${t} in ${expr}`);
  };
  const eq = (): unknown => {
    const l = primary();
    if (tokens[i] === "==") {
      i++;
      const r = primary();
      return typeof l === "string" && typeof r === "string"
        ? l.toLowerCase() === r.toLowerCase()
        : l === r;
    }
    return l;
  };
  const and = (): unknown => {
    let v = eq();
    while (tokens[i] === "&&") {
      i++;
      const r = eq();
      v = truthy(v) ? r : v;
    }
    return v;
  };
  let v = and();
  while (tokens[i] === "||") {
    i++;
    const r = and();
    v = truthy(v) ? v : r;
  }
  if (i !== tokens.length) throw new Error(`trailing tokens in ${expr}`);
  return v;
}
function interpolate(template: string, ctx: Ctx): string {
  return template.replace(/\$\{\{(.*?)\}\}/g, (_, e: string) => {
    const v = evaluate(e.trim(), ctx);
    return v === null || v === undefined ? "" : String(v);
  });
}

const S = (c: string): string => c.repeat(40);
const BASE_TIP = S("a");
const PR_BASE = S("b");
const PR_HEAD = S("e");
function ctxFor(event: string): Ctx {
  return {
    github: {
      event_name: event,
      sha: event === "pull_request" ? S("d") : event === "merge_group" ? S("2") : BASE_TIP,
      event: {
        pull_request: {
          number: 7,
          base: { sha: PR_BASE, ref: "main" },
          head: { sha: PR_HEAD, ref: "agent-branch", repo: { id: 2 } },
        },
        merge_group: { base_sha: S("1"), head_sha: S("2") },
      },
    },
  };
}

// ── The exact shape (the authority) ──────────────────────────────────────────

const POLICY_REF =
  "${{ github.event_name == 'pull_request_target' && github.sha || 'no-policy-revision-for-this-event' }}";
const HEAD_REF = "${{ github.event.pull_request.head.sha }}";
const STORE = '"$GITHUB_WORKSPACE/subject.git"';
const FETCH_RUN =
  `git init --quiet --bare ${STORE} &&` +
  ` git -C ${STORE} -c fetch.fsckObjects=true` +
  " fetch --quiet --no-tags" +
  ' "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"' +
  ' "+$POLICY_SHA:refs/governed-change/base"' +
  ' "+$EVENT_HEAD_SHA:refs/governed-change/head"';
const PR_TYPES = ["opened", "edited", "synchronize", "reopened", "ready_for_review"];
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const PNPM = "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86";
const NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";

/**
 * THE AUTHORITY: the workflow's exact shape, deny by default. A text scan
 * cannot close a bypass assembled at run time (a line appended to
 * $GITHUB_ENV, `NODE_OPTIONS` in a step env, `|| true` after the report); an
 * exact shape does. `run:` bodies are compared after trimming trailing
 * whitespace only.
 */
const EXPECTED_WORKFLOW = {
  name: "Governed change",
  on: {
    pull_request_target: { branches: ["main"], types: PR_TYPES },
  },
  concurrency: {
    group: "governed-change-${{ github.event.pull_request.number }}",
    "cancel-in-progress": true,
  },
  permissions: { contents: "read", "pull-requests": "read" },
  jobs: {
    "governed-change": {
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 15,
      steps: [
        {
          name: "Check out the base tip (the verifier, pins and policy that judge)",
          uses: CHECKOUT,
          with: { ref: POLICY_REF, path: "trusted", "persist-credentials": false },
        },
        {
          name: "Fetch the change as git objects only (no working tree, never executed)",
          "working-directory": "trusted",
          env: { POLICY_SHA: POLICY_REF, EVENT_HEAD_SHA: HEAD_REF },
          run: FETCH_RUN,
        },
        { uses: PNPM, with: { package_json_file: "trusted/package.json" } },
        { uses: NODE, with: { "node-version": "22", "package-manager-cache": false } },
        {
          name: "Install the base tip's dependencies (uncached)",
          "working-directory": "trusted",
          run: "pnpm install --frozen-lockfile",
        },
        {
          name: "Build motebit-verify from the base tip",
          "working-directory": "trusted",
          run: 'pnpm --filter "@motebit/verify..." run build',
        },
        {
          name: "Judge the change (motebit-verify repo-change, CI-on-PR mode)",
          "working-directory": "trusted",
          env: { EXPECTED_POLICY_SHA: POLICY_REF, EVENT_HEAD_SHA: HEAD_REF },
          run:
            "pnpm exec tsx scripts/governed-change-report.ts" +
            ' --event-path "$GITHUB_EVENT_PATH"' +
            ' --repository "$GITHUB_REPOSITORY"' +
            ` --subject ${STORE}`,
        },
      ],
    },
  },
};

function normalized(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalized);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        k,
        k === "run" && typeof x === "string" ? x.trimEnd() : normalized(x),
      ]),
    );
  }
  return v;
}

describe("the governed-change workflow's exact shape (the authority)", () => {
  it("equals the expected shape exactly: every key, every step, every value", () => {
    expect(
      normalized(wf),
      "governed-change.yml differs from EXPECTED_WORKFLOW in scripts/__tests__/governed-change-workflow.test.ts. " +
        "If the change is unintended, revert it; if it is intended, update EXPECTED_WORKFLOW in the same commit, " +
        "under founder review (CODEOWNERS owns /.github/).",
    ).toEqual(EXPECTED_WORKFLOW);
  });
});

describe("the governed-change workflow's triggers (expand)", () => {
  it("triggers on pull_request_target into main only, for every PR-side change", () => {
    expect(Object.keys(wf.on)).toEqual(["pull_request_target"]);
    expect(wf.on.pull_request_target?.branches).toEqual(["main"]);
    expect([...(wf.on.pull_request_target?.types ?? [])].sort()).toEqual([...PR_TYPES].sort());
  });

  it("does not run on merge_group (that mode is the contract phase's)", () => {
    expect(Object.keys(wf.on)).not.toContain("merge_group");
    expect(JSON.stringify(wf)).not.toMatch(/merge_group/);
  });

  it("is one job named governed-change, with no job-level if (a skipped job reports success)", () => {
    expect(Object.keys(wf.jobs)).toEqual(["governed-change"]);
    expect(job.if).toBeUndefined();
  });

  it("the report script judges exactly the workflow's one event, in the expand phase", () => {
    expect(JUDGED_EVENT).toBe("pull_request_target");
    expect(Object.keys(wf.on)).toEqual([JUDGED_EVENT]);
    expect(PHASE).toBe("expand");
  });
});

describe("the governed-change workflow's pull_request_target safety", () => {
  it("has a read-only token: contents and pull-requests read, nothing else, no job override", () => {
    expect(wf.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(job.permissions).toBeUndefined();
  });

  it("references no secrets and hands the token to no step", () => {
    expect(JSON.stringify(wf)).not.toMatch(/secrets\.|github\.token|GH_TOKEN|GITHUB_TOKEN/);
  });

  it("checks out exactly one tree, the base tip, without persisting credentials", () => {
    expect(checkouts).toHaveLength(1);
    const c = checkouts[0]!;
    expect(c.with?.path).toBe("trusted");
    expect(c.with?.["persist-credentials"]).toBe(false);
    expect(c.with?.repository, "a checkout of another repository").toBeUndefined();
    expect(JSON.stringify(wf)).not.toMatch(/allow-unsafe-pr-checkout/);
  });

  it("the checkout is the base tip on pull_request_target and no revision on any other event, never the PR head", () => {
    const ref = String(checkouts[0]!.with?.ref);
    expect(ref).not.toMatch(/head|pull_request\.|merge/);
    expect(interpolate(ref, ctxFor("pull_request_target"))).toBe(BASE_TIP);
    for (const e of ["pull_request", "pull_request_review", "merge_group", "push"]) {
      const r = interpolate(ref, ctxFor(e));
      expect(r, e).toBe("no-policy-revision-for-this-event");
    }
  });

  it("every run step works in trusted/, never in the PR head", () => {
    const runs = job.steps.filter((s) => s.run !== undefined);
    expect(runs.length).toBeGreaterThan(0);
    for (const s of runs) expect(s["working-directory"], s.name).toBe("trusted");
  });

  it("interpolates no expression into a run script (event fields reach it only by env and file)", () => {
    for (const s of job.steps) if (s.run !== undefined) expect(s.run, s.name).not.toContain("${{");
  });

  it("no step is conditional or allowed to fail", () => {
    expect(Object.keys(job)).not.toContain("continue-on-error");
    for (const s of job.steps) {
      expect(Object.keys(s)).not.toContain("if");
      expect(Object.keys(s)).not.toContain("continue-on-error");
    }
  });

  it("every action is pinned to a full commit sha, the same pin autonomy-tier.yml uses", () => {
    const autonomy = parse(fs.readFileSync(AUTONOMY_WORKFLOW, "utf-8")) as {
      jobs: Record<string, Job>;
    };
    const autonomyPins = new Map<string, string>();
    for (const j of Object.values(autonomy.jobs)) {
      for (const s of j.steps) {
        if (s.uses !== undefined) autonomyPins.set(s.uses.split("@")[0]!, s.uses);
      }
    }
    const uses = job.steps.filter((s) => s.uses !== undefined).map((s) => s.uses!);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u.startsWith("./")).toBe(false);
      expect(u).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/);
      expect(u, `${u} is not autonomy-tier.yml's pin`).toBe(autonomyPins.get(u.split("@")[0]!));
    }
  });

  it("the change is fetched as git objects into a bare store, fsck-checked, from this repository, never the fork", () => {
    expect(fetchStep).toBeDefined();
    expect(fetchStep!.uses).toBeUndefined();
    expect(fetchStep!.run).toBe(FETCH_RUN);
    expect(fetchStep!.run).toMatch(/^git init --quiet --bare /);
    expect(fetchStep!.run).toContain("-c fetch.fsckObjects=true");
    expect(fetchStep!.run).toContain('"$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"');
    expect(JSON.stringify(fetchStep)).not.toMatch(/head\.repo|head_repo|full_name|clone_url/);
    const ctx = ctxFor("pull_request_target");
    expect(interpolate(String(fetchStep!.env?.POLICY_SHA), ctx)).toBe(BASE_TIP);
    expect(interpolate(String(fetchStep!.env?.EVENT_HEAD_SHA), ctx)).toBe(PR_HEAD);
  });

  it("takes the package manager from the base and keeps the dependency cache off", () => {
    const pnpm = job.steps.find((s) => s.uses?.startsWith("pnpm/action-setup@"));
    expect(pnpm?.with?.package_json_file).toBe("trusted/package.json");
    const node = job.steps.find((s) => s.uses?.startsWith("actions/setup-node@"));
    expect(node?.with?.["package-manager-cache"]).toBe(false);
    expect(node?.with?.cache).toBeUndefined();
  });

  it("sets no shell or shell start-up file anywhere", () => {
    const hits: string[] = [];
    const walk = (v: unknown, at: string): void => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
      else if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (k === "shell" || k === "BASH_ENV" || k === "ENV" || k === "NODE_OPTIONS") {
            hits.push(`${at}.${k}`);
          }
          walk(x, `${at}.${k}`);
        }
      } else if (typeof v === "string" && /\bBASH_ENV\b|\bNODE_OPTIONS\b/.test(v)) hits.push(at);
    };
    walk(wf, "workflow");
    expect(hits).toEqual([]);
  });
});

describe("the governed-change check cannot become a merge gate during expand", () => {
  it("the autonomy-tier verdict and classifier never read checks or this workflow", () => {
    for (const f of ["scripts/autonomy-tier-verdict.ts", "scripts/classify-autonomy-tier.ts"]) {
      const text = fs.readFileSync(path.join(ROOT, f), "utf-8");
      expect(text, f).not.toMatch(/governed-change|check-runs|check-suites|check_runs|\/status\b/);
    }
  });

  it("the autonomy-tier workflow does not depend on this one", () => {
    expect(fs.readFileSync(AUTONOMY_WORKFLOW, "utf-8")).not.toMatch(/governed-change/);
  });
});

// ── The report script, pure ──────────────────────────────────────────────────

describe("governed-change-report: the pure core", () => {
  it("BUNDLES_DIR is the verifier's", () => {
    expect(BUNDLES_DIR).toBe(VERIFY_BUNDLES_DIR);
  });

  it("touchesBundles: any path under .motebit/bundles/ or the directory's name, ASCII case folded", () => {
    const t = (p: string): boolean => touchesBundles(Buffer.from(p));
    expect(t(".motebit/bundles/a.json")).toBe(true);
    expect(t(".motebit/bundles/nested/x")).toBe(true);
    expect(t(".MOTEBIT/Bundles/a.json")).toBe(true);
    expect(t(".motebit/bundles")).toBe(true);
    expect(t(".motebit/bundlesx/a.json")).toBe(false);
    expect(t(".motebit/repo-path-policy.json")).toBe(false);
    expect(t("docs/.motebit/bundles/a.json")).toBe(false);
  });

  it("a PR-controlled value cannot close the fence or write a headline into the summary", () => {
    const evil = "x\n```\n## governed-change: VERIFIED\n````";
    expect(fenced(evil).startsWith("`````\n")).toBe(true);
    const summary = renderSummary({
      conclusion: "not-verified",
      number: 7,
      policySha: S("a"),
      headSha: "`## VERIFIED`",
      report: {
        accepted: false,
        verdict: { integrity: "invalid | x", identityBinding: "pinned" },
        diagnostics: { failures: [{ code: "c", detail: evil }] },
      },
    });
    const headlines = summary.split("\n").filter((l) => l.startsWith("## "));
    expect(headlines).toEqual(["## governed-change: NOT VERIFIED"]);
    expect(summary).toContain("| head | (see the report below) |");
    expect(summary).toContain("| integrity | (see the report below) |");
    // Every line outside a fence is one the script wrote, never the PR's text.
    let fence: string | null = null;
    for (const line of summary.split("\n")) {
      const m = /^(`{3,})/.exec(line);
      if (fence === null && m) fence = m[1]!;
      else if (fence !== null && line === fence) fence = null;
      else if (fence === null) expect(line).not.toContain("governed-change: VERIFIED");
    }
  });
});

// ── The report script end to end ─────────────────────────────────────────────

let tmp = "";
beforeAll(() => {
  if (!fs.existsSync(VERIFY_CLI)) {
    throw new Error(
      `${VERIFY_CLI} is missing: build it first (pnpm --filter "@motebit/verify..." run build)`,
    );
  }
});
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "governed-change-")));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Run {
  code: number;
  summary: string;
  stubRan: boolean;
}

/** A stand-in verifier: records that it ran, prints `stdout`, exits `code`. */
function stubCli(code: number, stdout: string, stderr = ""): string {
  const p = path.join(tmp, "stub-cli.mjs");
  fs.writeFileSync(
    p,
    `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(path.join(tmp, "stub-ran"))}, "1");\n` +
      `process.stdout.write(${JSON.stringify(stdout)});\n` +
      `process.stderr.write(${JSON.stringify(stderr)});\n` +
      `process.exit(${code});\n`,
  );
  return p;
}

/** Commit `files` (null deletes) on a new branch from `from` in the fixture repo; back on main after. */
function branch(
  repo: string,
  name: string,
  from: string,
  files: Record<string, string | null>,
  orphan = false,
): string {
  if (orphan) {
    git(repo, "checkout", "-q", "--orphan", name);
    git(repo, "rm", "-rq", "--cached", ".");
    for (const f of fs.readdirSync(repo))
      if (f !== ".git") fs.rmSync(path.join(repo, f), { recursive: true });
  } else {
    git(repo, "checkout", "-q", "-b", name, from);
  }
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(repo, rel);
    if (content === null) fs.rmSync(p);
    else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--allow-empty", "-m", name);
  const sha = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-f", "main");
  return sha;
}

/** Move main forward in the fixture repo with `files`; returns the new tip. */
function mainCommit(repo: string, files: Record<string, string>): string {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "main moves on");
  return git(repo, "rev-parse", "HEAD");
}

/**
 * Run the workflow's own fetch step (its parsed `run:` body) against the
 * fixture as the remote, then the report script as the judge step runs it.
 */
function runCheck(
  repo: string,
  base: string,
  head: string,
  o: {
    cli?: string;
    login?: string;
    env?: Record<string, string>;
  } = {},
): Run {
  const env = {
    ...gitEnv(),
    GITHUB_WORKSPACE: tmp,
    GITHUB_SERVER_URL: `file://${path.dirname(repo)}`,
    GITHUB_REPOSITORY: path.basename(repo),
    POLICY_SHA: interpolate(String(fetchStep!.env!.POLICY_SHA), {
      github: { event_name: "pull_request_target", sha: base },
    }),
    EVENT_HEAD_SHA: interpolate(String(fetchStep!.env!.EVENT_HEAD_SHA), {
      github: { event: { pull_request: { head: { sha: head } } } },
    }),
  };
  execFileSync("sh", ["-c", fetchStep!.run!], { cwd: tmp, env, stdio: "pipe" });
  const eventPath = path.join(tmp, "event.json");
  fs.writeFileSync(
    eventPath,
    JSON.stringify({
      pull_request: {
        number: 7,
        head: { sha: head },
        base: { ref: "main", sha: base },
        user: { login: o.login ?? "motebit-agent" },
      },
    }),
  );
  const summaryPath = path.join(tmp, "summary.md");
  fs.writeFileSync(summaryPath, "");
  const code = main(
    ["--event-path", eventPath, "--repository", REPO, "--subject", path.join(tmp, "subject.git")],
    {
      env: {
        PATH: process.env.PATH,
        HOME: tmp,
        GITHUB_EVENT_NAME: "pull_request_target",
        GITHUB_SHA: base,
        EXPECTED_POLICY_SHA: base,
        EVENT_HEAD_SHA: head,
        GITHUB_STEP_SUMMARY: summaryPath,
        ...o.env,
      },
      policyRoot: repo,
      verifyCli: o.cli ?? VERIFY_CLI,
      now: NOW,
    },
  );
  return {
    code,
    summary: fs.readFileSync(summaryPath, "utf-8"),
    stubRan: fs.existsSync(path.join(tmp, "stub-ran")),
  };
}

async function governed(o: FixtureOptions = {}): Promise<Fixture> {
  return fixture(tmp, o);
}

const NOT_VERIFIED_JSON = JSON.stringify({
  accepted: false,
  verdict: {
    integrity: "invalid",
    identityBinding: "pinned",
    authority: "insufficient",
    revocation: { status: "fresh" },
  },
  outcome: "completed",
  diagnostics: { failures: [] },
});

describe("governed-change-report end to end: a governed change", () => {
  it("that verifies concludes VERIFIED (exit 0), with every axis in the summary", async () => {
    const fx = await governed();
    const r = runCheck(fx.repo, fx.base, fx.head);
    expect(r.summary).toContain("## governed-change: VERIFIED");
    for (const row of [
      "| integrity | verified |",
      "| identityBinding | pinned |",
      "| authority | valid |",
      "| revocation | fresh |",
      "| outcome | completed |",
      "| accepted | true |",
      `| base tip (policy) | ${fx.base} |`,
      `| head | ${fx.head} |`,
      `| change commit | ${fx.change} |`,
      "local_clock",
    ]) {
      expect(r.summary, row).toContain(row);
    }
    expect(r.code).toBe(0);
  }, 60_000);

  it("that is revoked concludes NOT VERIFIED (exit 1), revocation revoked in the summary", async () => {
    const fx = await governed({ revoked: true });
    const r = runCheck(fx.repo, fx.base, fx.head);
    expect(r.summary).toContain("## governed-change: NOT VERIFIED");
    expect(r.summary).toContain("| revocation | revoked |");
    expect(r.summary).toContain("revocation.repo_change.revoked");
    expect(r.code).toBe(1);
  }, 60_000);

  it("published by another account concludes NOT VERIFIED (exit 1)", async () => {
    const fx = await governed();
    const r = runCheck(fx.repo, fx.base, fx.head, { login: "someone-else" });
    expect(r.summary).toContain("## governed-change: NOT VERIFIED");
    expect(r.summary).toContain("| integrity | invalid |");
    expect(r.code).toBe(1);
  }, 60_000);

  it("the verifier unable to judge (its exit 2) concludes NOT JUDGED (exit 1), its error in the summary", async () => {
    const fx = await governed();
    const cli = stubCli(2, "", "motebit-verify: repo-change: not judged: no policy");
    const r = runCheck(fx.repo, fx.base, fx.head, { cli });
    expect(r.stubRan).toBe(true);
    expect(r.summary).toContain("## governed-change: NOT JUDGED");
    expect(r.summary).toContain("not judged: no policy");
    expect(r.code).toBe(1);
  }, 60_000);

  it("a verifier that exits 0 without accepted: true is not VERIFIED", async () => {
    const fx = await governed();
    const r = runCheck(fx.repo, fx.base, fx.head, { cli: stubCli(0, NOT_VERIFIED_JSON) });
    expect(r.summary).toContain("## governed-change: NOT VERIFIED");
    expect(r.code).toBe(1);
  }, 60_000);
});

describe("governed-change-report end to end: which pull requests are judged", () => {
  it("an ordinary PR (nothing under .motebit/bundles/) is not judged: exit 0, never reported verified", async () => {
    const fx = await governed();
    const head = branch(fx.repo, "plain", fx.base, { "notes/other.md": "hello\n" });
    const r = runCheck(fx.repo, fx.base, head, { cli: stubCli(1, NOT_VERIFIED_JSON) });
    expect(r.stubRan).toBe(false);
    expect(r.summary).toContain("## governed-change: not a governed change (not judged)");
    expect(r.summary).not.toMatch(/: VERIFIED/);
    expect(r.code).toBe(0);
  }, 60_000);

  it("an ordinary PR branched before a bundle landed on main is not judged (compared from the merge base)", async () => {
    const fx = await governed();
    const head = branch(fx.repo, "plain", fx.base, { "notes/other.md": "hello\n" });
    const tip = mainCommit(fx.repo, { ".motebit/bundles/landed.json": "{}\n" });
    const r = runCheck(fx.repo, tip, head, { cli: stubCli(1, NOT_VERIFIED_JSON) });
    expect(r.stubRan).toBe(false);
    expect(r.code).toBe(0);
  }, 60_000);

  it("a PR that deletes a bundle on main is judged", async () => {
    const fx = await governed();
    const tip = mainCommit(fx.repo, { ".motebit/bundles/landed.json": "{}\n" });
    const head = branch(fx.repo, "del", tip, { ".motebit/bundles/landed.json": null });
    const r = runCheck(fx.repo, tip, head, { cli: stubCli(1, NOT_VERIFIED_JSON) });
    expect(r.stubRan).toBe(true);
    expect(r.summary).toContain("## governed-change: NOT VERIFIED");
    expect(r.code).toBe(1);
  }, 60_000);

  it("a PR adding a case variant of .motebit/bundles/ is judged", async () => {
    const fx = await governed();
    const head = branch(fx.repo, "case", fx.base, { ".Motebit/Bundles/x.json": "{}\n" });
    const r = runCheck(fx.repo, fx.base, head, { cli: stubCli(1, NOT_VERIFIED_JSON) });
    expect(r.stubRan).toBe(true);
    expect(r.code).toBe(1);
  }, 60_000);

  it("a PR with no merge base is judged", async () => {
    const fx = await governed();
    const head = branch(fx.repo, "orphan", fx.base, { "notes/x.md": "x\n" }, true);
    const r = runCheck(fx.repo, fx.base, head, { cli: stubCli(1, NOT_VERIFIED_JSON) });
    expect(r.stubRan).toBe(true);
    expect(r.code).toBe(1);
  }, 60_000);
});

describe("governed-change-report end to end: the provenance self-check", () => {
  const cases: Array<[string, (base: string, head: string) => Record<string, string>]> = [
    ["an event other than pull_request_target", () => ({ GITHUB_EVENT_NAME: "pull_request" })],
    ["a checkout that is not GITHUB_SHA", () => ({ GITHUB_SHA: S("9") })],
    ["a checkout that is not EXPECTED_POLICY_SHA", () => ({ EXPECTED_POLICY_SHA: S("9") })],
    ["a fetched head that is not the payload's", () => ({ EVENT_HEAD_SHA: S("9") })],
  ];
  for (const [title, env] of cases) {
    it(`${title} is NOT JUDGED (exit 1), the verifier never run`, async () => {
      const fx = await governed();
      const r = runCheck(fx.repo, fx.base, fx.head, {
        cli: stubCli(0, "{}"),
        env: env(fx.base, fx.head),
      });
      expect(r.stubRan).toBe(false);
      expect(r.summary).toContain("## governed-change: NOT JUDGED");
      expect(r.summary).toContain("provenance self-check failed");
      expect(r.code).toBe(1);
    }, 60_000);
  }
});
