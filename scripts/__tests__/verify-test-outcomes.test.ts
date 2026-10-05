/**
 * verify-test-outcomes — the `check` verdict reads what vitest itself wrote,
 * never a shard runner's exit code or package list. GREEN on the artifacts a
 * correct sharded run uploads; RED on the artifacts each known runner bypass
 * leaves behind (B1 exit-code zeroing, the GITHUB_JOB return-0 runner, B2 an
 * enumeration that skips apps/web) and on every per-package failure shape
 * (missing results, failed tests, zero tests, all or most tests skipped by a
 * filter, unhandled errors, coverage or a per-glob floor below threshold,
 * duplicates, foreign or copied results, a tracked coverage/ file, results
 * older than their shard job) — and on a suite whose DECLARATION was narrowed
 * (one file named, --shard, --changed, deleted tests): below its committed
 * test floor, or with no floor at all. `--write-floors` is a ratchet.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_NAMES,
  FLOORS_FILE,
  formatFloors,
  nextFloors,
  readFloors,
  MIN_RUN_SHARE,
  NO_THRESHOLD_PACKAGES,
  SKIP_HEAVY_PACKAGES,
  ZERO_TEST_PACKAGES,
  trackedCoverageFiles,
  globToRegExp,
  pct,
  verifyOutcomes,
  workspaceCoveragePackages,
} from "../verify-test-outcomes.js";
import {
  RED_VARIANTS,
  greenFixture,
  materialize,
  type OutcomeFixture,
} from "../lib/test-outcomes-fixture.js";
import { readPackageThresholds } from "../lib/vitest-thresholds.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function withFixture<T>(f: OutcomeFixture, fn: (p: { root: string; artifacts: string }) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "verify-outcomes-"));
  try {
    return fn(materialize(f, dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("verifyOutcomes over fixture artifacts", () => {
  it("is GREEN on a correct sharded run", () => {
    const r = withFixture(greenFixture(), ({ root, artifacts }) => verifyOutcomes(root, artifacts));
    expect(r.violations).toEqual([]);
    expect(r.packages).toEqual([
      "apps/cli",
      "apps/web",
      "packages/circuit-breaker",
      "services/relay",
    ]);
    expect(r.tests).toBe(28);
  });

  for (const [id, { what, mutate }] of Object.entries(RED_VARIANTS)) {
    it(`is RED on ${id} — ${what}`, () => {
      const f = greenFixture();
      mutate(f);
      const r = withFixture(f, ({ root, artifacts }) => verifyOutcomes(root, artifacts));
      expect(r.violations.length).toBeGreaterThan(0);
    });
  }

  it("names apps/cli when a -t filter skipped its whole suite (apps/cli has no coverage floor)", () => {
    const f = greenFixture();
    RED_VARIANTS["all-skipped-name-filter"]!.mutate(f);
    const r = withFixture(f, ({ root, artifacts }) => verifyOutcomes(root, artifacts));
    expect(r.violations.join("\n")).toMatch(/apps\/cli: 0 of 7 tests passed/);
  });

  it("a suite narrowed to one file is RED by its floor alone — every other rule passes it", () => {
    const f = greenFixture();
    RED_VARIANTS["narrowed-to-one-file"]!.mutate(f);
    const r = withFixture(f, ({ root, artifacts }) => verifyOutcomes(root, artifacts));
    expect(r.violations).toEqual(r.floorViolations);
    expect(r.violations).toEqual([
      expect.stringMatching(/^apps\/cli: 1 test\(s\) passed, below its committed floor of 7/),
    ]);
  });

  it("names the new package that has no floor", () => {
    const f = greenFixture();
    RED_VARIANTS["new-package-without-floor"]!.mutate(f);
    const r = withFixture(f, ({ root, artifacts }) => verifyOutcomes(root, artifacts));
    expect(r.violations).toEqual([
      expect.stringMatching(/^packages\/brand-new: no entry in scripts\/test-outcome-floors\.json/),
    ]);
  });

  it("is GREEN when a suite passes MORE than its floor (a floor is a minimum)", () => {
    const f = greenFixture();
    f.floors = { "apps/cli": 3, "apps/web": 7, "packages/circuit-breaker": 1, "services/relay": 7 };
    const r = withFixture(f, ({ root, artifacts }) => verifyOutcomes(root, artifacts));
    expect(r.violations).toEqual([]);
    expect(r.passed["apps/cli"]).toBe(7);
  });

  it("counts only PASSED tests, never skipped or todo", () => {
    const f = greenFixture();
    const r0 = f.shards["coverage-shard-0"]!["services/relay"]!.results!;
    r0.numTotalTests = 71;
    r0.numPassedTests = 70;
    r0.numPendingTests = 1;
    const r = withFixture(f, ({ root, artifacts }) => verifyOutcomes(root, artifacts));
    expect(r.violations).toEqual([]);
    expect(r.tests).toBe(91);
  });

  it("names the package B2 dropped", () => {
    const f = greenFixture();
    RED_VARIANTS["B2-enumeration-skips-web"]!.mutate(f);
    const r = withFixture(f, ({ root, artifacts }) => verifyOutcomes(root, artifacts));
    expect(r.violations.join("\n")).toMatch(/apps\/web: no shard artifact carries/);
  });

  it("is RED when no shard artifact was downloaded at all", () => {
    const f = greenFixture();
    f.shards = {};
    const r = withFixture(f, ({ root, artifacts }) => verifyOutcomes(root, artifacts));
    expect(r.violations.length).toBeGreaterThan(0);
  });
});

describe("the CLI the `check` job runs", () => {
  const cli = (f: OutcomeFixture) =>
    withFixture(f, ({ root, artifacts }) =>
      spawnSync(
        join(ROOT, "node_modules", ".bin", "tsx"),
        [
          join(ROOT, "scripts", "verify-test-outcomes.ts"),
          "--artifacts",
          artifacts,
          "--root",
          root,
        ],
        { cwd: ROOT, encoding: "utf8" },
      ),
    );

  it("exits 0 and states its aperture on the GREEN fixture", () => {
    const r = cli(greenFixture());
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/examined 4 workspace package/);
    expect(r.stdout).toMatch(/28 test\(s\) passed \(skipped\/todo not counted/);
  });

  it("exits non-zero on B1 (vitest's own results say a test failed)", () => {
    const f = greenFixture();
    RED_VARIANTS["B1-exitcode-zeroed"]!.mutate(f);
    const r = cli(f);
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/packages\/circuit-breaker: numFailedTests is 1/);
  });
});

describe("--write-floors: the ratchet", () => {
  const tsx = join(ROOT, "node_modules", ".bin", "tsx");
  const write = (root: string, artifacts: string, ...extra: string[]) =>
    spawnSync(
      tsx,
      [
        join(ROOT, "scripts", "verify-test-outcomes.ts"),
        "--artifacts",
        artifacts,
        "--root",
        root,
        "--write-floors",
        ...extra,
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
  const floorsAt = (root: string) => {
    const f = readFloors(root);
    if (typeof f === "string") throw new Error(f);
    return f;
  };

  it("measures every package from a full green run when there is no floors file", () => {
    const f = greenFixture();
    f.floors = null;
    withFixture(f, ({ root, artifacts }) => {
      const r = write(root, artifacts);
      expect(r.status, r.stderr).toBe(0);
      expect(floorsAt(root).floors).toEqual({
        "apps/cli": 7,
        "apps/web": 7,
        "packages/circuit-breaker": 7,
        "services/relay": 7,
      });
      expect(verifyOutcomes(root, artifacts).violations).toEqual([]);
    });
  });

  it("raises a floor (GREEN) and never lowers one without --allow-lower (RED, floor kept)", () => {
    const f = greenFixture();
    f.floors = { "apps/cli": 5, "apps/web": 9, "packages/circuit-breaker": 7, "services/relay": 7 };
    withFixture(f, ({ root, artifacts }) => {
      const r = write(root, artifacts);
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/raised \(1\): apps\/cli 5 → 7/);
      expect(r.stderr).toMatch(/apps\/web measured 7 < floor 9/);
      expect(floorsAt(root).floors["apps/cli"]).toBe(7);
      expect(floorsAt(root).floors["apps/web"]).toBe(9);
      expect(floorsAt(root).allowedDecreases).toEqual({});
    });
  });

  it("lowers only with --allow-lower and a reason, recording {from, to, reason}", () => {
    const f = greenFixture();
    f.floors = { "apps/cli": 7, "apps/web": 9, "packages/circuit-breaker": 7, "services/relay": 7 };
    withFixture(f, ({ root, artifacts }) => {
      expect(write(root, artifacts, "--allow-lower").status).toBe(2);
      const r = write(root, artifacts, "--allow-lower", "deleted two obsolete web tests");
      expect(r.status, r.stderr).toBe(0);
      expect(floorsAt(root).floors["apps/web"]).toBe(7);
      expect(floorsAt(root).allowedDecreases).toEqual({
        "apps/web": { from: 9, to: 7, reason: "deleted two obsolete web tests" },
      });
    });
  });

  it("refuses to measure from a run that is not green in every other respect", () => {
    const f = greenFixture();
    RED_VARIANTS["B1-exitcode-zeroed"]!.mutate(f);
    withFixture(f, ({ root, artifacts }) => {
      const before = readFileSync(join(root, FLOORS_FILE), "utf8");
      const r = write(root, artifacts);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/--write-floors refused/);
      expect(readFileSync(join(root, FLOORS_FILE), "utf8")).toBe(before);
    });
  });

  it("nextFloors drops a removed package's floor and an allowance that no longer describes the floor", () => {
    const u = nextFloors(
      {
        floors: { a: 5, b: 9, gone: 3 },
        allowedDecreases: {
          b: { from: 12, to: 9, reason: "r" },
          a: { from: 6, to: 4, reason: "r" },
        },
      },
      { a: 6, b: 9 },
      null,
    );
    expect(u.next.floors).toEqual({ a: 6, b: 9 });
    expect(u.next.allowedDecreases).toEqual({ b: { from: 12, to: 9, reason: "r" } });
    expect(u.removed).toEqual(["gone"]);
    expect(formatFloors(u.next).endsWith("}\n")).toBe(true);
  });

  it("the written file round-trips through the reader", () => {
    const dir = mkdtempSync(join(tmpdir(), "floors-rt-"));
    try {
      const ff = { floors: { "apps/x": 3 }, allowedDecreases: {} };
      writeFileSync(join(dir, "f.json"), formatFloors(ff));
      expect(JSON.parse(readFileSync(join(dir, "f.json"), "utf8"))).toEqual(ff);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("independence from the shard runner", () => {
  const importsOf = (file: string) =>
    [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(
      (m) => m[1]!,
    );

  it("imports nothing from scripts/test-coverage-shards.ts, directly or through its local imports", () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of importsOf(file)) {
        expect(spec).not.toMatch(/test-coverage-shards/);
        if (spec.startsWith(".")) visit(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
      }
    };
    visit(join(ROOT, "scripts", "verify-test-outcomes.ts"));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("over the real workspace", () => {
  const pkgs = workspaceCoveragePackages(ROOT);

  it("enumerates every package.json that declares test:coverage", () => {
    const byScan = ["packages", "apps", "services"]
      .flatMap((b) => readdirSync(join(ROOT, b)).map((d) => `${b}/${d}`))
      .filter((p) => {
        try {
          const j = JSON.parse(readFileSync(join(ROOT, p, "package.json"), "utf8")) as {
            scripts?: Record<string, string>;
          };
          return typeof j.scripts?.["test:coverage"] === "string";
        } catch {
          return false;
        }
      })
      .sort();
    expect(pkgs).toEqual(byScan);
    expect(pkgs.length).toBeGreaterThan(50);
  });

  it("every package's vitest config emits the shared reporters the verdict reads", () => {
    const missing = pkgs.filter((p) => {
      const cfg = CONFIG_NAMES.map((n) => join(ROOT, p, n)).find((f) => {
        try {
          readFileSync(f);
          return true;
        } catch {
          return false;
        }
      });
      if (!cfg) return true;
      const src = readFileSync(cfg, "utf8");
      return !/defineMotebitTest\(|MOTEBIT_TEST_REPORTERS/.test(src);
    });
    expect(missing).toEqual([]);
  });

  it("every package declares thresholds or carries a reasoned NO_THRESHOLD_PACKAGES entry, and no allowlist entry is stale", () => {
    for (const p of pkgs) {
      const cfg = CONFIG_NAMES.map((n) => join(ROOT, p, n)).find((f) => existsSync(f));
      const has = cfg !== undefined && readPackageThresholds(cfg) !== null;
      expect(has || p in NO_THRESHOLD_PACKAGES, p).toBe(true);
      expect(has && p in NO_THRESHOLD_PACKAGES, p).toBe(false);
    }
    for (const p of [
      ...Object.keys(NO_THRESHOLD_PACKAGES),
      ...Object.keys(ZERO_TEST_PACKAGES),
      ...Object.keys(SKIP_HEAVY_PACKAGES),
    ])
      expect(pkgs).toContain(p);
  });

  it("every SKIP_HEAVY_PACKAGES entry gives a reason and a floor below the default", () => {
    for (const [p, e] of Object.entries(SKIP_HEAVY_PACKAGES)) {
      expect(e.reason.length, p).toBeGreaterThan(20);
      expect(e.minRunShare, p).toBeGreaterThan(0);
      expect(e.minRunShare, p).toBeLessThan(MIN_RUN_SHARE);
    }
  });

  it("the committed floors file has a positive floor for exactly the packages with test:coverage", () => {
    const ff = readFloors(ROOT);
    if (typeof ff === "string") throw new Error(ff);
    expect(Object.keys(ff.floors).sort()).toEqual(pkgs);
    expect(readFileSync(join(ROOT, FLOORS_FILE), "utf8")).toBe(formatFloors(ff));
  });

  it("tracks nothing under any coverage/ directory", () => {
    expect(trackedCoverageFiles(ROOT)).toEqual([]);
  });
});

describe("helpers", () => {
  it("pct matches istanbul (truncated, 100 when empty)", () => {
    expect(pct(0, 0)).toBe(100);
    expect(pct(2, 3)).toBe(66.66);
    expect(pct(1, 1)).toBe(100);
  });

  it("globToRegExp matches the per-glob floor shapes in use", () => {
    const re = globToRegExp("**/adapters.ts");
    expect(re.test("src/adapters.ts")).toBe(true);
    expect(re.test("adapters.ts")).toBe(true);
    expect(re.test("src/x/adapters.ts")).toBe(true);
    expect(re.test("src/my-adapters.ts")).toBe(false);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
  });
});
