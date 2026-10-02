/**
 * scripts/check-vercel-ignore-build.ts — the gate over every vercel.json.
 *
 * Two fixtures:
 *   - a synthetic workspace (web → a → b, devDependency on a service, a
 *     tsconfig extends chain through config/) proving the transitive closure,
 *     the root build config (tsconfig chain, turbo.json, pnpm-workspace.yaml,
 *     root manifests), the production-ownership rule parsed from the workflow
 *     YAML (a real `vercel --prod` step, no statically-false `if`, the
 *     project's own id secret, main-only dispatch, paths ⊇ build inputs), the
 *     deploymentEnabled shape and the stale KNOWN_DOUBLE_DEPLOY rule;
 *   - a copy of the REAL repo's workspace manifests/tsconfigs, root build
 *     config, every vercel.json and the workflows, proving every committed
 *     path list is exactly its build inputs and that dropping any one input
 *     turns the gate red.
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
  ifStaticallyFalse,
  ROOT_BUILD_FILES,
  rootBuildConfig,
  runsVercelProd,
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
  writeFileSync(join(t, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  writeFileSync(join(t, "turbo.json"), '{"globalDependencies": ["tsconfig.base.json"]}');
  writeFileSync(join(t, "tsconfig.base.json"), "{}");
  return t;
}

function put(root: string, path: string, body: unknown): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof body === "string" ? body : JSON.stringify(body));
}

const deployWorkflow = (dir: string, secret = "VERCEL_WEB_PROJECT_ID") => `name: deploy
on:
  push:
    branches: [main]
    paths:
      - "${dir}/**"
      - "packages/**"
      - "services/relay/**"
      - "config/**"
      - "pnpm-lock.yaml"
      - "package.json"
      - "pnpm-workspace.yaml"
      - "turbo.json"
      - "tsconfig.base.json"
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - name: Deploy
        # deploys production
        run: vercel --prod --yes
        env:
          VERCEL_PROJECT_ID: \${{ secrets.${secret} }}
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
  put(t, "apps/web/tsconfig.json", '{ "extends": "../../tsconfig.base.json" }');
  // A JSONC tsconfig whose chain leaves the workspace through config/.
  put(t, "packages/a/tsconfig.json", '{\n  // lib\n  "extends": "../../config/tsconfig.lib",\n}');
  put(t, "config/tsconfig.lib.json", '{ "extends": "../tsconfig.base.json" }');
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
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.base.json",
  "config/tsconfig.lib.json",
];
const MAIN_OFF = { git: { deploymentEnabled: { main: false } } };

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

describe("root build config (#1: previews skipped on root config changes)", () => {
  it("derives the tsconfig extends chain (JSONC, extension-less) and root build files", () => {
    const t = synthetic(FULL);
    expect(rootBuildConfig(t, closureDirs("web", workspaceManifests(t)))).toEqual([
      "config/tsconfig.lib.json",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.base.json",
      "turbo.json",
    ]);
  });

  it("requires the root build config for a project with no workspace deps too", () => {
    const t = mk();
    put(t, "services/proxy/package.json", { name: "proxy" });
    put(t, "services/proxy/vercel.json", {
      ignoreCommand: `sh ${SCRIPT} services/proxy pnpm-lock.yaml package.json`,
    });
    const r = collectVercelViolations(t, {});
    expect(r.violations).toHaveLength(1);
    for (const f of ["pnpm-workspace.yaml", "turbo.json"]) expect(r.violations[0]).toContain(f);
  });

  it("goes red when the production workflow's paths miss a build input", () => {
    for (const drop of [
      '      - "tsconfig.base.json"\n',
      '      - "turbo.json"\n',
      '      - "pnpm-workspace.yaml"\n',
    ]) {
      const t = synthetic(FULL, MAIN_OFF);
      put(t, ".github/workflows/deploy-web.yml", deployWorkflow("apps/web").replace(drop, ""));
      const r = collectVercelViolations(t, {});
      expect(r.violations, drop).toHaveLength(1);
      expect(r.violations[0], drop).toMatch(/on\.push\.paths miss/);
    }
  });

  it("--turbo-ignore: root build config outside turbo's globalDependencies is red", () => {
    const t = mk();
    put(t, "apps/docs/package.json", { name: "docs" });
    put(t, "apps/docs/tsconfig.json", '{ "extends": "../../tsconfig.base.json" }');
    put(t, "apps/docs/vercel.json", { ignoreCommand: `sh ${SCRIPT} --turbo-ignore docs` });
    expect(collectVercelViolations(t, {}).violations).toEqual([]);
    put(t, "turbo.json", '{"globalDependencies": []}');
    const r = collectVercelViolations(t, {});
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]).toContain("tsconfig.base.json");
  });
});

describe("production ownership is parsed, not grepped (#2)", () => {
  function owned(workflow: string, cfg: Record<string, unknown> = MAIN_OFF): string[] {
    const t = synthetic(FULL, cfg);
    put(t, ".github/workflows/deploy-web.yml", workflow);
    return collectVercelViolations(t, {}).violations;
  }

  it("passes the well-formed deployer", () => {
    expect(owned(deployWorkflow("apps/web"))).toEqual([]);
  });

  it("(a) `vercel --prod` only in a comment while the step echoes → red", () => {
    const wf = deployWorkflow("apps/web").replace(
      "run: vercel --prod --yes",
      "run: |\n          # vercel --prod --yes\n          echo vercel --prod",
    );
    const v = owned(wf);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/never deploy/);
  });

  it("(b) the deploy job has a statically-false `if` → red", () => {
    for (const cond of ["false", "${{ false }}", "github.ref == 'refs/heads/main' && false"]) {
      const wf = deployWorkflow("apps/web").replace(
        "if: github.ref == 'refs/heads/main'",
        `if: ${cond}`,
      );
      const v = owned(wf);
      expect(v.join("\n"), cond).toMatch(/statically-false/);
    }
  });

  it("(c) the workflow deploys another project's id secret → red", () => {
    const v = owned(deployWorkflow("apps/web", "VERCEL_PROJECT_ID"));
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/not apps\/web's secrets\.VERCEL_WEB_PROJECT_ID/);
  });

  it("(d) `deploymentEnabled: false` (kills previews) → red; other branches off → red", () => {
    const v = owned(deployWorkflow("apps/web"), { git: { deploymentEnabled: false } });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/EVERY branch/);
    const w = owned(deployWorkflow("apps/web"), {
      git: { deploymentEnabled: { main: false, "*": false } },
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/only main may be disabled/);
  });

  it("workflow_dispatch without a main-only restriction → red", () => {
    const wf = deployWorkflow("apps/web").replace("    if: github.ref == 'refs/heads/main'\n", "");
    const v = owned(wf);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/workflow_dispatch without restricting/);
  });

  it("parses run scripts and `if` expressions", () => {
    expect(runsVercelProd("vercel --prod --yes")).toBe(true);
    expect(runsVercelProd("npm i -g vercel\nnpx -y vercel deploy --prod")).toBe(true);
    expect(runsVercelProd("# vercel --prod")).toBe(false);
    expect(runsVercelProd("echo vercel --prod")).toBe(false);
    expect(runsVercelProd("vercel --yes # --prod")).toBe(false);
    expect(ifStaticallyFalse(undefined)).toBe(false);
    expect(ifStaticallyFalse("github.event_name == 'push'")).toBe(false);
    expect(ifStaticallyFalse("${{ !cancelled() }}")).toBe(false);
    expect(ifStaticallyFalse(false)).toBe(true);
    expect(ifStaticallyFalse("0")).toBe(true);
    expect(ifStaticallyFalse("${{ github.ref == 'x' && (false) }}")).toBe(true);
  });
});

describe("every vercel.json on the real workspace", () => {
  const VERCEL = ["apps/web/vercel.json", "services/proxy/vercel.json", "apps/docs/vercel.json"];

  /** Copy workspace manifests/tsconfigs, root build config, the vercel.json files and workflows. */
  function realCopy(): string {
    const t = mk();
    for (const group of ["packages", "apps", "services"]) {
      for (const d of readdirSync(join(REPO, group))) {
        for (const f of ["package.json", "tsconfig.json"]) {
          const p = join(group, d, f);
          if (existsSync(join(REPO, p))) cpSync(join(REPO, p), join(t, p));
        }
      }
    }
    for (const f of [...ROOT_BUILD_FILES, "tsconfig.base.json"]) {
      if (existsSync(join(REPO, f))) cpSync(join(REPO, f), join(t, f));
    }
    for (const f of VERCEL) cpSync(join(REPO, f), join(t, f));
    cpSync(join(REPO, ".github/workflows"), join(t, ".github/workflows"), { recursive: true });
    return t;
  }

  const cfgOf = (f: string) =>
    JSON.parse(readFileSync(join(REPO, f), "utf8")) as { ignoreCommand: string; git?: unknown };
  const pathsOf = (f: string) => cfgOf(f).ignoreCommand.trim().split(/\s+/).slice(2);
  const inputsOf = (dir: string, pkg: string) => {
    const closure = closureDirs(pkg, workspaceManifests(REPO));
    return [...closure, ...rootBuildConfig(REPO, closure)].sort();
  };
  const PROJECTS: [string, string][] = [
    ["apps/web", "@motebit/web"],
    ["services/proxy", "@motebit/proxy"],
  ];

  it("passes on the committed tree", () => {
    const r = collectVercelViolations(realCopy());
    expect(r.violations).toEqual([]);
    expect(r.actionOwned).toContain("apps/web (.github/workflows/deploy-web.yml)");
  });

  it.each(PROJECTS)("%s watches exactly its build inputs (closure + root config)", (dir, pkg) => {
    const inputs = inputsOf(dir, pkg);
    expect(inputs).toContain(dir);
    expect(inputs).toEqual(
      expect.arrayContaining(["tsconfig.base.json", "turbo.json", "pnpm-workspace.yaml"]),
    );
    expect([...pathsOf(`${dir}/vercel.json`)].sort()).toEqual(inputs);
  });

  it("gives apps/web production to deploy-web.yml alone (Git deploys of main off)", () => {
    expect(cfgOf("apps/web/vercel.json").git).toEqual({ deploymentEnabled: { main: false } });
  });

  it.each(PROJECTS)("%s: dropping any one watched path turns the gate red", (dir) => {
    const t = realCopy();
    const file = `${dir}/vercel.json`;
    const cfg = cfgOf(file);
    for (const drop of pathsOf(file)) {
      const kept = pathsOf(file).filter((p) => p !== drop);
      put(t, file, { ...cfg, ignoreCommand: `sh ${SCRIPT} ${kept.join(" ")}` });
      const r = collectVercelViolations(t);
      expect(r.violations, drop).toHaveLength(1);
      expect(r.violations[0], drop).toContain(`\`${drop}\``);
    }
  });
});
