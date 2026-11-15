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
 *   1. the pin for archetype-conformance.yml (no workflow-level group; only
 *      the staging job has a group; the job behind production has none);
 *   2. the class rule for every workflow:
 *        (a) no workflow-level concurrency group when the workflow has both
 *            a job behind `environment: production` and one that is not;
 *        (b) no two jobs of one workflow share a job-level group when
 *            exactly one of them is behind `environment: production`;
 *        (c) concurrency groups are repo-wide, so no LITERAL group name is
 *            held by a production job in one workflow and a non-production
 *            job in another.
 *
 * How a job is modelled: each job carries two facts, `production` (it, or
 * work it runs, waits on the production reviewer) and `unattended` (it, or
 * work it runs, does not). An ordinary job has exactly one. A caller of a
 * local reusable workflow (`./.github/workflows/x.yml`) is one job that
 * carries the UNION of its callee's jobs, recursively through nested local
 * callees: a callee with both a production job and an unattended job makes
 * its caller BOTH. So a workflow-level group over such a caller, or a
 * job-level group on it, is a breach on its own — the group spans the
 * callee's approval wait and the callee's unattended work (the 2026-11-14
 * shape, through a callee).
 *
 * Limits, stated: group names are compared lowercased (GitHub treats them
 * case-insensitively) and otherwise as written (expressions are not
 * evaluated; (c) skips any group containing `${{`). "Behind production" is
 * read from the `environment:` key, compared case-insensitively (GitHub
 * environment names are). What cannot be decided offline FAILS CLOSED: an
 * environment name built from an expression, and a reusable workflow in
 * another repository (`org/repo/.github/workflows/x.yml@ref`), whose jobs
 * this test cannot read. Other environments (npm-publish, staging) are
 * outside the rule: whether they require a reviewer is a GitHub setting this
 * repo cannot read. The rule does not cover the pending-run replacement
 * GitHub applies inside one group (a newer waiting run replaces an older
 * waiting one unless `queue: max` is set).
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
  /** The job-level group, lowercased, or null. */
  group: string | null;
  /** It, or (for a caller) some job of its callee, is behind `environment: production`. */
  production: boolean;
  /** It, or (for a caller) some job of its callee, is not. */
  unattended: boolean;
}
interface Workflow {
  file: string;
  /** The workflow-level group, lowercased, or null. */
  group: string | null;
  jobs: Job[];
}

/** The group name, lowercased: GitHub treats concurrency group names case-insensitively. */
function groupOf(node: unknown, where: string): string | null {
  if (node === undefined || node === null) return null;
  if (typeof node === "string") return node.toLowerCase();
  const g = (node as Yaml).group;
  if (typeof g !== "string") {
    throw new Error(
      `${where}: concurrency without a string group (${JSON.stringify(g)}). Write \`group:\` as a string.`,
    );
  }
  return g.toLowerCase();
}

/** The environment name, lowercased (GitHub compares them case-insensitively), or null. */
function envName(node: unknown, where: string): string | null {
  if (node === undefined || node === null) return null;
  const n = typeof node === "string" ? node : (node as Yaml).name;
  if (typeof n !== "string") {
    throw new Error(
      `${where}: environment without a string name (${JSON.stringify(n)}). Name the environment literally.`,
    );
  }
  if (n.includes("${{")) {
    throw new Error(
      `${where}: environment "${n}" is an expression, so whether the job waits on the ` +
        `${APPROVAL_ENV} reviewer cannot be decided offline. Name the environment literally ` +
        `(one job per environment), or teach scripts/__tests__/workflow-approval-concurrency.test.ts the expression.`,
    );
  }
  return n.toLowerCase();
}

/** Parse workflow sources ({ file: yaml text }) into the shape the rule reads. */
function load(sources: Record<string, string>): Workflow[] {
  const docs = new Map<string, Yaml>();
  for (const [file, text] of Object.entries(sources)) docs.set(file, parse(text) as Yaml);
  const jobsOf = (doc: Yaml) => Object.entries((doc.jobs ?? {}) as Record<string, Yaml>);
  type Kind = { production: boolean; unattended: boolean };
  const kind = (job: Yaml, where: string, seen: string[]): Kind => {
    const own = envName(job.environment, where) === APPROVAL_ENV;
    const uses = typeof job.uses === "string" ? job.uses : "";
    if (uses === "") return { production: own, unattended: !own };
    const m = /^\.\/\.github\/workflows\/([^@]+)$/.exec(uses);
    if (!m) {
      throw new Error(
        `${where}: \`uses: ${uses}\` calls a reusable workflow this test cannot read offline, so ` +
          `whether the job waits on the ${APPROVAL_ENV} reviewer is unknown. Call a workflow in this ` +
          `repo (./.github/workflows/<file>), or teach scripts/__tests__/workflow-approval-concurrency.test.ts about it.`,
      );
    }
    const callee = m[1] as string;
    const doc = docs.get(callee);
    if (!doc) {
      throw new Error(`${where}: reusable workflow ${callee} not found under .github/workflows`);
    }
    // A caller carries the union of its callee's jobs (recursively). A cycle
    // contributes nothing new: the jobs on it are already being counted.
    if (seen.includes(callee)) return { production: own, unattended: false };
    const inner = jobsOf(doc).map(([id, j]) => kind(j, `${callee}#${id}`, [...seen, callee]));
    const production = own || inner.some((k) => k.production);
    return { production, unattended: !own && (inner.some((k) => k.unattended) || !production) };
  };
  return [...docs.entries()].map(([file, doc]) => ({
    file,
    group: groupOf(doc.concurrency, file),
    jobs: jobsOf(doc).map(([id, job]) => ({
      id,
      group: groupOf(job.concurrency, `${file}#${id}`),
      ...kind(job, `${file}#${id}`, [file]),
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
    if (job.production) h.production.push(`${file}#${job.id}`);
    if (job.unattended) h.unattended.push(`${file}#${job.id}`);
    holders.set(group, h);
  };
  for (const wf of workflows) {
    const prod = wf.jobs.filter((j) => j.production);
    const rest = wf.jobs.filter((j) => j.unattended);
    if (wf.group !== null && prod.length > 0 && rest.length > 0) {
      out.push(
        `${wf.file}: workflow-level concurrency group "${wf.group}" is held by ` +
          `${prod.map((j) => j.id).join(", ")} (behind environment: ${APPROVAL_ENV}) while waiting for ` +
          `approval, blocking ${rest.map((j) => j.id).join(", ")}. Remove the workflow-level group and give each job its own.`,
      );
    }
    for (const a of prod) {
      if (a.group !== null && a.unattended) {
        out.push(
          `${wf.file}: job ${a.id} calls a reusable workflow that has both a job behind environment: ` +
            `${APPROVAL_ENV} and one that is not, and holds the job-level group "${a.group}" over all of ` +
            `it. Drop the group from the caller and give the callee's jobs their own.`,
        );
      }
      for (const b of rest) {
        if (a !== b && a.group !== null && a.group === b.group) {
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

  it("the scheduled staging job has the staging group and is not behind production", () => {
    expect(wf.jobs.map((j) => j.id).sort()).toEqual(["conformance", "prod-presence"]);
    expect(job("conformance").production).toBe(false);
    expect(job("conformance").group).toBe("archetype-conformance-staging");
  });

  it("no job behind environment: production declares a concurrency group", () => {
    const prod = wf.jobs.filter((j) => j.production);
    expect(prod.map((j) => j.id)).toEqual(["prod-presence"]);
    expect(prod.map((j) => j.group)).toEqual([null]);
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

  it("a running staging probe is never cancelled", () => {
    const doc = parse(readFileSync(join(WF_DIR, wf.file), "utf8")) as {
      jobs: Record<string, { concurrency?: Yaml }>;
    };
    expect(doc.jobs.conformance?.concurrency).toEqual({
      group: "archetype-conformance-staging",
      "cancel-in-progress": false,
    });
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
    const caller = wf(
      `concurrency: g\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n  other:\n    runs-on: x\n`,
    );
    const v = violations(load({ "callee.yml": callee, "w.yml": caller }));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/held by call .* blocking other\./);
    const plain = `on: workflow_call\njobs:\n  j:\n    runs-on: x\n`;
    expect(violations(load({ "callee.yml": plain, "w.yml": caller }))).toEqual([]);
  });

  it("a caller carries the UNION of its callee's jobs: a mixed callee under a workflow-level group", () => {
    const mixed = `on: workflow_call\njobs:\n  probe:\n    runs-on: x\n  deploy:\n    runs-on: x\n    environment: production\n`;
    const caller = wf(`concurrency: g\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n`);
    const v = violations(load({ "callee.yml": mixed, "w.yml": caller }));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(
      /^w\.yml: workflow-level concurrency group "g" is held by call .* blocking call\./,
    );
    // Nested: the mixed callee is reached through a second local callee.
    const middle = `on: workflow_call\njobs:\n  inner:\n    uses: ./.github/workflows/callee.yml\n`;
    const outer = wf(`concurrency: g\njobs:\n  call:\n    uses: ./.github/workflows/middle.yml\n`);
    const nested = violations(load({ "callee.yml": mixed, "middle.yml": middle, "w.yml": outer }));
    expect(nested).toHaveLength(1);
    expect(nested[0]).toMatch(/^w\.yml: workflow-level concurrency group "g"/);
    // No group on the caller workflow: nothing spans the two.
    const bare = wf(`jobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n`);
    expect(violations(load({ "callee.yml": mixed, "w.yml": bare }))).toEqual([]);
  });

  it("a caller carries the UNION of its callee's jobs: a mixed callee under the caller's job-level group", () => {
    const mixed = `on: workflow_call\njobs:\n  probe:\n    runs-on: x\n  deploy:\n    runs-on: x\n    environment: production\n`;
    const caller = wf(
      `jobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n    concurrency:\n      group: g\n`,
    );
    const v = violations(load({ "callee.yml": mixed, "w.yml": caller }));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(
      /^w\.yml: job call calls a reusable workflow that has both .* job-level group "g"/,
    );
    // A callee that is production-only, or unattended-only, may be grouped by its caller.
    const prodOnly = `on: workflow_call\njobs:\n  deploy:\n    runs-on: x\n    environment: production\n`;
    const plain = `on: workflow_call\njobs:\n  probe:\n    runs-on: x\n`;
    expect(violations(load({ "callee.yml": prodOnly, "w.yml": caller }))).toEqual([]);
    expect(violations(load({ "callee.yml": plain, "w.yml": caller }))).toEqual([]);
  });

  it("group names are compared case-insensitively: (b) in one workflow, (c) across workflows", () => {
    expect(violations(load({ "w.yml": wf(JOBS(GROUP("g"), GROUP("G"))) }))).toHaveLength(1);
    const a = wf(`jobs:\n  prod:\n    runs-on: x\n    environment: production\n${GROUP("Deploy")}`);
    const b = wf(`concurrency:\n  group: deploy\njobs:\n  nightly:\n    runs-on: x\n`);
    const v = violations(load({ "a.yml": a, "b.yml": b }));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/^group "deploy" is held by a\.yml#prod .* and by b\.yml#nightly/);
    // The shorthand form (`concurrency: <string>`) is lowercased too.
    const SHORT = (g: string) => `    concurrency: ${g}\n`;
    expect(violations(load({ "w.yml": wf(JOBS(SHORT("g"), SHORT("G"))) }))).toHaveLength(1);
    const c = wf(`jobs:\n  prod:\n    runs-on: x\n    environment: production\n${SHORT("Deploy")}`);
    const d = wf(`concurrency: deploy\njobs:\n  nightly:\n    runs-on: x\n`);
    expect(violations(load({ "c.yml": c, "d.yml": d }))).toHaveLength(1);
  });

  it("the environment name is compared case-insensitively, in both forms", () => {
    for (const env of ["environment: Production", "environment:\n      name: PRODUCTION"]) {
      const body = `concurrency: g\njobs:\n  a:\n    runs-on: x\n  prod:\n    runs-on: x\n    ${env}\n`;
      expect(violations(load({ "w.yml": wf(body) }))).toHaveLength(1);
    }
  });

  it("fails closed, naming the file and job, on an environment built from an expression", () => {
    const expr = "${{ inputs.target }}";
    for (const env of [`environment: ${expr}`, `environment:\n      name: ${expr}\n      url: u`]) {
      const body = `jobs:\n  deploy:\n    runs-on: x\n    ${env}\n`;
      expect(() => load({ "w.yml": wf(body) })).toThrow(
        /^w\.yml#deploy: environment "\$\{\{ inputs\.target \}\}" is an expression.*Name the environment literally/,
      );
    }
    const callee = `on: workflow_call\njobs:\n  inner:\n    runs-on: x\n    environment: ${expr}\n`;
    const caller = wf(`jobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n`);
    expect(() => load({ "w.yml": caller, "callee.yml": callee })).toThrow(/^callee\.yml#inner: /);
  });

  it("fails closed on a reusable workflow it cannot read (another repository, or a missing file)", () => {
    const call = (uses: string) => wf(`jobs:\n  call:\n    uses: ${uses}\n`);
    expect(() => load({ "w.yml": call("org/repo/.github/workflows/x.yml@v1") })).toThrow(
      /^w\.yml#call: `uses: org\/repo\/\.github\/workflows\/x\.yml@v1` calls a reusable workflow this test cannot read offline/,
    );
    expect(() => load({ "w.yml": call("./.github/workflows/gone.yml") })).toThrow(
      /^w\.yml#call: reusable workflow gone\.yml not found/,
    );
  });

  it("names the file in a concurrency block without a string group", () => {
    const top = wf(`concurrency:\n  cancel-in-progress: true\njobs:\n  a:\n    runs-on: x\n`);
    expect(() => load({ "w.yml": top })).toThrow(/^w\.yml: concurrency without a string group/);
    const inJob = wf(`jobs:\n  a:\n    runs-on: x\n    concurrency:\n      group: 7\n`);
    expect(() => load({ "w.yml": inJob })).toThrow(
      /^w\.yml#a: concurrency without a string group \(7\)/,
    );
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
