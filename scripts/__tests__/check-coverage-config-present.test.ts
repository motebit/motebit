/**
 * check-coverage-config-present — presence for test-bearing packages, services
 * and in-scope apps; tier floors for registry members.
 *
 * Drives `checkCoverageConfigPresent(root, { registry, triggers })` over a small
 * fixture tree built per test, so each failure the gate exists to catch is
 * planted alone against a tree that is otherwise green. One case also runs the
 * gate over the real repo. Tamper entries: scripts/tampers/coverage-config-present.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCoverageConfigPresent, formatReport } from "../check-coverage-config-present.ts";
import { hasApertureDisclosure, hasRepairInstruction } from "../lib/gate-report.ts";
import type { PathTier } from "../money-identity-path.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const TRIGGER = "@motebit/fixture-wallet";
const TRIGGERS: ReadonlySet<string> = new Set([TRIGGER]);
const NO_REGISTRY: ReadonlyMap<string, PathTier> = new Map();

const FLOORED = `export default { test: { coverage: { thresholds: { statements: 47, branches: 43, functions: 59, lines: 46 } } } };\n`;
const UNFLOORED = `export default { test: { coverage: { reporter: ["text"] } } };\n`;

let root: string;

interface Unit {
  pkg: Record<string, unknown>;
  tests?: boolean;
  config?: string;
}

function plant(rel: string, unit: Unit): void {
  const dir = join(root, rel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(unit.pkg));
  if (unit.tests !== false) {
    mkdirSync(join(dir, "src", "__tests__"), { recursive: true });
    writeFileSync(join(dir, "src", "__tests__", "a.test.ts"), "");
  }
  if (unit.config !== undefined) writeFileSync(join(dir, "vitest.config.ts"), unit.config);
}

function run(registry: ReadonlyMap<string, PathTier> = NO_REGISTRY) {
  return checkCoverageConfigPresent(root, { registry, triggers: TRIGGERS });
}

function flagged(registry?: ReadonlyMap<string, PathTier>): string[] {
  return run(registry).violations.map((v) => `${v.package} [${v.kind}]`);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "coverage-config-present-"));
  // An otherwise-green tree: a floored package, a floored service, a floored
  // in-scope app and an out-of-scope app with no config.
  plant("packages/lib", { pkg: { name: "@motebit/lib", private: true }, config: FLOORED });
  plant("services/svc", { pkg: { name: "@motebit/svc", private: true }, config: FLOORED });
  plant("apps/surface", {
    pkg: { name: "@motebit/surface", private: true, dependencies: { [TRIGGER]: "workspace:*" } },
    config: FLOORED,
  });
  plant("apps/console", { pkg: { name: "@motebit/console", private: true } });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("check-coverage-config-present failure cases", () => {
  it("the green fixture tree passes", () => {
    expect(flagged()).toEqual([]);
  });

  it("a published test-bearing app with no thresholds fails", () => {
    plant("apps/cli", { pkg: { name: "motebit" }, config: UNFLOORED });
    expect(flagged()).toEqual(["motebit [missing-config]"]);
  });

  it("a published test-bearing app with no vitest.config.ts fails", () => {
    plant("apps/cli", { pkg: { name: "motebit" } });
    expect(flagged()).toEqual(["motebit [missing-config]"]);
  });

  it("a private app with a trigger only in devDependencies and no thresholds fails", () => {
    plant("apps/bundled", {
      pkg: {
        name: "@motebit/bundled",
        private: true,
        devDependencies: { [TRIGGER]: "workspace:*" },
      },
      config: UNFLOORED,
    });
    expect(flagged()).toEqual(["@motebit/bundled [missing-config]"]);
  });

  it("a private app with a trigger in dependencies and no thresholds fails", () => {
    plant("apps/wallet-app", {
      pkg: { name: "@motebit/wallet-app", private: true, dependencies: { [TRIGGER]: "1.0.0" } },
    });
    expect(flagged()).toEqual(["@motebit/wallet-app [missing-config]"]);
  });

  it("a private app with a trigger in peerDependencies and no thresholds fails", () => {
    plant("apps/peer-app", {
      pkg: { name: "@motebit/peer-app", private: true, peerDependencies: { [TRIGGER]: "1.0.0" } },
    });
    expect(flagged()).toEqual(["@motebit/peer-app [missing-config]"]);
  });

  it("a test-bearing package with no thresholds fails", () => {
    plant("packages/bare", { pkg: { name: "@motebit/bare", private: true }, config: UNFLOORED });
    expect(flagged()).toEqual(["@motebit/bare [missing-config]"]);
  });

  it("a test-bearing service with no vitest.config.ts fails", () => {
    plant("services/bare", { pkg: { name: "@motebit/bare-svc", private: true } });
    expect(flagged()).toEqual(["@motebit/bare-svc [missing-config]"]);
  });

  it("a registry member below its tier floor fails", () => {
    expect(flagged(new Map([["@motebit/lib", "money"]]))).toEqual(["@motebit/lib [below-floor]"]);
  });

  it("a registry member not under packages/ fails", () => {
    expect(flagged(new Map([["@motebit/ghost", "identity"]]))).toEqual([
      "@motebit/ghost [missing-config]",
    ]);
  });

  it("the failure output carries a repair instruction", () => {
    plant("apps/cli", { pkg: { name: "motebit" }, config: UNFLOORED });
    const out = formatReport(run(), root);
    expect(out).toContain("✗ motebit [missing-config]");
    expect(hasRepairInstruction(out)).toEqual({ ok: true });
  });
});

describe("check-coverage-config-present scope", () => {
  it("a private, trigger-free app without a config is out of scope", () => {
    const report = run();
    expect(report.violations).toEqual([]);
    expect(report.apps.find((a) => a.name === "@motebit/console")?.reasons).toEqual([]);
  });

  it("an in-scope app without src/__tests__ is not a violation", () => {
    plant("apps/untested", { pkg: { name: "@motebit/untested" }, tests: false });
    const report = run();
    expect(report.violations).toEqual([]);
    expect(report.apps.find((a) => a.name === "@motebit/untested")?.reasons).toEqual(["published"]);
  });

  it("a registry member carried in the graduation manifest is floor-exempt", () => {
    writeFileSync(
      join(root, "coverage-graduation.json"),
      JSON.stringify({ packages: [{ package: "@motebit/lib" }] }),
    );
    expect(flagged(new Map([["@motebit/lib", "money"]]))).toEqual([]);
  });

  it("the passing output names every app and why it is in or out of scope", () => {
    plant("apps/cli", {
      pkg: { name: "motebit", devDependencies: { [TRIGGER]: "workspace:*" } },
      config: FLOORED,
    });
    const out = formatReport(run(), root);
    expect(out).toContain(`apps/cli (motebit): published; money/identity path via ${TRIGGER}`);
    expect(out).toContain(`apps/surface (@motebit/surface): money/identity path via ${TRIGGER}`);
    expect(out).toContain(
      "apps out of scope (1 apps — private, no trigger dependency): apps/console",
    );
    expect(hasApertureDisclosure(out)).toEqual({ ok: true });
  });
});

describe("check-coverage-config-present over the real repo", () => {
  it("passes, and holds the published, money-signing CLI to a floor", () => {
    const report = checkCoverageConfigPresent(REPO_ROOT);
    expect(report.violations).toEqual([]);
    const cli = report.apps.find((a) => a.name === "motebit");
    expect(cli?.hasTests).toBe(true);
    expect(cli?.reasons).toContain("published");
    expect(cli?.reasons.some((r) => r.includes("@motebit/wallet-solana"))).toBe(true);
  });
});
