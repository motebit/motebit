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

import { describe, it, expect, afterEach } from "vitest";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import type { SolanaRpcAdapter } from "@motebit/wallet-solana";

import type { SyncRelay } from "../index.js";
import { creditAccount } from "../accounts.js";
import { AUTH_HEADER, createTestRelay, jsonAuthWithIdempotency } from "./test-helpers.js";
import { freshChain, makeDurableOperator, type FakeDurableChain } from "./durable-payout-fake.js";

// === Helpers ===

/**
 * A fake-adapter-backed OperatorSolanaTransfer for injection: durable-nonce
 * payouts (#990) whose finalized outcome the test chooses.
 */
function makeOperator(
  overrides: Partial<SolanaRpcAdapter> = {},
  chain: FakeDurableChain = freshChain(),
) {
  return makeDurableOperator(chain, overrides);
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
    // A durable-nonce payout to the user's wallet in micro-units, over the
    // lane's nonce, with the hook that records it before broadcast (#990).
    expect(adapter.sendUsdcDurable).toHaveBeenCalledWith(
      { toAddress: userSolanaWallet, microAmount: 1_500_000n },
      {
        account: "NonceAccount111111111111111111111111111111",
        nonceValue: "nonce-1",
        observedSlot: 100,
      },
      expect.objectContaining({ beforeBroadcast: expect.any(Function) }),
    );
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

  it("does NOT fire when destination is EVM-shaped — the 0x withdrawal is refused before any debit (#948)", async () => {
    const { operator, adapter } = makeOperator();
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });

    const kp = await generateKeypair();
    await registerAndFund(relay, "user-evm", bytesToHex(kp.publicKey));

    const evmAddress = "0x1234567890123456789012345678901234567890";

    const res = await relay.app.request("/api/v1/agents/user-evm/withdraw", {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ amount: 1.0, destination: evmAddress }),
    });

    // Path 0 did NOT fire
    expect(adapter.sendUsdcDurable).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
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

  it("does NOT fire when the treasury's nonce lane is unavailable — stays pending (#990)", async () => {
    const { operator, adapter } = makeOperator(
      {},
      freshChain({ lane: { status: "unavailable", reason: "rpc down" } }),
    );
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });

    const kp = await generateKeypair();
    await registerAndFund(relay, "user-rpc-down", bytesToHex(kp.publicKey));

    const userSolanaWallet = "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5URpc";

    await relay.app.request("/api/v1/agents/user-rpc-down/withdraw", {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ amount: 1.0, destination: userSolanaWallet }),
    });

    // No lane, no payout: nothing was sent
    expect(adapter.sendUsdcDurable).not.toHaveBeenCalled();
    // Withdrawal stays pending
    const row = relay.moteDb.db
      .prepare(
        "SELECT status FROM relay_withdrawals WHERE motebit_id = ? ORDER BY requested_at DESC LIMIT 1",
      )
      .get("user-rpc-down") as { status: string } | undefined;
    expect(row!.status).toBe("pending");
  });

  it("a payout the bounded wait does not see finalized stays processing — never refunded on absence (#990)", async () => {
    const { operator, adapter } = makeOperator({}, freshChain({ sendOutcome: "unknown" }));
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
    expect(adapter.sendUsdcDurable).toHaveBeenCalledOnce();
    const row = relay.moteDb.db
      .prepare(
        "SELECT status, completed_at FROM relay_withdrawals WHERE motebit_id = ? ORDER BY requested_at DESC LIMIT 1",
      )
      .get("user-rpc-throw") as { status: string; completed_at: number | null } | undefined;
    expect(row!.status).toBe("processing");
    expect(row!.completed_at).toBeNull();
  });

  it("a send that throws before recording anything sent nothing — refunded at once", async () => {
    const { operator } = makeOperator({}, freshChain({ sendOutcome: "throw_before" }));
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    const kp = await generateKeypair();
    await registerAndFund(relay, "user-nothing-sent", bytesToHex(kp.publicKey));
    const res = await relay.app.request("/api/v1/agents/user-nothing-sent/withdraw", {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({
        amount: 1.0,
        destination: "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UNsn",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { withdrawal: { status: string } };
    expect(body.withdrawal.status).toBe("failed");
  });
});
