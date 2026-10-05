/**
 * check-spec-coverage — a spec's Status is a compatibility promise to outside
 * implementers, so it must come from a CLOSED vocabulary.
 *
 * fbfc9d0 copied each spec's Status into `spec/README.md` verbatim and only
 * checked that the two agreed. The index therefore carried `Unstated`,
 * `converged` and lower-case `stable` — words no implementer can act on — and
 * the gate called it green, because index and spec drifted together.
 *
 * Each case below keeps the spec and the README consistent with each other
 * (so the old copy-equality check passes) and asserts the gate still goes RED:
 *
 *   (a) a Status outside {Draft, Stable, Deprecated} (case-sensitive), not on
 *       the pending list;
 *   (b) no Status line at all, not on the pending list;
 *   (c) a `PENDING_STATUS_DECISION` entry whose spec now carries a valid
 *       status — a stale entry, so the list only ever shrinks.
 *
 * They drive the real gate over the real repo, perturbing files through
 * `repo-file-mutation.ts` (backup outside the tree, one perturbation at a time).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withRepoFileReplaced, withRepoLock } from "./repo-file-mutation.ts";
import { cleanEnv } from "../lib/differential-tree.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(ROOT, "scripts", "check-spec-coverage.ts");
const README = resolve(ROOT, "spec", "README.md");
const STABLE_SPEC = resolve(ROOT, "spec", "identity-v1.md");
const PENDING_SPEC = resolve(ROOT, "spec", "bond-v1.md");

const STATUS_LINE = /^\*\*Status:\*\*.*$/m;

function runGate(): { code: number | null; out: string } {
  const r = spawnSync("npx", ["tsx", SCRIPT, "--strict"], {
    cwd: ROOT,
    encoding: "utf8",
    env: cleanEnv(),
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

/** Rewrite one spec's README entry so its rendered Status reads `status`. */
function readmeWithStatus(spec: string, status: string): (original: string) => string {
  return (original) => {
    const entry = new RegExp(`^(- \\[${spec}\\]\\(${spec}\\) · Status: )(.+?)( · .*)$`, "m");
    if (!entry.test(original)) throw new Error(`no README entry for ${spec}`);
    return original.replace(entry, `$1${status}$3`);
  };
}

describe("check-spec-coverage — closed status vocabulary", () => {
  it("is green on the real repo", async () => {
    const { code, out } = await withRepoLock(runGate);
    expect(code, out).toBe(0);
  });

  it.each(["converged", "Final", "stable", "2026-06-28"])(
    "(a) goes RED for a non-pending spec whose Status is %j, even when the README copies it",
    async (bad) => {
      const { code, out } = await withRepoFileReplaced(
        STABLE_SPEC,
        (src) => src.replace(STATUS_LINE, `**Status:** ${bad}`),
        () => withRepoFileReplaced(README, readmeWithStatus("identity-v1.md", bad), runGate),
      );
      expect(code, out).toBe(1);
      expect(out).toContain("identity-v1.md");
      expect(out).toMatch(/closed status set \{Draft, Stable, Deprecated\}/);
    },
  );

  it("(b) goes RED for a non-pending spec with no Status line, even when the README says Unstated", async () => {
    const { code, out } = await withRepoFileReplaced(
      STABLE_SPEC,
      (src) => src.replace(/^\*\*Status:\*\*.*\n/m, ""),
      () => withRepoFileReplaced(README, readmeWithStatus("identity-v1.md", "Unstated"), runGate),
    );
    expect(code, out).toBe(1);
    expect(out).toContain("identity-v1.md");
    expect(out).toMatch(/no `\*\*Status:\*\*` line/);
  });

  it("(c) goes RED when a pending spec gains a valid Status but stays on PENDING_STATUS_DECISION", async () => {
    expect(STATUS_LINE.test(readFileSync(PENDING_SPEC, "utf8"))).toBe(false);
    const { code, out } = await withRepoFileReplaced(
      PENDING_SPEC,
      (src) => src.replace(/^(# .*\n)/, "$1\n**Status:** Draft\n"),
      () => withRepoFileReplaced(README, readmeWithStatus("bond-v1.md", "Draft"), runGate),
    );
    expect(code, out).toBe(1);
    expect(out).toMatch(/stale PENDING_STATUS_DECISION/);
    expect(out).toContain("bond-v1.md");
  });
});
