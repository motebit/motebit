/**
 * check-doc-counts — every numeric spec-count and package-count claim in the
 * two front-door docs must be checked, not just the sentences someone thought
 * to write a probe for.
 *
 * The gate used to run one hand-written regex per known sentence. README.md
 * line 37 ("the 36 specs and the protocol, crypto, …") had no probe, so it sat
 * at 36 while every probed sentence said 37 and the gate printed green. An
 * outside reader caught it. The defect class is APERTURE: a per-sentence probe
 * table never sees the next sentence.
 *
 * This test enumerates the claims INDEPENDENTLY of the gate — a broad
 * `<digits> [≤2 qualifier words] specs|specifications|packages|libraries` sweep over
 * README.md and CLAUDE.md — then, one location at a time, plants a wrong
 * number there and asserts the real gate goes RED naming that file. A new
 * count sentence added to either doc is picked up here automatically; if the
 * gate cannot see it, its case fails.
 *
 * Drives the real gate over the real repo, perturbing files through
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
const SCRIPT = resolve(ROOT, "scripts", "check-doc-counts.ts");

const SWEPT = ["README.md", "CLAUDE.md"] as const;

/**
 * Independent claim finder: a standalone integer (not part of `2.0`, `v1`,
 * `7-layer`, `~19`), up to two qualifier words, then the noun. Deliberately
 * written separately from the gate's own scanner so the two can disagree.
 */
const CLAIM =
  /(?<![\w.~-])(\d+)(?=((?:\s+[\w`.-]+){0,2}?)\s+(?:specs|specifications|packages|libraries)\b)/g;

interface Location {
  file: string;
  line: number;
  index: number;
  value: string;
  context: string;
}

function locations(): Location[] {
  const out: Location[] = [];
  for (const file of SWEPT) {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    for (const m of text.matchAll(CLAIM)) {
      const index = m.index ?? 0;
      out.push({
        file,
        line: text.slice(0, index).split("\n").length,
        index,
        value: m[1] ?? "",
        context: text.slice(index, index + 48).split("\n")[0] ?? "",
      });
    }
  }
  return out;
}

function runGate(): { code: number | null; out: string } {
  const r = spawnSync("npx", ["tsx", SCRIPT], { cwd: ROOT, encoding: "utf8", env: cleanEnv() });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const LOCATIONS = locations();

describe("check-doc-counts — every spec/package count claim in README.md and CLAUDE.md", () => {
  it("finds count claims in both docs (the enumeration itself is not empty)", () => {
    for (const file of SWEPT) expect(LOCATIONS.some((l) => l.file === file)).toBe(true);
  });

  it("is green on the real repo and states its aperture", async () => {
    const { code, out } = await withRepoLock(runGate);
    expect(code, out).toBe(0);
    expect(out).toMatch(/README\.md/);
    expect(out).toMatch(/CLAUDE\.md/);
    expect(out).toMatch(/\d+ spec\/package count claim\(s\) swept/);
  });

  it.each(LOCATIONS.map((l) => [`${l.file}:${l.line} "${l.context}"`, l] as const))(
    "goes RED when a wrong number is planted at %s",
    async (_name, loc) => {
      const wrong = String(Number(loc.value) + 100);
      const { code, out } = await withRepoFileReplaced(
        resolve(ROOT, loc.file),
        (src) => {
          if (src.slice(loc.index, loc.index + loc.value.length) !== loc.value)
            throw new Error(`${loc.file}:${loc.line} no longer holds ${loc.value}`);
          return src.slice(0, loc.index) + wrong + src.slice(loc.index + loc.value.length);
        },
        runGate,
      );
      expect(code, out).toBe(1);
      expect(out).toContain(`${loc.file}:${loc.line}`);
      expect(out).toContain(wrong);
    },
  );
});
