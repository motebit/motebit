/**
 * security-publish — every refusal of the plan check behind release.yml's
 * `security-publish` job, and the publish authority of every workflow: the
 * only jobs that can publish to npm (an id-token, a publish command, or a
 * changesets `publish:` input) are the two in release.yml that wait in the
 * founder-approved `npm-publish` environment. An ordinary push to main runs
 * only the prepare job, which has neither.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { parse } from "yaml";

import type { PublishablePackage, RegistryAnswer } from "../lib/publish-freshness.js";
import {
  packagesAhead,
  parsePackageList,
  planSecurityPublish,
  publishSteps,
  type PackedArtifact,
} from "../lib/security-publish.js";

function pkg(name: string, version: string, deps: Record<string, string> = {}): PublishablePackage {
  return { name, version, dir: `packages/${name}`, raw: { name, version, dependencies: deps } };
}

const crypto = pkg("@m/crypto", "4.0.1");
const verifier = pkg("@m/verifier", "1.14.2", { "@m/crypto": "workspace:*" });
const sdk = pkg("@m/sdk", "2.10.0");
const cli = pkg("cli", "2.2.2", { "@m/verifier": "workspace:^", "@m/sdk": "workspace:*" });
const workspace = [crypto, verifier, sdk, cli];

const published = (latest: string): RegistryAnswer => ({ kind: "published", latest });
const registry = new Map<string, RegistryAnswer>([
  ["@m/crypto", published("4.0.0")],
  ["@m/verifier", published("1.14.1")],
  ["@m/sdk", published("2.10.0")],
  ["cli", published("2.2.1")],
]);

function refusals(requested: string[], reg = registry, ws = workspace): string[] {
  const plan = planSecurityPublish(requested, ws, reg);
  return plan.ok ? [] : plan.refusals;
}

describe("planSecurityPublish", () => {
  it("accepts a dependency-ordered patch and records what it replaces", () => {
    const plan = planSecurityPublish(["@m/crypto", "@m/verifier", "cli"], workspace, registry);
    expect(plan).toEqual({
      ok: true,
      packages: [
        { name: "@m/crypto", version: "4.0.1", dir: "packages/@m/crypto", previous: "4.0.0" },
        { name: "@m/verifier", version: "1.14.2", dir: "packages/@m/verifier", previous: "1.14.1" },
        { name: "cli", version: "2.2.2", dir: "packages/cli", previous: "2.2.1" },
      ],
    });
  });

  it("refuses an empty list and a duplicate", () => {
    expect(refusals([])).toEqual(["the package list is empty"]);
    expect(refusals(["@m/crypto", "@m/crypto"])).toContain("@m/crypto is listed twice");
  });

  it("refuses a package that is not public in the workspace", () => {
    expect(refusals(["@m/market"])).toEqual(["@m/market is not a public workspace package"]);
  });

  it("refuses a version that is current, behind the registry, or a pre-release", () => {
    expect(refusals(["@m/sdk"])[0]).toMatch(/not ahead of the registry \(latest 2\.10\.0\)/);
    const ahead = new Map(registry).set("@m/crypto", published("4.1.0"));
    expect(refusals(["@m/crypto"], ahead)[0]).toMatch(/not ahead of the registry/);
    const pre = [pkg("@m/crypto", "4.0.1-rc.1"), verifier, sdk, cli];
    expect(refusals(["@m/crypto"], registry, pre)).toContain(
      "@m/crypto@4.0.1-rc.1 is not a plain x.y.z release",
    );
  });

  it("refuses a first publish and an unclean registry answer", () => {
    const absent = new Map(registry).set("@m/crypto", { kind: "absent" });
    expect(refusals(["@m/crypto"], absent)[0]).toMatch(/never been published/);
    const down = new Map(registry).set("@m/crypto", { kind: "unreachable", detail: "HTTP 503" });
    expect(refusals(["@m/crypto"], down)[0]).toMatch(/did not answer cleanly \(HTTP 503\)/);
    expect(refusals(["@m/crypto"], new Map())[0]).toMatch(/not asked/);
  });

  it("refuses a dependency listed after its dependent", () => {
    expect(refusals(["@m/verifier", "@m/crypto"])).toEqual([
      "@m/verifier depends on @m/crypto, so @m/crypto must be listed before it",
    ]);
  });

  it("refuses an unlisted dependency the registry has not got at the workspace version", () => {
    expect(refusals(["@m/verifier"])[0]).toMatch(
      /depends on @m\/crypto@4\.0\.1, which is not listed and is not the registry's latest \(4\.0\.0\)/,
    );
  });

  it("accepts an unlisted dependency that is current on the registry", () => {
    expect(refusals(["@m/crypto", "@m/verifier", "cli"])).toEqual([]); // @m/sdk unlisted, current
  });

  it("ignores non-workspace and private dependencies", () => {
    const ws = [
      pkg("@m/crypto", "4.0.1", { "@noble/ed25519": "^2.0.0", "@m/private": "workspace:*" }),
    ];
    expect(refusals(["@m/crypto"], registry, ws)).toEqual([]);
  });

  it("a rehearsal (dry run) accepts a version equal to latest, and nothing else extra", () => {
    const plan = planSecurityPublish(["@m/sdk"], workspace, registry, { rehearsal: true });
    expect(plan).toMatchObject({ ok: true, packages: [{ name: "@m/sdk", previous: "2.10.0" }] });
    const behind = new Map(registry).set("@m/sdk", published("2.11.0"));
    expect(planSecurityPublish(["@m/sdk"], workspace, behind, { rehearsal: true }).ok).toBe(false);
    const absent = new Map(registry).set("@m/sdk", { kind: "absent" });
    expect(planSecurityPublish(["@m/sdk"], workspace, absent, { rehearsal: true }).ok).toBe(false);
  });

  it("packagesAhead lists behind and never-published packages, and refuses to guess", () => {
    expect(packagesAhead(workspace, registry)).toEqual([
      "@m/crypto@4.0.1",
      "@m/verifier@1.14.2",
      "cli@2.2.2",
    ]);
    const first = new Map(registry).set("@m/sdk", { kind: "absent" });
    expect(packagesAhead(workspace, first)).toContain("@m/sdk@2.10.0");
    const down = new Map(registry).set("@m/sdk", { kind: "unreachable", detail: "x" });
    expect(packagesAhead(workspace, down)).toBeNull();
  });

  it("splits the dispatch input on spaces and commas", () => {
    expect(parsePackageList(" @m/crypto,@m/verifier \n cli ")).toEqual([
      "@m/crypto",
      "@m/verifier",
      "cli",
    ]);
  });
});

type Permissions = Record<string, string> | string | undefined;
interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  if?: string;
  uses?: string;
  environment?: string | { name?: string };
  permissions?: Permissions;
  needs?: string | string[];
  env?: Record<string, unknown>;
  concurrency?: { group?: string } | string;
  steps?: Step[];
}
interface Workflow {
  permissions?: Permissions;
  concurrency?: unknown;
  jobs?: Record<string, Job>;
}

const wf = join(__dirname, "..", "..", ".github", "workflows");
const workflows = readdirSync(wf)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((file) => {
    const text = readFileSync(join(wf, file), "utf8");
    return { file, text, doc: parse(text) as Workflow };
  });
const release = workflows.find((w) => w.file === "release.yml")!;
const jobs = release.doc.jobs!;

// A publish verb after npm/pnpm/yarn/changeset and any flags, `run`, `exec` or
// `--`: `npm publish`, `pnpm -r publish`, `pnpm run release`,
// `npm exec -- changeset publish`.
const PUBLISH_COMMAND =
  /\b(npm|pnpm|yarn|changeset)\b(\s+(--?\S*|run|exec)(\s+[^-\s]\S*)?)*\s+(publish|release)\b/;
// The security-publish script's own publish mode, which runs `npm publish`.
const SCRIPT_PUBLISH = /security-publish\.ts\s+publish\b/;
// The one job allowed an id-token outside npm-publish: cosign keyless signing
// of container images, with no npm path (checked below).
const ID_TOKEN_EXEMPT = new Set(["publish-images.yml:relay"]);

function envName(job: Job): string | undefined {
  return typeof job.environment === "string" ? job.environment : job.environment?.name;
}
function grantsIdToken(perms: Permissions): boolean {
  return perms === "write-all" || (typeof perms === "object" && perms["id-token"] === "write");
}
/** Run text with comments dropped and backslash line continuations joined. */
function shellLines(run: string): string[] {
  return run
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l));
}
/** Every way this job could publish. A job's own permissions, else the workflow's. */
function canPublish(job: Job, doc: Workflow): string[] {
  const why: string[] = [];
  if (grantsIdToken(job.permissions ?? doc.permissions)) why.push("id-token: write");
  if (job.uses) why.push(`calls reusable workflow ${job.uses}`);
  for (const step of job.steps ?? []) {
    if (shellLines(step.run ?? "").some((l) => PUBLISH_COMMAND.test(l) || SCRIPT_PUBLISH.test(l)))
      why.push(`publishes in "${step.name}"`);
    if (step.uses?.startsWith("changesets/action") && step.with && "publish" in step.with)
      why.push(`changesets publish: in "${step.name}"`);
    if (step.uses && !step.uses.startsWith("changesets/action") && /publish/i.test(step.uses))
      why.push(`publish action ${step.uses}`);
  }
  return why;
}

describe("publishSteps", () => {
  const art = (name: string, version: string, previous: string): PackedArtifact => ({
    name,
    version,
    previous,
    tarball: `/out/${name}.tgz`,
    integrity: "sha512-x",
  });
  const list = [art("@m/crypto", "4.0.1", "4.0.0"), art("@m/verifier", "1.14.2", "1.14.2")];

  it("a real run publishes every artifact, in order, with provenance and no --dry-run", () => {
    expect(publishSteps(list, false)).toEqual([
      {
        kind: "publish",
        name: "@m/crypto",
        version: "4.0.1",
        args: ["publish", "/out/@m/crypto.tgz", "--provenance", "--access", "public"],
      },
      {
        kind: "publish",
        name: "@m/verifier",
        version: "1.14.2",
        args: ["publish", "/out/@m/verifier.tgz", "--provenance", "--access", "public"],
      },
    ]);
  });

  it("a dry run skips a version npm already has and dry-runs one it does not", () => {
    const steps = publishSteps(list, true);
    expect(steps[0]).toEqual({
      kind: "publish",
      name: "@m/crypto",
      version: "4.0.1",
      args: ["publish", "/out/@m/crypto.tgz", "--provenance", "--access", "public", "--dry-run"],
    });
    expect(steps[1]).toMatchObject({ kind: "skip", name: "@m/verifier", version: "1.14.2" });
  });

  it("a real run never skips, even at the registry's version (the plan refuses that first)", () => {
    expect(publishSteps([art("@m/x", "1.0.0", "1.0.0")], false)[0]!.kind).toBe("publish");
  });
});

describe("publish authority across every workflow", () => {
  it("no workflow grants id-token or write-all at the top level", () => {
    expect(
      workflows.filter(({ doc }) => grantsIdToken(doc.permissions)).map((w) => w.file),
    ).toEqual([]);
  });

  it("every job able to publish to npm waits in the npm-publish environment", () => {
    const unapproved = workflows.flatMap(({ file, doc }) =>
      Object.entries(doc.jobs ?? {})
        .filter(([, job]) => envName(job) !== "npm-publish")
        .map(([name, job]) => ({
          job: `${file}:${name}`,
          why: canPublish(job, doc).filter(
            (w) => !(w === "id-token: write" && ID_TOKEN_EXEMPT.has(`${file}:${name}`)),
          ),
        }))
        .filter((j) => j.why.length > 0),
    );
    expect(unapproved).toEqual([]);
  });

  it("the id-token exemption is a job that publishes nothing to npm", () => {
    for (const id of ID_TOKEN_EXEMPT) {
      const [file, name] = id.split(":");
      const w = workflows.find((x) => x.file === file)!;
      expect(canPublish(w.doc.jobs![name!]!, w.doc)).toEqual(["id-token: write"]);
    }
  });

  // Drift guard, not a proof: a determined author can spell a token so no
  // text check sees it (a computed secret name, a quoted key). Token publishing
  // is closed on npm's side: every package is "Require two-factor
  // authentication and disallow bypass 2fa tokens" (RUNBOOK, Publish authority).
  it("no workflow names an npm token, indexes secrets dynamically, or writes an auth token", () => {
    const withToken = workflows
      .filter(({ text }) =>
        text
          .split("\n")
          .filter((l) => !/^\s*#/.test(l))
          .some((l) =>
            /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.NPM|secrets\s*\[|toJSON\(\s*secrets|_authToken/i.test(
              l,
            ),
          ),
      )
      .map((w) => w.file);
    expect(withToken).toEqual([]);
  });

  it("only release.yml's train-publish and security-publish jobs are in npm-publish", () => {
    const inEnv = workflows.flatMap(({ file, doc }) =>
      Object.entries(doc.jobs ?? {})
        .filter(([, job]) => envName(job) === "npm-publish")
        .map(([name]) => `${file}:${name}`),
    );
    expect(inEnv.sort()).toEqual(["release.yml:security-publish", "release.yml:train-publish"]);
  });

  it("a push runs prepare, which cannot publish; train-publish follows it, never in version mode", () => {
    expect(jobs.release!.if).toBe("github.event_name == 'push'");
    expect(canPublish(jobs.release!, release.doc)).toEqual([]);
    expect(jobs["train-publish"]!.needs).toBe("release");
    expect(jobs["train-publish"]!.if).toBe(
      "needs.release.outputs.state != 'version-mode' && needs.release.outputs.ahead != '0'",
    );
  });

  it("a dispatch runs only security-publish, read-only on contents", () => {
    expect(jobs["security-publish"]!.if).toBe("github.event_name == 'workflow_dispatch'");
    expect(jobs["security-publish"]!.permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
  });

  it("prepare queues alone; the two publishing jobs share one group", () => {
    // A job waiting for approval holds its group, and by default GitHub cancels
    // all but the newest pending run in a group.
    expect(release.doc.concurrency).toBeUndefined();
    const c = (j: string) => jobs[j]!.concurrency as Record<string, unknown> | undefined;
    expect(c("release")?.group).toEqual(expect.any(String));
    expect(c("release")?.group).not.toBe("npm-publish");
    for (const j of ["train-publish", "security-publish"])
      expect(c(j)).toEqual({ group: "npm-publish", "cancel-in-progress": false });
  });

  it("security-publish re-reads main's head immediately before publishing", () => {
    const names = (jobs["security-publish"]!.steps ?? []).map((s) => s.name);
    const publish = names.indexOf("Publish (dependency order)");
    expect(names[publish - 1]).toBe("Main is still the authorized commit");
    const check = jobs["security-publish"]!.steps![publish - 1]!.run ?? "";
    expect(check).toMatch(/git ls-remote [^\n]* refs\/heads\/main/);
    expect(check).toMatch(/\[ "\$HEAD" = "\$INPUT_SHA" \] \|\| \{[^}]*exit 1; \}/);
  });

  it("each publish job installs npm 11 only after its last test and before its publish", () => {
    // npm 11 prints config warnings on stderr, which CLI tests asserting exact
    // stderr read as failures: the 2026-10-18 rehearsal stopped there.
    for (const [job, publishStep] of [
      ["train-publish", "Direct publish"],
      ["security-publish", "Publish (dependency order)"],
    ] as const) {
      const steps = jobs[job]!.steps ?? [];
      const publish = steps.findIndex((s) => (s.name ?? "").startsWith(publishStep));
      const upgrades = steps.flatMap((s, i) =>
        /npm install -g npm@/.test(s.run ?? "") ? [i] : [],
      );
      const tests = steps.flatMap((s, i) =>
        i < publish && /\btest\b|smoke/i.test(`${s.name ?? ""}\n${s.run ?? ""}`) ? [i] : [],
      );
      expect(upgrades).toHaveLength(1);
      expect(tests.length).toBeGreaterThan(0);
      expect(upgrades[0]).toBeGreaterThan(Math.max(...tests));
      expect(upgrades[0]).toBeLessThan(publish);
    }
  });

  it("the security job never versions or publishes changesets, and uses no remote build cache", () => {
    const job = jobs["security-publish"]!;
    const runs = (job.steps ?? []).map((s) => s.run ?? "").join("\n");
    expect(runs).not.toMatch(/changeset/);
    expect(job.env?.TURBO_TOKEN).toBe("");
    expect(job.env).not.toHaveProperty("NODE_AUTH_TOKEN");
  });

  it("job-level env uses only the contexts GitHub allows there", () => {
    // runner, job, steps and env are not available in jobs.<id>.env. A file
    // that uses them fails to load, and then no job in it runs at all.
    const allowed = new Set(["github", "inputs", "matrix", "needs", "secrets", "strategy", "vars"]);
    const bad: string[] = [];
    for (const { file, doc } of workflows)
      for (const [name, job] of Object.entries(doc.jobs ?? {}))
        for (const [key, value] of Object.entries(job.env ?? {}))
          for (const expr of String(value).matchAll(/\$\{\{([^}]*)\}\}/g))
            for (const ctx of expr[1]!.replace(/'[^']*'/g, "").matchAll(/\b([a-z_]+)\s*[.[]/g))
              if (!allowed.has(ctx[1]!)) bad.push(`${file}:${name}.env.${key} uses ${ctx[1]}`);
    expect(bad).toEqual([]);
  });

  it("release.yml's dispatch inputs reach run scripts only through the environment", () => {
    for (const [name, job] of Object.entries(jobs))
      for (const step of job.steps ?? [])
        expect({ at: `${name}:${step.name}`, run: step.run ?? "" }).not.toMatchObject({
          run: expect.stringMatching(/\$\{\{[^}]*\b(inputs|github\.event)\b/),
        });
  });
});
