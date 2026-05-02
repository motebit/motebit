#!/usr/bin/env tsx
/**
 * check-deposit-detector-confirmations — synchronization invariant #72.
 *
 * Every CAIP-2 chain id in `USDC_CONTRACTS` (services/relay/src/deposit-detector.ts)
 * MUST also appear in `CONFIRMATIONS_BY_CHAIN`, and each value must be a
 * positive integer.
 *
 * ## Why this gate exists
 *
 * The deposit detector credits virtual accounts when it sees a USDC
 * `Transfer` log on a registered chain. The `confirmations` parameter
 * is the reorg-safety mechanism: the cycle never crosses
 * `currentBlock - confirmations`, so a chain reorg shallower than
 * `confirmations` cannot roll back a credit. Adding a chain to
 * `USDC_CONTRACTS` without a matching `CONFIRMATIONS_BY_CHAIN` entry
 * is a silent omission that leaves the detector unable to start for
 * that chain (it short-circuits with `deposit-detector.disabled`,
 * `reason: "no confirmation depth registered"`); a non-positive
 * value is the older 0-confirmation behavior the gate exists to retire.
 *
 * The two maps live next to each other in the same file precisely so
 * the human eye can verify alignment, but a literal-text gate prevents
 * a future drift where a contributor adds a USDC contract and forgets
 * the confirmation entry.
 *
 * ## Detection
 *
 *   1. Read `services/relay/src/deposit-detector.ts`.
 *   2. Extract the set of CAIP-2 keys in `USDC_CONTRACTS`.
 *   3. Extract the set of CAIP-2 keys in `CONFIRMATIONS_BY_CHAIN` and
 *      their numeric values.
 *   4. Fail if any key is in one map but not the other.
 *   5. Fail if any confirmation value is not a positive integer.
 *
 * Static text parse — no execution. The two maps are matched by name;
 * shape is a single object literal each.
 *
 * Exit 1 on any violation.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const SOURCE = resolve(REPO_ROOT, "services", "relay", "src", "deposit-detector.ts");

interface ParsedMap {
  /** Map name (e.g., USDC_CONTRACTS, CONFIRMATIONS_BY_CHAIN). */
  name: string;
  /** Keys → string-form values, in source order. */
  entries: Map<string, string>;
}

/**
 * Extract a `const NAME: ... = { ... }` block. Captures every line of
 * the form `"<chain>": <value>,` inside the block.
 */
function parseMap(src: string, name: string): ParsedMap | null {
  const start = src.indexOf(`const ${name}`);
  if (start < 0) return null;
  const open = src.indexOf("{", start);
  if (open < 0) return null;

  // Walk braces to find the matching close.
  let depth = 1;
  let i = open + 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  if (depth !== 0) return null;
  const body = src.slice(open + 1, i - 1);

  const entries = new Map<string, string>();
  // Match `"<key>": <value>` where key looks like a CAIP-2 id.
  const entryRe = /"([a-z0-9]+:[a-zA-Z0-9]+)"\s*:\s*([^,\n]+)/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(body)) !== null) {
    entries.set(m[1]!, m[2]!.trim());
  }
  return { name, entries };
}

function main(): void {
  const src = readFileSync(SOURCE, "utf-8");

  const contracts = parseMap(src, "USDC_CONTRACTS");
  const confs = parseMap(src, "CONFIRMATIONS_BY_CHAIN");

  if (!contracts || contracts.entries.size === 0) {
    console.error(
      "✗ check-deposit-detector-confirmations — could not parse USDC_CONTRACTS in services/relay/src/deposit-detector.ts",
    );
    process.exit(1);
  }
  if (!confs || confs.entries.size === 0) {
    console.error(
      "✗ check-deposit-detector-confirmations — could not parse CONFIRMATIONS_BY_CHAIN in services/relay/src/deposit-detector.ts",
    );
    process.exit(1);
  }

  const violations: string[] = [];

  for (const chain of contracts.entries.keys()) {
    if (!confs.entries.has(chain)) {
      violations.push(
        `USDC_CONTRACTS declares "${chain}" but CONFIRMATIONS_BY_CHAIN does not — adding a chain without a confirmation depth disables the detector for that chain`,
      );
    }
  }
  for (const chain of confs.entries.keys()) {
    if (!contracts.entries.has(chain)) {
      violations.push(
        `CONFIRMATIONS_BY_CHAIN declares "${chain}" but USDC_CONTRACTS does not — stale confirmation entry for a chain that no longer has a USDC contract registered`,
      );
    }
  }
  for (const [chain, raw] of confs.entries) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      violations.push(
        `CONFIRMATIONS_BY_CHAIN["${chain}"] = ${raw} — must be a positive integer; zero confirmations is the legacy reorg-unsafe behavior the gate exists to retire`,
      );
    }
  }

  if (violations.length === 0) {
    console.log(
      `✓ check-deposit-detector-confirmations — ${contracts.entries.size} chain(s) in USDC_CONTRACTS / CONFIRMATIONS_BY_CHAIN aligned, all positive integers`,
    );
    return;
  }

  console.error(`✗ check-deposit-detector-confirmations — ${violations.length} violation(s):\n`);
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nFix: edit services/relay/src/deposit-detector.ts so USDC_CONTRACTS and CONFIRMATIONS_BY_CHAIN " +
      "have the same set of CAIP-2 chain ids, and every confirmation depth is >= 1. See packages/deposit-detector/CLAUDE.md rule 6 for the chain-specific reference depths.",
  );
  process.exit(1);
}

main();
