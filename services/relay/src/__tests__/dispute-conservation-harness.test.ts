/**
 * Dispute conservation harness — exhaustive differential over the REAL routes.
 *
 * A dispute moves money out of ONE allocation. Whatever sequence of filings,
 * verdicts, appeals and appeal-window expiries the parties and the operator
 * produce, the escrow is paid out at most once. Two money findings in the
 * dispute path (filer authority, then one allocation paying out repeatedly)
 * both broke that, and neither was visible to a single-scenario test. So this
 * file enumerates every action sequence up to length {@link MAX_DEPTH} from
 * every allocation starting state, drives each step through the real HTTP
 * routes, and checks the conservation law after EVERY step:
 *
 *   L1  payout ≤ locked. For the allocation: every credit/debit the ledger
 *       recorded after the delegator's lock (settlement payout, refund,
 *       dispute redistribution; the platform fee is part of the settlement
 *       payout) sums to at most what the delegator actually locked.
 *   L2  Each dispute-driven ledger row references exactly one dispute, and
 *       the rows of at most one dispute per allocation move money.
 *   L3  An allocation is resolved by at most one fund action: at most one
 *       dispute on it reaches `final` (legacy duplicate rows a start state
 *       already holds are counted as given, never as licence for more).
 *   L4  A rejected request (non-2xx) writes nothing to the ledger.
 *   L5  The first dispute to reach `final` owns the allocation's one fund
 *       action: no other dispute writes a ledger row after it (whether or not
 *       that verdict moved money — release_to_worker post-settlement moves none).
 *   L6  PAYEE-IS-PARTY: every dispute-driven credit lands on the allocation's
 *       delegator or its worker.
 *   L7  A dispute reverses only what was paid, from the account that was paid
 *       (dispute debits on an account ≤ the settlement credits it received).
 *   L8  A verdict executes once: no account holds two credits from one dispute.
 *   L1 counts gross a federated origin forwarded to the executing peer.
 *   L9  ALLOCATION-TASK-BINDING: money for allocation A only ever references
 *       A's own task — a dispute whose task_id is not its allocation's moves
 *       nothing, every account a dispute touches is its allocation's hold
 *       payer, worker, or an account its OWN settlements paid, and a claim row
 *       names its allocation's own task.
 *   L10 CLAIM-RECORDS-WHAT-MOVED: a claim row's amounts are the ledger deltas
 *       of its dispute (delegator = the hold payer's net, worker = everyone
 *       else's net), never an intent the ledger does not show.
 *   L11 SWEEP-CONSERVATION: no allocation's refunds exceed what the ledger
 *       still holds for it, counting federated forwards (escrow never < 0).
 *   L12 NO-STRAND: an allocation closed `settled` / `released` holds nothing.
 *   L13 A verdict whose window passed is executed (`final`) or visibly
 *       refused (`fund_refusal` set) — never silently stuck in `resolved`.
 *   L14 A locked / settled allocation with no live dispute of its OWN accepts
 *       a party's filing (a dispute naming another allocation never blocks it).
 *   L15 An allocation left `disputed` with no live dispute carries the
 *       `fund_refusal` that says why its funds are held.
 *   L16 NO-RAW-ALLOCATION-WRITE: every allocation-money row a step writes is
 *       stamped by the escrow chokepoint (`allocation_kind` on ledger rows, an
 *       allocation + lifecycle status on a sent forward). Statically, the
 *       gate `check-allocation-money-chokepoint` asserts no raw write exists
 *       and that `KIND_ACTIONS` below maps every chokepoint kind to an action
 *       of this alphabet; at runtime this file asserts it OBSERVED every kind.
 *   L17 FORWARD-LIFECYCLE-CONSERVATION: a federated forward counts as moved
 *       until the peer is known never to have received it (its retries
 *       failed), then as returned — and the relay's own reading of what the
 *       allocation holds equals the harness's independent one; the forward's
 *       recorded status agrees with its delivery (failed retry ⇒ `failed`,
 *       pending retry ⇒ `pending`, otherwise `delivered`).
 *   L6b REFUND-TO-PAYER: every `allocation_release` credit of an allocation
 *       lands on one of that allocation's hold payers (never a fallback).
 *   L13b A round-2 verdict whose fund action was refused stays retryable: an
 *       `appealed` dispute carrying `fund_refusal` holds its persisted round-2
 *       resolution; and after a read (expire), a claw-back the paid account
 *       can now cover has executed.
 *
 * Alphabet: delegator files, worker files, operator upholds / overturns /
 * splits dispute k (fund_action + split_ratio per dispute-v1 §7.2 from the
 * filer role), the losing side appeals dispute k (§8; single-relay appeals
 * park in `appealed`), and the appeal window expires (every `resolved`
 * dispute is back-dated 25h and read — the lazy-finalize path, §3.3). Time is
 * the only thing the harness moves by hand; every fund movement is the
 * relay's own. Round 5 (the escrow chokepoint) added: a completed receipt
 * through the real route (`settlement-surplus`: fee, payee credit, risk-buffer
 * release), the origin's settlement forward (`forward`, peer down ⇒ pending +
 * retry, through `forwardOriginSettlement`), the retry loop
 * (`processSettlementRetries`) with the peer acknowledging (`forward-deliver`),
 * failing once (`forward-fail`) or failing its last attempt (`retry-exhaust`,
 * the real `refundExhaustedForward`), and `redeposit` (a payee that withdrew
 * receives funds again, so a refused claw-back can become executable).
 *
 * Starting states: locked (pre-settlement escrow), settled (relay-custody,
 * through the real receipt route), released (refunded by the real stale-
 * allocation releaser), p2p settled (trust-layer only, zero escrow), disputed
 * (locked + one delegator dispute already filed), and legacy duplicates
 * (locked or settled + two live disputes a pre-fix relay admitted, with the
 * one-dispute-per-task index unbuildable) — the state in which only the
 * fund-movement chokepoint stands between the escrow and a second payout.
 * The third money finding added: failed (receipt refunded the whole hold, the
 * allocation still `settled`), partial settlement, rerouted (#959: the receipt
 * signer is not the allocation's worker, who holds funds of its own),
 * federated-origin (gross forwarded, no settlement row, allocation `locked`),
 * legacy-final locked/settled (one dispute already final with no claim row and
 * the allocation left `disputed`, as a pre-claim-table relay left it, plus a
 * live duplicate; the upgrade backfill migration then runs), and legacy-paid
 * locked/settled (a dispute whose ledger rows exist but which holds no claim
 * and is still to be finalized). Round 5 added: mismatch-final-locked (C2: a
 * legacy final dispute on A1 naming T2 refunded A1's escrow while T2 was
 * still unsettled), fed-forward-undelivered (C1: a forward recorded before
 * delivery, its retry still pending), round2-clawback-insufficient (P1: the
 * federation round-2 verdict's claw-back refused because the worker
 * withdrew), and lost-task-queue (P2: the queue lost the task's entry while
 * its forward is pending).
 *
 * Enumeration is a memoized DFS over normalized observable states (see
 * `fingerprint`): a step that is rejected, or accepted but changes nothing
 * observable, is a leaf — its continuations equal the parent's, which are
 * enumerated anyway — and a state already expanded with at least the same
 * remaining depth is not expanded again. Every sequence up to the depth is
 * thereby covered, each distinct state once. A world (fresh relay + replayed
 * prefix) is rebuilt only after a step that changed the state. Aperture: the federation (§6.2) resolution/appeal path needs
 * peer relays and is not driven here; it shares the fund-movement chokepoint
 * this harness exercises.
 */
import { appendFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { SyncRelay } from "../index.js";
import { refundExhaustedForward, releaseStaleAllocations } from "../index.js";
import { processSettlementRetries } from "../federation.js";
import { forwardOriginSettlement } from "../federation-callbacks.js";
import { ALLOCATION_MONEY_KINDS } from "../allocation-escrow.js";
import { allocationEscrowHeld } from "../dispute-fund-ledger.js";
import { TaskQueue } from "../task-queue.js";
import { signAdjudicatorVote } from "@motebit/crypto";
import type { DisputeOutcome, VoteRequest } from "@motebit/protocol";
import type { RelayIdentity } from "../federation.js";
import {
  generateKeypair,
  bytesToHex,
  hexToBytes,
  signDisputeRequest,
  signDisputeAppeal,
  signExecutionReceipt,
  hash as sha256,
} from "@motebit/encryption";
import type { MotebitId, DeviceId } from "@motebit/sdk";
import { AUTH_HEADER, JSON_AUTH, createTestRelay, seedX402PaidTask } from "./test-helpers.js";
import {
  creditAccount,
  debitAccount,
  getAccountBalanceDetailed,
  requestWithdrawal,
} from "../accounts.js";
import { relayMigrations } from "../migrations.js";

const MAX_DEPTH = Number(process.env.DISPUTE_HARNESS_DEPTH ?? 6);
const DELEGATOR = "del-cons";
const WORKER = "wrk-cons";
/** A third registered agent: the receipt signer on a re-routed task (#959). */
const OTHER = "oth-cons";
/** The second allocation's parties (mismatch states). */
const DELEGATOR2 = "del2-cons";
const WORKER2 = "wrk2-cons";

type Keypair = { publicKey: Uint8Array; privateKey: Uint8Array };
type StartState =
  | "locked"
  | "settled"
  | "released"
  | "p2p"
  | "disputed"
  | "legacy-dup-locked"
  | "legacy-dup-settled"
  | "failed"
  | "partial"
  | "rerouted"
  | "federated-origin"
  | "legacy-final-locked"
  | "legacy-final-settled"
  | "legacy-paid-locked"
  | "legacy-paid-settled"
  | "mismatch-live"
  | "mismatch-final"
  | "fed-partial"
  | "two-paid"
  | "two-payers"
  | "mismatch-final-locked"
  | "fed-forward-undelivered"
  | "round2-clawback-insufficient"
  | "lost-task-queue";
type Action =
  /** World build: the allocation is opened and its hold taken (once per world). */
  | { kind: "open" }
  | { kind: "settlement-surplus" }
  | { kind: "forward" }
  | { kind: "forward-deliver" }
  | { kind: "forward-fail" }
  | { kind: "retry-exhaust" }
  | { kind: "redeposit" }
  | { kind: "fileD" }
  | { kind: "fileW" }
  | { kind: "fileD2" }
  | { kind: "upheld" | "overturned" | "split"; k: number }
  | { kind: "appeal"; k: number }
  | { kind: "expire" }
  | { kind: "sweep" }
  | { kind: "withdraw" };

const START_STATES: StartState[] = [
  "locked",
  "settled",
  "released",
  "p2p",
  "disputed",
  "legacy-dup-locked",
  "legacy-dup-settled",
  "failed",
  "partial",
  "rerouted",
  "federated-origin",
  "legacy-final-locked",
  "legacy-final-settled",
  "legacy-paid-locked",
  "legacy-paid-settled",
  "mismatch-live",
  "mismatch-final",
  "fed-partial",
  "two-paid",
  "two-payers",
  "mismatch-final-locked",
  "fed-forward-undelivered",
  "round2-clawback-insufficient",
  "lost-task-queue",
];

/**
 * Every kind of allocation-money movement (`ALLOCATION_MONEY_KINDS`,
 * allocation-escrow.ts) → the actions of this alphabet that drive it. The gate
 * `check-allocation-money-chokepoint` fails when a kind used in source is
 * missing here or maps to an action this alphabet does not have; the last test
 * below fails when a kind was never observed across the run.
 */
const KIND_ACTIONS = {
  hold: ["open"],
  settlement_fee: ["settlement-surplus"],
  settlement_credit: ["settlement-surplus"],
  settlement_release: ["settlement-surplus"],
  federated_forward: ["forward"],
  forward_return: ["retry-exhaust"],
  retry_exhaustion_refund: ["retry-exhaust"],
  sweep_refund: ["sweep"],
  dispute_clawback: ["upheld", "overturned", "split", "expire"],
  dispute_worker: ["upheld", "split", "expire"],
  dispute_delegator: ["overturned", "split", "expire"],
} satisfies Record<string, ReadonlyArray<Action["kind"]>>;

/** Kinds observed across every world of the run (the runtime half of L16). */
const observedKinds = new Set<string>();
let startStatesRun = 0;

/** The executing peer a federated origin forwards to (fetch is stubbed). */
const PEER_ID = "relay-peer";
const PEER_URL = "http://peer.cons.test";
/** Whether the stubbed peer acknowledges a settlement forward. */
let peerAcks = false;
/** Round-1 / round-2 votes the stubbed federation adjudicators cast (P1 world). */
const VOTES: Map<number, DisputeOutcome> = new Map([
  [1, "overturned"],
  [2, "overturned"],
]);
interface VotingPeer {
  id: string;
  url: string;
  kp: Keypair;
}
let votingPeers: VotingPeer[] = [];

function label(a: Action): string {
  return "k" in a ? `${a.kind}(${a.k})` : a.kind;
}

interface World {
  relay: SyncRelay;
  taskId: string;
  allocationId: string;
  /** Dispute ids in filing order — the `k` of the alphabet. */
  disputes: string[];
  /** Live disputes the start state already held (legacy duplicates). */
  startLive: number;
  /** Highest ledger rowid the start state holds — rows up to it are given. */
  startTxMax: number;
  /** A second allocation (D2 → W2, settled) — the mismatch states. */
  alt?: { allocationId: string; taskId: string };
  /** task_id → submitting delegator: what the stale sweep resolves (index.ts). */
  delegators: Map<string, string>;
  /** The allocation's delegator (hold payer): DELEGATOR, or the relay itself (P1). */
  delegator: string;
  /** The start state this world was built from (scopes the alphabet). */
  start: StartState;
}

interface Violation {
  start: StartState;
  sequence: string;
  law: string;
  detail: string;
}

let delegatorKp: Keypair;
let workerKp: Keypair;
let otherKp: Keypair;
let delegator2Kp: Keypair;
let worker2Kp: Keypair;
let seq = 0;

/** The relay identity of the world being driven (P1: the relay is the delegator). */
let currentRelay: SyncRelay | null = null;

/** The relay's full signing identity, read from its own table (tests run unencrypted). */
function relayIdentityOf(relay: SyncRelay): RelayIdentity {
  const row = relay.moteDb.db
    .prepare(
      "SELECT relay_motebit_id, public_key, private_key_hex, did FROM relay_identity LIMIT 1",
    )
    .get() as {
    relay_motebit_id: string;
    public_key: string;
    private_key_hex: string;
    did: string;
  };
  return {
    relayMotebitId: row.relay_motebit_id,
    publicKey: hexToBytes(row.public_key),
    privateKey: hexToBytes(row.private_key_hex),
    publicKeyHex: row.public_key,
    did: row.did,
  };
}

function kpOf(id: string): Keypair {
  if (currentRelay && id === currentRelay.relayIdentity.relayMotebitId) {
    const ident = relayIdentityOf(currentRelay);
    return { publicKey: ident.publicKey, privateKey: ident.privateKey };
  }
  if (id === DELEGATOR) return delegatorKp;
  if (id === WORKER) return workerKp;
  if (id === DELEGATOR2) return delegator2Kp;
  if (id === WORKER2) return worker2Kp;
  return otherKp;
}

async function register(relay: SyncRelay, motebitId: string, kp: Keypair): Promise<void> {
  const res = await relay.app.request(`/api/v1/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...AUTH_HEADER },
    body: JSON.stringify({
      motebit_id: motebitId,
      endpoint_url: "http://localhost:9999/mcp",
      capabilities: ["web_search"],
      public_key: bytesToHex(kp.publicKey),
    }),
  });
  if (res.status !== 200) throw new Error(`register ${motebitId}: ${res.status}`);
}

async function settleViaReceipt(
  relay: SyncRelay,
  taskId: string,
  opts: { status?: "completed" | "failed"; signer?: "worker" | "other"; worker?: string } = {},
): Promise<void> {
  const routeWorker = opts.worker ?? WORKER;
  const signerId = opts.signer === "other" ? OTHER : routeWorker;
  const signerKp = kpOf(signerId);
  const enc = new TextEncoder();
  const receipt = await signExecutionReceipt(
    {
      task_id: taskId,
      relay_task_id: taskId,
      motebit_id: signerId as unknown as MotebitId,
      device_id: "svc" as unknown as DeviceId,
      submitted_at: Date.now() - 1000,
      completed_at: Date.now(),
      status: opts.status ?? "completed",
      result: "done",
      tools_used: ["web_search"],
      memories_formed: 0,
      prompt_hash: await sha256(enc.encode("search for something")),
      result_hash: await sha256(enc.encode("done")),
    },
    signerKp.privateKey,
  );
  const res = await relay.app.request(`/agent/${routeWorker}/task/${taskId}/result`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(receipt),
  });
  if (res.status !== 200) throw new Error(`receipt: ${res.status} ${await res.text()}`);
}

async function fileDispute(w: World, by: "D" | "W" | "D2"): Promise<Response> {
  seq += 1;
  const onAlt = by === "D2";
  const filedBy = by === "D" ? w.delegator : by === "W" ? WORKER : DELEGATOR2;
  const respondent = by === "D" ? WORKER : by === "W" ? w.delegator : WORKER2;
  const taskId = onAlt ? w.alt!.taskId : w.taskId;
  const allocationId = onAlt ? w.alt!.allocationId : w.allocationId;
  const disputeId = `dsp-cons-${seq}`;
  const signed = await signDisputeRequest(
    {
      dispute_id: disputeId,
      task_id: taskId,
      allocation_id: allocationId,
      filed_by: filedBy,
      respondent,
      category: "quality",
      description: "contested",
      evidence_refs: ["receipt-1"],
      filed_at: Date.now(),
    },
    kpOf(filedBy).privateKey,
  );
  const res = await w.relay.app.request(`/api/v1/allocations/${allocationId}/dispute`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(signed),
  });
  if (res.status === 200) w.disputes.push(disputeId);
  return res;
}

async function buildWorld(start: StartState): Promise<World> {
  const relay = await createTestRelay({ enableDeviceAuth: false });
  currentRelay = relay;
  peerAcks = false;
  await register(relay, DELEGATOR, delegatorKp);
  await register(relay, WORKER, workerKp);
  insertPeer(relay, PEER_ID, PEER_URL, bytesToHex(otherKp.publicKey));
  if (start === "p2p") {
    const taskId = "task-p2p-cons";
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_settlements
         (settlement_id, allocation_id, task_id, motebit_id, receipt_hash,
          amount_settled, platform_fee, platform_fee_rate, status, settled_at,
          settlement_mode, p2p_tx_hash, payment_verification_status, delegator_id)
         VALUES ('stl-p2p-cons', 'p2p-alloc-cons', ?, ?, '', 0, 0, 0, 'completed', ?,
                 'p2p', 'fakeTxHash', 'pending', ?)`,
      )
      .run(taskId, WORKER, Date.now(), DELEGATOR);
    return {
      relay,
      taskId,
      allocationId: "p2p-alloc-cons",
      disputes: [],
      startLive: 0,
      startTxMax: maxRowid(relay),
      delegators: new Map([[taskId, DELEGATOR]]),
      delegator: DELEGATOR,
      start,
    };
  }
  if (start === "round2-clawback-insufficient") return buildRound2ClawbackInsufficient(relay);
  const taskId = seedX402PaidTask(relay, {
    workerId: WORKER,
    delegatorId: DELEGATOR,
    prompt: "search for something",
    unitCostUsd: 1.0,
  });
  const w: World = {
    relay,
    taskId,
    allocationId: `x402-${taskId}`,
    disputes: [],
    startLive: 0,
    startTxMax: 0,
    delegators: new Map([[taskId, DELEGATOR]]),
    delegator: DELEGATOR,
    start,
  };
  if (start === "mismatch-live" || start === "mismatch-final") {
    await seedMismatch(w, start === "mismatch-final");
  }
  if (start === "mismatch-final-locked") await seedMismatchFinalLocked(w);
  if (start === "fed-forward-undelivered" || start === "lost-task-queue") {
    seedUndeliveredForward(w, { riskBuffer: start === "lost-task-queue" });
    if (start === "lost-task-queue") {
      // P2: the task queue lost the entry (restart, TTL, eviction) — neither
      // the retry refund nor the sweep can resolve a submitter from it.
      new TaskQueue(relay.moteDb.db).delete(taskId);
      w.delegators = new Map();
    }
  }
  if (start === "two-paid" || start === "two-payers") {
    await register(relay, OTHER, otherKp);
    if (start === "two-paid") seedTwoPaid(w);
    else {
      await settleViaReceipt(relay, taskId);
      seedSecondPayer(w);
    }
  }
  if (
    start === "settled" ||
    start === "legacy-dup-settled" ||
    start === "legacy-final-settled" ||
    start === "legacy-paid-settled"
  ) {
    await settleViaReceipt(relay, taskId);
  }
  if (start === "failed") await settleViaReceipt(relay, taskId, { status: "failed" });
  if (start === "rerouted") {
    // #959: the receipt signer is not the allocation's worker. The signer is
    // credited; the allocation's worker holds unrelated funds of its own.
    await register(relay, OTHER, otherKp);
    creditAccount(relay.moteDb.db, WORKER, 5_000_000, "deposit", "wrk-own", "worker's own funds");
    await settleViaReceipt(relay, taskId, { signer: "other" });
  }
  if (start === "partial") seedPartialSettlement(w);
  if (start === "federated-origin" || start === "fed-partial") {
    // The origin relay forwarded the task's gross to the executing peer
    // (relay_federation_settlements) — no relay_settlements row, and the
    // allocation row is never touched by that path, so it stays `locked`.
    const snap = relay.moteDb.db
      .prepare("SELECT amount_locked FROM relay_allocations WHERE allocation_id = ?")
      .get(w.allocationId) as { amount_locked: number };
    relay.moteDb.db
      .prepare(
        `INSERT INTO relay_federation_settlements
         (settlement_id, task_id, upstream_relay_id, downstream_relay_id, agent_id,
          gross_amount, fee_amount, net_amount, fee_rate, settled_at, receipt_hash)
         VALUES ('fed-stl-cons', ?, 'relay-self', 'relay-peer', NULL, ?, ?, ?, 0.05, ?, 'rh')`,
      )
      .run(
        taskId,
        forwardedGross(start, snap.amount_locked),
        0,
        forwardedGross(start, snap.amount_locked),
        Date.now(),
      );
    // A pre-lifecycle forward, as an upgraded relay holds it.
    runUpgradeBackfill(relay);
  }
  if (start === "legacy-final-locked" || start === "legacy-final-settled") {
    await seedLegacyFinal(w, start === "legacy-final-locked" ? "upheld" : "overturned");
  }
  if (start === "legacy-paid-locked" || start === "legacy-paid-settled") {
    await seedLegacyPaidUnclaimed(w, start === "legacy-paid-settled");
  }
  if (start === "released") {
    const n = releaseStaleAllocations(relay.moteDb.db, Date.now() + 1000, 0, () => DELEGATOR);
    if (n !== 1) throw new Error(`release: ${n}`);
  }
  if (start === "disputed") {
    const res = await fileDispute(w, "D");
    if (res.status !== 200) throw new Error(`pre-dispute: ${res.status}`);
    w.startLive = 1;
  }
  if (start === "legacy-dup-locked" || start === "legacy-dup-settled") {
    // Two live disputes on one allocation, as a pre-fix relay admitted them:
    // the delegator's through the route, the worker's written in the route's
    // exact row shape. A database holding such rows cannot build the
    // one-dispute-per-task index (it is dropped here to model that), so the
    // fund-movement chokepoint is the only line left.
    const res = await fileDispute(w, "D");
    if (res.status !== 200) throw new Error(`pre-dispute: ${res.status}`);
    const db = relay.moteDb.db;
    dropOneLiveIndex(relay);
    const first = db
      .prepare("SELECT amount_locked, filing_fee FROM relay_disputes WHERE dispute_id = ?")
      .get(w.disputes[0]) as { amount_locked: number; filing_fee: number };
    seq += 1;
    const legacyId = `dsp-cons-${seq}`;
    db.prepare(
      `INSERT INTO relay_disputes
       (dispute_id, task_id, allocation_id, filed_by, respondent, category, description, state,
        amount_locked, filing_fee, filed_at, evidence_deadline, body_json, filer_role)
       VALUES (?, ?, ?, ?, ?, 'quality', 'contested', 'evidence', ?, ?, ?, ?, '', 'worker')`,
    ).run(
      legacyId,
      taskId,
      w.allocationId,
      WORKER,
      DELEGATOR,
      first.amount_locked,
      first.filing_fee,
      Date.now(),
      Date.now() + 48 * 3600_000,
    );
    w.disputes.push(legacyId);
    w.startLive = 2;
  }
  w.startTxMax = maxRowid(relay);
  return w;
}

function maxRowid(relay: SyncRelay): number {
  return (
    relay.moteDb.db
      .prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM relay_transactions")
      .get() as {
      m: number;
    }
  ).m;
}

/**
 * A partial settlement in the exact row shape the receipt route writes
 * (tasks.ts): half the gross settled — worker credited the net under the
 * settlement id, the unsettled remainder released to the delegator under the
 * allocation id, the allocation claimed `settled`.
 */
function seedPartialSettlement(w: World): void {
  const db = w.relay.moteDb.db;
  const { amount_locked: held } = db
    .prepare("SELECT amount_locked FROM relay_allocations WHERE allocation_id = ?")
    .get(w.allocationId) as { amount_locked: number };
  const gross = Math.floor(held / 2);
  const fee = Math.round(gross * 0.05);
  const net = gross - fee;
  db.prepare(
    "UPDATE relay_allocations SET status = 'settled', settled_at = ? WHERE allocation_id = ?",
  ).run(Date.now(), w.allocationId);
  db.prepare(
    `INSERT INTO relay_settlements
     (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, amount_settled,
      platform_fee, platform_fee_rate, status, settled_at, settlement_mode, delegator_id)
     VALUES ('stl-partial-cons', ?, ?, ?, 'rh', ?, ?, 0.05, 'partial', ?, 'relay', ?)`,
  ).run(w.allocationId, w.taskId, WORKER, net, fee, Date.now(), DELEGATOR);
  creditAccount(db, WORKER, net, "settlement_credit", "stl-partial-cons", "Payment (partial)");
  creditAccount(
    db,
    DELEGATOR,
    held - gross,
    "allocation_release",
    w.allocationId,
    "Partial release",
  );
}

/** fed-partial: the forward is the price, the hold also carried a risk buffer. */
const RISK_BUFFER = 52_632;
function forwardedGross(start: StartState, locked: number): number {
  return start === "fed-partial" ? locked - RISK_BUFFER : locked;
}

/** Drop every unique index on relay_disputes to model a legacy DB that cannot build one. */
function dropOneLiveIndex(relay: SyncRelay): void {
  const db = relay.moteDb.db;
  const idx = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'relay_disputes' AND sql LIKE 'CREATE UNIQUE%'",
    )
    .all() as Array<{ name: string }>;
  for (const { name } of idx) db.exec(`DROP INDEX IF EXISTS "${name}"`);
}

/**
 * F1: a legacy dispute row on allocation A1 (D → W, locked) whose task_id
 * names A2's task (D2 → W2, settled through the real receipt route) — the
 * shape a relay before the §4.2 task binding admitted. Live: it sits in
 * `evidence` with A1 `disputed`. Final: the pre-fix relay ran its fund action
 * keyed on the dispute's task (main's post-settlement path: split of T2's
 * net, W2 → D2) and left A1 `disputed`; the upgrade migration then runs.
 */
async function seedMismatch(w: World, final: boolean): Promise<void> {
  const relay = w.relay;
  const db = relay.moteDb.db;
  await register(relay, DELEGATOR2, delegator2Kp);
  await register(relay, WORKER2, worker2Kp);
  const t2 = seedX402PaidTask(relay, {
    workerId: WORKER2,
    delegatorId: DELEGATOR2,
    prompt: "search for something",
    unitCostUsd: 1.0,
  });
  await settleViaReceipt(relay, t2, { worker: WORKER2 });
  w.alt = { allocationId: `x402-${t2}`, taskId: t2 };
  w.delegators.set(t2, DELEGATOR2);
  const { amount_locked: locked } = db
    .prepare("SELECT amount_locked FROM relay_allocations WHERE allocation_id = ?")
    .get(w.allocationId) as { amount_locked: number };
  seq += 1;
  const d0 = `dsp-cons-${seq}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO relay_disputes
     (dispute_id, task_id, allocation_id, filed_by, respondent, category, description, state,
      amount_locked, filing_fee, filed_at, evidence_deadline, body_json, filer_role)
     VALUES (?, ?, ?, ?, ?, 'quality', 'contested', 'evidence', ?, 0, ?, ?, '', 'delegator')`,
  ).run(d0, t2, w.allocationId, DELEGATOR, WORKER, locked, now, now + 48 * 3600_000);
  db.prepare("UPDATE relay_allocations SET status = 'disputed' WHERE allocation_id = ?").run(
    w.allocationId,
  );
  w.disputes.push(d0);
  w.startLive = 1;
  // A mismatched row predates the §4.2 binding, so a relay running this code
  // has run the upgrade migration over it — live (here) or final (below).
  if (!final) runUpgradeBackfill(relay);
  if (final) {
    const { amount_settled: net } = db
      .prepare("SELECT amount_settled FROM relay_settlements WHERE task_id = ?")
      .get(t2) as { amount_settled: number };
    const back = net - Math.floor(net * 0.5);
    debitAccount(db, WORKER2, back, "settlement_debit", d0, "Dispute claw-back (legacy)");
    creditAccount(db, DELEGATOR2, back, "settlement_credit", d0, "Dispute refund (legacy)");
    db.prepare(
      `UPDATE relay_disputes SET state = 'final', resolution = 'split', fund_action = 'split',
         split_ratio = 0.5, resolved_at = ?, final_at = ? WHERE dispute_id = ?`,
    ).run(now, now, d0);
    runUpgradeBackfill(relay);
  }
}

/**
 * Two accounts hold the settlement's credit (a payee split under one
 * settlement id): no single paid account to reverse from — unroutable.
 */
function seedTwoPaid(w: World): void {
  const db = w.relay.moteDb.db;
  const { amount_locked: held } = db
    .prepare("SELECT amount_locked FROM relay_allocations WHERE allocation_id = ?")
    .get(w.allocationId) as { amount_locked: number };
  const fee = Math.round(held * 0.05);
  const net = held - fee;
  const half = Math.floor(net / 2);
  db.prepare(
    "UPDATE relay_allocations SET status = 'settled', settled_at = ? WHERE allocation_id = ?",
  ).run(Date.now(), w.allocationId);
  db.prepare(
    `INSERT INTO relay_settlements
     (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, amount_settled,
      platform_fee, platform_fee_rate, status, settled_at, settlement_mode, delegator_id)
     VALUES ('stl-two-cons', ?, ?, ?, 'rh', ?, ?, 0.05, 'completed', ?, 'relay', ?)`,
  ).run(w.allocationId, w.taskId, WORKER, net, fee, Date.now(), DELEGATOR);
  creditAccount(db, WORKER, half, "settlement_credit", "stl-two-cons", "Payment (split payee)");
  creditAccount(
    db,
    OTHER,
    net - half,
    "settlement_credit",
    "stl-two-cons",
    "Payment (split payee)",
  );
}

/**
 * A second account also funded the allocation's hold (and was released its
 * share): the ledger names no single hold payer to refund — unroutable.
 */
function seedSecondPayer(w: World): void {
  const db = w.relay.moteDb.db;
  creditAccount(db, OTHER, 100_000, "deposit", "oth-dep", "other's funds");
  debitAccount(db, OTHER, 100_000, "allocation_hold", w.allocationId, "co-funded hold");
  creditAccount(db, OTHER, 100_000, "allocation_release", w.allocationId, "co-funded release");
}

function insertPeer(
  relay: SyncRelay,
  id: string,
  url: string,
  publicKeyHex: string,
  state = "suspended",
): void {
  relay.moteDb.db
    .prepare(
      `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, missed_heartbeats, agent_count, trust_score, peered_at, last_heartbeat_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0.5, ?, ?)`,
    )
    .run(id, publicKeyHex, url, id, state, Date.now(), Date.now());
}

/** The task's gross price (the queue's price snapshot; the hold carries a risk buffer on top). */
function priceOf(w: World, taskId: string): number {
  const snap = new TaskQueue(w.relay.moteDb.db).get(taskId)?.price_snapshot;
  if (snap != null) return snap;
  const { amount_locked: locked } = w.relay.moteDb.db
    .prepare("SELECT amount_locked FROM relay_allocations WHERE task_id = ?")
    .get(taskId) as { amount_locked: number };
  return locked - RISK_BUFFER;
}

/**
 * C2 — the legacy cross-allocation dispute that moved the OTHER allocation's
 * money: D0 sits on A1 (D → W, locked) naming A2's task while A2 (D2 → W2) is
 * still UNSETTLED. A pre-binding relay finalized it on the pre-settlement path:
 * A1's escrow refunded to its delegator under D0's id, A1 left `disputed`.
 * The upgrade migrations then run.
 */
async function seedMismatchFinalLocked(w: World): Promise<void> {
  const relay = w.relay;
  const db = relay.moteDb.db;
  await register(relay, DELEGATOR2, delegator2Kp);
  await register(relay, WORKER2, worker2Kp);
  const t2 = seedX402PaidTask(relay, {
    workerId: WORKER2,
    delegatorId: DELEGATOR2,
    prompt: "search for something",
    unitCostUsd: 1.0,
  });
  w.alt = { allocationId: `x402-${t2}`, taskId: t2 };
  w.delegators.set(t2, DELEGATOR2);
  const { amount_locked: locked } = db
    .prepare("SELECT amount_locked FROM relay_allocations WHERE allocation_id = ?")
    .get(w.allocationId) as { amount_locked: number };
  seq += 1;
  const d0 = `dsp-cons-${seq}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO relay_disputes
     (dispute_id, task_id, allocation_id, filed_by, respondent, category, description, state,
      amount_locked, filing_fee, filed_at, evidence_deadline, body_json, filer_role,
      resolution, fund_action, split_ratio, resolved_at, final_at)
     VALUES (?, ?, ?, ?, ?, 'quality', 'contested', 'final', ?, 0, ?, ?, '', 'delegator',
             'upheld', 'refund_to_delegator', 0, ?, ?)`,
  ).run(d0, t2, w.allocationId, DELEGATOR, WORKER, locked, now, now + 48 * 3600_000, now, now);
  creditAccount(db, DELEGATOR, locked, "settlement_credit", d0, "Dispute refund (legacy)");
  db.prepare("UPDATE relay_allocations SET status = 'disputed' WHERE allocation_id = ?").run(
    w.allocationId,
  );
  w.disputes.push(d0);
  runUpgradeBackfill(relay);
}

/**
 * C1 — a federated origin recorded its settlement forward BEFORE delivery and
 * the peer never acknowledged: the forward row (in the shape the pre-lifecycle
 * relay wrote it) and its pending retry. The upgrade migration then runs.
 */
function seedUndeliveredForward(w: World, opts: { riskBuffer?: boolean } = {}): void {
  const db = w.relay.moteDb.db;
  // With a risk buffer the hold exceeds the forward, so the exhaustion refund
  // pays something even where the forward is (wrongly) counted as moved — P2's
  // payee question then stands on its own.
  const gross = opts.riskBuffer ? priceOf(w, w.taskId) - RISK_BUFFER : priceOf(w, w.taskId);
  const settlementId = "fed-stl-undelivered";
  db.prepare(
    `INSERT INTO relay_federation_settlements
     (settlement_id, task_id, upstream_relay_id, downstream_relay_id, agent_id,
      gross_amount, fee_amount, net_amount, fee_rate, settled_at, receipt_hash)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0.05, ?, 'rh')`,
  ).run(
    settlementId,
    w.taskId,
    w.relay.relayIdentity.relayMotebitId,
    PEER_ID,
    gross,
    Math.round(gross * 0.05),
    gross - Math.round(gross * 0.05),
    Date.now(),
  );
  db.prepare(
    `INSERT INTO relay_settlement_retries (retry_id, settlement_id, task_id, peer_relay_id, payload_json, attempts, max_attempts, next_retry_at, status, created_at)
     VALUES ('retry-cons', ?, ?, ?, ?, 0, 8, 0, 'pending', ?)`,
  ).run(
    settlementId,
    w.taskId,
    PEER_ID,
    JSON.stringify({ task_id: w.taskId, settlement_id: settlementId, gross_amount: gross }),
    Date.now(),
  );
  runUpgradeBackfill(w.relay);
}

/**
 * P1 — a federation-path dispute (the RELAY is the delegator, so its verdict
 * is adjudicated by peer votes, §6.2/§8.3): settled to the worker, who
 * withdrew once the 24h window passed, then filed. Round 1 and round 2 both
 * refund the delegator; round 2's claw-back is refused (the worker holds
 * nothing) — the dispute is left `appealed`, marked.
 */
async function buildRound2ClawbackInsufficient(relay: SyncRelay): Promise<World> {
  const db = relay.moteDb.db;
  const relayId = relay.relayIdentity.relayMotebitId;
  for (const p of votingPeers) insertPeer(relay, p.id, p.url, bytesToHex(p.kp.publicKey), "active");
  const taskId = seedX402PaidTask(relay, {
    workerId: WORKER,
    delegatorId: relayId,
    prompt: "search for something",
    unitCostUsd: 1.0,
  });
  const w: World = {
    relay,
    taskId,
    allocationId: `x402-${taskId}`,
    disputes: [],
    startLive: 0,
    startTxMax: 0,
    delegators: new Map([[taskId, relayId]]),
    delegator: relayId,
    start: "round2-clawback-insufficient",
  };
  await settleViaReceipt(relay, taskId);
  db.prepare("UPDATE relay_settlements SET settled_at = ? WHERE task_id = ?").run(
    Date.now() - 25 * 3600_000,
    taskId,
  );
  if (withdrawAll(w) === 0) throw new Error("round2: worker could not withdraw");
  const filed = await fileDispute(w, "W");
  if (filed.status !== 200) throw new Error(`round2 file: ${filed.status} ${await filed.text()}`);
  const resolved = await relay.app.request(`/api/v1/disputes/${w.disputes[0]}/resolve`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({
      resolution: "overturned",
      rationale: "ignored on the federation path",
      fund_action: "refund_to_delegator",
    }),
  });
  if (resolved.status !== 200) throw new Error(`round2 resolve: ${resolved.status}`);
  const appeal = await signDisputeAppeal(
    {
      dispute_id: w.disputes[0]!,
      appealed_by: WORKER,
      reason: "disagree",
      appealed_at: Date.now(),
    },
    workerKp.privateKey,
  );
  const appealed = await relay.app.request(`/api/v1/disputes/${w.disputes[0]}/appeal`, {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify(appeal),
  });
  // The round-2 finalize is refused (500): the claw-back exceeds what the
  // worker holds.
  if (appealed.status !== 500) throw new Error(`round2 appeal: ${appealed.status}`);
  w.startLive = 1;
  w.startTxMax = maxRowid(relay);
  return w;
}

/** Every payee withdraws what the relay lets it (the account drained). */
function withdrawAll(w: World): number {
  const db = w.relay.moteDb.db;
  let moved = 0;
  for (const acct of [WORKER, OTHER, WORKER2]) {
    const avail = getAccountBalanceDetailed(db, acct).available_for_withdrawal;
    if (avail <= 0) continue;
    seq += 1;
    if (requestWithdrawal(db, acct, avail, "pending", `wd-cons-${seq}`) !== null) moved += 1;
  }
  return moved;
}

/** Back-date every `resolved` dispute's window and read it — lazy finalize. */
async function expireAll(w: World): Promise<void> {
  w.relay.moteDb.db
    .prepare(
      "UPDATE relay_disputes SET resolved_at = ? WHERE state = 'resolved' AND appealed_at IS NULL",
    )
    .run(Date.now() - 25 * 60 * 60 * 1000);
  for (const id of w.disputes)
    await w.relay.app.request(`/api/v1/disputes/${id}`, { headers: AUTH_HEADER });
}

/**
 * The pre-claim-table shape at upgrade (C2): dispute 0 reached `final` and its
 * fund action ran on a relay with no relay_dispute_fund_actions table — so no
 * claim row, and that relay left the allocation `disputed`. A second, legacy
 * duplicate dispute is still live. The upgrade's migration then runs.
 */
async function seedLegacyFinal(w: World, verdict: "upheld" | "overturned"): Promise<void> {
  const res = await fileDispute(w, "D");
  if (res.status !== 200) throw new Error(`legacy-final file: ${res.status}`);
  if ((await step(w, { kind: verdict, k: 0 })) !== 200) throw new Error("legacy-final resolve");
  await expireAll(w);
  const db = w.relay.moteDb.db;
  db.exec("DELETE FROM relay_dispute_fund_actions");
  db.prepare("UPDATE relay_allocations SET status = 'disputed' WHERE allocation_id = ?").run(
    w.allocationId,
  );
  insertLegacyLiveDispute(w);
  w.startLive = 2;
  runUpgradeBackfill(w.relay);
}

/**
 * A dispute that already moved money but holds no claim row: its ledger rows
 * reference it, it sits `resolved` and is still to be finalized. Locked: the
 * escrow was refunded to the delegator. Settled: a split was applied — half
 * the worker's net clawed back to the delegator.
 */
async function seedLegacyPaidUnclaimed(w: World, settled: boolean): Promise<void> {
  const res = await fileDispute(w, "D");
  if (res.status !== 200) throw new Error(`legacy-paid file: ${res.status}`);
  const verdict = settled ? "split" : "upheld";
  if ((await step(w, { kind: verdict, k: 0 })) !== 200) throw new Error("legacy-paid resolve");
  const db = w.relay.moteDb.db;
  const d0 = w.disputes[0]!;
  if (settled) {
    const { amount_settled: net } = db
      .prepare("SELECT amount_settled FROM relay_settlements WHERE allocation_id = ?")
      .get(w.allocationId) as { amount_settled: number };
    const back = net - Math.floor(net * 0.5);
    debitAccount(db, WORKER, back, "settlement_debit", d0, "Dispute claw-back (legacy)");
    creditAccount(db, DELEGATOR, back, "settlement_credit", d0, "Dispute refund (legacy)");
  } else {
    const { amount_locked: locked } = db
      .prepare("SELECT amount_locked FROM relay_allocations WHERE allocation_id = ?")
      .get(w.allocationId) as { amount_locked: number };
    creditAccount(db, DELEGATOR, locked, "settlement_credit", d0, "Dispute refund (legacy)");
  }
  w.startLive = 1;
  runUpgradeBackfill(w.relay);
}

function insertLegacyLiveDispute(w: World): void {
  const db = w.relay.moteDb.db;
  dropOneLiveIndex(w.relay);
  const first = db
    .prepare("SELECT amount_locked, filing_fee FROM relay_disputes WHERE dispute_id = ?")
    .get(w.disputes[0]) as { amount_locked: number; filing_fee: number };
  seq += 1;
  const legacyId = `dsp-cons-${seq}`;
  db.prepare(
    `INSERT INTO relay_disputes
     (dispute_id, task_id, allocation_id, filed_by, respondent, category, description, state,
      amount_locked, filing_fee, filed_at, evidence_deadline, body_json, filer_role)
     VALUES (?, ?, ?, ?, ?, 'quality', 'contested', 'evidence', ?, ?, ?, ?, '', 'worker')`,
  ).run(
    legacyId,
    w.taskId,
    w.allocationId,
    WORKER,
    DELEGATOR,
    first.amount_locked,
    first.filing_fee,
    Date.now(),
    Date.now() + 48 * 3600_000,
  );
  w.disputes.push(legacyId);
}

/** Run the upgrade's dispute fund-action backfill migration, as boot would. */
function runUpgradeBackfill(relay: SyncRelay): void {
  // Each upgrade step that brings pre-existing rows onto the current model
  // (a relay without one simply has none to run).
  for (const name of ["dispute_fund_actions_backfill", "allocation_escrow_chokepoint"]) {
    relayMigrations.find((m) => m.name === name)?.up(relay.moteDb.db);
  }
}

function filerOf(w: World, k: number): "delegator" | "worker" {
  const row = w.relay.moteDb.db
    .prepare("SELECT filed_by, filer_role FROM relay_disputes WHERE dispute_id = ?")
    .get(w.disputes[k]) as { filed_by: string; filer_role: string | null };
  if (row.filer_role === "worker" || row.filer_role === "delegator") return row.filer_role;
  return row.filed_by === WORKER || row.filed_by === WORKER2 ? "worker" : "delegator";
}

/** One step through the real routes. Returns the HTTP status (200 for expiry). */
async function step(w: World, a: Action): Promise<number> {
  const app = w.relay.app;
  switch (a.kind) {
    case "fileD":
      return (await fileDispute(w, "D")).status;
    case "fileW":
      return (await fileDispute(w, "W")).status;
    case "fileD2":
      return (await fileDispute(w, "D2")).status;
    case "sweep": {
      // The stale-allocation releaser exactly as the relay's interval runs it
      // (index.ts), with every allocation past the horizon.
      releaseStaleAllocations(w.relay.moteDb.db, Date.now() + 1000, 0, (t) => w.delegators.get(t));
      return 200;
    }
    case "withdraw":
      return withdrawAll(w) > 0 ? 200 : 402;
    case "open":
      return 200; // the world build (seedX402PaidTask: openAllocation + the hold)
    case "redeposit": {
      // A payee that withdrew receives funds again (a later settlement, a
      // deposit): a refused claw-back can then execute on the next read.
      if (getAccountBalanceDetailed(w.relay.moteDb.db, WORKER).balance >= 5_000_000) return 404;
      creditAccount(w.relay.moteDb.db, WORKER, 5_000_000, "deposit", `redep-${++seq}`, "deposit");
      return 200;
    }
    case "settlement-surplus": {
      // A completed receipt through the real route: fee, payee credit and the
      // risk-buffer surplus back to the hold payer.
      try {
        await settleViaReceipt(w.relay, w.taskId);
        return 200;
      } catch {
        return 409;
      }
    }
    case "forward": {
      // The origin's settlement forward with the peer down: recorded pending,
      // retry queued (federation-callbacks.ts forwardOriginSettlement).
      try {
        const r = await forwardOriginSettlement(w.relay.moteDb.db, relayIdentityOf(w.relay), {
          taskId: w.taskId,
          peerRelayId: PEER_ID,
          grossAmount: priceOf(w, w.taskId),
          platformFeeRate: 0.05,
          receiptHash: "rh",
          x402TxHash: null,
          x402Network: null,
        });
        return r === "refused" ? 409 : 200;
      } catch {
        return 500;
      }
    }
    case "forward-deliver":
    case "forward-fail":
    case "retry-exhaust": {
      const db = w.relay.moteDb.db;
      const due = db
        .prepare("SELECT COUNT(*) AS n FROM relay_settlement_retries WHERE status = 'pending'")
        .get() as { n: number };
      if (due.n === 0) return 404;
      db.prepare(
        a.kind === "retry-exhaust"
          ? "UPDATE relay_settlement_retries SET next_retry_at = 0, attempts = max_attempts - 1 WHERE status = 'pending'"
          : "UPDATE relay_settlement_retries SET next_retry_at = 0 WHERE status = 'pending'",
      ).run();
      peerAcks = a.kind === "forward-deliver";
      try {
        await processSettlementRetries(db, relayIdentityOf(w.relay), (retry) => {
          refundExhaustedForward(db, retry);
        });
      } finally {
        peerAcks = false;
      }
      return 200;
    }
    case "upheld":
    case "overturned":
    case "split": {
      // dispute-v1 §7.2: fund action from (resolution, filer_role).
      const workerWins =
        a.kind === "split" ? null : (a.kind === "upheld") === (filerOf(w, a.k) === "worker");
      const body =
        workerWins === null
          ? { resolution: "split", fund_action: "split", split_ratio: 0.5 }
          : workerWins
            ? { resolution: a.kind, fund_action: "release_to_worker", split_ratio: 1 }
            : { resolution: a.kind, fund_action: "refund_to_delegator", split_ratio: 0 };
      const res = await app.request(`/api/v1/disputes/${w.disputes[a.k]}/resolve`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ ...body, rationale: "operator verdict" }),
      });
      return res.status;
    }
    case "appeal": {
      const d = w.relay.moteDb.db
        .prepare("SELECT respondent FROM relay_disputes WHERE dispute_id = ?")
        .get(w.disputes[a.k]) as { respondent: string };
      const kp = kpOf(d.respondent);
      const signed = await signDisputeAppeal(
        {
          dispute_id: w.disputes[a.k]!,
          appealed_by: d.respondent,
          reason: "disagree",
          appealed_at: Date.now(),
        },
        kp.privateKey,
      );
      const res = await app.request(`/api/v1/disputes/${w.disputes[a.k]}/appeal`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify(signed),
      });
      return res.status;
    }
    case "expire": {
      const past = Date.now() - 25 * 60 * 60 * 1000;
      w.relay.moteDb.db
        .prepare(
          "UPDATE relay_disputes SET resolved_at = ? WHERE state = 'resolved' AND appealed_at IS NULL",
        )
        .run(past);
      for (const id of w.disputes) {
        const res = await app.request(`/api/v1/disputes/${id}`, { headers: AUTH_HEADER });
        if (res.status !== 200) return res.status;
      }
      return 200;
    }
  }
}

/**
 * Where the round-5 movements are driven. Each applies in every start state
 * whose allocation can reach it — a pending task with its escrow locked
 * (receipt, forward), a forward in flight (the retry loop), a payee that
 * withdrew (redeposit) — and the legacy dispute states keep the round-4
 * alphabet: a forward or a fresh receipt there only multiplies states the
 * locked / fed states already cover, without reaching a new writer.
 */
const RECEIPT_STATES: ReadonlySet<StartState> = new Set<StartState>([
  "locked",
  "disputed",
  "federated-origin",
  "fed-partial",
  "fed-forward-undelivered",
  "lost-task-queue",
]);
const FORWARD_STATES: ReadonlySet<StartState> = new Set<StartState>([
  "locked",
  "federated-origin",
  "fed-partial",
  "fed-forward-undelivered",
  "lost-task-queue",
]);
const REDEPOSIT_STATES: ReadonlySet<StartState> = new Set<StartState>([
  "round2-clawback-insufficient",
  "rerouted",
  "two-paid",
]);

function alphabet(w: World): Action[] {
  const out: Action[] = [
    { kind: "fileD" },
    { kind: "fileW" },
    { kind: "expire" },
    { kind: "sweep" },
    { kind: "withdraw" },
  ];
  if (RECEIPT_STATES.has(w.start)) out.push({ kind: "settlement-surplus" });
  if (FORWARD_STATES.has(w.start)) {
    out.push(
      { kind: "forward" },
      { kind: "forward-deliver" },
      { kind: "forward-fail" },
      { kind: "retry-exhaust" },
    );
  }
  if (REDEPOSIT_STATES.has(w.start)) out.push({ kind: "redeposit" });
  if (w.alt) out.push({ kind: "fileD2" });
  for (let k = 0; k < w.disputes.length; k++) {
    out.push({ kind: "upheld", k }, { kind: "overturned", k }, { kind: "split", k });
    out.push({ kind: "appeal", k });
  }
  return out;
}

/**
 * Observable state, normalized: parties as roles, dispute ids as their filing
 * index, random settlement ids erased. Two prefixes with the same fingerprint
 * have the same continuations, so a state is expanded once per remaining
 * depth budget (memoized DFS) — exhaustive over sequences, not over replays.
 */
function fingerprint(w: World): string {
  const db = w.relay.moteDb.db;
  const role = (id: string): string =>
    id === w.relay.relayIdentity.relayMotebitId
      ? "R"
      : id === DELEGATOR
        ? "D"
        : id === WORKER
          ? "W"
          : id === DELEGATOR2
            ? "D2"
            : id === WORKER2
              ? "W2"
              : "o";
  const ref = (id: string): string => {
    const k = w.disputes.indexOf(id);
    if (k >= 0) return `d${k}`;
    return id === w.allocationId ? "A" : id === w.alt?.allocationId ? "A2" : "x";
  };
  const txns = (
    db
      .prepare(
        "SELECT motebit_id, type, amount, reference_id FROM relay_transactions ORDER BY rowid",
      )
      .all() as Array<{ motebit_id: string; type: string; amount: number; reference_id: string }>
  ).map((t) => `${role(t.motebit_id)}:${t.type}:${t.amount}:${ref(t.reference_id)}`);
  const alloc = (
    db
      .prepare("SELECT allocation_id, status FROM relay_allocations ORDER BY rowid")
      .all() as Array<{
      allocation_id: string;
      status: string;
    }>
  ).map((a) => `${ref(a.allocation_id)}:${a.status}`);
  const disputes = w.disputes.map((id) => {
    const d = db
      .prepare(
        "SELECT filed_by, state, appealed_at, fund_action, split_ratio FROM relay_disputes WHERE dispute_id = ?",
      )
      .get(id) as {
      filed_by: string;
      state: string;
      appealed_at: number | null;
      fund_action: string | null;
      split_ratio: number | null;
    };
    return `${role(d.filed_by)}:${d.state}:${d.appealed_at != null}:${d.fund_action}:${d.split_ratio}:${refusalOf(w, id) ?? ""}`;
  });
  const forwards = (
    db
      .prepare(
        "SELECT * FROM relay_federation_settlements WHERE downstream_relay_id IS NOT NULL ORDER BY rowid",
      )
      .all() as Array<{ gross_amount: number; status?: string }>
  ).map((f) => `${f.gross_amount}:${f.status ?? ""}`);
  const retries = (
    db
      .prepare("SELECT status, attempts FROM relay_settlement_retries ORDER BY rowid")
      .all() as Array<{ status: string; attempts: number }>
  ).map((r) => `${r.status}:${r.attempts}`);
  const round2 = (
    db.prepare("SELECT COUNT(*) AS n FROM relay_dispute_resolutions WHERE round = 2").get() as {
      n: number;
    }
  ).n;
  return JSON.stringify({ txns, alloc, disputes, forwards, retries, round2 });
}

function txnCount(w: World): number {
  return (
    w.relay.moteDb.db.prepare("SELECT COUNT(*) AS n FROM relay_transactions").get() as {
      n: number;
    }
  ).n;
}

type Txn = { motebit_id: string; type: string; amount: number; reference_id: string };

/** The marker a visibly refused fund action leaves (absent before round 4). */
function refusalOf(w: World, disputeId: string): string | null {
  try {
    const r = w.relay.moteDb.db
      .prepare("SELECT fund_refusal FROM relay_disputes WHERE dispute_id = ?")
      .get(disputeId) as { fund_refusal: string | null } | undefined;
    return r?.fund_refusal ?? null;
  } catch {
    return null;
  }
}

/**
 * The harness's OWN reading of what the ledger still holds for an
 * allocation (independent of the relay's helper): hold debits − releases −
 * what its own settlements consumed (credits + fee) − gross forwarded for its
 * task − the net of rows referenced to its disputes.
 */
function harnessEscrow(db: SyncRelay["moteDb"]["db"], txns: Txn[], allocationId: string): number {
  const a = db
    .prepare("SELECT task_id FROM relay_allocations WHERE allocation_id = ?")
    .get(allocationId) as { task_id: string };
  const stl = db
    .prepare(
      "SELECT settlement_id, platform_fee FROM relay_settlements WHERE allocation_id = ? AND COALESCE(settlement_mode, 'relay') = 'relay'",
    )
    .all(allocationId) as Array<{ settlement_id: string; platform_fee: number }>;
  const stlIds = new Set(stl.map((r) => r.settlement_id));
  const fees = stl.reduce((s, r) => s + (r.platform_fee || 0), 0);
  const forwarded = forwardedTruth(db, a.task_id);
  const disputeIds = new Set(
    (
      db
        .prepare("SELECT dispute_id FROM relay_disputes WHERE allocation_id = ?")
        .all(allocationId) as Array<{ dispute_id: string }>
    ).map((r) => r.dispute_id),
  );
  let escrow = -fees - forwarded;
  for (const t of txns) {
    if (t.reference_id === allocationId && t.type === "allocation_hold") escrow -= t.amount;
    else if (t.reference_id === allocationId && t.type === "allocation_release") escrow -= t.amount;
    else if (t.type === "settlement_credit" && stlIds.has(t.reference_id)) escrow -= t.amount;
    else if (disputeIds.has(t.reference_id)) escrow -= t.amount;
  }
  return escrow;
}

/**
 * What a task's sent forwards moved, by the harness's own truth: a forward
 * counts as moved unless the peer is known never to have received it — its
 * delivery retries failed (L17). Independent of the relay's status column.
 */
function forwardedTruth(db: SyncRelay["moteDb"]["db"], taskId: string | null): number {
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(f.gross_amount), 0) AS g FROM relay_federation_settlements f
          WHERE f.downstream_relay_id IS NOT NULL
            AND (? IS NULL OR f.task_id = ?)
            AND NOT EXISTS (SELECT 1 FROM relay_settlement_retries r
                             WHERE r.settlement_id = f.settlement_id AND r.status = 'failed')`,
      )
      .get(taskId, taskId) as { g: number }
  ).g;
}

function hasColumn(db: SyncRelay["moteDb"]["db"], table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    (c) => c.name === column,
  );
}

function holdPayers(txns: Txn[], allocationId: string): Set<string> {
  return new Set(
    txns
      .filter((t) => t.type === "allocation_hold" && t.reference_id === allocationId)
      .map((t) => t.motebit_id),
  );
}

/** L1–L3, L5–L13, L15 over the current state. */
function checkLaws(w: World): Array<{ law: string; detail: string }> {
  const db = w.relay.moteDb.db;
  const out: Array<{ law: string; detail: string }> = [];
  const txns = db
    .prepare("SELECT motebit_id, type, amount, reference_id FROM relay_transactions")
    .all() as Txn[];
  const allocs = db
    .prepare("SELECT allocation_id, task_id, motebit_id, status FROM relay_allocations")
    .all() as Array<{ allocation_id: string; task_id: string; motebit_id: string; status: string }>;
  const allocById = new Map(allocs.map((a) => [a.allocation_id, a]));
  const disputeRows = db
    .prepare("SELECT dispute_id, allocation_id, task_id FROM relay_disputes")
    .all() as Array<{ dispute_id: string; allocation_id: string; task_id: string }>;
  const disputeById = new Map(disputeRows.map((d) => [d.dispute_id, d]));

  // L1 (global): what every delegator locked bounds everything paid out of
  // escrow, across every allocation in the world. Deposits are external money
  // in, holds are the lock itself, withdrawals are a payee's own money out.
  const locked = -txns
    .filter((t) => t.type === "allocation_hold")
    .reduce((s, t) => s + t.amount, 0);
  const ledgerOut = txns
    .filter((t) => t.type !== "deposit" && t.type !== "allocation_hold" && t.type !== "withdrawal")
    .reduce((s, t) => s + t.amount, 0);
  // The platform fee leaves escrow as part of the settlement payout.
  const fees = (
    db
      .prepare(
        "SELECT COALESCE(SUM(platform_fee), 0) AS f FROM relay_settlements WHERE COALESCE(settlement_mode, 'relay') = 'relay'",
      )
      .get() as { f: number }
  ).f;
  // A federated origin forwards the task's gross to the executing peer: it
  // leaves escrow with no local ledger row.
  const forwarded = forwardedTruth(db, null);
  const paidOut = ledgerOut + fees + forwarded;
  if (paidOut > locked) {
    out.push({
      law: "L1 payout<=locked",
      detail: `paid out ${paidOut} (ledger ${ledgerOut} + fee ${fees} + forwarded ${forwarded}) from ${locked} locked`,
    });
  }

  // Rows this run wrote (the start state's rows are given).
  const fresh = db
    .prepare(
      "SELECT motebit_id, type, amount, reference_id FROM relay_transactions WHERE rowid > ?",
    )
    .all(w.startTxMax) as Txn[];
  const allDisputeIds = new Set(disputeById.keys());

  for (const a of allocs) {
    const own = new Set(
      disputeRows.filter((d) => d.allocation_id === a.allocation_id).map((d) => d.dispute_id),
    );
    // L2: the disputes NAMING this allocation — by allocation, or by its task
    // (a pre-binding relay keyed fund movement on the dispute's task) — move
    // its money at most once. A row of such a dispute moved THIS allocation's
    // money when it lands on one of its parties (hold payer, worker, an
    // account its own settlements paid): a legacy dispute on A1 naming A2's
    // task that refunded A1's delegator moved A1's money, not A2's (C2).
    const naming = new Set(
      disputeRows
        .filter((d) => d.allocation_id === a.allocation_id || d.task_id === a.task_id)
        .map((d) => d.dispute_id),
    );
    const partiesOfA = new Set([
      ...holdPayers(txns, a.allocation_id),
      a.motebit_id,
      ...(
        db
          .prepare(
            `SELECT DISTINCT t.motebit_id FROM relay_transactions t
              JOIN relay_settlements s ON s.settlement_id = t.reference_id
             WHERE t.type = 'settlement_credit' AND s.allocation_id = ?`,
          )
          .all(a.allocation_id) as Array<{ motebit_id: string }>
      ).map((r) => r.motebit_id),
    ]);
    const moving = new Set(
      txns
        .filter((t) => naming.has(t.reference_id) && partiesOfA.has(t.motebit_id))
        .map((t) => t.reference_id),
    );
    if (moving.size > 1) {
      out.push({
        law: "L2 one-dispute-moves-money",
        detail: `${moving.size} disputes moved ${a.allocation_id}'s money: ${[...moving].join(",")}`,
      });
    }

    const finals = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM relay_disputes WHERE allocation_id = ? AND state = 'final'",
        )
        .get(a.allocation_id) as { n: number }
    ).n;
    // A start state that already held N live disputes (legacy rows) cannot be
    // made to have fewer; the law is that resolution adds no further one.
    if (finals > Math.max(1, w.startLive)) {
      out.push({ law: "L3 one-fund-action", detail: `${finals} disputes reached final` });
    }

    // L5 The first verdict to become final is the allocation's one fund action:
    // no other dispute moves money afterwards, whether or not that verdict
    // itself moved any (release_to_worker after settlement moves nothing).
    const firstFinal = db
      .prepare(
        "SELECT dispute_id FROM relay_disputes WHERE allocation_id = ? AND state = 'final' ORDER BY final_at, rowid LIMIT 1",
      )
      .get(a.allocation_id) as { dispute_id: string } | undefined;
    if (firstFinal) {
      const others = fresh.filter(
        (t) => own.has(t.reference_id) && t.reference_id !== firstFinal.dispute_id,
      );
      if (others.length > 0) {
        out.push({
          law: "L5 first-final-owns-funds",
          detail: `${others.length} row(s) from a dispute other than the first final (${others.map((t) => t.reference_id).join(",")})`,
        });
      }
    }

    // L11 SWEEP-CONSERVATION / L12 NO-STRAND, from the harness's own reading.
    const escrow = harnessEscrow(db, txns, a.allocation_id);
    if (escrow < 0) {
      out.push({
        law: "L11 sweep-conservation",
        detail: `${a.allocation_id} paid out ${-escrow} more than the ledger held for it`,
      });
    }
    if ((a.status === "settled" || a.status === "released") && escrow > 0) {
      out.push({
        law: "L12 no-strand",
        detail: `${a.allocation_id} closed ${a.status} with ${escrow} still held`,
      });
    }
  }

  // L6 PAYEE-IS-PARTY / L9 ALLOCATION-TASK-BINDING over every fresh row a
  // dispute wrote: parties are the dispute's OWN allocation's hold payer and
  // worker; a debit may also land on an account that allocation's own
  // settlements paid (#959) — never on another allocation's payee.
  for (const t of fresh) {
    const d = disputeById.get(t.reference_id);
    if (!d) continue;
    const a = allocById.get(d.allocation_id);
    if (a && a.task_id !== d.task_id) {
      out.push({
        law: "L9 allocation-task-binding",
        detail: `dispute ${d.dispute_id} names task ${d.task_id}, not its allocation's ${a.task_id}, and moved ${t.amount} on ${t.motebit_id}`,
      });
    }
    const payers = holdPayers(txns, d.allocation_id);
    const parties = new Set([...payers, a?.motebit_id ?? ""]);
    if (t.amount > 0 && !parties.has(t.motebit_id)) {
      out.push({
        law: "L6 payee-is-party",
        detail: `dispute credit of ${t.amount} to non-party ${t.motebit_id}`,
      });
    }
    const ownPaid = new Set(
      (
        db
          .prepare(
            `SELECT DISTINCT t.motebit_id FROM relay_transactions t
              JOIN relay_settlements s ON s.settlement_id = t.reference_id
             WHERE t.type = 'settlement_credit' AND s.allocation_id = ?`,
          )
          .all(d.allocation_id) as Array<{ motebit_id: string }>
      ).map((r) => r.motebit_id),
    );
    if (!parties.has(t.motebit_id) && !ownPaid.has(t.motebit_id)) {
      out.push({
        law: "L9 allocation-task-binding",
        detail: `dispute ${d.dispute_id} on ${d.allocation_id} moved ${t.amount} on ${t.motebit_id}, not a party of that allocation`,
      });
    }
  }

  // L8 A verdict executes once: no account holds two credits from one dispute.
  const creditsPerDispute = new Map<string, number>();
  for (const t of txns) {
    if (t.amount > 0 && allDisputeIds.has(t.reference_id)) {
      const key = `${t.reference_id}→${t.motebit_id}`;
      creditsPerDispute.set(key, (creditsPerDispute.get(key) ?? 0) + 1);
    }
  }
  for (const [key, n] of creditsPerDispute) {
    if (n > 1) out.push({ law: "L8 verdict-executes-once", detail: `${n} credits ${key}` });
  }

  // L7 A dispute reverses only what was paid: dispute-driven debits on an
  // account never exceed the relay settlement credits it received.
  const settlementIds = new Set(
    (
      db
        .prepare(
          "SELECT settlement_id FROM relay_settlements WHERE COALESCE(settlement_mode, 'relay') = 'relay'",
        )
        .all() as Array<{ settlement_id: string }>
    ).map((r) => r.settlement_id),
  );
  const received = new Map<string, number>();
  const reversed = new Map<string, number>();
  for (const t of txns) {
    if (t.type === "settlement_credit" && settlementIds.has(t.reference_id)) {
      received.set(t.motebit_id, (received.get(t.motebit_id) ?? 0) + t.amount);
    }
    if (t.amount < 0 && allDisputeIds.has(t.reference_id)) {
      reversed.set(t.motebit_id, (reversed.get(t.motebit_id) ?? 0) - t.amount);
    }
  }
  for (const [acct, amt] of reversed) {
    if (amt > (received.get(acct) ?? 0)) {
      out.push({
        law: "L7 reverse-only-what-was-paid",
        detail: `${acct} debited ${amt} by disputes, received ${received.get(acct) ?? 0}`,
      });
    }
  }

  // L9 (claims) / L10 CLAIM-RECORDS-WHAT-MOVED.
  const claims = db
    .prepare(
      "SELECT allocation_id, task_id, dispute_id, regime, worker_amount, delegator_amount FROM relay_dispute_fund_actions",
    )
    .all() as Array<{
    allocation_id: string;
    task_id: string;
    dispute_id: string;
    regime: string;
    worker_amount: number;
    delegator_amount: number;
  }>;
  for (const c of claims) {
    const a = allocById.get(c.allocation_id);
    if (a && a.task_id !== c.task_id) {
      out.push({
        law: "L9 allocation-task-binding",
        detail: `claim for ${c.allocation_id} names task ${c.task_id}, not its own ${a.task_id}`,
      });
    }
    const claimDispute = disputeById.get(c.dispute_id);
    if (a && claimDispute && claimDispute.task_id !== a.task_id) {
      out.push({
        law: "L9 allocation-task-binding",
        detail: `claim for ${c.allocation_id} is held by dispute ${c.dispute_id}, which names task ${claimDispute.task_id}`,
      });
    }
    const payers = holdPayers(txns, c.allocation_id);
    const rows = txns.filter((t) => t.reference_id === c.dispute_id);
    const toDelegator = rows
      .filter((t) => payers.has(t.motebit_id))
      .reduce((s, t) => s + t.amount, 0);
    const toWorkerSide = rows
      .filter((t) => !payers.has(t.motebit_id))
      .reduce((s, t) => s + t.amount, 0);
    if (toDelegator !== c.delegator_amount) {
      out.push({
        law: "L10 claim-records-what-moved (delegator)",
        detail: `claim ${c.dispute_id} (${c.regime}) says delegator ${c.delegator_amount}, ledger moved ${toDelegator}`,
      });
    }
    if (toWorkerSide !== c.worker_amount) {
      out.push({
        law: "L10 claim-records-what-moved (worker)",
        detail: `claim ${c.dispute_id} (${c.regime}) says worker ${c.worker_amount}, ledger moved ${toWorkerSide}`,
      });
    }
  }

  // L13 A verdict past its window is executed or visibly refused.
  const stuck = db
    .prepare(
      "SELECT dispute_id FROM relay_disputes WHERE state = 'resolved' AND appealed_at IS NULL AND resolved_at < ?",
    )
    .all(Date.now() - 24 * 60 * 60 * 1000) as Array<{ dispute_id: string }>;
  for (const r of stuck) {
    if (refusalOf(w, r.dispute_id) === null) {
      out.push({
        law: "L13 verdict-executes-or-refuses-visibly",
        detail: `${r.dispute_id} stuck resolved past its window with no fund_refusal`,
      });
    }
  }
  // L15 A held allocation is visibly held: one left `disputed` with no live
  // dispute of its own carries the refusal that explains why.
  for (const a of allocs) {
    if (a.status !== "disputed") continue;
    const own = db
      .prepare("SELECT dispute_id, state FROM relay_disputes WHERE allocation_id = ?")
      .all(a.allocation_id) as Array<{ dispute_id: string; state: string }>;
    if (own.some((d) => d.state !== "final" && d.state !== "expired")) continue;
    if (!own.some((d) => refusalOf(w, d.dispute_id) !== null)) {
      out.push({
        law: "L15 held-allocation-is-marked",
        detail: `${a.allocation_id} left disputed with no live dispute and no fund_refusal`,
      });
    }
  }

  // L6b REFUND-TO-PAYER: an allocation's escrow returns only to who funded it.
  for (const t of fresh) {
    if (t.type !== "allocation_release" || t.amount <= 0) continue;
    if (!allocById.has(t.reference_id)) continue;
    const payers = holdPayers(txns, t.reference_id);
    if (!payers.has(t.motebit_id)) {
      out.push({
        law: "L6b refund-to-payer",
        detail: `${t.amount} of ${t.reference_id}'s escrow released to ${t.motebit_id}, not its hold payer (${[...payers].join(",")})`,
      });
    }
  }

  // L13b A refused round-2 verdict stays retryable (an appeal whose round 2
  // actually ran — its votes are recorded — and whose finalize was refused).
  const appealedRefused = db
    .prepare(
      `SELECT d.dispute_id FROM relay_disputes d
        WHERE d.state = 'appealed'
          AND EXISTS (SELECT 1 FROM relay_dispute_votes v WHERE v.dispute_id = d.dispute_id AND v.round = 2)`,
    )
    .all() as Array<{ dispute_id: string }>;
  for (const r of appealedRefused) {
    if (refusalOf(w, r.dispute_id) === null) continue;
    const round2 = db
      .prepare("SELECT 1 FROM relay_dispute_resolutions WHERE dispute_id = ? AND round = 2")
      .get(r.dispute_id);
    if (round2 === undefined) {
      out.push({
        law: "L13b round-2-refusal-retryable",
        detail: `${r.dispute_id} left appealed with fund_refusal=${refusalOf(w, r.dispute_id)} and no persisted round-2 verdict — nothing can ever retry it`,
      });
    }
  }

  // L16 NO-RAW-ALLOCATION-WRITE (runtime half; the gate is the static half):
  // every allocation-money row this run wrote carries the chokepoint's stamp.
  if (hasColumn(db, "relay_transactions", "allocation_kind")) {
    const kinds = new Set<string>(ALLOCATION_MONEY_KINDS);
    const unstamped = db
      .prepare(
        `SELECT motebit_id, type, amount, reference_id, allocation_kind FROM relay_transactions
          WHERE rowid > ? AND type IN ('allocation_hold', 'allocation_release', 'settlement_credit', 'settlement_debit')`,
      )
      .all(w.startTxMax) as Array<Txn & { allocation_kind: string | null }>;
    for (const t of unstamped) {
      if (t.allocation_kind === null || !kinds.has(t.allocation_kind)) {
        out.push({
          law: "L16 no-raw-allocation-write",
          detail: `${t.type} of ${t.amount} on ${t.motebit_id} (ref ${t.reference_id}) carries no escrow kind`,
        });
      }
    }
    const loose = db
      .prepare(
        `SELECT settlement_id FROM relay_federation_settlements
          WHERE downstream_relay_id IS NOT NULL AND allocation_id IS NULL`,
      )
      .all() as Array<{ settlement_id: string }>;
    for (const f of loose) {
      out.push({
        law: "L16 no-raw-allocation-write",
        detail: `forward ${f.settlement_id} carries no allocation`,
      });
    }
  }

  // L17 FORWARD-LIFECYCLE-CONSERVATION.
  const withStatus = hasColumn(db, "relay_federation_settlements", "status");
  for (const a of allocs) {
    const fwds = db
      .prepare(
        "SELECT * FROM relay_federation_settlements WHERE downstream_relay_id IS NOT NULL AND task_id = ?",
      )
      .all(a.task_id) as Array<{ settlement_id: string; status?: string }>;
    if (fwds.length === 0) continue;
    const truth = Math.max(0, harnessEscrow(db, txns, a.allocation_id));
    const relayHeld = allocationEscrowHeld(db, a.allocation_id);
    if (relayHeld !== truth) {
      out.push({
        law: "L17 forward-lifecycle-conservation",
        detail: `${a.allocation_id}: the relay reads ${relayHeld} held, the ledger and delivery truth say ${truth}`,
      });
    }
    if (!withStatus) continue;
    for (const f of fwds) {
      const retries = db
        .prepare("SELECT status FROM relay_settlement_retries WHERE settlement_id = ?")
        .all(f.settlement_id) as Array<{ status: string }>;
      const expected = retries.some((r) => r.status === "failed")
        ? "failed"
        : retries.some((r) => r.status === "pending")
          ? "pending"
          : "delivered";
      if (f.status !== expected) {
        out.push({
          law: "L17 forward-lifecycle-conservation",
          detail: `forward ${f.settlement_id} is ${f.status}, its delivery says ${expected}`,
        });
      }
    }
  }
  return out;
}

/**
 * L13b (liveness, after a read): a claw-back refused because the paid account
 * held too little has executed once that account again holds what it was
 * paid by the allocation.
 */
function checkRetryLiveness(w: World): Array<{ law: string; detail: string }> {
  const db = w.relay.moteDb.db;
  const out: Array<{ law: string; detail: string }> = [];
  const refused = db
    .prepare(
      "SELECT dispute_id, allocation_id, state FROM relay_disputes WHERE state IN ('resolved', 'appealed') AND fund_refusal = 'clawback_insufficient'",
    )
    .all() as Array<{ dispute_id: string; allocation_id: string; state: string }>;
  for (const d of refused) {
    if (d.state === "resolved") {
      const r = db
        .prepare("SELECT resolved_at FROM relay_disputes WHERE dispute_id = ?")
        .get(d.dispute_id) as { resolved_at: number };
      if (Date.now() <= r.resolved_at + 24 * 3600_000) continue;
    }
    const paid = db
      .prepare(
        `SELECT t.motebit_id, SUM(t.amount) AS amount FROM relay_transactions t
           JOIN relay_settlements s ON s.settlement_id = t.reference_id
          WHERE t.type = 'settlement_credit' AND s.allocation_id = ?
          GROUP BY t.motebit_id`,
      )
      .all(d.allocation_id) as Array<{ motebit_id: string; amount: number }>;
    const covered = paid.every(
      (p) => getAccountBalanceDetailed(db, p.motebit_id).balance >= p.amount,
    );
    if (paid.length > 0 && covered) {
      out.push({
        law: "L13b round-2-refusal-retryable",
        detail: `${d.dispute_id} (${d.state}) still refused clawback_insufficient after a read, though its paid account now covers the claw-back`,
      });
    }
  }
  return out;
}

/** The kinds of allocation-money movement this world has written (L16's runtime coverage). */
function observeKinds(w: World): void {
  const db = w.relay.moteDb.db;
  try {
    for (const r of db
      .prepare(
        "SELECT DISTINCT allocation_kind AS k FROM relay_transactions WHERE allocation_kind IS NOT NULL",
      )
      .all() as Array<{ k: string }>)
      observedKinds.add(r.k);
    if (db.prepare("SELECT 1 FROM relay_allocation_fees LIMIT 1").get() !== undefined) {
      observedKinds.add("settlement_fee");
    }
    // A forward the chokepoint wrote (the seeded legacy forwards excluded).
    if (
      db
        .prepare(
          "SELECT 1 FROM relay_federation_settlements WHERE allocation_id IS NOT NULL AND settlement_id NOT IN ('fed-stl-undelivered', 'fed-stl-cons') LIMIT 1",
        )
        .get() !== undefined
    ) {
      observedKinds.add("federated_forward");
    }
    if (
      db
        .prepare("SELECT 1 FROM relay_federation_settlements WHERE status = 'failed' LIMIT 1")
        .get() !== undefined
    ) {
      observedKinds.add("forward_return");
    }
  } catch {
    /* a relay without the escrow columns observes nothing */
  }
}

/**
 * L14 precondition: the filing's target allocation is locked / settled and no
 * live dispute of its OWN exists — a 409 then means another allocation's
 * dispute is blocking it.
 */
function fileTargetDisputable(w: World, a: Action): boolean {
  if (a.kind !== "fileD" && a.kind !== "fileW" && a.kind !== "fileD2") return false;
  const allocationId = a.kind === "fileD2" ? w.alt?.allocationId : w.allocationId;
  if (!allocationId) return false;
  const db = w.relay.moteDb.db;
  const alloc = db
    .prepare("SELECT status FROM relay_allocations WHERE allocation_id = ?")
    .get(allocationId) as { status: string } | undefined;
  if (!alloc || (alloc.status !== "locked" && alloc.status !== "settled")) return false;
  const own = db
    .prepare("SELECT 1 FROM relay_disputes WHERE allocation_id = ? AND state != 'expired' LIMIT 1")
    .get(allocationId);
  return own === undefined;
}

interface Stats {
  /** Distinct (state, remaining-depth) nodes expanded. */
  states: number;
  /** Transitions driven (each one a fresh relay replaying its prefix). */
  transitions: number;
  violations: Violation[];
  /** fingerprint → largest remaining depth already expanded from it. */
  seen: Map<string, number>;
}

async function replay(start: StartState, prefix: Action[]): Promise<World> {
  const w = await buildWorld(start);
  for (const a of prefix) await step(w, a);
  return w;
}

async function explore(
  start: StartState,
  prefix: Action[],
  fp: string,
  actions: Action[],
  stats: Stats,
  given: World | null,
): Promise<void> {
  const remaining = MAX_DEPTH - prefix.length;
  if (remaining <= 0 || (stats.seen.get(fp) ?? 0) >= remaining) {
    if (given) await given.relay.close();
    return;
  }
  stats.seen.set(fp, remaining);
  stats.states += 1;

  // `w` is a world standing in this node's state. A step that leaves the
  // state unchanged (rejected, or a no-op) keeps it for the next sibling; a
  // step that changes it hands the world to the child and the next sibling
  // replays the prefix on a fresh relay.
  let w = given;
  for (const a of actions) {
    w ??= await replay(start, prefix);
    const txBefore = txnCount(w);
    const disputable = fileTargetDisputable(w, a);
    const status = await step(w, a);
    stats.transitions += 1;
    const sequence = [...prefix, a].map(label).join(" → ");
    if (status >= 300 && txnCount(w) !== txBefore) {
      stats.violations.push({
        start,
        sequence,
        law: "L4 rejected-writes-nothing",
        detail: `HTTP ${status} appended ledger rows`,
      });
    }
    if (disputable && status === 409) {
      stats.violations.push({
        start,
        sequence,
        law: "L14 allocation-disputable",
        detail: `filing on an allocation with no dispute of its own refused 409`,
      });
    }
    const broken = checkLaws(w);
    if (a.kind === "expire") broken.push(...checkRetryLiveness(w));
    for (const v of broken) stats.violations.push({ start, sequence, ...v });
    observeKinds(w);
    const childFp = fingerprint(w);
    if (childFp === fp) continue;
    // A rejected step's continuations are the parent's (enumerated here); a
    // state that already breaks the law is a counterexample and adds none.
    if (status < 300 && broken.length === 0) {
      // Alphabet depends on the prefix (k ranges over disputes filed so far).
      await explore(start, [...prefix, a], childFp, alphabet(w), stats, w);
    } else {
      await w.relay.close();
    }
    w = null;
  }
  if (w) await w.relay.close();
}

describe("Dispute conservation harness (exhaustive, real routes)", () => {
  beforeAll(async () => {
    delegatorKp = await generateKeypair();
    workerKp = await generateKeypair();
    otherKp = await generateKeypair();
    delegator2Kp = await generateKeypair();
    worker2Kp = await generateKeypair();
    votingPeers = [];
    for (let i = 0; i < 3; i++) {
      votingPeers.push({
        id: `relay-voter-${i}`,
        url: `http://voter${i}.cons.test`,
        kp: await generateKeypair(),
      });
    }
    // No network: the executing peer acknowledges a settlement forward only
    // when an action says so; the voting peers cast the canned votes.
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(PEER_URL)) {
        if (!peerAcks) throw new Error("peer unreachable");
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      const voter = votingPeers.find((p) => url.startsWith(p.url));
      if (voter) {
        const body = JSON.parse(init!.body as string) as VoteRequest;
        const vote = VOTES.get(body.round);
        if (vote === undefined) throw new Error(`no canned vote for round ${body.round}`);
        const signed = await signAdjudicatorVote(
          {
            dispute_id: body.dispute_id,
            round: body.round,
            peer_id: voter.id,
            vote,
            rationale: "canned",
          },
          voter.kp.privateKey,
        );
        return new Response(JSON.stringify(signed), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`no network in the harness: ${url}`);
    });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  for (const start of START_STATES) {
    it(`conserves escrow from a ${start} allocation over every sequence ≤ ${MAX_DEPTH}`, async () => {
      const stats: Stats = { states: 0, transitions: 0, violations: [], seen: new Map() };
      // The starting state itself must already satisfy the law.
      const w0 = await buildWorld(start);
      for (const v of checkLaws(w0)) stats.violations.push({ start, sequence: "∅", ...v });
      observeKinds(w0);
      await explore(start, [], fingerprint(w0), alphabet(w0), stats, w0);

      // Shortest counterexample per (law, final action): one line per path
      // that breaks a law, so two writers breaking it are both named.
      const byLaw = new Map<string, Violation>();
      for (const v of stats.violations) {
        const key = `${v.law}|${v.sequence.split(" → ").pop()}`;
        const prev = byLaw.get(key);
        if (!prev || v.sequence.length < prev.sequence.length) byLaw.set(key, v);
      }
      const report = [...byLaw.values()]
        .map((v) => `[${v.law}] ${v.start}: ${v.sequence} — ${v.detail}`)
        .join("\n");
      const summary = `[conservation] ${start}: ${stats.states} states, ${stats.transitions} transitions, ${stats.violations.length} violations${report ? `\n${report}` : ""}`;
      console.info(summary);
      // Opt-in record of the explored size (vitest hides passing tests' logs).
      const statsFile = process.env.DISPUTE_HARNESS_STATS;
      if (statsFile) appendFileSync(statsFile, `${summary}\n`);
      expect(stats.transitions).toBeGreaterThan(0);
      startStatesRun += 1;
      expect(report).toBe("");
    }, 1_200_000);
  }

  // L16 (runtime half): across the run, every kind of allocation-money
  // movement the chokepoint knows was actually driven by this alphabet.
  it("drives every ALLOCATION_MONEY_KINDS kind (KIND_ACTIONS is not narrower than the code)", () => {
    if (startStatesRun < START_STATES.length) return; // a filtered run proves nothing here
    const missing = ALLOCATION_MONEY_KINDS.filter((k) => !observedKinds.has(k));
    expect(missing).toEqual([]);
    expect(Object.keys(KIND_ACTIONS).sort()).toEqual([...ALLOCATION_MONEY_KINDS].sort());
  });
});
