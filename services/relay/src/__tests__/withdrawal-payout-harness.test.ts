/**
 * Withdrawal payout harness (#948, #949, #945) — harness before fix
 * (docs/ops/agentic-lanes.md "Stopping rules").
 *
 * #920 and #921 each closed one door of the same class: "a withdrawal is
 * refunded while its payout can still land, or a payout outcome is left with
 * no door to settle it". This file enumerates the space those bugs live in
 * instead of adding one more cell per review round:
 *
 *   PATH 0 (Solana, relay-broadcast) — every send script the adapter
 *   contract allows × a fixed schedule of wall-clock jumps and chain moves ×
 *   a truthful operator who, at every step, looks at the chain and asks the
 *   relay to settle what it sees (paid ⇒ reconcile/complete with the landed
 *   signature; nothing landed ⇒ reconcile not_paid / fail), plus a replay of
 *   the /withdraw request. Also LEGACY claims (made by an earlier process
 *   that recorded no signatures).
 *
 *   BATCH — every withdrawable rail kind (manual, sent-undeclared,
 *   sent-declared) × every fire outcome (confirmed, unconfirmed, throws,
 *   the process died mid-fire) × a retried loop tick, then the operator's
 *   settle door.
 *
 *   PATH 1 (x402 to a 0x address) — a withdrawal the relay accepts must be
 *   one a facilitator can actually execute.
 *
 * The oracle, asserted after EVERY step of every cell:
 *   - value leaves at most once: refunds + payouts landed on chain ≤ 1;
 *   - a `completed` row names a payout that landed on chain;
 *   - the balance is exactly FUNDED − amount + refunds × amount;
 *   - a withdrawal that is still open is on the operator's queue
 *     (`GET /api/v1/admin/withdrawals/pending`) — never stranded;
 *   - one send per claimed withdrawal (a replay never sends again).
 * And at the end of each cell, once the chain has decided (every broadcast
 * landed, failed, or is past its last valid block HEIGHT): the withdrawal
 * is terminal and agrees with the chain. The modelled stuck set is empty.
 *
 * Wall-clock never decides whether a payout landed: the chain can HALT (no
 * block height advances) while the relay's clock runs for hours, and a
 * signed Solana transaction is still valid when it resumes (#949).
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import {
  OperatorSolanaTransfer,
  type SolanaRpcAdapter,
  type SignedTransactionRef,
  type SignatureOutcome,
  type BroadcastHooks,
} from "@motebit/wallet-solana";
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

// ── a Solana cluster ─────────────────────────────────────────────────────
type Fate = "lands" | "fails" | "never";
interface ChainTx {
  signature: string;
  lastValidBlockHeight: number;
  fate: Fate;
  landsAtHeight: number;
  state: "in_flight" | "landed" | "failed";
  slot: number;
}

/**
 * Block height is the only clock a Solana transaction obeys: it lands (or
 * fails) only at a height ≤ its `lastValidBlockHeight`, and is provably dead
 * only once the height is past it (+ the adapter's margin). A halted
 * cluster produces no blocks however much wall-clock passes.
 */
class FakeCluster {
  height = 10_000;
  halted = false;
  readonly txs = new Map<string, ChainTx>();
  private n = 0;

  sign(): SignedTransactionRef {
    this.n++;
    return {
      signature: `sig-${this.n}-${"x".repeat(40)}`,
      lastValidBlockHeight: this.height + 150,
    };
  }

  broadcast(ref: SignedTransactionRef, fate: Fate, delayBlocks: number): ChainTx {
    const tx: ChainTx = {
      ...ref,
      fate,
      landsAtHeight: this.height + delayBlocks,
      state: "in_flight",
      slot: 0,
    };
    this.txs.set(ref.signature, tx);
    this.settle();
    return tx;
  }

  advance(blocks: number): void {
    if (this.halted) return;
    for (let i = 0; i < blocks; i++) {
      this.height++;
      this.settle();
    }
  }

  private settle(): void {
    for (const tx of this.txs.values()) {
      if (tx.state !== "in_flight" || tx.fate === "never") continue;
      if (this.height >= tx.landsAtHeight && this.height <= tx.lastValidBlockHeight) {
        tx.state = tx.fate === "lands" ? "landed" : "failed";
        tx.slot = this.height * 2;
      }
    }
  }

  outcome(ref: SignedTransactionRef): SignatureOutcome {
    const tx = this.txs.get(ref.signature);
    if (tx?.state === "landed") return { status: "landed", slot: tx.slot };
    if (tx?.state === "failed") return { status: "failed" };
    return this.height > ref.lastValidBlockHeight + 10
      ? { status: "expired" }
      : { status: "pending" };
  }

  landed(): ChainTx[] {
    return [...this.txs.values()].filter((t) => t.state === "landed");
  }

  /** Every broadcast is landed, failed, or past its last valid height. */
  decided(): boolean {
    return [...this.txs.values()].every(
      (t) => t.state !== "in_flight" || this.height > t.lastValidBlockHeight + 10,
    );
  }
}

type SendScript =
  | "confirmed"
  | "landed_failed"
  | "resign_expired_then_confirmed"
  | "reported_failed_earlier_unknown"
  | "throw_before_broadcast"
  | "throw_after_broadcast_lands"
  | "throw_after_broadcast_never"
  | "halt_then_lands"
  | "halt_then_never"
  | "unavailable";

const SEND_SCRIPTS: SendScript[] = [
  "confirmed",
  "landed_failed",
  "resign_expired_then_confirmed",
  "reported_failed_earlier_unknown",
  "throw_before_broadcast",
  "throw_after_broadcast_lands",
  "throw_after_broadcast_never",
  "halt_then_lands",
  "halt_then_never",
  "unavailable",
];

type SendResult = Awaited<ReturnType<SolanaRpcAdapter["sendUsdc"]>>;

/**
 * An adapter that honours the #885 contract: `beforeBroadcast` runs for every
 * signed transaction before it is sent, and the chain can be asked about any
 * signed transaction. The send script decides what the cluster does.
 */
function makeAdapter(
  cluster: FakeCluster,
  script: SendScript,
): { adapter: SolanaRpcAdapter; sends: () => number } {
  let sends = 0;
  const broadcastOne = async (
    hooks: BroadcastHooks | undefined,
    fate: Fate,
    delay: number,
  ): Promise<ChainTx> => {
    const ref = cluster.sign();
    if (hooks?.beforeBroadcast) await hooks.beforeBroadcast(ref);
    return cluster.broadcast(ref, fate, delay);
  };
  const sendUsdc = async (_args: unknown, hooks?: BroadcastHooks): Promise<SendResult> => {
    sends++;
    switch (script) {
      case "confirmed": {
        const tx = await broadcastOne(hooks, "lands", 0);
        return {
          signature: tx.signature,
          slot: tx.slot,
          confirmed: true,
          earlierBroadcastsDead: true,
        };
      }
      case "landed_failed": {
        const tx = await broadcastOne(hooks, "fails", 0);
        return {
          signature: tx.signature,
          slot: tx.slot,
          confirmed: false,
          earlierBroadcastsDead: true,
        };
      }
      case "resign_expired_then_confirmed": {
        await broadcastOne(hooks, "never", 0);
        cluster.advance(170);
        const tx2 = await broadcastOne(hooks, "lands", 0);
        return {
          signature: tx2.signature,
          slot: tx2.slot,
          confirmed: true,
          earlierBroadcastsDead: true,
        };
      }
      case "reported_failed_earlier_unknown": {
        // The first broadcast is still in flight and will land; the adapter
        // reports only the LAST one, which failed.
        await broadcastOne(hooks, "lands", 5);
        const tx2 = await broadcastOne(hooks, "fails", 0);
        return {
          signature: tx2.signature,
          slot: tx2.slot,
          confirmed: false,
          earlierBroadcastsDead: false,
        };
      }
      case "throw_before_broadcast":
        throw new Error("insufficient treasury USDC (nothing signed)");
      case "throw_after_broadcast_lands":
        await broadcastOne(hooks, "lands", 5);
        throw new Error("socket hang up after broadcast");
      case "throw_after_broadcast_never":
        await broadcastOne(hooks, "never", 0);
        throw new Error("socket hang up after broadcast");
      case "halt_then_lands":
        cluster.halted = true;
        await broadcastOne(hooks, "lands", 5);
        throw new Error("RPC unavailable: cluster halted");
      case "halt_then_never":
        cluster.halted = true;
        await broadcastOne(hooks, "never", 0);
        throw new Error("RPC unavailable: cluster halted");
      case "unavailable":
        throw new Error("unreachable: isReachable is false");
    }
  };
  const adapter = {
    honorsBroadcastHooks: true as const,
    ownAddress: "RelayTreasuryAddressBase58",
    getUsdcBalance: () => Promise.resolve(10_000_000_000n),
    getUsdcBalanceOf: () => Promise.resolve(10_000_000_000n),
    getSolBalance: () => Promise.resolve(10_000_000n),
    sendUsdc,
    sendUsdcBatch: () => Promise.resolve([]),
    getTransaction: () => Promise.resolve({ status: "not_found" as const }),
    getSignatureOutcome: (ref: SignedTransactionRef) => Promise.resolve(cluster.outcome(ref)),
    getBlockHeight: () => Promise.resolve(cluster.height),
    isReachable: () => Promise.resolve(script !== "unavailable"),
  } as SolanaRpcAdapter;
  return { adapter, sends: () => sends };
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

// ── Path 0 ───────────────────────────────────────────────────────────────

/** The schedule every Path 0 cell runs: the relay's clock and the chain move independently. */
const PHASES: Array<{ name: string; move: (c: FakeCluster) => void }> = [
  { name: "P0 right after the send", move: () => {} },
  { name: "P1 wall-clock +3h, chain unchanged", move: () => jumpClock(3 * HOUR) },
  {
    name: "P2 chain resumes, +20 blocks",
    move: (c) => {
      c.halted = false;
      c.advance(20);
    },
  },
  { name: "P3 +400 blocks (every broadcast decided)", move: (c) => c.advance(400) },
  { name: "P4 wall-clock +3h", move: () => jumpClock(3 * HOUR) },
];

/** The operator looks at the chain and asks the relay to settle exactly what it sees. */
async function truthfulOperator(r: SyncRelay, mid: string, cluster: FakeCluster): Promise<void> {
  const landed = cluster.landed();
  for (const w of rowsOf(r, mid)) {
    if (w.status === "processing") {
      await admin(
        r,
        w.withdrawal_id,
        "reconcile",
        landed.length > 0
          ? {
              outcome: "paid",
              payout_reference: landed[0]!.signature,
              attestation: `explorer shows ${landed[0]!.signature} paid the destination`,
            }
          : {
              outcome: "not_paid",
              attestation: "explorer shows no transfer from the treasury to the destination",
            },
      );
    } else if (w.status === "pending") {
      if (landed.length > 0) {
        await admin(r, w.withdrawal_id, "complete", { payout_reference: landed[0]!.signature });
      } else {
        await admin(r, w.withdrawal_id, "fail", { reason: "nothing on chain" });
      }
    } else {
      // Terminal: a repeat must change nothing.
      await admin(r, w.withdrawal_id, "reconcile", { outcome: "not_paid", attestation: "again" });
    }
  }
}

async function oracle(
  r: SyncRelay,
  mid: string,
  cluster: FakeCluster,
  step: string,
  final: boolean,
): Promise<string[]> {
  const out: string[] = [];
  const rows = rowsOf(r, mid);
  const landed = cluster.landed();
  const refunded = refunds(r, mid);
  if (refunded + landed.length > 1) {
    out.push(`${step}: value out twice (refunds=${refunded}, landed=${landed.length})`);
  }
  for (const w of rows) {
    if (w.status === "completed" && !landed.some((t) => t.signature === w.payout_reference)) {
      out.push(`${step}: completed with ${w.payout_reference}, which is not a landed payout`);
    }
  }
  const debited = rows.length * W_MICRO;
  if (balance(r, mid) !== FUNDED - debited + refunded * W_MICRO) {
    out.push(
      `${step}: balance ${balance(r, mid)} ≠ ${FUNDED} − ${debited} + ${refunded}×${W_MICRO}`,
    );
  }
  const queue = await adminQueueIds(r);
  for (const w of rows) {
    if (OPEN.has(w.status) && !queue.has(w.withdrawal_id)) {
      out.push(
        `${step}: open withdrawal ${w.withdrawal_id} (${w.status}) is not on the operator's queue`,
      );
    }
  }
  if (final && cluster.decided()) {
    for (const w of rows) {
      if (OPEN.has(w.status)) out.push(`${step}: stuck ${w.status} after the chain decided`);
      else if (landed.length > 0 && w.status !== "completed")
        out.push(`${step}: a payout landed but the row is ${w.status}`);
      else if (landed.length === 0 && (w.status !== "failed" || refunded !== 1))
        out.push(`${step}: nothing landed but the row is ${w.status} with ${refunded} refund(s)`);
    }
  }
  return out;
}

describe("harness: Path 0 (Solana) — send script × schedule × truthful operator × replay", () => {
  it.each(SEND_SCRIPTS)("%s", async (script) => {
    const cluster = new FakeCluster();
    const { adapter, sends } = makeAdapter(cluster, script);
    relay = await createTestRelay({
      enableDeviceAuth: false,
      operatorSolanaTransfer: new OperatorSolanaTransfer(adapter),
    });
    const mid = `zzh-p0-${script}`;
    await registerAndFund(relay, mid);

    const headers = jsonAuthWithIdempotency();
    const post = () =>
      relay!.app.request(`/api/v1/agents/${mid}/withdraw`, {
        method: "POST",
        headers,
        body: JSON.stringify({ amount: W_USD, destination: DEST }),
      });
    await post();
    // A replay of the same request never sends again.
    await post();

    const violations: string[] = [];
    if (sends() > 1) violations.push(`sent ${sends()} times for one withdrawal`);
    for (const [i, phase] of PHASES.entries()) {
      phase.move(cluster);
      await truthfulOperator(relay, mid, cluster);
      violations.push(...(await oracle(relay, mid, cluster, phase.name, i === PHASES.length - 1)));
    }
    expect(violations).toEqual([]);
  });
});

describe("harness: legacy Path 0 claims (an earlier process recorded no signature)", () => {
  const LEGACY: Array<{ name: string; fate: Fate; halt: boolean }> = [
    { name: "legacy_lands", fate: "lands", halt: false },
    { name: "legacy_never", fate: "never", halt: false },
    { name: "legacy_halt_lands", fate: "lands", halt: true },
    { name: "legacy_halt_never", fate: "never", halt: true },
  ];

  it.each(LEGACY)("$name", async ({ name, fate, halt }) => {
    const cluster = new FakeCluster();
    const { adapter } = makeAdapter(cluster, "confirmed");
    relay = await createTestRelay({
      enableDeviceAuth: false,
      operatorSolanaTransfer: new OperatorSolanaTransfer(adapter),
    });
    const mid = `zzh-${name}`;
    await registerAndFund(relay, mid);
    // An earlier process claimed the withdrawal and broadcast one transaction,
    // recording nothing but the claim; then it died.
    const res = await relay.app.request(`/api/v1/agents/${mid}/withdraw`, {
      method: "POST",
      headers: jsonAuthWithIdempotency(),
      body: JSON.stringify({ amount: W_USD, destination: "not-a-payout-address" }),
    });
    const id = ((await res.json()) as { withdrawal: { withdrawal_id: string } }).withdrawal
      .withdrawal_id;
    relay.moteDb.db
      .prepare(
        "UPDATE relay_withdrawals SET status = 'processing', destination = ?, claimed_at = ?, payout_valid_until = NULL WHERE withdrawal_id = ?",
      )
      .run(DEST, Date.now() - 20 * 60 * 1000, id);
    if (halt) cluster.halted = true;
    cluster.broadcast(cluster.sign(), fate, 5);

    const violations: string[] = [];
    for (const [i, phase] of PHASES.entries()) {
      phase.move(cluster);
      await truthfulOperator(relay, mid, cluster);
      violations.push(...(await oracle(relay, mid, cluster, phase.name, i === PHASES.length - 1)));
    }
    expect(violations).toEqual([]);
  });
});

// ── batch ────────────────────────────────────────────────────────────────

type RailKind = "manual" | "sent_undeclared" | "sent_declared";
type FireOutcome = "confirmed" | "unconfirmed" | "throws" | "crash_mid_fire";

const RAIL_KINDS: RailKind[] = ["manual", "sent_undeclared", "sent_declared"];
const FIRE_OUTCOMES: FireOutcome[] = ["confirmed", "unconfirmed", "throws", "crash_mid_fire"];
const BATCH_CELLS = RAIL_KINDS.flatMap((rail) =>
  FIRE_OUTCOMES.map((outcome) => ({ rail, outcome })),
);

function batchRail(kind: RailKind, outcome: FireOutcome) {
  const withdraw = vi.fn(() => {
    if (outcome === "throws") return Promise.reject(new Error("provider 502 after accepting?"));
    return Promise.resolve({
      amount: W_USD,
      currency: "USDC",
      proof: {
        reference: kind === "manual" ? "pending:placeholder" : "provider-ref-1",
        railType: "protocol",
        confirmedAt: outcome === "confirmed" ? Date.now() : 0,
      },
    });
  });
  return {
    name: "zzh-rail",
    railType: "protocol" as const,
    custody: "relay" as const,
    supportsDeposit: false as const,
    supportsWithdraw: true as const,
    supportsBatch: false,
    isAvailable: () => Promise.resolve(true),
    attachProof: () => Promise.resolve(),
    withdraw,
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

describe("harness: batch — rail kind × fire outcome × retried tick, then the settle door", () => {
  it.each(BATCH_CELLS)("$rail × $outcome", async ({ rail: kind, outcome }) => {
    relay = await createTestRelay({ enableDeviceAuth: false });
    const db = relay.moteDb.db;
    const mid = `zzh-b-${kind}-${outcome}`;
    await registerAndFund(relay, mid);
    const pendingId = batch.enqueuePendingWithdrawal(db, {
      motebitId: mid,
      amountMicro: W_MICRO,
      destination: DEST,
      rail: "zzh-rail",
      source: "user",
    });
    expect(pendingId).not.toBeNull();
    const rail = batchRail(kind, outcome);
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
    if (rail.withdraw.mock.calls.length > 1) violations.push("the rail was called twice");

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
