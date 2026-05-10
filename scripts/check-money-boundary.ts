#!/usr/bin/env tsx
/**
 * check-money-boundary — synchronization invariant for the canonical
 * money converter family.
 *
 * Doctrine: CLAUDE.md § Money model — "Integer micro-units (1 USD =
 * 1,000,000). Convert at API boundary: `toMicro(dollars)` in,
 * `fromMicro(micro)` out. Zero floating-point in the money path."
 *
 * The canonical converters live in `@motebit/protocol/src/money.ts` and
 * cover the two reference precisions every motebit ledger or settlement
 * rail uses:
 *   - micro-units (×1,000,000) — `toMicro` / `fromMicro` (USDC 6 decimals)
 *   - cents (×100) — `toCents` / `fromCents` (Stripe and fiat rails)
 *
 * Inline `Math.round(amount * 100|1_000_000|MICRO|CENTS)` outside the
 * canonical home is a category error: the formula is a primitive, not
 * a snippet. A second copy at a sibling rail would double-convert if
 * the caller is already in integer units; a third precision (RWA
 * tokens, JPY rails) would force a third copy that drifts from the
 * first two.
 *
 * Why this gate at all: prior to its addition,
 * `packages/settlement-rails/src/{stripe,x402}-rail.ts` re-rolled both
 * formulas inline despite `@motebit/virtual-accounts/money.ts` already
 * exporting `toMicro`/`fromMicro`. The audit that landed this gate
 * found two siblings drifted from one canonical source — exactly the
 * shape the synchronization-invariants meta-principle addresses. A
 * third site (`apps/web/src/ui/sovereign-panels.ts`) was caught by
 * the gate's first run.
 *
 * Filter — money-shaped LHS only. `Math.round(x * 100)` is also a
 * common UI pattern for percentage displays (color saturation 0-1 →
 * 0-100, progress 0-1 → 0-100, confidence 0-1 → 0-100). The gate
 * fires only when the multiplied expression contains a money-shaped
 * token (`amount`, `dollar`, `usd`, `cent`, `fee`, `balance`,
 * `payment`, `deposit`, `withdraw`, `total`, `price`, `sum`,
 * `micro`). This makes the gate high-precision: the false-positive
 * surface (UI percentages) is excluded by name, the true-positive
 * surface (money conversion) is named exactly because money math
 * always names its variables.
 *
 * Allowlist: `packages/protocol/src/money.ts` is the one canonical
 * home. Tests are excluded.
 *
 * Usage:
 *   tsx scripts/check-money-boundary.ts           # exit 1 on violation
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

const CANONICAL_FILES = new Set<string>(["packages/protocol/src/money.ts"]);

const SCAN_ROOTS = [
  join(REPO_ROOT, "packages"),
  join(REPO_ROOT, "services"),
  join(REPO_ROOT, "apps"),
];

/**
 * Money-shaped tokens. Matched case-insensitively as substrings of
 * the multiplied LHS expression. `amount` covers `unit_amount` /
 * `unitAmount` / `maxAmount` etc.; `usd` covers `usdc` / `usdcAmount`
 * etc.; `dollar` covers `dollars` / `dollarAmount` etc. Conservative
 * default — false negatives are preferable to false positives because
 * the latter erodes trust in the gate.
 */
const MONEY_TOKENS = [
  "amount",
  "dollar",
  "usd",
  "cent",
  "fee",
  "balance",
  "payment",
  "deposit",
  "withdraw",
  "total",
  "price",
  "sum",
  "micro",
];

/**
 * Match `Math.round(<expr> * <precision>)` where `<precision>` is one
 * of the integer-unit factors. Captures `<expr>` for the money-shape
 * filter.
 */
const CONVERTER_PATTERN =
  /Math\.round\s*\(\s*([^*()]+?)\s*\*\s*(100|1[_]?000[_]?000|MICRO|CENTS)\s*\)/g;

interface Finding {
  file: string;
  line: number;
  precision: string;
  context: string;
}

function isMoneyShaped(expr: string): boolean {
  const lower = expr.toLowerCase();
  return MONEY_TOKENS.some((token) => lower.includes(token));
}

function walkTs(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "__tests__" ||
        entry.name === "dist" ||
        entry.name === "node_modules" ||
        entry.name === ".turbo" ||
        entry.name === ".next"
      ) {
        continue;
      }
      walkTs(full, out);
    } else if (
      (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) ||
      entry.name.endsWith(".tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

function isTestFile(rel: string): boolean {
  return rel.includes("/__tests__/") || rel.endsWith(".test.ts") || rel.endsWith(".spec.ts");
}

function scanFile(abs: string): Finding[] {
  const rel = relative(REPO_ROOT, abs);
  if (CANONICAL_FILES.has(rel)) return [];
  if (isTestFile(rel)) return [];
  const src = readFileSync(abs, "utf-8");
  const lines = src.split("\n");
  const findings: Finding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Strip line comments so a comment-only mention doesn't trip the gate.
    const code = line.replace(/\/\/.*$/, "");
    // Reset the global regex for each line.
    CONVERTER_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CONVERTER_PATTERN.exec(code)) !== null) {
      const expr = match[1]!;
      const precision = match[2]!;
      if (!isMoneyShaped(expr)) continue;
      findings.push({
        file: rel,
        line: i + 1,
        precision,
        context: line.trim(),
      });
    }
  }
  return findings;
}

function main(): void {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    try {
      statSync(root);
    } catch {
      continue;
    }
    walkTs(root, files);
  }
  const findings = files.flatMap(scanFile);

  console.log(
    `check-money-boundary — scanned ${files.length} files across packages/, services/, apps/ (excluding ${[...CANONICAL_FILES].join(", ")} and tests)\n`,
  );

  if (findings.length === 0) {
    console.log(
      "✓ Every money-converter formula routes through `toMicro` / `toCents` from `@motebit/protocol`.",
    );
    return;
  }

  console.log(`✗ Inline converter formulas found — replace with the canonical primitive:\n`);
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}  Math.round(_ * ${f.precision})`);
    console.log(`    ${f.context}`);
  }
  console.log(
    `\n  Fix: import { toMicro, toCents } from "@motebit/protocol" (or from\n` +
      `       "@motebit/virtual-accounts" which re-exports them) and use the\n` +
      `       named function in place of the inline formula.`,
  );
  process.exit(1);
}

main();
