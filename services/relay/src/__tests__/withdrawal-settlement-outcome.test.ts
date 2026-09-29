/**
 * Issue #920 — a withdrawal is recorded complete only when funds moved.
 *
 * The settlement-outcome rule (spec/market-v1.md §10.4, budget.ts Path 0):
 *
 *   1. confirmed:true                    ⇒ completed, signed, stays debited
 *   2. confirmed:false AND
 *      earlierBroadcastsDead === true    ⇒ failed + refunded ONCE, atomically
 *   3. throw, or confirmed:false with
 *      earlierBroadcastsDead false/absent ⇒ pending, NOT refunded, reason noted
 *
 * Round 2 (#920 cold review): an adapter that re-signs after a blockhash
 * expiry can report `confirmed:false` for its LAST broadcast while its FIRST
 * broadcast landed and paid. `confirmed:false` alone never proves nothing
 * was paid, so the refund needs `earlierBroadcastsDead === true`.
 *
 * The store half proves the refund is one transaction with the status
 * change (a failure mid-refund leaves the row pending and the balance
 * untouched) and that it happens at most once per withdrawal.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { createMotebitDatabase, type MotebitDatabase } from "@motebit/persistence";
import {
  requestWithdrawal,
  failWithdrawal,
  noteWithdrawalPayoutUnresolved,
} from "@motebit/virtual-accounts";
import {
  OperatorSolanaTransfer,
  Web3JsRpcAdapter,
  deriveSolanaAddress,
  type SolanaRpcAdapter,
} from "@motebit/wallet-solana";

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

// ── Route half: Path 0 ─────────────────────────────────────────────

function makeOperator(sendUsdc: SolanaRpcAdapter["sendUsdc"]): {
  operator: OperatorSolanaTransfer;
  adapter: SolanaRpcAdapter;
} {
  const adapter: SolanaRpcAdapter = {
    // #949: Path 0 sends only over a transfer that records every broadcast
    // and can read its outcome.
    honorsBroadcastHooks: true,
    // The node's retained-history edge (#949 rounds 2–3): full history.
    getFirstAvailableSlot: () => Promise.resolve(0),
    getSignatureOutcome: vi.fn().mockResolvedValue({ status: "pending" }),
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

  it("confirmed:false + earlierBroadcastsDead:true ⇒ failed with the tx recorded, balance refunded exactly once", async () => {
    const send = vi.fn().mockResolvedValue({
      signature: TX_SIG,
      slot: 12345,
      confirmed: false,
      earlierBroadcastsDead: true,
    });
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
    expect(body.withdrawal.status).toBe("processing");
    const row = relay.moteDb.db
      .prepare("SELECT status, completed_at FROM relay_withdrawals WHERE withdrawal_id = ?")
      .get(body.withdrawal.withdrawal_id) as { status: string; completed_at: number | null };
    expect(row.status).toBe("processing");
    expect(row.completed_at).toBeNull();
    expect(balance(relay, "zz920-unknown")).toBe(FUNDED - WITHDRAW_MICRO);
    expect(refundCount(relay, "zz920-unknown", body.withdrawal.withdrawal_id)).toBe(0);
  });

  // The reviewer's cell: the adapter re-signed after a "block height
  // exceeded", the first broadcast may have landed, and the re-broadcast
  // (its create-ATA instruction no longer valid) landed and failed. The
  // result describes sig2 only and says nothing about sig1.
  for (const [label, field] of [
    ["absent", undefined],
    ["false", false],
  ] as const) {
    it(`confirmed:false + earlierBroadcastsDead ${label} (retry cell) ⇒ pending, NOT refunded, reason noted`, async () => {
      const result: Record<string, unknown> = { signature: TX_SIG, slot: 12345, confirmed: false };
      if (field !== undefined) result["earlierBroadcastsDead"] = field;
      const send = vi.fn().mockResolvedValue(result);
      const { operator } = makeOperator(send);
      relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
      const mid = `zz920-retry-${label}`;
      await registerAndFund(relay, mid);

      const headers = jsonAuthWithIdempotency();
      const body = await withdraw(relay, mid, headers);
      const id = body.withdrawal.withdrawal_id;
      expect(body.withdrawal.status).toBe("processing");

      const row = relay.moteDb.db
        .prepare(
          "SELECT status, relay_signature, completed_at, payout_reference, failure_reason FROM relay_withdrawals WHERE withdrawal_id = ?",
        )
        .get(id) as {
        status: string;
        relay_signature: string | null;
        completed_at: number | null;
        payout_reference: string | null;
        failure_reason: string | null;
      };
      expect(row.status).toBe("processing");
      expect(row.relay_signature).toBeNull();
      expect(row.completed_at).toBeNull();
      // sig2 is not a payout: it is not recorded as the payout reference.
      expect(row.payout_reference).toBeNull();
      // The operator can see why it is stuck.
      expect(row.failure_reason).toContain("unresolved payout");
      expect(row.failure_reason).toContain(TX_SIG);
      expect(balance(relay, mid)).toBe(FUNDED - WITHDRAW_MICRO);
      expect(refundCount(relay, mid, id)).toBe(0);

      // A replay of the handler changes nothing.
      await withdraw(relay, mid, headers);
      expect(send).toHaveBeenCalledTimes(1);
      expect(balance(relay, mid)).toBe(FUNDED - WITHDRAW_MICRO);
      expect(refundCount(relay, mid, id)).toBe(0);
    });
  }

  // The reviewer's cell on the REAL adapter (stubbed Connection): attempt 1's
  // confirmation loses the race to "block height exceeded" (sig1 may have
  // landed and paid), the adapter re-signs, and attempt 2 — whose create-ATA
  // instruction is no longer valid — lands and fails. Main recorded this as a
  // completed withdrawal citing sig2; a naive `confirmed:false ⇒ refund` rule
  // would refund it (a double pay if sig1 landed). It must stay pending.
  /**
   * The REAL Web3JsRpcAdapter (#885): after web3.js reports "block height
   * exceeded" it asks the chain about the first signature before any re-sign.
   * `chain` decides what the status reads say.
   */
  async function realAdapterWithdraw(
    mid: string,
    chain: "undecidable" | "first_expired",
  ): Promise<{ r: SyncRelay; sends: number; withdrawalId: string; status: string }> {
    let t = 0;
    const adapter = new Web3JsRpcAdapter({
      rpcUrl: "http://127.0.0.1:1",
      identitySeed: new Uint8Array(32).fill(7),
      // Virtual clock: the post-expiry poll's 30s cap costs no real time.
      expiryConfirm: { now: () => t, sleep: (ms) => ((t += ms), Promise.resolve()) },
    });
    let sends = 0;
    let confirms = 0;
    const conn = {
      // The pre-blockhash slot read and the retention edge (#949 rounds 2–3).
      getSlot: vi.fn().mockResolvedValue(8_000),
      getFirstAvailableBlock: vi.fn().mockResolvedValue(0),
      getLatestBlockhash: vi.fn().mockResolvedValue({
        blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi",
        lastValidBlockHeight: 100,
      }),
      getAccountInfo: vi.fn().mockResolvedValue(null), // dest ATA missing: create-ATA ix
      sendRawTransaction: vi.fn().mockImplementation(() => {
        sends++;
        return Promise.resolve(sends === 1 ? "sig1" + TX_SIG.slice(4) : TX_SIG);
      }),
      confirmTransaction: vi.fn().mockImplementation(() => {
        confirms++;
        if (confirms === 1)
          return Promise.reject(new Error("Signature sig1 has expired: block height exceeded."));
        return Promise.resolve({
          context: { slot: 4242 },
          value: { err: { InstructionError: [0, { Custom: 0 }] } },
        });
      }),
      // undecidable: the chain is still inside the expiry margin — the first
      // send may yet land. first_expired: past the margin, the status node
      // caught up, the signature is nowhere — proven dead.
      getEpochInfo: vi
        .fn()
        .mockResolvedValue(
          chain === "first_expired"
            ? { blockHeight: 500, absoluteSlot: 9_000 }
            : { blockHeight: 101, absoluteSlot: 9_000 },
        ),
      getSignatureStatuses: vi.fn().mockResolvedValue({ context: { slot: 9_000 }, value: [null] }),
    };
    (adapter as unknown as { connection: unknown }).connection = conn;
    (adapter as unknown as { getUsdcBalance: () => Promise<bigint> }).getUsdcBalance = () =>
      Promise.resolve(10_000_000_000n);
    const r = await createTestRelay({
      enableDeviceAuth: false,
      operatorSolanaTransfer: new OperatorSolanaTransfer(adapter),
    });
    relay = r; // closed by afterEach
    await registerAndFund(r, mid);
    // An on-curve destination: the real adapter derives its ATA.
    const res = await r.app.request(`/api/v1/agents/${mid}/withdraw`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        amount: WITHDRAW_USD,
        destination: deriveSolanaAddress(new Uint8Array(32).fill(9)),
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { withdrawal: { withdrawal_id: string; status: string } };
    return {
      r,
      sends,
      withdrawalId: body.withdrawal.withdrawal_id,
      status: body.withdrawal.status,
    };
  }

  it("real adapter, expiry while the first send may still land ⇒ never re-signed, pending, NOT refunded", async () => {
    const mid = "zz920-real-undecidable";
    const out = await realAdapterWithdraw(mid, "undecidable");
    expect(out.sends, "no second broadcast while the first may land").toBe(1);
    expect(out.status).toBe("processing");
    expect(balance(out.r, mid)).toBe(FUNDED - WITHDRAW_MICRO);
    expect(refundCount(out.r, mid, out.withdrawalId)).toBe(0);
  });

  it("real adapter, first send PROVEN expired, re-broadcast lands and fails ⇒ failed and refunded exactly once", async () => {
    const mid = "zz920-real-proven";
    const out = await realAdapterWithdraw(mid, "first_expired");
    expect(out.sends).toBe(2);
    // earlierBroadcastsDead is true (the adapter proved sig1 dead), and the
    // re-broadcast landed and failed: nothing was paid — refund once.
    expect(out.status).toBe("failed");
    expect(balance(out.r, mid)).toBe(FUNDED);
    expect(refundCount(out.r, mid, out.withdrawalId)).toBe(1);
  });

  it("malformed result (no `confirmed`) with earlierBroadcastsDead:true ⇒ pending, NOT refunded", async () => {
    const { operator } = makeOperator(
      vi.fn().mockResolvedValue({ signature: TX_SIG, slot: 12345, earlierBroadcastsDead: true }),
    );
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    const mid = "zz920-malformed";
    await registerAndFund(relay, mid);
    const body = await withdraw(relay, mid);
    expect(body.withdrawal.status).toBe("processing");
    expect(balance(relay, mid)).toBe(FUNDED - WITHDRAW_MICRO);
    expect(refundCount(relay, mid, body.withdrawal.withdrawal_id)).toBe(0);
  });
});
