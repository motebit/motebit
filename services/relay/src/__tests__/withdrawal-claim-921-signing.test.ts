/**
 * Issue #921 round 3 — a payout stays "in flight" until its OUTCOME is
 * written, not merely until the send returns.
 *
 * Between `sendUsdc` returning and `completeWithdrawal(…, "processing")`
 * the handler awaits the receipt signature. The cold review's probe held the
 * signing, moved the clock past every window, and reconciled `not_paid` in
 * that gap: 200, refunded — and the payout had landed. The in-flight marker
 * now spans claim → settling write, so the reconcile is refused there.
 *
 * `signWithdrawalReceipt` is gated through a partial module mock; everything
 * else is the real relay.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { generateKeypair, bytesToHex } from "@motebit/encryption";

const gate: { hold: Promise<void> | null } = { hold: null };

vi.mock("../accounts.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../accounts.js")>();
  return {
    ...original,
    signWithdrawalReceipt: async (...args: Parameters<typeof original.signWithdrawalReceipt>) => {
      if (gate.hold) await gate.hold;
      return original.signWithdrawalReceipt(...args);
    },
  };
});

import type { SyncRelay } from "../index.js";
import { creditAccount, getAccountBalance, getTransactions } from "../accounts.js";
import { AUTH_HEADER, createTestRelay, jsonAuthWithIdempotency } from "./test-helpers.js";
import { freshChain, makeDurableOperator } from "./durable-payout-fake.js";

const FUNDED = 5_000_000;
const DEST = "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UAAAA";

const realNow = Date.now.bind(Date);

let relay: SyncRelay | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  gate.hold = null;
  await relay?.close();
  relay = undefined;
});

describe("#921 round 3: in flight until the outcome is written", () => {
  it("reconcile not_paid during the receipt signing (clock past every window) ⇒ 409; final completed, 0 refunds", async () => {
    let release!: () => void;
    gate.hold = new Promise<void>((r) => (release = r));
    let signingStarted = false;
    const chain = freshChain();
    const { operator, adapter } = makeDurableOperator(chain);
    const real = adapter.sendUsdcDurable.getMockImplementation()!;
    adapter.sendUsdcDurable.mockImplementation(async (...args) => {
      const out = await real(...args);
      signingStarted = true; // the handler goes on to decide and sign the receipt
      return out;
    });
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    const mid = "zz921-signing-gap";
    const kp = await generateKeypair();
    await relay.app.request(`/api/v1/agents/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({
        motebit_id: mid,
        endpoint_url: "http://localhost:9999/mcp",
        capabilities: ["web_search"],
        public_key: bytesToHex(kp.publicKey),
      }),
    });
    creditAccount(relay.moteDb.db, mid, FUNDED, "deposit", "zz921-deposit", "seed");

    const pending = Promise.resolve(
      relay.app.request(`/api/v1/agents/${mid}/withdraw`, {
        method: "POST",
        headers: jsonAuthWithIdempotency(),
        body: JSON.stringify({ amount: 1.5, destination: DEST }),
      }),
    );
    for (let i = 0; i < 500 && !signingStarted; i++) await new Promise((r) => setTimeout(r, 2));
    await new Promise((r) => setTimeout(r, 10)); // the handler is now parked in signing
    const id = (
      relay.moteDb.db
        .prepare("SELECT withdrawal_id FROM relay_withdrawals WHERE motebit_id = ?")
        .get(mid) as { withdrawal_id: string }
    ).withdrawal_id;

    // Every window long past: floor, blockhash lifetime, margin.
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 6 * 60 * 60 * 1000);
    const reconcile = await relay.app.request(`/api/v1/admin/withdrawals/${id}/reconcile`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify({ outcome: "not_paid", attestation: "explorer shows nothing yet" }),
    });
    // Refused BY the in-flight mark itself — not by a horizon, not by an error.
    expect(reconcile.status).toBe(409);
    expect(((await reconcile.json()) as { reason: string }).reason).toBe("in_flight_here");

    release();
    const res = await pending;
    expect(res.status).toBe(200);
    const status = (
      relay.moteDb.db
        .prepare("SELECT status FROM relay_withdrawals WHERE withdrawal_id = ?")
        .get(id) as { status: string }
    ).status;
    expect(status).toBe("completed");
    const refunds = getTransactions(relay.moteDb.db, mid, 100).filter(
      (t) => t.reference_id === id && t.amount > 0,
    ).length;
    expect(refunds).toBe(0);
    expect(getAccountBalance(relay.moteDb.db, mid)?.balance).toBe(FUNDED - 1_500_000);
  });
});
