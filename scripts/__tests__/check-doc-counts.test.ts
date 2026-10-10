/**
 * check-doc-counts — every numeric count claim in the swept docs must be
 * checked, not just the sentences someone thought to write a probe for.
 *
 * The gate used to run one hand-written regex per known sentence. README.md
 * line 37 ("the 36 specs and the protocol, crypto, …") had no probe, so it sat
 * at 36 while every probed sentence said 37 and the gate printed green. An
 * outside reader caught it. The defect class is APERTURE: a per-sentence probe
 * table never sees the next sentence.
 *
 * The first widening (a `<N> [≤2 words] specs|packages|…` sweep) still
 * overclaimed: a cold review planted wrong numbers in "12 publish to npm; the
 * other 62 are workspace-private", "(The 53 under `packages/` …)" and "11 apps
 * and 11 services" and the gate stayed green, and
 * docs/doctrine/deprecation-lifecycle.md said "51 internal packages" (true: 62)
 * outside every scan.
 *
 * This test enumerates the claims INDEPENDENTLY of the gate — a broad finder
 * over every swept doc for (a) `<N> [≤2 words] specs|specifications|packages|
 * libraries|directories|apps|services`, (b) the noun-less predicates `<N>
 * publish`, `<N> are [workspace-]private`, `<N> under \`packages/\``, and
 * (c) every number in a `+` chain — then, one location at a time, plants a
 * wrong number there and asserts the real gate goes RED naming that file and
 * line. A new count sentence in any swept doc is picked up here
 * automatically; if the gate cannot see it, its case fails.
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

const SWEPT = [
  "README.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "apps/cli/README.md",
  "apps/docs/content/docs/operator/architecture.mdx",
  "apps/docs/content/docs/concepts/public-surface.mdx",
  "docs/doctrine/deprecation-lifecycle.md",
] as const;

/**
 * Numbers the finder sees that are dated history, not present-tense repo
 * counts. The gate must exempt each one by name too (else it is red on the
 * real repo); listed here so a planted number there is not expected to fail.
 */
const HISTORICAL: ReadonlyArray<{ file: string; needle: string }> = [
  { file: "docs/doctrine/deprecation-lifecycle.md", needle: "19 sites across 8 packages" },
  { file: "docs/doctrine/deprecation-lifecycle.md", needle: "9 markers across 4 private packages" },
  { file: "docs/doctrine/deprecation-lifecycle.md", needle: "flip on 51 internal packages" },
];

/**
 * Independent claim finder: a standalone integer (not part of `2.0`, `v1`,
 * `7-layer`, `~19`, `#39`) followed by a count form. Deliberately written
 * separately from the gate's own scanner so the two can disagree.
 */
const CLAIM =
  /(?<![\w.~#-])(\d+)(?=(?:\s+[\w`.-]+){0,2}?\s+(?:specs|specifications|packages|libraries|directories|apps|services)\b|\s+publish(?:es)?\b|\s+are\s+(?:workspace-)?private\b|\s+under\s+`packages\/`|(?:\s+[A-Za-z][\w-]*){1,2}\s*\+\s*\d)/g;
/** The last member of a `+` chain ("… + 1 glue"), which CLAIM's chain arm cannot see. */
const CHAIN_TAIL = /(?<=\d(?:\s+[A-Za-z][\w-]*){1,2}\s*\+\s*)(\d+)(?=\s+[A-Za-z])/g;

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
    const historical = HISTORICAL.filter((h) => h.file === file).map((h) => {
      const at = text.indexOf(h.needle);
      if (at === -1) throw new Error(`HISTORICAL needle "${h.needle}" no longer in ${file}`);
      return [at, at + h.needle.length] as const;
    });
    const seen = new Set<number>();
    for (const m of [...text.matchAll(CLAIM), ...text.matchAll(CHAIN_TAIL)]) {
      const index = m.index ?? 0;
      if (seen.has(index)) continue;
      seen.add(index);
      if (historical.some(([a, b]) => index >= a && index < b)) continue;
      out.push({
        file,
        line: text.slice(0, index).split("\n").length,
        index,
        value: m[1] ?? "",
        context: text.slice(index, index + 48).split("\n")[0] ?? "",
      });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.index - b.index);
}

function runGate(): { code: number | null; out: string } {
  const r = spawnSync("npx", ["tsx", SCRIPT], { cwd: ROOT, encoding: "utf8", env: cleanEnv() });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

const LOCATIONS = locations();

describe("check-doc-counts — every count claim in the swept docs", () => {
  it("finds count claims in every swept doc (the enumeration itself is not empty)", () => {
    for (const file of SWEPT)
      expect(
        LOCATIONS.some((l) => l.file === file),
        file,
      ).toBe(true);
  });

  // The forms a cold review planted wrong numbers in while the gate stayed
  // green. If the finder ever stops reaching one, this fails before the
  // per-location cases silently shrink.
  it.each([
    ["README.md", "12 publish to npm"],
    ["README.md", "62 are workspace-private"],
    ["README.md", "53 under `packages/`"],
    ["README.md", "11 apps and 11 services"],
    ["CLAUDE.md", "12 publish to npm"],
    ["CLAUDE.md", "62 are workspace-private"],
    ["CLAUDE.md", "11 apps + 11 services"],
    ["CLAUDE.md", "5 surfaces + 6 supporting apps"],
    ["apps/docs/content/docs/operator/architecture.mdx", "11 apps and 11 services"],
    ["apps/docs/content/docs/operator/architecture.mdx", "62 are workspace-private"],
    ["docs/doctrine/deprecation-lifecycle.md", "62 internal packages"],
    ["docs/doctrine/deprecation-lifecycle.md", "62 `0.0.0-private` packages"],
    ["docs/doctrine/deprecation-lifecycle.md", "publishes 12 packages"],
    ["CONTRIBUTING.md", "1 relay + 4 molecules + 5 atoms + 1 glue"],
  ] as const)("the finder reaches %s %s", (file, phrase) => {
    const text = readFileSync(resolve(ROOT, file), "utf8");
    const at = text.indexOf(phrase);
    expect(at, `${file} no longer says "${phrase}"`).not.toBe(-1);
    const digitAt = at + phrase.search(/\d/);
    expect(LOCATIONS.some((l) => l.file === file && l.index === digitAt)).toBe(true);
  });

  it("is green on the real repo and states its aperture", async () => {
    const { code, out } = await withRepoLock(runGate);
    expect(code, out).toBe(0);
    for (const file of SWEPT) expect(out).toContain(file);
    expect(out).toMatch(/\d+ count claim\(s\) swept/);
    expect(out).toMatch(/publish/);
    expect(out).toMatch(/are \[workspace-\]private/);
    expect(out).toMatch(/under `packages\/`/);
    expect(out).toMatch(/apps\|services/);
    expect(out).toMatch(/\+ chains/);
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
