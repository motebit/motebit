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
 * Plus a smoke run against the real repo, and — by execution in temp git
 * repos — the merge-base rule: a break is judged against the baseline at the
 * merge-base and must be declared by a `motebit: major` changeset THIS change
 * adds (stamp tamper, hand-edited baseline, and the stale-branch race with an
 * unrelated pending major are all RED; an unresolvable base fails closed).
 */
import { afterAll, describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  declaresMotebitMajor,
  evaluateChangeSet,
  evaluateSurface,
  resolveBaseRef,
  stampForWrite,
  type CliSurface,
  type CliSurfaceBaseline,
} from "../check-cli-surface.js";
import { cleanEnv } from "../lib/differential-tree.js";

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

  it("parses a `motebit: major` declaration in any YAML key quoting", () => {
    for (const key of ['"motebit"', "'motebit'", "motebit"]) {
      expect(declaresMotebitMajor(`---\n${key}: major\n---\n\nx\n`)).toBe(true);
    }
    expect(declaresMotebitMajor('---\n"motebit": minor\n---\n')).toBe(false);
    expect(declaresMotebitMajor('---\n"@motebit/sdk": major\n---\n')).toBe(false);
    expect(declaresMotebitMajor('"motebit": major\n')).toBe(false);
  });

  it("resolves the base from the CI event, never silently", () => {
    expect(resolveBaseRef([], {})).toMatchObject({ ok: true, ref: "origin/main" });
    expect(resolveBaseRef(["--base", "abc"], { GITHUB_ACTIONS: "true" })).toMatchObject({
      ok: true,
      ref: "abc",
    });
    expect(
      resolveBaseRef([], {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_BASE_REF: "release",
      }),
    ).toMatchObject({ ok: true, ref: "origin/release" });
    expect(
      resolveBaseRef([], { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request" }).ok,
    ).toBe(false);
    expect(
      resolveBaseRef([], {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "merge_group",
        GITHUB_EVENT_PATH: "/nonexistent/event.json",
      }).ok,
    ).toBe(false);
    expect(resolveBaseRef(["--base"], {}).ok).toBe(false);
  });

  it("change set: a break needs a declaration from THIS change; additions never do", () => {
    const current = withoutFlag(SURFACE, "yes");
    const undeclared = evaluateChangeSet({
      current,
      mergeBaseBaseline: SURFACE,
      majorDeclaredBy: null,
    });
    expect(undeclared.ok).toBe(false);
    if (!undeclared.ok) expect(undeclared.breaking.map((d) => d.kind)).toEqual(["flag-removed"]);
    expect(
      evaluateChangeSet({ current, mergeBaseBaseline: SURFACE, majorDeclaredBy: ".changeset/x.md" })
        .ok,
    ).toBe(true);
    expect(
      evaluateChangeSet({
        current: withSubcommand(SURFACE, "status"),
        mergeBaseBaseline: SURFACE,
        majorDeclaredBy: null,
      }).ok,
    ).toBe(true);
  });

  it("re-running --write after a breaking write never lowers the promise", () => {
    const current = withoutFlag(SURFACE, "yes");
    const afterFirstWrite: CliSurfaceBaseline = { motebitMajor: 2, ...current };
    expect(stampForWrite(current, afterFirstWrite, 1)).toBe(2);
  });
});

describe("check-cli-surface (smoke)", () => {
  it("passes against the real repo", () => {
    // `--base HEAD`: the smoke judges the working tree only, independent of
    // whether origin/<base> is fetched; the merge-base logic is proven by the
    // temp-repo cases.
    const result = spawnSync(
      "npx",
      ["tsx", resolve(ROOT, "scripts/check-cli-surface.ts"), "--base", "HEAD"],
      { encoding: "utf-8", cwd: ROOT },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("all match baseline");
  });
});

// ── Merge-base enforcement, by execution in temp git repos ────────────
//
// The committed baseline (and its `motebitMajor` stamp) is a file the change
// under review can edit, so it cannot be what decides "is this a breaking
// change?". Each case below builds a throwaway repository holding a copy of
// THIS gate plus a minimal `apps/cli`, makes `main` (pinned as
// `refs/remotes/origin/main`, or handed in as the merge-queue base), then a
// change on top, and runs the real script on it.

const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const GATE_SRC = readFileSync(resolve(ROOT, "scripts/check-cli-surface.ts"), "utf-8");
const ID = ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid"];
const fixtures: string[] = [];

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", [...ID, "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: cleanEnv(),
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const SUBCOMMANDS = ["approvals", "doctor", "export", "federation", "goal", "relay", "runs"];
const FAMILY_VARS: Record<string, string> = {
  approvals: "approvalCmd",
  federation: "fedCmd",
  relay: "relayCmd",
  goal: "goalCmd",
  runs: "runsCmd",
};

function writeIndex(dir: string, subcommands: string[]): void {
  const lines = subcommands.map((s) =>
    FAMILY_VARS[s]
      ? `if (subcommand === "${s}") { if (${FAMILY_VARS[s]} === "list") {} }`
      : `if (subcommand === "${s}") {}`,
  );
  writeFileSync(join(dir, "apps/cli/src/index.ts"), lines.join("\n") + "\n");
}
function setPkgVersion(dir: string, version: string): void {
  writeFileSync(
    join(dir, "apps/cli/package.json"),
    JSON.stringify({ name: "motebit", version }, null, 2) + "\n",
  );
}
function addChangeset(dir: string, name: string, bump: "major" | "minor"): void {
  writeFileSync(
    join(dir, ".changeset", `${name}.md`),
    `---\n"motebit": ${bump}\n---\n\n${name}\n\n## Migration\n\nnone\n`,
  );
}
function commitAll(dir: string, msg: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", msg]);
  return git(dir, ["rev-parse", "HEAD"]);
}
function pinOriginMain(dir: string, sha: string): void {
  git(dir, ["update-ref", "refs/remotes/origin/main", sha]);
}

interface GateRun {
  status: number | null;
  out: string;
}
function runGate(dir: string, args: string[] = [], env: Record<string, string> = {}): GateRun {
  const base = cleanEnv();
  // A CI runner's own event must not leak into a fixture run.
  for (const k of ["GITHUB_ACTIONS", "GITHUB_EVENT_NAME", "GITHUB_BASE_REF", "GITHUB_EVENT_PATH"])
    delete base[k];
  const r = spawnSync(TSX, [join(dir, "scripts/check-cli-surface.ts"), ...args], {
    cwd: dir,
    env: { ...base, ...env },
    encoding: "utf-8",
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}
function writeBaseline(dir: string): void {
  const r = runGate(dir, ["--write"]);
  if (r.status !== 0) throw new Error(`--write failed: ${r.out}`);
}
function readStampedBaseline(dir: string): CliSurfaceBaseline {
  return JSON.parse(
    readFileSync(join(dir, "apps/cli/etc/cli-surface.json"), "utf-8"),
  ) as CliSurfaceBaseline;
}
function writeStampedBaseline(dir: string, b: CliSurfaceBaseline): void {
  writeFileSync(join(dir, "apps/cli/etc/cli-surface.json"), JSON.stringify(b, null, 2) + "\n");
}

/** `main` at motebit 1.x with a committed baseline stamped 1; HEAD on `change`. */
function makeFixture(): { dir: string; main: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cs-fixture-")));
  fixtures.push(dir);
  for (const d of ["scripts", "apps/cli/src", "apps/cli/etc", ".changeset"])
    mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "scripts/check-cli-surface.ts"), GATE_SRC);
  writeIndex(dir, SUBCOMMANDS);
  writeFileSync(
    join(dir, "apps/cli/src/args.ts"),
    'export const parsed = parseArgs({\n    options: {\n      provider: { type: "string" },\n      yes: { type: "boolean", default: false },\n    },\n});\n',
  );
  setPkgVersion(dir, "1.4.0");
  writeFileSync(join(dir, ".changeset/README.md"), "changesets\n");
  git(dir, ["init", "-q", "-b", "main"]);
  writeBaseline(dir);
  const main = commitAll(dir, "main");
  pinOriginMain(dir, main);
  git(dir, ["checkout", "-q", "-b", "change"]);
  return { dir, main };
}
const withoutExport = SUBCOMMANDS.filter((s) => s !== "export");

afterAll(() => {
  for (const d of fixtures) rmSync(d, { recursive: true, force: true });
});

describe("check-cli-surface: breaking changes are judged against the merge-base (temp repos)", () => {
  it("RED: stamp tampered back after `--write` recorded a removal", () => {
    const { dir } = makeFixture();
    writeIndex(dir, withoutExport);
    writeBaseline(dir);
    const b = readStampedBaseline(dir);
    expect(b.motebitMajor).toBe(2);
    writeStampedBaseline(dir, { ...b, motebitMajor: 1 });
    commitAll(dir, "remove export, stamp tampered back");
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain("subcommand-removed");
  });

  it("RED: baseline hand-edited to hide a removal (no --write, stamp untouched)", () => {
    const { dir } = makeFixture();
    writeIndex(dir, withoutExport);
    const b = readStampedBaseline(dir);
    const { export: _gone, ...rest } = b.subcommands;
    writeStampedBaseline(dir, { ...b, subcommands: rest });
    commitAll(dir, "remove export, baseline hand-edited");
    const r = runGate(dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain("subcommand-removed");
  });

  it("RED: stale-branch race — an UNRELATED pending major is not this change's declaration, before or after it releases", () => {
    const { dir, main } = makeFixture();
    // main gains an unrelated `motebit: major` changeset.
    git(dir, ["checkout", "-q", "main"]);
    addChangeset(dir, "unrelated-major", "major");
    const mainWithMajor = commitAll(dir, "unrelated major");
    pinOriginMain(dir, mainWithMajor);
    // The breaking change branches from there and leans on it.
    git(dir, ["checkout", "-q", "-b", "breaking", mainWithMajor]);
    writeIndex(dir, withoutExport);
    writeBaseline(dir);
    expect(readStampedBaseline(dir).motebitMajor).toBe(2);
    commitAll(dir, "remove export, no changeset of its own");
    const before = runGate(dir);
    expect(before.status).toBe(1);
    expect(before.out).toContain("subcommand-removed");

    // The release cuts before it merges: changeset consumed, package at 2.0.0.
    git(dir, ["checkout", "-q", "main"]);
    rmSync(join(dir, ".changeset/unrelated-major.md"));
    setPkgVersion(dir, "2.0.0");
    const released = commitAll(dir, "Version Packages");
    pinOriginMain(dir, released);
    git(dir, ["checkout", "-q", "breaking"]);
    git(dir, ["merge", "-q", "--no-edit", "main"]);
    const after = runGate(dir);
    expect(after.status).toBe(1);
    expect(after.out).toContain("subcommand-removed");
    void main;
  });

  it("GREEN: a breaking change that adds its own `motebit: major` changeset", () => {
    const { dir } = makeFixture();
    writeIndex(dir, withoutExport);
    writeBaseline(dir);
    addChangeset(dir, "remove-export", "major");
    commitAll(dir, "remove export + major");
    const r = runGate(dir);
    expect(r.status, r.out).toBe(0);
  });

  it("GREEN: additions only need no major", () => {
    const { dir } = makeFixture();
    writeIndex(dir, [...SUBCOMMANDS, "status"]);
    writeBaseline(dir);
    expect(readStampedBaseline(dir).motebitMajor).toBe(1);
    commitAll(dir, "add status");
    const r = runGate(dir);
    expect(r.status, r.out).toBe(0);
  });

  it("GREEN: post-release — after `changeset version` consumed the break's major, main and a later change are green", () => {
    const { dir } = makeFixture();
    writeIndex(dir, withoutExport);
    writeBaseline(dir);
    addChangeset(dir, "remove-export", "major");
    commitAll(dir, "remove export + major");
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["merge", "-q", "--ff-only", "change"]);
    // changeset version: consume, bump.
    rmSync(join(dir, ".changeset/remove-export.md"));
    setPkgVersion(dir, "2.0.0");
    const released = commitAll(dir, "Version Packages");
    pinOriginMain(dir, released);
    const onMain = runGate(dir);
    expect(onMain.status, onMain.out).toBe(0);
    // A later additive change off the released main.
    git(dir, ["checkout", "-q", "-b", "later"]);
    writeIndex(dir, [...withoutExport, "status"]);
    writeBaseline(dir);
    commitAll(dir, "add status");
    const later = runGate(dir);
    expect(later.status, later.out).toBe(0);
  });

  it("RED in the merge queue: the group's base_sha is the merge-base (no origin/main needed)", () => {
    const { dir, main } = makeFixture();
    git(dir, ["update-ref", "-d", "refs/remotes/origin/main"]);
    writeIndex(dir, withoutExport);
    const b = readStampedBaseline(dir);
    const { export: _gone, ...rest } = b.subcommands;
    writeStampedBaseline(dir, { ...b, subcommands: rest });
    commitAll(dir, "remove export, baseline hand-edited");
    const event = join(dir, "..", `${dir.split("/").pop()}-event.json`);
    writeFileSync(event, JSON.stringify({ merge_group: { base_sha: main } }));
    fixtures.push(event);
    const r = runGate(dir, [], {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "merge_group",
      GITHUB_EVENT_PATH: event,
    });
    expect(r.status).toBe(1);
    expect(r.out).toContain("subcommand-removed");
  });

  it("fails CLOSED with a repair instruction when the merge-base cannot be resolved", () => {
    const { dir } = makeFixture();
    git(dir, ["update-ref", "-d", "refs/remotes/origin/main"]);
    writeIndex(dir, withoutExport);
    const b = readStampedBaseline(dir);
    const { export: _gone, ...rest } = b.subcommands;
    writeStampedBaseline(dir, { ...b, subcommands: rest });
    commitAll(dir, "remove export, baseline hand-edited");
    const local = runGate(dir);
    expect(local.status).toBe(1);
    expect(local.out).toContain("git fetch origin main");
    // A PR run whose checkout is shallow (no origin/<base>) fails the same way.
    const pr = runGate(dir, [], {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_BASE_REF: "main",
    });
    expect(pr.status).toBe(1);
    expect(pr.out).toContain("fetch-depth: 0");
  });
});
