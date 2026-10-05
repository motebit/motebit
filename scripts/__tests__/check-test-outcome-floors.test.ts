/**
 * check-test-outcome-floors — the committed test floors are a ratchet:
 * raising or adding is GREEN; lowering without a matching allowedDecreases
 * entry, a package with no floor (a new one included), a floor for a package
 * that no longer runs coverage, and a stale or unused allowance are RED.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ratchetViolations } from "../check-test-outcome-floors.js";
import type { FloorsFile } from "../verify-test-outcomes.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PKGS = ["apps/cli", "packages/a"];
const ff = (
  floors: Record<string, number>,
  allowedDecreases: FloorsFile["allowedDecreases"] = {},
): FloorsFile => ({ floors, allowedDecreases });
const BASE = ff({ "apps/cli": 1017, "packages/a": 40 });

describe("ratchetViolations", () => {
  it("is GREEN when nothing changed", () => {
    expect(ratchetViolations(BASE, BASE, PKGS)).toEqual([]);
  });

  it("is GREEN when a floor is raised", () => {
    expect(ratchetViolations(BASE, ff({ "apps/cli": 1020, "packages/a": 40 }), PKGS)).toEqual([]);
  });

  it("is RED when a floor is lowered without an allowance", () => {
    const v = ratchetViolations(BASE, ff({ "apps/cli": 11, "packages/a": 40 }), PKGS);
    expect(v).toEqual([
      expect.stringMatching(/^apps\/cli: floor lowered 1017 → 11 with no allowedDecreases/),
    ]);
  });

  it("is GREEN when a floor is lowered with a matching { from, to, reason } allowance", () => {
    const cur = ff(
      { "apps/cli": 1010, "packages/a": 40 },
      { "apps/cli": { from: 1017, to: 1010, reason: "deleted the legacy ollama tests" } },
    );
    expect(ratchetViolations(BASE, cur, PKGS)).toEqual([]);
  });

  it("is RED when the allowance names a different decrease than the one made", () => {
    const cur = ff(
      { "apps/cli": 11, "packages/a": 40 },
      { "apps/cli": { from: 1017, to: 1010, reason: "r" } },
    );
    expect(ratchetViolations(BASE, cur, PKGS).length).toBeGreaterThan(0);
  });

  it("is RED when a package has no floor", () => {
    const v = ratchetViolations(BASE, ff({ "apps/cli": 1017 }), PKGS);
    expect(v).toEqual([
      expect.stringMatching(/^packages\/a: has a test:coverage script but no floor/),
    ]);
  });

  it("is RED when a NEW package (not in the baseline) arrives without a floor, GREEN once it has one", () => {
    const pkgs = [...PKGS, "packages/new"];
    expect(ratchetViolations(BASE, BASE, pkgs)).toEqual([
      expect.stringMatching(/^packages\/new: has a test:coverage script but no floor/),
    ]);
    expect(ratchetViolations(BASE, ff({ ...BASE.floors, "packages/new": 3 }), pkgs)).toEqual([]);
  });

  it("is RED on a floor for a package that no longer runs coverage, GREEN once it is dropped", () => {
    expect(ratchetViolations(BASE, BASE, ["apps/cli"]).length).toBe(1);
    expect(ratchetViolations(BASE, ff({ "apps/cli": 1017 }), ["apps/cli"])).toEqual([]);
  });

  it("is RED on an allowance this change adds for no decrease", () => {
    const cur = ff(BASE.floors, { "packages/a": { from: 50, to: 40, reason: "r" } });
    expect(ratchetViolations(BASE, cur, PKGS)).toEqual([
      expect.stringMatching(/allowedDecreases\[packages\/a\] is added by this change/),
    ]);
  });

  it("keeps an allowance inherited unchanged from the baseline (the last reviewed lowering)", () => {
    const base = ff(BASE.floors, { "packages/a": { from: 50, to: 40, reason: "r" } });
    expect(ratchetViolations(base, base, PKGS)).toEqual([]);
  });

  it("is RED on an allowance whose `to` is no longer the floor", () => {
    const base = ff(BASE.floors, { "packages/a": { from: 50, to: 40, reason: "r" } });
    const cur = ff({ "apps/cli": 1017, "packages/a": 45 }, base.allowedDecreases);
    expect(ratchetViolations(base, cur, PKGS)).toEqual([expect.stringMatching(/stale allowance/)]);
  });

  it("with no baseline, still requires a floor for every package", () => {
    expect(ratchetViolations(null, ff({ "apps/cli": 1 }), PKGS).length).toBe(1);
    expect(ratchetViolations(null, BASE, PKGS)).toEqual([]);
  });
});

describe("the gate over the real repo", () => {
  it("exits 0 and states its aperture", () => {
    const r = spawnSync(
      join(ROOT, "node_modules", ".bin", "tsx"),
      [join(ROOT, "scripts", "check-test-outcome-floors.ts")],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/examined \d+ workspace package\(s\)/);
  });
});
