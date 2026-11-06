/**
 * governed-change-landed workflow — `.github/workflows/governed-change-landed.yml`,
 * the offline half of acceptance test B1 (docs/proposals/governed-repo-change-v1.md
 * § "Acceptance tests"), read from the REAL file, and the landed mode of its
 * report script (`scripts/governed-change-report.ts landed`) end to end over
 * real landed fixture repositories (ephemeral keys only) and the real
 * `motebit-verify repo-change --landed` build.
 *
 * Defect class: a workflow that claims "offline" but can reach the network,
 * interpolates dispatcher-controlled input into a shell, runs on a non-main
 * ref, or reports VERIFIED on anything less than fully verified + completed.
 *
 * The authority is the exact workflow shape (EXPECTED_WORKFLOW), as in
 * governed-change-workflow.test.ts; the semantic tests below stay for their
 * readable failures. Two of the workflow's own scripts are EXECUTED from the
 * parsed file: the guard step (against a matrix of refs and inputs) and the
 * judge step (against a stub `docker` that records the exact argv it is
 * given, so every container flag is checked as passed, and that exits and
 * writes a summary as told, so the exit-code and summary rules are run). The
 * container itself needs Docker on Linux; it is pinned by that argv here and
 * observed in the recorded job. The no-network proof runs inside the
 * container in the report script (`proveNoNetwork`), tested here with
 * injected probes and once with the real probes on this (networked) host,
 * where it must fail. The end-to-end tests need `packages/verify/dist` (CI's
 * gate-self-tests job builds first).
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  LANDED_COMMIT_ID,
  LANDED_EVENT,
  LANDED_REF,
  NO_ROUTE_CODES,
  PROBE_ADDRESS,
  PROBE_NAME,
  PROBE_PORT,
  REAL_PROBES,
  mainLanded,
  proveNoNetwork,
  renderLandedSummary,
  run as runReport,
} from "../governed-change-report.js";
import type { NetworkProbes } from "../governed-change-report.js";
import { landedFixture } from "../../packages/verify/src/__tests__/helpers/landed-fixture.js";
import type {
  LandedFixture,
  LandedOptions,
} from "../../packages/verify/src/__tests__/helpers/landed-fixture.js";
import { REPO } from "../../packages/verify/src/__tests__/helpers/repo-change-fixture.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "governed-change-landed.yml");
const AUTONOMY_WORKFLOW = path.join(ROOT, ".github", "workflows", "autonomy-tier.yml");
const RELAY_DOCKERFILE = path.join(ROOT, "services", "relay", "Dockerfile");
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
  on: Record<string, { inputs?: Record<string, Record<string, unknown>> } | null>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const job = wf.jobs["governed-change-landed"]!;
const steps = job.steps;
const checkouts = steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
const guardStep = steps[0]!;
const judgeIndex = steps.findIndex((s) => s.name?.startsWith("Judge the landed change"));
const judgeStep = steps[judgeIndex]!;
const imageIndex = steps.findIndex((s) => s.name?.startsWith("Build the judge image"));
const imageStep = steps[imageIndex]!;

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
const TIP = S("a");

// ── The exact shape (the authority) ──────────────────────────────────────────

const TIP_REF = "${{ github.ref == 'refs/heads/main' && github.sha || 'no-trusted-tip-off-main' }}";
const INPUT = "${{ inputs.landed_commit }}";
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const PNPM = "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86";
const NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
/** The base image: the digest services/relay/Dockerfile pins (checked below). */
const BASE_IMAGE =
  "node:22-slim@sha256:d415caac2f1f77b98caaf9415c5f807e14bc8d7bdea62561ea2fef4fbd08a73c";

const GUARD_RUN = [
  'if [ "$GITHUB_REF" != "refs/heads/main" ]; then',
  '  echo "governed-change-landed runs only from refs/heads/main" >&2',
  "  exit 1",
  "fi",
  'case "$LANDED_COMMIT" in',
  '  *[!0-9a-f]*) echo "landed_commit must be 40 lowercase hex digits" >&2; exit 1 ;;',
  "esac",
  'if [ "${#LANDED_COMMIT}" -ne 40 ]; then',
  '  echo "landed_commit must be 40 lowercase hex digits" >&2',
  "  exit 1",
  "fi",
].join("\n");

const IID = '"$RUNNER_TEMP/governed-change-landed.iid"';
const DOCKERFILE = [
  `FROM ${BASE_IMAGE}`,
  "RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*",
];
const IMAGE_RUN = [
  `docker build --iidfile ${IID} - <<'DOCKERFILE'`,
  ...DOCKERFILE,
  "DOCKERFILE",
].join("\n");

const JUDGE_RUN = [
  'out="$RUNNER_TEMP/governed-change-landed-out"',
  'mkdir "$out"',
  "rc=0",
  "docker run --rm --pull never --network none --cap-drop ALL \\",
  "  --security-opt no-new-privileges --read-only \\",
  '  --user "$(id -u):$(id -g)" \\',
  "  --tmpfs /tmp:rw,nosuid,nodev,noexec \\",
  '  -v "$PWD:/repo:ro" -v "$out:/out" -w /repo \\',
  "  -e HOME=/tmp -e GITHUB_STEP_SUMMARY=/out/summary.md \\",
  "  -e GITHUB_EVENT_NAME -e GITHUB_REF -e GITHUB_SHA -e LANDED_COMMIT -e TRUSTED_TIP \\",
  `  "$(cat ${IID})" \\`,
  "  node --import tsx scripts/governed-change-report.ts landed \\",
  "  --repository motebit/motebit --repo /repo \\",
  "  --github-keys .motebit/operator-keys/github.json || rc=$?",
  'if [ -f "$out/summary.md" ]; then',
  '  cat "$out/summary.md" >> "$GITHUB_STEP_SUMMARY"',
  'elif [ "$rc" -eq 0 ]; then',
  '  echo "the judge wrote no summary" >&2',
  "  rc=1",
  "fi",
  'exit "$rc"',
].join("\n");

/**
 * THE AUTHORITY: the workflow's exact shape, deny by default. A text scan
 * cannot close a bypass assembled at run time (a flag that gives the
 * container a network, `|| true` after the judge, a line appended to
 * $GITHUB_ENV); an exact shape does. `run:` bodies are compared after
 * trimming trailing whitespace only.
 */
const EXPECTED_WORKFLOW = {
  name: "Governed change landed",
  on: {
    workflow_dispatch: {
      inputs: {
        landed_commit: {
          description:
            "The squash commit that landed the governed change (40 lowercase hex digits)",
          required: true,
          type: "string",
        },
      },
    },
  },
  permissions: { contents: "read" },
  jobs: {
    "governed-change-landed": {
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 20,
      steps: [
        {
          name: "Refuse a dispatch off main or a landed commit that is not a full commit id",
          env: { LANDED_COMMIT: INPUT },
          run: GUARD_RUN,
        },
        {
          name: "Check out main's tip, full history (the fresh clone and the trusted tip)",
          uses: CHECKOUT,
          with: {
            ref: TIP_REF,
            path: "trusted",
            "fetch-depth": 0,
            "persist-credentials": false,
          },
        },
        { uses: PNPM, with: { package_json_file: "trusted/package.json" } },
        { uses: NODE, with: { "node-version": "22", "package-manager-cache": false } },
        {
          name: "Install the trusted tip's dependencies (uncached)",
          "working-directory": "trusted",
          run: "pnpm install --frozen-lockfile",
        },
        {
          name: "Build motebit-verify from the trusted tip",
          "working-directory": "trusted",
          run: 'pnpm --filter "@motebit/verify..." run build',
        },
        {
          name: "Build the judge image (the pinned node:22-slim digest plus Debian's git)",
          "working-directory": "trusted",
          run: IMAGE_RUN,
        },
        {
          name: "Judge the landed change with no network (motebit-verify repo-change --landed)",
          "working-directory": "trusted",
          env: { LANDED_COMMIT: INPUT, TRUSTED_TIP: TIP_REF },
          run: JUDGE_RUN,
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

describe("the governed-change-landed workflow's exact shape (the authority)", () => {
  it("equals the expected shape exactly: every key, every step, every value", () => {
    expect(
      normalized(wf),
      "governed-change-landed.yml differs from EXPECTED_WORKFLOW in scripts/__tests__/governed-change-landed-workflow.test.ts. " +
        "If the change is unintended, revert it; if it is intended, update EXPECTED_WORKFLOW in the same commit, " +
        "under founder review (CODEOWNERS owns /.github/).",
    ).toEqual(EXPECTED_WORKFLOW);
  });
});

describe("the governed-change-landed workflow's trigger", () => {
  it("triggers on workflow_dispatch only, with one required string input landed_commit", () => {
    expect(Object.keys(wf.on)).toEqual(["workflow_dispatch"]);
    const inputs = wf.on.workflow_dispatch?.inputs ?? {};
    expect(Object.keys(inputs)).toEqual(["landed_commit"]);
    expect(inputs.landed_commit?.required).toBe(true);
    expect(inputs.landed_commit?.type).toBe("string");
  });

  it("is one job, with no job-level if (a skipped job reports success)", () => {
    expect(Object.keys(wf.jobs)).toEqual(["governed-change-landed"]);
    expect(job.if).toBeUndefined();
  });

  it("the report script judges exactly the workflow's event, from main", () => {
    expect(LANDED_EVENT).toBe("workflow_dispatch");
    expect(Object.keys(wf.on)).toEqual([LANDED_EVENT]);
    expect(LANDED_REF).toBe("refs/heads/main");
  });
});

describe("the governed-change-landed workflow's safety", () => {
  it("has a read-only token: contents read, nothing else, no job override", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();
  });

  it("references no secrets and hands the token to no step", () => {
    expect(JSON.stringify(wf)).not.toMatch(/secrets\.|github\.token|GH_TOKEN|GITHUB_TOKEN/);
  });

  it("checks out exactly one tree, this repository, full history, without persisting credentials", () => {
    expect(checkouts).toHaveLength(1);
    const c = checkouts[0]!;
    expect(c.with?.path).toBe("trusted");
    expect(c.with?.["fetch-depth"]).toBe(0);
    expect(c.with?.["persist-credentials"]).toBe(false);
    expect(c.with?.repository, "a checkout of another repository").toBeUndefined();
  });

  it("the checkout and TRUSTED_TIP are main's tip on main and no revision on any other ref", () => {
    for (const ref of [String(checkouts[0]!.with?.ref), String(judgeStep.env?.TRUSTED_TIP)]) {
      expect(ref).toBe(TIP_REF);
      const at = (r: string): string => interpolate(ref, { github: { ref: r, sha: TIP } });
      expect(at("refs/heads/main")).toBe(TIP);
      for (const r of ["refs/heads/feature", "refs/tags/v1", "refs/heads/main2", "main", ""]) {
        expect(at(r), r).toBe("no-trusted-tip-off-main");
      }
    }
  });

  it("interpolates no expression into a run script (inputs reach it only by env)", () => {
    for (const s of steps) if (s.run !== undefined) expect(s.run, s.name).not.toContain("${{");
  });

  it("the landed commit reaches a step only as LANDED_COMMIT, in the guard and the judge", () => {
    const users = steps.filter((s) => JSON.stringify(s).includes("inputs."));
    expect(users.map((s) => s.name)).toEqual([guardStep.name, judgeStep.name]);
    for (const s of users) expect(s.env).toMatchObject({ LANDED_COMMIT: INPUT });
  });

  it("no step is conditional or allowed to fail", () => {
    expect(Object.keys(job)).not.toContain("continue-on-error");
    for (const s of steps) {
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
    const uses = steps.filter((s) => s.uses !== undefined).map((s) => s.uses!);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u.startsWith("./")).toBe(false);
      expect(u).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/);
      expect(u, `${u} is not autonomy-tier.yml's pin`).toBe(autonomyPins.get(u.split("@")[0]!));
    }
  });

  it("takes the package manager from the checkout and keeps the dependency cache off", () => {
    const pnpm = steps.find((s) => s.uses?.startsWith("pnpm/action-setup@"));
    expect(pnpm?.with?.package_json_file).toBe("trusted/package.json");
    const node = steps.find((s) => s.uses?.startsWith("actions/setup-node@"));
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

// ── The guard step, executed ─────────────────────────────────────────────────

function runGuard(ref: string, landed: string): number {
  const r = spawnSync("sh", ["-c", guardStep.run!], {
    env: { PATH: process.env.PATH, GITHUB_REF: ref, LANDED_COMMIT: landed },
    encoding: "utf8",
  });
  return r.status ?? -1;
}

describe("the guard step refuses a dispatch off main and a landed commit that is not 40 lowercase hex", () => {
  it("is the first step, before the checkout", () => {
    expect(guardStep.uses).toBeUndefined();
    expect(guardStep.run?.trimEnd()).toBe(GUARD_RUN);
    expect(steps.indexOf(checkouts[0]!)).toBeGreaterThan(0);
  });

  it("passes main with a full lowercase commit id", () => {
    expect(runGuard("refs/heads/main", S("0").slice(0, 20) + S("f").slice(0, 20))).toBe(0);
  });

  it("refuses every ref other than refs/heads/main", () => {
    for (const ref of ["refs/heads/feature", "refs/heads/main2", "refs/tags/main", "main", ""]) {
      expect(runGuard(ref, S("a")), ref).toBe(1);
    }
  });

  it("refuses every landed commit that is not exactly 40 lowercase hex digits", () => {
    const bad = [
      "",
      S("a").slice(1),
      `${S("a")}a`,
      S("A"),
      `${S("a").slice(1)}g`,
      `${S("a").slice(2)} a`,
      `${S("a")}\n`,
      `${S("a")}\n${S("b")}`,
      `$(touch pwned)${S("a").slice(13)}`,
      S("a") + S("a").slice(0, 24),
    ];
    for (const c of bad) expect(runGuard("refs/heads/main", c), JSON.stringify(c)).toBe(1);
  });

  it("the report script's own check is the same rule", () => {
    expect(LANDED_COMMIT_ID.test(S("a"))).toBe(true);
    for (const c of [S("A"), `${S("a")}\n`, S("a").slice(1), S("a") + S("a").slice(0, 24)]) {
      expect(LANDED_COMMIT_ID.test(c), JSON.stringify(c)).toBe(false);
    }
  });
});

// ── The judge step, executed against a stub docker ───────────────────────────

let tmp = "";
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "governed-change-landed-")));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface JudgeRun {
  code: number;
  /** The argv the judge step gave docker, or null when docker never ran. */
  argv: string[] | null;
  /** What the step appended to the job summary. */
  summary: string;
  repo: string;
  out: string;
}

/**
 * Run the judge step's own `run:` body with bash -e (GitHub's default
 * shell), a stub `docker` that records its argv (one argument per line),
 * writes `summary` into the output directory when given, and exits `rc`.
 */
function runJudge(o: { rc: number; summary?: string; leftoverOut?: boolean }): JudgeRun {
  const dir = fs.mkdtempSync(path.join(tmp, "judge-"));
  const bin = path.join(dir, "bin");
  const runnerTemp = path.join(dir, "runner-temp");
  const repo = path.join(dir, "trusted");
  for (const d of [bin, runnerTemp, repo]) fs.mkdirSync(d);
  const out = path.join(runnerTemp, "governed-change-landed-out");
  if (o.leftoverOut) fs.mkdirSync(out);
  fs.writeFileSync(path.join(runnerTemp, "governed-change-landed.iid"), "sha256:judgeimage\n");
  const argvFile = path.join(dir, "docker-argv");
  const stubSummary = path.join(dir, "stub-summary");
  if (o.summary !== undefined) fs.writeFileSync(stubSummary, o.summary);
  fs.writeFileSync(
    path.join(bin, "docker"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${JSON.stringify(argvFile)}`,
      `if [ -f ${JSON.stringify(stubSummary)} ]; then cat ${JSON.stringify(stubSummary)} > ${JSON.stringify(path.join(out, "summary.md"))}; fi`,
      `exit ${o.rc}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const jobSummary = path.join(dir, "job-summary.md");
  fs.writeFileSync(jobSummary, "");
  const r = spawnSync("bash", ["-e", "-c", judgeStep.run!], {
    cwd: repo,
    env: {
      PATH: [bin, "/usr/bin", "/bin"].join(":"),
      RUNNER_TEMP: runnerTemp,
      GITHUB_STEP_SUMMARY: jobSummary,
    },
    encoding: "utf8",
  });
  return {
    code: r.status ?? -1,
    argv: fs.existsSync(argvFile)
      ? fs.readFileSync(argvFile, "utf8").split("\n").slice(0, -1)
      : null,
    summary: fs.readFileSync(jobSummary, "utf8"),
    repo,
    out,
  };
}

/** The flags (and their values) before the image in the judge's docker argv. */
function dockerFlags(argv: string[]): string[] {
  const at = argv.indexOf("sha256:judgeimage");
  if (at < 0) throw new Error("the judge's docker argv names no image");
  return argv.slice(1, at);
}

const UID = typeof process.getuid === "function" ? process.getuid() : -1;
const GID = typeof process.getgid === "function" ? process.getgid() : -1;

describe("the judge container: no network, no capabilities, non-root, read-only clone", () => {
  it("passes docker exactly the expected argv", () => {
    const r = runJudge({ rc: 0, summary: "ok\n" });
    expect(r.argv).toEqual([
      "run",
      "--rm",
      "--pull",
      "never",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--user",
      `${UID}:${GID}`,
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec",
      "-v",
      `${r.repo}:/repo:ro`,
      "-v",
      `${r.out}:/out`,
      "-w",
      "/repo",
      "-e",
      "HOME=/tmp",
      "-e",
      "GITHUB_STEP_SUMMARY=/out/summary.md",
      "-e",
      "GITHUB_EVENT_NAME",
      "-e",
      "GITHUB_REF",
      "-e",
      "GITHUB_SHA",
      "-e",
      "LANDED_COMMIT",
      "-e",
      "TRUSTED_TIP",
      "sha256:judgeimage",
      "node",
      "--import",
      "tsx",
      "scripts/governed-change-report.ts",
      "landed",
      "--repository",
      "motebit/motebit",
      "--repo",
      "/repo",
      "--github-keys",
      ".motebit/operator-keys/github.json",
    ]);
  });

  it("has no network: --network none, and no host namespace, device or daemon socket", () => {
    const flags = dockerFlags(runJudge({ rc: 0, summary: "ok\n" }).argv!);
    const net = flags.indexOf("--network");
    expect(net).toBeGreaterThan(-1);
    expect(flags[net + 1]).toBe("none");
    expect(
      flags.filter((f) => f === "--network" || f.startsWith("--network=") || f === "--net"),
    ).toHaveLength(1);
    const text = flags.join(" ");
    expect(text).not.toMatch(
      /docker\.sock|--pid|--ipc|--uts|--userns|--device|--volumes-from|--add-host|--dns/,
    );
  });

  it("has no capabilities and no_new_privs: --cap-drop ALL, nothing added back, never privileged", () => {
    const flags = dockerFlags(runJudge({ rc: 0, summary: "ok\n" }).argv!);
    expect(flags[flags.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(flags[flags.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
    expect(flags.filter((f) => f === "--security-opt")).toHaveLength(1);
    expect(flags.join(" ")).not.toMatch(/--cap-add|--privileged|unconfined/);
  });

  it("runs as the runner's own non-root uid and gid", () => {
    const flags = dockerFlags(runJudge({ rc: 0, summary: "ok\n" }).argv!);
    expect(
      flags.filter((f) => f === "--user" || f.startsWith("--user=") || f === "-u"),
    ).toHaveLength(1);
    expect(flags[flags.indexOf("--user") + 1]).toBe(`${UID}:${GID}`);
    expect(judgeStep.run).toContain('--user "$(id -u):$(id -g)"');
  });

  it("the root filesystem and the clone are read-only; the only host directory it can write is the fresh output directory", () => {
    const r = runJudge({ rc: 0, summary: "ok\n" });
    const flags = dockerFlags(r.argv!);
    expect(flags).toContain("--read-only");
    const mounts = flags.flatMap((f, i) => (f === "-v" || f === "--volume" ? [flags[i + 1]!] : []));
    expect(mounts).toEqual([`${r.repo}:/repo:ro`, `${r.out}:/out`]);
    expect(flags.join(" ")).not.toMatch(/--mount/);
    const tmpfs = flags.flatMap((f, i) => (f === "--tmpfs" ? [flags[i + 1]!] : []));
    expect(tmpfs).toEqual(["/tmp:rw,nosuid,nodev,noexec"]);
  });

  it("gets only the named variables, and the summary path inside the output directory", () => {
    const flags = dockerFlags(runJudge({ rc: 0, summary: "ok\n" }).argv!);
    const vars = flags.flatMap((f, i) => (f === "-e" || f === "--env" ? [flags[i + 1]!] : []));
    expect(vars).toEqual([
      "HOME=/tmp",
      "GITHUB_STEP_SUMMARY=/out/summary.md",
      "GITHUB_EVENT_NAME",
      "GITHUB_REF",
      "GITHUB_SHA",
      "LANDED_COMMIT",
      "TRUSTED_TIP",
    ]);
    expect(flags.join(" ")).not.toMatch(/--env-file/);
  });

  it("runs the image this job built, never a pulled one, and the report script's landed mode", () => {
    const argv = runJudge({ rc: 0, summary: "ok\n" }).argv!;
    const flags = dockerFlags(argv);
    expect(flags[flags.indexOf("--pull") + 1]).toBe("never");
    expect(argv.slice(argv.indexOf("sha256:judgeimage") + 1)).toEqual([
      "node",
      "--import",
      "tsx",
      "scripts/governed-change-report.ts",
      "landed",
      "--repository",
      "motebit/motebit",
      "--repo",
      "/repo",
      "--github-keys",
      ".motebit/operator-keys/github.json",
    ]);
  });

  it("the image is built from the digest services/relay/Dockerfile pins, adds only git, with no build context", () => {
    expect(imageIndex).toBe(judgeIndex - 1);
    expect(imageStep.run?.trimEnd()).toBe(IMAGE_RUN);
    const relayFrom = fs
      .readFileSync(RELAY_DOCKERFILE, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("FROM "))
      .map((l) => l.split(" ")[1]);
    expect(relayFrom).toContain(BASE_IMAGE);
    expect(BASE_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(imageStep.run).toMatch(/docker build --iidfile \S+ - <</);
  });
});

describe("the judge step's exit code and summary", () => {
  it("the step's exit code is the container's, and the container's summary is appended", () => {
    for (const rc of [0, 1, 2, 137]) {
      const r = runJudge({ rc, summary: `## from the container ${rc}\n` });
      expect(r.code, `rc ${rc}`).toBe(rc);
      expect(r.summary, `rc ${rc}`).toBe(`## from the container ${rc}\n`);
    }
  });

  it("a container that writes no summary never passes", () => {
    expect(runJudge({ rc: 0 }).code).toBe(1);
    expect(runJudge({ rc: 3 }).code).toBe(3);
  });

  it("the output directory must be fresh: a leftover one fails the step before docker runs", () => {
    const r = runJudge({ rc: 0, summary: "ok\n", leftoverOut: true });
    expect(r.code).not.toBe(0);
    expect(r.argv).toBeNull();
  });

  it("the judge is the last step, and the only step that runs the report script or the verifier", () => {
    expect(judgeIndex).toBe(steps.length - 1);
    for (const [i, s] of steps.entries()) {
      if (i === judgeIndex) continue;
      expect(JSON.stringify({ ...s, name: undefined }), s.name).not.toMatch(
        /governed-change-report|motebit-verify|repo-change|dist\/cli|docker run/,
      );
    }
  });

  it("the pinned keys the judge reads are the repository's motebit/operator-signing-keys@1.0 file", () => {
    const keys = JSON.parse(
      fs.readFileSync(path.join(ROOT, ".motebit", "operator-keys", "github.json"), "utf8"),
    ) as { spec?: unknown };
    expect(keys.spec).toBe("motebit/operator-signing-keys@1.0");
  });
});

// ── The no-network proof (in the report script, run inside the container) ────

const err = (code: string): Error => Object.assign(new Error(code), { code });
const never = (): Promise<never> => new Promise(() => {});
const OFFLINE: NetworkProbes = {
  interfaces: () => ({
    lo: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "127.0.0.1/8",
      },
    ],
  }),
  lookup: () => Promise.reject(err("EAI_AGAIN")),
  connect: () => Promise.reject(err("ENETUNREACH")),
};
const WITH_ETH0: NetworkProbes["interfaces"] = () => ({
  ...OFFLINE.interfaces(),
  eth0: [
    {
      address: "10.1.0.4",
      netmask: "255.255.0.0",
      family: "IPv4",
      mac: "00:0d:3a:00:00:01",
      internal: false,
      cidr: "10.1.0.4/16",
    },
  ],
});
const prove = (over: Partial<NetworkProbes>): Promise<string[]> =>
  proveNoNetwork({ ...OFFLINE, ...over }, 50);

describe("the no-network proof", () => {
  it("probes github.com and 1.1.1.1:443, and only ENETUNREACH / EHOSTUNREACH count as no route", () => {
    expect([PROBE_NAME, PROBE_ADDRESS, PROBE_PORT]).toEqual(["github.com", "1.1.1.1", 443]);
    expect([...NO_ROUTE_CODES].sort()).toEqual(["EHOSTUNREACH", "ENETUNREACH"]);
  });

  it("holds when only loopback exists, the name does not resolve and the connect has no route", async () => {
    expect(await prove({})).toEqual([]);
    expect(await prove({ connect: () => Promise.reject(err("EHOSTUNREACH")) })).toEqual([]);
  });

  it("a network interface other than loopback fails the proof", async () => {
    expect(await prove({ interfaces: WITH_ETH0 })).toEqual([
      "a network interface other than loopback: eth0",
    ]);
  });

  it("unreadable network interfaces fail the proof", async () => {
    const problems = await prove({
      interfaces: () => {
        throw new Error("EACCES");
      },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/unreadable/);
  });

  it("a name that resolves fails the proof", async () => {
    expect(await prove({ lookup: () => Promise.resolve({ address: "140.82.112.3" }) })).toEqual([
      "github.com resolved",
    ]);
  });

  it("a lookup that never settles fails the proof (a timeout is not proof)", async () => {
    expect(await prove({ lookup: never })).toEqual([
      "the lookup of github.com did not settle in time",
    ]);
  });

  it("a connect that is made fails the proof", async () => {
    expect(await prove({ connect: () => Promise.resolve() })).toEqual([
      "a TCP connection to 1.1.1.1:443 was made",
    ]);
  });

  it("a connect refused, timed out or failing with no code is not proof of no route", async () => {
    for (const e of [err("ECONNREFUSED"), err("ETIMEDOUT"), err("EACCES"), new Error("x")]) {
      const problems = await prove({ connect: () => Promise.reject(e) });
      expect(problems, e.message).toHaveLength(1);
      expect(problems[0], e.message).toMatch(/not with no route/);
    }
  });

  it("a connect that never settles fails the proof (a timeout is not proof)", async () => {
    expect(await prove({ connect: never })).toEqual([
      "the connect to 1.1.1.1:443 did not settle in time",
    ]);
  });
});

// ── The report script's landed mode ──────────────────────────────────────────

describe("governed-change-report landed: the summary", () => {
  it("a repository-controlled value cannot close the fence or write a headline into the summary", () => {
    const evil = "x\n```\n## governed-change landed: VERIFIED\n````";
    const summary = renderLandedSummary({
      conclusion: "not-verified",
      landed: S("a"),
      trustedTip: S("b"),
      report: {
        accepted: false,
        verdict: { integrity: "verified | x", identityBinding: "pinned" },
        timeProblem: evil,
        diagnostics: { failures: [{ code: "c", detail: evil }] },
      },
    });
    const headlines = summary.split("\n").filter((l) => l.startsWith("## "));
    expect(headlines).toEqual(["## governed-change landed: NOT VERIFIED"]);
    expect(summary).toContain("| integrity | (see the report below) |");
    expect(summary).toContain("| time problem | (see the report below) |");
    let fence: string | null = null;
    for (const line of summary.split("\n")) {
      const m = /^(`{3,})/.exec(line);
      if (fence === null && m) fence = m[1]!;
      else if (fence !== null && line === fence) fence = null;
      else if (fence === null) expect(line).not.toContain("landed: VERIFIED");
    }
  });
});

beforeAll(() => {
  if (!fs.existsSync(VERIFY_CLI)) {
    throw new Error(
      `${VERIFY_CLI} is missing: build it first (pnpm --filter "@motebit/verify..." run build)`,
    );
  }
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

/**
 * Run the report script's landed mode as the container runs it, against a
 * landed fixture, with the OFFLINE probes unless `network` is given.
 */
async function runLanded(
  fx: LandedFixture,
  o: {
    cli?: string;
    env?: Record<string, string>;
    viaRun?: boolean;
    network?: NetworkProbes;
  } = {},
): Promise<Run> {
  const summaryPath = path.join(tmp, "summary.md");
  fs.writeFileSync(summaryPath, "");
  const argv = ["--repository", REPO, "--repo", fx.repo, "--github-keys", fx.keysFile];
  const opts = {
    env: {
      PATH: process.env.PATH,
      HOME: tmp,
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: fx.tip,
      TRUSTED_TIP: fx.tip,
      LANDED_COMMIT: fx.squash,
      GITHUB_STEP_SUMMARY: summaryPath,
      ...o.env,
    },
    policyRoot: fx.repo,
    verifyCli: o.cli ?? VERIFY_CLI,
    network: o.network ?? OFFLINE,
  };
  const code = o.viaRun ? await runReport(["landed", ...argv], opts) : await mainLanded(argv, opts);
  return {
    code,
    summary: fs.readFileSync(summaryPath, "utf-8"),
    stubRan: fs.existsSync(path.join(tmp, "stub-ran")),
  };
}

async function landed(o: LandedOptions = {}): Promise<LandedFixture> {
  return landedFixture(tmp, o);
}

const NOT_ACCEPTED_JSON = JSON.stringify({
  accepted: false,
  verdict: {
    integrity: "verified",
    identityBinding: "pinned",
    authority: "unknown",
    revocation: { status: "fresh" },
  },
  outcome: "completed",
  diagnostics: { failures: [] },
});

describe("governed-change-report landed end to end", () => {
  it("a landed change that verifies concludes VERIFIED (exit 0), the inputs and every axis in the summary", async () => {
    const fx = await landed();
    const r = await runLanded(fx, { viaRun: true });
    expect(r.summary).toContain("## governed-change landed: VERIFIED");
    for (const row of [
      `| landed commit | ${fx.squash} |`,
      `| trusted tip | ${fx.tip} |`,
      `| parent | ${fx.parent} |`,
      "| evaluation basis | operator_recorded |",
      "| integrity | verified |",
      "| identityBinding | pinned |",
      "| authority | valid |",
      "| revocation | fresh |",
      "| outcome | completed |",
      "| accepted | true |",
    ]) {
      expect(r.summary, row).toContain(row);
    }
    expect(r.code).toBe(0);
  }, 60_000);

  it("a revoked change concludes NOT VERIFIED (exit 1), revocation revoked in the summary", async () => {
    const fx = await landed({ revoked: true });
    const r = await runLanded(fx);
    expect(r.summary).toContain("## governed-change landed: NOT VERIFIED");
    expect(r.summary).toContain("| revocation | revoked |");
    expect(r.code).toBe(1);
  }, 60_000);

  it("an unsigned landing (no accepted landing time) concludes NOT VERIFIED (exit 1), authority unknown", async () => {
    const fx = await landed({ sign: false });
    const r = await runLanded(fx);
    expect(r.summary).toContain("## governed-change landed: NOT VERIFIED");
    expect(r.summary).toContain("| authority | unknown |");
    expect(r.code).toBe(1);
  }, 60_000);

  it("a verifier that exits 0 without accepted: true is not VERIFIED", async () => {
    const fx = await landed();
    const r = await runLanded(fx, { cli: stubCli(0, NOT_ACCEPTED_JSON) });
    expect(r.stubRan).toBe(true);
    expect(r.summary).toContain("## governed-change landed: NOT VERIFIED");
    expect(r.code).toBe(1);
  }, 60_000);

  it("a verifier that reports accepted: true but exits 1 is not VERIFIED", async () => {
    const fx = await landed();
    const json = JSON.stringify({ ...JSON.parse(NOT_ACCEPTED_JSON), accepted: true });
    const r = await runLanded(fx, { cli: stubCli(1, json) });
    expect(r.summary).toContain("## governed-change landed: NOT VERIFIED");
    expect(r.code).toBe(1);
  }, 60_000);

  it("the verifier unable to judge (its exit 2) concludes NOT JUDGED (exit 1), its error in the summary", async () => {
    const fx = await landed();
    const cli = stubCli(2, "", "motebit-verify: repo-change: not judged: shallow clone");
    const r = await runLanded(fx, { cli });
    expect(r.stubRan).toBe(true);
    expect(r.summary).toContain("## governed-change landed: NOT JUDGED");
    expect(r.summary).toContain("not judged: shallow clone");
    expect(r.code).toBe(1);
  }, 60_000);

  it("a squash commit not on the trusted tip's first-parent chain is not VERIFIED", async () => {
    const fx = await landed({ sideBranch: true });
    const r = await runLanded(fx);
    expect(r.summary).not.toContain("## governed-change landed: VERIFIED");
    expect(r.code).toBe(1);
  }, 60_000);
});

describe("governed-change-report landed end to end: the no-network proof precedes the verifier", () => {
  it("a failed proof is NOT JUDGED (exit 1) and the verifier never runs", async () => {
    const fx = await landed();
    const r = await runLanded(fx, {
      cli: stubCli(0, '{"accepted":true}'),
      network: { ...OFFLINE, interfaces: WITH_ETH0 },
    });
    expect(r.stubRan).toBe(false);
    expect(r.summary).toContain("## governed-change landed: NOT JUDGED");
    expect(r.summary).toContain("no-network proof failed");
    expect(r.code).toBe(1);
  }, 60_000);

  // The real interface probe only: it reads this host's interfaces and sends
  // nothing. The real lookup and connect would make network traffic in a
  // test run, so they stay stubbed (their rules are the unit tests above).
  it("on this test host the REAL interface probe fails the proof and the verifier never runs", async () => {
    const fx = await landed();
    const r = await runLanded(fx, {
      cli: stubCli(0, '{"accepted":true}'),
      network: { ...OFFLINE, interfaces: REAL_PROBES.interfaces },
    });
    expect(r.stubRan).toBe(false);
    expect(r.summary).toContain("no-network proof failed");
    expect(r.summary).toContain("a network interface other than loopback");
    expect(r.code).toBe(1);
  }, 60_000);
});

describe("governed-change-report landed end to end: the provenance self-check", () => {
  const cases: Array<[string, (fx: LandedFixture) => Record<string, string>]> = [
    ["an event other than workflow_dispatch", () => ({ GITHUB_EVENT_NAME: "push" })],
    ["a ref other than refs/heads/main", () => ({ GITHUB_REF: "refs/heads/feature" })],
    ["an uppercase landed commit", (fx) => ({ LANDED_COMMIT: fx.squash.toUpperCase() })],
    ["a landed commit with a trailing newline", (fx) => ({ LANDED_COMMIT: `${fx.squash}\n` })],
    ["a short landed commit", (fx) => ({ LANDED_COMMIT: fx.squash.slice(0, 12) })],
    ["a checkout that is not TRUSTED_TIP", () => ({ TRUSTED_TIP: S("9") })],
    ["a checkout that is not GITHUB_SHA", () => ({ GITHUB_SHA: S("9") })],
  ];
  for (const [title, env] of cases) {
    it(`${title} is NOT JUDGED (exit 1), the verifier never run`, async () => {
      const fx = await landed();
      const r = await runLanded(fx, { cli: stubCli(0, '{"accepted":true}'), env: env(fx) });
      expect(r.stubRan).toBe(false);
      expect(r.summary).toContain("## governed-change landed: NOT JUDGED");
      expect(r.summary).toContain("provenance self-check failed");
      expect(r.code).toBe(1);
    }, 60_000);
  }

  it("the landed mode never writes to the repository it judges", async () => {
    const fx = await landed();
    const refs = (): string =>
      execFileSync("git", ["for-each-ref"], { cwd: fx.repo, encoding: "utf8" });
    const before = refs();
    await runLanded(fx);
    expect(refs()).toBe(before);
  }, 60_000);
});
