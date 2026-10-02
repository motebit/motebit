/**
 * scripts/check-vercel-ignore-build.ts — the gate over every vercel.json.
 *
 * Two fixtures:
 *   - a synthetic workspace (web → a → b, devDependency on a service) proving
 *     the transitive closure, the production-ownership (double-deploy) rule
 *     and the stale KNOWN_DOUBLE_DEPLOY rule;
 *   - a copy of the REAL repo's workspace manifests, apps/web/vercel.json and
 *     workflows, proving apps/web's committed path list is exactly its closure
 *     and that dropping any one web dependency turns the gate red.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  closureDirs,
  collectVercelViolations,
  workspaceManifests,
} from "../check-vercel-ignore-build.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = "../../scripts/vercel-ignore-build.sh";
const tmps: string[] = [];

afterAll(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
});

function mk(): string {
  const t = mkdtempSync(join(tmpdir(), "check-vercel-"));
  tmps.push(t);
  mkdirSync(join(t, "scripts"), { recursive: true });
  writeFileSync(join(t, "scripts/vercel-ignore-build.sh"), "");
  writeFileSync(join(t, "pnpm-lock.yaml"), "");
  writeFileSync(join(t, "package.json"), "{}");
  return t;
}

function put(root: string, path: string, body: unknown): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof body === "string" ? body : JSON.stringify(body));
}

const deployWorkflow = (dir: string) => `name: deploy
on:
  push:
    branches: [main]
    paths:
      - "${dir}/**"
      - "pnpm-lock.yaml"
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: vercel --prod --yes
`;

/** web → a → b, web devDepends on services/relay. */
function synthetic(paths: string[], extra: Record<string, unknown> = {}): string {
  const t = mk();
  put(t, "apps/web/package.json", {
    name: "web",
    dependencies: { a: "workspace:*", external: "^1.0.0" },
    devDependencies: { relay: "workspace:*" },
  });
  put(t, "packages/a/package.json", { name: "a", dependencies: { b: "workspace:^" } });
  put(t, "packages/b/package.json", { name: "b" });
  put(t, "packages/unrelated/package.json", { name: "unrelated" });
  put(t, "services/relay/package.json", { name: "relay" });
  put(t, "apps/web/vercel.json", {
    ignoreCommand: `sh ${SCRIPT} ${paths.join(" ")}`,
    ...extra,
  });
  return t;
}

const FULL = [
  "apps/web",
  "packages/a",
  "packages/b",
  "services/relay",
  "pnpm-lock.yaml",
  "package.json",
];

describe("synthetic workspace", () => {
  it("computes the transitive workspace closure across dependency fields", () => {
    const t = synthetic(FULL);
    expect(closureDirs("web", workspaceManifests(t))).toEqual([
      "apps/web",
      "packages/a",
      "packages/b",
      "services/relay",
    ]);
  });

  it("passes with the full closure", () => {
    expect(collectVercelViolations(synthetic(FULL), {}).violations).toEqual([]);
  });

  it.each(FULL)("goes red when %s is dropped", (drop) => {
    const r = collectVercelViolations(synthetic(FULL.filter((p) => p !== drop)), {});
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toContain(`\`${drop}\``);
  });

  it("flags a vercel --prod Action plus Git deploys of main as a double deploy", () => {
    const t = synthetic(FULL);
    put(t, ".github/workflows/deploy-web.yml", deployWorkflow("apps/web"));
    const r = collectVercelViolations(t, {});
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatch(/deploys twice/);
  });

  it("passes when the Action owns production and Git deploys of main are off", () => {
    const t = synthetic(FULL, { git: { deploymentEnabled: { main: false } } });
    put(t, ".github/workflows/deploy-web.yml", deployWorkflow("apps/web"));
    const r = collectVercelViolations(t, {});
    expect(r.violations).toEqual([]);
    expect(r.actionOwned).toEqual(["apps/web (.github/workflows/deploy-web.yml)"]);
  });

  it("flags Git deploys of main disabled with no Action (production never deploys)", () => {
    const t = synthetic(FULL, { git: { deploymentEnabled: { main: false } } });
    const r = collectVercelViolations(t, {});
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toMatch(/never deploy/);
  });

  it("ignores a workflow that does not run on push to main", () => {
    const t = synthetic(FULL);
    put(
      t,
      ".github/workflows/deploy-web.yml",
      deployWorkflow("apps/web").replace("[main]", "[staging]"),
    );
    expect(collectVercelViolations(t, {}).violations).toEqual([]);
  });

  it("tolerates a listed known double deploy and flags the entry once stale", () => {
    const t = synthetic(FULL);
    put(t, ".github/workflows/deploy-web.yml", deployWorkflow("apps/web"));
    const known = { "apps/web": "fixture" };
    const r = collectVercelViolations(t, known);
    expect(r.violations).toEqual([]);
    expect(r.knownDoubleDeploy).toEqual(["apps/web"]);

    put(t, "apps/web/vercel.json", {
      ignoreCommand: `sh ${SCRIPT} ${FULL.join(" ")}`,
      git: { deploymentEnabled: { main: false } },
    });
    const stale = collectVercelViolations(t, known);
    expect(stale.violations).toHaveLength(1);
    expect(stale.violations[0]).toMatch(/stale entry/);
  });
});

describe("apps/web on the real workspace", () => {
  /** Copy every workspace manifest, apps/web/vercel.json and the workflows. */
  function realCopy(): string {
    const t = mk();
    for (const group of ["packages", "apps", "services"]) {
      for (const d of readdirSync(join(REPO, group))) {
        const p = join(group, d, "package.json");
        if (existsSync(join(REPO, p))) cpSync(join(REPO, p), join(t, p));
      }
    }
    cpSync(join(REPO, "apps/web/vercel.json"), join(t, "apps/web/vercel.json"));
    cpSync(join(REPO, ".github/workflows"), join(t, ".github/workflows"), { recursive: true });
    return t;
  }

  const webCfg = () =>
    JSON.parse(readFileSync(join(REPO, "apps/web/vercel.json"), "utf8")) as {
      ignoreCommand: string;
      git?: unknown;
    };
  const webPaths = () => webCfg().ignoreCommand.trim().split(/\s+/).slice(2);
  const webClosure = () => closureDirs("@motebit/web", workspaceManifests(REPO));

  it("watches exactly apps/web's workspace closure plus the root manifests", () => {
    expect(webClosure()).toContain("apps/web");
    expect(webClosure().length).toBeGreaterThan(1);
    expect([...webPaths()].sort()).toEqual(
      [...webClosure(), "pnpm-lock.yaml", "package.json"].sort(),
    );
  });

  it("gives production to deploy-web.yml alone (Git deploys of main off)", () => {
    expect(webCfg().git).toEqual({ deploymentEnabled: { main: false } });
    const r = collectVercelViolations(realCopy());
    expect(r.violations).toEqual([]);
    expect(r.actionOwned).toContain("apps/web (.github/workflows/deploy-web.yml)");
  });

  it("goes red when any web workspace dependency is dropped from the path list", () => {
    const t = realCopy();
    const cfg = webCfg();
    const deps = webClosure().filter((d) => d !== "apps/web");
    for (const drop of deps) {
      const kept = webPaths().filter((p) => p !== drop);
      put(t, "apps/web/vercel.json", {
        ...cfg,
        ignoreCommand: `sh ${SCRIPT} ${kept.join(" ")}`,
      });
      const r = collectVercelViolations(t);
      expect(r.violations, drop).toHaveLength(1);
      expect(r.violations[0], drop).toContain(`\`${drop}\``);
    }
  });
});
