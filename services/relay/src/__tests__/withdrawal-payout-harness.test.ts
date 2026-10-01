/**
 * Withdrawal payout harness (#948, #945) — harness before fix
 * (docs/ops/agentic-lanes.md "Stopping rules").
 *
 * #920 and #921 each closed one door of the same class: "a withdrawal is
 * refunded while its payout can still land, or a payout outcome is left with
 * no door to settle it". This file enumerates the space those bugs live in
 * for the rails other than Path 0:
 *
 *   BATCH — every withdrawable rail kind (manual, sent-undeclared,
 *   sent-declared) × every fire outcome (confirmed, unconfirmed, throws,
 *   the process died mid-fire) × a retried loop tick, then the operator's
 *   settle door.
 *
 *   PATH 1 (x402 to a 0x address) — a withdrawal the relay accepts must be
 *   one a facilitator can actually execute.
 *
 * PATH 0 (Solana, durable-nonce payouts decided by finalized chain state,
 * #990) is driven by `withdrawal-payout-agave-harness.test.ts`: the REAL
 * adapter through the REAL routes against released-agave semantics.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { X402SettlementRail } from "@motebit/settlement-rails";
import { isWithdrawableRail, type GuestRail } from "@motebit/protocol";
import type { DatabaseDriver } from "@motebit/persistence";

import type { SyncRelay } from "../index.js";
import { creditAccount, getAccountBalance, getTransactions } from "../accounts.js";
import * as batch from "../batch-withdrawals.js";
import { AUTH_HEADER, createTestRelay, jsonAuthWithIdempotency } from "./test-helpers.js";

const FUNDED = 5_000_000;
const W_USD = 1.5;
const W_MICRO = 1_500_000;
const DEST = "GJmrQzyZumWWkdBuVH3Z1hnGvjrcDMbx7ptF5t5UAAAA";
const EVM_DEST = "0x1234567890abcdef1234567890abcdef12345678";
const HOUR = 60 * 60 * 1000;

// ── the relay's clock ────────────────────────────────────────────────────
const realNow = Date.now.bind(Date);
let clockOffset = 0;
function jumpClock(ms: number): void {
  clockOffset += ms;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
}

// ── relay helpers ────────────────────────────────────────────────────────
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
  creditAccount(relay.moteDb.db, motebitId, FUNDED, "deposit", `${motebitId}-dep`, "self-deposit");
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

interface Row {
  withdrawal_id: string;
  status: string;
  payout_reference: string | null;
}

function rowsOf(relay: SyncRelay, mid: string): Row[] {
  return relay.moteDb.db
    .prepare(
      "SELECT withdrawal_id, status, payout_reference FROM relay_withdrawals WHERE motebit_id = ?",
    )
    .all(mid) as Row[];
}

function refunds(relay: SyncRelay, mid: string): number {
  const ids = new Set(rowsOf(relay, mid).map((r) => r.withdrawal_id));
  return getTransactions(relay.moteDb.db, mid, 200).filter(
    (t) => t.reference_id != null && ids.has(t.reference_id) && t.amount > 0,
  ).length;
}

function balance(relay: SyncRelay, mid: string): number {
  return getAccountBalance(relay.moteDb.db, mid)?.balance ?? 0;
}

async function adminQueueIds(relay: SyncRelay): Promise<Set<string>> {
  const res = await relay.app.request(`/api/v1/admin/withdrawals/pending`, {
    headers: AUTH_HEADER,
  });
  const body = (await res.json()) as { withdrawals: Array<{ withdrawal_id: string }> };
  return new Set(body.withdrawals.map((w) => w.withdrawal_id));
}

const OPEN = new Set(["pending", "processing"]);

let relay: SyncRelay | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clockOffset = 0;
  await relay?.close();
  relay = undefined;
});

// ── batch ────────────────────────────────────────────────────────────────

type RailKind = "manual" | "sent_undeclared" | "sent_declared";
/** `serial`: one `withdraw()` per row; `batch`: one `withdrawBatch()` for the rail's rows. */
type FireMode = "serial" | "batch";
type FireOutcome = "confirmed" | "unconfirmed" | "throws" | "item_failed" | "crash_mid_fire";

const RAIL_KINDS: RailKind[] = ["manual", "sent_undeclared", "sent_declared"];
const FIRE_MODES: FireMode[] = ["serial", "batch"];
const FIRE_OUTCOMES: FireOutcome[] = [
  "confirmed",
  "unconfirmed",
  "throws",
  "item_failed",
  "crash_mid_fire",
];
// `item_failed` exists only for a batch (a serial call throws or returns).
const BATCH_CELLS = RAIL_KINDS.flatMap((rail) =>
  FIRE_MODES.flatMap((mode) =>
    FIRE_OUTCOMES.filter((o) => mode === "batch" || o !== "item_failed").map((outcome) => ({
      rail,
      mode,
      outcome,
    })),
  ),
);

function batchRail(kind: RailKind, mode: FireMode, outcome: FireOutcome) {
  const resultFor = () => ({
    amount: W_USD,
    currency: "USDC",
    proof: {
      reference: kind === "manual" ? "pending:placeholder" : "provider-ref-1",
      railType: "protocol",
      confirmedAt: outcome === "confirmed" ? Date.now() : 0,
    },
  });
  const withdraw = vi.fn(() => {
    if (outcome === "throws") return Promise.reject(new Error("provider 502 after accepting?"));
    return Promise.resolve(resultFor());
  });
  const withdrawBatch = vi.fn((items: ReadonlyArray<{ idempotency_key: string }>) => {
    if (outcome === "throws") return Promise.reject(new Error("provider 502 after accepting?"));
    if (outcome === "item_failed") {
      return Promise.resolve({
        fired: [],
        failed: items.map((item) => ({ item, reason: "provider rejected the item?" })),
      });
    }
    return Promise.resolve({
      fired: items.map((item) => ({ item, result: resultFor() })),
      failed: [],
    });
  });
  return {
    name: "zzh-rail",
    railType: "protocol" as const,
    custody: "relay" as const,
    supportsDeposit: false as const,
    supportsWithdraw: true as const,
    supportsBatch: mode === "batch",
    isAvailable: () => Promise.resolve(true),
    attachProof: () => Promise.resolve(),
    withdraw,
    ...(mode === "batch" ? { withdrawBatch } : {}),
    calls: () => withdraw.mock.calls.length + withdrawBatch.mock.calls.length,
    ...(kind === "manual" ? { payoutMode: "manual" } : {}),
    ...(kind === "sent_declared" ? { payoutMode: "sent", payoutValidityMs: HOUR } : {}),
  };
}

const FIRE_NOW = {
  policy: { minAggregateMicro: 0, feeJustificationMultiplier: 1, maxAgeMs: 0 },
} as unknown as batch.BatchWithdrawalConfig;

/** One tick of the batch loop — the exported tick when there is one, else each rail's fire. */
async function tick(db: DatabaseDriver, rail: GuestRail): Promise<void> {
  const runTick = (batch as unknown as Record<string, unknown>).runBatchWithdrawalTick as
    | ((
        db: DatabaseDriver,
        rails: readonly GuestRail[],
        c: batch.BatchWithdrawalConfig,
      ) => Promise<void>)
    | undefined;
  if (runTick) {
    await runTick(db, [rail], FIRE_NOW);
    return;
  }
  if (isWithdrawableRail(rail)) await batch.evaluateAndFireRail(db, rail, FIRE_NOW);
}

describe("harness: batch — rail kind × fire mode × fire outcome × retried tick, then the settle door", () => {
  it.each(BATCH_CELLS)("$rail × $mode × $outcome", async ({ rail: kind, mode, outcome }) => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const db = relay.moteDb.db;
    const mid = `zzh-b-${kind}-${mode}-${outcome}`;
    await registerAndFund(relay, mid);
    const pendingId = batch.enqueuePendingWithdrawal(db, {
      motebitId: mid,
      amountMicro: W_MICRO,
      destination: DEST,
      rail: "zzh-rail",
      source: "user",
    });
    expect(pendingId).not.toBeNull();
    const rail = batchRail(kind, mode, outcome);
    if (outcome === "crash_mid_fire") {
      // An earlier process claimed the row and called the rail; it died before
      // recording anything.
      db.prepare(
        "UPDATE relay_pending_withdrawals SET status = 'firing', last_attempt_at = ? WHERE pending_id = ?",
      ).run(Date.now() - 10 * 60 * 1000, pendingId);
    }

    const violations: string[] = [];
    await tick(db, rail as unknown as GuestRail);
    await tick(db, rail as unknown as GuestRail);
    if (rail.calls() > 1) violations.push("the rail was called twice");

    const q = db
      .prepare("SELECT status, withdrawal_id FROM relay_pending_withdrawals WHERE pending_id = ?")
      .get(pendingId) as { status: string; withdrawal_id: string | null };
    const rows = rowsOf(relay, mid);
    if (q.status === "pending") {
      violations.push("the queue row never fired");
    } else if (
      q.withdrawal_id == null ||
      rows.length !== 1 ||
      rows[0]!.withdrawal_id !== q.withdrawal_id
    ) {
      violations.push(
        `queue row ${q.status} has no single settle door (withdrawal_id=${q.withdrawal_id}, rows=${rows.length})`,
      );
    }
    const sentSomething = kind !== "manual";
    const expected =
      outcome === "confirmed" ? "completed" : sentSomething ? "processing" : "pending";
    if (rows.length === 1 && rows[0]!.status !== expected) {
      violations.push(`recorded ${rows[0]!.status}, expected ${expected}`);
    }
    if (balance(relay, mid) !== FUNDED - W_MICRO)
      violations.push("balance not debited exactly once");
    const queue = await adminQueueIds(relay);
    for (const w of rows) {
      if (OPEN.has(w.status) && !queue.has(w.withdrawal_id)) {
        violations.push(`open withdrawal ${w.status} is not on the operator's queue`);
      }
    }

    // The door works: past any horizon, the operator settles "not paid".
    jumpClock(26 * HOUR);
    for (const w of rows) {
      if (w.status === "processing") {
        await admin(relay, w.withdrawal_id, "reconcile", {
          outcome: "not_paid",
          attestation: "provider shows the payout was never executed",
        });
      } else if (w.status === "pending") {
        await admin(relay, w.withdrawal_id, "fail", { reason: "never paid" });
      }
    }
    const after = rowsOf(relay, mid);
    const refunded = refunds(relay, mid);
    for (const w of after) {
      if (OPEN.has(w.status)) violations.push(`the settle door did not settle a ${w.status} row`);
    }
    const completed = after.filter((w) => w.status === "completed").length;
    if (completed + refunded !== 1) {
      violations.push(`completed=${completed} refunds=${refunded}: funds stranded or out twice`);
    }
    expect(violations).toEqual([]);
  });
});

// ── Path 1 ───────────────────────────────────────────────────────────────

const EIP3009_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

describe("harness: Path 1 (x402) — a payout the relay accepts is one a facilitator can execute", () => {
  it("the x402 rail either is not withdrawable, or signs a real EIP-3009 authorization", async () => {
    const payloads: unknown[] = [];
    const rail = new X402SettlementRail({
      facilitatorClient: {
        url: "https://facilitator.invalid",
        getSupported: () => Promise.resolve({ kinds: [{}] }),
        settle: (payload: unknown) => {
          payloads.push(payload);
          return Promise.resolve({ success: true, transaction: "0xabc", network: "eip155:84532" });
        },
      },
      network: "eip155:84532",
      payToAddress: "0x0000000000000000000000000000000000000000",
    });
    const asGuest: GuestRail = rail;
    if (!isWithdrawableRail(asGuest)) return;
    await asGuest.withdraw("zzh-x402", W_USD, "USDC", EVM_DEST, "idem-key-1");
    const p = payloads[0] as { payload: { signature: string; authorization: { nonce: string } } };
    expect(p.payload.signature).toMatch(EIP3009_SIGNATURE);
    expect(p.payload.signature).not.toBe("idem-key-1");
  });

  it("a 0x withdrawal is refused before any debit, or handed to a facilitator with a real signature", async () => {
    const settleBodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: unknown, init?: { body?: string }) => {
        if (String(url).includes("/settle")) settleBodies.push(String(init?.body ?? ""));
        return Promise.reject(new Error("no network in tests"));
      }),
    );
    vi.spyOn(X402SettlementRail.prototype, "isAvailable").mockResolvedValue(true);
    relay = await createTestRelay({ enableDeviceAuth: false });
    const mid = "zzh-p1";
    await registerAndFund(relay, mid);
    const res = await relay.app.request(`/api/v1/agents/${mid}/withdraw`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ amount: W_USD, destination: EVM_DEST }),
    });
    const refused = res.status >= 400 && res.status < 500;
    if (refused) {
      expect(balance(relay, mid)).toBe(FUNDED);
      expect(rowsOf(relay, mid)).toHaveLength(0);
      return;
    }
    // Accepted: it must have been handed to a facilitator as a signed authorization.
    expect(settleBodies.length).toBeGreaterThan(0);
    for (const b of settleBodies) {
      const parsed = JSON.parse(b) as { paymentPayload?: { payload?: { signature?: string } } };
      expect(parsed.paymentPayload?.payload?.signature ?? "").toMatch(EIP3009_SIGNATURE);
    }
  });
});
