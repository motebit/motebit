/**
 * Bridge user-withdrawal path deletion — structural invariants test.
 *
 * Arc 1 Commit 2 of the off-ramp arc removed the user-facing Bridge
 * withdrawal capability at three layers:
 *   1. `BridgeSettlementRail.withdraw()` deleted at the package level
 *      (see packages/settlement-rails/src/bridge-rail.ts header)
 *   2. Path 2 dispatch deleted from services/relay/src/budget.ts
 *      (no `bridgeRail.withdraw(...)` call site remains in the relay)
 *   3. Bridge webhook handler deleted (no completion path for Bridge-
 *      initiated user withdrawals)
 *
 * These tests pin the structural invariants that emerge from the
 * deletion. They are intentionally orthogonal to the Path 0 tests in
 * `path0-solana-withdrawal.test.ts` — Path 0 tests verify the
 * positive case (sovereign Solana withdrawals work); this file
 * verifies the negative case (no fallthrough to Bridge exists, period).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { OperatorSolanaTransfer, type SolanaRpcAdapter } from "@motebit/wallet-solana";

import type { SyncRelay } from "../index.js";
import { creditAccount } from "../accounts.js";
import { AUTH_HEADER, createTestRelay, jsonAuthWithIdempotency } from "./test-helpers.js";

function makeOperator(overrides: Partial<SolanaRpcAdapter> = {}): {
  operator: OperatorSolanaTransfer;
  adapter: SolanaRpcAdapter;
} {
  const adapter: SolanaRpcAdapter = {
    ownAddress: "RelayTreasuryAddressBase58",
    getUsdcBalance: vi.fn().mockResolvedValue(10_000_000_000n),
    getUsdcBalanceOf: vi.fn().mockResolvedValue(10_000_000_000n),
    getSolBalance: vi.fn().mockResolvedValue(10_000_000n),
    sendUsdc: vi.fn().mockResolvedValue({
      signature: "tx-sig-base58",
      slot: 12345,
      confirmed: true,
    }),
    sendUsdcBatch: vi.fn().mockResolvedValue([]),
    getTransaction: vi.fn().mockResolvedValue({ status: "not_found" }),
    isReachable: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
  return { operator: new OperatorSolanaTransfer(adapter), adapter };
}

async function registerAndFund(relay: SyncRelay, motebitId: string, publicKeyHex: string) {
  await relay.app.request(`/api/v1/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      public_key: publicKeyHex,
    }),
  });
  creditAccount(
    relay.moteDb.db,
    motebitId,
    5_000_000,
    "deposit",
    "test-deposit",
    "User self-deposit",
  );
}

let relay: SyncRelay;

describe("Bridge user-withdrawal path — structural deletion", () => {
  afterEach(async () => {
    await relay?.close();
  });

  it("the Bridge webhook endpoint /api/v1/bridge/webhook returns 404 (deleted)", async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const res = await relay.app.request("/api/v1/bridge/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_type: "transfer.payment_processed" }),
    });
    expect(res.status).toBe(404);
  });

  it("a non-Solana, non-EVM destination stays pending — no fallback path exists", async () => {
    // Operator-Solana injected; destination is intentionally neither
    // base58-shaped (Path 0) nor 0x-EVM-shaped (Path 1). Before Commit 2,
    // this would fall through to Path 2 (Bridge). After Commit 2, the
    // only outcome is "stays pending for admin resolution."
    const { operator } = makeOperator();
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });

    const kp = await generateKeypair();
    await registerAndFund(relay, "user-weird-dest", bytesToHex(kp.publicKey));

    // Length too short for base58 Solana (32-44) AND not 0x-prefixed EVM.
    const oddDestination = "user@bank.example";

    const res = await relay.app.request("/api/v1/agents/user-weird-dest/withdraw", {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ amount: 1.0, destination: oddDestination }),
    });
    expect(res.status).toBe(200);

    const row = relay.moteDb.db
      .prepare(
        "SELECT status, payout_reference, completed_at FROM relay_withdrawals WHERE motebit_id = ? ORDER BY requested_at DESC LIMIT 1",
      )
      .get("user-weird-dest") as
      { status: string; payout_reference: string | null; completed_at: number | null } | undefined;
    expect(row).toBeDefined();
    // The doctrinal-correct outcome: no path matched, withdrawal stays
    // pending for admin resolution. Funds remain held by
    // requestWithdrawal — no double-spend risk.
    expect(row!.status).toBe("pending");
    expect(row!.payout_reference).toBeNull();
    expect(row!.completed_at).toBeNull();
  });

  it("a Solana destination with Path 0 unavailable stays pending — Bridge does NOT catch it (refinement #4)", async () => {
    // The exact transitional-state scenario the prior arc's review
    // flagged: Solana destination + Path 0 operator unreachable. Before
    // Commit 2, Bridge would attempt `createTransfer({on_behalf_of:
    // MotebitCustomerId, to: user's_Solana_wallet})` — Motebit becomes
    // the transmitter. After Commit 2, no path exists; withdrawal stays
    // pending. The structural impossibility is the doctrine enforced.
    const { operator, adapter } = makeOperator({
      isReachable: vi.fn().mockResolvedValue(false),
    });
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });

    const kp = await generateKeypair();
    await registerAndFund(relay, "user-rpc-down-2", bytesToHex(kp.publicKey));

    const userSolanaWallet = "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UDDDD";

    const res = await relay.app.request("/api/v1/agents/user-rpc-down-2/withdraw", {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ amount: 1.0, destination: userSolanaWallet }),
    });
    expect(res.status).toBe(200);

    // Path 0 checked availability and bailed; sendUsdc never invoked
    expect(adapter.sendUsdc).not.toHaveBeenCalled();

    // No Path 2 exists to catch it — stays pending
    const row = relay.moteDb.db
      .prepare(
        "SELECT status, payout_reference FROM relay_withdrawals WHERE motebit_id = ? ORDER BY requested_at DESC LIMIT 1",
      )
      .get("user-rpc-down-2") as { status: string; payout_reference: string | null } | undefined;
    expect(row!.status).toBe("pending");
    expect(row!.payout_reference).toBeNull();
  });
});
