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
const AGAVE = "src/__tests__/withdrawal-payout-agave-harness.test.ts";
const OUTCOME = "src/__tests__/withdrawal-settlement-outcome.test.ts";

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
  // #945's batch failure doors, retargeted onto #1034's money rule (main):
  // a sent-mode failure is held `unknown` with a settle door, a manual one is
  // refunded on the queue row — never a row left without either.
  {
    name: "#945 a serial rail throw gets no settle door",
    pkg: RELAY,
    file: "src/batch-withdrawals.ts",
    find: "        markFailed(db, rail, row, err, Date.now());\n        failed++;",
    replace: "        failed++;",
    test: HARNESS,
  },
  {
    name: "#945 crashed fires are not recovered",
    pkg: RELAY,
    file: "src/batch-withdrawals.ts",
    find: "  recoverFiring(db, withdrawableRails, now, opts.processStartedAt ?? PROCESS_STARTED_AT);\n",
    replace: "",
    test: HARNESS,
  },
  {
    name: "#945 a fire in flight in this process is recovered as stale",
    pkg: RELAY,
    file: "src/batch-withdrawals.ts",
    find: "(firingHere.has(row.pending_id) || now - claimedAt < STALE_FIRING_MS)",
    replace: "(now - claimedAt < STALE_FIRING_MS)",
    test: UNIT,
  },
  {
    name: "#945 the fired write is not a compare-and-set",
    pkg: RELAY,
    file: "src/batch-withdrawals.ts",
    find: "SET status = 'fired', last_attempt_at = ?\n         WHERE pending_id = ? AND status = 'firing'",
    replace: "SET status = 'fired', last_attempt_at = ?\n         WHERE pending_id = ?",
    test: UNIT,
  },
  {
    name: "#945 a recovered row's horizon counts from the dead claim, not now",
    pkg: RELAY,
    file: "src/batch-withdrawals.ts",
    find: "          now + ((rail && payoutValidityMsOf(rail)) ?? UNDECLARED_PAYOUT_HORIZON_MS),",
    replace:
      "          ((row as { last_attempt_at?: number | null }).last_attempt_at ?? now) +\n            ((rail && payoutValidityMsOf(rail)) ?? UNDECLARED_PAYOUT_HORIZON_MS),",
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
  {
    name: "X10 the unknown-outcome write is not a compare-and-set",
    pkg: RELAY,
    file: "src/batch-withdrawals.ts",
    find: "SET status = 'unknown', last_error = ?, last_attempt_at = ?\n         WHERE pending_id = ? AND status = 'firing'",
    replace:
      "SET status = 'unknown', last_error = ?, last_attempt_at = ?\n         WHERE pending_id = ?",
    test: UNIT,
  },
  {
    name: "X11 a batch (withdrawBatch) throw gets no settle door",
    pkg: RELAY,
    file: "src/batch-withdrawals.ts",
    find: "    for (const row of rows) markFailed(db, rail, row, err, now);",
    replace: "    void rows;",
    test: HARNESS,
  },
  {
    name: "X12 a batch per-item failure gets no settle door",
    pkg: RELAY,
    file: "src/batch-withdrawals.ts",
    find: "    markFailed(db, rail, row, new Error(reason), now);",
    replace: "    void reason;",
    test: HARNESS,
  },
  // ── #949 / #990: a Path 0 payout is a durable-nonce transaction decided by
  // FINALIZED chain state (the fresh-verdict and retention-edge entries of
  // rounds 2–5 are retired with the machinery they guarded).
  {
    name: "#990 the payout is not recorded before broadcast",
    pkg: RELAY,
    file: "src/budget.ts",
    find: "beforeBroadcast: (tx) => recordDurableAttempt(moteDb.db, withdrawalId, tx, Date.now()),",
    replace: "beforeBroadcast: () => undefined,",
    test: AGAVE,
  },
  {
    name: "#949 the claim is not marked chain-recorded",
    pkg: RELAY,
    file: "src/budget.ts",
    find: 'if (ok) markChainRecordedClaim(moteDb.db, withdrawalId, "solana", claimedAt);',
    replace: "void ok;",
    test: T921,
  },
  {
    name: "#949 the operator's outcome may contradict the chain",
    pkg: RELAY,
    file: "src/budget.ts",
    find: "(outcome !== chainSays ||",
    replace: "(false ||",
    test: T921,
  },
  {
    name: "#949 an undecided payout opens after 15 wall-clock minutes (the old horizon)",
    pkg: RELAY,
    file: "src/budget.ts",
    find: 'if (verdict.kind === "undecided" && !attestedPaid) {',
    replace:
      'if (verdict.kind === "undecided" && !attestedPaid && Date.now() < (withdrawal.claimed_at ?? 0) + 15 * 60 * 1000) {',
    test: T921,
  },
  {
    name: "#990 a legacy claim (no recorded signature, no nonce to kill) accepts not_paid",
    pkg: RELAY,
    file: "src/budget.ts",
    find: '      if (outcome === "not_paid") {\n        logger.warn("withdrawal.admin.reconcile_refused_chain", {',
    replace:
      '      if (false) {\n        logger.warn("withdrawal.admin.reconcile_refused_chain", {',
    test: AGAVE,
  },
  {
    name: "#990 a payout finalized WITH an error is read as paid",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: 'const landed = payouts.filter((a) => a.final_status === "ok");',
    replace: "const landed = payouts.filter((a) => a.final_status !== null);",
    test: AGAVE,
  },
  {
    name: "#990 a kill that is recorded but not finalized counts as proof",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: "        k.final_status !== null &&",
    replace: "        true &&",
    test: UNIT,
  },
  {
    name: "#990 a kill over ANOTHER nonce value counts as proof",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: "        k.nonce_value === durable.nonce_value,",
    replace: "        true,",
    test: UNIT,
  },
  {
    name: "#990 a payout that finalized with an error is not read as not paid",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: 'if (durable.final_status === "err") {',
    replace: "if (false) {",
    test: UNIT,
  },
  {
    name: "#990 nothing broadcast is not read as not paid",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: 'if (attempts.length === 0) return { kind: "not_paid", attempts: 0, by: "no_broadcast" };',
    replace: "",
    test: UNIT,
  },
  {
    name: "#990 a finalized status is not recorded (read again forever)",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: "recordFinal(db, withdrawalId, a.signature, st.ok, st.slot);",
    replace: "",
    test: UNIT,
  },
  {
    name: "#990 a status read has no timeout (a hung RPC holds the verdict)",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: 'st = await withTimeout(\n          reader.getFinalizedStatus(a.signature),\n          timeoutMs,\n          "finalized status",\n        );',
    replace: "st = await reader.getFinalizedStatus(a.signature);",
    test: UNIT,
  },
  {
    name: "#990 reads are not bounded (concurrency = every item)",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: "Math.max(1, Math.min(limit, items.length))",
    replace: "Math.max(1, items.length)",
    test: UNIT,
  },
  {
    name: "#990 a kill is broadcast although the lane already moved past the payout's nonce",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: "  if (lane.nonceValue !== payout.nonce_value) {",
    replace: "  if (false) {",
    test: UNIT,
  },
  {
    name: "#990 the operator's paid is accepted while a recorded status is found unfinalized (a fork)",
    pkg: RELAY,
    file: "src/budget.ts",
    find: "        recordedPayout &&\n        verdict.unfinalized.length === 0;",
    replace: "        recordedPayout;",
    test: T921,
  },
  {
    name: "#990 the operator's paid is accepted for a signature this payout never signed",
    pkg: RELAY,
    file: "src/budget.ts",
    find: '(a) => a.kind === "payout" && a.signature === payoutReference,',
    replace: "() => true,",
    test: T921,
  },
  {
    name: "#990 the operator's paid is refused on absence (a landed payout the node cannot show)",
    pkg: RELAY,
    file: "src/budget.ts",
    find: 'const attestedPaid =\n        verdict.kind === "undecided" &&',
    replace: "const attestedPaid =\n        false &&",
    test: T921,
  },
  {
    name: "#990 the operator's not_paid does not broadcast the kill",
    pkg: RELAY,
    file: "src/budget.ts",
    find: 'if (outcome === "not_paid" && verdict.killable) {',
    replace: "if (false) {",
    test: T921,
  },
  {
    name: "#990 an undecided payout is never killed automatically",
    pkg: RELAY,
    file: "src/budget.ts",
    find: "if (verdict.killable && Date.now() - claimedAt >= killAfterMs) {",
    replace: "if (false) {",
    test: T921,
  },
  {
    name: "#990 the kill-after wait is ignored (killed at once)",
    pkg: RELAY,
    file: "src/budget.ts",
    find: "if (verdict.killable && Date.now() - claimedAt >= killAfterMs) {",
    replace: "if (verdict.killable) {",
    test: T921,
  },
  {
    name: "#990 a busy nonce lane is not refused (two payouts over one nonce)",
    pkg: RELAY,
    file: "src/budget.ts",
    find: "if (reservedNonces.has(lane.nonceValue) || isNonceValueUsed(moteDb.db, lane)) {",
    replace: "if (false) {",
    test: AGAVE,
  },
  {
    name: "#990 the claimed nonce value is not reserved (two concurrent payouts over one nonce)",
    pkg: RELAY,
    file: "src/budget.ts",
    find: "      reservedNonces.add(lane.nonceValue);\n",
    replace: "",
    test: AGAVE,
  },
  {
    name: "#990 a withdrawal waiting for an unavailable lane is not queued",
    pkg: RELAY,
    file: "src/budget.ts",
    find: '        enqueuePayout(moteDb.db, withdrawalId, Date.now());\n        logger.warn("withdrawal.solana.nonce_lane_unavailable"',
    replace: '        logger.warn("withdrawal.solana.nonce_lane_unavailable"',
    test: T921,
  },
  {
    name: "#990 the resolution loop never fires the queue",
    pkg: RELAY,
    file: "src/budget.ts",
    find: "for (const id of queuedPayouts(moteDb.db)) {",
    replace: "for (const id of [] as string[]) {",
    test: AGAVE,
  },
  {
    name: "#990 the send path does not decide what the chain already shows",
    pkg: RELAY,
    file: "src/budget.ts",
    find: '        (await resolveWithdrawal(withdrawalId, { inline: true, correlationId })) === "frozen";',
    replace: "        false;",
    test: OUTCOME,
  },
  {
    name: "#921 a settling write that loses after the send is silent",
    pkg: RELAY,
    file: "src/budget.ts",
    find: "      if (opts.inline) {\n        // The send path's own payout",
    replace: "      if (false) {\n        // The send path's own payout",
    test: T921,
  },
  {
    name: "#990 the relay never starts the resolution loop",
    pkg: RELAY,
    file: "src/index.ts",
    find: "const payoutResolutionInterval = operatorSolanaTransfer\n    ? startPayoutResolutionLoop(",
    replace: "const payoutResolutionInterval = false\n    ? startPayoutResolutionLoop(",
    test: UNIT,
  },
  {
    name: "#990 nonceAdvance is not the FIRST instruction",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: "const tx = new Transaction().add(\n      SystemProgram.nonceAdvance({",
    replace:
      "const tx = new Transaction().add(\n      ...rest,\n      SystemProgram.nonceAdvance({",
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "#990 the payout is signed over something other than the lane's nonce value",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: "tx.recentBlockhash = lane.nonceValue;",
    replace: "tx.recentBlockhash = this.keypair.publicKey.toBase58();",
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "#990 the payout is recorded AFTER it is sent",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: '    if (hooks?.beforeBroadcast != null) await hooks.beforeBroadcast(ref);\n    try {\n      await this.timed(this.connection.sendRawTransaction(tx.serialize()), "sendRawTransaction");',
    replace:
      '    try {\n      await this.timed(this.connection.sendRawTransaction(tx.serialize()), "sendRawTransaction");\n      if (hooks?.beforeBroadcast != null) await hooks.beforeBroadcast(ref);',
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "#990 a status below finality (processed / confirmed — a fork) is taken as final (wallet-solana)",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: 'if (status.confirmationStatus !== "finalized") {',
    replace: "if (false) {",
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "#990 same, seen through the relay's released-agave harness (1b / 1c)",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: 'if (status.confirmationStatus !== "finalized") {',
    replace: "if (false) {",
    test: AGAVE,
    testPkg: "services/relay",
  },
  {
    name: "#990 an absent status-cache answer does not fall back to history",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: "if (resp.value[0] == null) {",
    replace: "if (false) {",
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "#990 the nonce lane is read below finality",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: '      this.connection.getAccountInfoAndContext(address, {\n        commitment: "finalized",',
    replace:
      '      this.connection.getAccountInfoAndContext(address, {\n        commitment: "confirmed",',
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "#990 a nonce account another key controls is used",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: "if (nonce.authorizedPubkey.toBase58() !== this.keypair.publicKey.toBase58()) {",
    replace: "if (false) {",
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "#990 an RPC call has no per-call timeout",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: "return Promise.race([p, timeout]).finally(() => clearTimeout(timer));",
    replace: "return p.finally(() => clearTimeout(timer));",
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "#990 Path 0 sends over a transfer that cannot read finalized statuses",
    pkg: "packages/wallet-solana",
    file: "src/operator-transfer.ts",
    find: '      typeof a.broadcastNonceKill === "function" &&\n      typeof a.getFinalizedStatus === "function"',
    replace: '      typeof a.broadcastNonceKill === "function"',
    test: "src/__tests__/operator-transfer.test.ts",
  },
  {
    name: "#949 the operator transfer drops the broadcast hooks",
    pkg: "packages/wallet-solana",
    file: "src/operator-transfer.ts",
    find: "return this.adapter.sendUsdcDurable({ toAddress, microAmount }, lane, hooks);",
    replace: "return this.adapter.sendUsdcDurable({ toAddress, microAmount }, lane);",
    test: "src/__tests__/operator-transfer.test.ts",
  },
  // ── round 7: the lane address is public (C1); an unrecorded nonce advance (P1)
  {
    name: "C1 a pre-funded system-owned 0-byte squat is treated as unusable (not taken over)",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: '    if (info.data.length === 0) {\n      return { status: "takeover", lamports: info.lamports, dataLen: 0 };',
    replace: '    if (info.data.length === 0) {\n      return squatted("funded by someone else");',
    test: AGAVE,
    testPkg: "services/relay",
  },
  {
    name: "C1 same, pinned by the adapter test",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: '    if (info.data.length === 0) {\n      return { status: "takeover", lamports: info.lamports, dataLen: 0 };',
    replace: '    if (info.data.length === 0) {\n      return squatted("funded by someone else");',
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "C1 the takeover omits allocateWithSeed (initialize on a 0-byte account fails)",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: "    if (dataLen === 0) {\n      ixs.push(",
    replace: "    if (false) {\n      ixs.push(",
    test: AGAVE,
    testPkg: "services/relay",
  },
  {
    name: "C1 the takeover omits the rent top-up (an under-funded squat stays uninitializable)",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: "    if (lamports < rent) {",
    replace: "    if (false) {",
    test: AGAVE,
    testPkg: "services/relay",
  },
  {
    name: "C1 an account owned by another program is taken for a nonce account",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: "    if (info.owner.toBase58() !== SystemProgram.programId.toBase58()) {\n      return squatted(",
    replace: "    if (false) {\n      return squatted(",
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "C1 a system account with other data is taken over",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: "    if (info.data.length !== NONCE_ACCOUNT_LENGTH) {\n      return squatted(",
    replace: "    if (false) {\n      return squatted(",
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "C1 an unrecoverable squat is not flagged (no address for the alarm)",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: "      squatted: { address: address.toBase58() },\n",
    replace: "",
    test: AGAVE,
    testPkg: "services/relay",
  },
  {
    name: "C1 a malformed seed suffix is accepted",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: "  if (!/^[a-z0-9]{1,8}$/.test(suffix)) {",
    replace: "  if (false) {",
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "C1 the squat is never raised as an alarm (the loop reads healthy)",
    pkg: RELAY,
    file: "src/budget.ts",
    find: "    if (squat !== null) {",
    replace: "    if (false) {",
    test: AGAVE,
  },
  {
    name: "C1 the squatted lane is not recorded for the tick's alarm",
    pkg: RELAY,
    file: "src/budget.ts",
    find: "        squatThisTick = { address: lane.squatted.address, reason: lane.reason };\n",
    replace: "",
    test: AGAVE,
  },
  {
    name: "P1 an unrecorded nonce advance is reported as kill_pending (no kill was sent)",
    pkg: RELAY,
    file: "src/budget.ts",
    find: '                : kill?.status === "consumed"\n                  ? "nonce_consumed_unrecorded"',
    replace: '                : kill?.status === "consumed"\n                  ? "kill_pending"',
    test: AGAVE,
  },
  {
    name: "P1 the attested override refunds without the nonce proven consumed",
    pkg: RELAY,
    file: "src/budget.ts",
    find: '        attestedNotPaid =\n          kill?.status === "consumed" &&',
    replace: "        attestedNotPaid =\n          true &&",
    test: T921,
  },
  {
    name: "P1 the attested override refunds while a recorded status is found below finality",
    pkg: RELAY,
    file: "src/budget.ts",
    find: "          verdict.unfinalized.length === 0 &&\n          body.override",
    replace: "          true &&\n          body.override",
    test: T921,
  },
  {
    name: "P1 not_paid refunds a consumed nonce WITHOUT the explicit override",
    pkg: RELAY,
    file: "src/budget.ts",
    find: '          body.override === "nonce_consumed_unrecorded";',
    replace: "          true;",
    test: AGAVE,
  },
  // ── round 8b: a new payout's lane read is floored at the highest observed slot
  {
    name: "C-1 (3) a new payout's lane read carries no minContextSlot floor",
    pkg: RELAY,
    file: "src/budget.ts",
    find: "            laneReadFloor(moteDb.db) !== undefined\n",
    replace: "            false\n",
    test: T921,
  },
  {
    name: "C-1 (3) the lane-read floor is the LOWEST observed slot, not the highest",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: '"SELECT MAX(nonce_observed_slot) AS m FROM relay_withdrawal_payout_attempts"',
    replace: '"SELECT MIN(nonce_observed_slot) AS m FROM relay_withdrawal_payout_attempts"',
    test: T921,
  },
  // ── round 8: "consumed" means provably PAST (C-1); the payout's own lane (P-a)
  {
    name: "C-1 (1) the kill/consumed read is not bound by the observed slot (relay)",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: "killer.readNonceAccount(payout.nonce_account, { minContextSlot: observed }),",
    replace: "killer.readNonceAccount(payout.nonce_account, {}),",
    test: UNIT,
  },
  {
    name: "C-1 (1) a read answered from below the observed slot is believed (relay)",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: "  if (lane.observedSlot === undefined || lane.observedSlot < observed) {",
    replace: "  if (false) {",
    test: UNIT,
  },
  {
    name: "C-1 (1) the adapter's account read omits minContextSlot",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: "        ...(minContextSlot !== undefined ? { minContextSlot } : {}),\n",
    replace: "",
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "C-1 (1) the adapter believes a node answering below minContextSlot",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: "    if (minContextSlot !== undefined && resp.context.slot < minContextSlot) {",
    replace: "    if (false) {",
    test: "src/__tests__/web3js-adapter.test.ts",
  },
  {
    name: "C-1 (1) the observed slot is not recorded with the payout",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: "    tx.nonceObservedSlot ?? null,",
    replace: "    null,",
    test: AGAVE,
  },
  {
    name: "C-1 (1) the signer does not carry the observed slot onto the payout",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: "        ...(lane.observedSlot !== undefined ? { nonceObservedSlot: lane.observedSlot } : {}),\n",
    replace: "",
    test: AGAVE,
    testPkg: "services/relay",
  },
  {
    name: "C-1 (1) a payout recorded without its observed slot can be called consumed",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: '  if (observed === null) {\n    return { status: "stale"',
    replace: '  if (false) {\n    return { status: "stale"',
    test: UNIT,
  },
  {
    name: "C-1 (2) a recorded EARLIER nonce value counts as consumed",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: "    if (earlierNonceValues(db, payout.nonce_account, payout.recorded_at).has(lane.nonceValue)) {",
    replace: "    if (false) {",
    test: UNIT,
  },
  {
    name: "C-1 (2) values recorded LATER are also treated as earlier (a real advance never proven)",
    pkg: RELAY,
    file: "src/withdrawal-chain-payouts.ts",
    find: "WHERE nonce_account = ? AND recorded_at < ? AND nonce_value IS NOT NULL",
    replace: "WHERE nonce_account = ? AND recorded_at <= ? + 1e15 AND nonce_value IS NOT NULL",
    test: UNIT,
  },
  {
    name: "P-a the kill reads the CURRENT lane, not the payout's own nonce account",
    pkg: "packages/wallet-solana",
    file: "src/web3js-adapter.ts",
    find: "      const r = await this.readNonceLane(new PublicKey(account), opts.minContextSlot);",
    replace:
      "      void account;\n      const r = await this.readNonceLane(undefined, opts.minContextSlot);",
    test: AGAVE,
    testPkg: "services/relay",
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
