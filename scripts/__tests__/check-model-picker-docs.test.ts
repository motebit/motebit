/**
 * check-model-picker-canonical — docs arm self-test (#654 cold review of
 * 27814cf, item 2).
 *
 * The gate's DOCS_PICKER allowlist reason claimed the docs picker tokens were
 * "kept in sync with @motebit/sdk". A reviewer changed ANTHROPIC_PICKER's
 * strongest row to `claude-fable-5-1` while the docs still said
 * `Claude Opus 5.5` / `claude-opus-5-5`, and every gate stayed green. This
 * test makes that mutation — and the same for each tier's id and label — in a
 * SCRATCH copy of packages/sdk/src/models.ts, runs the real gate against it
 * via `--models`, and requires RED naming the stale docs pages (.mdx under
 * apps/docs/content) and the generated apps/docs/public/llms-full.txt.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "check-model-picker-canonical.ts");
const MODELS = fs.readFileSync(path.join(ROOT, "packages/sdk/src/models.ts"), "utf8");

function runWith(source: string): { status: number | null; out: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picker-docs-"));
  try {
    const file = path.join(dir, "models.ts");
    fs.writeFileSync(file, source);
    const r = spawnSync("npx", ["tsx", SCRIPT, "--models", file], { encoding: "utf8", cwd: ROOT });
    return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function mutate(from: string, to: string): string {
  expect(MODELS.split(from).length, `exactly one "${from}" in models.ts`).toBe(2);
  return MODELS.replace(from, to);
}

const MUTATIONS: readonly { name: string; from: string; to: string }[] = [
  // The reviewer's exact mutation.
  {
    name: "strongest id",
    from: '{ id: "claude-opus-5-5", label',
    to: '{ id: "claude-fable-5-1", label',
  },
  {
    name: "strongest label",
    from: '"Claude Opus 5.5 — most capable"',
    to: '"Claude Fable 5.1 — most capable"',
  },
  {
    name: "default id",
    from: "{ id: DEFAULT_ANTHROPIC_MODEL, label",
    to: '{ id: "claude-opus-5", label',
  },
  {
    name: "default label",
    from: '"Claude Sonnet 5 — recommended"',
    to: '"Claude Sonnet 5.1 — recommended"',
  },
  {
    name: "fast id",
    from: '{ id: "claude-haiku-4-5-20251001", label',
    to: '{ id: "claude-sonnet-4-6", label',
  },
  {
    name: "fast label",
    from: '"Claude Haiku 4.5 — fastest"',
    to: '"Claude Haiku 5 — fastest"',
  },
];

describe("check-model-picker-canonical — docs picker tokens follow ANTHROPIC_PICKER", () => {
  it("is GREEN against an unmodified copy of models.ts", () => {
    const r = runWith(MODELS);
    expect(r.out).toContain("docs picker arm");
    expect(r.status, r.out).toBe(0);
  });

  for (const m of MUTATIONS) {
    it(`goes RED on the stale docs when ANTHROPIC_PICKER's ${m.name} changes`, () => {
      const r = runWith(mutate(m.from, m.to));
      expect(r.status, r.out).toBe(1);
      expect(r.out).toMatch(/apps\/docs\/content\/docs\/apps\/[a-z-]+\.mdx/);
      expect(r.out).toContain("apps/docs/public/llms-full.txt");
    });
  }
});
