/**
 * check-merge-queue-readiness — fixture round-trips.
 *
 * Each rule is proven both ways: a known-bad workflow fixture must produce the
 * rule's violation, and the corrected fixture must produce none. The naive
 * "just add `merge_group:`" fixture is the load-bearing one — it is the change
 * that LOOKS done while leaving required checks skipped (vacuous success) or
 * diffing against pull_request-only context.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluate,
  evalUnderMergeGroup,
  parseWorkflow,
  stripInlineComment,
} from "../check-merge-queue-readiness.js";
import { hasApertureDisclosure, hasRepairInstruction } from "../lib/gate-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(ROOT, "scripts", "check-merge-queue-readiness.ts");

const REQUIRED = ["check", "sibling-audit", "cla"];

/** Pre-merge-queue shape: PR-gated jobs, no merge_group anywhere. */
const CI_PR_ONLY = `name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm check
  sibling-audit:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - run: git diff --name-only origin/\${{ github.base_ref }}...HEAD | npx tsx scripts/check-sibling-boundaries.ts
`;

/** The trap: merge_group added, nothing else — skipped + PR-context diff. */
const CI_NAIVE = CI_PR_ONLY.replace(
  "  pull_request:\n    branches: [main]\n",
  "  pull_request:\n    branches: [main]\n  merge_group:\n    types: [checks_requested]\n",
);

const CI_READY = `name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  merge_group:
    types: [checks_requested]
concurrency:
  group: \${{ github.workflow }}-\${{ github.event_name == 'merge_group' && github.event.merge_group.head_ref || github.ref }}
  cancel-in-progress: \${{ github.event_name != 'merge_group' }}
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm check
  sibling-audit:
    if: github.event_name == 'pull_request' || github.event_name == 'merge_group'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: base
        env:
          PR_BASE_REF: \${{ github.base_ref }}
          MG_BASE_SHA: \${{ github.event.merge_group.base_sha }}
        run: bash scripts/ci-diff-base.sh
      - run: git diff --name-only "\${{ steps.base.outputs.base }}" HEAD | npx tsx scripts/check-sibling-boundaries.ts
`;

const CLA_PR_ONLY = `name: CLA
on:
  issue_comment:
    types: [created]
  pull_request_target:
    types: [opened, closed, synchronize]
jobs:
  cla:
    runs-on: ubuntu-latest
    if: |
      (github.event.comment.body == 'I have read the CLA Document and I hereby sign the CLA' ||
       github.event_name == 'pull_request_target')
    steps:
      - uses: contributor-assistant/github-action@v2
`;

const CLA_NAIVE = CLA_PR_ONLY.replace(
  "jobs:",
  "  merge_group:\n    types: [checks_requested]\njobs:",
);

/** Job runs; the real step is skipped; no stated pass-through. */
const CLA_SILENT_STEP_SKIP = `name: CLA
on:
  pull_request_target:
    types: [opened]
  merge_group:
    types: [checks_requested]
jobs:
  cla:
    runs-on: ubuntu-latest
    if: github.event_name == 'merge_group' || github.event_name == 'pull_request_target'
    steps:
      - name: CLA Assistant
        if: github.event_name != 'merge_group'
        uses: contributor-assistant/github-action@v2
`;

const CLA_READY = `name: CLA
on:
  issue_comment:
    types: [created]
  pull_request_target:
    types: [opened, closed, synchronize]
  merge_group:
    types: [checks_requested]
jobs:
  cla:
    runs-on: ubuntu-latest
    if: |
      github.event_name == 'merge_group' ||
      (github.event.comment.body == 'I have read the CLA Document and I hereby sign the CLA' ||
       github.event_name == 'pull_request_target')
    steps:
      - name: Merge queue — CLA verdict carries over from the PR
        if: github.event_name == 'merge_group'
        run: echo "carried over"
      - name: CLA Assistant
        if: github.event_name != 'merge_group'
        uses: contributor-assistant/github-action@v2
`;

const DEPLOY_WITH_MG = `name: Deploy
on:
  push:
    branches: [main]
  merge_group:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: flyctl deploy
`;

const rules = (files: Array<{ path: string; source: string }>) =>
  evaluate(files, REQUIRED).violations.map((v) => `${v.rule} ${v.site}`);

describe("check-merge-queue-readiness — expression evaluation under merge_group", () => {
  it.each([
    ["github.event_name == 'pull_request'", false],
    ["github.event_name == 'merge_group'", true],
    ["github.event_name != 'merge_group'", false],
    ["${{ github.event_name == 'pull_request' || github.event_name == 'merge_group' }}", true],
    ["github.event.comment.body == 'I sign' || github.event_name == 'pull_request_target'", false],
    ["github.event.pull_request.draft == false", false],
    ["github.event_name == 'push' || needs.changes.outputs.scripts == 'true'", "unknown"],
    ["always()", true],
    ["failure()", "unknown"],
    ["!cancelled() && github.event_name == 'merge_group'", true],
    ["contains(github.event.merge_group.head_ref, 'queue')", "unknown"],
  ] as const)("%s → %s", (expr, want) => {
    expect(evalUnderMergeGroup(expr)).toBe(want);
  });

  it("strips inline comments outside quotes only", () => {
    expect(stripInlineComment(`  run: echo "a # b" # trailing`)).toBe(`  run: echo "a # b"`);
    expect(stripInlineComment(`  timeout-minutes: 5 # why`)).toBe(`  timeout-minutes: 5`);
  });

  it("reads block-scalar ifs, names, needs and step ifs", () => {
    const wf = parseWorkflow("x.yml", CLA_READY);
    expect([...wf.events.keys()]).toEqual(["issue_comment", "pull_request_target", "merge_group"]);
    const cla = wf.jobs[0]!;
    expect(cla.checkName).toBe("cla");
    expect(cla.ifExpr).toContain("github.event_name == 'merge_group'");
    expect(cla.steps.map((s) => s.ifExpr)).toEqual([
      "github.event_name == 'merge_group'",
      "github.event_name != 'merge_group'",
    ]);
  });
});

describe("check-merge-queue-readiness — rules (fixture round-trips)", () => {
  it("R2: PR-only workflows producing required checks stall the queue", () => {
    const v = rules([
      { path: "ci.yml", source: CI_PR_ONLY },
      { path: "cla.yml", source: CLA_PR_ONLY },
    ]);
    expect(v).toEqual(["R2 ci.yml", "R2 cla.yml"]);
  });

  it("R3/R4/R6: the naive `merge_group:` addition is caught (vacuous skips, PR-context diff, cancelling group)", () => {
    const v = rules([
      { path: "ci.yml", source: CI_NAIVE },
      { path: "cla.yml", source: CLA_NAIVE },
    ]);
    expect(v.some((s) => s.startsWith("R3 ci.yml") && s.includes("sibling-audit"))).toBe(true);
    expect(v.some((s) => s.startsWith("R3 cla.yml") && s.includes("`cla`"))).toBe(true);
    expect(v.filter((s) => s.startsWith("R6 ci.yml"))).toHaveLength(2);
  });

  it("R4: a reachable job diffing against github.base_ref without merge_group handling is flagged", () => {
    const src = CI_NAIVE.replace(
      "if: github.event_name == 'pull_request'",
      "if: github.event_name == 'pull_request' || github.event_name == 'merge_group'",
    );
    const v = evaluate([{ path: "ci.yml", source: src }], ["check", "sibling-audit"]).violations;
    const r4 = v.filter((x) => x.rule === "R4");
    expect(r4).toHaveLength(1);
    expect(r4[0]!.detail).toContain("github.base_ref");
    expect(r4[0]!.detail).toContain("git diff");
  });

  it("R4: git diff without full history is flagged", () => {
    const src = CI_READY.replace("        with:\n          fetch-depth: 0\n", "");
    const v = evaluate([{ path: "ci.yml", source: src }], ["check", "sibling-audit"]).violations;
    expect(v.map((x) => x.rule)).toEqual(["R4"]);
    expect(v[0]!.detail).toContain("fetch-depth: 0");
  });

  it("R3: a required job skipping its real step without an explicit merge_group step is flagged", () => {
    const v = evaluate([{ path: "cla.yml", source: CLA_SILENT_STEP_SKIP }], ["cla"]).violations;
    expect(v.map((x) => x.rule)).toEqual(["R3"]);
    expect(v[0]!.detail).toContain("skips 1 step(s)");
  });

  it("R3: a required job whose `needs` is skipped under merge_group is flagged", () => {
    const src = `on:
  pull_request:
  merge_group:
jobs:
  build:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - run: true
  e2e:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: true
`;
    const v = evaluate([{ path: "ci.yml", source: src }], ["e2e"]).violations;
    expect(v.map((x) => x.rule)).toEqual(["R3"]);
  });

  it("R5: merge_group on a deploy workflow is flagged", () => {
    const v = rules([
      { path: "ci.yml", source: CI_READY },
      { path: "cla.yml", source: CLA_READY },
      { path: "deploy.yml", source: DEPLOY_WITH_MG },
    ]);
    expect(v).toEqual(["R5 deploy.yml"]);
  });

  it("R1: a required check nobody produces is flagged", () => {
    const v = evaluate([{ path: "ci.yml", source: CI_READY }], ["check", "ghost"]).violations;
    expect(v.map((x) => `${x.rule} ${x.detail.slice(0, 32)}`)).toEqual([
      "R1 required check `ghost` is produc",
    ]);
  });

  it("the merge-queue-ready fixtures pass", () => {
    expect(
      rules([
        { path: "ci.yml", source: CI_READY },
        { path: "cla.yml", source: CLA_READY },
      ]),
    ).toEqual([]);
  });
});

describe("check-merge-queue-readiness — CLI contract", () => {
  function fixtureRoot(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "mq-ready-"));
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(root, ".github", "required-checks.json"),
      JSON.stringify({ checks: REQUIRED }),
    );
    for (const [name, src] of Object.entries(files))
      writeFileSync(join(root, ".github", "workflows", name), src);
    return root;
  }

  it("fails with a repair instruction on the PR-only fixtures", () => {
    const root = fixtureRoot({ "ci.yml": CI_PR_ONLY, "cla.yml": CLA_PR_ONLY });
    const r = spawnSync("npx", ["tsx", SCRIPT, "--root", root], { encoding: "utf-8", cwd: ROOT });
    expect(r.status).toBe(1);
    expect(hasRepairInstruction(r.stdout + r.stderr).ok).toBe(true);
  });

  it("passes with an aperture disclosure on the ready fixtures", () => {
    const root = fixtureRoot({ "ci.yml": CI_READY, "cla.yml": CLA_READY });
    const r = spawnSync("npx", ["tsx", SCRIPT, "--root", root], { encoding: "utf-8", cwd: ROOT });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(hasApertureDisclosure(r.stdout).ok).toBe(true);
  });
});
