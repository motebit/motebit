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
    find: 'if (verdict.kind === "undecided") {',
    replace:
      'if (verdict.kind === "undecided" && Date.now() < (withdrawal.claimed_at ?? 0) + 15 * 60 * 1000) {',
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
    name: "#949 a legacy claim's height bound is ignored",
    pkg: RELAY,
    file: "src/budget.ts",
    find: "return { dead: height > bound, height, bound };",
    replace: "return { dead: true, height, bound };",
    test: HARNESS,
  },
  {
    name: "#949 seen-in-a-block is not sticky",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: 'if (outcome.status === "expired" && a.seen_in_block === 1) {',
    replace: "if (false) {",
    test: UNIT,
  },
  {
    name: "#949 a landed attempt after the first is not found",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: "landed.push({ signature: a.signature, slot: outcome.slot });",
    replace:
      "if (landed.length === 0 && a === attempts[0]) landed.push({ signature: a.signature, slot: outcome.slot });",
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
      execFileSync("npx", ["vitest", "run", t.test], {
        cwd: resolve(root, t.pkg),
        stdio: "ignore",
      });
    } catch {
      red = true;
    } finally {
      writeFileSync(path, original);
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
