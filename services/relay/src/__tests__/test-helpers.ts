/**
 * Shared test helpers for relay integration tests.
 *
 * Centralizes the common setup patterns (auth headers, relay factory, agent factory)
 * so that a single change to createSyncRelay's API propagates once, not 25+ times.
 */
import { moveAllocationMoney, openAllocation } from "../allocation-escrow.js";
import { createSyncRelay } from "../index.js";
import { resolveRelayAuthPosture } from "../auth-posture.js";
import type { SyncRelay, SyncRelayConfig } from "../index.js";
import { deriveSolanaAddress, SOLANA_MAINNET_CAIP2 } from "@motebit/wallet-solana";
import { PLATFORM_FEE_RATE } from "@motebit/protocol";
import type { AgentTask } from "@motebit/sdk";
import { AgentTaskStatus, asMotebitId, asAllocationId, asGoalId } from "@motebit/sdk";
import { allocateBudget, computeGrossAmount } from "@motebit/market";
import { TaskQueue } from "../task-queue.js";
import { recordTaskRoute } from "../task-routing.js";
import type { P2pPaymentChain } from "../p2p-payer.js";
import { fakeFacilitatorClient } from "./x402-fake-facilitator.js";
import { creditAccount, getSpendableBalance, toMicro, fromMicro } from "../accounts.js";

// === Fake payment chain (#918) ===

/**
 * A fake of the chain a P2P proof's payer is read from. A tx hash registered
 * with `pay(txHash, payerAddress)` was paid by exactly that address; `hide`
 * makes one invisible (not landed); `down = true` makes every read fail.
 * An UNREGISTERED hash is answered by `unregistered`: `"honest"` (the default)
 * models the honest delegator — it was paid by the submitter — so the many
 * tests of OTHER behaviour need no chain setup; `"absent"` answers not_found.
 * The payer comparison for a registered hash is the production one
 * (`candidates.has(payer)`).
 */
export interface FakePaymentChain extends P2pPaymentChain {
  pay(txHash: string, payerAddress: string): void;
  hide(txHash: string): void;
  down: boolean;
  unregistered: "honest" | "absent";
  reads: number;
}

export function createFakePaymentChain(
  unregistered: "honest" | "absent" = "absent",
): FakePaymentChain {
  const payers = new Map<string, string>();
  const hidden = new Set<string>();
  const chain: FakePaymentChain = {
    down: false,
    unregistered,
    reads: 0,
    pay(txHash, payerAddress) {
      payers.set(txHash, payerAddress);
    },
    hide(txHash) {
      hidden.add(txHash);
    },
    async payerOf(txHash, candidates) {
      chain.reads++;
      await Promise.resolve();
      if (chain.down) return { status: "unavailable", reason: "fake chain down" };
      if (hidden.has(txHash)) return { status: "not_found" };
      const payer = payers.get(txHash);
      if (payer === undefined) {
        return chain.unregistered === "honest" ? { status: "payer" } : { status: "not_found" };
      }
      return candidates.has(payer) ? { status: "payer" } : { status: "not_payer" };
    },
  };
  return chain;
}

/** The harness default: unregistered fake tx hashes were paid by their submitter. */
export const HONEST_PAYMENT_CHAIN: P2pPaymentChain = createFakePaymentChain("honest");

/** The Solana address an Ed25519 public key (hex) derives — identity key = address. */
export function walletOf(publicKeyHex: string): string {
  return deriveSolanaAddress(Uint8Array.from(Buffer.from(publicKeyHex, "hex")));
}

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

/** The global `fetch` as the relay suite's network guard installed it (setup runs first). */
const GUARDED_FETCH = globalThis.fetch;
const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;

/**
 * The in-process peer network a test relay reaches its peer relays through
 * (`SyncRelayConfig.federationPeerFetch`). A peer at a reserved `.invalid`
 * host (RFC 6761 §6.4: never resolves) — the registry-row peer a test seeds
 * to name a federated route it never answers on — is unreachable, whatever
 * else the test stubbed. A test that stubbed `fetch` otherwise owns its peer
 * mesh (`vi.stubGlobal("fetch", …)` routing peer URLs into in-process apps).
 * Without a stub, a loopback peer (a real in-process server) goes to the
 * global `fetch` and any other peer (`http://peer-….test`) is unreachable.
 * Unreachable rejects the way a failed fetch does, in-process, without a
 * socket. The network guard is untouched and still refuses any real dial.
 */
export const inProcessPeerFetch: typeof fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const host = new URL(url).hostname;
  const reachable =
    !host.endsWith(".invalid") && (globalThis.fetch !== GUARDED_FETCH || LOOPBACK_HOST.test(host));
  if (reachable) return globalThis.fetch(input, init);
  return Promise.reject(new TypeError(`fetch failed (peer ${url} unreachable in test)`));
};

/**
 * The network-touching boot services, replaced for tests: x402 talks to the
 * in-process facilitator (its `initialize()` otherwise fetches x402.org), and
 * the deposit detector — whose boot tick otherwise scans a public Base RPC —
 * is off, and peer relays are the in-process peer network
 * (`inProcessPeerFetch`). `createTestRelay` applies it; a test that calls
 * `createSyncRelay({...})` directly spreads it in. The relay suite's network
 * guard (`network-guard.setup.ts`) fails any test that reaches past it.
 */
/**
 * The minted insecure-dev posture (MOTEBIT_RELAY_INSECURE_NO_AUTH=1 under
 * NODE_ENV=test), for tests that exercise a relay with no master token. A
 * bare `{ kind: "insecure-dev" }` is not one — the relay seals its gates.
 */
export const INSECURE_DEV_POSTURE = resolveRelayAuthPosture({
  NODE_ENV: "test",
  MOTEBIT_RELAY_INSECURE_NO_AUTH: "1",
});

export const TEST_RELAY_NETWORK = {
  x402FacilitatorClient: fakeFacilitatorClient,
  depositDetectorRpc: null,
  federationPeerFetch: inProcessPeerFetch,
} as const satisfies Partial<SyncRelayConfig>;

/**
 * A facilitator that is never reachable — for tests that pin what the relay
 * does when the x402 facilitator is down (a payout that never settles). Every
 * call rejects the way a failed fetch does, in-process, without a socket.
 */
export const UNREACHABLE_FACILITATOR_CLIENT: unknown = {
  getSupported: () =>
    Promise.reject(new TypeError("fetch failed (facilitator unreachable in test)")),
  verify: () => Promise.reject(new TypeError("fetch failed (facilitator unreachable in test)")),
  settle: () => Promise.reject(new TypeError("fetch failed (facilitator unreachable in test)")),
};

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
    // The chain a P2P proof's payer is read from (#918). The harness default
    // models the honest delegator: a fake tx hash no test registered was
    // paid by the submitter. Tests of the payer rule inject their own chain
    // (`createFakePaymentChain` with `pay()`, or `paymentChainFromAdapter`
    // over a stub adapter).
    p2pPaymentChain: HONEST_PAYMENT_CHAIN,
    // The x402 reconciliation loop never reaches a real chain from a test
    // (#907 round 2): tests that exercise it inject a fake reader and call
    // `reconcilePendingX402Settlements` directly.
    x402ChainReader: null,
    // A test relay never reaches the network: x402 talks to the in-process
    // facilitator (its `initialize()` otherwise fetched x402.org and, unable
    // to, warned after the file's worker had closed — the relay suite's
    // `EnvironmentTeardownError` flake), and the deposit detector, whose boot
    // tick otherwise scans the public Base Sepolia RPC, is off.
    ...TEST_RELAY_NETWORK,
    // Tests use mock WebSocket connections that never disconnect, so the
    // production 5s drain grace would be paid in full on every `close()`
    // (afterEach) — ~5s/test, making the suite slow and timer-bound (the
    // contention-flake amplifier under parallel `turbo run test`). 10ms keeps
    // the drain code path exercised without the wall-clock + flake cost.
    drainGraceMs: 10,
    // Tests register workers on 127.0.0.1 — the local-development allowance.
    // Production keeps the default (false): only globally-routable endpoints.
    allowPrivateEndpoints: true,
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
// submission route still creates is the x402-paid one. That submission is
// drivable end to end over the real `@x402/hono` stack with an in-process
// facilitator (`x402-fake-facilitator.ts`, #907); this helper is the shortcut
// for tests about what happens AFTER it. It seeds the exact state a successful
// x402-paid submission leaves behind (a byte-faithful mirror of the x402
// branch in `tasks.ts` — queue entry with `x402_tx_hash`, auto-deposit credit,
// allocation hold capped at the payment + `relay_allocations` 'locked' row;
// `x402-settlement-907.test.ts` asserts the same state over the live route)
// so tests can drive the REAL
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

  // Admission records the path agent as the task's executor (#890 r6).
  recordTaskRoute(db, taskId, task.motebit_id);
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

  // Mirror: allocation hold sized from the SPENDABLE balance — the number the
  // debit enforces (#901) — and capped at this task's own x402 payment, so the
  // risk buffer never draws on the delegator's other funds (#907).
  const virtualBalance = Math.min(getSpendableBalance(db, args.delegatorId), priceSnapshot);

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

  // Mirror: the submission path's exact calls — the allocation row, then the
  // hold through the escrow chokepoint (allocation-escrow.ts). A refused hold
  // is a refusal — never seed a hold the ledger did not take (#901).
  db.exec("BEGIN");
  try {
    openAllocation(db, {
      allocationId: `x402-${taskId}`,
      taskId,
      worker: args.workerId,
      amountLocked: allocation.amount_locked,
      createdAt: now,
    });
    moveAllocationMoney(db, {
      kind: "hold",
      allocationId: `x402-${taskId}`,
      amount: allocation.amount_locked,
      party: args.delegatorId,
      description: `Hold for task ${taskId} to ${args.workerId}`,
    });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw new Error("seedX402PaidTask: allocation hold refused — spendable balance short", {
      cause: err,
    });
  }

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

  // Admission records the path agent as the task's executor (#890 r6).
  recordTaskRoute(db, taskId, task.motebit_id);
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
