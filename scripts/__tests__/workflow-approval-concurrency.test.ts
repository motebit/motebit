/**
 * workflow-approval-concurrency — a job waiting on human approval must not
 * hold a concurrency group that unattended work needs.
 *
 * Observed 2026-11-14/15: archetype-conformance.yml had ONE workflow-level
 * group. Its `prod-presence` job sits behind `environment: production`
 * (required reviewer); a manual dispatch waited ~13 h for approval and,
 * holding the group, kept the daily SCHEDULED staging run pending with no
 * jobs. scripts/check-promotion-ready.ts needs the last five scheduled runs
 * green, so a blocked or replaced scheduled run breaks promotion readiness.
 *
 * Two halves, both over the REAL .github/workflows/*.yml:
 *   1. the pin for archetype-conformance.yml (per-job groups, staging
 *      shared with no production job);
 *   2. the class rule for every workflow:
 *        (a) no workflow-level concurrency group when the workflow has both
 *            a job behind `environment: production` and one that is not;
 *        (b) no two jobs of one workflow share a job-level group when
 *            exactly one of them is behind `environment: production`;
 *        (c) concurrency groups are repo-wide, so no LITERAL group name is
 *            held by a production job in one workflow and a non-production
 *            job in another.
 *
 * Limits, stated: groups are compared as written (expressions are not
 * evaluated; (c) skips any group containing `${{`). "Behind production" is
 * read from the `environment:` key; a caller of a local reusable workflow
 * counts as one job, behind production when any job of the callee is. Other
 * environments (npm-publish, staging) are outside the rule: whether they
 * require a reviewer is a GitHub setting this repo cannot read.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WF_DIR = join(ROOT, ".github", "workflows");
const APPROVAL_ENV = "production";

type Yaml = Record<string, unknown>;
interface Job {
  id: string;
  /** The job-level group as written, or null. */
  group: string | null;
  production: boolean;
}
interface Workflow {
  file: string;
  /** The workflow-level group as written, or null. */
  group: string | null;
  jobs: Job[];
}

function groupOf(node: unknown): string | null {
  if (node === undefined || node === null) return null;
  if (typeof node === "string") return node;
  const g = (node as Yaml).group;
  if (typeof g !== "string") throw new Error(`concurrency without a string group: ${String(g)}`);
  return g;
}

function envName(node: unknown): string | null {
  if (node === undefined || node === null) return null;
  if (typeof node === "string") return node;
  const n = (node as Yaml).name;
  return typeof n === "string" ? n : null;
}

/** Parse workflow sources ({ file: yaml text }) into the shape the rule reads. */
function load(sources: Record<string, string>): Workflow[] {
  const docs = new Map<string, Yaml>();
  for (const [file, text] of Object.entries(sources)) docs.set(file, parse(text) as Yaml);
  const jobsOf = (doc: Yaml) => Object.entries((doc.jobs ?? {}) as Record<string, Yaml>);
  const direct = (job: Yaml) => envName(job.environment) === APPROVAL_ENV;
  const production = (job: Yaml, seen: string[]): boolean => {
    if (direct(job)) return true;
    const uses = typeof job.uses === "string" ? job.uses : "";
    const m = /^\.\/\.github\/workflows\/([^@]+)$/.exec(uses);
    if (!m) return false;
    const callee = m[1] as string;
    const doc = docs.get(callee);
    if (!doc) throw new Error(`reusable workflow ${callee} not found`);
    if (seen.includes(callee)) return false;
    return jobsOf(doc).some(([, j]) => production(j, [...seen, callee]));
  };
  return [...docs.entries()].map(([file, doc]) => ({
    file,
    group: groupOf(doc.concurrency),
    jobs: jobsOf(doc).map(([id, job]) => ({
      id,
      group: groupOf(job.concurrency),
      production: production(job, [file]),
    })),
  }));
}

/** Every breach of the class rule, as a repair-carrying sentence. */
function violations(workflows: Workflow[]): string[] {
  const out: string[] = [];
  const holders = new Map<string, { production: string[]; unattended: string[] }>();
  const hold = (group: string, job: Job, file: string) => {
    if (group.includes("${{")) return;
    const h = holders.get(group) ?? { production: [], unattended: [] };
    (job.production ? h.production : h.unattended).push(`${file}#${job.id}`);
    holders.set(group, h);
  };
  for (const wf of workflows) {
    const prod = wf.jobs.filter((j) => j.production);
    const rest = wf.jobs.filter((j) => !j.production);
    if (wf.group !== null && prod.length > 0 && rest.length > 0) {
      out.push(
        `${wf.file}: workflow-level concurrency group "${wf.group}" is held by ` +
          `${prod.map((j) => j.id).join(", ")} (behind environment: ${APPROVAL_ENV}) while waiting for ` +
          `approval, blocking ${rest.map((j) => j.id).join(", ")}. Remove the workflow-level group and give each job its own.`,
      );
    }
    for (const a of prod) {
      for (const b of rest) {
        if (a.group !== null && a.group === b.group) {
          out.push(
            `${wf.file}: jobs ${a.id} (behind environment: ${APPROVAL_ENV}) and ${b.id} share the ` +
              `job-level group "${a.group}". Give ${a.id} a group of its own.`,
          );
        }
      }
    }
    for (const job of wf.jobs) {
      if (wf.group !== null) hold(wf.group, job, wf.file);
      if (job.group !== null) hold(job.group, job, wf.file);
    }
  }
  for (const [group, h] of holders) {
    const files = (xs: string[]) => new Set(xs.map((x) => x.split("#")[0]));
    const cross = h.production.some((p) =>
      h.unattended.some((u) => u.split("#")[0] !== p.split("#")[0]),
    );
    if (cross && files(h.production).size > 0) {
      out.push(
        `group "${group}" is held by ${h.production.join(", ")} (behind environment: ${APPROVAL_ENV}) ` +
          `and by ${h.unattended.join(", ")} in another workflow; groups are repo-wide. Rename one.`,
      );
    }
  }
  return out;
}

const FILES = readdirSync(WF_DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort();
const REAL = load(Object.fromEntries(FILES.map((f) => [f, readFileSync(join(WF_DIR, f), "utf8")])));

describe("archetype-conformance.yml: approval never blocks the scheduled staging probe", () => {
  const wf = REAL.find((w) => w.file === "archetype-conformance.yml") as Workflow;
  const job = (id: string) => wf.jobs.find((j) => j.id === id) as Job;

  it("has no workflow-level concurrency group", () => {
    expect(wf.group).toBeNull();
  });

  it("every job has its own group, and no two jobs share one", () => {
    expect(wf.jobs.map((j) => j.id).sort()).toEqual(["conformance", "prod-presence"]);
    const groups = wf.jobs.map((j) => j.group);
    expect(groups.every((g) => typeof g === "string" && g.length > 0)).toBe(true);
    expect(new Set(groups).size).toBe(wf.jobs.length);
    expect(job("conformance").group).toBe("archetype-conformance-staging");
    expect(job("prod-presence").group).toBe("archetype-conformance-prod-presence");
  });

  it("the scheduled staging job's group is shared with no job behind environment: production", () => {
    expect(job("conformance").production).toBe(false);
    expect(job("prod-presence").production).toBe(true);
    const staging = job("conformance").group;
    const sharers = REAL.flatMap((w) =>
      w.jobs
        .filter((j) => j.production && (j.group === staging || w.group === staging))
        .map((j) => `${w.file}#${j.id}`),
    );
    expect(sharers).toEqual([]);
  });

  it("neither job cancels a running probe", () => {
    const doc = parse(readFileSync(join(WF_DIR, wf.file), "utf8")) as {
      jobs: Record<string, { concurrency: Yaml }>;
    };
    for (const id of ["conformance", "prod-presence"]) {
      expect(doc.jobs[id]?.concurrency["cancel-in-progress"]).toBe(false);
    }
  });
});

describe("class rule: a job behind environment: production shares no concurrency group with unattended work", () => {
  it("reads every workflow, and finds the production jobs it should", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(20);
    const prod = REAL.flatMap((w) => w.jobs.filter((j) => j.production).map(() => w.file));
    expect(prod).toContain("archetype-conformance.yml");
    expect(prod).toContain("deploy-clerk.yml");
  });

  it("no workflow under .github/workflows breaks the rule", () => {
    expect(violations(REAL)).toEqual([]);
  });

  const wf = (body: string) => `on: push\n${body}`;
  const JOBS = (a: string, b: string) =>
    `jobs:\n  staging:\n    runs-on: x\n${a}  prod:\n    runs-on: x\n    environment: production\n${b}`;
  const GROUP = (g: string) => `    concurrency:\n      group: ${g}\n`;

  it("(a) refuses a workflow-level group over a production job and an unattended job", () => {
    const v = violations(load({ "w.yml": wf(`concurrency:\n  group: g\n${JOBS("", "")}`) }));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/w\.yml: workflow-level concurrency group "g" is held by prod/);
  });

  it("(a) allows a workflow-level group when every job, or no job, is behind production", () => {
    const all = `concurrency: g\njobs:\n  prod:\n    runs-on: x\n    environment:\n      name: production\n`;
    const none = `concurrency: h\njobs:\n  a:\n    runs-on: x\n    environment: staging\n`;
    expect(violations(load({ "all.yml": wf(all), "none.yml": wf(none) }))).toEqual([]);
  });

  it("(b) refuses a job-level group shared by a production job and an unattended job", () => {
    const v = violations(load({ "w.yml": wf(JOBS(GROUP("g"), GROUP("g"))) }));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/jobs prod \(behind environment: production\) and staging share/);
    expect(violations(load({ "w.yml": wf(JOBS(GROUP("g"), GROUP("h"))) }))).toEqual([]);
  });

  it("(b) compares expression groups as written", () => {
    const g = "x-${{ github.ref }}";
    expect(violations(load({ "w.yml": wf(JOBS(GROUP(g), GROUP(g))) }))).toHaveLength(1);
  });

  it("a caller of a reusable workflow is a job, behind production when the callee is", () => {
    const callee = `on: workflow_call\njobs:\n  deploy:\n    runs-on: x\n    environment: production\n`;
    const caller = (uses: string) =>
      wf(
        `concurrency: g\njobs:\n  call:\n    uses: ${uses}\n  other:\n    runs-on: x\n` +
          `  third:\n    uses: org/repo/.github/workflows/x.yml@v1\n`,
      );
    const v = violations(
      load({ "callee.yml": callee, "w.yml": caller("./.github/workflows/callee.yml") }),
    );
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/held by call .* blocking other, third/);
    const plain = `on: workflow_call\njobs:\n  j:\n    runs-on: x\n`;
    expect(
      violations(load({ "callee.yml": plain, "w.yml": caller("./.github/workflows/callee.yml") })),
    ).toEqual([]);
  });

  it("(c) refuses a literal group held by a production job and an unattended job in another workflow", () => {
    const a = wf(`jobs:\n  prod:\n    runs-on: x\n    environment: production\n${GROUP("g")}`);
    const b = wf(`concurrency:\n  group: g\njobs:\n  nightly:\n    runs-on: x\n`);
    const v = violations(load({ "a.yml": a, "b.yml": b }));
    expect(v).toEqual([
      'group "g" is held by a.yml#prod (behind environment: production) and by b.yml#nightly in another workflow; groups are repo-wide. Rename one.',
    ]);
    const expr = "g-${{ github.ref }}";
    const a2 = a.replace("group: g", `group: ${expr}`);
    const b2 = b.replace("group: g", `group: ${expr}`);
    expect(violations(load({ "a.yml": a2, "b.yml": b2 }))).toEqual([]);
  });
});
