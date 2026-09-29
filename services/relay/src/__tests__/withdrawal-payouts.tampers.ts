/**
 * Tamper checks for #948 / #949 / #945 — each fix, removed, must turn a
 * named test red (docs/ops/agentic-lanes.md: "keep tamper checks in a file,
 * not in the transcript").
 *
 * Each entry is (file, text to revert, replacement, package, test file).
 * The runner applies ONE entry at a time (first occurrence), runs that
 * package's test file, expects it to FAIL, and restores the file. An entry
 * whose text is not found is reported COULD NOT APPLY and fails the run — a
 * stale tamper is a false green.
 *
 * Run from the repo root (the relay entries need `@motebit/relay` source
 * only; the wallet-solana and settlement-rails entries run their own
 * package's tests against src):
 *
 *   pnpm exec tsx services/relay/src/__tests__/withdrawal-payouts.tampers.ts
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface Tamper {
  name: string;
  pkg: "services/relay" | "packages/wallet-solana" | "packages/settlement-rails";
  file: string;
  find: string;
  replace: string;
  test: string;
  /**
   * Where the test runs, when not in `pkg` (a wallet-solana tamper seen
   * through the relay). The relay imports the BUILT package, so `pkg` is
   * rebuilt after the tamper is applied and again after it is restored.
   */
  testPkg?: "services/relay";
}

const RELAY = "services/relay";
const HARNESS = "src/__tests__/withdrawal-payout-harness.test.ts";
const T921 = "src/__tests__/withdrawal-claim-921.test.ts";
const UNIT = "src/__tests__/withdrawal-payouts-949-945.test.ts";

export const TAMPERS: Tamper[] = [
  {
    name: "#948 a 0x destination is no longer refused before debit",
    pkg: RELAY,
    file: "src/budget.ts",
    find: 'if (typeof body.destination === "string" && EVM_DEST_RE.test(body.destination)) {',
    replace: "if (false) {",
    test: HARNESS,
  },
  {
    name: "#948 same, pinned by the route test",
    pkg: RELAY,
    file: "src/budget.ts",
    find: 'if (typeof body.destination === "string" && EVM_DEST_RE.test(body.destination)) {',
    replace: "if (false) {",
    test: T921,
  },
  {
    name: "#948 the x402 rail claims to withdraw again",
    pkg: "packages/settlement-rails",
    file: "src/x402-rail.ts",
    find: "readonly supportsWithdraw = false as const;",
    replace: "readonly supportsWithdraw = true as const;",
    test: "src/__tests__/x402-rail.test.ts",
  },
  {
    name: "#949 an undecided chain verdict opens after 15 wall-clock minutes (the old horizon)",
    pkg: RELAY,
    file: "src/budget.ts",
    find: 'if (verdict.kind === "undecided" && !attestedPaid) {',
    replace:
      'if (verdict.kind === "undecided" && !attestedPaid && Date.now() < (withdrawal.claimed_at ?? 0) + 15 * 60 * 1000) {',
    test: HARNESS,
  },
  {
    name: "#949 signatures are not recorded before broadcast",
    pkg: RELAY,
    file: "src/budget.ts",
    find: "beforeBroadcast: (tx) => recordPayoutAttempt(moteDb.db, withdrawalId, tx, Date.now()),",
    replace: "beforeBroadcast: () => undefined,",
    test: HARNESS,
  },
  {
    name: "#949 Path 0 sends over a transfer that cannot record its broadcasts",
    pkg: RELAY,
    file: "src/budget.ts",
    find: "const pathZeroReady = operatorSolanaTransfer?.recordsBroadcasts === true;",
    replace: "const pathZeroReady = operatorSolanaTransfer !== undefined;",
    test: T921,
  },
  {
    name: "#949 the claim is not marked chain-recorded",
    pkg: RELAY,
    file: "src/budget.ts",
    find: "if (won) markChainRecordedClaim(moteDb.db, result.withdrawal_id, path, claimedAt);",
    replace: "void markChainRecordedClaim;",
    test: T921,
  },
  {
    name: "#949 the operator's outcome may contradict the chain",
    pkg: RELAY,
    file: "src/budget.ts",
    find: "outcome !== chainSays ||",
    replace: "false ||",
    test: T921,
  },
  {
    name: "#949 r5 a legacy claim (no recorded signature) accepts not_paid",
    pkg: RELAY,
    file: "src/budget.ts",
    find: '      if (outcome === "not_paid") {\n        logger.warn("withdrawal.admin.reconcile_refused_chain", {',
    replace:
      '      if (false) {\n        logger.warn("withdrawal.admin.reconcile_refused_chain", {',
    test: HARNESS,
  },
  {
    name: "#949 seen-in-a-block is not persisted",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: "    markAttemptSeen(db, withdrawalId, a.signature);\n",
    replace: "",
    test: UNIT,
  },
  {
    name: "#949 a landed attempt after the first is not found",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: "landed.push({ signature: a.signature, slot: v.slot });",
    replace:
      "if (landed.length === 0 && a === attempts[0]) landed.push({ signature: a.signature, slot: v.slot });",
    test: UNIT,
  },
  {
    name: "#949 the operator transfer drops the broadcast hooks",
    pkg: "packages/wallet-solana",
    file: "src/operator-transfer.ts",
    find: ": this.adapter.sendUsdc({ toAddress, microAmount }, hooks);",
    replace: ": this.adapter.sendUsdc({ toAddress, microAmount });",
    test: "src/__tests__/operator-transfer.test.ts",
  },
  {
    name: "#945 a serial rail throw gets no settle door",
    pkg: RELAY,
    file: "src/batch-withdrawals.ts",
    find: '      settleFire(db, row, unresolvedRecordFor(rail, reason, now), { kind: "failed", reason }, now);\n      failed++;',
    replace: "      failed++;",
    test: HARNESS,
  },
  {
    name: "#945 crashed fires are not recovered",
    pkg: RELAY,
    file: "src/batch-withdrawals.ts",
    find: "  recoverStaleFiring(db, withdrawableRails);\n",
    replace: "",
    test: HARNESS,
  },
  {
    name: "#945 a fire in flight in this process is recovered as stale",
    pkg: RELAY,
    file: "src/batch-withdrawals.ts",
    find: "if (firingHere.has(row.pending_id)) continue;",
    replace: "",
    test: UNIT,
  },
  {
    name: "#945 the fired write is not a compare-and-set",
    pkg: RELAY,
    file: "src/batch-withdrawals.ts",
    find: "SET status = 'fired', withdrawal_id = ?, last_attempt_at = ?\n       WHERE pending_id = ? AND status = 'firing'",
    replace:
      "SET status = 'fired', withdrawal_id = ?, last_attempt_at = ?\n       WHERE pending_id = ?",
    test: UNIT,
  },
  {
    name: "#945 a recovered row's horizon counts from the dead claim, not now",
    pkg: RELAY,
    file: "src/batch-withdrawals.ts",
    find: '      unresolvedRecordFor(rail, reason, now),\n      { kind: "failed", reason },',
    replace:
      '      unresolvedRecordFor(rail, reason, row.last_attempt_at ?? now),\n      { kind: "failed", reason },',
    test: UNIT,
  },
  {
    name: "#945 the loop swallows a failing tick",
    pkg: RELAY,
    file: "src/batch-withdrawals.ts",
    find: "        throw err;\n      }\n    },\n    { isFrozen },",
    replace: "      }\n    },\n    { isFrozen },",
    test: UNIT,
  },
  // ── round 2 (cold review of 7aeafed9b) ─────────────────────────────────
  {
    name: "X10 the failed write is not a compare-and-set",
    pkg: RELAY,
    file: "src/batch-withdrawals.ts",
    find: "SET status = 'failed', withdrawal_id = ?, last_error = ?, last_attempt_at = ?\n       WHERE pending_id = ? AND status = 'firing'",
    replace:
      "SET status = 'failed', withdrawal_id = ?, last_error = ?, last_attempt_at = ?\n       WHERE pending_id = ?",
    test: UNIT,
  },
  {
    name: "X11 a batch (withdrawBatch) throw gets no settle door",
    pkg: RELAY,
    file: "src/batch-withdrawals.ts",
    find: '    for (const row of rows) {\n      settleFire(db, row, unresolvedRecordFor(rail, reason, now), { kind: "failed", reason }, now);\n    }',
    replace: "    void rows;",
    test: HARNESS,
  },
  {
    name: "X12 a batch per-item failure gets no settle door",
    pkg: RELAY,
    file: "src/batch-withdrawals.ts",
    find: '    // accepted; it is parked on the same door as a throw (#945).\n    settleFire(db, row, unresolvedRecordFor(rail, reason, now), { kind: "failed", reason }, now);',
    replace: "    // accepted; it is parked on the same door as a throw (#945).\n    void reason;",
    test: HARNESS,
  },
  // ── round 5: absence of a transaction in HISTORY is never evidence of
  // non-payment; a refund needs POSITIVE evidence, per recorded attempt.
  // (The round 2–4 retention-edge machinery these replace — the landing
  // window, the local-ledger edge and its margins, the legacy height bound
  // — was deleted, so its entries are retired with it.)
  {
    name: "R5-1 a history absence (expired) is counted as dead (relay)",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: 'if (history.status === "failed") {',
    replace: 'if (history.status === "failed" || history.status === "expired") {',
    test: HARNESS,
  },
  {
    name: "R5-1 same, pinned by the route regression (paid refused / refund on absence)",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: 'if (history.status === "failed") {',
    replace: 'if (history.status === "failed" || history.status === "expired") {',
    test: T921,
  },
  {
    name: "R5-1b the adapter reports expired once the fresh window has passed (absence read as dead)",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: '      case "too_early":\n      case "window_passed":\n        return { status: "pending" };',
    replace:
      '      case "too_early":\n        return { status: "pending" };\n      case "window_passed":\n        return { status: "expired" };',
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "R5-2 the fresh status read omits minContextSlot",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: '      commitment: "finalized",\n      minContextSlot,\n    } as unknown as SignatureStatusConfig;',
    replace: '      commitment: "finalized",\n    } as unknown as SignatureStatusConfig;',
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "R5-2b a node answering from behind minContextSlot is believed",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: "    if (resp.context.slot < minContextSlot) {",
    replace: "    if (false) {",
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "R5-2c the answering bank's height is not re-read (a lagging cache is believed)",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: "        after.blockHeight > tx.lastValidBlockHeight + FRESH_WINDOW_END\n",
    replace: "        false\n",
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "R5-3 the fresh read searches transaction history (BigTable / blockstore absence)",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: '      searchTransactionHistory: false,\n      commitment: "finalized",',
    replace: '      searchTransactionHistory: true,\n      commitment: "finalized",',
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "R5-3b the fresh read is not at finalized commitment",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: '      searchTransactionHistory: false,\n      commitment: "finalized",',
    replace: '      searchTransactionHistory: false,\n      commitment: "confirmed",',
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "R5-4 the fresh window starts at expiry (FRESH_WINDOW_START = 0)",
    pkg: "packages/wallet-solana",
    file: "src/adapter.ts",
    find: "export const FRESH_WINDOW_START = 11;",
    replace: "export const FRESH_WINDOW_START = 0;",
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "R5-4b the fresh window runs past the status cache's reach (FRESH_WINDOW_END = 300)",
    pkg: "packages/wallet-solana",
    file: "src/adapter.ts",
    find: "export const FRESH_WINDOW_END = 130;",
    replace: "export const FRESH_WINDOW_END = 300;",
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "R5-5 the fresh verdict is not persisted (unit)",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: '      persistVerdict(db, withdrawalId, a.signature, "dead_fresh", fresh.contextSlot, null);\n',
    replace: "",
    test: UNIT,
  },
  {
    name: "R5-5 same, across the harness (swept in window, operator reconciles late)",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: '      persistVerdict(db, withdrawalId, a.signature, "dead_fresh", fresh.contextSlot, null);\n',
    replace: "",
    test: HARNESS,
  },
  {
    name: "R5-5b a persisted positive verdict is not read back (evidence lost after the window)",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: '  if (a.fresh_verdict === "failed" || a.fresh_verdict === "dead_fresh") return { kind: "dead" };',
    replace: "",
    test: HARNESS,
  },
  {
    name: "R5-6 the operator's paid is refused on an absence verdict (unit of the door)",
    pkg: RELAY,
    file: "src/budget.ts",
    find: '      const attestedPaid =\n        verdict.kind === "undecided" &&',
    replace: "      const attestedPaid =\n        false &&",
    test: T921,
  },
  {
    name: "R5-6 same, across the harness (a landed payout the relay cannot see)",
    pkg: RELAY,
    file: "src/budget.ts",
    find: '      const attestedPaid =\n        verdict.kind === "undecided" &&',
    replace: "      const attestedPaid =\n        false &&",
    test: HARNESS,
  },
  {
    name: "R5-6b paid naming a signature this payout never signed is accepted",
    pkg: RELAY,
    file: "src/budget.ts",
    find: "getPayoutAttempts(moteDb.db, withdrawalId).some((a) => a.signature === payoutReference);",
    replace: "true;",
    test: T921,
  },
  {
    name: "R5-7 no_positive_evidence is ranked below nothing (a live attempt hidden behind a passed one)",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: "const rank = { pending: 0, rpc_error: 1, no_positive_evidence: 2 } as const;",
    replace: "const rank = { pending: 2, rpc_error: 1, no_positive_evidence: 0 } as const;",
    test: UNIT,
  },
  {
    name: "R5-8 the relay never starts the fresh-verdict sweep",
    pkg: RELAY,
    file: "src/index.ts",
    find: "    ? startFreshVerdictLoop(moteDb.db, operatorSolanaTransfer, () => false, loopSupervisor)\n    : null;",
    replace: "    ? (void startFreshVerdictLoop, null)\n    : null;",
    test: UNIT,
  },
  {
    name: "R5-8b the sweep skips attempts with no verdict (reads nothing)",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: "WHERE w.status = 'processing' AND a.fresh_verdict IS NULL",
    replace: "WHERE w.status = 'processing' AND a.fresh_verdict IS NOT NULL",
    test: HARNESS,
  },
  {
    name: "R5-9 Path 0 sends over a transfer that cannot take the fresh verdict",
    pkg: "packages/wallet-solana",
    file: "src/operator-transfer.ts",
    find: ' &&\n      typeof this.adapter.getFreshSignatureVerdict === "function"',
    replace: "",
    test: "src/__tests__/operator-transfer.test.ts",
  },
];

function run(): number {
  const root = resolve(import.meta.dirname, "../../../..");
  let failures = 0;
  for (const t of TAMPERS) {
    const path = resolve(root, t.pkg, t.file);
    const original = readFileSync(path, "utf-8");
    if (!original.includes(t.find)) {
      process.stdout.write(`COULD NOT APPLY  ${t.name}\n`);
      failures++;
      continue;
    }
    writeFileSync(path, original.replace(t.find, t.replace));
    let red = false;
    try {
      if (t.testPkg !== undefined) {
        execFileSync("pnpm", ["exec", "tsc", "-b"], { cwd: resolve(root, t.pkg), stdio: "ignore" });
      }
      execFileSync("npx", ["vitest", "run", t.test], {
        cwd: resolve(root, t.testPkg ?? t.pkg),
        stdio: "ignore",
      });
    } catch {
      red = true;
    } finally {
      writeFileSync(path, original);
      if (t.testPkg !== undefined) {
        execFileSync("pnpm", ["exec", "tsc", "-b"], { cwd: resolve(root, t.pkg), stdio: "ignore" });
      }
    }
    process.stdout.write(`${red ? "RED (ok)       " : "STILL GREEN    "} ${t.name}\n`);
    if (!red) failures++;
  }
  process.stdout.write(
    `\n${TAMPERS.length - failures}/${TAMPERS.length} tampers turned their test red\n`,
  );
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("withdrawal-payouts.tampers.ts")) {
  process.exit(run());
}
