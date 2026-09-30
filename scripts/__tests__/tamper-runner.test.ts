/**
 * tamper-runner — the shared parallel runner every TAMPER file delegates to.
 *
 * Drives the REAL runner (in a child `node`, as a tamper file would) over a
 * throwaway git repo built from `tamper-runner-fixture/`: a function, a check
 * that fails when the function is wrong, and a check that proves which copy a
 * tamper ran in. A runner that reports a false RED, swallows a missing anchor,
 * lets two tampers share a copy, or leaves the caller's tree changed fails
 * here.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunTampersSummary, TamperEntry } from "../lib/tamper-runner";

const RUNNER = resolve(__dirname, "../lib/tamper-runner.ts");
const FIXTURE = resolve(__dirname, "tamper-runner-fixture");

let base: string;
let repo: string;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

/** Every observable of the caller's tree: HEAD, status, and file bytes. */
function snapshot(): string {
  const files = git(["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n");
  return [
    git(["rev-parse", "HEAD"]),
    git(["status", "--porcelain=v1", "--untracked-files=all"]),
    git(["worktree", "list", "--porcelain"]),
    ...files.filter(Boolean).map((f) => `${f}\n${readFileSync(join(repo, f), "utf8")}`),
  ].join("\0");
}

function drive(
  entries: TamperEntry[],
  concurrency: number,
): { code: number | null; out: string; summary: RunTampersSummary } {
  const driver = join(base, "drive.mjs");
  writeFileSync(
    driver,
    `import { runTampers } from ${JSON.stringify(RUNNER)};\n` +
      `const s = await runTampers(JSON.parse(process.argv[2]), { root: process.cwd(), concurrency: ${concurrency}, exit: false, argv: [] });\n` +
      `console.log("SUMMARY " + JSON.stringify(s));\n` +
      `process.exit(s.exitCode);\n`,
  );
  const env = { ...process.env };
  delete env.TAMPER_CONCURRENCY;
  const r = spawnSync("node", ["--no-warnings", driver, JSON.stringify(entries)], {
    cwd: repo,
    encoding: "utf8",
    env,
  });
  const out = `${r.stdout}${r.stderr}`;
  const line = out.split("\n").find((l) => l.startsWith("SUMMARY "));
  if (line == null) throw new Error(`driver printed no summary:\n${out}`);
  return { code: r.status, out, summary: JSON.parse(line.slice("SUMMARY ".length)) };
}

const CHECK = { command: ["node", "sum.check.mjs"] };

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "tamper-runner-test-"));
  repo = join(base, "repo");
  cpSync(FIXTURE, repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  git(["add", "-A"]);
  git([
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  ]);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("tamper-runner", () => {
  it("a tamper the test catches goes RED; the run exits 0", () => {
    const before = snapshot();
    const { code, out, summary } = drive(
      [
        {
          name: "sum subtracts",
          ...CHECK,
          edits: [{ file: "sum.mjs", from: "a + b", to: "a - b" }],
        },
      ],
      1,
    );
    expect(summary.results.map((r) => r.verdict)).toEqual(["RED"]);
    expect(out).toMatch(/^RED \(ok\) +sum subtracts$/m);
    expect(out).toContain("1/1 tampers turned their test red");
    expect(code).toBe(0);
    expect(snapshot()).toBe(before);
  });

  it("a tamper the test does not catch reports GREEN and exits non-zero", () => {
    const { code, out, summary } = drive(
      [
        {
          name: "comment edited",
          ...CHECK,
          edits: [{ file: "sum.mjs", from: "// marker: a comment", to: "// changed: a comment" }],
        },
      ],
      1,
    );
    expect(summary.results.map((r) => r.verdict)).toEqual(["GREEN"]);
    expect(out).toMatch(/^GREEN +comment edited$/m);
    expect(out).toContain("0/1 tampers turned their test red");
    expect(code).toBe(1);
  });

  it("a missing anchor reports COULD NOT APPLY and exits non-zero", () => {
    const { code, out, summary } = drive(
      [
        {
          name: "stale anchor",
          ...CHECK,
          edits: [{ file: "sum.mjs", from: "a * b", to: "a - b" }],
        },
      ],
      1,
    );
    expect(summary.results.map((r) => r.verdict)).toEqual(["COULD NOT APPLY"]);
    expect(out).toMatch(/^COULD NOT APPLY +stale anchor +\(sum\.mjs: text found 0×\)$/m);
    expect(code).toBe(1);
  });

  it("an anchor found twice is COULD NOT APPLY too (never an ambiguous edit)", () => {
    const { code, summary } = drive(
      [{ name: "ambiguous", ...CHECK, edits: [{ file: "sum.mjs", from: "a", to: "x" }] }],
      1,
    );
    expect(summary.results.map((r) => r.verdict)).toEqual(["COULD NOT APPLY"]);
    expect(code).toBe(1);
  });

  it("never touches the caller's tree, including its uncommitted state — and tests that state", () => {
    // An uncommitted "fix" in the caller: the tamper must see it (it is what
    // gets tested) without the caller's copy ever changing.
    writeFileSync(
      join(repo, "sum.mjs"),
      readFileSync(join(repo, "sum.mjs"), "utf8").replace("a + b", "b + a"),
    );
    writeFileSync(join(repo, "untracked.txt"), "caller scratch\n");
    const before = snapshot();
    const { code, summary } = drive(
      [
        {
          name: "dirty fix reverted",
          ...CHECK,
          edits: [{ file: "sum.mjs", from: "b + a", to: "b - a" }],
        },
        {
          name: "HEAD text absent",
          ...CHECK,
          edits: [{ file: "sum.mjs", from: "a + b", to: "a - b" }],
        },
      ],
      2,
    );
    expect(summary.results.map((r) => r.verdict)).toEqual(["RED", "COULD NOT APPLY"]);
    expect(code).toBe(1);
    expect(snapshot()).toBe(before);
  });

  it("two tampers on the same file run concurrently in separate copies without interfering", () => {
    const before = snapshot();
    const own = (mine: string, other: string): TamperEntry => ({
      name: `edit ${mine}`,
      command: ["node", "own-edit.check.mjs", mine, other],
      edits: [{ file: "sum.mjs", from: "// marker: a comment", to: `// ${mine}: a comment` }],
    });
    const { code, out, summary } = drive([own("TOKEN_A", "TOKEN_B"), own("TOKEN_B", "TOKEN_A")], 2);
    expect(summary.concurrency).toBe(2);
    expect(summary.results.map((r) => r.verdict)).toEqual(["RED", "RED"]);
    expect(new Set(summary.results.map((r) => r.slot)).size).toBe(2);
    // Output is in entry order whatever order they finished in.
    expect(out.indexOf("edit TOKEN_A")).toBeLessThan(out.indexOf("edit TOKEN_B"));
    expect(code).toBe(0);
    expect(snapshot()).toBe(before);
  });

  it("reuses a slot: a restored file carries no residue of the previous tamper", () => {
    const { code, summary } = drive(
      [
        { name: "first", ...CHECK, edits: [{ file: "sum.mjs", from: "a + b", to: "a - b" }] },
        // Would be COULD NOT APPLY if "first" were left applied in the slot.
        { name: "second", ...CHECK, edits: [{ file: "sum.mjs", from: "a + b", to: "a * b" }] },
        {
          name: "third (uncaught)",
          ...CHECK,
          edits: [{ file: "sum.mjs", from: "// marker", to: "// m" }],
        },
      ],
      1,
    );
    expect(summary.results.map((r) => r.verdict)).toEqual(["RED", "RED", "GREEN"]);
    expect(code).toBe(1);
  });
});
