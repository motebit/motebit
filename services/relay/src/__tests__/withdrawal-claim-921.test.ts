/**
 * Issue #921 — claim before send.
 *
 * Before #921, Path 0 sent USDC without claiming the withdrawal: an operator's
 * admin `/fail` during the in-flight send refunded it, the send then
 * confirmed, and the user was paid AND refunded while the row read `failed`.
 *
 * The rule (spec/market-v1.md §10.3/§10.4, budget.ts):
 *
 *   - no payout is sent until the handler CLAIMS the withdrawal — the
 *     compare-and-set `pending → processing`; a lost claim sends nothing;
 *   - the send's outcome settles the withdrawal FROM `processing` only, and a
 *     settling write that loses is logged at error level, never silently;
 *   - the operator's manual `/complete` and `/fail` refuse a `processing`
 *     withdrawal (409 "payout in flight");
 *   - a `processing` withdrawal whose outcome is unknown (the send threw, the
 *     process died mid-send) is settled only through `/reconcile`: never while
 *     the send is in flight here, never within RECONCILE_MIN_AGE_MS of the
 *     claim, and only on an explicit operator attestation.
 *
 * Every test names the invariant it pins; the tampers that turn each red are
 * listed in the #921 report.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import {
  OperatorSolanaTransfer,
  type SignatureOutcome,
  type SolanaRpcAdapter,
} from "@motebit/wallet-solana";
import {
  X402SettlementRail,
  StripeSettlementRail,
  isManualPayoutRail,
  payoutValidityMsOf,
} from "@motebit/settlement-rails";
import { isWithdrawableRail } from "@motebit/protocol";
import { createMotebitDatabase } from "@motebit/persistence";
import { requestWithdrawal } from "@motebit/virtual-accounts";

import type { SyncRelay } from "../index.js";
import { creditAccount, getAccountBalance, getTransactions } from "../accounts.js";
import {
  RECONCILE_MIN_AGE_MS,
  PAYOUT_HORIZON_MARGIN_MS,
  UNDECLARED_PAYOUT_HORIZON_MS,
  reconcileOpensAt,
  payoutMayHaveBeenAttempted,
} from "../budget.js";
import {
  SqliteAccountStore,
  createAccountTables,
  createWithdrawalTables,
} from "../account-store-sqlite.js";
import { evaluateAndFireRail, enqueuePendingWithdrawal } from "../batch-withdrawals.js";
import { LEGACY_BROADCAST_HEIGHT_BOUND } from "../withdrawal-chain-payouts.js";
import { AUTH_HEADER, createTestRelay, jsonAuthWithIdempotency } from "./test-helpers.js";

const TX_SIG =
  "5VfYdxYhWnD8X7K2YgHmBpDXJqJ1JmZj7rL2KkXg8sM3QfvN9P1bZw6cM5J8nT4rA7uW9eR6yU2dE1pV3hG4oS9k";
const FUNDED = 5_000_000;
const WITHDRAW_USD = 1.5;
const WITHDRAW_MICRO = 1_500_000;
const DEST = "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UAAAA";
const EVM_DEST = "0x1234567890abcdef1234567890abcdef12345678";

type SendUsdcResult = Awaited<ReturnType<SolanaRpcAdapter["sendUsdc"]>>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("zz921: condition never became true");
}

/**
 * What the chain says about the payout's recorded transaction (#949): the
 * reconcile door for a Path 0 payout asks the chain, never the clock. A
 * test sets `chain.outcome` to decide it.
 */
const chain: { outcome: SignatureOutcome; height: number; firstAvailableSlot: number } = {
  outcome: { status: "pending" },
  height: 50_000,
  firstAvailableSlot: 0,
};

/**
 * An operator transfer over an adapter that honours the #885 contract: the
 * relay's `beforeBroadcast` records the transaction before the (mocked)
 * send runs, as the real adapter does for every transaction it signs.
 */
function makeOperator(
  sendUsdc: SolanaRpcAdapter["sendUsdc"],
  isReachable: SolanaRpcAdapter["isReachable"] = vi.fn().mockResolvedValue(true),
): { operator: OperatorSolanaTransfer; adapter: SolanaRpcAdapter } {
  const adapter: SolanaRpcAdapter = {
    honorsBroadcastHooks: true,
    ownAddress: "RelayTreasuryAddressBase58",
    getUsdcBalance: vi.fn().mockResolvedValue(10_000_000_000n),
    getUsdcBalanceOf: vi.fn().mockResolvedValue(10_000_000_000n),
    getSolBalance: vi.fn().mockResolvedValue(10_000_000n),
    sendUsdc: async (args, hooks) => {
      await hooks?.beforeBroadcast?.({
        signature: TX_SIG,
        lastValidBlockHeight: chain.height + 150,
        recentSlot: 1_000_000,
      });
      return sendUsdc(args, hooks);
    },
    sendUsdcBatch: vi.fn().mockResolvedValue([]),
    getTransaction: vi.fn().mockResolvedValue({ status: "not_found" }),
    getSignatureOutcome: () => Promise.resolve(chain.outcome),
    getBlockHeight: () => Promise.resolve(chain.height),
    // The node holds all history unless a test prunes it (#949 round 2).
    getLocalLedgerFirstSlot: () => Promise.resolve(chain.firstAvailableSlot),
    isReachable,
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
  creditAccount(relay.moteDb.db, motebitId, FUNDED, "deposit", "zz921-deposit", "self-deposit");
}

type WithdrawBody = {
  withdrawal: {
    withdrawal_id: string;
    status: string;
    failure_reason: string | null;
    relay_signature: string | null;
  };
  idempotent?: boolean;
};

function startWithdraw(
  relay: SyncRelay,
  motebitId: string,
  opts: { headers?: Record<string, string>; destination?: string; bodyKey?: string } = {},
): Promise<Response> {
  return Promise.resolve(
    relay.app.request(`/api/v1/agents/${motebitId}/withdraw`, {
      method: "POST",
      headers: opts.headers ?? jsonAuthWithIdempotency(),
      body: JSON.stringify({
        amount: WITHDRAW_USD,
        destination: opts.destination ?? DEST,
        ...(opts.bodyKey ? { idempotency_key: opts.bodyKey } : {}),
      }),
    }),
  );
}

function admin(
  relay: SyncRelay,
  withdrawalId: string,
  verb: "fail" | "complete" | "reconcile",
  body: Record<string, unknown>,
): Promise<Response> {
  return Promise.resolve(
    relay.app.request(`/api/v1/admin/withdrawals/${withdrawalId}/${verb}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADER },
      body: JSON.stringify(body),
    }),
  );
}

function onlyWithdrawalId(relay: SyncRelay, motebitId: string): string {
  const rows = relay.moteDb.db
    .prepare("SELECT withdrawal_id FROM relay_withdrawals WHERE motebit_id = ?")
    .all(motebitId) as Array<{ withdrawal_id: string }>;
  expect(rows).toHaveLength(1);
  return rows[0]!.withdrawal_id;
}

function row(relay: SyncRelay, id: string) {
  return relay.moteDb.db
    .prepare(
      "SELECT status, relay_signature, payout_reference, failure_reason, claimed_at FROM relay_withdrawals WHERE withdrawal_id = ?",
    )
    .get(id) as {
    status: string;
    relay_signature: string | null;
    payout_reference: string | null;
    failure_reason: string | null;
    claimed_at: number | null;
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

/**
 * Move the relay's clock forward (Date.now) by `ms` from here on. The
 * reconcile door reads the payout's horizon against the clock, so a test
 * jumps the clock instead of rewriting rows.
 */
const realNow = Date.now.bind(Date);
let clockOffset = 0;
function jumpClock(ms: number): void {
  clockOffset += ms;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
}
/**
 * The chain has decided the payout's recorded transaction (#949) — by
 * default it can never land (past its last valid block height). Also jumps
 * the clock, which alone never opens a Solana reconcile.
 */
function pastSolanaHorizon(outcome: SignatureOutcome = { status: "expired" }): void {
  jumpClock(2 * 60 * 60 * 1000);
  chain.outcome = outcome;
}

/** Error-level log lines (the relay logger writes `error` to stderr). */
function captureErrors(): { lines: () => string[]; restore: () => void } {
  const seen: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    seen.push(String(chunk));
    return true;
  });
  return { lines: () => seen, restore: () => spy.mockRestore() };
}

/**
 * Exactly one of {payout recorded completed, refund} — never both, never
 * neither once the send resolved.
 */
function expectExactlyOneOutcome(relay: SyncRelay, mid: string, id: string): void {
  const r = row(relay, id);
  const refunds = refundCount(relay, mid, id);
  const paid = r.status === "completed";
  expect(Number(paid) + refunds, `status=${r.status} refunds=${refunds}`).toBe(1);
  expect(balance(relay, mid)).toBe(paid ? FUNDED - WITHDRAW_MICRO : FUNDED);
}

let relay: SyncRelay | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  clockOffset = 0;
  chain.outcome = { status: "pending" };
  chain.height = 50_000;
  chain.firstAvailableSlot = 0;
  await relay?.close();
  relay = undefined;
});

describe("#921 admin during the in-flight send", () => {
  it("admin /fail, /complete and /reconcile during the send are refused; the send confirms ⇒ completed, never refunded", async () => {
    const send = deferred<SendUsdcResult>();
    const sendUsdc = vi.fn().mockReturnValue(send.promise);
    const { operator } = makeOperator(sendUsdc);
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    const mid = "zz921-inflight-confirm";
    await registerAndFund(relay, mid);

    const pending = startWithdraw(relay, mid);
    await until(() => sendUsdc.mock.calls.length === 1);
    const id = onlyWithdrawalId(relay, mid);
    // Claimed BEFORE the send.
    expect(row(relay, id).status).toBe("processing");
    expect(row(relay, id).claimed_at).toBeGreaterThan(0);

    const fail = await admin(relay, id, "fail", { reason: "operator gave up" });
    expect(fail.status).toBe(409);
    expect(((await fail.json()) as { message: string }).message).toMatch(/payout in flight/);
    const complete = await admin(relay, id, "complete", { payout_reference: "manual-wire" });
    expect(complete.status).toBe(409);
    // Even past the age window, a send still awaited in this process is refused.
    pastSolanaHorizon();
    const reconcile = await admin(relay, id, "reconcile", {
      outcome: "not_paid",
      attestation: "explorer shows nothing",
    });
    expect(reconcile.status).toBe(409);
    expect(balance(relay, mid)).toBe(FUNDED - WITHDRAW_MICRO);

    send.resolve({ signature: TX_SIG, slot: 1, confirmed: true });
    const res = await pending;
    expect(res.status).toBe(200);
    const body = (await res.json()) as WithdrawBody;
    expect(body.withdrawal.status).toBe("completed");
    expect(body.withdrawal.relay_signature).toBeTruthy();
    expect(row(relay, id).payout_reference).toBe(TX_SIG);
    expectExactlyOneOutcome(relay, mid, id);
    expect(refundCount(relay, mid, id)).toBe(0);
  });

  it("admin /fail during the send, then a proven landed failure ⇒ refunded exactly once", async () => {
    const send = deferred<SendUsdcResult>();
    const sendUsdc = vi.fn().mockReturnValue(send.promise);
    const { operator } = makeOperator(sendUsdc);
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    const mid = "zz921-inflight-fail";
    await registerAndFund(relay, mid);

    const pending = startWithdraw(relay, mid);
    await until(() => sendUsdc.mock.calls.length === 1);
    const id = onlyWithdrawalId(relay, mid);
    expect((await admin(relay, id, "fail", { reason: "operator" })).status).toBe(409);

    send.resolve({ signature: TX_SIG, slot: 1, confirmed: false, earlierBroadcastsDead: true });
    const body = (await (await pending).json()) as WithdrawBody;
    expect(body.withdrawal.status).toBe("failed");
    expectExactlyOneOutcome(relay, mid, id);
    expect(refundCount(relay, mid, id)).toBe(1);
  });

  it("a settling write that loses after the send (row moved by another actor) is logged at error level, never silent", async () => {
    const send = deferred<SendUsdcResult>();
    const sendUsdc = vi.fn().mockReturnValue(send.promise);
    const { operator } = makeOperator(sendUsdc);
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    const mid = "zz921-settle-lost";
    await registerAndFund(relay, mid);

    const pending = startWithdraw(relay, mid);
    await until(() => sendUsdc.mock.calls.length === 1);
    const id = onlyWithdrawalId(relay, mid);
    // Another actor (a second process, a hand edit) moved the row while the
    // send was out. Only the handler's reaction is under test here.
    relay.moteDb.db
      .prepare("UPDATE relay_withdrawals SET status = 'failed' WHERE withdrawal_id = ?")
      .run(id);

    const errors = captureErrors();
    try {
      send.resolve({ signature: TX_SIG, slot: 1, confirmed: true });
      const body = (await (await pending).json()) as WithdrawBody;
      // The response reports the row as it stands — not a false `completed`.
      expect(body.withdrawal.status).toBe("failed");
    } finally {
      errors.restore();
    }
    const lost = errors.lines().filter((l) => l.includes('"withdrawal.payout_settle_lost"'));
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain(id);
    expect(lost[0]).toContain(TX_SIG);
    expect(lost[0]).toContain('"level":"error"');
    // No receipt signed onto a row the payout did not settle.
    expect(row(relay, id).relay_signature).toBeNull();
  });
});

describe("#921 claim before send", () => {
  it("admin /fail wins while the handler awaits availability ⇒ the claim is lost and NOTHING is sent", async () => {
    const reachable = deferred<boolean>();
    const isReachable = vi.fn().mockReturnValue(reachable.promise);
    const sendUsdc = vi.fn().mockResolvedValue({ signature: TX_SIG, slot: 1, confirmed: true });
    const { operator } = makeOperator(sendUsdc, isReachable);
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    const mid = "zz921-claim-lost";
    await registerAndFund(relay, mid);

    const pending = startWithdraw(relay, mid);
    await until(() => isReachable.mock.calls.length === 1);
    const id = onlyWithdrawalId(relay, mid);
    expect(row(relay, id).status).toBe("pending");
    // Unclaimed: the manual fail is allowed, and refunds.
    const fail = await admin(relay, id, "fail", { reason: "operator cancelled" });
    expect(fail.status).toBe(200);

    const errors = captureErrors();
    try {
      reachable.resolve(true);
      const body = (await (await pending).json()) as WithdrawBody;
      expect(body.withdrawal.status).toBe("failed");
    } finally {
      errors.restore();
    }
    expect(sendUsdc, "a lost claim sends nothing").not.toHaveBeenCalled();
    expect(errors.lines().some((l) => l.includes('"withdrawal.payout_claim_lost"'))).toBe(true);
    expectExactlyOneOutcome(relay, mid, id);
  });

  it("concurrent duplicate /withdraw on one Idempotency-Key ⇒ one withdrawal, one send", async () => {
    const send = deferred<SendUsdcResult>();
    const sendUsdc = vi.fn().mockReturnValue(send.promise);
    const { operator } = makeOperator(sendUsdc);
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    const mid = "zz921-dup-header";
    await registerAndFund(relay, mid);

    const headers = jsonAuthWithIdempotency();
    const a = startWithdraw(relay, mid, { headers });
    const b = startWithdraw(relay, mid, { headers });
    await until(() => sendUsdc.mock.calls.length === 1);
    send.resolve({ signature: TX_SIG, slot: 1, confirmed: true });
    const [ra, rb] = await Promise.all([a, b]);
    expect([ra.status, rb.status].sort()).toContain(200);
    expect(sendUsdc).toHaveBeenCalledTimes(1);
    const id = onlyWithdrawalId(relay, mid);
    expect(row(relay, id).status).toBe("completed");
    expect(balance(relay, mid)).toBe(FUNDED - WITHDRAW_MICRO);
  });

  it("concurrent duplicates sharing a body idempotency_key under different headers ⇒ one send", async () => {
    const send = deferred<SendUsdcResult>();
    const sendUsdc = vi.fn().mockReturnValue(send.promise);
    const { operator } = makeOperator(sendUsdc);
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    const mid = "zz921-dup-body";
    await registerAndFund(relay, mid);

    const a = startWithdraw(relay, mid, { bodyKey: "zz921-body-key" });
    await until(() => sendUsdc.mock.calls.length === 1);
    const b = await startWithdraw(relay, mid, { bodyKey: "zz921-body-key" });
    const bBody = (await b.json()) as WithdrawBody;
    expect(bBody.idempotent).toBe(true);
    // The duplicate sees the claimed payout honestly, and sends nothing.
    expect(bBody.withdrawal.status).toBe("processing");
    send.resolve({ signature: TX_SIG, slot: 1, confirmed: true });
    await a;
    expect(sendUsdc).toHaveBeenCalledTimes(1);
    expect(balance(relay, mid)).toBe(FUNDED - WITHDRAW_MICRO);
  });
});

describe("#921 crash mid-send: processing, resolvable only through /reconcile", () => {
  async function thrownSend(mid: string): Promise<string> {
    const { operator } = makeOperator(
      vi.fn().mockRejectedValue(new Error("socket hang up after broadcast")),
    );
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    await registerAndFund(relay, mid);
    const body = (await (await startWithdraw(relay, mid)).json()) as WithdrawBody;
    expect(body.withdrawal.status).toBe("processing");
    expect(body.withdrawal.failure_reason).toMatch(/unresolved payout: solana send threw/);
    return body.withdrawal.withdrawal_id;
  }

  it("manual /fail and /complete refuse it; /reconcile refuses inside the window and without an attestation", async () => {
    const mid = "zz921-crash-doors";
    const id = await thrownSend(mid);

    expect((await admin(relay!, id, "fail", { reason: "x" })).status).toBe(409);
    expect((await admin(relay!, id, "complete", { payout_reference: "y" })).status).toBe(409);
    // Inside the window: the send could be in flight elsewhere.
    expect(
      (await admin(relay!, id, "reconcile", { outcome: "not_paid", attestation: "nothing" }))
        .status,
    ).toBe(409);
    pastSolanaHorizon();
    // Never a blind refund.
    expect((await admin(relay!, id, "reconcile", { outcome: "not_paid" })).status).toBe(400);
    expect(
      (await admin(relay!, id, "reconcile", { outcome: "maybe", attestation: "x" })).status,
    ).toBe(400);
    expect(
      (await admin(relay!, id, "reconcile", { outcome: "paid", attestation: "x" })).status,
    ).toBe(400);
    expect(row(relay!, id).status).toBe("processing");
    expect(balance(relay!, mid)).toBe(FUNDED - WITHDRAW_MICRO);
  });

  it("reconcile not_paid (attested, after the window) ⇒ failed and refunded exactly once", async () => {
    const mid = "zz921-crash-notpaid";
    const id = await thrownSend(mid);
    pastSolanaHorizon();
    const res = await admin(relay!, id, "reconcile", {
      outcome: "not_paid",
      attestation: "treasury history has no transfer to the destination since the claim",
    });
    expect(res.status).toBe(200);
    expect(row(relay!, id).status).toBe("failed");
    expect(row(relay!, id).failure_reason).toContain("operator attestation");
    // A repeat is refused and refunds nothing.
    expect(
      (await admin(relay!, id, "reconcile", { outcome: "not_paid", attestation: "again" })).status,
    ).toBe(409);
    expectExactlyOneOutcome(relay!, mid, id);
  });

  it("reconcile paid (attested, after the window) ⇒ completed and signed, never refunded", async () => {
    const mid = "zz921-crash-paid";
    const id = await thrownSend(mid);
    pastSolanaHorizon({ status: "landed", slot: 42 });
    const res = await admin(relay!, id, "reconcile", {
      outcome: "paid",
      payout_reference: TX_SIG,
      attestation: "explorer shows the transfer at slot 42",
    });
    expect(res.status).toBe(200);
    const r = row(relay!, id);
    expect(r.status).toBe("completed");
    expect(r.payout_reference).toBe(TX_SIG);
    expect(r.relay_signature).toBeTruthy();
    expect(
      (await admin(relay!, id, "reconcile", { outcome: "not_paid", attestation: "x" })).status,
    ).toBe(409);
    expect((await admin(relay!, id, "fail", { reason: "late" })).status).toBe(404);
    expectExactlyOneOutcome(relay!, mid, id);
  });

  it("reconcile refuses a pending (unclaimed) withdrawal — that is /complete or /fail's", async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const mid = "zz921-reconcile-pending";
    await registerAndFund(relay, mid);
    const body = (await (
      await startWithdraw(relay, mid, { destination: "pending" })
    ).json()) as WithdrawBody;
    expect(body.withdrawal.status).toBe("pending");
    const res = await admin(relay, body.withdrawal.withdrawal_id, "reconcile", {
      outcome: "not_paid",
      attestation: "x",
    });
    expect(res.status).toBe(409);
    expect(
      (await admin(relay, body.withdrawal.withdrawal_id, "fail", { reason: "ok" })).status,
    ).toBe(200);
  });
});

describe("#948 Path 1 (x402) is not offered: a 0x withdrawal is refused before any debit", () => {
  it("refuses a 0x destination 400 with no debit, no withdrawal row, and never touches the x402 rail; a replay answers the same", async () => {
    const available = vi.spyOn(X402SettlementRail.prototype, "isAvailable").mockResolvedValue(true);
    relay = await createTestRelay({ enableDeviceAuth: false });
    const mid = "zz948-evm";
    await registerAndFund(relay, mid);
    const headers = jsonAuthWithIdempotency();
    const first = await startWithdraw(relay, mid, { destination: EVM_DEST, headers });
    expect(first.status).toBe(400);
    const body = (await first.json()) as { error: string; message: string };
    expect(body.error).toBe("WITHDRAWAL_DESTINATION_UNSUPPORTED");
    expect(body.message).toMatch(/Solana/);
    expect(balance(relay, mid)).toBe(FUNDED);
    expect(
      relay.moteDb.db
        .prepare("SELECT COUNT(*) AS n FROM relay_withdrawals WHERE motebit_id = ?")
        .get(mid),
    ).toEqual({ n: 0 });
    expect(available).not.toHaveBeenCalled();
    // A replay of the same request is answered from the idempotency record.
    const replay = await startWithdraw(relay, mid, { destination: EVM_DEST, headers });
    expect(replay.status).toBe(400);
    expect(balance(relay, mid)).toBe(FUNDED);
  });

  it("the x402 rail is not a withdrawable rail", () => {
    const x402 = new X402SettlementRail({
      facilitatorClient: {} as ConstructorParameters<
        typeof X402SettlementRail
      >[0]["facilitatorClient"],
      network: "eip155:84532",
      payToAddress: "0x0000000000000000000000000000000000000000",
    });
    expect(isWithdrawableRail(x402)).toBe(false);
  });
});

describe("#921 batch withdrawals: a fired, unconfirmed payout is processing", () => {
  it("records an unconfirmed fired payout as processing; admin /fail refuses it", async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const db = relay.moteDb.db;
    const mid = "zz921-batch";
    await registerAndFund(relay, mid);
    const pendingId = enqueuePendingWithdrawal(db, {
      motebitId: mid,
      amountMicro: WITHDRAW_MICRO,
      destination: EVM_DEST,
      rail: "zz921-rail",
      source: "user",
    });
    expect(pendingId).not.toBeNull();

    const rail = {
      name: "zz921-rail",
      railType: "protocol" as const,
      custody: "relay" as const,
      supportsDeposit: false as const,
      supportsWithdraw: true as const,
      supportsBatch: false,
      isAvailable: () => Promise.resolve(true),
      deposit: () => Promise.reject(new Error("unused")),
      attachProof: () => Promise.resolve(),
      // The provider accepted the payout but has not settled it yet.
      withdraw: vi.fn().mockResolvedValue({
        amount: WITHDRAW_USD,
        currency: "USDC",
        proof: { reference: "async-ref", railType: "protocol", confirmedAt: 0 },
      }),
    };
    await evaluateAndFireRail(
      db,
      rail as unknown as Parameters<typeof evaluateAndFireRail>[1],
      {
        policy: { minAggregateMicro: 0, feeJustificationMultiplier: 1, maxAgeMs: 0 },
      } as unknown as Parameters<typeof evaluateAndFireRail>[2],
    );
    expect(rail.withdraw).toHaveBeenCalledTimes(1);
    const id = onlyWithdrawalId(relay, mid);
    expect(row(relay, id).status).toBe("processing");
    const before = balance(relay, mid);
    expect((await admin(relay, id, "fail", { reason: "operator" })).status).toBe(409);
    expect(balance(relay, mid)).toBe(before);
    expect(refundCount(relay, mid, id)).toBe(0);
  });
});

describe("#921 round 3: the reconcile door waits for the payout's own horizon", () => {
  /**
   * A `processing` withdrawal carrying a DECLARED horizon — an x402 payout
   * claimed before #948 removed Path 1, or a batch fire on a sent-mode rail.
   * No code path creates the x402 kind any more; existing rows keep this door.
   */
  async function declaredHorizonRow(mid: string, validForMs: number) {
    relay = await createTestRelay({ enableDeviceAuth: false });
    await registerAndFund(relay, mid);
    const r = await startWithdraw(relay, mid, { destination: "pending" });
    const id = ((await r.json()) as WithdrawBody).withdrawal.withdrawal_id;
    const claimedAt = Date.now();
    const validUntil = claimedAt + validForMs;
    relay.moteDb.db
      .prepare(
        "UPDATE relay_withdrawals SET status = 'processing', destination = ?, claimed_at = ?, payout_valid_until = ? WHERE withdrawal_id = ?",
      )
      .run(EVM_DEST, claimedAt, validUntil, id);
    return { id, validUntil };
  }

  it("a declared-horizon payout ⇒ reconcile refused past the 15-minute floor, until the declared validity + margin", async () => {
    const mid = "zz921-x402-horizon";
    const { id, validUntil } = await declaredHorizonRow(mid, 60 * 60 * 1000);

    // 20 minutes on: past the 15-minute floor, but the facilitator can still
    // submit the authorization — refused, and the answer says when it opens.
    jumpClock(20 * 60 * 1000);
    const early = await admin(relay!, id, "reconcile", {
      outcome: "not_paid",
      attestation: "nothing on chain yet",
    });
    expect(early.status).toBe(409);
    const earlyBody = (await early.json()) as { message: string; reconcile_opens_at: number };
    expect(earlyBody.reconcile_opens_at).toBe(validUntil + PAYOUT_HORIZON_MARGIN_MS);
    expect(earlyBody.message).toMatch(/reconcile opens at/);
    expect(balance(relay!, mid)).toBe(FUNDED - WITHDRAW_MICRO);

    // Past validBefore + margin: the authorization can no longer land.
    jumpClock(validUntil + PAYOUT_HORIZON_MARGIN_MS - Date.now() + 1_000);
    const late = await admin(relay!, id, "reconcile", {
      outcome: "not_paid",
      attestation: "authorization expired unused; no transfer on chain",
    });
    expect(late.status).toBe(200);
    expectExactlyOneOutcome(relay!, mid, id);
  });

  it("reconcileOpensAt: floor and declared horizon; null (fail closed) without a declared horizon — never a clock bound for a relay-broadcast payout (#949)", () => {
    const claim = 1_000_000;
    // Declared horizon: the later of floor and validity + margin.
    expect(reconcileOpensAt({ claimed_at: claim, payout_valid_until: claim + 3_600_000 })).toBe(
      claim + 3_600_000 + PAYOUT_HORIZON_MARGIN_MS,
    );
    // A short declared horizon never goes below the floor.
    expect(reconcileOpensAt({ claimed_at: claim, payout_valid_until: claim + 1 })).toBe(
      claim + RECONCILE_MIN_AGE_MS,
    );
    // A Solana payout has no declared horizon: the chain decides, not the clock.
    expect(reconcileOpensAt({ claimed_at: claim, payout_valid_until: null })).toBeNull();
  });
});

describe("#921 round 3: batch — manual rails stay pending, sent rails carry a horizon", () => {
  function fakeRail(extra: Record<string, unknown>) {
    return {
      name: "zz921-rail",
      railType: "fiat" as const,
      custody: "relay" as const,
      supportsDeposit: false as const,
      supportsWithdraw: true as const,
      supportsBatch: false,
      isAvailable: () => Promise.resolve(true),
      attachProof: () => Promise.resolve(),
      withdraw: vi.fn().mockResolvedValue({
        amount: WITHDRAW_USD,
        currency: "USDC",
        proof: { reference: "pending:placeholder", railType: "fiat", confirmedAt: 0 },
      }),
      ...extra,
    };
  }
  async function fire(r: SyncRelay, mid: string, rail: ReturnType<typeof fakeRail>) {
    enqueuePendingWithdrawal(r.moteDb.db, {
      motebitId: mid,
      amountMicro: WITHDRAW_MICRO,
      destination: EVM_DEST,
      rail: "zz921-rail",
      source: "user",
    });
    await evaluateAndFireRail(
      r.moteDb.db,
      rail as unknown as Parameters<typeof evaluateAndFireRail>[1],
      {
        policy: { minAggregateMicro: 0, feeJustificationMultiplier: 1, maxAgeMs: 0 },
      } as unknown as Parameters<typeof evaluateAndFireRail>[2],
    );
    return onlyWithdrawalId(r, mid);
  }

  it("a MANUAL rail's fire is an ordinary pending withdrawal: admin /complete works (main parity)", async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const mid = "zz921-batch-manual";
    await registerAndFund(relay, mid);
    const id = await fire(relay, mid, fakeRail({ payoutMode: "manual" }));
    expect(row(relay, id).status).toBe("pending");
    // Its placeholder reference is not a payout, and it is not flagged.
    expect(row(relay, id).payout_reference).toBeNull();
    const done = await admin(relay, id, "complete", { payout_reference: "stripe-po-1" });
    expect(done.status).toBe(200);
    expect(row(relay, id).status).toBe("completed");
  });

  it("the real rails declare themselves: Stripe manual; x402 declares nothing — it no longer withdraws (#948)", () => {
    const stripe = new StripeSettlementRail({
      stripeClient: {} as ConstructorParameters<typeof StripeSettlementRail>[0]["stripeClient"],
      webhookSecret: "whsec_zz921",
    });
    expect(isManualPayoutRail(stripe)).toBe(true);
    const x402 = new X402SettlementRail({
      facilitatorClient: {} as ConstructorParameters<
        typeof X402SettlementRail
      >[0]["facilitatorClient"],
      network: "eip155:84532",
      payToAddress: "0x0000000000000000000000000000000000000000",
    });
    expect(isManualPayoutRail(x402)).toBe(false);
    expect(payoutValidityMsOf(x402)).toBeNull();
    expect(isWithdrawableRail(x402)).toBe(false);
  });

  it("a sent-but-unconfirmed fire is processing with the rail's horizon, or the 24h floor when it declares none", async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const mid = "zz921-batch-horizon";
    await registerAndFund(relay, mid);
    const before = Date.now();
    const id = await fire(relay, mid, fakeRail({}));
    expect(row(relay, id).status).toBe("processing");
    const v = (
      relay.moteDb.db
        .prepare("SELECT payout_valid_until FROM relay_withdrawals WHERE withdrawal_id = ?")
        .get(id) as { payout_valid_until: number }
    ).payout_valid_until;
    expect(v).toBeGreaterThanOrEqual(before + UNDECLARED_PAYOUT_HORIZON_MS);
    // Past the floor but inside the undeclared horizon: still refused.
    jumpClock(2 * 60 * 60 * 1000);
    expect(
      (await admin(relay, id, "reconcile", { outcome: "not_paid", attestation: "x" })).status,
    ).toBe(409);
  });
});

describe("#921 round 3: the SQLite store's from-state guard", () => {
  it("refuses a terminal from-state passed by a cast: a completed row is never re-completed", () => {
    const moteDb = createMotebitDatabase(":memory:");
    try {
      createAccountTables(moteDb.db);
      createWithdrawalTables(moteDb.db);
      const store = new SqliteAccountStore(moteDb.db);
      store.credit("zz921-sqlite", FUNDED, "deposit", "seed", "seed");
      const r = requestWithdrawal(store, {
        motebitId: "zz921-sqlite",
        amountMicro: WITHDRAW_MICRO,
        destination: DEST,
      });
      if (!r || "existing" in r) throw new Error("expected fresh");
      expect(store.claimWithdrawalForPayout(r.withdrawal_id, Date.now())).toBe(true);
      expect(store.setWithdrawalCompletion(r.withdrawal_id, "sig-1", 1, "processing")).toBe(true);
      const bogus = "completed" as unknown as "pending";
      expect(() => store.setWithdrawalCompletion(r.withdrawal_id, "sig-2", 2, bogus)).toThrow(
        /invalid from-status/,
      );
      expect(() => store.failWithdrawalAndRefund(r.withdrawal_id, "x", bogus)).toThrow(
        /invalid from-status/,
      );
      const w = store.getWithdrawalById(r.withdrawal_id)!;
      expect(w.status).toBe("completed");
      expect(w.payout_reference).toBe("sig-1");
      expect(store.getOrCreateAccount("zz921-sqlite").balance).toBe(FUNDED - WITHDRAW_MICRO);
    } finally {
      moteDb.close();
    }
  });
});

describe("#921 round 3: pre-claim rows are marked durably, once, at migration", () => {
  it("marks every pending row when claimed_at is added; never a later row; a pending row with a payout reference is flagged too", async () => {
    const moteDb = createMotebitDatabase(":memory:");
    try {
      // A ledger from before #921: no claimed_at / payout_valid_until / pre_claim_review.
      moteDb.db.exec(`
        CREATE TABLE relay_withdrawals (
          withdrawal_id TEXT PRIMARY KEY, motebit_id TEXT NOT NULL, amount INTEGER NOT NULL,
          currency TEXT NOT NULL DEFAULT 'USD', destination TEXT NOT NULL DEFAULT 'pending',
          status TEXT NOT NULL DEFAULT 'pending', idempotency_key TEXT, payout_reference TEXT,
          requested_at INTEGER NOT NULL, completed_at INTEGER, failure_reason TEXT,
          relay_signature TEXT, relay_public_key TEXT
        );
        INSERT INTO relay_withdrawals (withdrawal_id, motebit_id, amount, destination, status, requested_at)
          VALUES ('w-old-pending', 'm', 1, '${DEST}', 'pending', 1),
                 ('w-old-done', 'm', 1, '${DEST}', 'completed', 1);
      `);
      createWithdrawalTables(moteDb.db); // the deploy
      const flag = (id: string) =>
        (
          moteDb.db
            .prepare("SELECT pre_claim_review FROM relay_withdrawals WHERE withdrawal_id = ?")
            .get(id) as { pre_claim_review: number }
        ).pre_claim_review;
      expect(flag("w-old-pending")).toBe(1);
      expect(flag("w-old-done")).toBe(0);

      moteDb.db.exec(
        `INSERT INTO relay_withdrawals (withdrawal_id, motebit_id, amount, destination, status, requested_at)
           VALUES ('w-new-pending', 'm', 1, '${DEST}', 'pending', 1)`,
      );
      createWithdrawalTables(moteDb.db); // a later boot — even one with a wound-back clock
      expect(flag("w-new-pending")).toBe(0);
      expect(flag("w-old-pending")).toBe(1);

      const store = new SqliteAccountStore(moteDb.db);
      expect(payoutMayHaveBeenAttempted(store.getWithdrawalById("w-old-pending")!)).toBe(true);
      expect(payoutMayHaveBeenAttempted(store.getWithdrawalById("w-new-pending")!)).toBe(false);
      moteDb.db.exec(
        "UPDATE relay_withdrawals SET payout_reference = 'sig-x' WHERE withdrawal_id = 'w-new-pending'",
      );
      expect(payoutMayHaveBeenAttempted(store.getWithdrawalById("w-new-pending")!)).toBe(true);
    } finally {
      moteDb.close();
    }
  });

  it("/pending flags and /pre-claim lists exactly the marked rows (read-only, master token)", async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const mid = "zz921-preclaim";
    await registerAndFund(relay, mid);
    const w = async (destination: string): Promise<string> =>
      ((await (await startWithdraw(relay!, mid, { destination })).json()) as WithdrawBody)
        .withdrawal.withdrawal_id;
    const marked = await w(DEST);
    const plain = await w(DEST);
    relay.moteDb.db
      .prepare("UPDATE relay_withdrawals SET pre_claim_review = 1 WHERE withdrawal_id = ?")
      .run(marked);

    const pending = (await (
      await relay.app.request("/api/v1/admin/withdrawals/pending", { headers: AUTH_HEADER })
    ).json()) as {
      withdrawals: Array<{ withdrawal_id: string; payout_may_have_been_attempted: boolean }>;
    };
    const flagged = new Map(
      pending.withdrawals.map((x) => [x.withdrawal_id, x.payout_may_have_been_attempted]),
    );
    expect(flagged.get(marked)).toBe(true);
    expect(flagged.get(plain)).toBe(false);

    const reportRes = await relay.app.request("/api/v1/admin/withdrawals/pre-claim", {
      headers: AUTH_HEADER,
    });
    expect(reportRes.status).toBe(200);
    const report = (await reportRes.json()) as { withdrawals: Array<{ withdrawal_id: string }> };
    expect(report.withdrawals.map((x) => x.withdrawal_id)).toEqual([marked]);
    expect((await relay.app.request("/api/v1/admin/withdrawals/pre-claim")).status).toBe(401);
    // Not a wire field on the user's own record.
    const own = (await (
      await relay.app.request(`/api/v1/agents/${mid}/withdrawals`, { headers: AUTH_HEADER })
    ).json()) as { withdrawals: Array<Record<string, unknown>> };
    expect(own.withdrawals[0]).not.toHaveProperty("pre_claim_review");
    expect(own.withdrawals[0]).not.toHaveProperty("payout_valid_until");
  });
});

describe("#949: a Solana payout's reconcile is decided by the chain, never the clock", () => {
  async function reconcileBody(
    r: SyncRelay,
    id: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await admin(r, id, "reconcile", body);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it("a send that threw stays closed while its transaction can still land — hours of clock change nothing; the chain's expiry opens not_paid only", async () => {
    const { operator } = makeOperator(vi.fn().mockRejectedValue(new Error("RPC unavailable")));
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    const mid = "zz949-halt";
    await registerAndFund(relay, mid);
    const body = (await (await startWithdraw(relay, mid)).json()) as WithdrawBody;
    const id = body.withdrawal.withdrawal_id;
    expect(body.withdrawal.status).toBe("processing");

    // A halted chain: the transaction is not past its last valid height.
    chain.outcome = { status: "pending" };
    for (const hours of [1, 6, 48]) {
      jumpClock(hours * 60 * 60 * 1000);
      const r = await reconcileBody(relay, id, { outcome: "not_paid", attestation: "nothing" });
      expect(r.status).toBe(409);
      expect(r.json.reason).toBe("chain_pending");
      expect((r.json.chain as { signature: string }).signature).toBe(TX_SIG);
    }
    // An unreadable chain decides nothing either.
    chain.outcome = { status: "rpc_error", reason: "503" };
    expect(
      (await reconcileBody(relay, id, { outcome: "not_paid", attestation: "x" })).json.reason,
    ).toBe("chain_unreadable");
    // Seen in a block once ⇒ a later "expired" read is not trusted (#885 round 5).
    chain.outcome = { status: "pending", seen: true };
    expect((await reconcileBody(relay, id, { outcome: "not_paid", attestation: "x" })).status).toBe(
      409,
    );
    chain.outcome = { status: "expired" };
    expect(
      (await reconcileBody(relay, id, { outcome: "not_paid", attestation: "x" })).json.reason,
    ).toBe("chain_pending");
    expect(balance(relay, mid)).toBe(FUNDED - WITHDRAW_MICRO);
  });

  it("the chain's expiry allows only not_paid; a landed transaction allows only paid, under its own signature", async () => {
    const { operator } = makeOperator(vi.fn().mockRejectedValue(new Error("socket hang up")));
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    const midA = "zz949-expired";
    await registerAndFund(relay, midA);
    const a = ((await (await startWithdraw(relay, midA)).json()) as WithdrawBody).withdrawal
      .withdrawal_id;
    chain.outcome = { status: "expired" };
    const wrongWay = await reconcileBody(relay, a, {
      outcome: "paid",
      payout_reference: TX_SIG,
      attestation: "I think it paid",
    });
    expect(wrongWay.status).toBe(409);
    expect(wrongWay.json.error).toBe("WITHDRAWAL_RECONCILE_CONTRADICTS_CHAIN");
    expect(wrongWay.json.chain_outcome).toBe("not_paid");
    expect(
      (await reconcileBody(relay, a, { outcome: "not_paid", attestation: "expired unused" }))
        .status,
    ).toBe(200);
    expectExactlyOneOutcome(relay, midA, a);

    const midB = "zz949-landed";
    await registerAndFund(relay, midB);
    const b = ((await (await startWithdraw(relay, midB)).json()) as WithdrawBody).withdrawal
      .withdrawal_id;
    chain.outcome = { status: "landed", slot: 77 };
    const refund = await reconcileBody(relay, b, { outcome: "not_paid", attestation: "no" });
    expect(refund.status).toBe(409);
    expect(refund.json.payout_reference).toBe(TX_SIG);
    const otherRef = await reconcileBody(relay, b, {
      outcome: "paid",
      payout_reference: "someOtherSignature",
      attestation: "x",
    });
    expect(otherRef.status).toBe(409);
    expect(
      (
        await reconcileBody(relay, b, {
          outcome: "paid",
          payout_reference: TX_SIG,
          attestation: "landed",
        })
      ).status,
    ).toBe(200);
    expect(row(relay, b).payout_reference).toBe(TX_SIG);
    expectExactlyOneOutcome(relay, midB, b);
  });

  it("round 5 regression: a history-absence verdict never refuses the operator's paid naming a recorded signature, and never refunds", async () => {
    const { operator } = makeOperator(vi.fn().mockRejectedValue(new Error("socket hang up")));
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    const mid = "zz949-r5-absence";
    await registerAndFund(relay, mid);
    const id = ((await (await startWithdraw(relay, mid)).json()) as WithdrawBody).withdrawal
      .withdrawal_id;
    // Days later: the history read says "absent, past its validity" and the
    // node reports a deep edge (a snapshot jump) — the payout in fact landed.
    chain.outcome = { status: "expired" };
    chain.firstAvailableSlot = 0;
    const refund = await reconcileBody(relay, id, {
      outcome: "not_paid",
      attestation: "explorer shows nothing",
    });
    expect(refund.status).toBe(409);
    expect(balance(relay, mid)).toBe(FUNDED - WITHDRAW_MICRO);
    const paid = await reconcileBody(relay, id, {
      outcome: "paid",
      payout_reference: TX_SIG,
      attestation: "an archive explorer shows it landed",
    });
    expect(paid.status).toBe(200);
    expectExactlyOneOutcome(relay, mid, id);
  });

  it("PR1: the send threw, the payout landed, the node pruned it — no refund; the operator's paid under the recorded signature is accepted (#949 round 2)", async () => {
    const { operator } = makeOperator(vi.fn().mockRejectedValue(new Error("socket hang up")));
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    const mid = "zz949-pr1";
    await registerAndFund(relay, mid);
    const id = ((await (await startWithdraw(relay, mid)).json()) as WithdrawBody).withdrawal
      .withdrawal_id;
    // Days later: the node no longer holds the landing window and answers
    // "absent, past its last valid height" for the landed transaction.
    chain.outcome = { status: "expired" };
    chain.firstAvailableSlot = 2_000_000;
    const refund = await reconcileBody(relay, id, {
      outcome: "not_paid",
      attestation: "explorer shows nothing",
    });
    expect(refund.status).toBe(409);
    expect(refund.json.reason).toBe("chain_history_pruned");
    expect(balance(relay, mid)).toBe(FUNDED - WITHDRAW_MICRO);
    // A paid naming a signature this payout never signed is still refused.
    const stranger = await reconcileBody(relay, id, {
      outcome: "paid",
      payout_reference: "notOurSignature",
      attestation: "x",
    });
    expect(stranger.status).toBe(409);
    const paid = await reconcileBody(relay, id, {
      outcome: "paid",
      payout_reference: TX_SIG,
      attestation: "an archive node shows it landed",
    });
    expect(paid.status).toBe(200);
    expect(row(relay, id).payout_reference).toBe(TX_SIG);
    expectExactlyOneOutcome(relay, mid, id);
  });

  it("the in-flight mark still wins over a decided chain", async () => {
    const send = deferred<SendUsdcResult>();
    const sendUsdc = vi.fn().mockReturnValue(send.promise);
    const { operator } = makeOperator(sendUsdc);
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    const mid = "zz949-inflight";
    await registerAndFund(relay, mid);
    const pending = startWithdraw(relay, mid);
    await until(() => sendUsdc.mock.calls.length === 1);
    const id = onlyWithdrawalId(relay, mid);
    chain.outcome = { status: "expired" };
    const r = await reconcileBody(relay, id, { outcome: "not_paid", attestation: "x" });
    expect(r.json.reason).toBe("in_flight_here");
    send.resolve({ signature: TX_SIG, slot: 1, confirmed: true });
    await pending;
    expect(row(relay, id).status).toBe("completed");
    expect(refundCount(relay, mid, id)).toBe(0);
  });

  it("a signature the relay cannot record is never broadcast; no recorded attempt ⇒ provably not paid", async () => {
    const sendUsdc = vi.fn();
    const { operator } = makeOperator(sendUsdc);
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    relay.moteDb.db.exec(
      "CREATE TRIGGER zz949_no_record BEFORE INSERT ON relay_withdrawal_payout_attempts BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    );
    const mid = "zz949-unrecordable";
    await registerAndFund(relay, mid);
    const body = (await (await startWithdraw(relay, mid)).json()) as WithdrawBody;
    const id = body.withdrawal.withdrawal_id;
    expect(sendUsdc).not.toHaveBeenCalled();
    expect(body.withdrawal.status).toBe("processing");
    // The chain need not be asked: nothing of this payout was ever broadcast.
    chain.outcome = { status: "pending" };
    expect(
      (await reconcileBody(relay, id, { outcome: "not_paid", attestation: "never sent" })).status,
    ).toBe(200);
    expectExactlyOneOutcome(relay, mid, id);
  });

  it("a transfer that cannot record its broadcasts or read their outcome is never used: the withdrawal stays pending, nothing sent", async () => {
    const sendUsdc = vi.fn();
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
    relay = await createTestRelay({
      enableDeviceAuth: false,
      operatorSolanaTransfer: new OperatorSolanaTransfer(adapter),
    });
    const mid = "zz949-unrecording-transfer";
    await registerAndFund(relay, mid);
    const body = (await (await startWithdraw(relay, mid)).json()) as WithdrawBody;
    expect(sendUsdc).not.toHaveBeenCalled();
    expect(body.withdrawal.status).toBe("pending");
    expect(
      (await admin(relay, body.withdrawal.withdrawal_id, "fail", { reason: "x" })).status,
    ).toBe(200);
  });

  it("a LEGACY claim (an earlier process, no signatures recorded) opens only when the chain's height passes the bound; a halted chain keeps it shut", async () => {
    const { operator } = makeOperator(vi.fn());
    relay = await createTestRelay({ enableDeviceAuth: false, operatorSolanaTransfer: operator });
    const mid = "zz949-legacy";
    await registerAndFund(relay, mid);
    const r0 = await startWithdraw(relay, mid, { destination: "pending" });
    const id = ((await r0.json()) as WithdrawBody).withdrawal.withdrawal_id;
    relay.moteDb.db
      .prepare(
        "UPDATE relay_withdrawals SET status = 'processing', destination = ?, claimed_at = ?, payout_valid_until = NULL WHERE withdrawal_id = ?",
      )
      .run(DEST, Date.now() - 60 * 60 * 1000, id);

    const listing = (await (
      await relay.app.request("/api/v1/admin/withdrawals/pending", { headers: AUTH_HEADER })
    ).json()) as { withdrawals: Array<{ withdrawal_id: string; reconcile_decided_by: string }> };
    expect(listing.withdrawals.find((w) => w.withdrawal_id === id)!.reconcile_decided_by).toBe(
      "chain_height",
    );

    // First read anchors the bound; a halted chain never passes it.
    const first = await reconcileBody(relay, id, { outcome: "not_paid", attestation: "x" });
    expect(first.json.reason).toBe("chain_height");
    const bound = (first.json.chain as { opens_past_block_height: number }).opens_past_block_height;
    expect(bound).toBe(chain.height + LEGACY_BROADCAST_HEIGHT_BOUND);
    jumpClock(72 * 60 * 60 * 1000);
    expect(
      (await reconcileBody(relay, id, { outcome: "not_paid", attestation: "x" })).json.reason,
    ).toBe("chain_height");
    chain.height = bound;
    expect((await reconcileBody(relay, id, { outcome: "not_paid", attestation: "x" })).status).toBe(
      409,
    );
    chain.height = bound + 1;
    expect(
      (await reconcileBody(relay, id, { outcome: "not_paid", attestation: "nothing landed" }))
        .status,
    ).toBe(200);
    expectExactlyOneOutcome(relay, mid, id);
  });

  it("a legacy claim with no Solana transfer configured is undetermined: the door stays shut", async () => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const mid = "zz949-legacy-noreader";
    await registerAndFund(relay, mid);
    const r0 = await startWithdraw(relay, mid, { destination: "pending" });
    const id = ((await r0.json()) as WithdrawBody).withdrawal.withdrawal_id;
    relay.moteDb.db
      .prepare(
        "UPDATE relay_withdrawals SET status = 'processing', destination = ?, claimed_at = ?, payout_valid_until = NULL WHERE withdrawal_id = ?",
      )
      .run(DEST, Date.now() - 60 * 60 * 1000, id);
    jumpClock(72 * 60 * 60 * 1000);
    const r = await reconcileBody(relay, id, { outcome: "not_paid", attestation: "x" });
    expect(r.status).toBe(409);
    expect(r.json.reason).toBe("chain_unreadable");
    const listing = (await (
      await relay.app.request("/api/v1/admin/withdrawals/pending", { headers: AUTH_HEADER })
    ).json()) as { withdrawals: Array<{ withdrawal_id: string; reconcile_state: string }> };
    expect(listing.withdrawals.find((w) => w.withdrawal_id === id)!.reconcile_state).toBe(
      "undetermined",
    );
  });
});
