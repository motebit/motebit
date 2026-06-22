#!/usr/bin/env tsx
/**
 * check-accrual-basis-canonical — locks the two structural honesty invariants
 * of the felt-accumulation leverage register (`AccrualBasis` / `AccrualKind`),
 * the same shape as `check-memory-source-canonical` (produced-not-authored) and
 * `check-felt-interior-honesty` (no inward aggregate).
 *
 * The leverage moment ("I recalled this", "I trusted that peer") is felt, and a
 * felt claim is only trustworthy if it cannot be fabricated. Two arms enforce
 * that structurally:
 *
 *   1. **Registry coverage.** The gate's `ACCRUAL_KINDS_REFERENCE` must agree
 *      exactly with the `AccrualKind` union AND `ALL_ACCRUAL_KINDS` in
 *      `packages/protocol/src/accrual.ts` (the three-way lock). A kind added to
 *      the union without updating the array or this gate drifts the vocabulary.
 *
 *   2. **Produced-not-authored (the load-bearing scan).** An `AccrualBasis` is
 *      minted ONLY in the accrual source (`@motebit/memory-graph`'s
 *      `recalledMemoryBasis`), from the retrieval it actually performed — never
 *      authored by the model. The model-facing loop (`packages/ai-core/src`)
 *      THREADS a produced basis onto the turn result; it must never CONSTRUCT
 *      one. So no file in `packages/ai-core/src` may name an accrual-kind string
 *      literal (the construction fingerprint) — a model that could author
 *      "recalled_memory" could fabricate a recall that never happened. (Same
 *      authorship rule as `<memory>` carrying no `source=`.) Tests are excluded.
 *
 *   3. **No inward aggregate.** "More capable over time" is felt as the lived
 *      FREQUENCY of leverage moments, never a counter, rate, streak, or score
 *      (felt-accumulation § What-not-to-build; the §2 trend turned inward — the
 *      sybil-bait the felt family refuses). So `AccrualBasis`
 *      (`packages/protocol/src/accrual.ts`) and `AccrualAttribution`
 *      (`packages/panels/src/memory/accrual-attribution.ts`) must declare no
 *      count/score/rank/rate/streak/total/aggregate/trend/delta/growth field.
 *
 * Doctrine: `docs/doctrine/felt-accumulation.md`.
 * This is a synchronization-invariant defense; see docs/drift-defenses.md.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ACCRUAL_TS = "packages/protocol/src/accrual.ts";
const ATTRIBUTION_TS = "packages/panels/src/memory/accrual-attribution.ts";

/** The closed accrual-kind vocabulary, mirrored here for the three-way lock. */
const ACCRUAL_KINDS_REFERENCE = [
  "recalled_memory",
  "trust_edge",
  "consolidated_fact",
  "prior_approval_pattern",
  "standing_delegation",
] as const;

/** Aggregate-shaped fields the leverage types must never declare (§3). */
const FORBIDDEN_AGGREGATE =
  /\b(count|score|rank|ranking|rate|streak|total|aggregate|tally|trend|delta|growth)\s*\??\s*:/;

function readFile(rel: string): string | null {
  const abs = resolve(ROOT, rel);
  return existsSync(abs) ? readFileSync(abs, "utf-8") : null;
}

/** Every non-test `.ts` file under a directory, repo-relative. */
function walkTsFiles(rel: string): string[] {
  const out: string[] = [];
  const abs = resolve(ROOT, rel);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name === "dist")
      continue;
    const childAbs = join(abs, entry.name);
    const childRel = relative(ROOT, childAbs);
    if (entry.isDirectory()) out.push(...walkTsFiles(childRel));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !/\.test\.ts$/.test(entry.name))
      out.push(childRel);
  }
  return out;
}

/** Extract the body of `interface <name> { ... }`, or "" if absent. */
function interfaceBody(src: string, name: string): string {
  const m = new RegExp(`interface\\s+${name}\\s*\\{`).exec(src);
  if (!m) return "";
  const start = m.index + m[0].length;
  let depth = 1;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i);
  }
  return "";
}

const findings: string[] = [];

// ── Arm 1: registry coverage (three-way lock) ─────────────────────────────
const accrualSrc = readFile(ACCRUAL_TS);
if (accrualSrc === null) {
  findings.push(`${ACCRUAL_TS}: missing — the canonical AccrualKind source is absent.`);
} else {
  const unionMatch = /export type AccrualKind =([\s\S]*?);/.exec(accrualSrc);
  const arrayMatch = /ALL_ACCRUAL_KINDS[^=]*=\s*Object\.freeze\(\[([\s\S]*?)\]/.exec(accrualSrc);
  const unionKinds = unionMatch
    ? [...unionMatch[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1])
    : [];
  const arrayKinds = arrayMatch
    ? [...arrayMatch[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1])
    : [];
  const ref = [...ACCRUAL_KINDS_REFERENCE];
  const eq = (a: string[]): boolean =>
    a.length === ref.length && [...a].sort().join(",") === [...ref].sort().join(",");
  if (!eq(unionKinds) || !eq(arrayKinds)) {
    findings.push(
      `${ACCRUAL_TS}: AccrualKind three-way drift — union [${unionKinds}] / ALL_ACCRUAL_KINDS [${arrayKinds}] / gate reference [${ref}] disagree. Update all three together (a kind is one union entry + one ALL_ACCRUAL_KINDS entry + one ACCRUAL_KIND_MARKERS entry + this reference).`,
    );
  }
}

// ── Arm 2: produced-not-authored — ai-core may not construct a basis ───────
const kindLiteral = new RegExp(`"(${ACCRUAL_KINDS_REFERENCE.join("|")})"`);
for (const rel of walkTsFiles("packages/ai-core/src")) {
  const content = readFile(rel);
  if (content === null) continue;
  content.split("\n").forEach((line, i) => {
    if (kindLiteral.test(line)) {
      findings.push(
        `${rel}:${i + 1}: an accrual-kind literal in the model-facing loop — ai-core must THREAD a produced AccrualBasis (from @motebit/memory-graph recalledMemoryBasis), never CONSTRUCT one. Mint the basis in the accrual source. (Produced-not-authored, felt-accumulation §3.)`,
      );
    }
  });
}

// ── Arm 3: no inward aggregate on the leverage types ──────────────────────
if (accrualSrc !== null) {
  const body = interfaceBody(accrualSrc, "AccrualBasis");
  if (FORBIDDEN_AGGREGATE.test(body)) {
    findings.push(
      `${ACCRUAL_TS}: AccrualBasis declares a forbidden aggregate field (count/score/rank/rate/streak/total/aggregate/trend/delta/growth) — remove it. The leverage register is a single produced basis, never a tally or climbing score (felt-accumulation §2/§What-not-to-build).`,
    );
  }
}
const attrSrc = readFile(ATTRIBUTION_TS);
if (attrSrc !== null && FORBIDDEN_AGGREGATE.test(interfaceBody(attrSrc, "AccrualAttribution"))) {
  findings.push(
    `${ATTRIBUTION_TS}: AccrualAttribution declares a forbidden aggregate field — remove it. The attribution is a calm phrase, never a counter/rate/score the surface could render as a number.`,
  );
}

// ── Report ────────────────────────────────────────────────────────────────
if (findings.length > 0) {
  console.error(`✗ check-accrual-basis-canonical: ${findings.length} violation(s):`);
  for (const f of findings) console.error(`    ${f}`);
  console.error(
    "\n  Canonical source: packages/protocol/src/accrual.ts (AccrualKind / AccrualBasis) +\n" +
      "    packages/memory-graph/src/accrual.ts (the sole producer, recalledMemoryBasis).\n" +
      "  Fix: mint every AccrualBasis in the accrual source (never in ai-core or a surface);\n" +
      "    keep the leverage types free of any aggregate/count/score/rate field; align the\n" +
      "    AccrualKind union, ALL_ACCRUAL_KINDS, and this gate's reference together.\n" +
      "  Doctrine: docs/doctrine/felt-accumulation.md.",
  );
  process.exit(1);
}

console.log(
  `✓ check-accrual-basis-canonical: ${ACCRUAL_KINDS_REFERENCE.length} accrual kind(s) locked (union × ALL_ACCRUAL_KINDS × reference); produced-not-authored (ai-core constructs no basis); no inward aggregate on AccrualBasis/AccrualAttribution.`,
);
