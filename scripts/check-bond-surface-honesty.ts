#!/usr/bin/env tsx
/**
 * check-bond-surface-honesty — the cardinal surface rule for commitment bonds:
 * a bond is an anti-sybil SIGNAL, never recourse, so no counterparty- or
 * operator-facing surface may frame it as secured funds or guaranteed recourse.
 *
 * Phase-1 honesty is load-bearing (docs/doctrine/commitment-bond.md;
 * spec/bond-v1.md §7): a bond gives a wronged party NOTHING back. Words like
 * "secured" / "guaranteed" / "escrow" / "your money back" next to bond status
 * would manufacture a confidence the protocol cannot deliver — the exact failure
 * the surface-honesty discipline exists to prevent (sibling of
 * check-public-fee-claims for the fee path). The honest reading is: *this agent
 * staked a credible, withdrawable commitment — a signal, not your money back.*
 *
 * This gate is **necessary, not sufficient** — a word list cannot catch a
 * compliant-but-misleading LAYOUT (a giant "$1,000" over a tiny "signal"). So
 * doctrine ALSO requires a recorded human design-review sign-off on any bond
 * surface before ship; this gate locks the cheap half and the doc anchor keeps
 * the human-review requirement on the record.
 *
 * Two arms:
 *
 *   Arm A — **surface scan (the defense).** No surface source line may conjoin a
 *     BOND token (`bond`, `bonded`, `commitment bond`) with a forbidden framing
 *     (`secured`, `guaranteed`, `escrow`, `protected`, `recourse`, `covered`,
 *     "your money back") as the meaning of the bond. Same-line conjunction keeps
 *     precision (an unrelated "protected route" elsewhere never trips). Scoped to
 *     the curated user-facing surface trees below; spec/doctrine — which LIST the
 *     forbidden words as forbidden — are deliberately out of scope.
 *
 *   Arm B — **documentation anchor.** spec/bond-v1.md must carry the §7
 *     surface-honesty interop law, and docs/doctrine/commitment-bond.md must
 *     carry the human design-review checkpoint — so the rule (and its
 *     necessary-not-sufficient nature) cannot be silently dropped.
 *
 * Today there are no bond surfaces (ingestion + UI are deferred-with-trigger),
 * so Arm A passes vacuously — the guardrail is deliberately in place BEFORE the
 * first surface lands, not bolted on after.
 *
 * Doctrine: docs/doctrine/commitment-bond.md. Drift defense: docs/drift-defenses.md.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { failWithRepair } from "./lib/gate-report.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SPEC_MD = "spec/bond-v1.md";
const DOCTRINE_MD = "docs/doctrine/commitment-bond.md";

/**
 * Curated user-facing surface trees. Bond status, when it ships, renders here —
 * panels (surface-agnostic controllers) and the per-surface apps. spec/doctrine
 * are NOT scanned (they enumerate the forbidden words as forbidden). CLI help /
 * error strings are operational, not bond representations.
 *
 * TRIGGER: when a bond surface lands in a tree not listed here (a new app, a
 * marketing page), add its root so the honesty rule covers it — a loud miss, not
 * a silent gap.
 */
const SURFACE_TREES: readonly string[] = [
  "packages/panels/src",
  "apps/web/src",
  "apps/mobile",
  "apps/desktop/src",
  "apps/operator",
  "apps/spatial/src",
];

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  ".next",
  ".turbo",
  ".motebit",
  "__tests__",
]);

const SURFACE_EXT = /\.(ts|tsx|js|jsx|html)$/;

/** A bond token — the subject the framing must not be attached to. */
const BOND_TOKEN = /\bbond(?:ed|s)?\b/i;
/** Forbidden framings of a bond's meaning (necessary-not-sufficient word list). */
const FORBIDDEN_FRAMING =
  /\b(secured|guaranteed?|escrow|protected|recourse|covered)\b|your\s+money\s+back|money[-\s]back/i;

function read(rel: string): string | null {
  const abs = resolve(ROOT, rel);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(resolve(ROOT, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const rel = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(rel));
    else if (SURFACE_EXT.test(e.name)) out.push(rel);
  }
  return out;
}

const findings: string[] = [];

// ── Arm A: surface scan ──────────────────────────────────────────────────
let scanned = 0;
for (const tree of SURFACE_TREES) {
  for (const file of walk(tree)) {
    const src = read(file);
    if (src === null) continue;
    scanned++;
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i]!;
      if (BOND_TOKEN.test(ln) && FORBIDDEN_FRAMING.test(ln)) {
        findings.push(
          `${file}:${i + 1}: frames a bond as secured/guaranteed recourse — ` +
            `"${ln.trim().slice(0, 120)}". A bond is an anti-sybil signal, never your money back.`,
        );
      }
    }
  }
}

// ── Arm B: documentation anchor ──────────────────────────────────────────
const specSrc = read(SPEC_MD);
if (specSrc === null) {
  findings.push(`${SPEC_MD}: missing — the §7 surface-honesty interop law must be specced.`);
} else if (!/surface honesty/i.test(specSrc)) {
  findings.push(
    `${SPEC_MD}: missing the §7 "Surface honesty" interop law — the rule that a bond MUST NOT be ` +
      `presented as secured funds or guaranteed recourse.`,
  );
}

const doctrineSrc = read(DOCTRINE_MD);
if (doctrineSrc === null) {
  findings.push(
    `${DOCTRINE_MD}: missing — the surface-honesty + human-review rule must be doctrine.`,
  );
} else if (!/design[-\s]review/i.test(doctrineSrc)) {
  findings.push(
    `${DOCTRINE_MD}: missing the human design-review checkpoint — the word-list gate is ` +
      `necessary-not-sufficient (it cannot catch a compliant-but-misleading layout), so a recorded ` +
      `human design-review sign-off on any bond surface is a required doctrine rule.`,
  );
}

// ── Report ─────────────────────────────────────────────────────────────────
if (findings.length > 0) {
  failWithRepair({
    invariant:
      "A commitment bond is an anti-sybil signal, NEVER recourse — no surface may frame it as secured funds or guaranteed recourse, and any bond surface needs a recorded human design-review sign-off.",
    canonical: `${SPEC_MD} §7 + ${DOCTRINE_MD} (the cardinal surface-honesty rule)`,
    fix: 'Reframe any bond surface as a soft signal ("staked a credible, withdrawable commitment — a signal, not your money back"); drop secured/guaranteed/escrow/protected/recourse/covered/"money back" framings; keep spec §7 + the doctrine design-review checkpoint.',
    sites: findings,
    doctrine: DOCTRINE_MD,
  });
}

console.log(
  `✓ check-bond-surface-honesty: ${scanned} surface file(s) scanned — no bond framed as secured/` +
    `guaranteed recourse; spec §7 + the doctrine human design-review checkpoint are present.`,
);
