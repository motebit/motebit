#!/usr/bin/env tsx
/**
 * check-doctrine-cited-constants — pin numeric render constants cited in
 * doctrine to their code source of truth.
 *
 * Doctrine narrates the creature's material properties as physics-derived
 * ("every design decision, every material property is derived from this single
 * sentence"). But a cited constant is only *true* if it matches what the body
 * actually renders. On 2026-07-25 DROPLET.md was found citing `transmission
 * 0.98` — with a whole "the critical consequence of 0.98 transmission" narrative
 * — while the shipped body renders at creature.ts's `transmission: 0.94`, pinned
 * by `creature.test.ts` (`toBeCloseTo(0.94, 5)`). The drift had gone unnoticed
 * for months, and a maintenance PR nearly "fixed" it BACKWARDS by trusting the
 * doc table over the code constant. The rule that must never be ambiguous in
 * this repo: **docs are never ground truth; the code constant plus its test is.**
 * This gate makes that structural — a doctrine doc that cites a pinned render
 * constant with a value must cite the value that lives in `creature.ts`.
 *
 * The canonical value is READ FROM THE CODE at check time (never hardcoded
 * here), so this gate cannot itself drift from the source of truth.
 *
 * Scope (v1): `transmission` — the single-value constant that actually drifted,
 * cited at ~6 doctrine sites. `ior` is deliberately NOT gated yet: DROPLET cites
 * it as a DUAL value in one table cell ("1.45 (physical) / 1.22 (rendered)"),
 * and a robust matcher for the physical-vs-rendered split is a v2 concern. A
 * fragile IOR regex that silently missed the drift would give false confidence
 * — worse than no gate — so IOR stays reviewer-caught (and was fixed by hand in
 * the same change that introduced this gate). Adding a constant here = one
 * `PINNED` entry; the doc-scan and repair reporting are generic.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { failWithRepair } from "./lib/gate-report.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CREATURE = "packages/render-engine/src/creature.ts";

interface Pinned {
  /** Human name of the constant. */
  name: string;
  /** Captures the canonical value from the code source (group 1). */
  codeRegex: RegExp;
  /** Finds doctrine citations of this constant with a decimal value (group 1). */
  docRegex: RegExp;
}

const PINNED: readonly Pinned[] = [
  {
    name: "transmission",
    // The standalone material property (not `iridescence…`). One in creature.ts.
    codeRegex: /\btransmission:\s*([\d.]+)/,
    // "transmission … 0.94" — the canonical citation form: the value directly
    // FOLLOWS the constant name. We deliberately do NOT match the value-first
    // form ("0.94 transmission"): in prose a preceding number often belongs to a
    // different constant ("IOR 1.22 + transmission 0.94"), and binding it to
    // transmission is a false positive. Every doc's definitional cite uses the
    // constant-first form, so nothing is lost; a fragile matcher that flags the
    // wrong number would be worse than none.
    docRegex: /transmission[^\d\n]{0,16}(\d\.\d+)/gi,
  },
];

/** Doctrine surfaces: foundational root docs + docs/doctrine/*.md. Generated
 *  artifacts (llms.txt) and gate scripts are out of scope by construction. */
function doctrineFiles(): string[] {
  const rootDocs = readdirSync(ROOT)
    .filter((f) => /^[A-Z_]+\.md$/.test(f))
    .map((f) => resolve(ROOT, f));
  const doctrineDir = resolve(ROOT, "docs/doctrine");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return e.isFile() && e.name.endsWith(".md") ? [p] : [];
    });
  return [...rootDocs, ...walk(doctrineDir)];
}

function readCanonical(p: Pinned, src: string): number {
  const m = src.match(p.codeRegex);
  if (!m) {
    failWithRepair({
      invariant: `the canonical '${p.name}' constant is readable from ${CREATURE}`,
      canonical: CREATURE,
      fix: `check-doctrine-cited-constants could not read '${p.name}' from ${CREATURE} — the code source moved. Update the codeRegex for '${p.name}' in scripts/check-doctrine-cited-constants.ts to the current shape.`,
    });
  }
  return parseFloat(m[1]!);
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

interface Violation {
  file: string;
  line: number;
  constant: string;
  cited: string;
  expected: number;
}

function main(): void {
  const creatureSrc = readFileSync(resolve(ROOT, CREATURE), "utf-8");
  const files = doctrineFiles();
  const violations: Violation[] = [];

  for (const pinned of PINNED) {
    const expected = readCanonical(pinned, creatureSrc);
    for (const abs of files) {
      const src = readFileSync(abs, "utf-8");
      // Fresh regex per file (global lastIndex is stateful).
      const re = new RegExp(pinned.docRegex.source, pinned.docRegex.flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const cited = m[1];
        if (cited == null) continue;
        if (parseFloat(cited) !== expected) {
          violations.push({
            file: relative(ROOT, abs),
            line: lineOf(src, m.index),
            constant: pinned.name,
            cited,
            expected,
          });
        }
      }
    }
  }

  if (violations.length > 0) {
    failWithRepair({
      invariant:
        "a doctrine doc that cites a pinned render constant must cite the value in the code source of truth (creature.ts) — docs are never ground truth; the code constant + its test is",
      canonical: CREATURE,
      fix:
        `these doctrine citations disagree with the code constant:\n` +
        violations
          .map(
            (v) =>
              `    • ${v.file}:${v.line} — cites ${v.constant} ${v.cited}, but ${CREATURE} renders ${v.expected}`,
          )
          .join("\n") +
        `\nFix the doc to the code value (NOT the reverse — the body renders what creature.ts says, pinned by creature.test.ts). If the render value genuinely changed, change it in creature.ts + its test first, then the docs.`,
    });
  }

  process.stderr.write(
    `✓ check-doctrine-cited-constants: ${PINNED.map((p) => p.name).join(", ")} cited in doctrine match ${CREATURE}.\n`,
  );
}

main();
