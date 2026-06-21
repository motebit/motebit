/**
 * Path 0 Solana sovereign-return withdrawal dispatch tests.
 *
 * Arc 1 Commit 1 of the off-ramp arc (docs/doctrine/settlement-rails.md
 * § "Lanes for external readers" + future `off-ramp-as-user-action.md`).
 * When a user requests withdrawal to their own sovereign Solana wallet
 * (base58-shaped destination), the relay's operator-side Solana transfer
 * primitive sends USDC directly from the relay treasury — no third-party
 * orchestrator, no `on_behalf_of` header, native principal of its own
 * onchain transfer.
 *
 * These tests pin three things:
 *   1. Path 0 fires when destination is base58-shaped AND
 *      operatorSolanaTransfer is injected
 *   2. Withdrawal is completed with the Solana tx signature as
 *      `payout_reference` and a signed `WithdrawalReceipt`
 *   3. Path 0 does NOT fire (falls through to other paths) when the
 *      destination is EVM-shaped, when operatorSolanaTransfer is absent,
 *      or when the operator transfer reports unavailable
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { OperatorSolanaTransfer, type SolanaRpcAdapter } from "@motebit/wallet-solana";

import type { SyncRelay } from "../index.js";
import { creditAccount } from "../accounts.js";
import { AUTH_HEADER, createTestRelay, jsonAuthWithIdempotency } from "./test-helpers.js";

// === Helpers ===

/**
 * Construct a fake-adapter-backed OperatorSolanaTransfer for injection.
 * The fake adapter returns deterministic results; tests assert on what
 * was sent and how the relay records it.
 */
function makeOperator(overrides: Partial<SolanaRpcAdapter> = {}): {
  operator: OperatorSolanaTransfer;
  adapter: SolanaRpcAdapter;
} {
  const adapter: SolanaRpcAdapter = {
    ownAddress: "RelayTreasuryAddressBase58",
    getUsdcBalance: vi.fn().mockResolvedValue(10_000_000_000n),
    getSolBalance: vi.fn().mockResolvedValue(10_000_000n),
    sendUsdc: vi.fn().mockResolvedValue({
      signature:
        "5VfYdxYhWnD8X7K2YgHmBpDXJqJ1JmZj7rL2KkXg8sM3QfvN9P1bZw6cM5J8nT4rA7uW9eR6yU2dE1pV3hG4oS9k",
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
  // Give the user a balance via self-deposit credit (treats it as same-party
  // round-trip — Path 0's load-bearing semantic).
  creditAccount(
    relay.moteDb.db,
    motebitId,
    5_000_000,
    "deposit",
    "test-deposit",
    "User self-deposit",
  );
}

// === Tests ===

let relay: SyncRelay;

describe("Path 0 — Solana sovereign-return withdrawal", () => {
  afterEach(async () => {
    await relay?.close();
  });

  it("fires when destination is base58-shaped and operator is injected", async () => {
    const { operator, adapter } = makeOperator();
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });

    const kp = await generateKeypair();
    await registerAndFund(relay, "user-solana", bytesToHex(kp.publicKey));

    const userSolanaWallet = "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UAAAA";

    const res = await relay.app.request("/api/v1/agents/user-solana/withdraw", {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ amount: 1.5, destination: userSolanaWallet }),
    });

    expect(res.status).toBe(200);
    // sendUsdc was called with the user's wallet + micro-units
    expect(adapter.sendUsdc).toHaveBeenCalledWith({
      toAddress: userSolanaWallet,
      microAmount: 1_500_000n,
    });
  });

  it("records the Solana tx signature as the withdrawal payout_reference + signed receipt", async () => {
    const { operator } = makeOperator();
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });

    const kp = await generateKeypair();
    await registerAndFund(relay, "user-solana-2", bytesToHex(kp.publicKey));

    // Valid base58 — alphabet excludes 0, O, I, l.
    const userSolanaWallet = "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UBBBB";

    const res = await relay.app.request("/api/v1/agents/user-solana-2/withdraw", {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ amount: 1.0, destination: userSolanaWallet }),
    });
    expect(res.status).toBe(200);

    const row = relay.moteDb.db
      .prepare(
        "SELECT status, payout_reference, relay_signature, completed_at FROM relay_withdrawals WHERE motebit_id = ? ORDER BY requested_at DESC LIMIT 1",
      )
      .get("user-solana-2") as
      | {
          status: string;
          payout_reference: string;
          relay_signature: string;
          completed_at: number;
        }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe("completed");
    // payout_reference is the Solana tx signature returned by the fake adapter
    expect(row!.payout_reference).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    // signed by the relay (Ed25519, base64url-encoded)
    expect(row!.relay_signature).toBeTruthy();
    expect(row!.relay_signature.length).toBeGreaterThan(0);
    expect(row!.completed_at).toBeGreaterThan(0);
  });

  it("does NOT fire when destination is EVM-shaped — falls through to Path 1/2", async () => {
    const { operator, adapter } = makeOperator();
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });

    const kp = await generateKeypair();
    await registerAndFund(relay, "user-evm", bytesToHex(kp.publicKey));

    const evmAddress = "0x1234567890123456789012345678901234567890";

    await relay.app.request("/api/v1/agents/user-evm/withdraw", {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ amount: 1.0, destination: evmAddress }),
    });

    // Path 0 did NOT fire — sendUsdc was never called
    expect(adapter.sendUsdc).not.toHaveBeenCalled();
  });

  it("does NOT fire when operator is absent — falls through to other paths", async () => {
    // No operatorSolanaTransfer injected; Path 0 cannot fire even on
    // a Solana-shaped destination. Withdrawal remains pending or
    // routes through Path 2 (Bridge) — neither happens here because
    // Bridge isn't configured in the test relay. The withdrawal stays
    // recorded but uncompleted.
    relay = await createTestRelay({ enableDeviceAuth: false });

    const kp = await generateKeypair();
    await registerAndFund(relay, "user-no-op", bytesToHex(kp.publicKey));

    const userSolanaWallet = "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UCCCC";

    const res = await relay.app.request("/api/v1/agents/user-no-op/withdraw", {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ amount: 1.0, destination: userSolanaWallet }),
    });
    expect(res.status).toBe(200);

    // Withdrawal exists but is uncompleted (no path fired)
    const row = relay.moteDb.db
      .prepare(
        "SELECT status, completed_at FROM relay_withdrawals WHERE motebit_id = ? ORDER BY requested_at DESC LIMIT 1",
      )
      .get("user-no-op") as { status: string; completed_at: number | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.status).toBe("pending");
    expect(row!.completed_at).toBeNull();
  });

  it("does NOT fire when operator reports unavailable — falls through", async () => {
    const { operator, adapter } = makeOperator({
      isReachable: vi.fn().mockResolvedValue(false),
    });
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });

    const kp = await generateKeypair();
    await registerAndFund(relay, "user-rpc-down", bytesToHex(kp.publicKey));

    const userSolanaWallet = "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5URpc";

    await relay.app.request("/api/v1/agents/user-rpc-down/withdraw", {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ amount: 1.0, destination: userSolanaWallet }),
    });

    // Path 0 checked availability and bailed; sendUsdc never invoked
    expect(adapter.sendUsdc).not.toHaveBeenCalled();
    // Withdrawal stays pending
    const row = relay.moteDb.db
      .prepare(
        "SELECT status FROM relay_withdrawals WHERE motebit_id = ? ORDER BY requested_at DESC LIMIT 1",
      )
      .get("user-rpc-down") as { status: string } | undefined;
    expect(row!.status).toBe("pending");
  });

  it("does NOT fire when adapter.sendUsdc throws — withdrawal stays pending for admin resolution", async () => {
    const { operator, adapter } = makeOperator({
      sendUsdc: vi.fn().mockRejectedValue(new Error("Solana RPC timeout")),
    });
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });

    const kp = await generateKeypair();
    await registerAndFund(relay, "user-rpc-throw", bytesToHex(kp.publicKey));

    const userSolanaWallet = "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UTHr";

    const res = await relay.app.request("/api/v1/agents/user-rpc-throw/withdraw", {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ amount: 1.0, destination: userSolanaWallet }),
    });
    expect(res.status).toBe(200);

    // sendUsdc was attempted but threw
    expect(adapter.sendUsdc).toHaveBeenCalledOnce();
    // Withdrawal stays pending — funds already held by requestWithdrawal,
    // no double-spend, admin can resolve
    const row = relay.moteDb.db
      .prepare(
        "SELECT status, completed_at FROM relay_withdrawals WHERE motebit_id = ? ORDER BY requested_at DESC LIMIT 1",
      )
      .get("user-rpc-throw") as { status: string; completed_at: number | null } | undefined;
    expect(row!.status).toBe("pending");
    expect(row!.completed_at).toBeNull();
  });
});
