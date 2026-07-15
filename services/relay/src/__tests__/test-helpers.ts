/**
 * Shared test helpers for relay integration tests.
 *
 * Centralizes the common setup patterns (auth headers, relay factory, agent factory)
 * so that a single change to createSyncRelay's API propagates once, not 25+ times.
 */
import { createSyncRelay } from "../index.js";
import type { SyncRelay, SyncRelayConfig } from "../index.js";
import { deriveSolanaAddress, SOLANA_MAINNET_CAIP2 } from "@motebit/wallet-solana";
import { PLATFORM_FEE_RATE } from "@motebit/protocol";
import type { AgentTask } from "@motebit/sdk";
import { AgentTaskStatus, asMotebitId, asAllocationId, asGoalId } from "@motebit/sdk";
import { allocateBudget, computeGrossAmount } from "@motebit/market";
import { TaskQueue } from "../task-queue.js";
import {
  creditAccount,
  debitSpendableAccount,
  getAccountBalance,
  computeDisputeWindowHold,
  toMicro,
  fromMicro,
} from "../accounts.js";

// === Auth constants ===

export const API_TOKEN = "test-token";
export const AUTH_HEADER = { Authorization: `Bearer ${API_TOKEN}` };
export const JSON_AUTH = { "Content-Type": "application/json", ...AUTH_HEADER };

/** JSON_AUTH with a fresh Idempotency-Key — use for financial endpoints (deposit, withdraw, task, ledger). */
export function jsonAuthWithIdempotency(): Record<string, string> {
  return { ...JSON_AUTH, "Idempotency-Key": crypto.randomUUID() };
}

// === x402 test config ===

export const X402_TEST_CONFIG = {
  payToAddress: "0x0000000000000000000000000000000000000000",
  network: "eip155:84532",
  testnet: true,
} as const;

// === Relay factory ===

/**
 * Create a test relay with in-memory SQLite.
 * All SyncRelayConfig fields can be overridden; the base provides
 * apiToken and x402 so callers don't repeat them.
 */
export async function createTestRelay(overrides?: Partial<SyncRelayConfig>): Promise<SyncRelay> {
  return createSyncRelay({
    apiToken: API_TOKEN,
    x402: X402_TEST_CONFIG,
    // Tests use mock WebSocket connections that never disconnect, so the
    // production 5s drain grace would be paid in full on every `close()`
    // (afterEach) — ~5s/test, making the suite slow and timer-bound (the
    // contention-flake amplifier under parallel `turbo run test`). 10ms keeps
    // the drain code path exercised without the wall-clock + flake cost.
    drainGraceMs: 10,
    ...overrides,
  });
}

// === Agent factory ===

/**
 * Register an identity + device on the relay, returning IDs.
 * Used by money-loop, trust-flywheel, settlement-safety, and similar tests.
 */
export async function createAgent(
  relay: SyncRelay,
  pubKeyHex: string,
): Promise<{ motebitId: string; deviceId: string }> {
  const identityRes = await relay.app.request("/identity", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ owner_id: `owner-${crypto.randomUUID()}` }),
  });
  const { motebit_id } = (await identityRes.json()) as { motebit_id: string };

  const deviceRes = await relay.app.request("/device/register", {
    method: "POST",
    headers: JSON_AUTH,
    body: JSON.stringify({ motebit_id, device_name: "Test", public_key: pubKeyHex }),
  });
  const { device_id } = (await deviceRes.json()) as { device_id: string };

  return { motebitId: motebit_id, deviceId: device_id };
}

// === P2P payment-proof harness ===
//
// Paid direct delegation settles P2P: the delegator broadcasts an atomic
// multi-output Solana tx (worker leg + treasury fee leg) and submits a
// `payment_proof` with the task. These helpers construct a proof whose
// fields pass the submission validation in `tasks.ts` — the single place
// the net/fee math lives, so the ~32 E2E sites don't each re-derive it.
// The relay treasury address IS the relay's identity-derived Solana wallet
// (`deriveSolanaAddress(relayIdentity.publicKey)` — the same address the
// fee leg must target, validated at `tasks.ts:1720`).

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A fresh, format-valid (88-char base58) fake Solana tx signature. */
export function fakeSolanaTxHash(): string {
  let s = "";
  for (let i = 0; i < 88; i++) {
    s += BASE58_ALPHABET[Math.floor(Math.random() * BASE58_ALPHABET.length)];
  }
  return s;
}

/** The relay's treasury Solana address — the required `fee_to_address`. */
export function p2pTreasuryAddress(relay: SyncRelay): string {
  return deriveSolanaAddress(Uint8Array.from(Buffer.from(relay.relayIdentity.publicKeyHex, "hex")));
}

export interface BuildP2pProofArgs {
  /** Worker's declared settlement address (must match the worker registration). */
  workerAddress: string;
  /** Net the worker earns, in micro-units (== the listing unit_cost). */
  unitCostMicro: number;
  /** Platform fee rate; defaults to the canonical `PLATFORM_FEE_RATE` (0.05). */
  feeRate?: number;
  /** Override the tx signature; defaults to a fresh `fakeSolanaTxHash()`. */
  txHash?: string;
}

export interface P2pPaymentProof {
  tx_hash: string;
  chain: string;
  network: string;
  to_address: string;
  amount_micro: number;
  fee_to_address: string;
  fee_amount_micro: number;
}

/**
 * Build a `payment_proof` for a paid direct delegation. The fee leg is
 * computed exactly as the submission validator expects: the worker earns
 * `net = unitCostMicro`, the fee is `gross - net` where
 * `gross = round(net / (1 - feeRate))`. Mirrors `tasks.ts:1745`.
 */
export function buildP2pPaymentProof(relay: SyncRelay, args: BuildP2pProofArgs): P2pPaymentProof {
  const feeRate = args.feeRate ?? PLATFORM_FEE_RATE;
  const net = args.unitCostMicro;
  const gross = Math.round(net / (1 - feeRate));
  return {
    tx_hash: args.txHash ?? fakeSolanaTxHash(),
    chain: "solana",
    network: SOLANA_MAINNET_CAIP2,
    to_address: args.workerAddress,
    amount_micro: net,
    fee_to_address: p2pTreasuryAddress(relay),
    fee_amount_micro: gross - net,
  };
}

/**
 * Seed a virtual-account balance directly through the ledger — the test
 * replacement for the removed self-declared `POST /deposit` route.
 *
 * Tests seed state and then exercise spend/settle/withdraw logic; they must
 * not depend on a production money-minting HTTP endpoint to do it. This
 * credits via the same `creditAccount` primitive the real funding paths use
 * (deposit-detector, Stripe webhook), so seeded balance is byte-identical to
 * funded balance without the treasury-drain surface a client route exposed.
 *
 * `amount` is decimal USD (converted to micro-units at the boundary, exactly
 * as the removed endpoint did).
 */
export function seedBalance(relay: SyncRelay, motebitId: string, amount: number): number {
  const newBalanceMicro = creditAccount(
    relay.moteDb.db,
    motebitId,
    toMicro(amount),
    "deposit",
    null,
    "test seed",
  );
  return fromMicro(newBalanceMicro);
}

// === x402-paid submission harness ===
//
// After the Arc 3.5 gate, the only cross-agent relay-custody settlement the
// submission route still creates is the x402-paid one — and `x402TxHash` is
// set exclusively by the real `onAfterSettle` payment hook behind an external
// facilitator, so that branch cannot be driven end-to-end from the harness.
// This helper seeds the exact state a successful x402-paid submission leaves
// behind (a byte-faithful mirror of the x402 branch in `tasks.ts` — queue
// entry with `x402_tx_hash`, auto-deposit credit, risk-buffered allocation
// hold + `relay_allocations` 'locked' row) so tests can drive the REAL
// receipt → settlement → dispute → withdrawal path over live routes. Only
// the facilitator round-trip is faked; every ledger mutation goes through
// the same primitives production uses. Sibling of `seedBalance` (ledger
// seeding) and `buildP2pPaymentProof` (proof construction).
//
// TaskQueue is write-through SQLite (no in-memory cache), so a second
// instance over the same db is visible to the relay's route handlers.

/** A format-plausible fake x402 (EVM) transaction hash. */
export function fakeX402TxHash(): string {
  let s = "0x";
  for (let i = 0; i < 64; i++) s += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  return s;
}

export interface SeedX402PaidTaskArgs {
  /** The worker (target agent) — must be registered with a priced listing. */
  workerId: string;
  /** The delegator (submitter). */
  delegatorId: string;
  prompt: string;
  /** The worker's listing unit_cost in decimal USD (net to worker). */
  unitCostUsd: number;
  /** Override the x402 tx hash; defaults to a fresh `fakeX402TxHash()`. */
  txHash?: string;
}

/**
 * Seed an x402-paid direct delegation at the point submission leaves it:
 * pending task in the durable queue (with `x402_tx_hash`), the delegator's
 * x402 auto-deposit, and the locked budget allocation. Returns the task_id;
 * POST the signed receipt to `/agent/:worker/task/:taskId/result` to drive
 * the real relay-custody settlement.
 */
export function seedX402PaidTask(relay: SyncRelay, args: SeedX402PaidTaskArgs): string {
  const db = relay.moteDb.db;
  const taskId = crypto.randomUUID();
  const now = Date.now();
  const txHash = args.txHash ?? fakeX402TxHash();

  // Mirror: unitCostAtSubmission → gross price snapshot (tasks.ts submission).
  const priceSnapshot = toMicro(computeGrossAmount(args.unitCostUsd, PLATFORM_FEE_RATE));

  const task: AgentTask = {
    task_id: taskId,
    motebit_id: asMotebitId(args.workerId),
    prompt: args.prompt,
    submitted_at: now,
    submitted_by: args.delegatorId,
    status: AgentTaskStatus.Pending,
  };

  new TaskQueue(db).set(taskId, {
    task,
    expiresAt: now + 10 * 60 * 1000, // TASK_TTL_MS
    submitted_by: args.delegatorId,
    price_snapshot: priceSnapshot,
    x402_tx_hash: txHash,
    x402_network: X402_TEST_CONFIG.network,
    settlement_mode: "relay",
  });

  // Mirror: x402 auto-deposit to the delegator's virtual account.
  creditAccount(
    db,
    args.delegatorId,
    priceSnapshot,
    "deposit",
    `x402-${taskId}`,
    `x402 payment for task ${taskId}`,
  );

  // Mirror: risk-buffered allocation hold (spendable balance only).
  const account = getAccountBalance(db, args.delegatorId);
  const rawBalance = account?.balance ?? 0;
  const escrowHold = computeDisputeWindowHold(db, args.delegatorId);
  const virtualBalance = Math.max(0, rawBalance - escrowHold);

  const allocation = allocateBudget(
    {
      goal_id: asGoalId(taskId),
      candidate_motebit_id: asMotebitId(args.workerId),
      estimated_cost: priceSnapshot,
      currency: "USDC",
      risk_factor: 1.0,
    },
    virtualBalance,
    asAllocationId(`x402-${taskId}`),
  );
  if (!allocation) {
    throw new Error("seedX402PaidTask: allocation failed — delegator balance below gross price");
  }
  allocation.amount_locked = Math.round(allocation.amount_locked);

  debitSpendableAccount(
    db,
    args.delegatorId,
    allocation.amount_locked,
    "allocation_hold",
    `x402-${taskId}`,
    `Hold for task ${taskId} to ${args.workerId}`,
  );
  db.prepare(
    "INSERT OR IGNORE INTO relay_allocations (allocation_id, task_id, motebit_id, amount_locked, status, created_at) VALUES (?, ?, ?, ?, 'locked', ?)",
  ).run(`x402-${taskId}`, taskId, args.workerId, allocation.amount_locked, now);

  return taskId;
}

// === P2P sub-task seeding (multi-hop-as-P2P) ===
//
// A p2p sub-hop is a real `POST /agent/C/task` the sub-delegator submits with a
// payment_proof (it paid the worker onchain from its OWN wallet before
// submitting — the Clerk's move). This helper seeds the exact post-submission
// queue state — a durable entry with `settlement_mode: "p2p"` + the proof + a
// price snapshot — WITHOUT driving the eligibility gate (which isn't what the
// multi-hop settlement tests exercise; the p2p-cycle tests already cover it).
// A parent receipt that nests this sub-task's receipt then drives
// `settleSubReceipt`, which writes the audit-only p2p settlement row. Books NO
// relay allocation (a p2p hop moves money onchain) — the sibling of
// `seedX402PaidTask`'s relay-custody seeding, for the p2p lane.

export interface SeedP2pSubTaskArgs {
  /** The worker (sub-agent) executing this hop — must be registered (device key resolvable). */
  workerId: string;
  /** The sub-delegator that submitted + paid this hop. */
  delegatorId: string;
  prompt: string;
  /** The worker's listing unit_cost in decimal USD (net to worker). */
  unitCostUsd: number;
  /** The worker's Solana settlement address (the proof's `to_address`). */
  workerAddress: string;
}

/**
 * Seed a p2p-submitted sub-task at the point submission leaves it: a durable
 * queue entry with `settlement_mode: "p2p"`, a format-valid `payment_proof`
 * (net + fee legs), and a price snapshot so the sub-hop reads as paid. Returns
 * the task_id — use it as the sub-receipt's `relay_task_id`.
 */
export function seedP2pSubTask(relay: SyncRelay, args: SeedP2pSubTaskArgs): string {
  const db = relay.moteDb.db;
  const taskId = crypto.randomUUID();
  const now = Date.now();
  const netMicro = toMicro(args.unitCostUsd);
  const proof = buildP2pPaymentProof(relay, {
    workerAddress: args.workerAddress,
    unitCostMicro: netMicro,
  });

  const task: AgentTask = {
    task_id: taskId,
    motebit_id: asMotebitId(args.workerId),
    prompt: args.prompt,
    submitted_at: now,
    submitted_by: args.delegatorId,
    status: AgentTaskStatus.Pending,
  };

  new TaskQueue(db).set(taskId, {
    task,
    expiresAt: now + 10 * 60 * 1000, // TASK_TTL_MS
    submitted_by: args.delegatorId,
    // Price snapshot > 0 so the sub-hop reads as paid (settleSubReceipt's
    // subGross gate); the settled AMOUNT comes from the proof, not this.
    price_snapshot: toMicro(computeGrossAmount(args.unitCostUsd, PLATFORM_FEE_RATE)),
    settlement_mode: "p2p",
    p2p_payment_proof: proof,
  });

  return taskId;
}
