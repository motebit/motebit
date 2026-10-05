/**
 * check-test-outcome-floors — the committed test floors are a ratchet:
 * raising or adding is GREEN; lowering without a matching allowedDecreases
 * entry, a package with no floor (a new one included), a floor for a package
 * that no longer runs coverage, and a stale or unused allowance are RED.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { baseline, ratchetViolations } from "../check-test-outcome-floors.js";
import { cleanEnv } from "../lib/differential-tree.js";
import { FLOORS_FILE, type FloorsFile } from "../verify-test-outcomes.js";

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

// ── Base resolution per event, by execution in a temp git repo ──────────
//
// `baseline` resolves the base exactly as check-cli-surface does
// (resolveBaseRef): merge_group → the payload's base_sha (GITHUB_BASE_REF is
// unset on that event), pull_request → origin/<GITHUB_BASE_REF>, push / local
// → origin/main. Each case pins main's floors at one value and the change's
// at another, so the label AND the floors prove which commit was read.
describe("baseline — the base per event", () => {
  const ID = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"];
  const dirs: string[] = [];
  const g = (cwd: string, ...args: string[]): string => {
    const r = spawnSync("git", [...ID, "-c", "commit.gpgsign=false", ...args], {
      cwd,
      env: cleanEnv(),
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const floorsAt = (dir: string, n: number): string => {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(
      join(dir, FLOORS_FILE),
      JSON.stringify({ floors: { "apps/cli": n }, allowedDecreases: {} }),
    );
    g(dir, "add", "-A");
    g(dir, "commit", "-q", "-m", `floor ${n}`);
    return g(dir, "rev-parse", "HEAD");
  };
  /** main at floor 100; the change (HEAD) at 101; origin/main pinned to main. */
  const fixture = (): { dir: string; main: string } => {
    const dir = mkdtempSync(join(tmpdir(), "floors-base-"));
    dirs.push(dir);
    g(dir, "init", "-q", "-b", "main");
    const main = floorsAt(dir, 100);
    g(dir, "checkout", "-q", "-b", "change");
    floorsAt(dir, 101);
    g(dir, "update-ref", "refs/remotes/origin/main", main);
    return { dir, main };
  };
  const event = (dir: string, payload: unknown): string => {
    const p = join(dir, "..", `${dir.split("/").pop()}-event.json`);
    writeFileSync(p, JSON.stringify(payload));
    dirs.push(p);
    return p;
  };
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const ok = (r: ReturnType<typeof baseline>) => {
    if (typeof r === "string") throw new Error(`failed closed: ${r}`);
    return r;
  };

  it("pull_request: origin/<GITHUB_BASE_REF>", () => {
    const { dir, main } = fixture();
    const r = ok(
      baseline(
        [],
        { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" },
        dir,
      ),
    );
    expect(r.label).toBe(`the merge-base ${main.slice(0, 10)} (origin/main)`);
    expect(r.floors?.floors["apps/cli"]).toBe(100);
  });

  it("merge_group: the payload's base_sha, with GITHUB_BASE_REF unset and no origin/main", () => {
    const { dir, main } = fixture();
    g(dir, "update-ref", "-d", "refs/remotes/origin/main");
    const r = ok(
      baseline(
        [],
        {
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "merge_group",
          GITHUB_EVENT_PATH: event(dir, { merge_group: { base_sha: main } }),
        },
        dir,
      ),
    );
    expect(r.label).toBe(`the merge-base ${main.slice(0, 10)} (${main})`);
    expect(r.floors?.floors["apps/cli"]).toBe(100);
  });

  it("merge_group without a readable base_sha fails CLOSED (never falls back to origin/main)", () => {
    const { dir } = fixture();
    const r = baseline(
      [],
      {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "merge_group",
        GITHUB_EVENT_PATH: event(dir, { merge_group: {} }),
      },
      dir,
    );
    expect(r).toMatch(/merge_group event without a readable merge_group\.base_sha/);
  });

  it("push (and local): origin/main", () => {
    const { dir, main } = fixture();
    for (const env of [{ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push" }, {}]) {
      const r = ok(baseline([], env, dir));
      expect(r.label).toBe(`the merge-base ${main.slice(0, 10)} (origin/main)`);
      expect(r.floors?.floors["apps/cli"]).toBe(100);
    }
  });

  it("a shallow clone (no origin/<base>) fails CLOSED on pull_request — the #1062 CI shape", () => {
    const { dir } = fixture();
    const shallow = mkdtempSync(join(tmpdir(), "floors-shallow-"));
    dirs.push(shallow);
    g(shallow, "clone", "-q", "--depth", "1", "--branch", "change", `file://${dir}`, "c");
    const r = baseline(
      [],
      { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main" },
      join(shallow, "c"),
    );
    expect(r).toBe("`origin/main` (pull_request base) does not resolve to a commit");
  });
});
