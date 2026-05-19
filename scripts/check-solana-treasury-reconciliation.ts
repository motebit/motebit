#!/usr/bin/env tsx
/**
 * check-solana-treasury-reconciliation — synchronization invariant #104.
 *
 * When `services/relay/src/index.ts` wires the P2P payment verifier
 * (which validates the delegator's fee-leg transfer to the relay's
 * identity-derived Solana treasury wallet — Arc 2 of the off-ramp
 * arc), the same boot path MUST also wire
 * `startSolanaTreasuryReconciliationLoop`. Otherwise, P2P fee legs
 * accumulate in the treasury wallet without any automated audit
 * comparing recorded `platform_fee` against the wallet's onchain USDC
 * balance — the same silent-leakage failure mode the EVM reconciler
 * exists to catch, just on the Solana side.
 *
 * ## Why this gate exists
 *
 * The EVM and Solana sides of treasury reconciliation are structural
 * siblings:
 *
 *   - EVM: x402 facilitator settles to `X402_PAY_TO_ADDRESS`;
 *     `treasury-reconciliation.ts` audits drift.
 *   - Solana: P2P delegator pays worker + treasury fee in one atomic
 *     multi-output Solana tx (Arc 2); `p2p-verifier.ts` walks the
 *     transfers[] array to confirm both legs; the verified rows
 *     populate `relay_settlements.platform_fee`;
 *     `solana-treasury-reconciliation.ts` audits drift.
 *
 * Without both halves wired, the relay records p2p fees as verified
 * and the treasury wallet accumulates USDC, but no cycle compares the
 * two. A relay-side recording bug, a verifier false-positive, or an
 * onchain settlement that didn't actually land in the treasury would
 * surface only on manual audit. The reconciler is the automated audit
 * the operator-transparency declaration commits to.
 *
 * ## Detection
 *
 *   1. Read `services/relay/src/index.ts`.
 *   2. If the file calls `startP2pVerifierLoop(...)`, require it to
 *      also call `startSolanaTreasuryReconciliationLoop(...)`.
 *   3. If the file calls `startSolanaTreasuryReconciliationLoop(...)`,
 *      require it to also call `startP2pVerifierLoop(...)` (the
 *      reconciler reads rows the verifier produces; an isolated
 *      reconciler is a configuration mistake).
 *   4. Forbid string-literal `"solana:mainnet"` / `"solana:devnet"` in
 *      the two treasury-reconciliation source files. The canonical
 *      CAIP-2 form per CAIP-30 is
 *      `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (mainnet) /
 *      `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (devnet), exported as
 *      `SOLANA_MAINNET_CAIP2` / `SOLANA_DEVNET_CAIP2` from
 *      `@motebit/wallet-solana`. The constants are the single source
 *      of truth — re-declaring a non-canonical shorthand drifts the
 *      `relay_treasury_reconciliations.chain` column off the CAIP-30
 *      identifier used by every other audit table that joins on chain
 *      (credential anchors, consolidation receipts). Reviewed catch
 *      2026-05-18; without this gate the drift could regress silently.
 *   5. Exit 1 on any violation.
 *
 * Static text parse — no execution. The gate is presence-based; it
 * does not parse the if-block scopes, so a future refactor that
 * conditions one loop on a different env than the other would still
 * pass — the human review catches that, the gate catches the
 * one-loop-missing case.
 *
 * Same load-bearing shape as `check-deposit-detector-confirmations`
 * (#72): two paired primitives that must travel together because
 * they share a structural commitment.
 *
 * Doctrine: `docs/doctrine/treasury-custody.md` § "Solana p2p-fee
 * reconciliation"; `services/relay/CLAUDE.md` rule 16.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const INDEX_SOURCE = resolve(REPO_ROOT, "services", "relay", "src", "index.ts");

// The two files where the canonical CAIP-2 constant is the only allowed
// source. Tests / consumer surfaces are free to use the constants but
// must not redeclare the shorthand.
const CANONICAL_CONSTANT_FILES = [
  resolve(REPO_ROOT, "packages", "wallet-solana", "src", "operator-treasury-reconciler.ts"),
  resolve(REPO_ROOT, "services", "relay", "src", "solana-treasury-reconciliation.ts"),
];

function main(): void {
  const indexSrc = readFileSync(INDEX_SOURCE, "utf-8");

  const hasVerifier = /\bstartP2pVerifierLoop\s*\(/.test(indexSrc);
  const hasReconciler = /\bstartSolanaTreasuryReconciliationLoop\s*\(/.test(indexSrc);

  const violations: string[] = [];

  if (hasVerifier && !hasReconciler) {
    violations.push(
      "services/relay/src/index.ts calls startP2pVerifierLoop() but does NOT call startSolanaTreasuryReconciliationLoop() — Arc 2 P2P fee legs accumulate in the relay treasury wallet with no automated reconciliation. Wire startSolanaTreasuryReconciliationLoop in the same boot block (gated on solanaRpcUrl) so recorded platform_fee accumulation is audited against the treasury's onchain USDC balance.",
    );
  }

  if (hasReconciler && !hasVerifier) {
    violations.push(
      "services/relay/src/index.ts calls startSolanaTreasuryReconciliationLoop() but does NOT call startP2pVerifierLoop() — the reconciler audits verified p2p settlement rows, but no verifier is wired to produce them. Either restore the verifier or remove the orphaned reconciler.",
    );
  }

  // Forbid non-canonical shorthand in the two source files where the
  // chain identifier is constructed for persistence. Matches string
  // literals only — prose mentions of the shorthand inside doc comments
  // (e.g., naming what is being forbidden) are tolerated because they
  // require surrounding quotes-as-string, not in a string-literal
  // context. We approximate "string-literal context" by requiring the
  // match to be quoted by `"` or `'` adjacent to a known assignment /
  // call-arg / return shape.
  const SHORTHAND_PATTERN = /(['"])solana:(mainnet|devnet)\1/g;

  for (const file of CANONICAL_CONSTANT_FILES) {
    const src = readFileSync(file, "utf-8");
    let match: RegExpExecArray | null;
    while ((match = SHORTHAND_PATTERN.exec(src)) !== null) {
      // Determine line for the violation message.
      const before = src.slice(0, match.index);
      const line = before.split("\n").length;
      // Detect doc-comment context (line begins with `*` or `//`) —
      // doc references that name the forbidden form are allowed.
      const lineStart = before.lastIndexOf("\n") + 1;
      const lineText = src.slice(lineStart, src.indexOf("\n", match.index));
      const trimmed = lineText.trimStart();
      if (trimmed.startsWith("*") || trimmed.startsWith("//")) {
        continue;
      }
      violations.push(
        `${file.replace(REPO_ROOT + "/", "")}:${line} — non-canonical CAIP-2 string literal "${match[0]}". The canonical form per CAIP-30 is "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" (mainnet) / "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" (devnet); import SOLANA_MAINNET_CAIP2 / SOLANA_DEVNET_CAIP2 from @motebit/wallet-solana (mainnet constant is also re-exported as SOLANA_TREASURY_DEFAULT_CHAIN from operator-treasury-reconciler) rather than constructing the shorthand.`,
      );
    }
  }

  if (violations.length > 0) {
    console.error("✗ check-solana-treasury-reconciliation:");
    for (const v of violations) console.error("  - " + v);
    process.exit(1);
  }

  console.log("✓ check-solana-treasury-reconciliation");
}

main();
