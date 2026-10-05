/**
 * check-cli-surface — the release-robustness contract (#739).
 *
 * The pre-2026-10 gate excused an unwritten baseline while any
 * `motebit: major` changeset was pending; `changeset version` deletes that
 * changeset, so the Version Packages commit went red. These tests pin the
 * replacement rule on the gate's pure decision:
 *   - any drift from the committed baseline bites, pending major or not;
 *   - a declared breaking change (baseline stamped as the next major +
 *     pending `motebit: major`) is green;
 *   - the same tree after `changeset version` (changeset consumed, package
 *     major caught up with the stamp) is green;
 *   - a breaking stamp with nothing declaring it bites.
 * Plus a smoke run against the real repo.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateSurface,
  stampForWrite,
  type CliSurface,
  type CliSurfaceBaseline,
} from "../check-cli-surface.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SURFACE: CliSurface = {
  subcommands: { doctor: [], relay: ["up"] },
  flags: [
    { name: "provider", type: "string" },
    { name: "yes", type: "boolean", default: false },
  ],
  exitCodes: [0, 1],
  onDiskLayout: ["config.json"],
};

function withSubcommand(s: CliSurface, name: string): CliSurface {
  return { ...s, subcommands: { ...s.subcommands, [name]: [] } };
}
function withoutFlag(s: CliSurface, name: string): CliSurface {
  return { ...s, flags: s.flags.filter((f) => f.name !== name) };
}

describe("check-cli-surface decision", () => {
  it("bites on an unwritten drift even while a motebit major is pending", () => {
    const baseline: CliSurfaceBaseline = { motebitMajor: 1, ...SURFACE };
    const current = withSubcommand(SURFACE, "status");
    for (const majorPending of [false, true]) {
      const v = evaluateSurface({ current, baseline, pkgMajor: 1, majorPending });
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toBe("drift");
    }
  });

  it("an additive change keeps the stamp — green with no major, before and after a release", () => {
    const previous: CliSurfaceBaseline = { motebitMajor: 1, ...SURFACE };
    const current = withSubcommand(SURFACE, "status");
    const stamp = stampForWrite(current, previous, 1);
    expect(stamp).toBe(1);
    const baseline = { motebitMajor: stamp, ...current };
    expect(evaluateSurface({ current, baseline, pkgMajor: 1, majorPending: false }).ok).toBe(true);
    // An unrelated major releasing (changeset consumed, package at 2) stays green.
    expect(evaluateSurface({ current, baseline, pkgMajor: 2, majorPending: false }).ok).toBe(true);
  });

  it("a declared breaking change is green, and stays green after `changeset version`", () => {
    const previous: CliSurfaceBaseline = { motebitMajor: 1, ...SURFACE };
    const current = withoutFlag(SURFACE, "yes");
    const stamp = stampForWrite(current, previous, 1);
    expect(stamp).toBe(2);
    const baseline = { motebitMajor: stamp, ...current };
    // Pre-release: pending `motebit: major` declares it.
    expect(evaluateSurface({ current, baseline, pkgMajor: 1, majorPending: true }).ok).toBe(true);
    // Release commit: changeset consumed, apps/cli/package.json at 2.0.0.
    expect(evaluateSurface({ current, baseline, pkgMajor: 2, majorPending: false }).ok).toBe(true);
  });

  it("bites on a breaking stamp that no pending changeset declares", () => {
    const current = withoutFlag(SURFACE, "yes");
    const baseline: CliSurfaceBaseline = { motebitMajor: 2, ...current };
    const v = evaluateSurface({ current, baseline, pkgMajor: 1, majorPending: false });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("undeclared-major");
  });

  it("re-running --write after a breaking write never lowers the promise", () => {
    const current = withoutFlag(SURFACE, "yes");
    const afterFirstWrite: CliSurfaceBaseline = { motebitMajor: 2, ...current };
    expect(stampForWrite(current, afterFirstWrite, 1)).toBe(2);
  });
});

describe("check-cli-surface (smoke)", () => {
  it("passes against the real repo", () => {
    const result = spawnSync("npx", ["tsx", resolve(ROOT, "scripts/check-cli-surface.ts")], {
      encoding: "utf-8",
      cwd: ROOT,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("all match baseline");
  });
});
