#!/usr/bin/env tsx
/**
 * check-multihop-depth-single-site — recursion-safety invariant for multi-hop
 * settlement.
 *
 * Doctrine: services/relay/CLAUDE.md rule 8 — "only `settleSubReceipt`'s
 * relay-mode write is a deferred residual (the multi-hop-as-P2P arc)."
 *
 * The relay-mode multi-hop settlement WRITE recurses over nested
 * `delegation_receipts`. Its only safety bound is the depth-limit comparison:
 * stop recursing past `MAX_SETTLEMENT_DEPTH`. That comparison MUST live in
 * exactly one place — `services/relay/src/multihop-depth.ts`'s
 * `exceedsSettlementDepth`. A re-inlined `depth > MAX_SETTLEMENT_DEPTH` (or a
 * magic-number `depth >= 10`) elsewhere is the precise drift that produced the
 * residual branch in the first place: a comparison that silently diverges from
 * the recursion it guards re-opens unbounded settlement recursion.
 *
 * Why a gate and not just code review: this branch is a deferred residual that
 * fires only on legacy / non-integration-drivable paths (see the ARC-MARKER in
 * tasks.ts). Code that rarely executes is exactly the code a reviewer skims —
 * so the invariant is enforced structurally.
 *
 * What it catches: any comparison of a variable literally named `depth` against
 * the depth limit — by name (`MAX_SETTLEMENT_DEPTH` / `maxSettlementDepth` /
 * `maxDepth`) in either direction, or against a bare integer — anywhere under
 * `services/relay/src` except the canonical home. `\bdepth\b` is case-sensitive
 * so `maxDepth:` (object key) and `depthBlocked` (field) do not trip it; only
 * `<`/`>` operators count, so `depth + 1` and `exceedsSettlementDepth(depth, …)`
 * pass.
 *
 * Allowlist: `services/relay/src/multihop-depth.ts` is the one canonical home.
 * Tests are excluded.
 *
 * Usage:
 *   tsx scripts/check-multihop-depth-single-site.ts   # exit 1 on violation
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

const CANONICAL_FILES = new Set<string>(["services/relay/src/multihop-depth.ts"]);

const SCAN_ROOTS = [join(REPO_ROOT, "services", "relay", "src")];

/**
 * A depth-limit comparison: a `depth` variable on one side of a `<`/`>`(`=`)
 * operator and a depth-limit token (named constant or bare integer) on the
 * other. Both directions covered. Case-sensitive `\bdepth\b` excludes
 * `maxDepth` / `depthBlocked`.
 */
const LIMIT = String.raw`(?:MAX_SETTLEMENT_DEPTH|maxSettlementDepth|maxDepth|\d+)`;
const DEPTH_COMPARISON = new RegExp(
  String.raw`(?:\bdepth\b\s*[<>]=?\s*${LIMIT})|(?:${LIMIT}\s*[<>]=?\s*\bdepth\b)`,
);

interface Finding {
  file: string;
  line: number;
  context: string;
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
        entry.name === ".turbo"
      ) {
        continue;
      }
      walkTs(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
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
  const lines = readFileSync(abs, "utf-8").split("\n");
  const findings: Finding[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Strip line comments so a comment-only mention doesn't trip the gate.
    const code = lines[i]!.replace(/\/\/.*$/, "");
    if (DEPTH_COMPARISON.test(code)) {
      findings.push({ file: rel, line: i + 1, context: lines[i]!.trim() });
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
    `check-multihop-depth-single-site — scanned ${files.length} files under services/relay/src (excluding ${[...CANONICAL_FILES].join(", ")} and tests)\n`,
  );

  if (findings.length === 0) {
    console.log(
      "✓ The settlement depth-limit comparison lives only in multihop-depth.ts (exceedsSettlementDepth).",
    );
    return;
  }

  console.log(`✗ Re-inlined settlement depth comparison found — route through the helper:\n`);
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}`);
    console.log(`    ${f.context}`);
  }
  console.log(
    `\n  Fix: import { exceedsSettlementDepth } from "./multihop-depth.js" and call\n` +
      `       exceedsSettlementDepth(depth, maxDepth) instead of comparing inline.\n` +
      `       The depth limit is bounded in exactly one place by design (rule 8).`,
  );
  process.exit(1);
}

main();
