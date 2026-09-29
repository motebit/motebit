/**
 * #921 differential probe — claim before send. Run with
 * scripts/differential-vs-main.ts --probe <this> --pkg services/relay.
 *
 * Cells (each records outcome-level observations, no ids):
 *   - inflight_fail_then_confirm: admin /fail while the Path 0 send is in
 *     flight, then the send confirms — the #921 interleaving. Records the
 *     admin answer, the final status, the refund count and whether the user
 *     was paid AND refunded.
 *   - inflight_complete_then_confirm: admin /complete during the send.
 *   - claim_lost: admin /fail while the handler awaits availability; how many
 *     sends happen afterwards.
 *   - dup_idempotency: two concurrent /withdraw on one Idempotency-Key.
 *   - send_throws: the send throws; status, then admin /fail's answer.
 *   - batch_unconfirmed: a batch fire the rail has not confirmed; status and
 *     admin /fail's answer.
 *   - signing_gap (round 3): the operator's refund attempt while the handler
 *     is parked in the receipt signature, clock hours on.
 *   - x402_throw_then_20m (round 3): refund attempt 20 minutes after an x402
 *     withdraw threw (its authorization is valid for an hour).
 *   - batch_manual (round 3): a manual rail's fire; admin /complete answer.
 * Surfaces used exist on both trees: /withdraw, admin /fail and /complete,
 * the injected OperatorSolanaTransfer, batch-withdrawals exports, the
 * accounts shim reads.
 */
import { it, afterAll, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { OperatorSolanaTransfer, type SolanaRpcAdapter } from "@motebit/wallet-solana";

// Round 3: hold the receipt signature (the gap between the send returning
// and the outcome's write). Present on both trees: budget.ts signs through
// ../accounts.js `signWithdrawalReceipt` on main and here.
const signingGate: { hold: Promise<void> | null } = { hold: null };
vi.mock("../accounts.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../accounts.js")>();
  return {
    ...original,
    signWithdrawalReceipt: async (...args: Parameters<typeof original.signWithdrawalReceipt>) => {
      if (signingGate.hold) await signingGate.hold;
      return original.signWithdrawalReceipt(...args);
    },
  };
});

import type { SyncRelay } from "../index.js";
import { creditAccount, getAccountBalance, getTransactions } from "../accounts.js";
import { enqueuePendingWithdrawal, evaluateAndFireRail } from "../batch-withdrawals.js";
import { AUTH_HEADER, createTestRelay, jsonAuthWithIdempotency } from "./test-helpers.js";

type SendUsdcResult = Awaited<ReturnType<SolanaRpcAdapter["sendUsdc"]>>;

const obs: Record<string, unknown> = {};
afterAll(() => {
  writeFileSync(process.env["PROBE_OUT"]!, JSON.stringify(obs, null, 2));
});

const FUNDED = 5_000_000;
const MICRO = 1_500_000;
const SIG =
  "5VfYdxYhWnD8X7K2YgHmBpDXJqJ1JmZj7rL2KkXg8sM3QfvN9P1bZw6cM5J8nT4rA7uW9eR6yU2dE1pV3hG4oS9k";
const DEST = "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UAAAA";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
async function until(cond: () => boolean): Promise<boolean> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 2));
  }
  return false;
}

function operatorWith(
  sendUsdc: SolanaRpcAdapter["sendUsdc"],
  isReachable: SolanaRpcAdapter["isReachable"] = () => Promise.resolve(true),
): OperatorSolanaTransfer {
  // Honours the #885 broadcast hooks (the real adapter does): a tree whose
  // Path 0 records each signature before broadcast (#949) sees one; a tree
  // that passes no hooks is unaffected. The chain never decides here.
  return new OperatorSolanaTransfer({
    honorsBroadcastHooks: true,
    // The fresh verdict (#949 round 5): nothing decided yet.
    getFreshSignatureVerdict: () => Promise.resolve({ status: "too_early" as const }),
    ownAddress: "RelayTreasuryAddressBase58",
    getUsdcBalance: vi.fn().mockResolvedValue(10_000_000_000n),
    getUsdcBalanceOf: vi.fn().mockResolvedValue(10_000_000_000n),
    getSolBalance: vi.fn().mockResolvedValue(10_000_000n),
    sendUsdc: async (args, hooks) => {
      await hooks?.beforeBroadcast?.({ signature: SIG, lastValidBlockHeight: 1_000 });
      return sendUsdc(args, hooks);
    },
    sendUsdcBatch: vi.fn().mockResolvedValue([]),
    getTransaction: vi.fn().mockResolvedValue({ status: "not_found" }),
    getSignatureOutcome: () => Promise.resolve({ status: "pending" }),
    isReachable,
  });
}

async function fund(relay: SyncRelay, mid: string): Promise<void> {
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
  creditAccount(relay.moteDb.db, mid, FUNDED, "deposit", "zz921-probe-dep", "seed");
}

function withdraw(relay: SyncRelay, mid: string, headers = jsonAuthWithIdempotency(), dest = DEST) {
  return Promise.resolve(
    relay.app.request(`/api/v1/agents/${mid}/withdraw`, {
      method: "POST",
      headers,
      body: JSON.stringify({ amount: MICRO / 1_000_000, destination: dest }),
    }),
  );
}

function adminCall(relay: SyncRelay, id: string, verb: string, body: Record<string, unknown>) {
  return Promise.resolve(
    relay.app.request(`/api/v1/admin/withdrawals/${id}/${verb}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(body),
    }),
  );
}

function withdrawalIds(relay: SyncRelay, mid: string): string[] {
  return (
    relay.moteDb.db
      .prepare("SELECT withdrawal_id FROM relay_withdrawals WHERE motebit_id = ?")
      .all(mid) as Array<{ withdrawal_id: string }>
  ).map((r) => r.withdrawal_id);
}

function outcome(relay: SyncRelay, mid: string, id: string, paidOnChain: boolean) {
  const status = (
    relay.moteDb.db
      .prepare("SELECT status FROM relay_withdrawals WHERE withdrawal_id = ?")
      .get(id) as { status: string } | undefined
  )?.status;
  const refunds = getTransactions(relay.moteDb.db, mid, 100).filter(
    (t) => t.reference_id === id && t.amount > 0,
  ).length;
  const balanceDelta = (getAccountBalance(relay.moteDb.db, mid)?.balance ?? 0) - FUNDED;
  return {
    status,
    refunds,
    balanceDelta,
    paid_and_refunded: paidOnChain && refunds > 0,
  };
}

it("zz921 probe", async () => {
  // ── inflight_fail_then_confirm / inflight_complete_then_confirm ──
  for (const verb of ["fail", "complete"] as const) {
    const send = deferred<SendUsdcResult>();
    const sendUsdc = vi.fn().mockReturnValue(send.promise);
    const relay = await createTestRelay({
      enableDeviceAuth: false,
      operatorSolanaTransfer: operatorWith(sendUsdc),
    });
    const mid = `zz921-probe-inflight-${verb}`;
    await fund(relay, mid);
    const pending = withdraw(relay, mid);
    await until(() => sendUsdc.mock.calls.length === 1);
    const [id] = withdrawalIds(relay, mid);
    const adminRes = await adminCall(
      relay,
      id!,
      verb,
      verb === "fail" ? { reason: "operator" } : { payout_reference: "manual-wire" },
    );
    send.resolve({ signature: SIG, slot: 1, confirmed: true });
    const res = (await (await pending).json()) as { withdrawal: { status: string } };
    obs[`inflight_${verb}_then_confirm`] = {
      admin_status: adminRes.status,
      response_status: res.withdrawal.status,
      ...outcome(relay, mid, id!, true),
    };
    await relay.close();
  }

  // ── claim_lost ──
  {
    const reachable = deferred<boolean>();
    const isReachable = vi.fn().mockReturnValue(reachable.promise);
    const sendUsdc = vi.fn().mockResolvedValue({ signature: SIG, slot: 1, confirmed: true });
    const relay = await createTestRelay({
      enableDeviceAuth: false,
      operatorSolanaTransfer: operatorWith(sendUsdc, isReachable),
    });
    const mid = "zz921-probe-claim-lost";
    await fund(relay, mid);
    const pending = withdraw(relay, mid);
    await until(() => isReachable.mock.calls.length === 1);
    const [id] = withdrawalIds(relay, mid);
    const adminRes = await adminCall(relay, id!, "fail", { reason: "operator" });
    reachable.resolve(true);
    const res = (await (await pending).json()) as { withdrawal: { status: string } };
    const sends = sendUsdc.mock.calls.length;
    obs["claim_lost"] = {
      admin_status: adminRes.status,
      sends,
      response_status: res.withdrawal.status,
      ...outcome(relay, mid, id!, sends > 0),
    };
    await relay.close();
  }

  // ── dup_idempotency ──
  {
    const send = deferred<SendUsdcResult>();
    const sendUsdc = vi.fn().mockReturnValue(send.promise);
    const relay = await createTestRelay({
      enableDeviceAuth: false,
      operatorSolanaTransfer: operatorWith(sendUsdc),
    });
    const mid = "zz921-probe-dup";
    await fund(relay, mid);
    const headers = jsonAuthWithIdempotency();
    const a = withdraw(relay, mid, headers);
    const b = withdraw(relay, mid, headers);
    await until(() => sendUsdc.mock.calls.length >= 1);
    send.resolve({ signature: SIG, slot: 1, confirmed: true });
    const statuses = (await Promise.all([a, b])).map((r) => r.status).sort();
    obs["dup_idempotency"] = {
      http: statuses,
      sends: sendUsdc.mock.calls.length,
      withdrawals: withdrawalIds(relay, mid).length,
    };
    await relay.close();
  }

  // ── send_throws ──
  {
    const relay = await createTestRelay({
      enableDeviceAuth: false,
      operatorSolanaTransfer: operatorWith(vi.fn().mockRejectedValue(new Error("hang up"))),
    });
    const mid = "zz921-probe-throws";
    await fund(relay, mid);
    const res = (await (await withdraw(relay, mid)).json()) as { withdrawal: { status: string } };
    const [id] = withdrawalIds(relay, mid);
    const adminRes = await adminCall(relay, id!, "fail", { reason: "operator" });
    obs["send_throws"] = {
      response_status: res.withdrawal.status,
      admin_fail_status: adminRes.status,
      // Unknown on-chain outcome: "paid_and_refunded" is the exposure if it landed.
      ...outcome(relay, mid, id!, true),
    };
    await relay.close();
  }

  // ── batch_unconfirmed ──
  {
    const relay = await createTestRelay({ enableDeviceAuth: false });
    const mid = "zz921-probe-batch";
    await fund(relay, mid);
    enqueuePendingWithdrawal(relay.moteDb.db, {
      motebitId: mid,
      amountMicro: MICRO,
      destination: "0x1234567890abcdef1234567890abcdef12345678",
      rail: "zz921-probe-rail",
      source: "user",
    });
    const rail = {
      name: "zz921-probe-rail",
      railType: "protocol",
      custody: "relay",
      supportsDeposit: false,
      supportsWithdraw: true,
      supportsBatch: false,
      isAvailable: () => Promise.resolve(true),
      attachProof: () => Promise.resolve(),
      withdraw: () =>
        Promise.resolve({
          amount: MICRO / 1_000_000,
          currency: "USDC",
          proof: { reference: "async-ref", railType: "protocol", confirmedAt: 0 },
        }),
    };
    await evaluateAndFireRail(
      relay.moteDb.db,
      rail as unknown as Parameters<typeof evaluateAndFireRail>[1],
      {
        policy: { minAggregateMicro: 0, feeJustificationMultiplier: 1, maxAgeMs: 0 },
      } as unknown as Parameters<typeof evaluateAndFireRail>[2],
    );
    const [id] = withdrawalIds(relay, mid);
    const before = outcome(relay, mid, id!, true);
    const adminRes = await adminCall(relay, id!, "fail", { reason: "operator" });
    obs["batch_unconfirmed"] = {
      status_after_fire: before.status,
      admin_fail_status: adminRes.status,
      ...outcome(relay, mid, id!, true),
    };
    await relay.close();
  }

  // ── signing_gap (round 3) ──
  // The send confirmed; the handler is parked in the receipt signature; the
  // clock is hours on. The operator tries to refund: /reconcile on this tree,
  // /fail on main (main has no reconcile). Paid AND refunded is the defect.
  {
    let release!: () => void;
    signingGate.hold = new Promise<void>((r) => (release = r));
    let sent = false;
    const sendUsdc = vi.fn().mockImplementation(() => {
      sent = true;
      return Promise.resolve({ signature: SIG, slot: 1, confirmed: true });
    });
    const relay = await createTestRelay({
      enableDeviceAuth: false,
      operatorSolanaTransfer: operatorWith(sendUsdc),
    });
    const mid = "zz921-probe-signing";
    await fund(relay, mid);
    const pending = withdraw(relay, mid);
    await until(() => sent);
    await new Promise((r) => setTimeout(r, 10));
    const [id] = withdrawalIds(relay, mid);
    const realNow = Date.now.bind(Date);
    const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 6 * 60 * 60 * 1000);
    const rec = await adminCall(relay, id!, "reconcile", {
      outcome: "not_paid",
      attestation: "nothing seen",
    });
    const fail = rec.status === 404 ? await adminCall(relay, id!, "fail", { reason: "x" }) : null;
    release();
    await pending;
    spy.mockRestore();
    signingGate.hold = null;
    obs["signing_gap"] = {
      refund_attempt_status: fail ? fail.status : rec.status,
      ...outcome(relay, mid, id!, true),
    };
    await relay.close();
  }

  // ── x402_throw_then_20m (round 3) ──
  // The x402 withdraw threw after the facilitator may have accepted the
  // authorization (valid 1h). 20 minutes later the operator tries to refund.
  {
    const { X402SettlementRail } = await import("@motebit/settlement-rails");
    const avail = vi.spyOn(X402SettlementRail.prototype, "isAvailable").mockResolvedValue(true);
    // #948 removed the x402 withdraw: spy on it only on a tree that has it.
    const proto = X402SettlementRail.prototype as unknown as {
      withdraw?: (...a: unknown[]) => Promise<unknown>;
    };
    const wd =
      typeof proto.withdraw === "function"
        ? vi
            .spyOn(proto as { withdraw: (...a: unknown[]) => Promise<unknown> }, "withdraw")
            .mockRejectedValue(new Error("facilitator timeout"))
        : null;
    const relay = await createTestRelay({ enableDeviceAuth: false });
    const mid = "zz921-probe-x402";
    await fund(relay, mid);
    const res = await withdraw(
      relay,
      mid,
      jsonAuthWithIdempotency(),
      "0x1234567890abcdef1234567890abcdef12345678",
    );
    const [id] = withdrawalIds(relay, mid);
    if (id === undefined) {
      // #948: refused before any debit.
      obs["x402_throw_then_20m"] = {
        withdraw_status: res.status,
        balance: getAccountBalance(relay.moteDb.db, mid)?.balance ?? 0,
      };
    } else {
      const realNow = Date.now.bind(Date);
      const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 20 * 60 * 1000);
      const rec = await adminCall(relay, id, "reconcile", {
        outcome: "not_paid",
        attestation: "nothing seen",
      });
      const fail = rec.status === 404 ? await adminCall(relay, id, "fail", { reason: "x" }) : null;
      spy.mockRestore();
      obs["x402_throw_then_20m"] = {
        refund_attempt_status: fail ? fail.status : rec.status,
        // The authorization may still be submitted for ~40 more minutes.
        ...outcome(relay, mid, id, true),
      };
    }
    avail.mockRestore();
    wd?.mockRestore();
    await relay.close();
  }

  // ── batch_manual (round 3) — main parity expected ──
  {
    const relay = await createTestRelay({ enableDeviceAuth: false });
    const mid = "zz921-probe-manual";
    await fund(relay, mid);
    enqueuePendingWithdrawal(relay.moteDb.db, {
      motebitId: mid,
      amountMicro: MICRO,
      destination: "0x1234567890abcdef1234567890abcdef12345678",
      rail: "zz921-probe-manual-rail",
      source: "user",
    });
    const rail = {
      name: "zz921-probe-manual-rail",
      railType: "fiat",
      custody: "relay",
      supportsDeposit: false,
      supportsWithdraw: true,
      supportsBatch: false,
      payoutMode: "manual",
      isAvailable: () => Promise.resolve(true),
      attachProof: () => Promise.resolve(),
      withdraw: () =>
        Promise.resolve({
          amount: MICRO / 1_000_000,
          currency: "USDC",
          proof: { reference: "pending:x", railType: "fiat", confirmedAt: 0 },
        }),
    };
    await evaluateAndFireRail(
      relay.moteDb.db,
      rail as unknown as Parameters<typeof evaluateAndFireRail>[1],
      {
        policy: { minAggregateMicro: 0, feeJustificationMultiplier: 1, maxAgeMs: 0 },
      } as unknown as Parameters<typeof evaluateAndFireRail>[2],
    );
    const [id] = withdrawalIds(relay, mid);
    const status = (
      relay.moteDb.db
        .prepare("SELECT status FROM relay_withdrawals WHERE withdrawal_id = ?")
        .get(id) as { status: string } | undefined
    )?.status;
    const done = await adminCall(relay, id!, "complete", { payout_reference: "stripe-po" });
    obs["batch_manual"] = { status_after_fire: status, admin_complete_status: done.status };
    await relay.close();
  }
}, 120_000);
