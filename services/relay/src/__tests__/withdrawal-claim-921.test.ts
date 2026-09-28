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
import { OperatorSolanaTransfer, type SolanaRpcAdapter } from "@motebit/wallet-solana";
import { X402SettlementRail } from "@motebit/settlement-rails";

import type { SyncRelay } from "../index.js";
import { creditAccount, getAccountBalance, getTransactions } from "../accounts.js";
import { RECONCILE_MIN_AGE_MS } from "../budget.js";
import { evaluateAndFireRail, enqueuePendingWithdrawal } from "../batch-withdrawals.js";
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

function makeOperator(
  sendUsdc: SolanaRpcAdapter["sendUsdc"],
  isReachable: SolanaRpcAdapter["isReachable"] = vi.fn().mockResolvedValue(true),
): { operator: OperatorSolanaTransfer; adapter: SolanaRpcAdapter } {
  const adapter: SolanaRpcAdapter = {
    ownAddress: "RelayTreasuryAddressBase58",
    getUsdcBalance: vi.fn().mockResolvedValue(10_000_000_000n),
    getUsdcBalanceOf: vi.fn().mockResolvedValue(10_000_000_000n),
    getSolBalance: vi.fn().mockResolvedValue(10_000_000n),
    sendUsdc,
    sendUsdcBatch: vi.fn().mockResolvedValue([]),
    getTransaction: vi.fn().mockResolvedValue({ status: "not_found" }),
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

/** Push a claim back past the reconcile window (the send is long dead). */
function ageClaim(relay: SyncRelay, id: string): void {
  relay.moteDb.db
    .prepare("UPDATE relay_withdrawals SET claimed_at = ? WHERE withdrawal_id = ?")
    .run(Date.now() - RECONCILE_MIN_AGE_MS - 1_000, id);
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
    ageClaim(relay, id);
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
    ageClaim(relay!, id);
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
    ageClaim(relay!, id);
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
    ageClaim(relay!, id);
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

describe("#921 Path 1 (x402) claims before send too", () => {
  it("admin /fail during the x402 withdraw is refused; the withdraw lands ⇒ completed, never refunded", async () => {
    const landed = deferred<Awaited<ReturnType<X402SettlementRail["withdraw"]>>>();
    vi.spyOn(X402SettlementRail.prototype, "isAvailable").mockResolvedValue(true);
    const withdraw = vi
      .spyOn(X402SettlementRail.prototype, "withdraw")
      .mockReturnValue(landed.promise);
    vi.spyOn(X402SettlementRail.prototype, "attachProof").mockResolvedValue(undefined);
    relay = await createTestRelay({ enableDeviceAuth: false });
    const mid = "zz921-x402";
    await registerAndFund(relay, mid);

    const pending = startWithdraw(relay, mid, { destination: EVM_DEST });
    await until(() => withdraw.mock.calls.length === 1);
    const id = onlyWithdrawalId(relay, mid);
    expect(row(relay, id).status).toBe("processing");
    expect((await admin(relay, id, "fail", { reason: "operator" })).status).toBe(409);

    landed.resolve({
      amount: WITHDRAW_USD,
      currency: "USDC",
      proof: { reference: "0xabc", railType: "protocol", network: "eip155:84532", confirmedAt: 1 },
    } as Awaited<ReturnType<X402SettlementRail["withdraw"]>>);
    const body = (await (await pending).json()) as WithdrawBody;
    expect(body.withdrawal.status).toBe("completed");
    expectExactlyOneOutcome(relay, mid, id);
  });

  it("x402 withdraw throws ⇒ processing (not pending), manual /fail refused", async () => {
    vi.spyOn(X402SettlementRail.prototype, "isAvailable").mockResolvedValue(true);
    vi.spyOn(X402SettlementRail.prototype, "withdraw").mockRejectedValue(
      new Error("facilitator timeout"),
    );
    relay = await createTestRelay({ enableDeviceAuth: false });
    const mid = "zz921-x402-throw";
    await registerAndFund(relay, mid);
    const body = (await (
      await startWithdraw(relay, mid, { destination: EVM_DEST })
    ).json()) as WithdrawBody;
    expect(body.withdrawal.status).toBe("processing");
    expect(
      (await admin(relay, body.withdrawal.withdrawal_id, "fail", { reason: "x" })).status,
    ).toBe(409);
    expect(balance(relay, mid)).toBe(FUNDED - WITHDRAW_MICRO);
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
