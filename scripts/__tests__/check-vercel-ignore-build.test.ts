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
 *     watch file is exactly its build inputs and that dropping any one input
 *     turns the gate red.
 *
 * #1027: apps/web's inline path list made its ignoreCommand 1051 chars and
 * Vercel refused the config ("ignoreCommand should NOT be longer than 256
 * characters") before building — while every test here was green. Every
 * vercel.json is now validated with Vercel's own schema code (the CLI's
 * buildVercelConfigSchema over @vercel/routing-utils + @vercel/build-utils)
 * plus the motebit tightening layer, and the path list lives in a watch file.
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
import { IGNORE_COMMAND_MAX } from "../lib/vercel-config-schema.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = "../../scripts/vercel-ignore-build.sh";
const WEB_WATCH = "scripts/vercel-watch/web.txt";
const watchCmd = (file = WEB_WATCH) => `sh ${SCRIPT} --watch ../../${file}`;
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
          VERCEL_TOKEN: \${{ secrets.VERCEL_TOKEN }}
          VERCEL_ORG_ID: \${{ secrets.VERCEL_ORG_ID }}
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
  put(t, WEB_WATCH, `${paths.join("\n")}\n`);
  put(t, "apps/web/vercel.json", { ignoreCommand: watchCmd(), ...extra });
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
      ignoreCommand: watchCmd(),
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
    put(t, "scripts/vercel-watch/proxy.txt", "services/proxy\npnpm-lock.yaml\npackage.json\n");
    put(t, "services/proxy/vercel.json", {
      ignoreCommand: watchCmd("scripts/vercel-watch/proxy.txt"),
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

  it("parses `if` expressions and finds deploy candidates", () => {
    expect(runsVercelProd("vercel --prod --yes")).toBe(true);
    expect(runsVercelProd("npm i -g vercel\nnpx -y vercel deploy --prod")).toBe(true);
    expect(runsVercelProd("vercel --yes")).toBe(false);
    expect(ifStaticallyFalse(undefined)).toBe(false);
    expect(ifStaticallyFalse("github.event_name == 'push'")).toBe(false);
    expect(ifStaticallyFalse("${{ !cancelled() }}")).toBe(false);
    expect(ifStaticallyFalse(false)).toBe(true);
    expect(ifStaticallyFalse("0")).toBe(true);
    expect(ifStaticallyFalse("${{ github.ref == 'x' && (false) }}")).toBe(true);
  });
});

describe("the deploy step is a pinned form (cold-review hardening: each was GREEN before)", () => {
  function owned(workflow: string): string[] {
    const t = synthetic(FULL, MAIN_OFF);
    put(t, ".github/workflows/deploy-web.yml", workflow);
    return collectVercelViolations(t, {}).violations;
  }
  const WF = deployWorkflow("apps/web");
  const RUN = "        run: vercel --prod --yes\n";
  const sub = (from: string, to: string) => {
    if (!WF.includes(from)) throw new Error(`fixture vacuous: ${JSON.stringify(from)}`);
    return WF.replace(from, to);
  };

  it("control: the well-formed deployer is green", () => {
    expect(owned(WF)).toEqual([]);
  });

  const MUTANTS: [string, string, RegExp][] = [
    [
      "continue-on-error: true on the deploy step",
      sub(RUN, `${RUN}        continue-on-error: true\n`),
      /continue-on-error/,
    ],
    [
      "continue-on-error: true on the deploy job",
      sub(
        "    runs-on: ubuntu-latest\n",
        "    runs-on: ubuntu-latest\n    continue-on-error: true\n",
      ),
      /continue-on-error/,
    ],
    [
      "`|| true` on the deploy command",
      sub(RUN, "        run: vercel --prod --yes || true\n"),
      /pinned form/,
    ],
    [
      "`exit 0` before `vercel --prod`",
      sub(RUN, "        run: |\n          exit 0\n          vercel --prod --yes\n"),
      /pinned form/,
    ],
    [
      "`vercel --prod` inside a heredoc",
      sub(
        RUN,
        "        run: |\n          cat <<EOF\n          vercel --prod --yes\n          EOF\n",
      ),
      /pinned form/,
    ],
    [
      "`--target=preview`",
      sub(RUN, "        run: vercel --prod --yes --target=preview\n"),
      /pinned form/,
    ],
    [
      "`needs:` on a job with `if: false`",
      sub(
        "jobs:\n",
        "jobs:\n  gate:\n    runs-on: ubuntu-latest\n    if: false\n    steps:\n      - run: echo gate\n",
      ).replace(
        "    runs-on: ubuntu-latest\n    if: github.ref",
        "    needs: gate\n    runs-on: ubuntu-latest\n    if: github.ref",
      ),
      /needs/,
    ],
    [
      "`needs:` on a job that does not exist",
      sub(
        "    if: github.ref == 'refs/heads/main'\n",
        "    needs: nope\n    if: github.ref == 'refs/heads/main'\n",
      ),
      /needs/,
    ],
    [
      "`github.event_name == 'never'`",
      sub(
        "    if: github.ref == 'refs/heads/main'\n",
        "    if: github.ref == 'refs/heads/main' && github.event_name == 'never'\n",
      ),
      /false on a push to main/,
    ],
    [
      "`github.ref == 'refs/heads/release'`",
      sub(
        "    if: github.ref == 'refs/heads/main'\n",
        "    if: github.ref == 'refs/heads/release'\n",
      ),
      /false on a push to main/,
    ],
    [
      "a step `if: github.event_name != 'push'`",
      sub(RUN, `${RUN}        if: github.event_name != 'push'\n`),
      /false on a push to main/,
    ],
    [
      "`paths-ignore: apps/web/**`",
      sub(
        "  workflow_dispatch:\n",
        '    paths-ignore:\n      - "apps/web/**"\n  workflow_dispatch:\n',
      ),
      /paths-ignore/,
    ],
    [
      "a negated `!apps/web/**` push path",
      sub('      - "turbo.json"\n', '      - "turbo.json"\n      - "!apps/web/**"\n'),
      /negat/,
    ],
    [
      "`working-directory: services/proxy` on the step",
      sub(RUN, `${RUN}        working-directory: services/proxy\n`),
      /working-directory/,
    ],
    [
      "`defaults.run.working-directory` on the job",
      sub(
        "    runs-on: ubuntu-latest\n",
        "    runs-on: ubuntu-latest\n    defaults:\n      run:\n        working-directory: services/proxy\n",
      ),
      /defaults/,
    ],
    ["`shell:` override on the step", sub(RUN, `${RUN}        shell: python\n`), /shell/],
    [
      "wrong VERCEL_ORG_ID",
      sub("secrets.VERCEL_ORG_ID }}", "secrets.OTHER_ORG_ID }}"),
      /VERCEL_ORG_ID/,
    ],
    [
      "VERCEL_TOKEN removed",
      sub("          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}\n", ""),
      /VERCEL_TOKEN/,
    ],
  ];

  it.each(MUTANTS)("RED: %s", (_name, wf, why) => {
    const v = owned(wf);
    expect(v.length, v.join("\n")).toBeGreaterThan(0);
    expect(v.join("\n")).toMatch(why);
  });
});

describe("every vercel.json validates under Vercel's own schema + the motebit tightening (#1027)", () => {
  const max = IGNORE_COMMAND_MAX;

  it("keeps Vercel's server-side ignoreCommand limit (its error: 256)", () => {
    expect(max).toBe(256);
  });

  /** A routed, otherwise-valid command padded to exactly `len` chars. */
  const padded = (len: number) => {
    const base = watchCmd();
    return base.replace(" --watch", `${" ".repeat(len - base.length)} --watch`);
  };

  it("control: a valid command of exactly maxLength chars is green", () => {
    const cmd = padded(max);
    expect(cmd).toHaveLength(max);
    expect(collectVercelViolations(synthetic(FULL, { ignoreCommand: cmd }), {}).violations).toEqual(
      [],
    );
  });

  it("RED: a 257-char ignoreCommand (maxLength + 1)", () => {
    const cmd = padded(max + 1);
    expect(cmd).toHaveLength(257);
    const v = collectVercelViolations(synthetic(FULL, { ignoreCommand: cmd }), {}).violations;
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/tightening/);
    expect(v[0]).toMatch(/ignoreCommand/);
    // The one tightening rule with server evidence says so, and cites it.
    expect(v[0]).toMatch(/Vercel's server enforces/);
    expect(v[0]).toMatch(/#1027.*should NOT be longer than 256 characters/);
    expect(v[0]).not.toMatch(/motebit's own tightening/);
  });

  /** The rest of the layer is motebit's: never labelled as a Vercel server rule. */
  const OWN_TIGHTENING: [string, Record<string, unknown>, string][] = [
    ["an unknown top-level key", { ignoreComand: "typo" }, "ignoreComand"],
    ["a wrong-typed known key (framework: 1)", { framework: 1 }, "framework"],
    ["regions: 5", { regions: 5 }, "regions"],
    ["git.deploymentEnabled: 'no'", { git: { deploymentEnabled: "no" } }, "deploymentEnabled"],
  ];

  it.each(OWN_TIGHTENING)("RED (motebit's own tightening): %s", (_n, extra, key) => {
    const v = collectVercelViolations(synthetic(FULL, extra), {}).violations;
    const t = v.filter((x) => x.includes("tightening"));
    expect(t, v.join("\n")).toHaveLength(1);
    expect(t[0]).toContain(key);
    expect(t[0]).toMatch(/motebit's own tightening.*not a Vercel verdict/);
    expect(t[0]).not.toMatch(/server enforces/);
  });

  it("RED: both kinds at once are each labelled for what they are", () => {
    const v = collectVercelViolations(
      synthetic(FULL, { ignoreCommand: padded(max + 1), ignoreComand: "typo" }),
      {},
    ).violations;
    expect(v).toHaveLength(1);
    expect(v[0]).toMatch(/server enforces[^|]*ignoreCommand must NOT/);
    expect(v[0]).toMatch(/\| motebit's own tightening[^|]*ignoreComand/);
  });

  /**
   * A cold review found these four pass the interim hand-written subset while
   * Vercel's own validator refuses them — and `vercel --prod` in
   * deploy-web.yml would refuse them on every production deploy.
   */
  const REFUSED_BY_VERCEL: [string, Record<string, unknown>, RegExp][] = [
    ["a rewrite with no destination", { rewrites: [{ source: "/a" }] }, /rewrites\/0.*destination/],
    ["an empty rewrite", { rewrites: [{}] }, /rewrites\/0.*source/],
    [
      "a rewrite with an extra key",
      { rewrites: [{ source: "/a", destination: "/b", extra: 1 }] },
      /rewrites\/0.*additional/,
    ],
    ['"headers": "x"', { headers: "x" }, /headers.*array/],
  ];

  it.each(REFUSED_BY_VERCEL)("RED (Vercel's own schema): %s", (_name, extra, why) => {
    const v = collectVercelViolations(synthetic(FULL, extra), {}).violations;
    expect(v, v.join("\n")).toHaveLength(1);
    expect(v[0]).toMatch(/Vercel/);
    expect(v[0]).toMatch(why);
  });

  /**
   * Cold review (vercel@62.2.0's validateConfig run side by side): schema-valid
   * configs the CLI still refuses — its post-schema affinity check — and that
   * `vercel build` refuses when getTransformedRoutes compiles the routes.
   */
  const REFUSED_AFTER_SCHEMA: [string, Record<string, unknown>, RegExp][] = [
    [
      'functions affinity "strict" with two regions',
      { functions: { "api/*.js": { regions: ["iad1", "sfo1"], affinity: { mode: "strict" } } } },
      /INVALID_FUNCTION_AFFINITY_REGIONS/,
    ],
    [
      'functions affinity "strict" with regions ["all"]',
      { functions: { "api/*.js": { regions: ["all"], affinity: { mode: "strict" } } } },
      /INVALID_FUNCTION_AFFINITY_REGIONS/,
    ],
    [
      "functions with builds",
      { functions: { "api/*.js": { memory: 1024 } }, builds: [{ use: "@vercel/node" }] },
      /FUNCTIONS_AND_BUILDS/,
    ],
    [
      'a rewrite source "/:(" (not a regex)',
      { rewrites: [{ source: "/:(", destination: "/b" }] },
      /getTransformedRoutes invalid_rewrite/,
    ],
    [
      'a route src "/a(" (not a regex)',
      { routes: [{ src: "/a(" }] },
      /getTransformedRoutes invalid_route/,
    ],
    [
      'a header source "/(" (not a regex)',
      { headers: [{ source: "/(", headers: [{ key: "x-a", value: "b" }] }] },
      /getTransformedRoutes invalid_header/,
    ],
    [
      'a redirect source "/a(" (not a regex)',
      { redirects: [{ source: "/a(", destination: "/b" }] },
      /getTransformedRoutes invalid_redirect/,
    ],
  ];

  it.each(REFUSED_AFTER_SCHEMA)("RED (Vercel, after its schema): %s", (_name, extra, why) => {
    const v = collectVercelViolations(synthetic(FULL, extra), {}).violations;
    expect(v, v.join("\n")).toHaveLength(1);
    expect(v[0]).toMatch(/Vercel's own checks/);
    expect(v[0]).toMatch(why);
  });

  it.each<[string, Record<string, unknown>]>([
    [
      'affinity "strict" with one region',
      { functions: { "api/*.js": { regions: ["iad1"], affinity: { mode: "strict" } } } },
    ],
    [
      'affinity "strict" with a duplicated region',
      { functions: { "api/*.js": { regions: ["iad1", "iad1"], affinity: { mode: "strict" } } } },
    ],
    ["a rewrite with a named param", { rewrites: [{ source: "/a/:id", destination: "/b/:id" }] }],
  ])("control (the CLI accepts it): %s", (_name, extra) => {
    expect(collectVercelViolations(synthetic(FULL, extra), {}).violations).toEqual([]);
  });

  it("labels a key it does not mirror as motebit's fail-closed rule, never as a Vercel refusal", () => {
    // vercel@62.2.0 accepts this config (scripts/__tests__/vercel-cli-verdicts.json "crons valid").
    const v = collectVercelViolations(
      synthetic(FULL, { crons: [{ path: "/api/c", schedule: "0 0 * * *" }] }),
      {},
    ).violations;
    expect(v, v.join("\n")).toHaveLength(1);
    expect(v[0]).toMatch(/motebit's fail-closed rule, not by Vercel/);
    expect(v[0]).toMatch(/crons/);
    expect(v[0]).not.toMatch(/fails Vercel|refuse this config/);
  });

  it("control: a valid rewrite and header set is green", () => {
    const v = collectVercelViolations(
      synthetic(FULL, {
        rewrites: [{ source: "/(.*)", destination: "/index.html" }],
        headers: [{ source: "/(.*)", headers: [{ key: "x-a", value: "b" }] }],
      }),
      {},
    ).violations;
    expect(v).toEqual([]);
  });

  it("validates a vercel.json with no ignoreCommand too", () => {
    const t = mk();
    put(t, "apps/verify/package.json", { name: "verify" });
    put(t, "apps/verify/vercel.json", { framework: "vite", rewritez: [] });
    const v = collectVercelViolations(t, {}).violations;
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("rewritez");
  });
});

describe("the watch file is exactly the build inputs", () => {
  it("RED: an extra path that is not a build input", () => {
    const t = synthetic([...FULL, "packages/unrelated"]);
    const v = collectVercelViolations(t, {}).violations;
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("`packages/unrelated`");
  });

  it("RED: a missing or empty watch file, or a duplicate line", () => {
    const missing = synthetic(FULL);
    rmSync(join(missing, WEB_WATCH));
    expect(collectVercelViolations(missing, {}).violations.join("\n")).toMatch(/watch file/);
    const empty = synthetic([]);
    expect(collectVercelViolations(empty, {}).violations.join("\n")).toMatch(/watch file/);
    const dup = synthetic([...FULL, "apps/web"]);
    expect(collectVercelViolations(dup, {}).violations.join("\n")).toMatch(/more than once/);
  });

  it("RED: a malformed line (whitespace, CR, absolute, ..)", () => {
    for (const bad of ["apps/web ", "apps/web\r", "/apps/web", "../apps/web"]) {
      const v = collectVercelViolations(synthetic([...FULL.slice(1), bad]), {}).violations;
      expect(v.length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
  });

  it("RED: the retired inline path list (and an unknown flag)", () => {
    const inline = collectVercelViolations(
      synthetic(FULL, { ignoreCommand: `sh ${SCRIPT} apps/web` }),
      {},
    ).violations;
    expect(inline.join("\n")).toMatch(/--watch/);
    const flag = collectVercelViolations(
      synthetic(FULL, { ignoreCommand: `${watchCmd()} --extra` }),
      {},
    ).violations;
    expect(flag.join("\n")).toMatch(/--watch/);
  });

  it("RED: a --watch path outside the repo or a missing file", () => {
    const v = collectVercelViolations(
      synthetic(FULL, { ignoreCommand: `sh ${SCRIPT} --watch ../../../outside.txt` }),
      {},
    ).violations;
    expect(v.join("\n")).toMatch(/watch file/);
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
    cpSync(join(REPO, "scripts/vercel-watch"), join(t, "scripts/vercel-watch"), {
      recursive: true,
    });
    cpSync(join(REPO, ".github/workflows"), join(t, ".github/workflows"), { recursive: true });
    return t;
  }

  const cfgOf = (f: string) =>
    JSON.parse(readFileSync(join(REPO, f), "utf8")) as { ignoreCommand: string; git?: unknown };
  /** The watch file a vercel.json names (`--watch <path relative to the project dir>`). */
  const watchOf = (f: string) => {
    const args = cfgOf(f).ignoreCommand.trim().split(/\s+/).slice(2);
    expect(args[0]).toBe("--watch");
    return join(dirname(f), args[1]!);
  };
  const pathsOf = (f: string) =>
    readFileSync(join(REPO, watchOf(f)), "utf8")
      .split("\n")
      .filter((l) => l.length > 0 && !l.startsWith("#"));
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

  it.each(VERCEL)("%s: committed ignoreCommand fits Vercel's 256-char limit", (f) => {
    const max = IGNORE_COMMAND_MAX;
    const cmd = (cfgOf(f) as { ignoreCommand?: string }).ignoreCommand ?? "";
    expect(cmd.length).toBeLessThanOrEqual(max);
  });

  it("gives apps/web production to deploy-web.yml alone (Git deploys of main off)", () => {
    expect(cfgOf("apps/web/vercel.json").git).toEqual({ deploymentEnabled: { main: false } });
  });

  it.each(PROJECTS)("%s: dropping any one watched path turns the gate red", (dir) => {
    const t = realCopy();
    const file = `${dir}/vercel.json`;
    const cfg = cfgOf(file);
    const watch = watchOf(file);
    for (const drop of pathsOf(file)) {
      const kept = pathsOf(file).filter((p) => p !== drop);
      put(t, watch, `${kept.join("\n")}\n`);
      const r = collectVercelViolations(t);
      expect(r.violations, drop).toHaveLength(1);
      expect(r.violations[0], drop).toContain(`\`${drop}\``);
    }
  });
});
