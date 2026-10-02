/**
 * Task submission, polling, receipt ingestion, and settlement routes.
 *
 * handleReceiptIngestion is the unified receipt pipeline (~760 lines).
 * All three call sites (HTTP result POST, MCP forward callback, HTTP MCP
 * fallback callback) live within registerTaskRoutes. Exported in case
 * future refactoring moves the WebSocket or federation receipt paths here.
 */

import type { Hono } from "hono";
import type { TokenAudience } from "@motebit/protocol";
import type { OutboundUrlOptions } from "@motebit/sdk";
import { HTTPException } from "hono/http-exception";
import type { DatabaseDriver, MotebitDatabase } from "@motebit/persistence";
import type { IdentityManager } from "@motebit/core-identity";
import type { EventStore } from "@motebit/event-log";
import {
  AgentTaskStatus,
  asMotebitId,
  asAllocationId,
  asSettlementId,
  asGoalId,
  PLATFORM_FEE_RATE as SDK_DEFAULT_PLATFORM_FEE_RATE,
  AgentTrustLevel,
  EventType,
} from "@motebit/sdk";
import { evaluateTrustTransition, trustLevelToScore } from "@motebit/market";
import type {
  ExecutionReceipt,
  AgentTask,
  CapabilityPrice,
  BudgetAllocation,
  AgentTrustRecord,
} from "@motebit/sdk";
/* eslint-disable no-restricted-imports -- Relay service generates its own keypair (not a user surface) */
import {
  verifyExecutionReceipt,
  hexPublicKeyToDidKey,
  issueReputationCredential,
  sign,
  signSettlement,
  canonicalJson,
  bytesToHex,
  hexToBytes,
} from "@motebit/encryption";
/* eslint-enable no-restricted-imports */
import {
  explainedRankCandidates,
  settleOnReceipt,
  allocateBudget,
  computeGrossAmount,
  weightedSumComposite,
  lexicographicComposite,
  lexicographicOver,
} from "@motebit/market";
import type { CandidateProfile, CompositeFunction } from "@motebit/market";
import {
  computeP2pFeeMicro,
  computeFederatedFeeSplit,
  roundSettlementSplitMicro,
} from "@motebit/protocol";
import { getSpendableBalance, fromMicro, toMicro } from "./accounts.js";
import { allocationEscrowHeld } from "./dispute-fund-ledger.js";
import {
  AllocationMoneyRefused,
  allocationHoldPayer,
  moveAllocationMoney,
  openAllocation,
  recordP2pSettlementAudit,
} from "./allocation-escrow.js";
import { secretEquals } from "./secret-compare.js";
import { attemptPushWake } from "./push-adapter.js";
import { getRelayKeypair } from "./credentials.js";
import type { RelayIdentity } from "./federation.js";
import { attemptResultDelivery, defaultPeerFetch, enqueueResultDelivery } from "./federation.js";
import type { PeerFetch } from "./federation.js";
import {
  forwardTaskViaMcp,
  evaluateSettlementEligibility,
  type ReceiptCandidate,
  mintTaskDispatchToken,
  mintRelayMcpBearer,
  recordTaskRoute,
} from "./task-routing.js";
import type { TaskRouter } from "./task-routing.js";
import { getBondBackingAdapter } from "./bond-backing-adapter.js";
import { getArchivedReceiptForKeyOwner } from "./receipts-store.js";
import { admitReceipt } from "./task-answer.js";
import type { AnswerQueue } from "./task-answer.js";
import type { AnswerRefusal } from "./task-answer.js";
import {
  MAX_SETTLEMENT_DEPTH,
  exceedsSettlementDepth,
  settlementTreeDepths,
} from "./multihop-depth.js";
import type { ConnectedDevice } from "./index.js";
import { sendToEach } from "./ws-send.js";
import { routeToSockets } from "./task-presentation.js";
import {
  bindIdempotencyClaimToTask,
  bindP2pProofToTask,
  checkIdempotency,
  completeIdempotency,
  findP2pProofClaim,
  idempotencyClaimExists,
  IDEMPOTENCY_TTL_MS,
  p2pProofKey,
  recordAdmittedOutcome,
  type P2pProofClaim,
} from "./idempotency.js";
import { CALLER_VERIFIED_KEY, OPERATOR_PRESENTED } from "./auth-events.js";
import { payerCandidates } from "./p2p-payer.js";
import { isDerivedSettlementBinding } from "@motebit/wallet-solana";
import {
  localWorkerAdmission,
  p2pPayeeOf,
  p2pWorkerLegScope,
  receiptDischargesP2p,
  type P2pAdmission,
} from "./p2p-payee.js";
import { createLogger } from "./logger.js";
import { pathIdentity } from "./id-bounds.js";
import type { TaskQueue } from "./task-queue.js";
import { ExecutionReceiptSchema } from "@motebit/wire-schemas";
import {
  RelayError,
  AuthenticationError,
  AuthorizationError,
  InsufficientFundsError,
  AllocationError,
  TaskError,
  P2pProofAlreadyAdmittedError,
  X402OutcomeUnknownError,
  X402PaymentReplayedError,
  type X402SettlementRef,
} from "./errors.js";
import {
  classifySettleVerdict,
  creditX402Settlement,
  findPendingX402ForKey,
  findX402Settlement,
  markX402Failed,
  readEip3009Authorization,
  recordX402Intent,
  X402_MAX_VALIDITY_SECONDS,
  X402_MAX_WINDOW_SECONDS,
  type SettleOutcome,
  type X402SettlementRecord,
} from "./x402-settlements.js";

/** What a client is told about an x402 settlement record (never the task's contents). */
function x402SettlementRef(
  rec: Pick<
    X402SettlementRecord,
    "payer" | "nonce" | "amount_micro" | "delegator_id" | "network" | "status" | "valid_before"
  >,
): X402SettlementRef {
  return {
    payer: rec.payer,
    nonce: rec.nonce,
    amount_micro: rec.amount_micro,
    delegator: rec.delegator_id,
    network: rec.network,
    status: rec.status,
    valid_before: rec.valid_before,
  };
}
import { isGrantRevokedBy } from "./delegation-revocations.js";
import { ON_SHELF, ON_SHELF_PREDICATE } from "./registry-delist.js";
import { identityGuardianFor, verificationKeyFor } from "./identity-keys.js";
import type { ReconcileKeyConnections } from "./connection-ports.js";

const logger = createLogger({ service: "tasks" });

// --- Constants ---
// Exported so index.ts can assert the stale-allocation sweep horizon stays
// safely above the maximum task lifetime (initial TTL + the single
// receipt-time extension below) — sweeping a live task's allocation would
// open a refund/settlement double-credit race.
export const TASK_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Retention for a COMPLETED task the delegator paid for (P2P settlement).
 * A paid artifact must outlive a slow client: the payer already settled
 * onchain, so reaping the receipt at the free-task TTL makes the paid
 * result unrecoverable when polling stalls (token expiry, network) — the
 * #424 fund-loss-adjacent shape. Allocation-horizon safety: P2P tasks hold
 * NO budget allocation (they settle onchain, not from a relay-custody
 * allocation), so the `STALE_ALLOCATION_HORIZON_MS >= 3 * TASK_TTL_MS`
 * refund-race guard in index.ts is not implicated by this longer retention.
 */
export const PAID_TASK_RESULT_RETENTION_MS = 60 * 60 * 1000; // 1 hour

/**
 * How long an answered entry stays readable: paid (P2P) results outlive the
 * free-task TTL — the payer settled onchain and must be able to recover the
 * artifact after a stalled poll.
 */
function resultRetentionMs(
  entry: Pick<TaskQueueEntry, "settlement_mode" | "p2p_payment_proof">,
): number {
  return entry.settlement_mode === "p2p" || entry.p2p_payment_proof != null
    ? PAID_TASK_RESULT_RETENTION_MS
    : TASK_TTL_MS;
}
const MAX_TASK_QUEUE_SIZE = 100_000; // Hard cap prevents memory exhaustion

/** Shape of each entry in the in-memory task queue. */
export type TaskQueueEntry = {
  task: AgentTask;
  receipt?: ExecutionReceipt;
  expiresAt: number;
  submitted_by?: string;
  /** Gross amount x402 charged at submission time (from listing price). */
  price_snapshot?: number;
  /** x402 on-chain transaction hash captured from the payment settlement. */
  x402_tx_hash?: string;
  /** x402 network (CAIP-2) captured from the payment settlement. */
  x402_network?: string;
  /** When set, this task was forwarded from a peer relay and the result should be returned there. */
  origin_relay?: string;
  /** Set to true after receipt settlement completes — prevents double-settlement. */
  settled?: boolean;
  /**
   * The signature of the receipt this task's settlement is CLAIMED for
   * (#890 round 9) — set by `answerTask` in the same write that takes the
   * answer, so the answer and its settlement are one decision: once set, the
   * answer is frozen and every door settles only this receipt.
   */
  settling?: string;
  /**
   * The door the settlement claim was taken by (#890 round 10) — written with
   * `settling`, in the same write. The settlement-recovery sweep replays a
   * claimed-but-unsettled answer through THIS door's settlement step (the
   * federation door with its peer, a sub-task through its parent's answer).
   */
  settle_via?: import("./task-answer.js").AnswerDoor;
  /**
   * The entry's answer version (#890 round 9), stepped by every answer write
   * (`TaskQueue.writeAnswer`). A copy carrying an older version is refused by
   * `TaskQueue.set` — it would silently undo a newer answer.
   */
  answer_version?: number;
  /** Settlement mode: "relay" (default) or "p2p" (direct onchain). */
  settlement_mode?: "relay" | "p2p";
  /**
   * P2P payment proof (when settlement_mode === "p2p"). After Arc 2 of
   * the off-ramp arc, carries the fee-leg fields so the relay can
   * record and verify both delegator→worker and delegator→treasury
   * transfers from the same atomic multi-output Solana tx.
   */
  p2p_payment_proof?: {
    tx_hash: string;
    chain: string;
    network: string;
    to_address: string;
    amount_micro: number;
    fee_to_address: string;
    fee_amount_micro: number;
    /** Executor-relay (B) fee leg — cross-operator federated P2P only. */
    b_fee_to_address?: string;
    b_fee_amount_micro?: number;
  };
  /** Target agent for p2p tasks (pinned routing). */
  target_agent?: string;
  /**
   * What P2P ADMISSION decided about the worker leg (#959) — stamped by the
   * admission branch that accepted the proof, never inferred from the proof's
   * (payer-supplied) shape. Every P2P settlement writer reads it.
   */
  p2p_admission?: P2pAdmission;
  /**
   * Standing-delegation grant the task was declared under (checkpoint D4).
   * Persisted for audit lineage; the acceptance-time revocation fence
   * already ran when this entry exists. Advisory id, never authority.
   */
  grant_id?: string;
};

// Platform fee rate is no longer a module-level variable. It lives in the
// closure of `registerTaskRoutes` (see the function body below), guaranteeing
// every registered handler sees the same rate and different relay instances
// don't clobber each other's state. SDK_DEFAULT_PLATFORM_FEE_RATE is the
// fallback when `deps.platformFeeRate` is omitted.

export interface TasksDeps {
  app: Hono;
  moteDb: MotebitDatabase;
  identityManager: IdentityManager;
  eventStore: EventStore;
  relayIdentity: RelayIdentity;
  connections: Map<string, ConnectedDevice[]>;
  /**
   * The production queue is `TaskQueue` (SQLite-backed) whose indexed
   * `countBySubmitter` the fairness check uses (#459 — the Map-iteration
   * fallback is a full-table scan there). Tests may inject a plain Map;
   * the check falls back to iteration, which is fine at test scale.
   */
  taskQueue: Map<string, TaskQueueEntry> &
    AnswerQueue & {
      countBySubmitter?: (submitterId: string) => number;
    };
  taskRouter: TaskRouter;
  issueCredentials: boolean;
  apiToken?: string;
  /** Outbound URL law applied to every MCP forward (`buildOutboundPolicy`). */
  outboundPolicy?: OutboundUrlOptions;
  /** The peer transport (`PeerFetch`); omitted, the global `fetch`. */
  peerFetch?: PeerFetch;
  enableDeviceAuth: boolean;
  maxTasksPerSubmitter: number;
  x402Config: {
    payToAddress: string;
    network: string;
    facilitatorUrl?: string;
    testnet?: boolean;
  };
  /**
   * An injected facilitator client (tests: the in-process fake). Omitted:
   * `createX402FacilitatorClient(x402Config)`, the canonical construction.
   */
  x402FacilitatorClient?: unknown;
  /**
   * Hands the relay a promise this module started but does not await (the
   * facilitator `initialize()`), so `close()` awaits it. Omitted: untracked.
   */
  trackStartup?: (work: Promise<unknown>) => void;
  /**
   * Aborts when the relay shuts down: a facilitator handshake still pending
   * then rejects at once instead of holding `close()`. Omitted: unbounded.
   */
  shutdownSignal?: AbortSignal;
  /** Auth helpers from relay auth layer */
  parseTokenPayloadUnsafe: (token: string) => import("./auth.js").TokenPayload | null;
  verifySignedTokenForDevice: (
    token: string,
    motebitId: string,
    identityManager: IdentityManager,
    expectedAudience: TokenAudience,
    blacklistCheck?: (jti: string, motebitId: string) => boolean,
    agentRevokedCheck?: (motebitId: string) => boolean,
  ) => Promise<boolean>;
  isTokenBlacklisted: (jti: string, motebitId: string) => boolean;
  isAgentRevoked: (motebitId: string) => boolean;
  /** Platform fee rate (0–1). Defaults to SDK constant (0.05) if not provided. */
  platformFeeRate?: number;
  /**
   * The chain the payer of a P2P `payment_proof` is read from (#918,
   * p2p-payer.ts). `null` — no Solana RPC configured — refuses every P2P
   * submission (fail closed): an unverified payer is never admitted.
   */
  p2pPaymentChain: import("./p2p-payer.js").P2pPaymentChain | null;
  /** Settlement rail registry — for attaching payment proofs through the rail boundary. */
  railRegistry?: import("@motebit/settlement-rails").SettlementRailRegistry;
  /** Push adapter for waking offline mobile devices. */
  pushAdapter?: import("./push-adapter.js").PushAdapter;
  /**
   * The receipt heal moves the registry key — the fallback a service-mode
   * socket was admitted under — so the sockets it no longer admits are
   * closed after the write (#776). Required: optional, the heal would
   * silently leave them open.
   */
  reconcileKeyConnections: ReconcileKeyConnections;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function extractMotebitIdFromPath(path: string): string | null {
  const match = path.match(/\/agent\/([^/]+)\/task/);
  return match ? match[1]! : null;
}

/**
 * The listing unit_cost an agent charges. When `capability` is given, price THAT
 * capability (a delegation is for one capability); otherwise sum all capabilities
 * (legacy behavior, correct only for single-capability agents). Summing a
 * multi-capability agent — a web-search+read-url atom — over-charges a
 * single-capability hop, so the P2P sub-hop path always passes the capability.
 */
export function getListingUnitCost(
  moteDb: MotebitDatabase,
  agentId: string,
  capability?: string,
): number {
  const row = moteDb.db
    .prepare(
      "SELECT pricing FROM relay_service_listings WHERE motebit_id = ? ORDER BY updated_at DESC LIMIT 1",
    )
    .get(agentId) as { pricing: string } | undefined;
  if (!row) return 0;
  try {
    const pricing = JSON.parse(row.pricing) as CapabilityPrice[];
    if (capability != null) {
      const listed = pricing.find((p) => p.capability === capability)?.unit_cost;
      if (listed != null) return listed;
      // An UNLISTED capability against a priced worker prices at the worker's
      // ceiling, never at 0: a `required_capabilities: ["bogus"]` submission
      // must not clear the P2P gate for free and walk away with a dispatch
      // token the worker will honor (task-admission.md). Unpriced workers
      // still price at 0.
      return pricing.reduce((max, p) => Math.max(max, p.unit_cost ?? 0), 0);
    }
    return pricing.reduce((sum, p) => sum + (p.unit_cost ?? 0), 0);
  } catch {
    return 0;
  }
}

/** What a task submission costs, and who is being paid for it. */
export interface SubmissionPrice {
  /** The agent whose listing prices the task: `target_agent` when set, else the path agent. */
  pricingAgent: string;
  /** The single capability a pinned delegation prices, when it names exactly one. */
  pricingCapability: string | undefined;
  /** Listing unit cost in dollars (net to the worker). 0 = free. */
  unitCost: number;
  /** Gross price (unit cost + platform fee) in integer micro-units. 0 = free. */
  grossMicro: number;
  /**
   * The pricing agent's onchain `pay_to_address`, or null when it publishes
   * none. The x402 gate arms only for a listing that publishes one, and that
   * is ALL it decides. It is not the x402 destination: x402 pays the relay
   * treasury (`x402Config.payToAddress`) and the worker is paid from its
   * virtual account at settlement (#907). Nor is it "does this agent charge":
   * the relay-custody lane credits the worker's VIRTUAL ACCOUNT and never
   * reads it, so a priced agent with no payout address still charges
   * (`grossMicro > 0`). Reading it as "free" made "priced and unpayable"
   * representable (`priced-unpayable-listing.test.ts`).
   */
  payTo: string | null;
}

/**
 * The price of a task submission, for the worker it is routed to — called
 * only by `submissionTerms`, which decides that worker (#901 round 3).
 *
 * One price for every reader (#901 round 2). The submit handler's
 * `price_snapshot` (which the budget hold, the x402 deposit credit and
 * settlement all read) and the x402 gate (what it charges onchain, and
 * whether the delegator's spendable balance lets it skip x402) both call this.
 *
 * They used to price differently: the gate summed every capability the PATH
 * agent lists; the handler prices `target_agent` when one is set, and the one
 * capability a pinned delegation names. When the two disagreed the gate could
 * send to x402 a task the handler then funded from the virtual account — the
 * onchain payment settles after a 2xx, so the delegator paid twice — or ask
 * x402 for less than the deposit the handler credits.
 *
 * Price against the WORKER, not the URL agent: a P2P proof submission carries
 * `target_agent` (the worker) and POSTs to the DELEGATOR's own endpoint, so the
 * URL agent is the delegator — pricing by it would validate the hop against the
 * delegator's own listing (a $0.25 researcher paying a $0.003 atom would be
 * checked against $0.25). And price the SPECIFIC capability the delegation
 * pins, not the sum of the worker's listings (`pinned`: the submission names
 * its worker as `target_agent`). A submission with no `target_agent` prices
 * the URL agent (the worker), summed, as before.
 */
function priceSubmission(
  moteDb: MotebitDatabase,
  pricingAgent: string,
  pinned: boolean,
  body: { required_capabilities?: unknown },
  platformFeeRate: number,
): SubmissionPrice {
  const pricingCapability =
    pinned && Array.isArray(body.required_capabilities) && body.required_capabilities.length === 1
      ? String(body.required_capabilities[0])
      : undefined;
  const unitCost = getListingUnitCost(moteDb, pricingAgent, pricingCapability);
  const grossMicro = unitCost > 0 ? toMicro(computeGrossAmount(unitCost, platformFeeRate)) : 0;
  const row = moteDb.db
    .prepare(
      "SELECT pay_to_address FROM relay_service_listings WHERE motebit_id = ? ORDER BY updated_at DESC LIMIT 1",
    )
    .get(pricingAgent) as { pay_to_address: string | null } | undefined;
  const payTo =
    row?.pay_to_address != null && row.pay_to_address !== "" ? row.pay_to_address : null;
  return { pricingAgent, pricingCapability, unitCost, grossMicro, payTo };
}

/**
 * Read a task-submission body: a JSON object or a 400 — never a 500 from a
 * handler dereferencing `null` or an array (#901 round 3).
 */
async function readSubmissionBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await c.req.json();
  } catch {
    throw new TaskError("TASK_INVALID_INPUT", "Request body must be a JSON object", 400);
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TaskError("TASK_INVALID_INPUT", "Request body must be a JSON object", 400);
  }
  return parsed as Record<string, unknown>;
}

/** How a submission is read: who submits it, which worker it goes to, and what it costs. */
export type SubmissionTerms =
  | {
      ok: true;
      /** The delegator: the authenticated caller, else the body's `submitted_by`. */
      submitter: string | undefined;
      /** A P2P proof submission: `payment_proof` + `target_agent` + a submitter. */
      p2p: boolean;
      /**
       * The worker the task is routed to — the proof's pinned `target_agent`
       * on P2P, else the path agent. ALWAYS the agent `price` is for.
       */
      routedTo: string;
      price: SubmissionPrice;
    }
  | { ok: false; message: string };

/**
 * The ONE reading of a task submission (#901 rounds 2–3), shared by the x402
 * gate and the submit handler. It decides the submitter, whether the
 * submission is P2P, the worker the task is ROUTED to, and the price — and
 * the price is always for the worker the task is routed to.
 *
 * `target_agent` routes a task only on a P2P proof submission (the pinned
 * dispatch and the federated forward both key on it there, and the proof's
 * legs are validated against it). Anywhere else the relay routes from the
 * path agent. Pricing a `target_agent` that routes nothing let any caller
 * name an unlisted agent (price 0) or a cheap one and have the path agent —
 * a priced worker — work for free or for the cheap agent's price (#901
 * round 3). So a non-P2P submission may name only the path agent itself as
 * `target_agent`; any other target is refused, before admission.
 *
 * `submitted_by`, when present, must be a non-empty string (the gate and the
 * handler used to disagree about `""`). The handler maps a refusal to 400;
 * the gate charges nothing on a refusal and lets the handler refuse.
 */
export function submissionTerms(
  moteDb: MotebitDatabase,
  pathAgentId: string,
  callerMotebitId: string | undefined,
  body: unknown,
  platformFeeRate: number,
): SubmissionTerms {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Request body must be a JSON object" };
  }
  const b = body as {
    submitted_by?: unknown;
    target_agent?: unknown;
    payment_proof?: unknown;
    required_capabilities?: unknown;
  };
  if (b.submitted_by != null && (typeof b.submitted_by !== "string" || b.submitted_by === "")) {
    return { ok: false, message: "submitted_by must be a non-empty string when present" };
  }
  if (b.target_agent != null && typeof b.target_agent !== "string") {
    return { ok: false, message: "target_agent must be a string when present" };
  }
  const target =
    typeof b.target_agent === "string" && b.target_agent !== "" ? b.target_agent : null;
  const caller =
    typeof callerMotebitId === "string" && callerMotebitId !== "" ? callerMotebitId : undefined;
  const submitter = caller ?? (b.submitted_by as string | undefined);
  const p2p = Boolean(b.payment_proof) && target != null && submitter != null;
  if (target != null && !p2p && target !== pathAgentId) {
    return {
      ok: false,
      message:
        "target_agent pins a worker only on a P2P submission (payment_proof + target_agent + submitter); " +
        "without one the task goes to the agent in the path — POST to /agent/<target>/task instead",
    };
  }
  const routedTo = p2p && target != null ? target : pathAgentId;
  const price = priceSubmission(moteDb, routedTo, target != null, b, platformFeeRate);
  return { ok: true, submitter, p2p, routedTo, price };
}

/**
 * Arc 3.5 P2P-by-default gate predicate. Returns `true` ⟺ a submission must be
 * rejected with `TASK_P2P_PROOF_REQUIRED` (402): paid direct delegation to a
 * DIFFERENT worker, settling relay-custody, with no P2P proof and no x402 proof.
 *
 * Pure and exported so the carve-out matrix is unit-testable as a truth table.
 * The three carve-outs (false return): zero-cost (`unitCostAtSubmission === 0`),
 * self-delegation (`submittedBy === workerId`), and x402-paid (`x402Paid`: this
 * request carries an x402 payment the gate VERIFIED and bound to it, which the
 * handler settles to the relay treasury before admission — #907; a settlement
 * that then fails refuses the submission, so an unpaid task never passes here).
 * See docs/doctrine/off-ramp-as-user-action.md § "Arc 3.5".
 */
export function requiresP2pProof(args: {
  settlementMode: "relay" | "p2p";
  x402Paid: boolean;
  unitCostAtSubmission: number;
  submittedBy: string | null | undefined;
  workerId: string;
}): boolean {
  return (
    args.settlementMode === "relay" &&
    !args.x402Paid &&
    args.unitCostAtSubmission > 0 &&
    args.submittedBy != null &&
    args.submittedBy !== args.workerId
  );
}

/** A replayed dispatch token this close to `exp` will not survive the hop — treat as expired. */
const DISPATCH_TOKEN_REMINT_MARGIN_MS = 60_000;

/**
 * Idempotent replay ⇒ the same response, INCLUDING the same dispatch token —
 * which lives 15 minutes while the idempotency window lives 24 hours. A
 * delegator whose first presentation died without a receipt and who retries
 * after the TTL would replay an expired token and be refused until the window
 * lapsed (the retry gap named in docs/doctrine/task-admission.md; the worker
 * half — re-admitting a receiptless `sub` — shipped with the one-presenter arc).
 *
 * This is the relay half: when the replayed body carries a dispatch token that
 * is expired (or within a minute of it) AND the task still has no receipt, mint
 * a fresh token for the SAME task id and prompt digest. A task that already
 * produced a receipt is left alone — its replay should send the delegator to
 * the result, never to a second admission — and so is any body without a
 * token. Same `sub`, same `digest`, same worker: nothing about what was
 * admitted changes, only the clock.
 */
export async function refreshDispatchTokenOnReplay(
  replayed: Record<string, unknown>,
  deps: {
    taskQueue: Pick<TaskQueue, "get">;
    relayIdentity: RelayIdentity;
    parseTokenPayloadUnsafe: (token: string) => { mid?: string; exp?: number } | null;
    now?: () => number;
  },
): Promise<Record<string, unknown>> {
  const token = replayed["dispatch_token"];
  const taskId = replayed["task_id"];
  if (typeof token !== "string" || typeof taskId !== "string") return replayed;
  const claims = deps.parseTokenPayloadUnsafe(token);
  if (claims == null || typeof claims.mid !== "string" || typeof claims.exp !== "number") {
    return replayed;
  }
  const now = (deps.now ?? Date.now)();
  if (claims.exp - now > DISPATCH_TOKEN_REMINT_MARGIN_MS) return replayed; // still live
  const entry = deps.taskQueue.get(taskId);
  if (entry == null) return replayed; // aged out of the queue — nothing to admit
  const terminal =
    entry.receipt != null ||
    entry.task.status === AgentTaskStatus.Completed ||
    entry.task.status === AgentTaskStatus.Failed ||
    entry.task.status === AgentTaskStatus.Denied;
  if (terminal) return replayed;
  // Stamp the re-mint with the same clock that judged the old token expired:
  // with the real clock, a re-mint in the same millisecond as the original
  // would carry an identical `exp` — indistinguishable to a worker's
  // "later than what I saw" check, and a flake in tests with an injected now.
  const fresh = await mintTaskDispatchToken(
    deps.relayIdentity,
    claims.mid,
    taskId,
    entry.task.prompt,
    now,
  );
  logger.info("task.dispatch_token_reminted", {
    correlationId: taskId,
    worker: claims.mid,
    reason: claims.exp <= now ? "expired" : "expiring",
  });
  return { ...replayed, dispatch_token: fresh };
}

/**
 * May a refusal of an already-admitted P2P proof name the task it funds
 * (#918)? Only to:
 *
 *   - the operator, marked POSITIVELY by the master-token door, never
 *     inferred from an unset caller id (a relay with no API token configured
 *     leaves every caller unset); or
 *   - a caller whose signed token verified as the claim's submitter, when that
 *     submitter was itself token-verified at admission (`submitter_verified`).
 *     A submitter the operator asserted in a body, or a peer relay forwarded,
 *     is not proven, so no caller is ever shown that task as its own.
 *
 * Everyone else gets the refusal without the id (cf. #903).
 */
export function mayDiscloseAdmittedTask(
  claim: P2pProofClaim,
  caller: { operator: boolean; verifiedCaller: string | undefined },
): boolean {
  if (caller.operator) return true;
  return (
    claim.submitter_verified === 1 &&
    typeof caller.verifiedCaller === "string" &&
    caller.verifiedCaller !== "" &&
    caller.verifiedCaller === claim.submitted_by
  );
}

/** Context key the submit handler stamps once its admission transaction commits (#888). */
export const ADMITTED_TASK_KEY = "idempotencyAdmittedTask";

/** The task a submission admitted, and the idempotency claim that names it. */
export interface AdmittedTask {
  key: string;
  motebitId: string;
  taskId: string;
}

/**
 * One Idempotency-Key admits at most one task (#888). Runs after the submit
 * handler on EVERY exit — the 201, a thrown error rendered by the error
 * boundary, or any other response — and, when the request admitted a task,
 * records the response the client is about to receive as the claim's terminal
 * outcome, with the admitted `task_id` added to it. A same-key replay then
 * returns that response and that task id; it never finds the key free and
 * admits a second task.
 *
 * It used to be that a submission throwing after enqueue (a federation forward
 * rejected or timed out, a 402 from the ranking loop, a token mint) released
 * its claim at the error boundary while its task stayed queued, so a client
 * whose response was lost and who retried with the same key was admitted a
 * second task. Recording at this one seam, rather than at each throw point, is
 * what makes the rule hold for throw points added later. A refusal that needs
 * no admitted task (funding, the federated-P2P discovery and validation) runs
 * BEFORE admission instead, so it frees the key for a corrected retry.
 *
 * A 201 has already completed its claim in the handler; the write here then
 * matches nothing and the response is left exactly as it was.
 */
export async function recordAdmissionOutcome(
  db: Parameters<typeof recordAdmittedOutcome>[0],
  admitted: AdmittedTask,
  res: Response,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await res.clone().json();
    body =
      parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { error: "Task admission did not complete", status: res.status };
  } catch {
    body = { error: "Task admission did not complete", status: res.status };
  }
  const outcome = { ...body, task_id: admitted.taskId };
  const serialized = JSON.stringify(outcome);
  const recorded = recordAdmittedOutcome(
    db,
    admitted.key,
    admitted.motebitId,
    admitted.taskId,
    res.status,
    serialized,
  );
  if (!recorded) return res; // the handler completed its claim (201) — nothing to add
  logger.warn("task.admitted_then_failed", {
    correlationId: admitted.taskId,
    taskId: admitted.taskId,
    motebitId: admitted.motebitId,
    status: res.status,
  });
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return new Response(serialized, { status: res.status, headers });
}

/**
 * The worker key an executor relay sends with a federation result: the
 * holder, else main's registry read (§5f verification reader).
 */
export function workerKeyFor(db: DatabaseDriver, motebitId: string): string | null {
  const reg = db
    .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
    .get(motebitId) as { public_key: string | null } | undefined;
  return verificationKeyFor(db, motebitId, reg?.public_key);
}

// ---------------------------------------------------------------------------
// Unified receipt ingestion pipeline
// ---------------------------------------------------------------------------
// ALL receipts — regardless of transport (HTTP POST, MCP forward, WebSocket,
// federation) — flow through this single function. It handles:
//   1. Idempotency (DB settlement check + in-memory settled flag)
//   2. Ed25519 signature verification
//   3. Trust record update (evaluateTrustTransition)
//   4. Delegation edge caching (multi-hop routing intelligence)
//   5. Multi-hop settlement (nested delegation_receipts)
//   6. Latency recording
//   7. Main settlement (settleOnReceipt) + virtual account credits
//   8. Credential issuance (AgentReputationCredential)
//   9. WebSocket fan-out
//  10. Federation result forwarding
//
// Returns { verified: true } on success, { verified: false, reason } on failure.
// Callers decide how to surface the failure (HTTP 403, log warning, etc.).
export async function handleReceiptIngestion(
  receipt: ExecutionReceipt,
  taskId: string,
  motebitId: string,
  entry: TaskQueueEntry,
  /** The local door the receipt arrived by (#890 r8). */
  door: "result_post" | "mcp_forward",
  /** How long the answered entry is kept readable. */
  retainMs: number,
  deps: {
    moteDb: MotebitDatabase;
    identityManager: IdentityManager;
    eventStore: EventStore;
    relayIdentity: RelayIdentity;
    connections: Map<string, ConnectedDevice[]>;
    taskQueue: Map<string, TaskQueueEntry> & AnswerQueue;
    issueCredentials: boolean;
    /**
     * Platform fee rate (0–1) for this relay instance. Passed explicitly
     * so there is no module-level global state — every caller provides the
     * rate, every handler sees the one it was called with. Previous code
     * used a module-level `let PLATFORM_FEE_RATE` which could be clobbered
     * by concurrent relay instantiations.
     */
    platformFeeRate: number;
    /** Maximum delegation chain depth for multi-hop settlement. Default: 10. */
    maxSettlementDepth?: number;
    /** Closes the sockets the heal's moved registry key no longer admits (#776). */
    reconcileKeyConnections: ReconcileKeyConnections;
    /** The peer transport (`PeerFetch`) the federation result is delivered by. */
    peerFetch?: PeerFetch;
  },
): Promise<
  | { verified: true; credential_id: string | null; already_settled?: boolean }
  | { verified: false; reason: string; refusal: AnswerRefusal; answer?: ExecutionReceipt }
> {
  const {
    moteDb,
    identityManager,
    eventStore,
    relayIdentity,
    connections,
    taskQueue,
    issueCredentials,
    platformFeeRate,
  } = deps;
  const peerFetch = deps.peerFetch ?? defaultPeerFetch;

  // --- The answer and its settlement (#890 r8/r9): ONE door routine ---
  // `admitReceipt` (task-answer.ts) decides the answer at the chokepoint —
  // binding, P2P payee (#959), recorded executor for this task's origin
  // (#890 r6/r7), signature, write-once — claims its settlement in the same
  // write, and runs the settlement step below on the ENTRY'S receipt: on the
  // first pass, and on a repeat whose settlement never completed (a crash or
  // a failed step between the claim and the settle). Only a completed step
  // marks the entry settled.
  let credential_id: string | null = null;
  let pubKeyHex = "";
  const admission = await admitReceipt(
    {
      db: moteDb.db,
      identityManager,
      taskQueue,
      verifyReceipt: (r, keyHex) => verifyExecutionReceipt(r, hexToBytes(keyHex)),
      // Main's heal (#758 review): the registry is departure's and the
      // signature readers' INPUT for an identity with no holder. The
      // chokepoint calls this only for an embedded key that is ALREADY a
      // registered device of the signer and that the receipt verified under
      // — never an arbitrary self-signed key (a cross-identity hijack).
      // Legitimate rotation is the /rotate-key succession route.
      healRegistryKey: (signer, keyHex) => {
        moteDb.db
          .prepare("UPDATE agent_registry SET public_key = ? WHERE motebit_id = ?")
          .run(keyHex, signer);
        // The registry key is the fallback a socket with no device row was
        // admitted under; a socket the previous value admitted is no longer
        // admitted and is closed (#776).
        deps.reconcileKeyConnections(signer);
      },
    },
    taskId,
    receipt,
    { kind: door },
    retainMs,
    async ({ entry: claimed, receipt: answer, verdict, newlyArchived }) => {
      entry = claimed;
      receipt = answer;
      pubKeyHex = verdict.publicKeyHex;
      return settleLocalAnswer(newlyArchived);
    },
  );
  if (!admission.took) {
    return {
      verified: false,
      reason: admission.reason,
      refusal: admission.refusal,
      ...(admission.answer != null ? { answer: admission.answer } : {}),
    };
  }
  if (admission.alreadySettled) {
    if (admission.repeat) {
      // The parent's identical retry re-walks its nested sub-receipts whose
      // claims a failed sub-settlement left unsettled (#890 r10).
      entry = admission.entry;
      receipt = admission.receipt;
      await settleNestedReceipts(true);
    }
    return { verified: true, credential_id: null, already_settled: true };
  }
  entry = admission.entry;
  receipt = admission.receipt;
  return deliverLocalAnswer();

  /**
   * The settlement step for the local doors (the result POST and the MCP
   * forward): trust, edges, sub-receipts, latency, the main settlement and
   * credentials — bound to the ENTRY'S claimed receipt. `true` once the
   * settlement decision is complete; `false` when it failed (retry settles).
   */
  async function settleLocalAnswer(newlyArchived: boolean): Promise<boolean> {
    logger.info("receipt.verified", {
      correlationId: taskId,
      status: receipt.status,
      motebitId: receipt.motebit_id,
    });
    // The signed receipt tree was archived by `admitReceipt` before this step
    // (`newlyArchived` false: an earlier pass archived it — trust updates and
    // credential issuance below are exactly-once per receipt).

    // --- Trust record update ---
    const taskSubmitter = entry.submitted_by ?? entry.task.submitted_by;
    const isSelfDelegation = taskSubmitter != null && taskSubmitter === receipt.motebit_id;
    if (isSelfDelegation) {
      logger.info("trust.self_delegation_skipped", {
        correlationId: taskId,
        motebitId,
        reason: "submitter === executor — no trust signal or credential issued",
      });
    }
    if (!isSelfDelegation && newlyArchived) {
      try {
        const executingAgentId = receipt.motebit_id;
        const taskSucceeded = receipt.status === "completed";
        const taskFailed = receipt.status === "failed";
        const now = Date.now();

        // Quality gate: reclassify low-quality completions as failures
        let resultQuality = 1.0;
        if (taskSucceeded) {
          const resultStr = typeof receipt.result === "string" ? receipt.result : "";
          const lengthScore = Math.min(resultStr.length, 500) / 500;
          const toolScore = Math.min(receipt.tools_used?.length ?? 0, 3) / 3;
          const latencyMs = (receipt.completed_at ?? 0) - (receipt.submitted_at ?? 0);
          const latencyScore =
            latencyMs > 0 ? Math.min(Math.max(latencyMs, 500), 5000) / 5000 : 0.5;
          resultQuality = 0.6 * lengthScore + 0.3 * toolScore + 0.1 * latencyScore;
        }
        const effectiveSuccess = taskSucceeded && resultQuality >= 0.2;
        const effectiveFailure = taskFailed || (taskSucceeded && resultQuality < 0.2);

        const existing = await moteDb.agentTrustStore.getAgentTrust(motebitId, executingAgentId);

        if (existing) {
          const alpha = 0.3;
          const prevQuality = existing.avg_quality ?? 1.0;
          const newQuality = alpha * resultQuality + (1 - alpha) * prevQuality;

          const updated: AgentTrustRecord = {
            ...existing,
            last_seen_at: now,
            interaction_count: existing.interaction_count + 1,
            successful_tasks: (existing.successful_tasks ?? 0) + (effectiveSuccess ? 1 : 0),
            failed_tasks: (existing.failed_tasks ?? 0) + (effectiveFailure ? 1 : 0),
            avg_quality: newQuality,
            quality_sample_count: (existing.quality_sample_count ?? 0) + 1,
          };
          const newLevel = evaluateTrustTransition(updated);
          if (newLevel != null) {
            const previousLevel = existing.trust_level;
            updated.trust_level = newLevel;
            try {
              const clock = await eventStore.getLatestClock(asMotebitId(motebitId));
              await eventStore.append({
                event_id: crypto.randomUUID(),
                motebit_id: asMotebitId(motebitId),
                timestamp: now,
                event_type: EventType.TrustLevelChanged,
                payload: {
                  remote_motebit_id: executingAgentId,
                  previous_level: previousLevel,
                  new_level: newLevel,
                  successful_tasks: updated.successful_tasks,
                  failed_tasks: updated.failed_tasks,
                  source: "relay_receipt_verification",
                },
                version_clock: clock + 1,
                tombstoned: false,
              });
            } catch {
              // Event emission is best-effort
            }
          }
          await moteDb.agentTrustStore.setAgentTrust(updated);
        } else {
          await moteDb.agentTrustStore.setAgentTrust({
            motebit_id: asMotebitId(motebitId),
            remote_motebit_id: asMotebitId(executingAgentId),
            trust_level: AgentTrustLevel.FirstContact,
            first_seen_at: now,
            last_seen_at: now,
            interaction_count: 1,
            successful_tasks: effectiveSuccess ? 1 : 0,
            failed_tasks: effectiveFailure ? 1 : 0,
            avg_quality: resultQuality,
            quality_sample_count: 1,
          });
        }
      } catch {
        // Trust update is best-effort — don't block receipt delivery
      }
    }

    // --- Delegation edge caching ---
    if (receipt.delegation_receipts && receipt.delegation_receipts.length > 0) {
      try {
        const insertEdge = moteDb.db.prepare(
          `INSERT INTO relay_delegation_edges
         (from_motebit_id, to_motebit_id, trust, cost, latency_ms, reliability, regulatory_risk, recorded_at, receipt_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        const walkReceipts = async (
          parentMotebitId: string,
          receipts: ExecutionReceipt[],
        ): Promise<void> => {
          for (const sub of receipts) {
            if (sub.signature) {
              let subPubKey: string | undefined;
              const subReg = moteDb.db
                .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
                .get(sub.motebit_id) as { public_key: string } | undefined;
              // Holder, else main's registry read (§5f verification reader).
              const subKey = verificationKeyFor(moteDb.db, sub.motebit_id, subReg?.public_key);
              if (subKey !== null) {
                subPubKey = subKey;
              } else {
                const subDevices = await identityManager.listDevices(asMotebitId(sub.motebit_id));
                subPubKey = subDevices.find((d) => d.public_key)?.public_key;
              }
              if (subPubKey) {
                const subValid = await verifyExecutionReceipt(sub, hexToBytes(subPubKey));
                if (!subValid) {
                  logger.warn("delegation_receipt.signature_invalid", {
                    correlationId: taskId,
                    parentAgent: parentMotebitId,
                    delegatedAgent: sub.motebit_id,
                  });
                  continue;
                }
              }
            }

            const latency =
              sub.completed_at && sub.submitted_at ? sub.completed_at - sub.submitted_at : 5000;
            const reliability = sub.status === "completed" ? 0.9 : 0.3;
            const trustRow = moteDb.db
              .prepare(
                "SELECT trust_level FROM agent_trust WHERE motebit_id = ? AND remote_motebit_id = ?",
              )
              .get(motebitId, sub.motebit_id) as { trust_level: string } | undefined;
            const trust = trustRow ? trustLevelToScore(trustRow.trust_level) : 0.1;

            insertEdge.run(
              parentMotebitId,
              sub.motebit_id,
              trust,
              0,
              latency > 0 ? latency : 5000,
              reliability,
              0,
              Date.now(),
              sub.result_hash ?? null,
            );

            if (sub.delegation_receipts && sub.delegation_receipts.length > 0) {
              await walkReceipts(sub.motebit_id, sub.delegation_receipts);
            }
          }
        };

        await walkReceipts(receipt.motebit_id, receipt.delegation_receipts);
      } catch {
        // Best-effort edge caching
      }
    }

    // --- Multi-hop settlement (recursive) ---
    await settleNestedReceipts(false);

    // --- Latency recording ---
    if (receipt.completed_at && entry.task.submitted_at) {
      const elapsed = receipt.completed_at - entry.task.submitted_at;
      if (elapsed > 0 && receipt.motebit_id != null) {
        try {
          moteDb.db
            .prepare(
              `INSERT INTO relay_latency_stats (motebit_id, remote_motebit_id, latency_ms, recorded_at)
             VALUES (?, ?, ?, ?)`,
            )
            .run(motebitId, receipt.motebit_id, elapsed, Date.now());
        } catch {
          // Best-effort latency recording
        }
      }
    }

    // --- Main settlement + credential issuance ---
    {
      try {
        // P2P tasks: audit record only, no fund movement.
        // Inserted inside the settlement try-block so it shares the error boundary (#10).
        if (entry.settlement_mode === "p2p") {
          const p2pSettlementId = crypto.randomUUID();
          const p2pSettledAt = Date.now();

          // P2P settlement after Arc 2 of the off-ramp arc: money moves
          // delegator→worker AND delegator→relay_treasury in a single
          // atomic Solana multi-output tx. The relay never held the
          // worker's earnings OR the fee; both legs settle on-chain as
          // the delegator's principal action.
          //
          // The signed audit record commits the relay to "I observed
          // this task settle peer-to-peer at worker_amount + fee with
          // status completed" — the p2p-verifier walks transfers[] on
          // `p2p_tx_hash` to validate both legs against the recorded
          // `amount_settled` and `platform_fee`.
          //
          // Resolves the sibling-doc contradiction the settlement_mode
          // arc surfaced: `platform_fee` is now non-zero on P2P,
          // matching the top-level "5% applies through both lanes"
          // claim. `services/relay/CLAUDE.md` rule 8 amends in the
          // same arc commit.
          const p2pProof = entry.p2p_payment_proof;
          const p2pWorkerAmount = p2pProof?.amount_micro ?? 0;
          // Which fee leg funds THIS relay's treasury? For a single-operator P2P
          // task it is the only fee leg (`fee_amount_micro`). For a cross-operator
          // FEDERATED task this relay is the EXECUTOR (origin_relay set) — its
          // treasury is funded by the executor-fee leg (`b_fee_amount_micro`); the
          // origin relay records the origin-fee leg separately in
          // onTaskResultReceived. This keeps each relay's recorded fee equal to the
          // onchain leg landing in its OWN treasury (the verifier + reconciler both
          // key on `platform_fee` → treasury).
          const isFederatedExecutorP2p = entry.origin_relay != null;
          const p2pFeeAmount = isFederatedExecutorP2p
            ? (p2pProof?.b_fee_amount_micro ?? 0)
            : (p2pProof?.fee_amount_micro ?? 0);
          // Gross at this relay's hop = worker net + this relay's fee.
          const p2pGrossAmount = p2pWorkerAmount + p2pFeeAmount;
          const p2pFeeRate =
            p2pGrossAmount > 0 ? Math.round((p2pFeeAmount / p2pGrossAmount) * 10000) / 10000 : 0;

          const signedP2pAudit = await signSettlement(
            {
              settlement_id: p2pSettlementId,
              allocation_id: `p2p-${taskId}` as never,
              // Payee = the worker the onchain payment paid: the task's
              // admitted `target_agent` (#959) — equal to the receipt signer,
              // checked at the top of ingestion. NEVER `motebitId`: a P2P
              // submission posts to the DELEGATOR's own endpoint, so the path
              // agent is the payer here.
              motebit_id: p2pPayeeOf(entry),
              receipt_hash: receipt.result_hash ?? "",
              ledger_hash: null,
              amount_settled: p2pWorkerAmount,
              platform_fee: p2pFeeAmount,
              platform_fee_rate: p2pFeeRate,
              // P2P audit record: relay never held the funds. Money moved
              // onchain delegator → worker AND delegator → treasury in a
              // single atomic tx. Lane is part of the signed body so the
              // relay's custody posture is committed-to, not derivable.
              settlement_mode: "p2p",
              status: "completed",
              settled_at: p2pSettledAt,
              issuer_relay_id: relayIdentity.relayMotebitId,
            },
            relayIdentity.privateKey,
          );

          recordP2pSettlementAudit(moteDb.db, {
            settlement_id: p2pSettlementId,
            allocation_id: `p2p-${taskId}`,
            task_id: taskId,
            motebit_id: signedP2pAudit.motebit_id,
            receipt_hash: receipt.result_hash ?? "",
            amount_settled: p2pWorkerAmount,
            platform_fee: p2pFeeAmount,
            platform_fee_rate: p2pFeeRate,
            status: "completed",
            settled_at: p2pSettledAt,
            settlement_mode: "p2p",
            p2p_tx_hash: p2pProof != null ? p2pProofKey(p2pProof.tx_hash) : null,
            payment_verification_status: "pending",
            delegator_id: entry.submitted_by ?? null,
            p2p_worker_leg: p2pWorkerLegScope(entry),
            p2p_worker_address: entry.p2p_admission?.worker_address ?? null,
            p2p_worker_address_rung: entry.p2p_admission?.worker_address_rung ?? null,
            issuer_relay_id: signedP2pAudit.issuer_relay_id,
            suite: signedP2pAudit.suite,
            signature: signedP2pAudit.signature,
            record_json: canonicalJson(signedP2pAudit),
            receipt_signature: receipt.signature,
          });
        }

        // P2P tasks: settlement audit already recorded above. Skip relay settlement,
        // jump to credential issuance.
        const isP2pTask = entry.settlement_mode === "p2p";

        // Federated-executor dedupe (spec relay-federation-v1 §7.3): when THIS
        // relay executed a task forwarded by a peer (origin_relay set), the local
        // relay-settlement money path must NOT fire. Settlement is origin-driven —
        // the originating relay extracts its fee and forwards the remainder via
        // /settlement/forward, and this relay credits the worker exactly once in
        // onSettlementReceived. Settling locally here would pay the worker the
        // wrong local-price amount AND double-pay once the forwarded settlement
        // arrives. The result is still forwarded back to origin below (see the
        // `entry.origin_relay` block); only the fund movement is skipped.
        const isFederatedExecutor = entry.origin_relay != null;

        const persistentAlloc = isP2pTask
          ? undefined
          : (moteDb.db
              .prepare("SELECT * FROM relay_allocations WHERE task_id = ? AND status = 'locked'")
              .get(taskId) as
              { allocation_id: string; amount_locked: number; motebit_id: string } | undefined);

        // Receipt-time pricing honesty (#459): gross comes from what was
        // actually HELD — the submission price snapshot or the locked
        // allocation — never from the EXECUTING agent's listing. The removed
        // fallback (getListingUnitCost over the receipt's signer) fired
        // exactly when a task had NO snapshot and NO allocation (a zero-cost
        // submission that never booked funds) and invented a gross that was
        // never held: guaranteed `settlement.unfunded_skipped`, plus a full
        // Ed25519 settlement-signing cost per attempt to produce an object
        // that was then discarded (the constant gross=6316 in the 2026-07-29
        // incident was web-search's summed listing, not any funded amount).
        // No snapshot and no allocation ⇒ gross 0 — the honest free-task
        // settlement.
        const grossAmount = entry.price_snapshot ?? persistentAlloc?.amount_locked ?? 0;

        const settlementId = asSettlementId(crypto.randomUUID());
        const allocationId = persistentAlloc
          ? asAllocationId(persistentAlloc.allocation_id)
          : asAllocationId(`x402-${taskId}`);
        const allocation: BudgetAllocation = {
          allocation_id: allocationId,
          goal_id: asGoalId(taskId),
          candidate_motebit_id: receipt.motebit_id,
          amount_locked: grossAmount,
          currency: "USDC",
          created_at: receipt.submitted_at ?? Date.now(),
          status: "settled",
        };

        // Thread the INJECTED platformFeeRate into the split — else it defaults
        // to PLATFORM_FEE_RATE (0.05) while the gross lock above used the
        // injected rate, so on a relay configured with a non-default
        // MOTEBIT_PLATFORM_FEE_RATE the recorded platform_fee (and the worker's
        // amount_settled) diverge from what the delegator was actually charged.
        const settlement = settleOnReceipt(
          allocation,
          receipt,
          null,
          settlementId,
          platformFeeRate,
        );
        // Round to integer micro-units for DB storage
        // Conserving round to whole micro-units. `settleOnReceipt` returns a
        // conserving but possibly fractional pair; rounding the two legs
        // INDEPENDENTLY breaks `net + fee === gross` on 5% of grosses, each
        // recording one micro of fee the relay never retained — into the signed,
        // dispute-grade `relay_settlements` row that feeds the treasury
        // reconciler's `onchain >= recordedFeeSum` invariant.
        {
          const rounded = roundSettlementSplitMicro(
            settlement.amount_settled,
            settlement.platform_fee,
          );
          settlement.amount_settled = rounded.netMicro;
          settlement.platform_fee = rounded.feeMicro;
        }

        let credentialRow: {
          credential_id: string;
          subject: string;
          issuer: string;
          type: string;
          json: string;
          issued_at: number;
        } | null = null;

        if (
          issueCredentials &&
          receipt.status === "completed" &&
          !isSelfDelegation &&
          newlyArchived
        ) {
          const latencyRows = moteDb.db
            .prepare(
              "SELECT latency_ms FROM relay_latency_stats WHERE remote_motebit_id = ? ORDER BY recorded_at DESC LIMIT 100",
            )
            .all(receipt.motebit_id) as Array<{ latency_ms: number }>;
          const avgLatency =
            latencyRows.length > 0
              ? latencyRows.reduce((a, r) => a + r.latency_ms, 0) / latencyRows.length
              : receipt.completed_at && receipt.submitted_at
                ? receipt.completed_at - receipt.submitted_at
                : 0;

          const subjectDid = pubKeyHex
            ? hexPublicKeyToDidKey(pubKeyHex)
            : `did:motebit:${receipt.motebit_id}`;

          const relayKeys = getRelayKeypair(relayIdentity);
          const vc = await issueReputationCredential(
            {
              success_rate: 1.0,
              avg_latency_ms: avgLatency,
              task_count: latencyRows.length + 1,
              trust_score: 1.0,
              availability: 1.0,
              measured_at: Date.now(),
            },
            relayKeys.privateKey,
            relayKeys.publicKey,
            subjectDid,
          );

          const credType =
            vc.type.find((t) => t !== "VerifiableCredential") ?? "VerifiableCredential";
          credentialRow = {
            credential_id: crypto.randomUUID(),
            subject: receipt.motebit_id,
            issuer: vc.issuer,
            type: credType,
            json: JSON.stringify(vc),
            issued_at: Date.now(),
          };
        }

        // Self-attesting settlement (audit follow-up #1, delegation-v1
        // §6.4): the relay signs the canonical body so a worker (or any
        // auditor) can prove what was claimed without trusting the
        // relay's word about it. SettlementRecord wire format MUST carry
        // signature/suite/issuer_relay_id; the columns are persisted so
        // the audit-emission path can reconstruct + verify.
        //
        // CRITICAL: signSettlement is async (Ed25519 over canonical bytes).
        // Compute it OUTSIDE the synchronous BEGIN/COMMIT block — placing
        // an await inside the transaction lets concurrent receipts
        // interleave their transactions and corrupts INSERT-OR-IGNORE
        // semantics (caught by the money-loop-concurrency test on first
        // attempt; signed-but-uninserted settlements would silently drop).
        const signedSettlement =
          !isP2pTask && !isFederatedExecutor
            ? await signSettlement(
                {
                  settlement_id: settlement.settlement_id,
                  allocation_id: settlement.allocation_id,
                  // Payee = the executing agent named on the receipt
                  // (settleOnReceipt sets it to receipt.motebit_id).
                  motebit_id: settlement.motebit_id,
                  receipt_hash: settlement.receipt_hash,
                  ledger_hash: settlement.ledger_hash,
                  amount_settled: settlement.amount_settled,
                  platform_fee: settlement.platform_fee,
                  platform_fee_rate: settlement.platform_fee_rate,
                  // !isP2pTask branch — runs only for Arc 3 carve-outs:
                  // self-delegation (worker is the delegator, same-party),
                  // zero-cost direct delegation (unit_cost = 0, no real
                  // funds), or legacy non-P2P paths that pre-date the
                  // TASK_P2P_PROOF_REQUIRED submission gate. Paid direct
                  // delegation to a different worker can no longer reach
                  // this branch — submission rejects without a
                  // payment_proof. `settlement_mode: "relay"` here is the
                  // documented carve-out; the structural enforcement is at
                  // submission, not at this write site. See
                  // `docs/doctrine/off-ramp-as-user-action.md` § "Arc 3
                  // carve-outs".
                  settlement_mode: "relay",
                  status: settlement.status,
                  settled_at: settlement.settled_at,
                  ...(entry.x402_tx_hash != null ? { x402_tx_hash: entry.x402_tx_hash } : {}),
                  ...(entry.x402_network != null ? { x402_network: entry.x402_network } : {}),
                  issuer_relay_id: relayIdentity.relayMotebitId,
                },
                relayIdentity.privateKey,
              )
            : null;

        moteDb.db.exec("BEGIN");
        try {
          // Fail-closed funding claim — mirror of the retry-refund guard in
          // index.ts's settlement retry loop (`UPDATE ... WHERE status =
          // 'locked'`, then check `changes`). Every credit below (worker
          // payment, refund, partial remainder, risk-buffer surplus) is funded
          // by this task's locked allocation; claim it atomically before
          // crediting. If the row is no longer 'locked' (stale-allocation
          // sweep, dispute release, retry-exhaustion refund), the delegator
          // has already been credited back and settling here would pay both
          // parties for the same funds. The pre-transaction `persistentAlloc`
          // read is advisory; this UPDATE is the authoritative check. It also
          // keeps reconciliation invariant 3 (allocation 'settled' ⇔ settlement
          // record exists) true: the claim and the INSERT below commit together
          // or not at all.
          // What the delegator actually has at stake: allocation_hold debits
          // minus allocation_release credits for this allocation, from the
          // transaction ledger. NEVER `amount_locked` — allocation rows also
          // exist for never-debited paths (free-agent best-effort holds), and
          // crediting against one mints balance the relay never received.
          //
          // READ BEFORE CLAIMING, and this ordering is load-bearing.
          // `allocationClaimed` is not a predicate — it EXECUTES the UPDATE. An
          // earlier attempt at this fix claimed first, consulted the ledger
          // second, then skipped the settlement INSERT when unfunded, which left
          // an allocation permanently `'settled'` with no settlement row: a hard
          // error in `reconcileLedger` invariant 3 (settled allocation ⇔
          // settlement record). Deriving funding first and claiming only when
          // funded keeps the claim and the INSERT atomic, exactly as the previous
          // comment here promised.
          const heldOnLedger = allocationEscrowHeld(moteDb.db, allocationId);
          const settlementApplies = !isP2pTask && signedSettlement != null;
          const fundedOnLedger = grossAmount === 0 || heldOnLedger > 0;

          // Claim only what we intend to settle. An unfunded row stays `'locked'`
          // and is retired later by the stale-allocation sweep, which (since the
          // ledger-derived release) correctly pays out nothing for it.
          const allocationClaimed =
            settlementApplies &&
            fundedOnLedger &&
            moteDb.db
              .prepare(
                "UPDATE relay_allocations SET status = 'settled', settled_at = ? WHERE task_id = ? AND status = 'locked'",
              )
              .run(Date.now(), taskId).changes > 0;

          const heldRemaining = allocationClaimed ? heldOnLedger : 0;
          const settlementFunded = grossAmount === 0 || (allocationClaimed && heldRemaining > 0);
          if (settlementApplies && !settlementFunded) {
            logger.error("settlement.unfunded_skipped", {
              correlationId: taskId,
              settlementId: settlement.settlement_id,
              gross: settlement.amount_settled + settlement.platform_fee,
              heldOnLedger,
              allocationClaimed,
              reason:
                heldOnLedger > 0
                  ? "allocation no longer locked — funds already released to the delegator; settlement skipped to prevent double-credit"
                  : "allocation holds nothing on the ledger — never debited (best-effort path, or a priced listing with no payout address), so crediting the worker would mint balance the relay never received",
            });
          }
          // Relay settlement: INSERT record + credit/refund virtual accounts.
          // P2P tasks skip this — their audit record was inserted above.
          if (!isP2pTask && signedSettlement != null && settlementFunded) {
            moveAllocationMoney(moteDb.db, {
              kind: "settlement_fee",
              allocationId,
              amount: signedSettlement.platform_fee,
              settlement: {
                settlement_id: signedSettlement.settlement_id,
                allocation_id: signedSettlement.allocation_id,
                task_id: taskId,
                // KNOWN RESIDUAL (#959, left for its own change): this column is
                // the PATH agent while the signed body and the credit below name
                // the receipt signer; they differ whenever scored routing hands
                // the task to another worker. Existing relay-mode tests read the
                // row under the path agent, so the fix is not made here.
                motebit_id: motebitId,
                receipt_hash: signedSettlement.receipt_hash,
                ledger_hash: signedSettlement.ledger_hash,
                amount_settled: signedSettlement.amount_settled,
                platform_fee: signedSettlement.platform_fee,
                platform_fee_rate: signedSettlement.platform_fee_rate,
                status: signedSettlement.status,
                settled_at: signedSettlement.settled_at,
                settlement_mode: signedSettlement.settlement_mode,
                // The payer/delegator, so the per-peer settlement-summary export
                // (state-export.ts) can attribute relay-custody settlements to a
                // counterparty — not only P2P rows. `null` when self-funded /
                // unknown (no distinct submitter) → stays in the unattributed
                // bucket rather than mis-attributing to self. Only the p2p-verifier
                // reads this column, and it filters `settlement_mode='p2p'`, so a
                // value on relay-custody rows is inert there.
                delegator_id: entry.submitted_by ?? entry.task.submitted_by ?? null,
                x402_tx_hash: entry.x402_tx_hash ?? null,
                x402_network: entry.x402_network ?? null,
                issuer_relay_id: signedSettlement.issuer_relay_id,
                suite: signedSettlement.suite,
                signature: signedSettlement.signature,
                record_json: canonicalJson(signedSettlement),
                receipt_signature: receipt.signature,
              },
            });

            {
              const workerMotebitId = receipt.motebit_id;
              // The allocation's hold payer — the only party a remainder of its
              // escrow may return to (P2 / #959: never a fallback to the path
              // agent, which names the worker).
              const releaseTo = (amount: number, description: string): void => {
                const payer = allocationHoldPayer(moteDb.db, allocationId);
                moveAllocationMoney(moteDb.db, {
                  kind: "settlement_release",
                  allocationId,
                  amount,
                  party: payer ?? "",
                  description,
                });
              };

              if (settlement.status === "refunded") {
                // Full release of the funded hold. settleOnReceipt fixes
                // amount_settled/platform_fee at 0 for refunded settlements —
                // those fields are the RECORD of what settled (nothing). The
                // refund AMOUNT is what was actually debited at hold time and
                // not yet released, from the transaction ledger.
                if (heldRemaining > 0) {
                  releaseTo(heldRemaining, `Refund for task ${taskId} (${receipt.status})`);
                }
              } else {
                if (settlement.amount_settled > 0) {
                  moveAllocationMoney(moteDb.db, {
                    kind: "settlement_credit",
                    allocationId,
                    amount: settlement.amount_settled,
                    party: workerMotebitId,
                    settlementId: settlement.settlement_id,
                    description: `Payment for task ${taskId}`,
                  });
                }

                if (settlement.status === "partial") {
                  // The unsettled remainder of the funded hold — including the
                  // risk buffer, so no separate surplus release below.
                  const grossSettled = settlement.amount_settled + settlement.platform_fee;
                  const remainder = heldRemaining - grossSettled;
                  if (remainder > 0) {
                    releaseTo(remainder, `Partial release for task ${taskId}`);
                  }
                }

                // Release risk-buffer surplus back to the delegator — atomic
                // with the settlement that consumes the hold. (Previously ran
                // after COMMIT as best-effort, which silently retained the
                // surplus on failure, and ALSO fired on partial settlements
                // whose remainder branch above already returns the buffer —
                // double-crediting it.)
                if (settlement.status === "completed" && heldRemaining > grossAmount) {
                  const surplus = heldRemaining - grossAmount;
                  releaseTo(surplus, `Risk buffer surplus release for task ${taskId}`);
                  logger.info("settlement.surplus_released", {
                    correlationId: taskId,
                    surplus,
                    allocationId,
                  });
                }
              }
            }
          }

          if (credentialRow) {
            moteDb.db
              .prepare(
                `INSERT INTO relay_credentials (credential_id, subject_motebit_id, issuer_did, credential_type, credential_json, issued_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
              )
              .run(
                credentialRow.credential_id,
                credentialRow.subject,
                credentialRow.issuer,
                credentialRow.type,
                credentialRow.json,
                credentialRow.issued_at,
              );
            credential_id = credentialRow.credential_id;
          }

          moteDb.db.exec("COMMIT");

          if (isFederatedExecutor) {
            // No local settlement was written — record why for the audit trail.
            logger.info("settlement.federated_deferred", {
              correlationId: taskId,
              originRelay: entry.origin_relay,
              note: "settlement driven by originating relay via /federation/v1/settlement/forward",
            });
          } else if (settlementFunded) {
            // Log honesty (#459): `settlement.created` fires ONLY when a
            // settlement was actually recorded. During the 2026-07-29 incident
            // this line sat outside the funded guard and reported the same
            // in-memory gross that `settlement.unfunded_skipped` had just
            // refused — the log stream claimed money movement that never
            // happened, dozens of times per second. The multihop sibling
            // (`multihop.settlement.created`) always had it right; the
            // unfunded case's record is the unfunded_skipped line alone.
            logger.info("settlement.created", {
              correlationId: taskId,
              gross: settlement.amount_settled + settlement.platform_fee,
              fee: settlement.platform_fee,
              net: settlement.amount_settled,
              x402TxHash: entry.x402_tx_hash ?? null,
            });
          }
          if (credentialRow) {
            logger.info("credential.issued", {
              correlationId: taskId,
              motebitId: credentialRow.subject,
              type: credentialRow.type,
            });
          }
        } catch (txnErr) {
          moteDb.db.exec("ROLLBACK");
          throw txnErr;
        }
      } catch (settlementErr) {
        logger.warn("settlement.failed", {
          correlationId: taskId,
          error: settlementErr instanceof Error ? settlementErr.message : String(settlementErr),
        });
        // Receipt delivery is never blocked on an accounting error — but the
        // answer stays claimed and UNSETTLED, so the next retry of this
        // receipt (or the next restart's) settles it (#890 r9).
        return false;
      }
    }
    return true;
  }

  /**
   * Multi-hop settlement: each sub-receipt nested in the ENTRY'S answer is
   * admitted as its sub-task's own answer and settled. `onlyUnsettledClaims`:
   * the parent's repeat (#890 r10) — only sub-tasks claimed for their nested
   * receipt and left unsettled (a failed sub-settlement) are re-admitted.
   */
  async function settleNestedReceipts(onlyUnsettledClaims: boolean): Promise<void> {
    const delegationReceipts = receipt.delegation_receipts ?? [];
    if (delegationReceipts.length > 0) {
      const maxSettlementDepth = deps.maxSettlementDepth ?? MAX_SETTLEMENT_DEPTH;

      /**
       * The sub-receipt door's settlement step: settle sub-task `subRelayTaskId`
       * on `sub`, its CLAIMED answer. `true` once the decision is complete.
       */
      const settleSubAnswer = async (
        subEntry: TaskQueueEntry,
        sub: ExecutionReceipt,
        parentTaskId: string,
        depth: number,
        subRelayTaskId: string,
      ): Promise<boolean> => {
        {
          const subUnitCost = getListingUnitCost(moteDb, sub.motebit_id);
          const subGross =
            subEntry.price_snapshot ??
            (subUnitCost > 0 ? toMicro(computeGrossAmount(subUnitCost, platformFeeRate)) : 0);
          if (subGross <= 0) {
            // No cost — still recurse into nested receipts
            return true;
          }

          // === Multi-hop-as-P2P reconciliation: honor the sub-task's SUBMITTED
          // settlement_mode ===
          // A p2p-submitted sub-hop (B paid C onchain from its OWN wallet — net +
          // fee legs — at sub-submission time, exactly the Clerk's move) settles as
          // an AUDIT-ONLY p2p row, mirroring the parent-P2P write in
          // handleReceiptIngestion. NO `creditAccount`, NO allocation claim: the
          // money already moved onchain, so a relay credit would double-pay on top
          // of the delegator's principal action. The p2p-verifier walks
          // `transfers[]` on `p2p_tx_hash` and flips `pending → verified` once both
          // legs match. This is the reconciliation the multi-hop-as-P2P arc names;
          // the relay-mode branch below survives only for the same-party carve-out
          // (self-delegation has no cross-party onchain payment to record) and
          // legacy in-flight nested settlements. Doctrine:
          // `docs/doctrine/off-ramp-as-user-action.md` § "Multi-hop-as-P2P — Increment 1".
          if (subEntry.settlement_mode === "p2p") {
            // Payee = the worker the sub-hop's payment paid (#959): the sub-task's
            // admitted `target_agent`. A nested receipt signed by anyone else is
            // not the work B paid for — record nothing for it (the paid worker's
            // own receipt can still settle the sub-task directly).
            const subPayee = p2pPayeeOf(subEntry);
            if (sub.motebit_id !== subPayee) {
              logger.error("multihop.settlement.p2p_receipt_not_from_payee", {
                correlationId: parentTaskId,
                subTaskId: subRelayTaskId,
                payee: subPayee,
                signer: sub.motebit_id,
                depth,
              });
              return false;
            }
            const subP2pProof = subEntry.p2p_payment_proof;
            const subWorkerAmount = subP2pProof?.amount_micro ?? 0;
            // Which fee leg funds THIS relay's treasury — mirror the parent-P2P
            // rule: federated-executor hop uses `b_fee_amount_micro`, single-op
            // uses `fee_amount_micro`.
            const subIsFederatedExecutor = subEntry.origin_relay != null;
            const subFeeAmount = subIsFederatedExecutor
              ? (subP2pProof?.b_fee_amount_micro ?? 0)
              : (subP2pProof?.fee_amount_micro ?? 0);
            const subP2pGross = subWorkerAmount + subFeeAmount;
            const subP2pFeeRate =
              subP2pGross > 0 ? Math.round((subFeeAmount / subP2pGross) * 10000) / 10000 : 0;
            const subP2pSettlementId = crypto.randomUUID();
            const subP2pSettledAt = Date.now();

            const signedSubP2p = await signSettlement(
              {
                settlement_id: subP2pSettlementId,
                allocation_id: `p2p-${subRelayTaskId}` as never,
                // Payee = the sub-hop's admitted worker, paid onchain (equal to
                // the signer, checked above).
                motebit_id: subPayee,
                receipt_hash: sub.result_hash ?? "",
                ledger_hash: null,
                amount_settled: subWorkerAmount,
                platform_fee: subFeeAmount,
                platform_fee_rate: subP2pFeeRate,
                // Lane in the signed body — the relay's custody posture is
                // committed-to, not derivable.
                settlement_mode: "p2p",
                status: "completed",
                settled_at: subP2pSettledAt,
                issuer_relay_id: relayIdentity.relayMotebitId,
              },
              relayIdentity.privateKey,
            );

            recordP2pSettlementAudit(moteDb.db, {
              settlement_id: subP2pSettlementId,
              allocation_id: `p2p-${subRelayTaskId}`,
              task_id: subRelayTaskId,
              motebit_id: signedSubP2p.motebit_id,
              receipt_hash: sub.result_hash ?? "",
              amount_settled: subWorkerAmount,
              platform_fee: subFeeAmount,
              platform_fee_rate: subP2pFeeRate,
              status: "completed",
              settled_at: subP2pSettledAt,
              settlement_mode: "p2p",
              p2p_tx_hash: subP2pProof != null ? p2pProofKey(subP2pProof.tx_hash) : null,
              payment_verification_status: "pending",
              delegator_id: subEntry.submitted_by ?? null,
              p2p_worker_leg: p2pWorkerLegScope(subEntry),
              p2p_worker_address: subEntry.p2p_admission?.worker_address ?? null,
              p2p_worker_address_rung: subEntry.p2p_admission?.worker_address_rung ?? null,
              issuer_relay_id: signedSubP2p.issuer_relay_id,
              suite: signedSubP2p.suite,
              signature: signedSubP2p.signature,
              record_json: canonicalJson(signedSubP2p),
              receipt_signature: sub.signature,
            });

            logger.info("multihop.settlement.p2p_recorded", {
              correlationId: parentTaskId,
              subTaskId: subRelayTaskId,
              subAgent: sub.motebit_id,
              net: subWorkerAmount,
              fee: subFeeAmount,
              depth,
            });

            // Recurse into nested receipts, then done — the relay-mode residual
            // write below is skipped for p2p sub-hops.
            return true;
          }

          // ARC-MARKER(multi-hop-as-P2P): the relay-mode multi-hop settlement WRITE.
          // Multi-hop-as-P2P Increment 1 (2026-07-15) reconciled the p2p case ABOVE
          // — a p2p-submitted sub-hop now settles as an audit-only p2p row and never
          // reaches here. This branch is therefore the narrow CARVE-OUT residual:
          // a same-party self-delegated sub-hop (no cross-party onchain payment to
          // record) or a legacy in-flight nested settlement from before the p2p
          // reconciliation. It is instrumented LOUDLY rather than thrown — a legacy
          // nested settlement can still legitimately land here, and a throw would
          // regress exactly the state this residual preserves. Inverting to a hard
          // throw belongs to the later increment that makes direct delegation
          // P2P-only; until then this write is correct for the carve-out. The
          // error-level event name is the metric (structured logs, not a counter) —
          // alerting keys on `multihop.settlement.relay_residual_fired`. Doctrine:
          // `docs/doctrine/off-ramp-as-user-action.md` § "Multi-hop-as-P2P — Increment 1".
          logger.error("multihop.settlement.relay_residual_fired", {
            correlationId: parentTaskId,
            subTaskId: subRelayTaskId,
            subAgent: sub.motebit_id,
            depth,
            amountLocked: subGross,
            marker: "ARC:multi-hop-as-P2P",
          });

          const subSettlementId = asSettlementId(crypto.randomUUID());
          const subAllocationId = asAllocationId(`x402-${subRelayTaskId}`);
          const subAllocation: BudgetAllocation = {
            allocation_id: subAllocationId,
            goal_id: asGoalId(subRelayTaskId),
            candidate_motebit_id: sub.motebit_id,
            amount_locked: subGross,
            currency: "USDC",
            created_at: sub.submitted_at ?? Date.now(),
            status: "settled",
          };

          // Same injected-rate threading as the main settlement below — the
          // sub-hop gross was locked with `platformFeeRate` (via subGross), so
          // its split must use the same rate, not the 0.05 default.
          const subSettlement = settleOnReceipt(
            subAllocation,
            sub,
            null,
            subSettlementId,
            platformFeeRate,
          );
          // Conserving round to whole micro-units: `net + fee` must still equal
          // the gross after rounding. Rounding each leg independently overstates
          // the fee by one micro on 5% of grosses (see roundSettlementSplitMicro).
          {
            const rounded = roundSettlementSplitMicro(
              subSettlement.amount_settled,
              subSettlement.platform_fee,
            );
            subSettlement.amount_settled = rounded.netMicro;
            subSettlement.platform_fee = rounded.feeMicro;
          }

          // Self-attesting sub-settlement. Sign BEFORE the synchronous
          // BEGIN/COMMIT block — see the canonical settlement site for the
          // concurrency rationale (await inside transaction interleaves).
          const signedSubSettlement = await signSettlement(
            {
              settlement_id: subSettlement.settlement_id,
              allocation_id: subSettlement.allocation_id,
              // Payee = the sub-agent named on the sub-receipt.
              motebit_id: subSettlement.motebit_id,
              receipt_hash: subSettlement.receipt_hash,
              ledger_hash: subSettlement.ledger_hash,
              amount_settled: subSettlement.amount_settled,
              platform_fee: subSettlement.platform_fee,
              platform_fee_rate: subSettlement.platform_fee_rate,
              // Multi-hop sub-receipt settlement-write. NOTE the precise
              // scope: the sub-task SUBMISSION (B→C) is a real
              // `POST /agent/C/task` and, once Arc 3.5's gate lands, a *paid*
              // sub-hop is gated exactly like a direct delegation (it needs
              // its own P2P proof). This relay-mode WRITE is therefore a
              // residual of the pre-gate topology — reachable only for a
              // paid sub-receipt that has no settlement of its own (e.g. the
              // sub-agent's receipt was nested in the parent's rather than
              // posted directly). Reconciling this write to honor the
              // sub-task's submitted settlement_mode (so a p2p-submitted
              // sub-hop settles p2p, not relay) is the deferred
              // multi-hop-as-P2P arc. See
              // `docs/doctrine/off-ramp-as-user-action.md` § "Arc 3.5".
              settlement_mode: "relay",
              status: subSettlement.status,
              settled_at: subSettlement.settled_at,
              issuer_relay_id: relayIdentity.relayMotebitId,
            },
            relayIdentity.privateKey,
          );

          try {
            moteDb.db.exec("BEGIN");

            // Fail-closed funding claim — mirror of the canonical settlement
            // site (handleReceiptIngestion), including its claim-ORDER.
            //
            // What the delegator actually has at stake for this sub-task:
            // `allocation_hold` debits minus `allocation_release` credits for
            // `x402-<subRelayTaskId>`, read from the transaction ledger. NEVER
            // the allocation row's status alone — a `'locked'` row also exists
            // on never-debited paths (free-agent best-effort holds), and a paid
            // sub-delegation is a real `POST /agent/:worker/task` (rule 8), so
            // it reaches that same branch. Crediting against such a row mints
            // balance the relay never received, and `reconcileLedger` cannot
            // see it because the credit is itself a ledger row.
            //
            // READ BEFORE CLAIMING, and the ordering is load-bearing. The
            // UPDATE is not a predicate — it EXECUTES. Claiming first and
            // consulting the ledger second would leave an unfunded allocation
            // permanently `'settled'` with no settlement row: a hard error in
            // `reconcileLedger` invariant 3, and the exact defect that sent the
            // direct-path fix back for rework (#541 review → #566). Deriving
            // funding first and claiming only when funded keeps the claim and
            // the INSERT atomic.
            //
            // subGross > 0 is guaranteed above, so there is no zero-cost
            // carve-out to make here: unfunded always means skip.
            const subHeldOnLedger = allocationEscrowHeld(moteDb.db, subAllocationId);
            const subClaimed =
              subHeldOnLedger > 0 &&
              moteDb.db
                .prepare(
                  "UPDATE relay_allocations SET status = 'settled', settled_at = ? WHERE task_id = ? AND status = 'locked'",
                )
                .run(Date.now(), subRelayTaskId).changes > 0;

            if (!subClaimed) {
              moteDb.db.exec("ROLLBACK");
              logger.error("multihop.settlement.unfunded_skipped", {
                correlationId: parentTaskId,
                subTaskId: subRelayTaskId,
                subAgent: sub.motebit_id,
                gross: subGross,
                subHeldOnLedger,
                reason:
                  subHeldOnLedger > 0
                    ? "sub-allocation not locked — never funded (e.g. P2P sub-hop) or already released; relay credit skipped to prevent unfunded credit / double-pay"
                    : "sub-allocation holds nothing on the ledger — never debited (best-effort path, or a P2P-submitted sub-hop that moved money onchain), so crediting the sub-agent would mint balance the relay never received",
              });
            } else {
              moveAllocationMoney(moteDb.db, {
                kind: "settlement_fee",
                allocationId: subAllocationId,
                amount: signedSubSettlement.platform_fee,
                settlement: {
                  settlement_id: signedSubSettlement.settlement_id,
                  allocation_id: signedSubSettlement.allocation_id,
                  task_id: subRelayTaskId,
                  motebit_id: sub.motebit_id,
                  receipt_hash: signedSubSettlement.receipt_hash,
                  ledger_hash: signedSubSettlement.ledger_hash,
                  amount_settled: signedSubSettlement.amount_settled,
                  platform_fee: signedSubSettlement.platform_fee,
                  platform_fee_rate: signedSubSettlement.platform_fee_rate,
                  status: signedSubSettlement.status,
                  settled_at: signedSubSettlement.settled_at,
                  settlement_mode: signedSubSettlement.settlement_mode,
                  issuer_relay_id: signedSubSettlement.issuer_relay_id,
                  suite: signedSubSettlement.suite,
                  signature: signedSubSettlement.signature,
                  // Rule 11: store the exact canonical signed bytes. The anchor
                  // leaf is SHA-256 of THIS, so it equals the bytes the worker holds.
                  record_json: canonicalJson(signedSubSettlement),
                  receipt_signature: sub.signature,
                },
              });

              if (subSettlement.amount_settled > 0) {
                moveAllocationMoney(moteDb.db, {
                  kind: "settlement_credit",
                  allocationId: subAllocationId,
                  amount: subSettlement.amount_settled,
                  party: sub.motebit_id,
                  settlementId: subSettlement.settlement_id,
                  description: `Payment for sub-delegated task ${subRelayTaskId}`,
                });
              }

              moteDb.db.exec("COMMIT");
              logger.info("multihop.settlement.created", {
                correlationId: parentTaskId,
                subTaskId: subRelayTaskId,
                subAgent: sub.motebit_id,
                net: subSettlement.amount_settled,
                fee: subSettlement.platform_fee,
                depth,
              });
            }
          } catch (txnErr) {
            moteDb.db.exec("ROLLBACK");
            logger.warn("multihop.settlement.failed", {
              correlationId: parentTaskId,
              subTaskId: subRelayTaskId,
              error: txnErr instanceof Error ? txnErr.message : String(txnErr),
            });
            return false;
          }
          return true;
        }
      };

      const settleSubReceipt = async (
        sub: ExecutionReceipt,
        parentTaskId: string,
        depth: number,
      ): Promise<void> => {
        if (exceedsSettlementDepth(depth, maxSettlementDepth)) {
          const subRelayTaskId = (sub as unknown as Record<string, unknown>).relay_task_id;
          logger.error("multihop.settlement.depth_limit_exceeded", {
            correlationId: parentTaskId,
            subAgent: sub.motebit_id,
            subTaskId: typeof subRelayTaskId === "string" ? subRelayTaskId : null,
            depth,
            maxDepth: maxSettlementDepth,
            reason: "depth_limit_exceeded",
            action: "unsettled — agent will not be paid for this sub-delegation",
          });
          return;
        }

        const subRelayTaskId = (sub as unknown as Record<string, unknown>).relay_task_id;
        if (typeof subRelayTaskId !== "string" || subRelayTaskId === "") return;

        // A parent's REPEAT re-walks only the sub-tasks whose settlement is
        // claimed for this very receipt and was never completed (#890 r10: a
        // sub-settlement that failed once is not stranded behind its settled
        // parent); each still enters by the one door routine below.
        const subClaim = onlyUnsettledClaims ? taskQueue.get(subRelayTaskId) : undefined;
        const strandedClaim =
          subClaim != null && subClaim.settled !== true && subClaim.settling === sub.signature;
        if (onlyUnsettledClaims && !strandedClaim) {
          for (const nested of sub.delegation_receipts ?? []) {
            await settleSubReceipt(nested, parentTaskId, depth + 1);
          }
          return;
        }

        // The sub-task's receipt is the sub-task's OWN answer (#890 r9 C1): it
        // enters by the one door routine like any other — bound to the
        // sub-task, its payee, a recorded executor, its signature, write-once —
        // and is settled only as the sub-task's CLAIMED answer. A sub-task
        // answered (or settled) on another receipt is never paid on this one;
        // a sub-task paid here answers its poll with this receipt.
        try {
          const subAdmission = await admitReceipt(
            {
              db: moteDb.db,
              identityManager,
              taskQueue,
              verifyReceipt: (r, keyHex) => verifyExecutionReceipt(r, hexToBytes(keyHex)),
            },
            subRelayTaskId,
            sub,
            { kind: "sub_receipt", parentTaskId },
            0,
            async ({ entry: subEntry, receipt: subAnswer }) =>
              settleSubAnswer(subEntry, subAnswer, parentTaskId, depth, subRelayTaskId),
          );
          if (!subAdmission.took) {
            logger.warn("multihop.settlement.sub_receipt_not_taken", {
              correlationId: parentTaskId,
              subTaskId: subRelayTaskId,
              subAgent: sub.motebit_id,
              refusal: subAdmission.refusal,
            });
          }
        } catch (subErr: unknown) {
          logger.warn("multihop.settlement.sub_error", {
            correlationId: parentTaskId,
            subRelayTaskId,
            error: subErr instanceof Error ? subErr.message : String(subErr),
          });
        }

        // Recurse into nested delegation_receipts
        const nestedReceipts = sub.delegation_receipts ?? [];
        for (const nested of nestedReceipts) {
          await settleSubReceipt(nested, parentTaskId, depth + 1);
        }
      };

      const treeNodes = settlementTreeDepths(receipt, maxSettlementDepth);
      logger.info("multihop.settlement.start", {
        correlationId: taskId,
        count: delegationReceipts.length,
        treeDepth: treeNodes.reduce((m, n) => Math.max(m, n.depth), 0),
        depthBlockedCount: treeNodes.filter((n) => n.depthBlocked).length,
      });
      for (const sub of delegationReceipts) {
        await settleSubReceipt(sub, taskId, 1);
      }
    }
  }

  /** After the settlement step: fan-out and the federation result return. */
  async function deliverLocalAnswer(): Promise<{ verified: true; credential_id: string | null }> {
    // --- WebSocket fan-out ---
    sendToEach(
      connections.get(motebitId),
      JSON.stringify({ type: "task_result", task_id: taskId, receipt }),
    );

    // --- Federation result forwarding ---
    if (entry.origin_relay) {
      // An outbox row first, then one send (#890 r10): the origin settles the
      // task only on this result, so an origin that is down now is retried
      // by the supervised recovery loop until it acknowledges — never left
      // waiting on a single best-effort send. The worker's key travels with
      // the receipt (it is registered HERE, not at the origin), so the
      // origin verifies the worker's own signature — and, for a sovereign
      // motebit_id, the key→id binding offline.
      try {
        enqueueResultDelivery(moteDb.db, taskId, entry.origin_relay);
        await attemptResultDelivery(
          moteDb.db,
          relayIdentity,
          taskId,
          (signer) => workerKeyFor(moteDb.db, signer),
          undefined,
          { peerFetch },
        );
      } catch (err) {
        logger.warn("federation.result_delivery_failed", {
          correlationId: taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Update trust for the originating relay
      try {
        const peerRow = moteDb.db
          .prepare(
            "SELECT trust_level, successful_forwards, failed_forwards FROM relay_peers WHERE peer_relay_id = ?",
          )
          .get(entry.origin_relay) as
          { trust_level: string; successful_forwards: number; failed_forwards: number } | undefined;

        if (peerRow) {
          const isSuccess = receipt.status === "completed";
          const newSuccessful = peerRow.successful_forwards + (isSuccess ? 1 : 0);
          const newFailed = peerRow.failed_forwards + (isSuccess ? 0 : 1);

          const trustRecord: AgentTrustRecord = {
            motebit_id: asMotebitId(relayIdentity.relayMotebitId),
            remote_motebit_id: asMotebitId(entry.origin_relay),
            trust_level: peerRow.trust_level as AgentTrustLevel,
            first_seen_at: 0,
            last_seen_at: Date.now(),
            interaction_count: newSuccessful + newFailed,
            successful_tasks: newSuccessful,
            failed_tasks: newFailed,
          };

          const newLevel = evaluateTrustTransition(trustRecord);
          const trustLevel = newLevel ?? peerRow.trust_level;
          const trustScore = trustLevelToScore(trustLevel);

          moteDb.db
            .prepare(
              `UPDATE relay_peers SET
            successful_forwards = ?, failed_forwards = ?,
            trust_level = ?, trust_score = ?
            WHERE peer_relay_id = ?`,
            )
            .run(newSuccessful, newFailed, trustLevel, trustScore, entry.origin_relay);
        }
      } catch {
        // Best-effort trust update
      }
    }

    return { verified: true, credential_id };
  }
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/** What the task routes hand back to the relay (#890 round 10). */
export interface TaskRoutesHandle {
  /**
   * Replay `taskId`'s OWN answer through the local door its settlement was
   * claimed by (`handleReceiptIngestion` → `admitReceipt`): the identical
   * retry a crash between claim and settle waits for. The door decides it
   * again; nothing is settled around it.
   */
  replayLocalAnswer(taskId: string, door: "result_post" | "mcp_forward"): Promise<boolean>;
}

export async function registerTaskRoutes(deps: TasksDeps): Promise<TaskRoutesHandle> {
  const {
    app,
    moteDb,
    identityManager,
    eventStore,
    relayIdentity,
    connections,
    taskQueue,
    taskRouter,
    issueCredentials,
    apiToken,
    outboundPolicy,
    enableDeviceAuth,
    maxTasksPerSubmitter,
    x402Config,
    x402FacilitatorClient,
    trackStartup,
    shutdownSignal,
    parseTokenPayloadUnsafe,
    verifySignedTokenForDevice,
    isTokenBlacklisted,
    isAgentRevoked,
    pushAdapter,
    p2pPaymentChain,
  } = deps;
  const peerFetch = deps.peerFetch ?? defaultPeerFetch;

  // Platform fee rate lives in this function's closure — every handler
  // registered below sees the same rate for its lifetime. No module-level
  // mutation; independent relay instances are fully isolated.
  const platformFeeRate = deps.platformFeeRate ?? SDK_DEFAULT_PLATFORM_FEE_RATE;

  const ingestionDeps = {
    moteDb,
    identityManager,
    eventStore,
    relayIdentity,
    connections,
    taskQueue,
    issueCredentials,
    platformFeeRate,
    reconcileKeyConnections: deps.reconcileKeyConnections,
    peerFetch,
  };

  const replayLocalAnswer = async (
    taskId: string,
    door: "result_post" | "mcp_forward",
  ): Promise<boolean> => {
    const entry = taskQueue.get(taskId);
    if (entry?.receipt == null) return false;
    const replayed = await handleReceiptIngestion(
      entry.receipt,
      taskId,
      entry.task.motebit_id,
      entry,
      door,
      resultRetentionMs(entry),
      ingestionDeps,
    );
    return replayed.verified;
  };

  // === x402: a request's handler relies only on ITS OWN verified payment (#907) ===
  //
  // `@x402/hono`'s middleware, with `ExactEvmScheme` (eip3009, the
  // "authorization" flow), verifies before the handler and SETTLES AFTER it,
  // only on a response below 400. The relay used to capture the settle tx hash
  // in an `onAfterSettle` hook into a variable shared by every request, and the
  // handler read it — before its own settlement existed. So the paying request
  // never saw its own payment (it was refused, and so never settled),
  // while a hash left by an earlier settlement (a paid same-key replay, #925)
  // was read by the NEXT submission, possibly another principal's, and
  // credited to it as a `deposit`.
  //
  // Now the gate uses the library's manual API (`processHTTPRequest` to
  // verify, the resource server's `settlePayment` to settle) instead of its
  // middleware, and never settles after the handler. A verified payment is
  // bound to the request that carries it — on the Hono context, which no
  // client can write — as an `X402Payment` whose `settle()` the handler calls
  // exactly once, AFTER every pre-admission refusal and immediately before
  // the admission transaction. A request whose handler never reaches that
  // point (a refusal, a replay, a conflict, a throw) is charged nothing: its
  // EIP-3009 authorization is never submitted, and it expires at its
  // `validBefore` (the authorization flow has nothing to cancel). The
  // settlement the handler credits is therefore always this request's own,
  // credited once, to the delegator this request names.
  //
  // Round 2: `settle()` writes a durable `pending` record keyed by the
  // authorization (payer, nonce) BEFORE calling the facilitator, and
  // classifies the answer (x402-settlements.ts): settled ⇒ credited once;
  // a definite pre-submission refusal (a closed set) ⇒ failed, "not charged";
  // anything else (timeout, 5xx, network, unrecognised refusal,
  // unattributable success, crash) ⇒ left pending, "outcome unknown — do not
  // pay again", resolved by the supervised reconciliation loop from PROOF OF
  // EXECUTION on the chain (an `AuthorizationUsed` log whose transaction
  // carries the exact Transfer to the treasury — never the
  // `authorizationState` bit, which a cancellation also sets; round 3). The
  // amount credited is only ever the authorization's value. A same-key retry
  // while pending is refused
  // 409 before anything is priced; the same authorization is never settled
  // twice under any key.
  //
  // Destination: the relay treasury (`x402Config.payToAddress`), never the
  // worker's `pay_to_address`. x402 is a relay-custody guest rail
  // (docs/doctrine/settlement-rails.md, treasury-custody.md "Clients pay TO
  // X402_PAY_TO_ADDRESS"): the relay receives the payment, credits it to the
  // delegator's virtual account, holds the task's budget from that account and
  // pays the worker's virtual account at settlement. Sending x402 to the worker
  // while also crediting the delegator paid the worker twice and cost the
  // relay the price.
  type X402Payment = {
    /** The path agent, the key and the delegator this payment was verified for. */
    motebitId: string;
    idempotencyKey: string;
    delegatorId: string;
    /** The quoted gross price, integer micro-units (USDC atomic units). */
    grossMicro: number;
    /** "verified" until `settle()` is called; then never settled again. */
    state: "verified" | "settling" | "settled" | "failed";
    /**
     * Settle THIS request's payment, for the task id it will admit. Single
     * use. Writes the durable intent first; throws a refusal ("not charged")
     * only on a definite facilitator refusal, and `X402OutcomeUnknownError`
     * ("do not pay again") on anything else that is not a settlement.
     */
    settle(taskId: string): Promise<X402Settlement>;
    /** PAYMENT-RESPONSE headers for a settled payment. */
    responseHeaders?: Record<string, string>;
  };
  type X402Settlement = {
    txHash: string;
    network: string;
    amountMicro: number;
    payer: string;
    nonce: string;
  };
  const X402_PAYMENT_KEY = "x402Payment";

  {
    const { x402HTTPResourceServer, x402ResourceServer, HonoAdapter } = await import("@x402/hono");
    const { FacilitatorResponseError } = await import("@x402/core/server");
    const { SettleError } = await import("@x402/core/types");
    const { encodePaymentResponseHeader } = await import("@x402/core/http");
    const { ExactEvmScheme } = await import("@x402/evm/exact/server");
    // CDP-aware facilitator construction; throws X402ConfigError on mainnet
    // misconfiguration so the route registration fails fast rather than
    // silently leaving the x402 surface broken. See x402-facilitator.ts.
    const { createX402FacilitatorClient } = await import("./x402-facilitator.js");
    const { abortGetSupportedOnShutdown } = await import("./x402-facilitator-shutdown.js");
    const facilitatorClient = abortGetSupportedOnShutdown(
      (x402FacilitatorClient ?? (await createX402FacilitatorClient(x402Config))) as object,
      shutdownSignal,
    ) as ConstructorParameters<typeof x402ResourceServer>[0];

    const network = x402Config.network as `${string}:${string}`;
    const treasury = x402Config.payToAddress;
    const resourceServer = new x402ResourceServer(facilitatorClient).register(
      network,
      new ExactEvmScheme(),
    );

    // The x402 price of each request is its `priceSubmission` quote (#901
    // round 2), held PER REQUEST: the wrapper stores the quote under a fresh
    // nonce and stamps the nonce on the request it hands the gate (overwriting
    // any client-sent value), and the price callback reads the quote back
    // through the request adapter. A single shared "current pricing" variable
    // was set before awaits (the body read, the facilitator init), so a
    // concurrent submission could replace it and one request was charged
    // another's price.
    type X402Quote = { unitCost: number; grossMicro: number };
    const x402Quotes = new Map<string, X402Quote>();
    const X402_QUOTE_HEADER = "x-motebit-x402-quote";
    type QuoteContext = { adapter?: { getHeader(name: string): string | undefined } };
    const quoteOf = (ctx: QuoteContext): X402Quote | null => {
      const nonce = ctx.adapter?.getHeader(X402_QUOTE_HEADER);
      return nonce != null ? (x402Quotes.get(nonce) ?? null) : null;
    };
    const requireQuote = (ctx: QuoteContext): X402Quote => {
      const quote = quoteOf(ctx);
      // Fail closed: a request the wrapper did not quote is never priced as free.
      if (quote == null) throw new Error("x402: no price quote for this request");
      return quote;
    };

    const x402Routes = {
      "POST /agent/*/task": {
        accepts: {
          scheme: "exact" as const,
          network,
          // Exactly the handler's `price_snapshot` (integer micro-units).
          price: (ctx: QuoteContext) => `$${fromMicro(requireQuote(ctx).grossMicro).toFixed(6)}`,
          // The relay treasury — x402 is relay-custody (see above). Every
          // priced request resolves its quote first, so an unquoted request
          // still fails closed in `price`.
          payTo: (ctx: QuoteContext) => {
            requireQuote(ctx);
            return treasury;
          },
        },
        description: "Submit a task to a motebit agent",
        mimeType: "application/json",
        unpaidResponseBody: (ctx: { path: string } & QuoteContext) => {
          const agentId = extractMotebitIdFromPath(ctx.path);
          return {
            contentType: "application/json",
            body: {
              error: "payment_required",
              message: "Task submission requires USDC payment via x402",
              agent: agentId,
              estimated_cost: quoteOf(ctx)?.unitCost ?? 0,
              platform_fee_rate: platformFeeRate,
              network: x402Config.network,
            },
          };
        },
      },
    };

    // Construct HTTP server ourselves so we control initialization lifecycle.
    // Initialization is fired manually with .catch() so the promise rejection
    // is always handled. The x402 gate is fail-closed: if the facilitator
    // is unreachable, paid requests get 402 (correct behavior). Virtual
    // account bypass still works regardless.
    const httpServer = new x402HTTPResourceServer(resourceServer, x402Routes);
    let x402Initialized = false;
    const x402InitPromise = httpServer
      .initialize()
      .then(() => {
        x402Initialized = true;
      })
      .catch((err: unknown) =>
        logger.warn("x402.facilitator.init_failed", {
          error: err instanceof Error ? err.message : String(err),
          facilitator: x402Config.facilitatorUrl ?? "https://x402.org/facilitator",
        }),
      );
    trackStartup?.(x402InitPromise);
    const paywallConfig = { testnet: x402Config.testnet ?? true };

    // One priceSubmission() quote per request. Free tasks (no listing / zero
    // price) bypass payment entirely. Funding is decided HERE, once: a
    // delegator whose spendable balance covers the price is funded from its
    // virtual account (the gate steps aside and binds no payment); otherwise
    // the request must carry an x402 payment, which is verified and bound to
    // it. The handler never re-decides: with a bound payment it settles that
    // payment; without one it debits the account (and refuses 402 if a
    // concurrent spend emptied it — nothing is charged onchain then).
    app.use("*", async (c, next) => {
      const isTaskPost = c.req.method === "POST" && /\/agent\/[^/]+\/task/.test(c.req.path);
      if (!isTaskPost) return next();
      // `c.req.path` is decoded with `decodeURI`, the handler's param with
      // `decodeURIComponent`: a segment still holding a `%` here (`%3A`, …)
      // is one the two disagree about, so this gate would price one agent
      // and the handler serve another. Refused, never priced as free (#853).
      const pathAgentId = extractMotebitIdFromPath(c.req.path);
      const agentId = pathAgentId == null ? null : pathIdentity(pathAgentId);
      if (pathAgentId != null && agentId == null) {
        return c.json(
          { error: "motebitId in the path must be literal — no percent-encoding" },
          400,
        );
      }
      if (agentId == null) return next();
      // Only a task SUBMISSION is priced (the x402 route pattern, `POST
      // /agent/*/task`, matches no deeper path — receipts pass through).
      if (!/^\/agent\/[^/]+\/task$/.test(c.req.path)) return next();

      // Idempotency before price (#925). A key that already holds a claim is a
      // replay or a conflict: the handler answers it from the claim and admits
      // nothing, so it is never quoted, verified or charged here. With no key
      // the handler refuses 400 — nothing to charge either.
      const idempotencyKey = c.req.header("Idempotency-Key");
      if (!idempotencyKey) return next();
      if (idempotencyClaimExists(moteDb.db, idempotencyKey, agentId)) return next();
      // An earlier request under this key paid via x402 and its outcome is
      // not known yet (#907 round 2): never quote or settle another payment
      // for it. The record names what is being reconciled.
      const pendingX402 = findPendingX402ForKey(moteDb.db, idempotencyKey, agentId);
      if (pendingX402 != null) {
        throw new X402OutcomeUnknownError(x402SettlementRef(pendingX402), "pending");
      }

      // Read the body ONCE and hand the handler an identical request: the
      // price depends on it (`target_agent`, `required_capabilities`), and so
      // do the delegator (`submitted_by`) and the P2P bypass (`payment_proof`).
      // The request is rebuilt with the same bytes and with the quote header
      // stripped (only this wrapper sets it, below).
      const bodyText = new TextDecoder().decode(await c.req.raw.arrayBuffer());
      const headers = new Headers(c.req.raw.headers);
      headers.delete(X402_QUOTE_HEADER);
      const rebuild = (): void => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- Hono internals: replacing raw request for body re-read
        (c.req as any).raw = new Request(c.req.raw.url, {
          method: c.req.raw.method,
          headers,
          body: bodyText,
        });
      };
      rebuild();
      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        // Fail closed: an unparseable body is charged nothing and never priced
        // as free — the handler reads the same bytes and rejects them.
        return next();
      }
      // The SAME reading the handler makes (`submissionTerms`): the submitter,
      // the worker the task is routed to, and that worker's price. A refused
      // submission (not an object, an empty `submitted_by`, a `target_agent`
      // that routes nothing) is charged nothing — the handler refuses it 400.
      const terms = submissionTerms(
        moteDb,
        agentId,
        // The VERIFIED caller dualAuth set — the exact input the handler
        // passes. Re-parsing the bearer here (unverified) let the gate and
        // the handler disagree on who pays when auth was not mounted.
        c.get("callerMotebitId" as never) as string | undefined,
        parsed,
        platformFeeRate,
      );
      if (!terms.ok) return next();
      const { price } = terms;
      // Free, or a priced agent that publishes no `pay_to_address`, is not
      // x402-chargeable: the handler decides (a priced task it cannot fund is
      // refused 402).
      if (price.grossMicro <= 0 || price.payTo == null) return next();

      // Virtual account bypass: the delegator the handler will debit
      // (`submitter ?? path agent`) can pay from its SPENDABLE balance, the
      // number the hold is debited against, never the raw balance (#901). A
      // raw read skipped x402 for an account whose balance is under the escrow
      // hold; the handler then refused it 402 "pay via x402", and every retry
      // skipped x402 again.
      const delegatorId = terms.submitter ?? agentId;
      if (getSpendableBalance(moteDb.db, delegatorId) >= price.grossMicro) return next();

      // P2P bypass: a body carrying payment_proof paid onchain — skip x402.
      // Checked after the balance, so p2p is used only when the delegator
      // cannot pay through its virtual account.
      if ((parsed as { payment_proof?: unknown }).payment_proof != null) return next();

      const nonce = crypto.randomUUID();
      x402Quotes.set(nonce, { unitCost: price.unitCost, grossMicro: price.grossMicro });
      headers.set(X402_QUOTE_HEADER, nonce);
      rebuild();
      try {
        // Guard: if the facilitator is unreachable, the x402 gate throws (500)
        // instead of returning a proper 402.
        await x402InitPromise;
        if (!x402Initialized) {
          return c.json(
            {
              error: "payment_required",
              message:
                "Payment facilitator unavailable — deposit to virtual account or retry later",
              estimated_cost: price.unitCost,
              platform_fee_rate: platformFeeRate,
              network: x402Config.network,
            },
            402,
          );
        }

        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
        const adapter = new HonoAdapter(c);
        const context = {
          adapter,
          path: c.req.path,
          method: c.req.method,
          paymentHeader: adapter.getHeader("payment-signature") ?? adapter.getHeader("x-payment"),
        };
        // The route pattern covers every path this wrapper prices. A miss
        // would admit a priced task with no payment asked: fail closed.
        if (!httpServer.requiresPayment(context)) {
          throw new Error("x402: a priced task submission did not match the payment route");
        }
        let result: Awaited<ReturnType<typeof httpServer.processHTTPRequest>>;
        try {
          result = await httpServer.processHTTPRequest(context, paywallConfig);
        } catch (err) {
          if (err instanceof FacilitatorResponseError) return c.json({ error: err.message }, 502);
          throw err;
        }
        if (result.type === "payment-error") {
          // No payment, or one that did not verify: the 402 challenge (with
          // its PAYMENT-REQUIRED header) or the facilitator's refusal.
          const { response } = result;
          for (const [k, v] of Object.entries(response.headers)) c.header(k, v);
          if (response.isHtml) {
            return c.html(
              typeof response.body === "string" ? response.body : "",
              response.status as 402,
            );
          }
          return c.json(response.body ?? {}, response.status as 402);
        }
        if (result.type !== "payment-verified") {
          throw new Error(`x402: priced task submission answered ${result.type}`);
        }
        const { paymentPayload, paymentRequirements, declaredExtensions, beforeHandlerSettlement } =
          result;
        // ExactEvmScheme's EIP-3009 flow is "authorization": verify only,
        // nothing settled before the handler. A flow that settled already
        // would be money this path never records — refuse loudly.
        if (beforeHandlerSettlement != null) {
          logger.error("x402.unexpected_settle_before_handler", {
            agent: agentId,
            transaction: beforeHandlerSettlement.result.transaction,
          });
          throw new Error("x402: payment flow settled before the handler — unsupported");
        }

        // Tie the verified payment to THIS request's quote before anything is
        // settled: the relay's treasury, this network, and exactly the quoted
        // gross in USDC atomic units (= micro-units). A mismatch (an asset
        // whose decimals are not 6, a route misconfiguration) is refused, and
        // nothing is charged.
        if (
          paymentRequirements.payTo.toLowerCase() !== treasury.toLowerCase() ||
          paymentRequirements.network !== network ||
          paymentRequirements.amount !== String(price.grossMicro)
        ) {
          logger.error("x402.payment_unbound", {
            agent: agentId,
            payTo: paymentRequirements.payTo,
            network: paymentRequirements.network,
            amount: paymentRequirements.amount,
            quotedMicro: price.grossMicro,
          });
          throw new TaskError(
            "TASK_X402_PAYMENT_UNBOUND",
            "x402 payment requirements do not match this submission's quote — nothing was charged",
            500,
          );
        }
        // The EIP-3009 authorization is what a record is keyed by and what
        // reconciliation reads from the chain (x402-settlements.ts). A payment
        // that is not one, or whose authorization does not pay exactly this
        // quote to the treasury, is refused before anything is submitted.
        const authorization = readEip3009Authorization(paymentPayload.payload);
        if (
          authorization == null ||
          authorization.to !== treasury.toLowerCase() ||
          authorization.value !== String(price.grossMicro)
        ) {
          throw new TaskError(
            "TASK_X402_PAYMENT_UNBOUND",
            "The x402 payment is not an EIP-3009 authorization of exactly this submission's price to the relay treasury — it was not settled",
            400,
          );
        }
        // validBefore is client-chosen. Bounded, it bounds how long a record
        // can stay pending and how far reconciliation ever scans (#907 round 4).
        if (authorization.validBefore > Math.floor(Date.now() / 1000) + X402_MAX_VALIDITY_SECONDS) {
          throw new TaskError(
            "TASK_X402_PAYMENT_UNBOUND",
            `The x402 authorization's validBefore is more than ${X402_MAX_VALIDITY_SECONDS} s ahead — sign one that expires sooner; it was not settled`,
            400,
          );
        }
        // The signed execution window bounds where reconciliation looks for an
        // execution — chain-time facts only, never this relay's clock (#907
        // round 9); the relay-clock bound above is a sanity check.
        if (
          authorization.validBefore <= authorization.validAfter ||
          authorization.validBefore - authorization.validAfter > X402_MAX_WINDOW_SECONDS
        ) {
          throw new TaskError(
            "TASK_X402_PAYMENT_UNBOUND",
            `The x402 authorization's validAfter..validBefore window must be positive and at most ${X402_MAX_WINDOW_SECONDS} s — it was not settled`,
            400,
          );
        }
        // One signed authorization is settled and credited at most once (#907
        // round 2), under any key: a replay is refused here, and a concurrent
        // one loses the (payer, nonce) primary key when its intent is written.
        const existing = findX402Settlement(moteDb.db, authorization.payer, authorization.nonce);
        if (existing != null) {
          throw new X402PaymentReplayedError(x402SettlementRef(existing));
        }

        const payment: X402Payment = {
          motebitId: agentId,
          idempotencyKey,
          delegatorId,
          grossMicro: price.grossMicro,
          state: "verified",
          settle: async (taskId: string): Promise<X402Settlement> => {
            if (payment.state !== "verified") {
              throw new Error("x402: this request's payment was already settled");
            }
            payment.state = "settling";
            // Durable intent FIRST: a crash, a timeout or an unreadable answer
            // from here on leaves a pending record the reconciler resolves
            // from the chain — never a charge nobody knows about.
            const intent = {
              payer: authorization.payer,
              nonce: authorization.nonce,
              network,
              token: paymentRequirements.asset.toLowerCase(),
              pay_to: treasury.toLowerCase(),
              amount_micro: price.grossMicro,
              valid_after: authorization.validAfter,
              valid_before: authorization.validBefore,
              idempotency_key: idempotencyKey,
              motebit_id: agentId,
              delegator_id: delegatorId,
              task_id: taskId,
            };
            if (!recordX402Intent(moteDb.db, intent)) {
              payment.state = "failed";
              const rec = findX402Settlement(moteDb.db, intent.payer, intent.nonce);
              throw new X402PaymentReplayedError(rec != null ? x402SettlementRef(rec) : undefined);
            }
            const ref = x402SettlementRef({ ...intent, status: "pending" });
            let outcome: SettleOutcome;
            try {
              const verdict = await resourceServer.settlePayment(
                paymentPayload,
                paymentRequirements,
                declaredExtensions,
                { request: context },
              );
              outcome = classifySettleVerdict(verdict, {
                network,
                amountMicro: price.grossMicro,
              });
            } catch (err) {
              // The facilitator's own answer, delivered as a non-2xx JSON
              // settle response, is a verdict; anything else thrown (a
              // timeout, a non-JSON 5xx, a network error, a malformed body)
              // says nothing about whether the transfer landed.
              outcome =
                err instanceof SettleError
                  ? classifySettleVerdict(
                      {
                        success: false,
                        errorReason: err.errorReason,
                        ...(err.transaction != null ? { transaction: err.transaction } : {}),
                      },
                      { network, amountMicro: price.grossMicro },
                    )
                  : {
                      kind: "unknown",
                      reason: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
                    };
            }
            if (outcome.kind === "refused") {
              payment.state = "failed";
              markX402Failed(moteDb.db, intent.payer, intent.nonce, outcome.reason);
              throw new TaskError(
                "TASK_X402_SETTLEMENT_FAILED",
                `The facilitator refused the x402 payment before submitting it (${outcome.reason}): nothing has been charged, and this task was not admitted. The signed authorization stays valid until its validBefore; if it is executed anyway, the payment is credited to account ${delegatorId}. Retry with a fresh payment.`,
                402,
              );
            }
            if (outcome.kind === "unknown") {
              payment.state = "failed";
              logger.error("x402.settlement_outcome_unknown", {
                payer: intent.payer,
                nonce: intent.nonce,
                amountMicro: intent.amount_micro,
                idempotencyKey,
                agent: agentId,
                delegator: delegatorId,
                taskId,
                reason: outcome.reason,
              });
              throw new X402OutcomeUnknownError(ref);
            }
            payment.state = "settled";
            payment.responseHeaders = {
              "PAYMENT-RESPONSE": encodePaymentResponseHeader({
                success: true,
                transaction: outcome.txHash,
                network: outcome.network as `${string}:${string}`,
                payer: intent.payer,
              }),
            };
            return {
              txHash: outcome.txHash,
              network: outcome.network,
              // The authorization's value — the only amount ever credited.
              amountMicro: intent.amount_micro,
              payer: intent.payer,
              nonce: intent.nonce,
            };
          },
        };
        c.set(X402_PAYMENT_KEY as never, payment as never);
        // A verified payment the handler never settles (a refusal, a replay or
        // conflict decided by the handler's own claim, a throw) is simply
        // never submitted: the signed authorization is not executed and
        // expires at its `validBefore`. Nothing is charged.
        await next();
        if (payment.responseHeaders != null) {
          for (const [k, v] of Object.entries(payment.responseHeaders)) c.res.headers.set(k, v);
        }
        return;
      } finally {
        x402Quotes.delete(nonce);
      }
    });
  }

  // --- Admission outcome (#888): one Idempotency-Key, at most one task ---
  // Registered before the submit route so it wraps the handler: after the
  // handler returns or throws (Hono renders the throw through onError first),
  // a request that ADMITTED a task records its response as the key's terminal
  // outcome. See `recordAdmissionOutcome`.
  app.use("/agent/:motebitId/task", async (c, next) => {
    await next();
    if (c.req.method !== "POST") return;
    const admitted = c.get(ADMITTED_TASK_KEY as never) as AdmittedTask | undefined;
    if (admitted == null) return;
    try {
      const outcome = await recordAdmissionOutcome(moteDb.db, admitted, c.res);
      if (outcome !== c.res) c.res = outcome;
    } catch (err) {
      // The claim stays bound to its task (never released), so a replay gets
      // 409 until the 24h sweep — never a second task. Say so loudly.
      logger.error("task.admission_outcome_unrecorded", {
        correlationId: admitted.taskId,
        taskId: admitted.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // --- POST /agent/:motebitId/task — submit a task (master token or signed device token) ---
  /** @spec motebit/delegation@1.0 */
  app.post("/agent/:motebitId/task", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));

    // Idempotency key required for task submission (involves budget allocation)
    const idempotencyKey = c.req.header("Idempotency-Key");
    if (!idempotencyKey) {
      throw new TaskError(
        "TASK_INVALID_INPUT",
        "Idempotency-Key header is required for task submission",
        400,
      );
    }

    const idempCheck = checkIdempotency(moteDb.db, idempotencyKey, motebitId);
    if (idempCheck.action === "replay") {
      // Same answer, fresh admission when the old one has aged out and the
      // work never happened (see refreshDispatchTokenOnReplay).
      const replayed = await refreshDispatchTokenOnReplay(
        JSON.parse(idempCheck.body) as Record<string, unknown>,
        { taskQueue, relayIdentity, parseTokenPayloadUnsafe },
      );
      return c.json(replayed, idempCheck.status as 201);
    }
    if (idempCheck.action === "conflict") {
      if (idempCheck.taskId != null) {
        // The key already admitted a task whose outcome is not recorded yet
        // (its request is in flight, or ended before recording it). Name the
        // task, so a client can poll it instead of waiting out the key (#888).
        return c.json(
          {
            error: "A request with this idempotency key already admitted a task",
            code: "TASK_CONFLICT",
            status: 409,
            task_id: idempCheck.taskId,
          },
          409,
        );
      }
      throw new TaskError(
        "TASK_CONFLICT",
        "A request with this idempotency key is already being processed",
        409,
      );
    }
    // This request now OWNS the 'processing' claim. Stamp ownership so the
    // error boundary can release it if the handler throws before
    // completeIdempotency — else the key is stranded and an honest
    // same-key retry gets 409 until the 24h sweep (#459). Set only on the
    // claiming request; a conflict above never reaches this line. The release
    // reopens the key only while no task is admitted: once the admission
    // transaction below binds the claim to a task, the claim is kept and the
    // request's outcome is recorded instead (#888).
    c.set("idempotencyClaim" as never, { key: idempotencyKey, motebitId } as never);

    const body = (await readSubmissionBody(c)) as {
      prompt: string;
      submitted_by?: string;
      wall_clock_ms?: number;
      required_capabilities?: string[];
      step_id?: string;
      /** Optional: requesting agent's exploration drive [0-1] from intelligence gradient. */
      exploration_drive?: number;
      /** Optional: agent IDs to exclude from routing (failed on previous attempts). */
      exclude_agents?: string[];
      /** Optional: routing strategy for candidate ranking. */
      routing_strategy?: "cost" | "quality" | "balanced";
      /**
       * Invocation provenance discriminator — propagated to the task envelope
       * and, via the agent's receipt builder, onto the signed outer receipt.
       * See `IntentOrigin` in `@motebit/protocol` and
       * `docs/doctrine/surface-determinism.md`. Unknown values are rejected
       * (400) so that surface-determinism callers cannot typo past the gate.
       */
      invocation_origin?: "user-tap" | "ai-loop" | "scheduled" | "agent-to-agent";
      /**
       * Who presents the admitted task to the worker (delegation spec §3.1,
       * 1.2). "relay" (default): the relay routes and forwards, its token
       * travels with the dispatch. "submitter": the relay runs every settlement
       * gate but does NOT route; it returns the dispatch_token and the
       * submitter presents the task directly — the shape of a sub-delegation
       * whose receipt rides back in the submitter's own delegation chain. One
       * admission, one presenter, chosen up front instead of by whether
       * anything happened to route.
       */
      presenter?: "relay" | "submitter";
      /** P2P: target agent for direct settlement (required with payment_proof). */
      target_agent?: string;
      /**
       * P2P bootstrap acknowledgment — Arc 3 of the off-ramp arc. When
       * set true, unlocks the eligibility gate's new-pair branch (no
       * trust history accumulated yet). The delegator consciously
       * accepts the cold-start risk; transactions accumulate real
       * trust into the graph for future routing decisions. Established
       * pairs (trust ≥ 0.6 + ≥5 interactions) don't need this — the
       * acknowledgment is ignored on the fast path. See
       * `docs/doctrine/off-ramp-as-user-action.md` § Arc 3 and the
       * `trust_as_economic_membrane` memory.
       */
      delegator_acknowledges_no_history_risk?: boolean;
      /**
       * Standing-delegation grant this task executes under (checkpoint
       * D4). OPTIONAL and advisory-shaped on the wire — a bare id, not
       * the signed artifacts; the runtime's `verifyGrantForTurn` is the
       * cryptographic gate. Declaring it buys the submitter the relay's
       * acceptance-time revocation fence: a task under a grant the
       * relay's delegation-revocation cache shows revoked is refused
       * BEFORE any budget hold commits.
       */
      grant_id?: string;
      /** P2P: onchain payment proof (triggers p2p settlement mode). */
      payment_proof?: {
        tx_hash: string;
        chain: string;
        network: string;
        to_address: string;
        amount_micro: number;
        /**
         * Relay treasury Solana address (base58). Required after Arc 2
         * of the off-ramp arc — the delegator's atomic Solana tx
         * composes a fee leg sending `fee_amount_micro` to this
         * address. Discoverable via the relay's published public key
         * (`deriveSolanaAddress(relayPublicKey)`).
         */
        fee_to_address: string;
        /**
         * Fee leg amount in micro-units. Computed as
         * `gross - amount_micro` where `gross = amount_micro / (1 - feeRate)`.
         * For federated P2P this is the ORIGIN relay's (A's) fee leg.
         */
        fee_amount_micro: number;
        /**
         * Executor-relay (B) treasury address + fee leg. Present ONLY for
         * cross-operator federated P2P (delegation to a remote worker). The
         * delegator's atomic tx carries a THIRD leg → relay B's treasury.
         * See `P2pPaymentProof` in `@motebit/protocol` and
         * `docs/doctrine/off-ramp-as-user-action.md` § federated P2P.
         */
        b_fee_to_address?: string;
        b_fee_amount_micro?: number;
      };
    };

    if (body.presenter != null && body.presenter !== "relay" && body.presenter !== "submitter") {
      throw new TaskError(
        "TASK_INVALID_INPUT",

        'presenter must be "relay" or "submitter" when present',

        400,
      );
    }

    const submitterPresenter = body.presenter === "submitter";

    if (!body.prompt || typeof body.prompt !== "string" || body.prompt.trim() === "") {
      throw new TaskError("TASK_INVALID_INPUT", "Missing or empty 'prompt' field", 400);
    }
    if (body.required_capabilities != null && !Array.isArray(body.required_capabilities)) {
      throw new TaskError(
        "TASK_INVALID_INPUT",
        "required_capabilities must be an array of strings",
        400,
      );
    }
    const VALID_INVOCATION_ORIGINS = [
      "user-tap",
      "ai-loop",
      "scheduled",
      "agent-to-agent",
    ] as const;
    if (
      body.invocation_origin != null &&
      !VALID_INVOCATION_ORIGINS.includes(body.invocation_origin)
    ) {
      throw new TaskError(
        "TASK_INVALID_INPUT",
        `invocation_origin must be one of: ${VALID_INVOCATION_ORIGINS.join(", ")}`,
        400,
      );
    }

    // The one reading of this submission (#901 round 3) — the same the x402
    // gate made: the submitter, the worker the task is ROUTED to, and that
    // worker's price. Refused before admission (the key is freed): a
    // `target_agent` that routes nothing, an empty `submitted_by`.
    const terms = submissionTerms(
      moteDb,
      motebitId,
      c.get("callerMotebitId" as never) as string | undefined,
      body,
      platformFeeRate,
    );
    if (!terms.ok) throw new TaskError("TASK_INVALID_INPUT", terms.message, 400);

    // Standing-delegation revocation fence (checkpoint D4). Cache-based,
    // not cryptographic — the runtime's verifyGrantForTurn is the
    // cryptographic gate; this is the coordinator refusing to ACCEPT (and
    // therefore to hold money for) work under authority it can already
    // see is withdrawn. The cache is never the authority (§6 D2): an
    // un-cached revocation still bites at the runtime. Mid-flight
    // revocations (arriving after acceptance, before receipt) are not
    // re-fenced in v1 — the hold was committed under then-unrevoked
    // authority; online latency is bounded by this acceptance check.
    if (body.grant_id != null) {
      if (typeof body.grant_id !== "string" || body.grant_id.trim() === "") {
        throw new TaskError("TASK_INVALID_INPUT", "grant_id must be a non-empty string", 400);
      }
      // Only the SUBMITTER's own revocation fences its task (#850): the relay
      // holds no grants, so a cached revocation by any other identity names a
      // grant_id it has no proven relationship to. The submitter is the one
      // settlement uses below (the verified token's identity, else the
      // operator's body field); a body-named submitter can only ever fence
      // the request that names it.
      const fenceSubmitter = terms.submitter;
      if (isGrantRevokedBy(moteDb.db, body.grant_id, fenceSubmitter)) {
        throw new TaskError(
          "TASK_GRANT_REVOKED",
          "Standing grant is revoked — task refused at acceptance (delegation-revocation cache)",
          403,
        );
      }
    }

    const taskId = crypto.randomUUID();
    const now = Date.now();
    const task: AgentTask = {
      task_id: taskId,
      motebit_id: motebitId,
      prompt: body.prompt,
      submitted_at: now,
      submitted_by: body.submitted_by,
      wall_clock_ms: body.wall_clock_ms,
      status: AgentTaskStatus.Pending,
      required_capabilities: Array.isArray(body.required_capabilities)
        ? (body.required_capabilities.filter(
            (c): c is string => typeof c === "string",
          ) as AgentTask["required_capabilities"])
        : undefined,
      step_id: body.step_id,
      invocation_origin: body.invocation_origin,
    };

    // Capture the submitter identity for receipt fan-out and settlement.
    // Prefer callerMotebitId (from dualAuth signed token) over body.submitted_by.
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    // (`submissionTerms`: the verified caller, else a non-empty `submitted_by`.)
    const submittedBy = terms.submitter;

    // A P2P proof already bound to an admitted task (#918). The refusal names
    // that task only to a caller entitled to see it (`mayDiscloseAdmittedTask`).
    const proofAlreadyAdmitted = (existing: P2pProofClaim): P2pProofAlreadyAdmittedError =>
      new P2pProofAlreadyAdmittedError(
        mayDiscloseAdmittedTask(existing, {
          operator: c.get(OPERATOR_PRESENTED) === true,
          verifiedCaller: callerMotebitId,
        })
          ? existing.task_id
          : undefined,
      );
    // Whether THIS request's submitter was proven by a signed token (not the
    // operator's body assertion). Recorded in the claim, so a later refusal
    // discloses the task only to a submitter the relay actually verified.
    const submitterVerified =
      typeof callerMotebitId === "string" &&
      callerMotebitId !== "" &&
      callerMotebitId === submittedBy;

    // Snapshot the listing price at submission time so the settlement audit
    // matches what the delegator actually paid. Price against the WORKER, not
    // the URL agent: a P2P proof submission carries `target_agent` (the worker)
    // and POSTs to the DELEGATOR's own endpoint, so `motebitId` (the URL) is the
    // delegator here — pricing by it would validate the hop against the
    // delegator's own listing (e.g. a $0.25 researcher paying a $0.003 atom
    // would be checked against $0.25). And price the SPECIFIC capability the
    // delegation pins, not the sum of the worker's listings. A non-P2P task has
    // no `target_agent` and prices the URL agent (the worker) as before.
    // unit_cost is in dollars from the listing JSON. Convert to micro-units for accounting.
    //
    // ONE price per submission (#901 rounds 2–3): `submissionTerms` is also
    // what the x402 gate charges and what its virtual-account bypass compares
    // against, so the gate can never divert to x402 a task the handler would
    // fund from the account (a double charge), nor ask x402 for less than the
    // handler credits — and the price is for the worker the task is ROUTED
    // to (`terms.routedTo`).
    const { pricingCapability, unitCost: unitCostAtSubmission, grossMicro } = terms.price;
    const priceSnapshot = grossMicro > 0 ? grossMicro : undefined;

    // THIS request's x402 payment, verified by the gate and bound to this
    // request's context (#907) — never a value another request left behind.
    // Not settled yet: the funding block below settles it, once, after every
    // pre-admission refusal. It must be the payment the gate verified for THIS
    // submission (path agent, key, delegator, price); anything else is refused
    // before anything is settled.
    const x402Payment = c.get(X402_PAYMENT_KEY as never) as X402Payment | undefined;
    if (
      x402Payment != null &&
      (x402Payment.motebitId !== motebitId ||
        x402Payment.idempotencyKey !== idempotencyKey ||
        x402Payment.delegatorId !== (submittedBy ?? motebitId) ||
        x402Payment.grossMicro !== grossMicro)
    ) {
      throw new TaskError(
        "TASK_X402_PAYMENT_UNBOUND",
        "The x402 payment on this request was verified for a different submission — nothing was charged",
        409,
      );
    }
    // Set only from THIS request's own settlement, in the funding block.
    let x402TxHash: string | undefined;
    let x402Net: string | undefined;

    // Reject if task queue is at capacity (prevents memory exhaustion from flooding)
    if (taskQueue.size >= MAX_TASK_QUEUE_SIZE) {
      throw new TaskError("TASK_QUEUE_FULL", "Task queue at capacity — try again later", 503);
    }

    // Per-submitter fairness: prevent a single agent from monopolizing queue
    // capacity. Uses the O(1) indexed COUNT — the previous implementation
    // iterated taskQueue.values(), which is a FULL-TABLE `SELECT *` plus a
    // per-row JSON.parse on every submission (#459: during the 2026-07-29
    // amplification incident this scan, growing with the queue it was
    // guarding, was the largest single event-loop cost and helped starve
    // the relay past its 2s health budget).
    if (submittedBy) {
      let submitterCount: number;
      if (typeof taskQueue.countBySubmitter === "function") {
        submitterCount = taskQueue.countBySubmitter(submittedBy);
      } else {
        // Plain-Map injection (tests) — iteration is fine at that scale.
        submitterCount = 0;
        for (const entry of taskQueue.values()) {
          if (entry.submitted_by === submittedBy) submitterCount++;
        }
      }
      if (submitterCount >= maxTasksPerSubmitter) {
        logger.warn("task.per_submitter_limit", {
          correlationId: taskId,
          submittedBy,
          limit: maxTasksPerSubmitter,
        });
        throw new TaskError(
          "TASK_PER_SUBMITTER_LIMIT",
          "Too many pending tasks for this agent",
          429,
        );
      }
    }

    // === P2P settlement path ===
    let settlementMode: "relay" | "p2p" = "relay";
    let p2pPaymentProof: TaskQueueEntry["p2p_payment_proof"];
    // True when the proof targets a REMOTE worker (cross-operator federated
    // P2P): routing forwards directly to the worker's operator with the proof
    // rather than ranking. Set in the remote branch below.
    let federatedP2pIntent = false;
    // What admission decided about the worker leg (#959) — set by the branch
    // that accepts the proof, never inferred later from the proof's shape.
    let p2pAdmission: P2pAdmission | undefined;

    if (terms.p2p && body.payment_proof && body.target_agent && submittedBy) {
      const proof = body.payment_proof;

      // Validate proof completeness — after Arc 2 of the off-ramp arc,
      // the fee leg fields are required (delegator's atomic tx carries
      // both worker and treasury legs).
      if (
        !proof.tx_hash ||
        !proof.chain ||
        !proof.network ||
        !proof.to_address ||
        !proof.amount_micro ||
        !proof.fee_to_address ||
        proof.fee_amount_micro == null
      ) {
        throw new TaskError(
          "TASK_INVALID_INPUT",
          "Incomplete payment_proof fields (after Arc 2: tx_hash, chain, network, to_address, amount_micro, fee_to_address, fee_amount_micro are all required)",
          400,
        );
      }

      // Tx hash format (Solana signatures are 87-88 char base58)
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(proof.tx_hash)) {
        throw new TaskError("TASK_INVALID_INPUT", "Invalid transaction signature format", 400);
      }

      // The proof is bound to its PAYER (#918 round 2). A tx hash is public
      // the moment it lands, so a submitter must prove the payment is theirs:
      // the transaction's payer must be the Solana address their key derives
      // (identity key = address). Checked here, before any other read of the
      // proof and before any admission write, so a non-payer learns nothing
      // about the proof's state, claims nothing, and frees its key. Fail
      // closed: no chain, an RPC error, or a transaction not visible yet is a
      // retryable 503 that admits nothing. p2p-payer.ts has the rule.
      const payerAddresses = payerCandidates(moteDb.db, {
        verifiedKey: c.get(CALLER_VERIFIED_KEY) as string | undefined,
        operator: c.get(OPERATOR_PRESENTED) === true,
        submitter: submittedBy,
      });
      const payer =
        p2pPaymentChain == null
          ? ({ status: "unavailable", reason: "no Solana RPC configured" } as const)
          : payerAddresses.size === 0
            ? ({ status: "not_payer" } as const)
            : await p2pPaymentChain.payerOf(p2pProofKey(proof.tx_hash), payerAddresses);
      if (payer.status === "not_payer") {
        throw new TaskError(
          "TASK_P2P_PROOF_NOT_PAYER",
          "This payment proof's transaction was not paid from the submitter's identity-derived wallet — only the payer may submit it",
          403,
        );
      }
      if (payer.status !== "payer") {
        throw new TaskError(
          "TASK_P2P_PROOF_UNVERIFIED",
          payer.status === "not_found"
            ? "This payment proof's transaction is not visible onchain at confirmed commitment yet — retry shortly; nothing was admitted"
            : `The relay cannot read the chain to verify this payment's payer (${payer.reason}) — retry shortly; nothing was admitted`,
          503,
        );
      }

      // Proof-replay guard: one onchain payment funds exactly one task. Reject a
      // tx_hash that has ALREADY settled a task on this relay — otherwise a
      // delegator could reuse one payment across many tasks (each a fresh
      // task_id, which the (task_id, *) unique indexes don't catch), getting N
      // workers to execute for ONE payment. Rejecting at SUBMISSION means the
      // worker never does replayed work; the partial UNIQUE index on
      // relay_settlements(p2p_tx_hash) (migration v30) is the structural
      // backstop for a second SETTLEMENT.
      const alreadySettled = moteDb.db
        .prepare("SELECT 1 FROM relay_settlements WHERE p2p_tx_hash = ? LIMIT 1")
        .get(p2pProofKey(proof.tx_hash));
      if (alreadySettled != null) {
        throw new TaskError(
          "TASK_P2P_PROOF_REPLAYED",
          "This payment proof (tx_hash) has already settled a task — each onchain payment funds exactly one task",
          409,
        );
      }
      // A settlement row exists only once a task SETTLED, so the check above
      // cannot see a proof whose task is admitted and still running (or whose
      // forward failed): that proof would fund a second task and a second
      // execution under a fresh Idempotency-Key (#918). The ADMISSION claim
      // sees it. This read refuses early, before eligibility and discovery;
      // the binding inside the admission transaction below is the law (it
      // also closes the race between two concurrent submissions).
      const admittedClaim = findP2pProofClaim(moteDb.db, proof.tx_hash);
      if (admittedClaim != null) throw proofAlreadyAdmitted(admittedClaim);

      // Is the target worker LOCAL to this relay? A worker REGISTERED here
      // (an `agent_registry` row, whatever its settlement_address) is local
      // and ALWAYS takes the local branch (#959 round 3): choosing the
      // federated path by the absence of a registered address let a payer
      // steer a locally hosted worker into a "remote" row whose worker leg
      // nobody checks. Only a worker this relay does not host is federated —
      // the cross-operator path, which carries a third (executor-relay) fee
      // leg and is validated at the forward site (where the worker's address
      // + the peer relay's treasury resolve via discovery). See
      // docs/doctrine/off-ramp-as-user-action.md § federated P2P.
      //
      // Branch selection (#959 rounds 4–5), over the row's shelf state and
      // the proof's shape:
      //   - ON SHELF and not revoked (the predicate discovery lists hireable
      //     agents by — `ON_SHELF` from registry-delist.ts + the revoked
      //     clause task-routing.ts composes) ⇒ LOCAL, whatever the proof
      //     says (a b_fee field on it is refused below). A hosted worker can
      //     never be steered into a 'remote' row.
      //   - not revoked but OFF shelf (delisted: a daemon that shut down and
      //     deregistered — "offline for a moment" — or a worker that moved to
      //     a peer), with a 2-LEG proof ⇒ LOCAL, verified against its
      //     registered address exactly as main queued it.
      //   - not revoked, off shelf, with a 3-LEG proof ⇒ the federated plan.
      //     'remote' still requires that plan to be BUILT from discovery (a
      //     peer hosting the worker, its identity-bound address, all three
      //     legs), so the proof's shape cannot choose 'remote' by itself.
      //   - REVOKED ⇒ never local (the row is kept for key state only).
      const workerRow = moteDb.db
        .prepare(
          `SELECT settlement_address, public_key,
                  (revoked IS NOT NULL AND revoked != 0) AS is_revoked,
                  (${ON_SHELF_PREDICATE}) AS on_shelf
             FROM agent_registry WHERE motebit_id = ?`,
        )
        .get(body.target_agent) as
        | {
            settlement_address: string | null;
            public_key: string | null;
            is_revoked: number;
            on_shelf: number;
          }
        | undefined;
      const proofHasExecutorLeg =
        proof.b_fee_to_address != null || proof.b_fee_amount_micro != null;
      const hostedHere =
        workerRow != null &&
        workerRow.is_revoked === 0 &&
        (workerRow.on_shelf === 1 || !proofHasExecutorLeg);
      const workerReg = hostedHere ? workerRow : undefined;

      if (workerReg != null) {
        // ── Single-operator P2P (local worker): the existing 2-leg path. ──
        // A 2-leg proof carries no executor-relay fee leg. One that does is
        // refused before anything is read or admitted (#959 round 2): the
        // fields mean nothing here, and a proof shape the payer controls must
        // never steer how the relay verifies the payment.
        if (proof.b_fee_to_address != null || proof.b_fee_amount_micro != null) {
          throw new TaskError(
            "TASK_INVALID_INPUT",
            "An executor-relay fee leg (b_fee_to_address, b_fee_amount_micro) applies only to a cross-operator P2P task; this worker is hosted by this relay — submit a 2-leg proof",
            400,
          );
        }
        // Policy-based eligibility check
        // Arc 3: pass the delegator's cold-start acknowledgment through to
        // the eligibility gate. Established pairs ignore it; new pairs
        // require it set true to unlock the bootstrap branch.
        // Bond-eligibility opt-in (additive — commitment-bond phase 1). Passing
        // the ticket value lets the gate consider a worker's verified, backed
        // commitment bond as a cold-start signal (CLAUDE.md rule 19). The
        // read-only adapter is the spec §6 accept-time re-verification seam: a
        // bond whose cached backing is stale — or that was just submitted and is
        // still `pending` — is re-checked synchronously at decision time rather
        // than trusted blindly or fail-closed-rejected. `null` when
        // SOLANA_RPC_URL is unset (bonds inert) → cached reads only, stale fails closed.
        const bondBackingAdapter = getBondBackingAdapter();
        const eligibility = await evaluateSettlementEligibility(
          moteDb.db,
          submittedBy,
          body.target_agent,
          body.delegator_acknowledges_no_history_risk === true,
          {
            unitCostMicro: unitCostAtSubmission > 0 ? BigInt(toMicro(unitCostAtSubmission)) : 0n,
            ...(bondBackingAdapter ? { adapter: bondBackingAdapter } : {}),
          },
        );
        if (!eligibility.allowed) {
          throw new TaskError("TASK_P2P_INELIGIBLE", eligibility.reason, 403);
        }

        // Verify worker's settlement address matches payment proof. At the LOCAL
        // leg the address was written by the worker itself (register/patch is
        // caller===motebit_id authed) or the operator — so the write-auth IS the
        // authorization, and an agent choosing a distinct payout wallet is
        // legitimate custody separation, not a redirect. No identity-derivation
        // binding is required here; the federated leg (below) is where a PEER
        // asserts a DIFFERENT agent's address and binding must be enforced.
        // docs/doctrine/settlement-authority-binding.md.
        //
        // DEFENSIVE FLOOR (#959 round 4): a local worker with no registered
        // address is not P2P-eligible (`evaluateSettlementEligibility` refuses
        // above — a worker that never registered an address never opted into
        // being paid P2P), so this branch should be unreachable for admission.
        // Should it be reached, the only destination accepted is the one the
        // worker's own key derives; anything else is refused.
        const derivedOk = (): boolean => {
          // Holder, else main's registry read (§5f verification reader).
          const workerKey = verificationKeyFor(
            moteDb.db,
            body.target_agent!,
            workerReg.public_key ?? undefined,
          );
          return workerKey != null && isDerivedSettlementBinding(proof.to_address, workerKey);
        };
        const addressOk = workerReg.settlement_address
          ? proof.to_address === workerReg.settlement_address
          : derivedOk();
        if (!addressOk) {
          throw new TaskError(
            "TASK_P2P_ADDRESS_MISMATCH",
            workerReg.settlement_address
              ? "Payment proof to_address does not match worker's settlement address"
              : "Payment proof to_address is not the worker's identity-derived address (the worker has no registered settlement address)",
            400,
          );
        }

        // Verify fee leg's treasury address matches the relay's
        // identity-derived Solana address. The relay treasury IS the
        // relay's identity key — same address that funds
        // OperatorSolanaTransfer and SolanaMemoSubmitter. Mismatch means
        // the delegator sent the fee leg to a non-relay address — reject.
        const { deriveSolanaAddress } = await import("@motebit/wallet-solana");
        const relayTreasuryAddress = deriveSolanaAddress(relayIdentity.publicKey);
        if (proof.fee_to_address !== relayTreasuryAddress) {
          throw new TaskError(
            "TASK_P2P_FEE_ADDRESS_MISMATCH",
            `Payment proof fee_to_address does not match relay treasury address`,
            400,
          );
        }

        // Exact amount match against the worker's unit cost. The worker
        // earns net = unit_cost; the fee = gross - unit_cost where
        // gross = unit_cost / (1 - platformFeeRate). The delegator's
        // atomic tx pays both.
        const unitCostMicro = unitCostAtSubmission > 0 ? toMicro(unitCostAtSubmission) : undefined;
        if (unitCostMicro != null && proof.amount_micro !== unitCostMicro) {
          throw new TaskError(
            "TASK_P2P_AMOUNT_MISMATCH",
            // Report the NET worker-leg amount the check actually compares against
            // (`unitCostMicro`), not the gross `priceSnapshot` — the earlier
            // message showed the gross and misled the diagnosis.
            `Payment worker-leg amount ${proof.amount_micro} does not match expected ${unitCostMicro} for capability "${pricingCapability ?? "?"}"`,
            400,
          );
        }

        // Fee amount must match the expected platform_fee given the worker's
        // unit_cost and the current platform_fee_rate. `computeP2pFeeMicro`
        // (@motebit/protocol) is the single canonical source for `gross - net`
        // where `gross = round(net / (1 - feeRate))` — the delegator client
        // that builds the proof computes the fee with the SAME primitive, so
        // the two cannot drift (a one-micro disagreement would reject every
        // proof here).
        if (unitCostMicro != null && platformFeeRate > 0) {
          const expectedFeeMicro = computeP2pFeeMicro(unitCostMicro, platformFeeRate);
          if (proof.fee_amount_micro !== expectedFeeMicro) {
            throw new TaskError(
              "TASK_P2P_FEE_AMOUNT_MISMATCH",
              `Payment fee_amount_micro ${proof.fee_amount_micro} does not match expected ${expectedFeeMicro} (net ${unitCostMicro}, rate ${platformFeeRate})`,
              400,
            );
          }
        }

        settlementMode = "p2p";
        p2pPaymentProof = proof;
        p2pAdmission = localWorkerAdmission(moteDb.db, body.target_agent, proof.to_address);

        logger.info("task.p2p_settlement", {
          correlationId: taskId,
          delegator: submittedBy,
          worker: body.target_agent,
          txHash: proof.tx_hash,
          amount: proof.amount_micro,
          reason: eligibility.reason,
        });
      } else {
        // ── Cross-operator federated P2P (remote worker): the 3-leg path. ──
        // The delegator client did federated discovery (P-A surfaces the
        // remote worker's settlement_address), built a single atomic Solana
        // tx with three legs — worker net, origin-relay (A) fee, executor-
        // relay (B) fee — and pinned the worker via `target_agent`. The
        // relay NEVER transmits funds cross-operator: the delegator pays
        // all three legs directly, both relays coordinate + verify only.
        //
        // Full leg validation (addresses + amounts vs the discovered
        // candidate + the peer relay's treasury) happens at the forward
        // site, where discovery has resolved the worker and the hosting
        // peer. Here we require the inputs that path needs.
        if ((task.required_capabilities ?? []).length === 0) {
          throw new TaskError(
            "TASK_P2P_NO_ADDRESS",
            "Federated P2P delegation to a remote worker requires required_capabilities (to locate the worker on its operator)",
            400,
          );
        }
        if (!proof.b_fee_to_address || proof.b_fee_amount_micro == null) {
          // Say WHY this worker is not local here (#959 round 5): a revoked
          // registration is never hireable on this relay; an unknown one is
          // hosted elsewhere, if anywhere.
          const why =
            workerRow != null && workerRow.is_revoked !== 0
              ? "This worker's registration on this relay is revoked, so it is not hired here"
              : "This worker is not hosted by this relay";
          throw new TaskError(
            "TASK_INVALID_INPUT",
            `${why}; a paid delegation to it is cross-operator, and a federated P2P payment_proof requires the executor-relay fee leg (b_fee_to_address, b_fee_amount_micro)`,
            400,
          );
        }

        // The federated plan (discovery, the settlement-authority binding and
        // the three-leg check) runs only when the RELAY presents: it is the
        // relay's forward that carries the proof to the executor relay. With
        // the submitter presenting, nothing would validate the legs or
        // forward the task — and no legitimate flow needs it: a dispatch
        // token this relay mints is verified by the worker against its OWN
        // relay's key, so the submitter could not present it to a remote
        // worker anyway. Refused before admission (#959 round 3).
        if (submitterPresenter) {
          throw new TaskError(
            "TASK_INVALID_INPUT",
            'A cross-operator P2P task is presented by the relay (its forward carries the proof to the executor relay); presenter "submitter" is not available for a worker this relay does not host',
            400,
          );
        }

        settlementMode = "p2p";
        p2pPaymentProof = proof;
        federatedP2pIntent = true;
        // `p2pAdmission` is set only once the federated plan is BUILT (below);
        // it is never chosen here, at branch selection.

        logger.info("task.federated_p2p_pending", {
          correlationId: taskId,
          delegator: submittedBy,
          worker: body.target_agent,
          txHash: proof.tx_hash,
        });
      }
    }

    // Priced === routed holds by construction (#901 round 3): the price is
    // `terms.price` of `terms.routedTo`, and every later use of the worker —
    // the pinned P2P dispatch, the audit row, the dispatch token — reads
    // `terms.routedTo` (the P2P branch runs only when `terms.p2p`, so its
    // `body.target_agent` IS `terms.routedTo`). No runtime assertion: one that
    // cannot fire guards nothing.

    // === Arc 3.5: P2P-by-default submission gate ===
    // Paid direct delegation to a different worker MUST settle P2P. The
    // predicate is the pure, unit-tested `requiresP2pProof` (truth table in
    // arc-3.5-gate.test.ts). True submission carve-outs (do not reach the gate):
    // zero-cost (`unitCostAtSubmission === 0`), self-delegation
    // (`submittedBy === motebitId`), x402-paid (own onchain proof). Multi-hop is
    // NOT a carve-out — a paid sub-delegation (B→C) is a real `POST /agent/C/task`
    // submission and is gated like any direct delegation; only the
    // `settleSubReceipt` relay-write (~665) is a deferred residual. See
    // off-ramp-as-user-action.md § "Arc 3.5".
    if (
      requiresP2pProof({
        settlementMode,
        x402Paid: x402Payment != null,
        unitCostAtSubmission,
        submittedBy,
        workerId: motebitId,
      })
    ) {
      throw new TaskError(
        "TASK_P2P_PROOF_REQUIRED",
        "Paid direct delegation requires a P2P payment_proof: the delegator settles the worker and platform fee onchain in one atomic transaction. Deposit-funded relay-custody settlement is closed for this flow. See off-ramp-as-user-action.md.",
        402,
      );
    }

    // === Federated P2P: discover and validate BEFORE admission (#888 r2) ===
    // A paid delegation to a pinned REMOTE worker is refused here, before any
    // task exists, when the worker is not discoverable, its settlement address
    // is not identity-bound, it has no priced listing, the executor relay's
    // treasury cannot be resolved, any of the three proof legs mismatch, or the
    // executor relay's circuit is open. A refusal therefore admits nothing:
    // the error boundary releases the key, and the delegator's corrected
    // same-key retry (a transient discovery miss, a fixed fee leg) is admitted
    // — once. Everything the forward needs is captured in `federatedP2pPlan`,
    // so what is forwarded after admission is exactly what was validated here
    // (nothing is re-read). Skipped when the submitter presents (no forward).
    // Doctrine: docs/doctrine/off-ramp-as-user-action.md § federated P2P.
    let federatedP2pPlan:
      | {
          peerEndpoint: string;
          peerRelayId: string;
          targetId: string;
          budgetMicro: number;
          workerNetMicro: number;
          aFeeMicro: number;
          bFeeMicro: number;
        }
      | undefined;
    if (federatedP2pIntent && !submitterPresenter) {
      const proof = p2pPaymentProof!;
      const targetId = body.target_agent!;
      const fedCaps = task.required_capabilities ?? [];
      // Same exclusion the ranking path applies (exclude_agents + the
      // submitter itself, #459): a pinned target on that list is not placed.
      const fedExclude = new Set(
        Array.isArray(body.exclude_agents)
          ? body.exclude_agents.filter((a): a is string => typeof a === "string")
          : [],
      );
      if (submittedBy) fedExclude.add(submittedBy);
      let fc:
        | {
            profile: CandidateProfile;
            _source_relay_endpoint: string;
            _settlement_address: string | null;
            _public_key: string | null;
          }
        | undefined;
      try {
        const fedResult = await taskRouter.fetchFederatedCandidates(fedCaps, callerMotebitId);
        fc = fedResult.candidates.find(
          (c) => c.profile.motebit_id === targetId && !fedExclude.has(c.profile.motebit_id),
        );
      } catch {
        // Discovery is best-effort; a miss is the 404 below, which frees the key.
      }
      if (fc == null) {
        throw new HTTPException(404, {
          message:
            "Pinned remote worker not discoverable on any active peer — cannot place the paid federated task",
        });
      }
      const peerEndpoint = fc._source_relay_endpoint;
      const workerAddr = fc._settlement_address;
      const fedPrice = fc.profile.listing?.pricing.find((p) =>
        (fedCaps as readonly string[]).includes(p.capability),
      );
      if (!workerAddr) {
        throw new HTTPException(400, {
          message: "Discovered remote worker has no settlement_address",
        });
      }

      // SETTLEMENT-AUTHORITY BINDING at the cross-org boundary. Unlike the
      // local leg, `workerAddr` here is asserted by a PEER — this relay has no
      // authed registration proving the worker chose it, so a malicious peer
      // could redirect the worker's payments. Bind it fail-closed
      // (docs/doctrine/settlement-authority-binding.md, derived rung): the
      // peer-forwarded key must (1) sovereign-bind to the worker's motebit_id
      // — a peer can't forge a key the id commits to — and (2) be the key the
      // address derives from. Both hold ⇒ the address is the worker's own,
      // beyond the peer's power to forge. A non-sovereign / rotated / distinct-
      // wallet worker fails closed here until the signed-bound rung transports
      // the succession-verified binding (Inc 2/3); prod has no external peers,
      // so that deferral is latent.
      const { deriveSolanaAddress } = await import("@motebit/wallet-solana");
      const { verifySovereignBinding } = await import("@motebit/crypto");
      const boundOk =
        fc._public_key != null &&
        isDerivedSettlementBinding(workerAddr, fc._public_key) &&
        (await verifySovereignBinding(targetId, fc._public_key));
      if (!boundOk) {
        throw new HTTPException(400, {
          message:
            "Remote worker settlement address is not identity-bound (peer-asserted address rejected; no derived+sovereign or signed binding)",
        });
      }
      if (fedPrice == null || fedPrice.unit_cost <= 0) {
        throw new HTTPException(400, {
          message: "Remote worker has no priced listing for the requested capability",
        });
      }

      // Fee-from-budget split (spec relay-federation-v1 §7.1): the listed
      // unit_cost IS the chain budget. A takes 5% of the budget, forwards
      // the remainder; B takes 5% of that; the worker nets the rest.
      // $1.00 → A $0.05 / B $0.0475 / worker $0.9025. The canonical
      // `computeFederatedFeeSplit` (@motebit/protocol) is shared with the
      // delegator client that builds the proof so the two cannot drift.
      const budgetMicro = toMicro(fedPrice.unit_cost);
      const {
        originFeeMicro: aFeeMicro,
        executorFeeMicro: bFeeMicro,
        workerNetMicro,
      } = computeFederatedFeeSplit(budgetMicro, platformFeeRate);

      // Resolve treasuries: A = our identity-derived Solana address; B = the
      // hosting peer's relay-identity-derived address (relay_peers.public_key).
      const aTreasury = deriveSolanaAddress(relayIdentity.publicKey);
      const peerRow = moteDb.db
        .prepare(
          "SELECT public_key, peer_relay_id FROM relay_peers WHERE endpoint_url = ? AND state = 'active'",
        )
        .get(peerEndpoint) as { public_key: string; peer_relay_id: string } | undefined;
      if (!peerRow?.public_key) {
        throw new HTTPException(400, {
          message: "Cannot resolve executor relay treasury (peer public key missing)",
        });
      }
      const bTreasury = deriveSolanaAddress(hexToBytes(peerRow.public_key));

      // Validate all three legs of the delegator's atomic tx against the
      // resolved addresses + the deterministic fee split. Any mismatch is
      // a fail-closed reject — the relay forwards only a proof it can stand
      // behind (and that the executor relay will independently re-verify).
      const legErr =
        proof.to_address !== workerAddr
          ? "worker leg address"
          : proof.amount_micro !== workerNetMicro
            ? `worker leg amount (${proof.amount_micro} ≠ ${workerNetMicro})`
            : proof.fee_to_address !== aTreasury
              ? "origin-fee leg address"
              : proof.fee_amount_micro !== aFeeMicro
                ? `origin-fee leg amount (${proof.fee_amount_micro} ≠ ${aFeeMicro})`
                : proof.b_fee_to_address !== bTreasury
                  ? "executor-fee leg address"
                  : proof.b_fee_amount_micro !== bFeeMicro
                    ? `executor-fee leg amount (${proof.b_fee_amount_micro} ≠ ${bFeeMicro})`
                    : null;
      if (legErr) {
        throw new HTTPException(400, {
          message: `Federated P2P payment_proof leg mismatch: ${legErr}`,
        });
      }
      // Conservation: the three legs sum to the budget exactly.
      if (workerNetMicro + aFeeMicro + bFeeMicro !== budgetMicro) {
        throw new HTTPException(500, { message: "Fee split does not conserve budget" });
      }
      // The circuit is checked here, before admission, so an open circuit
      // frees the key. It is NOT re-checked after admission: a re-check there
      // would lock the key on a refusal that made no attempt. If the circuit
      // opens in the window between this check and the forward, the forward
      // is attempted anyway and its failure is an honest post-attempt 502.
      if (!taskRouter.canForward(peerEndpoint)) {
        throw new HTTPException(503, {
          message: "Executor relay temporarily unavailable (circuit open) — retry shortly",
        });
      }
      federatedP2pPlan = {
        peerEndpoint,
        peerRelayId: peerRow.peer_relay_id,
        targetId,
        budgetMicro,
        workerNetMicro,
        aFeeMicro,
        bFeeMicro,
      };
      // This relay originates the task; the executor relay hosts the worker
      // and verifies its leg. Declared from the BUILT plan, with the PLANNED
      // executor relay recorded at admission — before the forward, so a lost
      // response (the executor accepted, our fetch timed out or saw a 5xx)
      // still leaves the scope 'remote' when the result arrives (#959 round
      // 4). Cleared only by a definitive refusal (4xx) at the forward site.
      // Only that peer's result is accepted for this task
      // (`onTaskResultReceived`).
      p2pAdmission = { worker_leg: "remote", planned_peer: peerRow.peer_relay_id };
    }

    // Every P2P admission names how its worker leg is verified: a local
    // worker binding, or a built federated plan. One that ends with neither is
    // refused — never admitted with a guessed scope (#959 round 3).
    if (settlementMode === "p2p" && p2pAdmission == null) {
      throw new TaskError(
        "TASK_INVALID_INPUT",
        "P2P admission produced neither a local worker binding nor a federated plan; refusing rather than guessing how the worker leg is verified",
        400,
      );
    }

    // Budget allocation, decided BEFORE admission (#888). Everything here can
    // refuse the task (insufficient funds, a failed deposit), and a refusal
    // must leave no task behind: the task is enqueued only by the admission
    // transaction below, which commits the hold's writes in the same step.
    // P2P tasks skip allocation — money already moved onchain.
    let fundingWrites: (() => void) | undefined;
    if (settlementMode !== "p2p" && priceSnapshot != null && priceSnapshot > 0) {
      // Payment is required BY DEFINITION here: this branch is guarded by
      // `priceSnapshot > 0`, and `priceSnapshot` derives from the listing's
      // own `pricing` column (`getListingUnitCost`). A priced agent charges.
      //
      // This used to ask an x402-chargeability read (`!= null`), which additionally
      // required a `pay_to_address` — and that made a priced listing WITHOUT a
      // payout address read as FREE. It is the same listing row answering two
      // different questions:
      //
      //   - the x402 middleware asks "can this agent be charged ONCHAIN?" —
      //     which genuinely needs `pay_to_address`, because that is where the
      //     money goes. `priceSubmission(...).payTo` serves that question.
      //   - this branch asks "does this agent charge AT ALL?" — which does not,
      //     because the relay-custody lane credits the worker's VIRTUAL ACCOUNT
      //     and never touches `pay_to_address`.
      //
      // Conflating them made "priced and unpayable" representable: priced
      // enough to mint a `price_snapshot`, not priced enough to demand payment.
      // An unfunded delegation then fell to the free-agent best-effort branch
      // below and booked an allocation `status='locked'` with `amount_locked`
      // set and NO debit — a row every downstream payout site trusts (the
      // settlement credit, the stale-allocation release, the retry-exhaustion
      // refund), each paying out real balance against money never received.
      //
      // Deriving both halves from the one read makes the disagreement
      // unrepresentable rather than catching it later at each payout site.
      const requiresPayment = true;

      try {
        const delegatorId = submittedBy ?? motebitId;

        // x402-funded (#907): settle THIS request's verified payment now —
        // after every pre-admission refusal, so a refused request is never
        // charged — and credit exactly what the relay treasury received to
        // the delegator this request names, once. The credit commits on its
        // own, before the hold: a refusal after it (below) leaves the payment
        // in the delegator's account and says so, never invites a second one.
        let x402CreditedMicro = 0;
        if (x402Payment != null) {
          // Refusals and unknown outcomes are thrown by `settle()` itself, as
          // the errors the client must see (a definite refusal: "not
          // charged"; anything else: "outcome unknown — do not pay again").
          const settlement: X402Settlement = await x402Payment.settle(taskId);
          x402TxHash = settlement.txHash;
          x402Net = settlement.network;
          x402CreditedMicro = settlement.amountMicro;
          let credited: boolean;
          try {
            // Flips the (payer, nonce) record pending → credited and credits
            // the delegator in ONE transaction: exactly once, whether this
            // request or the reconciler gets there first.
            credited = creditX402Settlement(moteDb.db, settlement.payer, settlement.nonce, {
              txHash: settlement.txHash,
              description: `x402 payment ${settlement.txHash} for task ${taskId}`,
              from: "pending",
            });
          } catch (depositErr) {
            // Settled onchain, not credited here. The record stays pending,
            // so the reconciler credits it from the chain; the client is told
            // not to pay again.
            logger.error("x402.settled_not_credited", {
              correlationId: taskId,
              delegator: delegatorId,
              payer: settlement.payer,
              nonce: settlement.nonce,
              txHash: settlement.txHash,
              amountMicro: settlement.amountMicro,
              idempotencyKey,
              error: depositErr instanceof Error ? depositErr.message : String(depositErr),
            });
            const rec = findX402Settlement(moteDb.db, settlement.payer, settlement.nonce);
            throw new X402OutcomeUnknownError(rec != null ? x402SettlementRef(rec) : undefined);
          }
          if (!credited) {
            // The record left `pending` while the settle call was in flight.
            // Only a record the reconciler CREDITED (from proof of execution)
            // funds this task. Anything else — a record a lagging read marked
            // failed while this late answer was on its way — is not money in
            // the account: refuse as unknown, admit nothing, never fund this
            // task from the delegator's other funds. The reconciler's one
            // re-check of that failed record credits it if the chain shows
            // the execution.
            const rec = findX402Settlement(moteDb.db, settlement.payer, settlement.nonce);
            if (rec?.status !== "credited") {
              logger.error("x402.settled_after_record_resolved", {
                correlationId: taskId,
                payer: settlement.payer,
                nonce: settlement.nonce,
                txHash: settlement.txHash,
                status: rec?.status,
                failureReason: rec?.failure_reason,
                idempotencyKey,
              });
              throw new X402OutcomeUnknownError(rec != null ? x402SettlementRef(rec) : undefined);
            }
            logger.info("x402.credited_by_reconciler", {
              correlationId: taskId,
              payer: settlement.payer,
              nonce: settlement.nonce,
            });
          }

          // Attach proof through the x402 rail — sibling parity with Stripe webhook flow.
          const x402Rail = deps.railRegistry?.get("x402");
          if (x402Rail) {
            await x402Rail.attachProof(`x402-${taskId}`, {
              reference: x402TxHash,
              railType: "protocol",
              network: x402Net,
              confirmedAt: Date.now(),
            });
          }
        }

        // Hold funds from the virtual account. SPENDABLE balance only — the
        // delegator's own recent/disputed settlement earnings are under the
        // escrow hold and cannot fund a new delegation (true escrow; closes
        // the collusion drain where a disputed worker delegates held earnings
        // to a confederate before claw-back). Deposited/cleared funds are
        // unaffected (hold = 0 → spendable = balance).
        //
        // ONE definition for the check and the debit, on every funding path
        // (#901): `getSpendableBalance` is exactly what `debitSpendableAccount`
        // enforces. The x402 path used to size the hold from the RAW balance
        // (to avoid netting the escrow hold against the x402 deposit credited
        // just above), while the debit netted it — so `raw ≥ lock > spendable`
        // made the debit return null, that null was ignored, and a `locked`
        // allocation was booked and the task admitted with nothing held. An
        // x402 deposit is itself spendable (a deposit is never under the
        // escrow hold), so reading spendable here nets it only when the
        // account's other funds sit BELOW its hold; then the lock is sized
        // down to what can really be debited, or the task is refused.
        const spendable = getSpendableBalance(moteDb.db, delegatorId);

        // A funding refusal. When THIS request's x402 payment was credited
        // above, the refusal says so — the amount, that it sits in the
        // delegator's account, that it becomes withdrawable once the account's
        // dispute-escrow hold clears — and never invites a second payment.
        // (Reached with a payment only when the account's other funds sit
        // below its escrow hold, so the credited deposit cannot cover the
        // price on its own.)
        const creditedMicro = x402TxHash != null ? x402CreditedMicro : 0;
        const fundingRefusal = (): InsufficientFundsError => {
          if (x402TxHash == null) {
            return new InsufficientFundsError(
              "Insufficient spendable funds — deposit to virtual account or pay via x402",
            );
          }
          return new InsufficientFundsError(
            `Insufficient spendable funds for this task. This request's x402 payment of ` +
              `${creditedMicro} micro-units was credited to account ${delegatorId} and remains ` +
              `there; it is withdrawable once the account's dispute-escrow hold clears. Do not ` +
              `pay again: resubmit when the account's spendable balance covers the price.`,
            {
              creditedPayment: {
                amount_micro: creditedMicro,
                reference: `x402-${taskId}`,
                motebit_id: delegatorId,
              },
            },
          );
        };

        // Use allocateBudget to compute lock amount with risk buffer.
        // An x402-funded task is funded by THIS request's payment and nothing
        // else (#907: funding decided once): its hold is capped at what the
        // request paid, so the 1.2× buffer never draws on the delegator's other
        // funds — in particular never on another request's concurrent x402
        // deposit, which would leave that paying request refused.
        const allocation = allocateBudget(
          {
            goal_id: asGoalId(taskId),
            candidate_motebit_id: asMotebitId(motebitId),
            estimated_cost: priceSnapshot,
            currency: "USDC",
            risk_factor: 1.0, // 1.2× buffer
          },
          x402Payment != null ? Math.min(spendable, x402CreditedMicro) : spendable,
          asAllocationId(`x402-${taskId}`),
        );

        if (!allocation) {
          // Paid agent, spendable balance below the price — 402, on the x402
          // path too. (That path used to book a `locked` allocation with no
          // debit here, as a "best-effort" hold: an unfunded row every payout
          // site trusts.) An x402 payment already credited above stays in
          // the delegator's virtual account, and the refusal says so.
          throw fundingRefusal();
        }
        // Round to integer micro-units (allocateBudget may produce fractional from risk multiplier)
        const amountLocked = Math.round(allocation.amount_locked);
        // Lock the risk-buffered amount — committed by the admission
        // transaction below, atomically with the task it funds.
        fundingWrites = () => {
          // The allocation row, then the hold through the escrow chokepoint
          // (it stamps the debit with the allocation it funds). A refused
          // debit is a funding REFUSAL (#901), raised inside the admission
          // transaction: the allocation row, the queued task and the claim
          // binding below never happen, the transaction rolls back, and the
          // key is freed for a funded retry (a pre-admission refusal,
          // spec/delegation-v1.md §3.3). Never book a hold the ledger did not
          // take.
          openAllocation(moteDb.db, {
            allocationId: `x402-${taskId}`,
            taskId,
            worker: motebitId,
            amountLocked,
            createdAt: now,
          });
          try {
            moveAllocationMoney(moteDb.db, {
              kind: "hold",
              allocationId: `x402-${taskId}`,
              amount: amountLocked, // Uses risk-buffered amount (rounded to micro-unit)
              party: delegatorId,
              description: `Hold for task ${taskId} to ${motebitId}`,
            });
          } catch (err) {
            if (err instanceof AllocationMoneyRefused) throw fundingRefusal();
            throw err;
          }
        };
      } catch (err) {
        // Re-throw intentional errors (RelayError, HTTPException)
        if (err instanceof RelayError || err instanceof HTTPException) throw err;
        // For paid agents, accounting errors must not be silently swallowed —
        // allowing the task through without a budget hold means unpaid work.
        if (requiresPayment) {
          logger.error("task.budget_hold_failed", {
            correlationId: taskId,
            taskId,
            motebitId,
            error: err instanceof Error ? err.message : String(err),
          });
          throw new AllocationError(
            "ALLOCATION_HOLD_FAILED",
            "Budget allocation failed — retry or contact support",
          );
        }
        // Free agent — best-effort allocation, don't block task submission
      }
    }

    // === Admission (#888): the ONE step that makes a task exist ===
    // One transaction: the budget hold (if any), the idempotency claim bound
    // to this task, and the queued task. All commit or none does, so a key
    // never names a task that is not queued, and a queued task is never
    // unnamed by its key. Once committed, the claim is never released
    // (`releaseIdempotency` leaves a bound claim alone), and whatever response
    // this request ends with — the 201, or any error thrown below, including
    // throw points added later — is recorded by the admission-outcome
    // middleware (`recordAdmissionOutcome`), so a same-key replay returns
    // this task's id and never admits a second task.
    moteDb.db.exec("BEGIN");
    try {
      fundingWrites?.();
      bindIdempotencyClaimToTask(moteDb.db, idempotencyKey, motebitId, taskId);
      // One proof admits one task (#918), bound in this same transaction: a
      // proof already bound to another task refuses here and the rollback
      // below undoes the hold, the key binding and the task with it. A
      // submission that concurrently passed the early read above loses here.
      if (p2pPaymentProof != null) {
        const proofBinding = bindP2pProofToTask(
          moteDb.db,
          p2pPaymentProof.tx_hash,
          taskId,
          // The P2P branch runs only with a submitter (`terms.p2p`).
          submittedBy!,
          submitterVerified,
        );
        if (!proofBinding.bound) throw proofAlreadyAdmitted(proofBinding.existing);
      }
      taskQueue.set(taskId, {
        task,
        expiresAt: now + TASK_TTL_MS,
        submitted_by: submittedBy,
        // A federated P2P task's snapshot is the chain budget (A's p2p audit
        // row reads it in onTaskResultReceived).
        price_snapshot: federatedP2pPlan?.budgetMicro ?? priceSnapshot,
        x402_tx_hash: x402TxHash,
        x402_network: x402Net,
        settlement_mode: settlementMode,
        p2p_payment_proof: p2pPaymentProof,
        p2p_admission: p2pAdmission,
        target_agent: body.target_agent,
        grant_id: body.grant_id,
      });
      moteDb.db.exec("COMMIT");
    } catch (admitErr) {
      moteDb.db.exec("ROLLBACK");
      // A funding refusal (the hold's debit found the spendable balance
      // short) is a 402, not an allocation fault: the client funds and
      // retries under the same key, which this rollback left free (#901).
      if (admitErr instanceof InsufficientFundsError) throw admitErr;
      // A proof already bound to another task (#918): a 409 refusal, and the
      // rollback left this key free.
      if (admitErr instanceof P2pProofAlreadyAdmittedError) throw admitErr;
      if (fundingWrites != null) {
        throw new AllocationError("ALLOCATION_HOLD_FAILED", "Allocation hold failed", {
          cause: admitErr,
        });
      }
      throw admitErr;
    }
    const admitted: AdmittedTask = { key: idempotencyKey, motebitId, taskId };
    c.set(ADMITTED_TASK_KEY as never, admitted as never);
    // The routing record (#890 round 6): the path agent is this task's
    // executor from admission — its own devices take the broadcast and its
    // reconnect recovery re-presents the task. Every later hand-off below
    // records its executor BEFORE the hand-off, so a lost answer still
    // leaves the executor on record. Only a recorded executor's receipt,
    // through the recorded peer, may answer the task (every ingestion door).
    recordTaskRoute(moteDb.db, taskId, motebitId);

    logger.info("task.submitted", {
      correlationId: taskId,
      taskId,
      motebitId,
      capabilities: task.required_capabilities ?? [],
      invocationOrigin: task.invocation_origin,
    });

    const requiredCaps = task.required_capabilities ?? [];
    const payload = JSON.stringify({ type: "task_request", task });
    // Task admission artifact — one presenter per admission. Every MCP forward
    // below mints a token bound to the worker it goes to (`mid`) and to this
    // prompt (`digest`). If the relay routes the task itself, the relay is the
    // presenter and the submitter gets NO token; if nothing routes it, the
    // submitter gets a token bound to the intended worker (`target_agent`, else
    // the URL worker) so it can present the task directly. Two presentations
    // of one admission are mutually exclusive at the worker (single-use `sub`).
    const dispatchTokenFor = (workerId: string): Promise<string> =>
      mintTaskDispatchToken(relayIdentity, workerId, taskId, body.prompt);
    // Every relay MCP forward goes through here (fire-and-forget, as on main).
    // Reconnect recovery is not held back while it runs: holding it stranded
    // tasks main completes when the forward failed and the held-back device
    // had left (#811; presentation-matrix.probe.ts). Shared with main: a
    // device that reconnects mid-forward can run the task beside the forward.
    const presentViaMcp = async (endpointUrl: string, workerId: string): Promise<void> => {
      recordTaskRoute(moteDb.db, taskId, workerId);
      const token = await dispatchTokenFor(workerId);
      void forwardTaskViaMcp(
        endpointUrl,
        taskId,
        body.prompt,
        workerId,
        taskQueue,
        logger,
        apiToken,
        async (receiptCandidate: ReceiptCandidate) => {
          const mcpEntry = taskQueue.get(taskId);
          // Gone: nothing to answer (`false`, never `undefined`: absence is
          // never acceptance). Settled or answered is the chokepoint's call
          // (#890 r8): `answerTask` refuses it unless completed outranks
          // failed, and `verified` is true only when the entry took it.
          if (!mcpEntry) return false;
          const ingested = await handleReceiptIngestion(
            receiptCandidate as unknown as ExecutionReceipt,
            taskId,
            mcpEntry.task.motebit_id,
            mcpEntry,
            "mcp_forward",
            resultRetentionMs(mcpEntry),
            ingestionDeps,
          );
          return ingested.verified;
        },
        token,
        outboundPolicy,
        // The relay's own transport credential, fresh per request (#981).
        () => mintRelayMcpBearer(relayIdentity, workerId),
      );
    };
    // `routed` means what it meant on main: a presenter exists — an OPEN
    // socket took the frame, a forward was taken, or the task is HELD for
    // reconnect recovery. Every later door (Phases 2–4, the incidental token)
    // is guarded on it, so a held task takes none of them, as on main.
    let routed = false;
    let federationAttempted = false;
    // A socket send found registered sockets but none OPEN (#811). Main
    // counted that as routed and left the task to reconnect recovery; so does
    // this relay — `mainWouldRecover` in task-presentation.ts, consulted by
    // every dispatch site through `routeToSockets`. A held task is `routed`;
    // this flag only names it in the log.
    let heldForReconnect = false;
    let routingChoice:
      | {
          selected_agent: string;
          composite_score: number;
          sub_scores: Record<string, number>;
          routing_paths: string[][];
          alternatives_considered: number;
          trust_evidence_path?: string[];
        }
      | undefined;

    // Phase 0: Pinned-local paid dispatch — the single-operator sibling of the
    // `federatedP2pIntent` branch below. The delegator already discovered,
    // priced, and PAID this specific local worker onchain (the 2-leg proof was
    // validated above); ranking it against the market again is wrong in both
    // directions — a zero-history pair ranks to composite 0 (task strands with
    // the worker's money settled: the 2026-07-13 staging conformance failure),
    // and a re-ranked winner could route the paid task to an agent the
    // delegator never paid. Dispatch DIRECTLY to the pinned worker: WebSocket
    // when connected, else HTTP MCP via its registered endpoint. No ranking,
    // no federation, no fallback broadcast (Phases 1–4 are skipped via
    // `pinnedLocalHandled` even when dispatch fails — a paid task must never
    // fan out to a worker the delegator did not pay).
    let pinnedLocalHandled = false;
    if (
      !submitterPresenter &&
      settlementMode === "p2p" &&
      body.target_agent != null &&
      !federatedP2pIntent
    ) {
      pinnedLocalHandled = true;
      const pinnedId = body.target_agent;
      routingChoice = {
        selected_agent: pinnedId,
        composite_score: 1,
        sub_scores: { pinned: 1 },
        routing_paths: [[pinnedId]],
        alternatives_considered: 0,
      };
      // The one socket rule (`routeToSockets`, #811 v4): an OPEN socket took
      // it; or registered sockets were all CLOSING/CLOSED, which main counted
      // routed — HELD for reconnect recovery, no MCP forward; or no socket at
      // all, where main forwarded to the MCP endpoint and so does this relay.
      const pinnedRoute = routeToSockets(connections.get(pinnedId), payload);
      if (pinnedRoute !== "no_socket") {
        // Recorded in the same synchronous turn as the hand-off, before any
        // answer can arrive (an MCP forward records inside presentViaMcp).
        recordTaskRoute(moteDb.db, taskId, pinnedId);
        routed = true;
        heldForReconnect = pinnedRoute === "held_for_recovery";
        logger.info("task.p2p_pinned_dispatched", {
          correlationId: taskId,
          worker: pinnedId,
          via: heldForReconnect ? "held_for_reconnect" : "websocket",
        });
      } else {
        const pinnedReg = moteDb.db
          .prepare(
            `SELECT endpoint_url FROM agent_registry WHERE motebit_id = ? AND expires_at > ?${ON_SHELF}`,
          )
          .get(pinnedId, Date.now()) as { endpoint_url: string } | undefined;
        if (pinnedReg?.endpoint_url?.trim()) {
          await presentViaMcp(pinnedReg.endpoint_url, pinnedId);
          routed = true;
          logger.info("task.p2p_pinned_dispatched", {
            correlationId: taskId,
            worker: pinnedId,
            via: "mcp",
            endpoint: pinnedReg.endpoint_url,
          });
        } else {
          // Paid task with no reachable worker transport — leave queued (the
          // worker may reconnect and claim within TTL) but say so LOUDLY:
          // money has settled onchain and nothing is executing.
          logger.error("task.p2p_pinned_unroutable", {
            correlationId: taskId,
            worker: pinnedId,
            reason: "no open WebSocket connection and no registered endpoint_url",
          });
        }
      }
    }

    // Phase 0b: Federated P2P forward — the plan was discovered and validated
    // BEFORE admission (above), so the only step left is the forward itself.
    // Its failure comes after an attempt, and the peer may have accepted, so
    // it is a post-admission outcome recorded under the key.
    if (federatedP2pPlan != null) {
      const { peerEndpoint, peerRelayId, targetId, workerNetMicro, aFeeMicro, bFeeMicro } =
        federatedP2pPlan;
      const proof = p2pPaymentProof!;
      federationAttempted = true;
      routingChoice = {
        selected_agent: targetId,
        composite_score: 1,
        sub_scores: {},
        routing_paths: [],
        alternatives_considered: 0,
      };

      const forwardBody = {
        task_id: taskId,
        origin_relay: relayIdentity.relayMotebitId,
        target_agent: targetId,
        task_payload: {
          prompt: body.prompt,
          required_capabilities: requiredCaps,
          submitted_by: submittedBy,
          wall_clock_ms: body.wall_clock_ms,
        },
        // The proof rides the SIGNED forward body — the executor relay
        // verifies A's signature over canonicalJson(body), so the proof is
        // integrity-protected peer-to-peer (no separate channel).
        payment_proof: proof,
        routing_choice: routingChoice,
        timestamp: Date.now(),
      };
      const forwardBytes = new TextEncoder().encode(canonicalJson(forwardBody));
      const forwardSig = await sign(forwardBytes, relayIdentity.privateKey);
      recordTaskRoute(moteDb.db, taskId, targetId, peerRelayId);
      try {
        const resp = await peerFetch(`${peerEndpoint}/federation/v1/task/forward`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Correlation-ID": taskId },
          body: JSON.stringify({ ...forwardBody, signature: bytesToHex(forwardSig) }),
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          routed = true;
          taskRouter.recordPeerForwardResult(peerEndpoint, true);
          logger.info("task.federated_p2p_forwarded", {
            correlationId: taskId,
            peerRelay: peerEndpoint,
            targetAgent: targetId,
            workerNetMicro,
            aFeeMicro,
            bFeeMicro,
          });
        } else {
          taskRouter.recordPeerForwardResult(peerEndpoint, false);
          // Post-admission: the proof is bound to THIS task (#918) and funds
          // no other — for a refusal too. This used to invite "the same
          // payment_proof under a new Idempotency-Key", which admitted and
          // dispatched a second task on one payment. Releasing the proof on a
          // refusal was tried (#918 round 3) and withdrawn: voiding the task
          // is not a fence (a late receipt still settled it), and the
          // executor contract (relay-federation-v1) does not promise that a
          // refusal means "not enqueued". So a refused forward is a paid
          // failure (docs/doctrine/paid-failure-recourse.md). The key
          // replays this answer (#888), and the body names this task.
          // Wording only (the binding is the same either way): a 4xx is the
          // executor refusing; anything else may mean it holds the task.
          // A 409 whose body says `status: "duplicate"` is NOT a refusal: the
          // executor answers it exactly when it ALREADY HOLDS this task_id
          // (federation.ts forward route) — a retrying proxy or an alternate-
          // route retry reaches it. Its result will still come, so the planned
          // peer stays (#959 round 5).
          let executorHoldsTask = false;
          if (resp.status === 409) {
            try {
              const dupBody = (await resp.clone().json()) as { status?: unknown };
              executorHoldsTask = dupBody.status === "duplicate";
            } catch {
              executorHoldsTask = false;
            }
          }
          const refusedDefinitively = resp.status >= 400 && resp.status < 500 && !executorHoldsTask;
          if (refusedDefinitively) {
            // A definitive refusal: the executor relay does not hold the task,
            // so no result can legitimately arrive from it and the worker leg
            // is nobody's to hand off (#959 round 4). Clearing the planned
            // peer makes the scope 'local' and closes the result door. Any
            // other outcome (5xx, a lost response) keeps it: the executor may
            // hold the task and its result may still arrive.
            const refusedEntry = taskQueue.get(taskId);
            if (refusedEntry?.p2p_admission?.planned_peer != null) {
              refusedEntry.p2p_admission = { worker_leg: "remote" };
              taskQueue.set(taskId, refusedEntry);
            }
          }
          const executorOutcome = refusedDefinitively
            ? `The executor relay refused this task (HTTP ${resp.status}).`
            : `The executor relay failed this task (HTTP ${resp.status}); it may hold the task — poll that task's result.`;
          throw new HTTPException(502, {
            message: `${executorOutcome} This payment is bound to it (task_id in this response) and cannot fund another task; a resubmission of this payment_proof under any Idempotency-Key is refused, and this key replays this answer. Payments on the sovereign rail are not reversed: the recourse for a paid task that never runs is the trust record, not a refund.`,
          });
        }
      } catch (fwdErr) {
        if (fwdErr instanceof HTTPException) throw fwdErr;
        taskRouter.recordPeerForwardResult(peerEndpoint, false);
        logger.warn("task.federated_p2p_forward_failed", {
          correlationId: taskId,
          peerRelay: peerEndpoint,
          targetAgent: targetId,
          error: fwdErr instanceof Error ? fwdErr.message : String(fwdErr),
        });
        // The executor relay may have accepted the forward (a timeout after
        // delivery), so the task's result may still arrive: the retry is to
        // poll this task, never the proof under a new key (#918).
        throw new HTTPException(502, {
          message:
            "Failed to forward the federated P2P task to the executor relay; it may still have been accepted. This payment_proof is bound to this task (task_id in this response): poll that task's result. Resubmitting the proof under any Idempotency-Key is refused, and this key replays this answer.",
        });
      }
    }

    // Phase 1: Scored routing — find best service agents from listings
    if (
      !submitterPresenter &&
      !pinnedLocalHandled &&
      !federatedP2pIntent &&
      requiredCaps.length > 0
    ) {
      try {
        const { profiles, requirements } = taskRouter.buildCandidateProfiles(
          requiredCaps[0],
          undefined,
          20,
          callerMotebitId,
        );
        // Narrow to candidates matching ALL required capabilities (not just the first)
        const multiCapProfiles =
          requiredCaps.length > 1
            ? profiles.filter((p) =>
                requiredCaps.every((cap) => p.listing?.capabilities.includes(cap)),
              )
            : profiles;

        // Filter out excluded agents (failed on previous delegation attempts)
        const excludeSet = new Set(
          Array.isArray(body.exclude_agents)
            ? body.exclude_agents.filter((a): a is string => typeof a === "string")
            : [],
        );
        // Self-exclusion (#459): capability ranking must NEVER select the
        // SUBMITTER as its own worker. The 2026-07-29 amplification loop
        // closed exactly here — web-search sub-delegated a read_url task,
        // the target atom was down, ranking picked the other agent
        // advertising read_url (the submitter itself), and the task
        // round-tripped forever (submit → route-to-self → execute →
        // sub-delegate again). Deliberate self-delegation stays available
        // via explicit target_agent pinning — that path never ranks.
        if (submittedBy) excludeSet.add(submittedBy);
        const eligibleProfiles =
          excludeSet.size > 0
            ? multiCapProfiles.filter((p) => !excludeSet.has(p.motebit_id))
            : multiCapProfiles;

        // Phase 4: Fetch federated candidates from active peer relays (best-effort, non-blocking)
        let federatedCandidates: {
          profile: CandidateProfile;
          _source_relay_endpoint: string;
          _settlement_address: string | null;
          _public_key: string | null;
        }[] = [];
        let peerRelayNodes: Array<{
          peerRelayId: string;
          trust: number;
          latency: number;
          reliability: number;
        }> = [];
        const remoteAgentRelay = new Map<string, string>(); // remote agent motebit_id → peer relay endpoint_url
        const peerEndpointByRelayId = new Map<string, string>(); // peer relay id → endpoint_url (dispatch consumes the planned route)
        try {
          const fedResult = await taskRouter.fetchFederatedCandidates(
            requiredCaps,
            callerMotebitId,
          );
          federatedCandidates = fedResult.candidates;
          // `fedResult.federationEdges` (peer → agent topology) is deliberately
          // not fed to the ranking graph: each remote profile carries
          // `reachable_via`, so `buildRoutingGraph` builds that leg from the
          // agent's OWN execution metrics instead of placeholder weights.
          peerRelayNodes = fedResult.peerRelayNodes;
          for (const fc of federatedCandidates) {
            // Filter out excluded agents from federated results too
            if (!excludeSet.has(fc.profile.motebit_id)) {
              remoteAgentRelay.set(fc.profile.motebit_id, fc._source_relay_endpoint);
              if (fc.profile.reachable_via) {
                peerEndpointByRelayId.set(fc.profile.reachable_via, fc._source_relay_endpoint);
              }
            }
          }
        } catch {
          // Federation candidate fetch is best-effort — don't block local routing
        }

        // Merge local and federated candidates before ranking
        const federatedProfiles = federatedCandidates
          .filter((fc) => !excludeSet.has(fc.profile.motebit_id))
          .map((fc) => fc.profile);
        const allProfiles = [...eligibleProfiles, ...federatedProfiles];

        if (allProfiles.length > 0) {
          // Apply gradient-informed precision to routing weights when provided
          const explorationWeight =
            typeof body.exploration_drive === "number"
              ? Math.max(0, Math.min(1, body.exploration_drive))
              : undefined;
          const peerEdges = taskRouter.fetchPeerEdges();

          // Build selfId → peerRelay edges and merge with peerRelay → agent edges
          // so the semiring graph composes trust multiplicatively along the full path
          const selfId = callerMotebitId ?? motebitId;
          const federationPeerEdges = peerRelayNodes.map((node) => ({
            from: selfId,
            to: node.peerRelayId,
            kind: "traversed" as const, // the forward really goes through the peer
            weight: {
              trust: node.trust,
              cost: 0,
              latency: node.latency,
              reliability: node.reliability,
              regulatory_risk: 0,
            },
          }));
          // Only the traversed self → peer hop is supplied here; the peer →
          // agent leg comes from each remote profile's `reachable_via`.
          // Discovery via a peer never yields a direct self → agent edge.
          const allPeerEdges = [...peerEdges, ...federationPeerEdges];

          // Map routing_strategy to semiring composite function
          const compositeFunction: CompositeFunction | undefined =
            body.routing_strategy === "cost"
              ? lexicographicOver(["costScore", "reliability", "trust"])
              : body.routing_strategy === "quality"
                ? lexicographicComposite
                : body.routing_strategy === "balanced"
                  ? weightedSumComposite
                  : undefined;

          // The caller's guardian for the organizational trust baseline — the
          // one guardian truth (§5a A3), not a registry read of its own.
          const callerGuardian = identityGuardianFor(moteDb.db, callerMotebitId ?? motebitId);

          const ranked = explainedRankCandidates(
            asMotebitId(callerMotebitId ?? motebitId),
            allProfiles,
            {
              ...requirements,
              required_capabilities: requiredCaps,
            },
            {
              maxCandidates: 10,
              explorationWeight,
              peerEdges: allPeerEdges,
              compositeFunction,
              callerGuardianPublicKey: callerGuardian ?? undefined,
            },
          );
          const selected = ranked.filter((r) => r.selected && r.composite > 0);

          if (selected.length > 0) {
            // Capture routing provenance from the top-ranked agent for the response
            const topScore = selected[0]!;
            routingChoice = {
              selected_agent: topScore.motebit_id,
              composite_score: topScore.composite,
              sub_scores: topScore.sub_scores,
              routing_paths: topScore.routing_paths,
              alternatives_considered: topScore.alternatives_considered,
              trust_evidence_path: topScore.trust_evidence_path,
            };

            // A task forwards to at most ONE federated relay: fanning one task
            // out to multiple relays means multiple workers execute it. Local
            // fan-out below is unaffected.
            let federatedForwarded = false;

            // Route to selected agents — local via WebSocket, remote via federation forward
            for (const sel of selected) {
              const selId = sel.motebit_id;
              if (remoteAgentRelay.has(selId)) {
                // Remote agent: forward task to the peer relay the PLANNED
                // ROUTE names. Selection and transport must agree — choosing
                // a worker and then picking a peer independently would let
                // the recorded route and the real forward diverge.
                if (federatedForwarded) continue;
                const plannedRoute = sel.routing_paths[0] ?? [];
                const plannedPeer = plannedRoute.length >= 2 ? plannedRoute[0] : undefined;
                const peerEndpoint =
                  plannedPeer != null ? peerEndpointByRelayId.get(plannedPeer) : undefined;
                if (peerEndpoint == null || plannedRoute[plannedRoute.length - 1] !== selId) {
                  // Loud, not silent: the ranking produced a route the dispatcher
                  // cannot take. Skip rather than forward on a different path.
                  logger.warn("task.forward_route_mismatch", {
                    taskId,
                    agent: selId,
                    plannedRoute,
                    knownPeers: [...peerEndpointByRelayId.keys()],
                  });
                  continue;
                }

                // Circuit breaker: skip forwarding if the peer's circuit is open
                if (!taskRouter.canForward(peerEndpoint)) {
                  logger.info("task.forward_circuit_open", {
                    correlationId: taskId,
                    peerRelay: peerEndpoint,
                    targetAgent: selId,
                  });
                  continue;
                }

                federationAttempted = true;
                federatedForwarded = true;

                // PAID federated delegation now requires a 3-leg P2P proof
                // (delegator pays worker + both operator treasuries onchain in
                // one atomic tx; the relay never custodies cross-operator
                // funds). That path is the dedicated `federatedP2pIntent` branch
                // above — it forwards directly to the pinned worker. Reaching
                // THIS ranking-path branch with a priced federated candidate
                // means the submitter did not supply target_agent + payment_proof
                // → reject. This REPLACES PR1's relay-custody hold; the migration
                // window is closed in the same change (no free-forward gap, no
                // relay-custody charge). FREE federated tasks (no price) still
                // forward here without proof or charge.
                const fedProfile = federatedCandidates.find(
                  (fc) => fc.profile.motebit_id === selId,
                )?.profile;
                const fedPrice = fedProfile?.listing?.pricing.find((p) =>
                  (requiredCaps as readonly string[]).includes(p.capability),
                );
                if (fedPrice != null && fedPrice.unit_cost > 0) {
                  // The routing catch rethrows HTTPException (see "Re-throw
                  // intentional HTTP errors" below) → surfaces as 402.
                  throw new HTTPException(402, {
                    message:
                      "Paid federated delegation requires a 3-leg P2P payment_proof (submit with target_agent + payment_proof). Deposit-funded cross-operator settlement is closed. See off-ramp-as-user-action.md.",
                  });
                }

                try {
                  const forwardBody = {
                    task_id: taskId,
                    origin_relay: relayIdentity.relayMotebitId,
                    target_agent: selId,
                    task_payload: {
                      prompt: body.prompt,
                      required_capabilities: requiredCaps,
                      submitted_by: submittedBy,
                      wall_clock_ms: body.wall_clock_ms,
                    },
                    routing_choice: routingChoice,
                    timestamp: Date.now(),
                  };
                  const forwardBytes = new TextEncoder().encode(canonicalJson(forwardBody));
                  const forwardSig = await sign(forwardBytes, relayIdentity.privateKey);
                  recordTaskRoute(moteDb.db, taskId, selId, plannedPeer);

                  const resp = await peerFetch(`${peerEndpoint}/federation/v1/task/forward`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "X-Correlation-ID": taskId },
                    body: JSON.stringify({
                      ...forwardBody,
                      signature: bytesToHex(forwardSig),
                    }),
                    signal: AbortSignal.timeout(10000),
                  });

                  if (resp.ok) {
                    routed = true;
                    taskRouter.recordPeerForwardResult(peerEndpoint, true);
                    logger.info("task.forwarded", {
                      correlationId: taskId,
                      peerRelay: peerEndpoint,
                      targetAgent: selId,
                    });
                  } else {
                    taskRouter.recordPeerForwardResult(peerEndpoint, false);
                    // Loud, not silent: this rejection sets `federationAttempted`,
                    // which suppresses every local fallback phase — an unlogged
                    // branch here strands the task with zero forensic trail
                    // (masked the 2026-07-13 staging conformance failure).
                    logger.warn("task.forward_rejected", {
                      correlationId: taskId,
                      peerRelay: peerEndpoint,
                      targetAgent: selId,
                      status: resp.status,
                    });
                  }
                } catch (fwdErr) {
                  taskRouter.recordPeerForwardResult(peerEndpoint, false);
                  logger.warn("task.forward_failed", {
                    correlationId: taskId,
                    peerRelay: peerEndpoint,
                    targetAgent: selId,
                    error: fwdErr instanceof Error ? fwdErr.message : String(fwdErr),
                  });
                }
              } else {
                // Local agent: route via WebSocket first, HTTP MCP fallback.
                // The one socket rule (`routeToSockets`, #811 v4): a worker
                // whose registered sockets are all CLOSING/CLOSED is HELD for
                // reconnect recovery, as main held it — never forwarded (the
                // #854 cell: the forward ran the task, its answer was lost,
                // and recovery ran it again). Only a worker with no socket at
                // all takes the MCP fallback, as on main.
                const localRoute = routeToSockets(connections.get(selId), payload);
                if (localRoute !== "no_socket") {
                  // Same synchronous turn as the hand-off (MCP: presentViaMcp).
                  recordTaskRoute(moteDb.db, taskId, selId);
                  routed = true;
                  if (localRoute === "held_for_recovery") heldForReconnect = true;
                } else {
                  // No open WebSocket — try HTTP MCP forwarding via registered endpoint_url
                  const regRow = moteDb.db
                    .prepare(
                      `SELECT endpoint_url FROM agent_registry WHERE motebit_id = ? AND expires_at > ?${ON_SHELF}`,
                    )
                    .get(selId, Date.now()) as { endpoint_url: string } | undefined;
                  if (regRow?.endpoint_url?.trim()) {
                    await presentViaMcp(regRow.endpoint_url, selId);
                    routed = true;
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        // Re-throw intentional HTTP errors (e.g. 402 insufficient budget)
        if (err instanceof HTTPException) throw err;
        // Scoring failed — fall through to broadcast
      }
    }

    // Phase 2: Broadcast fallback — original behavior.
    // Skip if a federation forward was attempted (even if it timed out) — the peer relay
    // may have accepted the task, and broadcasting locally would cause double-execution.
    // Also skip for pinned-local paid tasks (Phase 0): fan-out could execute the
    // paid task on a worker the delegator never paid.
    if (!submitterPresenter && !pinnedLocalHandled && !routed && !federationAttempted) {
      // The one socket rule (`routeToSockets`, #811 v4), over the sockets
      // main broadcast to (the capability-eligible ones). A broadcast that
      // reached only CLOSING/CLOSED sockets is HELD for reconnect: main counted
      // it routed and took no Phase 3 forward, no push wake and no token, and
      // the agent's reconnect recovery delivered the task. It still does.
      const eligible = (peer: ConnectedDevice): boolean =>
        requiredCaps.length > 0 && peer.capabilities
          ? requiredCaps.every((c) => peer.capabilities!.includes(c))
          : true;
      const broadcastRoute = routeToSockets(connections.get(motebitId), payload, eligible);
      if (broadcastRoute !== "no_socket") {
        routed = true;
        if (broadcastRoute === "held_for_recovery") heldForReconnect = true;
      }
    }

    // Phase 3: HTTP MCP fallback — when no WebSocket routed the task,
    // find a registered agent with matching capabilities and forward via HTTP.
    // Not when the task is held for reconnect (it is `routed`): main never
    // took this forward there, and recovery is that task's presenter (#811).
    if (
      !submitterPresenter &&
      !pinnedLocalHandled &&
      !routed &&
      !federationAttempted &&
      requiredCaps.length > 0
    ) {
      const now = Date.now();
      const capFilter = requiredCaps[0]!;
      // Self-exclusion (#459): same rule as the scored path — the fallback
      // must never route a task back to its own submitter (the second half
      // of the 2026-07-29 routing cycle). Pinned self-delegation never
      // reaches this query.
      const httpCandidate = moteDb.db
        .prepare(
          `SELECT r.motebit_id, r.endpoint_url FROM agent_registry r
           WHERE r.expires_at > ? AND r.endpoint_url != '' AND r.${ON_SHELF_PREDICATE}
             AND r.motebit_id != ?
             AND EXISTS (SELECT 1 FROM json_each(r.capabilities) WHERE value = ?)
           LIMIT 1`,
        )
        .get(now, submittedBy ?? "", capFilter) as
        { motebit_id: string; endpoint_url: string } | undefined;
      if (httpCandidate?.endpoint_url?.trim()) {
        await presentViaMcp(httpCandidate.endpoint_url, httpCandidate.motebit_id);
        routed = true;
      }
    }

    // Phase 4: Push wake — when no WebSocket, no HTTP MCP, and no federation routed the task,
    // attempt to wake a mobile device via push notification. Fire-and-forget — the task stays
    // in queue regardless. The device will reconnect via WebSocket and claim the task.
    if (
      !submitterPresenter &&
      !pinnedLocalHandled &&
      !routed &&
      !federationAttempted &&
      pushAdapter
    ) {
      void attemptPushWake(motebitId, { pushAdapter, db: moteDb.db });
    }

    // The submitter becomes the presenter only when the relay did not route
    // the task anywhere (no WebSocket, no MCP endpoint, no federation). A
    // routed task's token travelled with the forward; handing the submitter a
    // second one would race the relay's own dispatch at the worker.
    const submitterPresents = !routed && !federationAttempted;
    if (heldForReconnect) {
      logger.info("task.held_for_reconnect", { correlationId: taskId, motebitId });
    }
    if (submitterPresenter) {
      // Chosen, not incidental: the submitter asked to present. Nothing above
      // routed (every phase is guarded), so the token below is the ONLY one.
      // Reconnect recovery still hands the task to a worker socket that
      // registers, as on main: withholding it strands the task whenever the
      // submitter never presents (#811; presentation-matrix.probe.ts).
      logger.info("task.submitter_presents", {
        correlationId: taskId,
        worker: terms.routedTo,
        submitted_by: submittedBy ?? null,
      });
    }
    // The worker the dispatch token binds is the one the task was priced and
    // routed for — `terms.routedTo`, never a re-read of `body.target_agent`
    // (#901 round 3): one reading of the submission decides price, route and
    // admission binding, so they cannot diverge.
    const intendedWorker = terms.routedTo;
    if (submitterPresents) recordTaskRoute(moteDb.db, taskId, intendedWorker);
    const responseBody = {
      task_id: taskId,
      status: task.status,
      routing_choice: routingChoice ?? null,
      ...(submitterPresents ? { dispatch_token: await dispatchTokenFor(intendedWorker) } : {}),
    };
    completeIdempotency(moteDb.db, idempotencyKey, motebitId, 201, JSON.stringify(responseBody));
    return c.json(responseBody, 201);
  });

  // --- GET /agent/:motebitId/task/:taskId — poll task status ---
  /** @spec motebit/delegation@1.0 */
  app.get("/agent/:motebitId/task/:taskId", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const taskId = c.req.param("taskId");

    // Device auth: require signed token or master token
    const authHeader = c.req.header("authorization");
    if (authHeader == null || !authHeader.startsWith("Bearer ")) {
      throw new AuthenticationError("AUTH_MISSING_TOKEN", "Authorization required");
    }
    const token = authHeader.slice(7);
    let callerMotebitId: string | undefined;
    if (secretEquals(token, apiToken)) {
      // Master token bypass — caller identity unknown but trusted
    } else if (enableDeviceAuth && token.includes(".")) {
      // Verify device token against the CALLER's identity (from token claims),
      // not the target agent's motebitId from the URL. The submitter polls for
      // tasks they submitted to another agent — their token carries their own mid.
      const claims = parseTokenPayloadUnsafe(token);
      if (!claims?.mid) {
        throw new AuthenticationError("AUTH_INVALID_TOKEN", "Invalid token");
      }
      // Expiry gets its own honest error BEFORE the boolean verify collapses
      // every failure into "device not authorized" (#424): a long-running task
      // outlives the 5-minute token TTL, and the client's correct remedy is
      // re-mint — not device re-registration. Reading exp from the unverified
      // payload is safe here: it only selects the error message, never grants.
      if (typeof claims.exp === "number" && claims.exp < Date.now()) {
        throw new AuthenticationError(
          "AUTH_TOKEN_EXPIRED",
          "Token expired — mint a fresh task:query token and retry",
        );
      }
      const verified = await verifySignedTokenForDevice(
        token,
        claims.mid,
        identityManager,
        "task:query",
        isTokenBlacklisted,
        isAgentRevoked,
      );
      if (!verified) {
        throw new AuthorizationError("AUTHZ_DEVICE_NOT_AUTHORIZED", "Device not authorized");
      }
      callerMotebitId = claims.mid;
    } else {
      throw new AuthorizationError("AUTHZ_INVALID_CREDENTIALS", "Invalid authorization");
    }

    const entry = taskQueue.get(taskId);

    if (!entry) {
      // Gone from the queue. If one of THIS agent's own Idempotency-Keys
      // admitted the task and that key is still live, answer from the
      // receipt archive (#890 r4): the delegator can be replayed this task
      // id for 24 h and must be able to learn how it ended. A caller asking
      // for another agent's path learns nothing.
      if (callerMotebitId == null || callerMotebitId === motebitId) {
        const archived = getArchivedReceiptForKeyOwner(
          moteDb.db,
          motebitId,
          taskId,
          Date.now() - IDEMPOTENCY_TTL_MS,
        );
        if (archived != null) {
          const receipt = JSON.parse(archived) as ExecutionReceipt;
          return c.json({
            task: { task_id: taskId, motebit_id: motebitId, status: receipt.status },
            receipt,
          });
        }
      }
      throw new TaskError(
        "TASK_NOT_FOUND",
        `Task not found — it may have expired (TTL ${Math.round(TASK_TTL_MS / 60_000)}min; paid results retained ${Math.round(PAID_TASK_RESULT_RETENTION_MS / 60_000)}min) or the task_id is invalid`,
        404,
      );
    }
    if (entry.task.motebit_id !== motebitId) {
      throw new TaskError(
        "TASK_NOT_FOUND",
        "Task not found — motebit_id in URL does not match the task's target agent",
        404,
      );
    }

    // Authorization: caller must be the submitter or the target agent
    if (callerMotebitId) {
      const submitter = entry.submitted_by ?? entry.task.submitted_by;
      if (callerMotebitId !== motebitId && callerMotebitId !== submitter) {
        throw new AuthorizationError(
          "AUTHZ_NOT_TASK_PARTICIPANT",
          "Not authorized to poll this task — caller is neither the submitter nor the target agent",
        );
      }
    }

    return c.json({ task: entry.task, receipt: entry.receipt ?? null });
  });

  // --- POST /agent/:motebitId/task/:taskId/result — device posts signed receipt ---
  /** @spec motebit/delegation@1.0 */
  app.post("/agent/:motebitId/task/:taskId/result", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const taskId = c.req.param("taskId");

    // Device auth: require signed token or master token
    const authHeader = c.req.header("authorization");
    if (authHeader == null || !authHeader.startsWith("Bearer ")) {
      throw new AuthenticationError("AUTH_MISSING_TOKEN", "Authorization required");
    }
    const token = authHeader.slice(7);
    if (!secretEquals(token, apiToken)) {
      // Verify as device signed token
      if (enableDeviceAuth && token.includes(".")) {
        // Same expiry-before-verify honesty as the task:query poll route (#424).
        const resultClaims = parseTokenPayloadUnsafe(token);
        if (typeof resultClaims?.exp === "number" && resultClaims.exp < Date.now()) {
          throw new AuthenticationError(
            "AUTH_TOKEN_EXPIRED",
            "Token expired — mint a fresh task:result token and retry",
          );
        }
        const verified = await verifySignedTokenForDevice(
          token,
          motebitId,
          identityManager,
          "task:result",
          isTokenBlacklisted,
          isAgentRevoked,
        );
        if (!verified) {
          throw new AuthorizationError("AUTHZ_DEVICE_NOT_AUTHORIZED", "Device not authorized");
        }
      } else {
        throw new AuthorizationError("AUTHZ_INVALID_CREDENTIALS", "Invalid authorization");
      }
    }

    const entry = taskQueue.get(taskId);
    if (!entry) {
      throw new TaskError(
        "TASK_NOT_FOUND",
        `Task not found — it may have expired (TTL ${Math.round(TASK_TTL_MS / 60_000)}min; paid results retained ${Math.round(PAID_TASK_RESULT_RETENTION_MS / 60_000)}min) or the task_id is invalid`,
        404,
      );
    }
    if (entry.task.motebit_id !== motebitId) {
      throw new TaskError(
        "TASK_NOT_FOUND",
        "Task not found — motebit_id in URL does not match the task's target agent",
        404,
      );
    }

    const rawBody: unknown = await c.req.json().catch(() => null);
    const parsedReceipt = ExecutionReceiptSchema.safeParse(rawBody);
    if (!parsedReceipt.success) {
      return c.json({ error: parsedReceipt.error.flatten() }, 400);
    }
    const receipt = parsedReceipt.data as unknown as ExecutionReceipt;

    // Reject stale receipts — completed_at must be within 1 hour of submitted_at
    if (receipt.completed_at && entry.task.submitted_at) {
      const elapsed = receipt.completed_at - entry.task.submitted_at;
      if (elapsed > 3_600_000 || elapsed < -60_000) {
        // 1 hour max, 1 min clock skew tolerance
        throw new TaskError(
          "TASK_INVALID_INPUT",
          `Receipt timestamp outside acceptable window (elapsed=${Math.round(elapsed / 1000)}s, allowed=-60s to +3600s) — check agent clock synchronization`,
          400,
        );
      }
    }

    // Task-receipt binding (dual invariant):
    // 1. Primary: relay_task_id — cryptographic binding to the economic identity of the task.
    // 2. Secondary: prompt_hash — semantic binding to the task content.
    const receiptRelayTaskId = (receipt as unknown as Record<string, unknown>).relay_task_id;
    if (typeof receiptRelayTaskId === "string" && receiptRelayTaskId !== "") {
      if (receiptRelayTaskId !== taskId) {
        throw new TaskError(
          "TASK_INVALID_INPUT",
          `Receipt relay_task_id "${receiptRelayTaskId}" does not match task "${taskId}" — receipt is bound to a different economic contract`,
          400,
        );
      }
    } else {
      // No relay_task_id — reject. This field is required for cryptographic binding.
      logger.error("receipt.missing_relay_task_id", {
        correlationId: taskId,
        reason: "receipt does not include relay_task_id — required for economic binding",
        motebitId: receipt.motebit_id,
      });
      throw new TaskError(
        "TASK_INVALID_INPUT",
        "Receipt missing relay_task_id — cryptographic task binding is required. Ensure your motebit runtime is up to date.",
        400,
      );
    }

    // A P2P task was paid to ONE worker (#959): a receipt signed by anyone
    // else is refused BEFORE it touches the entry, so it can never overwrite
    // the result the paid worker delivered. (Ingestion refuses it too.)
    if (entry.settlement_mode === "p2p" && !receiptDischargesP2p(entry, receipt.motebit_id)) {
      logger.error("settlement.p2p_receipt_not_from_payee", {
        correlationId: taskId,
        payee: p2pPayeeOf(entry),
        signer: receipt.motebit_id,
      });
      throw new AuthorizationError(
        "AUTHZ_INVALID_CREDENTIALS",
        `Receipt verification failed: receipt is signed by ${receipt.motebit_id}, not by the worker this P2P task was paid to`,
      );
    }

    // Unified receipt ingestion: the answer chokepoint (`answerTask`, #890
    // r8 — binding, routed executor, signature, write-once) → settlement →
    // trust → credentials. The entry takes the receipt only inside
    // `answerTask`; this door reports acceptance only when it took it.
    const ingestionResult = await handleReceiptIngestion(
      receipt,
      taskId,
      motebitId,
      entry,
      "result_post",
      resultRetentionMs(entry),
      ingestionDeps,
    );
    if (!ingestionResult.verified) {
      if (ingestionResult.refusal === "answered") {
        // A settled answer is frozen (#890 round 9): the 409 carries it, so
        // the sender learns the task's answer instead of guessing.
        logger.warn("task.result_already_answered", {
          correlationId: taskId,
          signer: receipt.motebit_id,
        });
        return c.json(
          {
            error: `Receipt not accepted: ${ingestionResult.reason}`,
            code: "TASK_ALREADY_ANSWERED",
            status: 409,
            receipt: ingestionResult.answer ?? null,
          },
          409,
        );
      }
      if (ingestionResult.refusal === "gone") {
        throw new TaskError("TASK_NOT_FOUND", `Task not found — ${ingestionResult.reason}`, 404);
      }
      throw new AuthorizationError(
        "AUTHZ_INVALID_CREDENTIALS",
        `Receipt verification failed: ${ingestionResult.reason}`,
      );
    }

    if (ingestionResult.already_settled) {
      return c.json({ status: "already_settled" });
    }
    const answered = taskQueue.get(taskId);
    return c.json({
      status: answered?.task.status ?? receipt.status,
      credential_id: ingestionResult.credential_id,
    });
  });

  return { replayLocalAnswer };
}
