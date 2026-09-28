/**
 * Issue #920 — a withdrawal is recorded complete only when funds moved.
 *
 * The settlement-outcome rule (spec/market-v1.md §10.4, budget.ts Path 0):
 *
 *   1. confirmed:true                 ⇒ completed, signed, balance stays debited
 *   2. confirmed:false, landed slot   ⇒ failed + balance refunded, ONCE,
 *                                        atomically with the status change
 *   3. throw / confirmed:false slot 0 ⇒ pending, balance NOT refunded
 *                                        (unknown: the transfer may land)
 *
 * The store half proves the refund is one transaction with the status
 * change (a failure mid-refund leaves the row pending and the balance
 * untouched) and that it happens at most once per withdrawal.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { createMotebitDatabase, type MotebitDatabase } from "@motebit/persistence";
import { requestWithdrawal, failWithdrawal } from "@motebit/virtual-accounts";
import { OperatorSolanaTransfer, type SolanaRpcAdapter } from "@motebit/wallet-solana";

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

    expect(failWithdrawal(store, id, "tx landed and failed")).toBe(true);
    // Retry — a re-run handler, a sweeper, an admin replay.
    expect(failWithdrawal(store, id, "retry")).toBe(false);
    expect(store.failWithdrawalAndRefund(id, "direct retry")).toBeNull();

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
    expect(() => failWithdrawal(store, id, "tx landed and failed")).toThrow(/zz920/);

    expect(store.getWithdrawalById(id)!.status).toBe("pending");
    expect(store.getOrCreateAccount("mote-a").balance).toBe(before);
    expect(refundRows(store, id)).toHaveLength(0);

    // Once the fault clears, the same call refunds exactly once.
    moteDb.db.exec("DROP TRIGGER zz920_refund_boom");
    expect(failWithdrawal(store, id, "tx landed and failed")).toBe(true);
    expect(store.getOrCreateAccount("mote-a").balance).toBe(FUNDED);
    expect(refundRows(store, id)).toHaveLength(1);
  });

  it("refuses a completed withdrawal — no refund of money that moved", () => {
    const fresh = freshStore();
    moteDb = fresh.moteDb;
    const { store } = fresh;
    const id = pendingWithdrawal(store);
    expect(store.setWithdrawalCompletion(id, TX_SIG, Date.now())).toBe(true);
    expect(failWithdrawal(store, id, "late fail")).toBe(false);
    expect(store.getOrCreateAccount("mote-a").balance).toBe(FUNDED - WITHDRAW_MICRO);
    expect(store.getWithdrawalById(id)!.status).toBe("completed");
  });
});

// ── Route half: Path 0 ─────────────────────────────────────────────

function makeOperator(sendUsdc: SolanaRpcAdapter["sendUsdc"]): {
  operator: OperatorSolanaTransfer;
  adapter: SolanaRpcAdapter;
} {
  const adapter: SolanaRpcAdapter = {
    ownAddress: "RelayTreasuryAddressBase58",
    getUsdcBalance: vi.fn().mockResolvedValue(10_000_000_000n),
    getUsdcBalanceOf: vi.fn().mockResolvedValue(10_000_000_000n),
    getSolBalance: vi.fn().mockResolvedValue(10_000_000n),
    sendUsdc,
    sendUsdcBatch: vi.fn().mockResolvedValue([]),
    getTransaction: vi.fn().mockResolvedValue({ status: "not_found" }),
    isReachable: vi.fn().mockResolvedValue(true),
  };
  return { operator: new OperatorSolanaTransfer(adapter), adapter };
}

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

describe("Path 0 settlement outcome (#920)", () => {
  afterEach(async () => {
    await relay?.close();
    relay = undefined;
  });

  it("confirmed:true ⇒ completed, signed, balance stays debited", async () => {
    const { operator } = makeOperator(
      vi.fn().mockResolvedValue({ signature: TX_SIG, slot: 12345, confirmed: true }),
    );
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
    expect(row.payout_reference).toBe(TX_SIG);
    expect(row.relay_signature).toBeTruthy();
    expect(balance(relay, "zz920-ok")).toBe(FUNDED - WITHDRAW_MICRO);
    expect(refundCount(relay, "zz920-ok", body.withdrawal.withdrawal_id)).toBe(0);
  });

  it("confirmed:false (landed and failed) ⇒ failed with the tx recorded, balance refunded exactly once", async () => {
    const send = vi.fn().mockResolvedValue({ signature: TX_SIG, slot: 12345, confirmed: false });
    const { operator } = makeOperator(send);
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    await registerAndFund(relay, "zz920-fail");

    const headers = jsonAuthWithIdempotency();
    const body = await withdraw(relay, "zz920-fail", headers);
    const id = body.withdrawal.withdrawal_id;

    // The response reports the real outcome, not a stale `pending` or a false `completed`.
    expect(body.withdrawal.status).toBe("failed");
    expect(body.withdrawal.failure_reason).toContain(TX_SIG);
    expect(body.withdrawal.failure_reason).toContain("confirmed:false");

    const row = relay.moteDb.db
      .prepare(
        "SELECT status, relay_signature, failure_reason FROM relay_withdrawals WHERE withdrawal_id = ?",
      )
      .get(id) as { status: string; relay_signature: string | null; failure_reason: string };
    expect(row.status).toBe("failed");
    // No signed completion receipt for a payout that never happened.
    expect(row.relay_signature).toBeNull();
    expect(balance(relay, "zz920-fail")).toBe(FUNDED);
    expect(refundCount(relay, "zz920-fail", id)).toBe(1);

    // Retry of the handler with the SAME Idempotency-Key: replayed, no second send, no second refund.
    await withdraw(relay, "zz920-fail", headers);
    expect(send).toHaveBeenCalledTimes(1);
    expect(balance(relay, "zz920-fail")).toBe(FUNDED);
    expect(refundCount(relay, "zz920-fail", id)).toBe(1);

    // Admin/sweeper retry of the fail: refused, no second refund.
    const admin = await relay.app.request(`/api/v1/admin/withdrawals/${id}/fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ reason: "operator retry" }),
    });
    expect(admin.status).toBe(404);
    expect(balance(relay, "zz920-fail")).toBe(FUNDED);
    expect(refundCount(relay, "zz920-fail", id)).toBe(1);
  });

  it("send throws (unknown outcome) ⇒ pending, balance NOT refunded", async () => {
    const { operator, adapter } = makeOperator(
      vi.fn().mockRejectedValue(new Error("block height exceeded — was not confirmed")),
    );
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    await registerAndFund(relay, "zz920-unknown");

    const body = await withdraw(relay, "zz920-unknown");
    expect(adapter.sendUsdc).toHaveBeenCalledOnce();
    expect(body.withdrawal.status).toBe("pending");
    const row = relay.moteDb.db
      .prepare("SELECT status, completed_at FROM relay_withdrawals WHERE withdrawal_id = ?")
      .get(body.withdrawal.withdrawal_id) as { status: string; completed_at: number | null };
    expect(row.status).toBe("pending");
    expect(row.completed_at).toBeNull();
    expect(balance(relay, "zz920-unknown")).toBe(FUNDED - WITHDRAW_MICRO);
    expect(refundCount(relay, "zz920-unknown", body.withdrawal.withdrawal_id)).toBe(0);
  });

  it("confirmed:false with no landed slot (unknown) ⇒ pending, balance NOT refunded", async () => {
    const { operator } = makeOperator(
      vi.fn().mockResolvedValue({ signature: TX_SIG, slot: 0, confirmed: false }),
    );
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    await registerAndFund(relay, "zz920-noslot");

    const body = await withdraw(relay, "zz920-noslot");
    expect(body.withdrawal.status).toBe("pending");
    expect(balance(relay, "zz920-noslot")).toBe(FUNDED - WITHDRAW_MICRO);
    expect(refundCount(relay, "zz920-noslot", body.withdrawal.withdrawal_id)).toBe(0);
  });
});
