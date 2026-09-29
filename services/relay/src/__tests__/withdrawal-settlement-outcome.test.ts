/**
 * Issue #920 — a withdrawal is recorded complete only when funds moved.
 *
 * The settlement-outcome rule (spec/market-v1.md §10.4, budget.ts Path 0),
 * over durable-nonce payouts (#990) — one transaction per nonce value, never
 * re-signed, decided only by FINALIZED statuses:
 *
 *   1. finalized ok                      ⇒ completed, signed, stays debited
 *   2. finalized with an error, or a finalized kill of its nonce,
 *      or nothing ever broadcast         ⇒ failed + refunded ONCE, atomically
 *   3. anything else                     ⇒ processing, NOT refunded, reason noted
 *
 * The store half proves the refund is one transaction with the status
 * change (a failure mid-refund leaves the row pending and the balance
 * untouched) and that it happens at most once per withdrawal.
 */

import { describe, it, expect, afterEach } from "vitest";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { createMotebitDatabase, type MotebitDatabase } from "@motebit/persistence";
import {
  requestWithdrawal,
  failWithdrawal,
  noteWithdrawalPayoutUnresolved,
} from "@motebit/virtual-accounts";

import type { SyncRelay } from "../index.js";
import { creditAccount, getAccountBalance, getTransactions } from "../accounts.js";
import {
  SqliteAccountStore,
  createAccountTables,
  createWalletTable,
  createWithdrawalTables,
} from "../account-store-sqlite.js";
import { createFederationTables } from "../federation.js";
import { createPairingTables } from "../pairing.js";
import { createDataSyncTables } from "../data-sync.js";
import { createProofTable } from "../settlement-proofs.js";
import { createIdempotencyTable } from "../idempotency.js";
import { relayMigrations, runMigrations } from "../migrations.js";
import { AUTH_HEADER, createTestRelay, jsonAuthWithIdempotency } from "./test-helpers.js";
import { freshChain, makeDurableOperator } from "./durable-payout-fake.js";

const TX_SIG =
  "5VfYdxYhWnD8X7K2YgHmBpDXJqJ1JmZj7rL2KkXg8sM3QfvN9P1bZw6cM5J8nT4rA7uW9eR6yU2dE1pV3hG4oS9k";
const FUNDED = 5_000_000;
const WITHDRAW_USD = 1.5;
const WITHDRAW_MICRO = 1_500_000;

// ── Store half ─────────────────────────────────────────────────────

function freshStore(): { moteDb: MotebitDatabase; store: SqliteAccountStore } {
  const moteDb = createMotebitDatabase(":memory:");
  createFederationTables(moteDb.db);
  createPairingTables(moteDb.db);
  createDataSyncTables(moteDb.db);
  createAccountTables(moteDb.db);
  createWithdrawalTables(moteDb.db);
  createProofTable(moteDb.db);
  createWalletTable(moteDb.db);
  createIdempotencyTable(moteDb.db);
  runMigrations(moteDb.db, relayMigrations);
  return { moteDb, store: new SqliteAccountStore(moteDb.db) };
}

function pendingWithdrawal(store: SqliteAccountStore): string {
  store.credit("mote-a", FUNDED, "deposit", "seed", "seed");
  const r = requestWithdrawal(store, {
    motebitId: "mote-a",
    amountMicro: WITHDRAW_MICRO,
    destination: "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UAAAA",
  });
  if (!r || "existing" in r) throw new Error("expected a fresh withdrawal");
  // The payout's claim (#921): every automated outcome settles from `processing`.
  if (!store.claimWithdrawalForPayout(r.withdrawal_id, Date.now())) throw new Error("claim");
  return r.withdrawal_id;
}

function refundRows(store: SqliteAccountStore, withdrawalId: string) {
  return store
    .getTransactions("mote-a", 100)
    .filter((t) => t.reference_id === withdrawalId && t.amount > 0);
}

describe("SqliteAccountStore.failWithdrawalAndRefund (#920)", () => {
  let moteDb: MotebitDatabase | undefined;
  afterEach(() => {
    moteDb?.close();
    moteDb = undefined;
  });

  it("fails and refunds in one step; a retry refunds nothing", () => {
    const fresh = freshStore();
    moteDb = fresh.moteDb;
    const { store } = fresh;
    const id = pendingWithdrawal(store);
    expect(store.getOrCreateAccount("mote-a").balance).toBe(FUNDED - WITHDRAW_MICRO);

    expect(failWithdrawal(store, id, "tx landed and failed", "processing")).toBe(true);
    // Retry — a re-run handler, a sweeper, an admin replay.
    expect(failWithdrawal(store, id, "retry", "processing")).toBe(false);
    expect(store.failWithdrawalAndRefund(id, "direct retry", "processing")).toBeNull();

    expect(store.getOrCreateAccount("mote-a").balance).toBe(FUNDED);
    expect(refundRows(store, id)).toHaveLength(1);
    const w = store.getWithdrawalById(id)!;
    expect(w.status).toBe("failed");
    expect(w.failure_reason).toBe("tx landed and failed");
  });

  it("is atomic: a failure inside the refund leaves the row pending and the balance untouched", () => {
    const fresh = freshStore();
    moteDb = fresh.moteDb;
    const { store } = fresh;
    const id = pendingWithdrawal(store);
    const before = store.getOrCreateAccount("mote-a").balance;

    // Make the refund's ledger-row INSERT fail — the LAST write of the
    // compound operation. Everything before it must roll back with it.
    moteDb.db.exec(`
      CREATE TRIGGER zz920_refund_boom BEFORE INSERT ON relay_transactions
      WHEN NEW.description LIKE 'Withdrawal failed:%'
      BEGIN SELECT RAISE(ABORT, 'zz920 injected refund failure'); END;
    `);
    expect(() => failWithdrawal(store, id, "tx landed and failed", "processing")).toThrow(/zz920/);

    expect(store.getWithdrawalById(id)!.status).toBe("processing");
    expect(store.getOrCreateAccount("mote-a").balance).toBe(before);
    expect(refundRows(store, id)).toHaveLength(0);

    // Once the fault clears, the same call refunds exactly once.
    moteDb.db.exec("DROP TRIGGER zz920_refund_boom");
    expect(failWithdrawal(store, id, "tx landed and failed", "processing")).toBe(true);
    expect(store.getOrCreateAccount("mote-a").balance).toBe(FUNDED);
    expect(refundRows(store, id)).toHaveLength(1);
  });

  it("refuses a completed withdrawal — no refund of money that moved", () => {
    const fresh = freshStore();
    moteDb = fresh.moteDb;
    const { store } = fresh;
    const id = pendingWithdrawal(store);
    expect(store.setWithdrawalCompletion(id, TX_SIG, Date.now(), "processing")).toBe(true);
    expect(failWithdrawal(store, id, "late fail", "processing")).toBe(false);
    expect(store.getOrCreateAccount("mote-a").balance).toBe(FUNDED - WITHDRAW_MICRO);
    expect(store.getWithdrawalById(id)!.status).toBe("completed");
  });

  it("completing a noted-pending withdrawal clears the unresolved-payout note", () => {
    const fresh = freshStore();
    moteDb = fresh.moteDb;
    const { store } = fresh;
    const id = pendingWithdrawal(store);
    expect(noteWithdrawalPayoutUnresolved(store, id, "unresolved payout: sig2 failed")).toBe(true);
    expect(store.getWithdrawalById(id)!.failure_reason).toBe("unresolved payout: sig2 failed");
    expect(store.setWithdrawalCompletion(id, TX_SIG, Date.now(), "processing")).toBe(true);
    const w = store.getWithdrawalById(id)!;
    expect(w.status).toBe("completed");
    expect(w.failure_reason).toBeNull();
  });

  it("refuses a note on a completed or failed withdrawal; the recorded reason is unchanged", () => {
    const fresh = freshStore();
    moteDb = fresh.moteDb;
    const { store } = fresh;

    const done = pendingWithdrawal(store);
    expect(store.setWithdrawalCompletion(done, TX_SIG, Date.now(), "processing")).toBe(true);
    expect(noteWithdrawalPayoutUnresolved(store, done, "late note")).toBe(false);
    expect(store.getWithdrawalById(done)!.failure_reason).toBeNull();
    expect(store.getWithdrawalById(done)!.status).toBe("completed");

    const failed = pendingWithdrawal(store);
    expect(failWithdrawal(store, failed, "reconciled: nothing landed", "processing")).toBe(true);
    expect(noteWithdrawalPayoutUnresolved(store, failed, "late note")).toBe(false);
    expect(store.getWithdrawalById(failed)!.failure_reason).toBe("reconciled: nothing landed");
    expect(store.getWithdrawalById(failed)!.status).toBe("failed");
  });
});

// ── Route half: Path 0 (#920, #990) ────────────────────────────────
//
// The outcome rule over durable-nonce payouts: only a FINALIZED status
// decides — finalized ok ⇒ completed; finalized with an error ⇒ failed and
// refunded once (it consumed its nonce; nothing moved); anything the send's
// bounded wait did not see finalized ⇒ processing, never refunded. The REAL
// adapter against released-agave semantics is driven by
// `withdrawal-payout-agave-harness.test.ts`.

async function registerAndFund(relay: SyncRelay, motebitId: string): Promise<void> {
  const kp = await generateKeypair();
  await relay.app.request(`/api/v1/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      public_key: bytesToHex(kp.publicKey),
    }),
  });
  creditAccount(relay.moteDb.db, motebitId, FUNDED, "deposit", "zz920-deposit", "self-deposit");
}

const DEST = "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UAAAA";

async function withdraw(relay: SyncRelay, motebitId: string, headers = jsonAuthWithIdempotency()) {
  const res = await relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
    method: "POST",
    headers,
    body: JSON.stringify({ amount: WITHDRAW_USD, destination: DEST }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    withdrawal: { withdrawal_id: string; status: string; failure_reason: string | null };
  };
}

function balance(relay: SyncRelay, motebitId: string): number {
  return getAccountBalance(relay.moteDb.db, motebitId)?.balance ?? 0;
}

function refundCount(relay: SyncRelay, motebitId: string, withdrawalId: string): number {
  return getTransactions(relay.moteDb.db, motebitId, 100).filter(
    (t) => t.reference_id === withdrawalId && t.amount > 0,
  ).length;
}

let relay: SyncRelay | undefined;

describe("Path 0 settlement outcome (#920, #990)", () => {
  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  it("finalized ok ⇒ completed with that signature, signed, balance stays debited", async () => {
    const { operator, chain } = makeDurableOperator(freshChain({ sendOutcome: "finalized_ok" }));
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    await registerAndFund(relay, "zz920-ok");

    const body = await withdraw(relay, "zz920-ok");
    expect(body.withdrawal.status).toBe("completed");
    const row = relay.moteDb.db
      .prepare(
        "SELECT status, payout_reference, relay_signature FROM relay_withdrawals WHERE withdrawal_id = ?",
      )
      .get(body.withdrawal.withdrawal_id) as {
      status: string;
      payout_reference: string;
      relay_signature: string | null;
    };
    expect(row.status).toBe("completed");
    expect(row.payout_reference).toBe(chain.payouts[0]!.signature);
    expect(row.relay_signature).toBeTruthy();
    expect(balance(relay, "zz920-ok")).toBe(FUNDED - WITHDRAW_MICRO);
    expect(refundCount(relay, "zz920-ok", body.withdrawal.withdrawal_id)).toBe(0);
  });

  it("finalized with an error ⇒ failed, refunded exactly once; a replay and an admin retry change nothing", async () => {
    const { operator, adapter } = makeDurableOperator(freshChain({ sendOutcome: "finalized_err" }));
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    await registerAndFund(relay, "zz920-fail");

    const headers = jsonAuthWithIdempotency();
    const body = await withdraw(relay, "zz920-fail", headers);
    const id = body.withdrawal.withdrawal_id;
    expect(body.withdrawal.status).toBe("failed");
    expect(body.withdrawal.failure_reason).toContain("landed and failed");

    const row = relay.moteDb.db
      .prepare("SELECT status, relay_signature FROM relay_withdrawals WHERE withdrawal_id = ?")
      .get(id) as { status: string; relay_signature: string | null };
    expect(row.status).toBe("failed");
    expect(row.relay_signature).toBeNull();
    expect(balance(relay, "zz920-fail")).toBe(FUNDED);
    expect(refundCount(relay, "zz920-fail", id)).toBe(1);

    await withdraw(relay, "zz920-fail", headers);
    expect(adapter.sendUsdcDurable).toHaveBeenCalledTimes(1);
    const admin = await relay.app.request(`/api/v1/admin/withdrawals/${id}/fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ reason: "operator retry" }),
    });
    expect(admin.status).toBe(404);
    expect(balance(relay, "zz920-fail")).toBe(FUNDED);
    expect(refundCount(relay, "zz920-fail", id)).toBe(1);
  });

  it("not finalized within the send's wait ⇒ processing, NOT refunded, reason noted; a replay sends nothing", async () => {
    const { operator, adapter, chain } = makeDurableOperator(
      freshChain({ sendOutcome: "unknown" }),
    );
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    await registerAndFund(relay, "zz920-unknown");

    const headers = jsonAuthWithIdempotency();
    const body = await withdraw(relay, "zz920-unknown", headers);
    const id = body.withdrawal.withdrawal_id;
    expect(body.withdrawal.status).toBe("processing");
    expect(body.withdrawal.failure_reason).toContain("not finalized");
    expect(body.withdrawal.failure_reason).toContain(chain.payouts[0]!.signature);
    expect(balance(relay, "zz920-unknown")).toBe(FUNDED - WITHDRAW_MICRO);
    expect(refundCount(relay, "zz920-unknown", id)).toBe(0);

    await withdraw(relay, "zz920-unknown", headers);
    expect(adapter.sendUsdcDurable).toHaveBeenCalledTimes(1);
    expect(refundCount(relay, "zz920-unknown", id)).toBe(0);
  });

  it("then: the payout finalizes ⇒ the resolution loop completes it; never a refund", async () => {
    const { operator, chain } = makeDurableOperator(freshChain({ sendOutcome: "unknown" }));
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    await registerAndFund(relay, "zz920-late");
    const body = await withdraw(relay, "zz920-late");
    const sig = chain.payouts[0]!.signature;
    chain.final.set(sig, { status: "finalized", ok: true, slot: 99 });
    await relay.withdrawalPayouts.resolveOnce();
    const row = relay.moteDb.db
      .prepare("SELECT status, payout_reference FROM relay_withdrawals WHERE withdrawal_id = ?")
      .get(body.withdrawal.withdrawal_id) as { status: string; payout_reference: string };
    expect(row).toEqual({ status: "completed", payout_reference: sig });
    expect(refundCount(relay, "zz920-late", body.withdrawal.withdrawal_id)).toBe(0);
  });

  it("the send throws before recording anything ⇒ nothing was sent ⇒ failed and refunded once", async () => {
    const { operator } = makeDurableOperator(freshChain({ sendOutcome: "throw_before" }));
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    await registerAndFund(relay, "zz920-nothing");
    const body = await withdraw(relay, "zz920-nothing");
    expect(body.withdrawal.status).toBe("failed");
    expect(body.withdrawal.failure_reason).toContain("was ever broadcast");
    expect(balance(relay, "zz920-nothing")).toBe(FUNDED);
    expect(refundCount(relay, "zz920-nothing", body.withdrawal.withdrawal_id)).toBe(1);
  });
});
