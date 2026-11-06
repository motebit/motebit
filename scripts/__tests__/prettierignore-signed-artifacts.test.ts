/**
 * Signed governed-change artifacts are byte-exact, so `format:check` must
 * never judge them (.prettierignore). A governed pull request is exactly the
 * change commit and the bundle commit (spec/repo-change-v1.md §9), so it
 * cannot carry a reformat: if Prettier judged the canonical one-line bundle,
 * every governed PR would fail the required `format` check. Milestone B's
 * first live run (B1, 2026-11-06) found exactly that.
 */
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { getFileInfo } from "prettier";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IGNORE = path.join(ROOT, ".prettierignore");

async function ignored(rel: string): Promise<boolean> {
  return (await getFileInfo(path.join(ROOT, rel), { ignorePath: IGNORE })).ignored;
}

describe(".prettierignore and the signed governed-change artifacts", () => {
  it.each([
    ".motebit/bundles/01a1b25a-a36e-7df0-aaac-d6d8bb041c28.json",
    ".motebit/revocations/01a1b25a-a36e-7df0-aaac-d6d8bb041c28.json",
    ".motebit/principals/principal.md",
    ".motebit/principals/agents/repo-a.md",
  ])("%s is never reformatted", async (rel) => {
    expect(await ignored(rel)).toBe(true);
  });

  it.each([
    ".motebit/operator-keys/github.json",
    ".motebit/repo-path-policy.json",
    "docs/parity-inventory.md",
  ])("%s is still format-checked", async (rel) => {
    expect(await ignored(rel)).toBe(false);
  });
});
