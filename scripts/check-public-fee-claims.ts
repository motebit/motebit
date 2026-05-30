#!/usr/bin/env tsx
/**
 * check-public-fee-claims — drift defense for the "prose-ahead-of-proof"
 * class on the MONEY path: a public surface that states a platform-fee
 * behavior the code contradicts.
 *
 * Surfaced 2026-05-30 (PR #125): README, the operator architecture doc, and
 * the generated llms.txt/llms-full.txt all said P2P settlement charges "zero
 * fees" — but Arc 2 of the off-ramp arc had shipped a 5% fee on P2P, composed
 * as a direct delegator→relay_treasury leg in the same atomic Solana
 * multi-output transaction (recorded as `platform_fee`; see
 * `services/relay/CLAUDE.md` rule 8). The code moved; the public prose did not.
 * A stale claim on the money path is the worst place for one — it is a fee
 * representation to users, not an internal doc nit. PR #125 corrected the prose
 * by hand; this gate locks the class so it cannot silently return.
 *
 * The verifiable anchor: `PLATFORM_FEE_RATE` (the single source of truth in
 * `packages/protocol/src/index.ts`, today `0.05` → 5%). The economic invariant
 * (`CLAUDE.md` § "Economic loop"): the platform fee applies at EVERY settlement
 * checkpoint — relay-mediated AND P2P. No settlement path is fee-exempt; on P2P
 * the fee composes as a direct delegator→treasury leg rather than a
 * virtual-account deduction. Two failure shapes follow, one rule each:
 *
 *   Rule A — fee RATE must match the constant. A fee-percentage claim on a
 *     public surface ("N% fee", "fee … N%") whose number ≠ the canonical
 *     percent derived from `PLATFORM_FEE_RATE` is stale (the rate changed in
 *     code, or a doc was hand-typed wrong). Catches the wrong-number drift.
 *
 *   Rule B — no fee-EXEMPTION claim in a settlement context. A line that
 *     conjoins a settlement/P2P token (`p2p`, `peer-to-peer`, `settle*`,
 *     `delegator→`) with a fee-exemption phrase (`zero fees`, `no fees`,
 *     `fee-free`, `without fees`, `0% fee`, `fees … waived`) asserts a
 *     fee-free settlement — false by the economic invariant. This is the exact
 *     #125 shape. Scoped to the SETTLEMENT context on the same line so that a
 *     legitimately fee-free non-settlement operation (a withdrawal/off-ramp, or
 *     "free to self-host") does not false-positive — the exemption must also
 *     name "fee(s)", so a generic "free" / "zero floating-point" never trips.
 *
 * Scope (public, user-facing surfaces — the ones #125 actually drifted on):
 * `README.md`, `DOCTRINE.md`, every `.md`/`.mdx` under `apps/docs/content/`,
 * and the committed `apps/docs/public/llms{,-full}.txt`. CLAUDE.md / spec /
 * doctrine internals are out of scope here — they are engineering surfaces with
 * their own gates; this gate defends the consumer-facing fee representation.
 *
 * Extending to a second economic claim: add its anchor + patterns alongside the
 * fee rules. The shape — read a canonical constant from code, forbid public
 * prose that contradicts it — generalizes to any load-bearing public claim.
 *
 * Usage:
 *   tsx scripts/check-public-fee-claims.ts        # exit 1 on violation
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const PROTOCOL_INDEX = path.join(REPO_ROOT, "packages/protocol/src/index.ts");
const DOCS_CONTENT = path.join(REPO_ROOT, "apps/docs/content");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  ".next",
  ".turbo",
  ".motebit",
]);

interface Finding {
  readonly doc: string;
  readonly line: number;
  readonly rule: "A:rate" | "B:exemption";
  readonly reason: string;
  readonly snippet: string;
}

function findFiles(dir: string, predicate: (p: string) => boolean): string[] {
  const out: string[] = [];
  function walk(d: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (predicate(full)) out.push(full);
    }
  }
  walk(dir);
  return out;
}

/**
 * Extract the canonical platform-fee percent from `PLATFORM_FEE_RATE` in
 * `@motebit/protocol`. `export const PLATFORM_FEE_RATE = 0.05;` → 5. If the
 * constant is renamed or relocated, this regex must follow — the inline
 * doctrine here tells the next maintainer (same pattern as
 * `check-docs-default-models`' canonical extraction).
 */
function loadCanonicalFeePercent(): number | null {
  const text = fs.readFileSync(PROTOCOL_INDEX, "utf8");
  const m = text.match(/export const PLATFORM_FEE_RATE\s*=\s*([0-9]*\.?[0-9]+)\s*;/);
  if (!m) return null;
  const rate = Number.parseFloat(m[1]!);
  if (!Number.isFinite(rate)) return null;
  return rate * 100;
}

function lineOf(text: string, charIndex: number): number {
  return text.slice(0, charIndex).split("\n").length;
}

// Rule A: a percentage bound to the word "fee" (either order, small window so
// the number and "fee" are genuinely about the rate, not two unrelated tokens
// in a sentence). Capture group 1 = the percent number.
const RATE_PATTERNS: readonly RegExp[] = [
  // "5% fee", "5% platform fee", "5 % settlement fee"
  /(\d+(?:\.\d+)?)\s*%\s*(?:platform\s+|settlement\s+)?fee/gi,
  // "fee of 5%", "fee … 5%" within a tight window
  /\bfee\b[^.\n]{0,24}?(\d+(?:\.\d+)?)\s*%/gi,
];

// Rule B: a settlement/P2P context token AND a fee-exemption phrase on the same
// line. Both anchored to keep precision — the exemption must name "fee(s)".
const SETTLEMENT_CONTEXT =
  /\b(p2p|peer-to-peer|settle(?:s|d|ment|ing)?|delegator\s*(?:→|->)\s*(?:treasury|worker))\b/i;
const FEE_EXEMPTION =
  /\b(?:zero|no|without|free\s+of|free\s+from)\s+(?:platform\s+|settlement\s+)?fees?\b|\bfee-free\b|\b0\s*%\s*fee\b|\bfees?\b[^.\n]{0,20}?\b(?:waived|free)\b/i;

function scanDoc(doc: string, canonicalPercent: number): Finding[] {
  const text = fs.readFileSync(doc, "utf8");
  const findings: Finding[] = [];
  const docRel = doc.replace(REPO_ROOT + "/", "");

  // Rule A — fee-rate literals must equal the canonical percent.
  for (const pattern of RATE_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      const pct = Number.parseFloat(m[1]!);
      if (pct === canonicalPercent) continue;
      findings.push({
        doc: docRel,
        line: lineOf(text, m.index ?? 0),
        rule: "A:rate",
        reason: `states a ${pct}% fee but PLATFORM_FEE_RATE is ${canonicalPercent}%`,
        snippet: m[0].slice(0, 100),
      });
    }
  }

  // Rule B — no fee-exemption claim conjoined with a settlement context.
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]!;
    if (SETTLEMENT_CONTEXT.test(ln) && FEE_EXEMPTION.test(ln)) {
      findings.push({
        doc: docRel,
        line: i + 1,
        rule: "B:exemption",
        reason:
          "claims a fee-free settlement — the platform fee applies at EVERY settlement checkpoint (relay AND P2P; on P2P as a direct delegator→treasury leg)",
        snippet: ln.trim().slice(0, 140),
      });
    }
  }

  return findings;
}

function main(): void {
  console.log(
    "▸ check-public-fee-claims — drift defense against public fee prose contradicting code " +
      "(the #125 'P2P = zero fees' class). Anchors every public fee claim to PLATFORM_FEE_RATE.",
  );

  const canonicalPercent = loadCanonicalFeePercent();
  if (canonicalPercent === null) {
    console.error(
      "✗ check-public-fee-claims: failed to extract PLATFORM_FEE_RATE from packages/protocol/src/index.ts — " +
        "the constant may have been renamed or moved; update the regex in loadCanonicalFeePercent.",
    );
    process.exit(1);
  }

  const docs = [
    ...["README.md", "DOCTRINE.md"]
      .map((f) => path.join(REPO_ROOT, f))
      .filter((p) => fs.existsSync(p)),
    ...findFiles(DOCS_CONTENT, (p) => p.endsWith(".mdx") || p.endsWith(".md")),
    ...["apps/docs/public/llms.txt", "apps/docs/public/llms-full.txt"]
      .map((f) => path.join(REPO_ROOT, f))
      .filter((p) => fs.existsSync(p)),
  ];

  const allFindings: Finding[] = [];
  for (const doc of docs) {
    allFindings.push(...scanDoc(doc, canonicalPercent));
  }

  if (allFindings.length === 0) {
    console.log(
      `✓ check-public-fee-claims: ${docs.length} public surface(s) scanned; every fee claim is ` +
        `consistent with PLATFORM_FEE_RATE (${canonicalPercent}%) and no settlement path is claimed fee-free.`,
    );
    return;
  }

  console.error(`\n✗ check-public-fee-claims: ${allFindings.length} stale/false fee claim(s):\n`);
  for (const f of allFindings) {
    console.error(`  [${f.rule}] ${f.doc}:${f.line} — ${f.reason}`);
    console.error(`      ${f.snippet}`);
  }
  console.error(
    `\nFix: align the prose with the code. The canonical fee rate is PLATFORM_FEE_RATE ` +
      `(${canonicalPercent}%) in packages/protocol/src/index.ts, applied at every settlement ` +
      `checkpoint (relay AND P2P). Doctrine: CLAUDE.md § "Economic loop"; ` +
      `docs/doctrine/off-ramp-as-user-action.md (the P2P fee leg).`,
  );
  process.exit(1);
}

main();
