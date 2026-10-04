/**
 * Relay delegation — submit-and-poll core for relay-mediated tasks.
 *
 * Extracted from `interactive-delegation.ts` so both the AI-loop path
 * (`delegate_to_agent` tool handler) and the deterministic path
 * (`MotebitRuntime.invokeCapability`) share one implementation. Divergence
 * between the two paths was the drift risk that motivated the extraction.
 *
 * Returns a discriminated result: on success, the verified `ExecutionReceipt`
 * the relay delivered; on failure, a structured `DelegationError` with a
 * closed error-code union the UI layer can switch on without pattern-matching
 * on strings. No fall-through to alternate paths — honest degradation is the
 * contract (see `docs/doctrine/surface-determinism.md`).
 */

import type { ExecutionReceipt, IntentOrigin } from "@motebit/sdk";
import type { TokenAudience } from "@motebit/protocol";
import type { P2pPaymentProof, RelayMetadata, SovereignP2pPaymentRequest } from "@motebit/protocol";
import {
  base58Encode,
  hexToBytes32,
  toMicro,
  computeP2pFeeMicro,
  computeFederatedFeeSplit,
  PLATFORM_FEE_RATE,
} from "@motebit/protocol";
import { verifyRelayFeeRate, verifySovereignBinding } from "@motebit/crypto";
import {
  type PaidIntentLedger,
  isPaymentWithoutTaskId,
  paymentEntryId,
} from "./paid-intent-ledger.js";

/**
 * The DERIVED settlement-authority binding, inlined here to keep the
 * rail-agnostic runtime from depending on `@motebit/wallet-solana` (Solana
 * coupling): a Solana address IS `base58Encode` of the 32-byte Ed25519 key, so
 * `address === base58Encode(key)` proves the key authorizes the payout offline.
 * Mirrors `isDerivedSettlementBinding` in `@motebit/wallet-solana` (both use the
 * one `@motebit/protocol` base58 codec). Fail-closed on a malformed key.
 * docs/doctrine/settlement-authority-binding.md.
 */
function isDerivedSolanaSettlement(settlementAddress: string, publicKeyHex: string): boolean {
  const bytes = hexToBytes32(publicKeyHex);
  return bytes != null && settlementAddress === base58Encode(bytes);
}

/**
 * Closed-union error codes for relay delegation failures. The UI maps each to
 * a distinct user-visible message; the runtime never hides a failure behind a
 * retry or a fall-back invocation.
 */
export type DelegationErrorCode =
  /**
   * Pre-flight. The runtime was never paired with a relay in this session —
   * `enableInvokeCapability()` has not been called, so the deterministic
   * path has no relay coordinates or auth-token minter. Surfaced via an
   * `invoke_error` chunk (not a throw) so the UI can show a user-facing
   * remediation instead of leaking developer-wiring language.
   */
  | "sync_not_enabled"
  /** Pre-flight. `fetch` rejected — DNS, TLS, offline. Relay unreachable. */
  | "network_unreachable"
  /** Pre-flight. HTTP 401. Relay rejected the device token's signature. */
  | "auth_expired"
  /** Pre-flight. HTTP 403. Caller not authorized to invoke this capability. */
  | "unauthorized"
  /** Pre-flight. HTTP 429. Retry after the indicated interval. */
  | "rate_limited"
  /** Pre-flight. Relay returned HTTP 402 / INSUFFICIENT_FUNDS. */
  | "insufficient_balance"
  /**
   * Pre-flight. HTTP 402 / `TASK_P2P_PROOF_REQUIRED` — the Arc 3.5 gate. Paid
   * direct delegation to a different worker must settle P2P: the submission
   * needs a `payment_proof` (the delegator's atomic onchain worker + fee tx),
   * which this client did not supply. Distinct from `insufficient_balance`
   * (there are funds; the relay simply does not custody this flow). See
   * `docs/doctrine/off-ramp-as-user-action.md` § "Arc 3.5".
   */
  | "payment_proof_required"
  /**
   * Pre-flight. Paid P2P delegation was requested but no sovereign wallet rail
   * is configured (or the rail cannot build an atomic multi-leg payment), so
   * the client cannot produce the proof the relay requires. Honest: "fund/enable
   * a sovereign wallet for direct paid delegation."
   */
  | "no_sovereign_rail"
  /**
   * Pre-broadcast. The resolved payment total (worker leg + all fee legs)
   * exceeds the caller's `maxTotalMicro` ceiling. Nothing was broadcast and
   * nothing was submitted — the budget is enforced BEFORE money moves.
   */
  | "budget_exceeded"
  /**
   * Pre-flight. A worker was discovered but cannot be paid directly — it has no
   * service listing, no positive price, or no settlement address. Distinct from
   * `no_routing` (no worker at all) and `insufficient_balance` (the delegator's
   * shortfall).
   */
  | "worker_not_payable"
  /**
   * Pre-flight, BEFORE broadcast. The relay's listing read reported the
   * delegator↔worker pair is not P2P-eligible (cold-start without the
   * acknowledgment, or an active dispute) — so the client did NOT broadcast the
   * payment. Distinct from a post-broadcast rejection: no funds moved. In the
   * `selectAndRunDelegation` fallback set, so the delegation degrades to the
   * relay-mediated path rather than losing funds to a doomed P2P submission.
   */
  | "p2p_ineligible"
  /**
   * Pre-flight. The delegator's atomic onchain payment failed to broadcast,
   * and the funds did NOT move — established, not assumed (#885): either the
   * builder failed before signing, or the wallet's read-only lookup found no
   * matching transaction after every blockhash the build could have used
   * expired. NO task was submitted. A later hire may pay.
   */
  | "payment_broadcast_failed"
  /**
   * Post-signing (#885). The payment builder threw, and the chain could
   * neither confirm nor rule out that THIS hire's own transaction landed
   * (RPC error, a wallet that cannot read a transaction's status, or still
   * in flight past the wait). Money MAY have left the wallet. Nothing was submitted,
   * nothing is broadcast again automatically, and the payment is recorded
   * in the paid-intent ledger (`unconfirmedPayment.ledgerId`) so a re-hire
   * of this worker + capability is refused until the owner reconciles the
   * wallet and dismisses the entry.
   */
  | "payment_status_unknown"
  /**
   * Post-payment (#885). The payment LANDED (tx in `settledPayment`), and
   * the relay REJECTED the task outright (a definitive 4xx such as a proof
   * the relay refuses). No second payment was made. `settledPayment.taskId`
   * is the ledger's `p2p-payment:` id, not a relay task. The payment stays
   * outstanding in the ledger, so a re-hire of this worker + capability is
   * refused — in this session and every later one — until the owner
   * resolves it.
   */
  | "payment_not_admitted"
  /**
   * Post-payment (#885). The payment LANDED, and the relay's admission of
   * the task is UNCONFIRMED: every submission of that same proof ended in
   * a network failure, a 5xx (including 503 `TASK_P2P_PROOF_UNVERIFIED`,
   * the relay unable to read the payer from the chain yet), a 409 (the
   * relay still processing the same payment; `TASK_P2P_PROOF_REPLAYED` —
   * this proof already settled a task; or `TASK_P2P_PROOF_ALREADY_ADMITTED`
   * WITHOUT a `task_id` — the proof funds a task the relay will not name to
   * this caller), or another answer that does not say the task was refused.
   * A `TASK_P2P_PROOF_ALREADY_ADMITTED` that DOES carry a `task_id` never
   * ends here: the relay names the task only to its verified submitter, so
   * the client hands over to that task (records it, polls its result).
   * The relay may have admitted it — the answer never reached this device.
   * Same money facts and same ledger lock as `payment_not_admitted`; the
   * difference is only what can honestly be said about the task.
   */
  | "payment_admission_unconfirmed"
  /**
   * Pre-flight, BEFORE broadcast. The grant blast-radius meter refused the
   * spend against the verified standing grant's signed ceiling (over-ceiling,
   * nonce replay, or an unmeterable action) — the metered builder threw a
   * `MoneyMeterDeniedError` before any funds moved. The specific
   * `BlastRadiusDenial` code rides in `DelegationError.denial`. Distinct from
   * `payment_broadcast_failed` (the broadcast itself failing): the meter
   * deliberately blocked an authorized-but-out-of-bounds spend. Only reachable
   * on the metered deterministic path (`executeGrantedDelegation`) or a
   * grant-carrying loop turn; a raw-builder path (human-tap `invokeCapability`)
   * has no meter and cannot produce this.
   */
  | "money_meter_denied"
  /**
   * Pre-flight, BEFORE broadcast. The session's paid-intent ledger holds a
   * SETTLED-but-unretrieved payment that this new delegation would duplicate
   * (same worker + capability, or too many outstanding payments session-wide).
   * NO new money moved — the refusal happened before the payment was built.
   * The prior payment's facts ride in `settledPayment`; the remedy is
   * re-fetching that `taskId` (or restarting the session after review),
   * never re-hiring. The mechanical half of the #433 fix: #434 told the
   * model money moved; this refuses the broadcast even if the model
   * misreads it (docs/doctrine/memory-never-confers-authority.md posture —
   * money safety must not end at model compliance).
   */
  | "intent_already_paid"
  /** Pre-flight. Trust below the capability's threshold. */
  | "trust_threshold_unmet"
  /** Pre-flight. No agent advertises the capability. */
  | "no_routing"
  /**
   * Pre-flight, BEFORE broadcast. A FEDERATED (peer-hosted) worker's discovered
   * settlement address is not cryptographically bound to the worker's identity
   * — a malicious peer could be redirecting the worker's payments. The client
   * refuses to broadcast rather than pay a peer-asserted address it cannot
   * verify. No funds move. docs/doctrine/settlement-authority-binding.md.
   */
  | "worker_settlement_unbound"
  /**
   * Pre-flight, BEFORE broadcast. A relay's platform fee rate — an input to the
   * irreversible payment — could not be taken from discovery metadata signed by
   * the key this client trusts for that relay (the PINNED key for the origin;
   * the peer key the pinned origin vouches for, for a federated executor): the
   * metadata was unreachable, signed by another key, or declared a `fee_rate`
   * that is not a number in [0, 1). No funds move. spec/discovery-v1.md §3.2.
   */
  | "relay_fee_rate_unverified"
  /** Pre-flight. HTTP 400 — malformed submission. Code bug, surface loudly. */
  | "malformed_request"
  /** In-flight. Polling exceeded `timeoutMs` without a receipt. */
  | "timeout"
  /** In-flight. Relay reported the agent failed mid-task. */
  | "agent_failed"
  /**
   * In-flight (one task, one body). The relay GRANTED the task to an
   * executor and that executor was lost, or never answered (`undetermined`
   * on the task read, reason in `relayVerdict`). The work MAY have run, may
   * still be running, or never started — the relay itself does not know,
   * and never hands the task to anyone else. Not a failure and not a
   * timeout: the caller must NOT hire again for this work (a second paid
   * hire for the same intent); the executor's late signed result still
   * resolves the task, so re-read `relayVerdict.taskId` later.
   */
  | "undetermined"
  /**
   * In-flight (one task, one body). The task outlived its TTL with nothing
   * ever granted it (`expired` on the task read, reason `never_claimed`):
   * no executor took it, so it did NOT run and never will. Conclusive.
   */
  | "task_expired"
  /** Result-time. Receipt body missing required fields. */
  | "malformed_receipt"
  /** Unclassified. Used when the relay returns an unexpected shape. */
  | "unknown";

export interface DelegationError {
  code: DelegationErrorCode;
  /** Human-readable detail. Not user-facing verbatim — the UI renders its own copy per code. */
  message: string;
  /** Seconds to wait before retrying (set on `rate_limited` when the relay provides `Retry-After`). */
  retryAfterSeconds?: number;
  /** HTTP status code when applicable. */
  status?: number;
  /**
   * The blast-radius meter's specific `BlastRadiusDenial` code, set ONLY on
   * `code: "money_meter_denied"`. The denial *code* is the whole owner-safe
   * residual — the `spend_overage_micro` quantity is an owner-facing oracle
   * (`grant-blast-radius.ts`) and is deliberately NOT carried here, so this
   * field is safe to relay in a signed refusal receipt.
   */
  denial?: string;
  /**
   * Set ONLY when the delegator's onchain payment ALREADY SETTLED but the
   * result could not be retrieved (poll timeout, transient relay 5xx, task
   * record reaped). The hire happened and the money is gone; only delivery
   * failed.
   *
   * Load-bearing for money safety (#433): without this, a post-broadcast
   * poll failure is indistinguishable from a never-hired failure
   * (`worker_not_payable`, `p2p_ineligible`), so an autonomous caller reads
   * "it failed" and RE-DELEGATES — broadcasting a SECOND payment for work
   * already bought. A caller seeing this field MUST resolve by re-fetching
   * this `taskId`, never by re-hiring.
   *
   * Also set on `payment_not_admitted` / `payment_admission_unconfirmed`
   * (#885): the payment landed and no relay task is confirmed for it.
   * `taskId` is then the paid-intent ledger's `p2p-payment:<tx>` id — not
   * a relay task.
   */
  settledPayment?: {
    txHash: string;
    paidMicro: number;
    feeMicro: number;
    /** The relay task the payment bought — the handle to re-fetch, never re-pay. */
    taskId: string;
  };
  /**
   * Set ONLY on `payment_status_unknown` (#885): the builder threw and the
   * chain could not say whether the payment landed. The amounts are what
   * the payment would have moved; `ledgerId` is the paid-intent ledger
   * entry that now refuses a re-hire until the owner reconciles it.
   */
  unconfirmedPayment?: {
    paidMicro: number;
    feeMicro: number;
    /** Absent when no paid-intent ledger was wired (nothing could be recorded). */
    ledgerId?: string;
    reason: string;
  };
  /**
   * Set ONLY on `payment_not_admitted` / `payment_admission_unconfirmed` (#885): the relay's LAST answer to
   * the submission, classified as it would be for an unpaid submit — e.g.
   * `malformed_request` for a proof the relay rejects (a construction bug),
   * `unknown` for a 503, `network_unreachable` for a network failure.
   */
  submitError?: { code: DelegationErrorCode; message: string; status?: number };
  /** #885: other transactions this hire sent that may have moved money (see `DelegationSettlement`). */
  extraPayments?: Array<{ txHash: string; status: "landed" | "unconfirmed" }>;
  /** #885: a payment owed could not be written durably — held in memory only. */
  ledgerWriteFailed?: true;
  /** #885: the human-readable statement of the two fields above. */
  notice?: string;
  /**
   * Set ONLY on `undetermined` / `task_expired`: the relay's own verdict on
   * the task, as its read reported it.
   */
  relayVerdict?: { taskId: string; reason: string; detail: string };
}

/**
 * What actually settled — the money fact a successful delegation must carry so
 * the caller (and the AI loop) can report payment truthfully instead of
 * confabulating "settlement isn't active." Populated by the leaf submitters:
 * `submitP2pDelegation` fills the onchain facts from the payment proof;
 * `submitAndPollDelegation` marks `mode: "relay"` (the relay records the
 * ledger movement internally — no client-visible tx). Typed-truth doctrine:
 * the result states what happened, the prompt only teaches how to read it.
 */
export interface DelegationSettlement {
  /** `p2p` = paid onchain in the delegator's atomic tx; `relay` = relay-ledger settlement. */
  mode: "p2p" | "relay";
  /** Onchain transaction signature (P2P only). */
  txHash?: string;
  /** Micro-units paid to the worker, net of fees (P2P only — the proof's `amount_micro`). */
  paidMicro?: number;
  /**
   * Platform fee in micro-units (P2P only). Single-operator = the one fee leg;
   * federated = origin-relay fee + executor-relay fee (`fee_amount_micro +
   * b_fee_amount_micro`).
   */
  feeMicro?: number;
  /**
   * #885: OTHER transactions this hire's wallet sent that may have moved
   * money (a re-sign whose first attempt landed too, or could not be ruled
   * out). Recorded in the paid-intent ledger; the owner must reconcile them.
   */
  extraPayments?: Array<{ txHash: string; status: "landed" | "unconfirmed" }>;
  /** #885: a payment owed could not be written durably — held in memory only. */
  ledgerWriteFailed?: true;
  /** #885: the human-readable statement of the two fields above. */
  notice?: string;
}

export type DelegationResult =
  | { ok: true; receipt: ExecutionReceipt; taskId: string; settlement?: DelegationSettlement }
  | { ok: false; error: DelegationError };

/**
 * Result of `MotebitRuntime.executeGrantedDelegation` — the deterministic
 * granted-spend path. Distinct from `DelegationResult` because the dry-run
 * branch has NO worker receipt (no worker ran) and a refusal carries only a
 * denial CODE (the owner-safe residual), never the overage quantity or an
 * `AuthorityDelta`.
 */
export type GrantedDelegationResult =
  | { ok: true; dryRun: true; settlement: DelegationSettlement }
  | {
      ok: true;
      dryRun: false;
      receipt: ExecutionReceipt;
      settlement?: DelegationSettlement;
      /**
       * The signed routing-decision transcript minted for THIS hire's ranked
       * selection (docs/doctrine/routing-decision-transcript.md Inc 4 — the
       * egress a molecule self-attests into its own receipt, the
       * `sub_settlements` shape). Absent on pinned hires and when no signing
       * key is wired. Reveals, never authorizes.
       */
      routingTranscript?: import("@motebit/protocol").RoutingDecisionTranscript;
    }
  | {
      ok: false;
      code: string;
      /**
       * Set ONLY when the delegator's onchain payment ALREADY SETTLED but
       * the result could not be retrieved. Same #433 contract as
       * `DelegationError.settledPayment` — without it, the human-absent
       * granted path flattened a paid-but-undelivered hire into a bare
       * failure code, indistinguishable from never-hired (#436 finding 1).
       */
      settledPayment?: DelegationError["settledPayment"];
      /** #885: money may have moved and could not be confirmed (see `DelegationError`). */
      unconfirmedPayment?: DelegationError["unconfirmedPayment"];
      /** #885: other transactions this hire sent that may have moved money. */
      extraPayments?: DelegationError["extraPayments"];
      /** #885: a payment owed could not be written durably — held in memory only. */
      ledgerWriteFailed?: true;
      /** #885: the owner-facing statement of the fields above. */
      notice?: string;
    };

export interface SubmitAndPollParams {
  /** This motebit's identity (the submitter/owner of the task). */
  motebitId: string;
  /** Base URL of the relay. */
  syncUrl: string;
  /** Mints audience-scoped auth tokens. */
  authToken: (audience?: TokenAudience) => Promise<string>;
  /** Task prompt to submit. */
  prompt: string;
  /** Capabilities the target agent must advertise. */
  requiredCapabilities?: string[];
  /** Routing strategy for candidate ranking. */
  routingStrategy?: "cost" | "quality" | "balanced";
  /** Invocation provenance — signature-bound on the resulting receipt. */
  invocationOrigin?: IntentOrigin;
  /**
   * Standing-grant id this delegation executes under (advisory on the
   * wire, never authority). Attached so the relay's acceptance-time
   * revocation fence engages (`TASK_GRANT_REVOKED` before any hold).
   */
  grantId?: string;
  /** Upper bound on end-to-end wait. Default 120s (matches delegate_to_agent). */
  timeoutMs?: number;
  /** Structured logger. */
  logger: { warn(message: string, context?: Record<string, unknown>): void };
  /** Abort the poll loop early — pairs with `AbortController` on the caller side. */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2000;

/**
 * Map a relay error envelope to a `DelegationErrorCode`. Exported so the
 * code-mapping — in particular that `TASK_P2P_PROOF_REQUIRED` is distinguished
 * from a bare 402 `insufficient_balance` — is unit-testable without a live
 * relay; a reorder that lets the generic 402 swallow the gate code fails there.
 */
export function classifyRelayError(
  status: number,
  body: string,
  retryAfterHeader?: string | null,
): DelegationError {
  const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined;

  // Attempt to parse the structured relay error envelope. Relay returns
  // `{ error, code, status }` (see services/relay/src/errors.ts).
  let relayCode: string | undefined;
  let relayMessage: string | undefined;
  try {
    const parsed = JSON.parse(body) as { code?: string; error?: string };
    relayCode = parsed.code;
    relayMessage = parsed.error;
  } catch {
    // Non-JSON body — keep the raw text for the message.
  }

  const message = relayMessage ?? body.slice(0, 512);

  // 401 — auth expired / invalid.
  if (status === 401) {
    return { code: "auth_expired", message, status };
  }
  // 402 + TASK_P2P_PROOF_REQUIRED — the Arc 3.5 gate. Check before the generic
  // 402 so a paid cross-agent delegation without a proof reports honestly
  // ("this path settles P2P") instead of the misleading "insufficient balance."
  if (relayCode === "TASK_P2P_PROOF_REQUIRED") {
    return { code: "payment_proof_required", message, status };
  }
  // 402 — relay's economic-boundary signal.
  if (status === 402 || relayCode === "INSUFFICIENT_FUNDS") {
    return { code: "insufficient_balance", message, status };
  }
  // 403 — authorization failures. P2P eligibility surfaces as TASK_P2P_INELIGIBLE
  // which, for a user-tap chip, effectively means "not authorized for this path".
  if (status === 403) {
    return { code: "unauthorized", message, status };
  }
  // 429 — rate limit with Retry-After.
  if (status === 429) {
    return {
      code: "rate_limited",
      message,
      status,
      ...(Number.isFinite(retryAfterSeconds) ? { retryAfterSeconds } : {}),
    };
  }
  // 400 — malformed. Code bug on the caller side.
  if (status === 400) {
    return { code: "malformed_request", message, status };
  }
  return { code: "unknown", message, status };
}

/**
 * Submit a task to the relay and poll until a receipt lands, the caller
 * aborts, or the timeout elapses. Pure transport — does not bump trust, does
 * not stash receipts, does not render. Callers layer those concerns on top.
 */
export async function submitAndPollDelegation(
  params: SubmitAndPollParams,
): Promise<DelegationResult> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  // Mint the submit token (used once, immediately). The relay enforces `aud`
  // binding: task:submit for POST; the task:query token for GET is minted
  // per poll attempt inside pollForReceipt (see PollForReceiptArgs.getQueryHeader).
  let submitHeader: string;
  try {
    submitHeader = `Bearer ${await params.authToken("task:submit")}`;
  } catch (err: unknown) {
    return {
      ok: false,
      error: {
        code: "auth_expired",
        message: `Auth token mint failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  // Submit.
  let taskId: string;
  try {
    const body: Record<string, unknown> = {
      prompt: params.prompt,
      submitted_by: params.motebitId,
    };
    if (params.requiredCapabilities && params.requiredCapabilities.length > 0) {
      body.required_capabilities = params.requiredCapabilities;
    }
    if (params.routingStrategy) {
      body.routing_strategy = params.routingStrategy;
    }
    if (params.invocationOrigin) {
      body.invocation_origin = params.invocationOrigin;
    }
    if (params.grantId != null) {
      body.grant_id = params.grantId;
    }

    const resp = await fetch(`${params.syncUrl}/agent/${params.motebitId}/task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: submitHeader,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return {
        ok: false,
        error: classifyRelayError(resp.status, text, resp.headers.get("Retry-After")),
      };
    }

    const data = (await resp.json()) as { task_id: string };
    taskId = data.task_id;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        error: { code: "timeout", message: "Aborted before submission completed" },
      };
    }
    return {
      ok: false,
      error: {
        code: "network_unreachable",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  // Poll until a receipt lands, the caller aborts, or the timeout elapses.
  // Shared with the P2P path (`submitP2pDelegation`) — the only difference
  // between the two flows is the submit body, never the poll.
  const result = await pollForReceipt({
    syncUrl: params.syncUrl,
    motebitId: params.motebitId,
    taskId,
    getQueryHeader: async () => `Bearer ${await params.authToken("task:query")}`,
    timeoutMs,
    startedAt,
    logger: params.logger,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  // Relay-mediated settlement — the relay records the ledger movement; there is
  // no client-visible onchain tx. Mark the mode so the caller reports honestly
  // ("settled via the relay ledger") rather than confabulating no settlement.
  return result.ok ? { ...result, settlement: { mode: "relay" } } : result;
}

interface PollForReceiptArgs {
  syncUrl: string;
  motebitId: string;
  taskId: string;
  /**
   * Re-minting thunk, called PER poll attempt — never a pre-minted header.
   * A task can legitimately outlive the 5-minute signed-token TTL (a paid
   * molecule doing per-hop onchain settlement runs tens of minutes); a
   * static token then 403s every remaining poll while the relay's task TTL
   * reaps the completed record — a paid receipt lost to the payer (#424).
   * Minting is a local Ed25519 sign, so per-attempt cost is negligible.
   */
  getQueryHeader: () => Promise<string>;
  timeoutMs: number;
  startedAt: number;
  logger: { warn(message: string, context?: Record<string, unknown>): void };
  signal?: AbortSignal;
}

/**
 * The outcome of ONE authenticated `task:query` read of
 * `GET /agent/:taskOwnerId/task/:taskId`. Shared by the poll loop
 * (`pollForReceipt`) and the single-shot retrieval
 * (`retrieveDelegationResult`) so the two can never parse the relay's
 * answer differently.
 */
type TaskQueryOutcome =
  | { kind: "receipt"; receipt: ExecutionReceipt }
  | { kind: "failed" }
  | { kind: "pending"; taskStatus: string }
  | { kind: "undetermined"; reason: string; detail: string }
  | { kind: "expired"; reason: string; detail: string }
  | { kind: "http_error"; status: number; body: string }
  | { kind: "aborted" }
  | { kind: "network_error"; message: string };

/** The relay's `undetermined` / `expired` verdict object, read defensively. */
function relayVerdictOf(v: { reason?: unknown; detail?: unknown }): {
  reason: string;
  detail: string;
} {
  return {
    reason: typeof v.reason === "string" ? v.reason : "unknown",
    detail: typeof v.detail === "string" ? v.detail : "",
  };
}

async function queryTaskOnce(args: {
  syncUrl: string;
  taskOwnerId: string;
  taskId: string;
  authorization: string;
  signal?: AbortSignal;
}): Promise<TaskQueryOutcome> {
  try {
    const resp = await fetch(`${args.syncUrl}/agent/${args.taskOwnerId}/task/${args.taskId}`, {
      headers: { Authorization: args.authorization },
      signal: args.signal,
    });
    if (!resp.ok) {
      return { kind: "http_error", status: resp.status, body: await resp.text().catch(() => "") };
    }
    const data = (await resp.json()) as {
      task: { status: string };
      receipt: ExecutionReceipt | null;
      undetermined?: { reason?: unknown; detail?: unknown } | null;
      expired?: { reason?: unknown; detail?: unknown } | null;
    };
    // Agent-failed status arrives either as receipt.status === "failed" (with
    // a signed receipt — preferred) or as task.status === "failed" without
    // one. Both are terminal for a single invocation — no retry.
    if (data.receipt != null) return { kind: "receipt", receipt: data.receipt };
    if (data.task.status === "failed") return { kind: "failed" };
    // One task, one body: the relay's own verdicts on a task with no
    // receipt — granted and its executor lost (`undetermined`: it may have
    // run), or never granted before its TTL (`expired`: it did not run).
    // Neither is "pending".
    if (data.undetermined != null) {
      return { kind: "undetermined", ...relayVerdictOf(data.undetermined) };
    }
    if (data.expired != null) return { kind: "expired", ...relayVerdictOf(data.expired) };
    return { kind: "pending", taskStatus: data.task.status };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") return { kind: "aborted" };
    return { kind: "network_error", message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Poll the relay for a task's receipt. Tasks are stored under the submitter's
 * motebitId. Returns on the first signed receipt, an explicit agent-failed
 * status, abort, or timeout. Network glitches mid-poll are retried silently
 * (calm-software doctrine). Extracted so the relay-mode and P2P delegation
 * paths share one poll implementation — divergence here was the drift risk.
 * Each attempt is one `queryTaskOnce` — the same read `retrieveDelegationResult`
 * makes after the fact.
 */
async function pollForReceipt(args: PollForReceiptArgs): Promise<DelegationResult> {
  const maxPolls = Math.ceil(args.timeoutMs / POLL_INTERVAL_MS);
  for (let i = 0; i < maxPolls; i++) {
    if (args.signal?.aborted) {
      return { ok: false, error: { code: "timeout", message: "Aborted mid-poll" } };
    }

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, POLL_INTERVAL_MS);
      args.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    }).catch(() => {
      /* abort — handled on next iteration */
    });

    let queryHeader: string;
    try {
      queryHeader = await args.getQueryHeader();
    } catch (err: unknown) {
      args.logger.warn("delegation poll token mint failed", {
        taskId: args.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const outcome = await queryTaskOnce({
      syncUrl: args.syncUrl,
      taskOwnerId: args.motebitId,
      taskId: args.taskId,
      authorization: queryHeader,
      ...(args.signal ? { signal: args.signal } : {}),
    });
    switch (outcome.kind) {
      case "receipt":
        return { ok: true, receipt: outcome.receipt, taskId: args.taskId };
      case "failed":
        return {
          ok: false,
          error: { code: "agent_failed", message: "Agent reported failure without a receipt" },
        };
      case "aborted":
        return { ok: false, error: { code: "timeout", message: "Aborted mid-poll" } };
      case "undetermined":
        // The relay's verdict, not a timeout: stop polling now.
        return {
          ok: false,
          error: {
            code: "undetermined",
            message: `Task ${args.taskId} is undetermined at the relay (${outcome.reason}): ${outcome.detail}`,
            relayVerdict: { taskId: args.taskId, reason: outcome.reason, detail: outcome.detail },
          },
        };
      case "expired":
        return {
          ok: false,
          error: {
            code: "task_expired",
            message: `Task ${args.taskId} expired at the relay without ever being claimed (${outcome.reason}): ${outcome.detail}`,
            relayVerdict: { taskId: args.taskId, reason: outcome.reason, detail: outcome.detail },
          },
        };
      case "http_error":
        args.logger.warn("delegation poll failed", {
          taskId: args.taskId,
          status: outcome.status,
          body: outcome.body,
        });
        continue;
      case "pending":
      case "network_error":
        // Still running, or a network glitch — silent retry, per calm-software doctrine.
        continue;
    }
  }

  const elapsedMs = Date.now() - args.startedAt;
  return {
    ok: false,
    error: { code: "timeout", message: `No receipt within ${Math.round(elapsedMs / 1000)}s` },
  };
}

/**
 * What one retrieval found. Typed truth (docs/doctrine/typed-truth-perception.md):
 * each status is a distinct fact the caller renders and the model reads —
 * never collapsed into "failed", because "failed" is what an agent reads as
 * "hire again" (#433/#874).
 *
 * - `delivered` — the worker's signed receipt is held by the relay (its own
 *   `status` may still be `failed`: a signed failure is a delivered result).
 * - `pending` — the task exists and has no receipt yet; ask again later.
 * - `undetermined` — the relay granted the task and its executor was lost
 *   or never answered: the work MAY have run. Never hire again for it; the
 *   executor's late signed result still resolves it (ask again later).
 * - `expired` — the task outlived its TTL with nothing ever granted it: it
 *   did not run and never will.
 * - `failed` — the relay marked the task failed without a signed receipt.
 * - `not_found` — HTTP 404: the relay no longer holds the task (reaped
 *   after its retention window) or the id is wrong. NOT proof the result
 *   is gone for good — a 404 has followed a transient 503 before (#433).
 * - `auth_error` — the relay refused the `task:query` token (401/403), or
 *   no token could be minted.
 * - `unreachable` — network failure or a relay 5xx/other status.
 * - `malformed` — a receipt came back bound to a DIFFERENT relay task.
 * - `invalid_task_id` — the id is not a task id; nothing was sent.
 * - `not_connected` — this runtime has no relay coordinates; nothing was sent.
 * - `not_admitted` — the id is a paid-intent ledger entry for a payment
 *   with no confirmed relay task (`p2p-payment:` / `p2p-unconfirmed:`,
 *   #885): the relay refused it, its admission is unconfirmed, or the
 *   payment's own landing is unconfirmed. The relay has no read by payment,
 *   so nothing was sent; the entry stays until the owner reconciles it.
 */
export type TaskRetrieval =
  | { status: "not_admitted"; taskId: string }
  | { status: "delivered"; taskId: string; receipt: ExecutionReceipt }
  | { status: "pending"; taskId: string; taskStatus: string }
  | { status: "undetermined"; taskId: string; reason: string; detail: string }
  | { status: "expired"; taskId: string; reason: string; detail: string }
  | { status: "failed"; taskId: string }
  | { status: "not_found"; taskId: string; message: string }
  | { status: "auth_error"; taskId: string; httpStatus?: number; message: string }
  | { status: "unreachable"; taskId: string; httpStatus?: number; message: string }
  | { status: "malformed"; taskId: string; message: string }
  | { status: "invalid_task_id"; taskId: string }
  | { status: "not_connected"; taskId: string };

export interface RetrieveDelegationResultParams {
  /** The caller's identity — the submitter the `task:query` token is minted for. */
  motebitId: string;
  /** Base URL of the relay. */
  syncUrl: string;
  /** Mints audience-scoped auth tokens; called once, for `task:query`. */
  authToken: (audience?: TokenAudience) => Promise<string>;
  /** The relay task to read. */
  taskId: string;
  /**
   * The motebit the task is filed under on the relay (the `:motebitId`
   * path segment). The runtime's own delegation paths file under the
   * submitter, so it defaults to `motebitId`; `motebit delegate`'s
   * relay-mode path files under the target worker and passes it here.
   */
  taskOwnerId?: string;
  signal?: AbortSignal;
}

/** Relay task ids are UUIDs today; accept a conservative id alphabet, never a path. */
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Retrieve a delegated task's result by id — ONE authenticated `task:query`
 * GET. The recovery path for a paid delegation whose result was never
 * delivered (#874): before this, nothing fetched a result by task id, so a
 * restarted agent's only route to "get my paid result" was hiring again.
 *
 * Free and read-only by construction: it mints one `task:query` token and
 * makes one GET. It never submits a task, never builds or broadcasts a
 * payment, never retries — a caller that wants to wait asks again.
 */
export async function retrieveDelegationResult(
  params: RetrieveDelegationResultParams,
): Promise<TaskRetrieval> {
  const taskId = params.taskId.trim();
  const taskOwnerId = params.taskOwnerId ?? params.motebitId;
  // A payment with no confirmed relay task (#885) is answered here: its
  // ledger id is not a relay task id, so a read would 404 and read as
  // "reaped". The relay offers no read by payment or idempotency key, so
  // nothing more can be learned remotely.
  if (isPaymentWithoutTaskId(taskId)) {
    return { status: "not_admitted", taskId };
  }
  if (!TASK_ID_PATTERN.test(taskId) || !TASK_ID_PATTERN.test(taskOwnerId)) {
    return { status: "invalid_task_id", taskId };
  }

  let authorization: string;
  try {
    authorization = `Bearer ${await params.authToken("task:query")}`;
  } catch (err: unknown) {
    return {
      status: "auth_error",
      taskId,
      message: `task:query token mint failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const outcome = await queryTaskOnce({
    syncUrl: params.syncUrl,
    taskOwnerId,
    taskId,
    authorization,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  switch (outcome.kind) {
    case "receipt": {
      // The relay binds a receipt to its economic task via `relay_task_id`
      // (it refuses a mismatched one at POST). Re-check it here: a receipt
      // for another task must never clear this task's paid-unretrieved entry.
      const bound = (outcome.receipt as unknown as { relay_task_id?: unknown }).relay_task_id;
      if (typeof bound === "string" && bound !== taskId) {
        return {
          status: "malformed",
          taskId,
          message: `receipt is bound to relay task ${bound}, not ${taskId}`,
        };
      }
      return { status: "delivered", taskId, receipt: outcome.receipt };
    }
    case "failed":
      return { status: "failed", taskId };
    case "pending":
      return { status: "pending", taskId, taskStatus: outcome.taskStatus };
    case "undetermined":
      return { status: "undetermined", taskId, reason: outcome.reason, detail: outcome.detail };
    case "expired":
      return { status: "expired", taskId, reason: outcome.reason, detail: outcome.detail };
    case "http_error": {
      const message = classifyRelayError(outcome.status, outcome.body).message;
      if (outcome.status === 404) return { status: "not_found", taskId, message };
      if (outcome.status === 401 || outcome.status === 403) {
        return { status: "auth_error", taskId, httpStatus: outcome.status, message };
      }
      return { status: "unreachable", taskId, httpStatus: outcome.status, message };
    }
    case "aborted":
      return { status: "unreachable", taskId, message: "aborted" };
    case "network_error":
      return { status: "unreachable", taskId, message: outcome.message };
  }
}

export interface SubmitP2pDelegationParams {
  /** The delegator's identity (submitter / owner of the task). */
  motebitId: string;
  /**
   * Standing-grant id this delegation executes under (advisory on the
   * wire, never authority) — engages the relay's acceptance-time
   * revocation fence.
   */
  grantId?: string;
  /** Base URL of the relay. */
  syncUrl: string;
  /** Mints audience-scoped auth tokens. */
  authToken: (audience?: TokenAudience) => Promise<string>;
  /** Task prompt to submit. */
  prompt: string;
  /**
   * The capabilities the pinned worker must advertise. REQUIRED for a federated
   * (cross-operator) worker: the origin relay rejects a federated P2P submission
   * with no `required_capabilities` (it cannot locate the worker on its operator
   * or price the §7.1 budget without them — tasks.ts). Harmless for a local
   * worker (the target is pinned by `target_agent` regardless).
   */
  requiredCapabilities?: string[];
  /**
   * Cold-start acknowledgment. The relay's single-operator P2P eligibility gate
   * (`evaluateSettlementEligibility`) rejects a NEW delegator↔worker pair (no
   * trust history) with 403 unless the delegator consciously accepts the
   * cold-start risk (Arc 3, `docs/doctrine/off-ramp-as-user-action.md`). Set
   * true to send `delegator_acknowledges_no_history_risk` so a first-time paid
   * P2P delegation is accepted rather than 403'd. CRITICAL: without it, a
   * cold-start pair fails the gate AFTER the client has already broadcast the
   * payment (resolve broadcasts before submit) — funds move, task rejected, no
   * relay-mode fallback. Established pairs (trust ≥ threshold) ignore it.
   */
  acknowledgeNoHistoryRisk?: boolean;
  /**
   * The PINNED worker. P2P settlement addresses a specific worker — the proof's
   * worker leg pays that worker's `settlement_address` — so unlike relay-mode
   * capability routing, the target is fixed (submitted as `target_agent`).
   */
  targetWorkerId: string;
  /**
   * The pre-built P2P payment proof: the delegator's CONFIRMED atomic onchain
   * settlement (worker leg + relay-fee leg[s]). Built ONCE by the caller via
   * `SovereignWalletRail.buildP2pPayment` BEFORE this call. This function never
   * broadcasts — it only submits the already-paid proof and polls. On a
   * transient submission failure it retries with the SAME proof itself
   * (`submitRetry`, #885), never rebuilding: rebuilding broadcasts a second
   * payment, whereas resubmitting the same `tx_hash` is safe (the relay
   * dedupes on it as the `Idempotency-Key`: a refusal made before admission
   * frees the key, and once a task is admitted the key replays that
   * submission's answer, 201 or failure, and never admits a second task
   * (#888). The proof itself is bound to the task it admitted, under any
   * key, and is never released: a later submission of it is 409
   * `TASK_P2P_PROOF_ALREADY_ADMITTED`, or `TASK_P2P_PROOF_REPLAYED` once
   * that task settled (#918)). Separating the irreversible broadcast from the
   * retryable submit is what makes "no double-pay" structural rather than a
   * convention.
   */
  paymentProof: P2pPaymentProof;
  /** Invocation provenance — signature-bound on the resulting receipt. */
  invocationOrigin?: IntentOrigin;
  /** Upper bound on end-to-end wait. Default 120s. */
  timeoutMs?: number;
  /** Structured logger. */
  logger: { warn(message: string, context?: Record<string, unknown>): void };
  /** Abort the poll loop early. */
  signal?: AbortSignal;
  /**
   * Called once, synchronously, the moment the relay accepts the paid
   * submission — BEFORE the first poll. The payment has settled and the
   * task exists, so this is when "paid, result pending" becomes a fact a
   * caller must be able to recover from even if the process dies mid-poll
   * (#874 review: recording only on poll failure lost the entry to a quit).
   */
  onTaskAccepted?: (taskId: string) => void;
  /**
   * How a failed submission of the already-paid proof is retried (#885).
   * Every retry resubmits the SAME proof under the same `Idempotency-Key`
   * (the tx hash) — never a new payment. Tests inject `sleep`.
   */
  submitRetry?: SubmitRetryPolicy;
}

/** Retry policy for resubmitting an already-paid P2P proof (#885). */
export interface SubmitRetryPolicy {
  /** Waits before each retry; its length is the retry count. Default 1s, 3s, 9s. */
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Default waits between resubmissions of an already-paid proof: three
 * retries over ~13s. Bounded so a relay that is down for good surfaces
 * "paid, not admitted" promptly rather than holding the caller.
 */
const DEFAULT_SUBMIT_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 9_000];
/** Upper bound on a relay `Retry-After` honoured between resubmissions. */
const MAX_SUBMIT_RETRY_AFTER_MS = 30_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * May a failed submission of an ALREADY-PAID proof be tried again with the
 * same proof? (#885.) Retrying is always money-safe — the proof is the
 * same payment and the relay dedupes on the tx hash (`Idempotency-Key`;
 * services/relay/src/tasks.ts frees a key refused before admission and
 * replays an admitted submission's answer, #888; the proof is bound to its
 * admitted task, #918) — so the only question is whether another attempt could
 * succeed. Transient: network, 5xx, 408, 429, 401 (a fresh token is minted
 * per attempt), and a 409 that is the relay still processing the same key.
 * A 409 `TASK_P2P_PROOF_REPLAYED` (the proof already settled a task),
 * `TASK_P2P_PROOF_ALREADY_ADMITTED` (the proof is bound to a task already
 * admitted — #918: one proof funds at most one task), and every other 4xx
 * will answer the same way again.
 */
const FINAL_PROOF_CONFLICTS = new Set([
  "TASK_P2P_PROOF_REPLAYED",
  "TASK_P2P_PROOF_ALREADY_ADMITTED",
]);
function isRetryableSubmitStatus(status: number, relayCode: string | undefined): boolean {
  if (status >= 500 || status === 408 || status === 429 || status === 401) return true;
  if (status === 409) return relayCode == null || !FINAL_PROOF_CONFLICTS.has(relayCode);
  return false;
}

/**
 * `ambiguous` = the request may have reached the relay's handler and been
 * admitted without the answer arriving here (a network failure, a 5xx, a
 * 409 on the same payment still being processed, a 2xx without a task id,
 * an abort mid-request). A definitive refusal (4xx) or a token that could
 * not be minted is not ambiguous.
 */
type SubmitAttempt =
  | { kind: "accepted"; taskId: string }
  | {
      kind: "failed";
      error: DelegationError;
      retryable: boolean;
      ambiguous: boolean;
      retryAfterMs?: number;
    }
  | { kind: "aborted"; error: DelegationError };

/**
 * ONE submission of an already-paid P2P proof: mint a `task:submit` token,
 * POST the pinned task with the proof, classify the answer. Never
 * broadcasts; a caller retries by calling it again with the same proof.
 */
async function submitP2pOnce(params: SubmitP2pDelegationParams): Promise<SubmitAttempt> {
  let submitHeader: string;
  try {
    submitHeader = `Bearer ${await params.authToken("task:submit")}`;
  } catch (err: unknown) {
    return {
      kind: "failed",
      retryable: true,
      ambiguous: false,
      error: {
        code: "auth_expired",
        message: `Auth token mint failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  try {
    const body: Record<string, unknown> = {
      prompt: params.prompt,
      submitted_by: params.motebitId,
      target_agent: params.targetWorkerId,
      settlement_mode: "p2p",
      // The relay's task-submission handler reads the proof under `payment_proof`
      // (services/relay/src/tasks.ts) — NOT `p2p_payment_proof` (that's only the
      // relay's internal TaskQueue field name). Sending the wrong key made the
      // relay see no proof and reject every paid cross-agent delegation with 402
      // TASK_P2P_PROOF_REQUIRED. The federation-e2e client↔relay integration test
      // locks this wire key (the seam that mocked-fetch unit tests can't catch).
      payment_proof: params.paymentProof,
    };
    // Federated P2P needs the capabilities to locate + price the remote worker
    // on its operator (the relay rejects a proofed federated submission without
    // them). Local P2P ignores them (the target is pinned).
    if (params.requiredCapabilities && params.requiredCapabilities.length > 0) {
      body.required_capabilities = params.requiredCapabilities;
    }
    // Cold-start: lets the relay's single-op P2P eligibility gate accept a
    // no-trust-history pair (else 403 AFTER the payment already broadcast).
    if (params.acknowledgeNoHistoryRisk === true) {
      body.delegator_acknowledges_no_history_risk = true;
    }
    if (params.invocationOrigin) {
      body.invocation_origin = params.invocationOrigin;
    }
    // Standing-grant fence: the relay refuses acceptance under a revoked
    // grant (TASK_GRANT_REVOKED) — advisory id, never authority.
    if (params.grantId != null) {
      body.grant_id = params.grantId;
    }

    const resp = await fetch(`${params.syncUrl}/agent/${params.motebitId}/task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: submitHeader,
        // Stable across retries of the SAME logical delegation so a re-submit
        // of the already-paid proof dedupes byte-identically rather than
        // racing a second task. Keyed on the onchain tx_hash, which uniquely
        // identifies this payment.
        "Idempotency-Key": params.paymentProof.tx_hash,
      },
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const retryAfter = resp.headers.get("Retry-After");
      const error = classifyRelayError(resp.status, text, retryAfter);
      let relayCode: string | undefined;
      let boundTaskId: unknown;
      try {
        const parsed = JSON.parse(text) as { code?: string; task_id?: unknown };
        relayCode = parsed.code;
        boundTaskId = parsed.task_id;
      } catch {
        relayCode = undefined;
      }
      // #918: this proof is already bound to an admitted task, and the relay
      // names it — it does so only to the submitter whose verified token
      // admitted it, or the operator. That task IS the one this payment
      // funds (e.g. it was admitted under a key this device no longer
      // replays), so hand over to it: record it and poll its result, never
      // end "unconfirmed" on a task the relay has just told us about.
      if (
        resp.status === 409 &&
        relayCode === "TASK_P2P_PROOF_ALREADY_ADMITTED" &&
        typeof boundTaskId === "string" &&
        boundTaskId.length > 0
      ) {
        return { kind: "accepted", taskId: boundTaskId };
      }
      return {
        kind: "failed",
        error,
        retryable: isRetryableSubmitStatus(resp.status, relayCode),
        // A 409 is never a refusal of THIS payment: either the relay is still
        // handling the same key, or (TASK_P2P_PROOF_REPLAYED /
        // TASK_P2P_PROOF_ALREADY_ADMITTED) this very proof already funded a
        // task — admitted, just not visibly to us.
        ambiguous: resp.status >= 500 || resp.status === 408 || resp.status === 409,
        ...(error.retryAfterSeconds != null && Number.isFinite(error.retryAfterSeconds)
          ? { retryAfterMs: error.retryAfterSeconds * 1000 }
          : {}),
      };
    }

    const data = (await resp.json()) as { task_id?: unknown };
    if (typeof data.task_id !== "string" || data.task_id.length === 0) {
      // A 2xx without a task id: the same key replays the relay's cached
      // answer, so asking again is the only way to learn the task.
      return {
        kind: "failed",
        retryable: true,
        ambiguous: true,
        error: { code: "unknown", message: "relay accepted the submission without a task_id" },
      };
    }
    return { kind: "accepted", taskId: data.task_id };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        kind: "aborted",
        error: { code: "timeout", message: "Aborted before submission completed" },
      };
    }
    return {
      kind: "failed",
      retryable: true,
      ambiguous: true,
      error: {
        code: "network_unreachable",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Submit a PAID direct delegation that settles peer-to-peer and poll until a
 * receipt lands. The delegator has already paid the worker + relay fee in one
 * atomic onchain transaction (`params.paymentProof`); this function pins the
 * worker (`target_agent`), declares `settlement_mode: "p2p"`, and attaches the
 * proof so the relay's Arc-3.5 gate (`requiresP2pProof`) is satisfied — the
 * relay records an audit row and the async p2p-verifier confirms the legs
 * landed. Shares `pollForReceipt` with the relay-mode path; the only difference
 * is the submit body. Pure transport — does not bump trust, broadcast, or
 * render.
 *
 * The money has ALREADY moved when this runs, so a submission that fails is
 * never a plain failure (#885). A transient failure (network, relay 5xx, 429,
 * a stale token) is retried with the SAME proof — never a new payment — up to
 * `submitRetry.delaysMs.length` times. If the relay still has not admitted
 * the task, or it rejects the proof outright (a 4xx such as a
 * `malformed_request` leg mismatch), the result is `payment_not_admitted` (a
 * definitive refusal) or `payment_admission_unconfirmed` (any attempt may have
 * been admitted unseen — a network failure, a 5xx, a 409 on the same payment),
 * carrying the payment in `settledPayment` under the ledger's
 * `p2p-payment:<tx>` id: the caller must record it and must never pay
 * again for this intent.
 */
export async function submitP2pDelegation(
  params: SubmitP2pDelegationParams,
): Promise<DelegationResult> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const delays = params.submitRetry?.delaysMs ?? DEFAULT_SUBMIT_RETRY_DELAYS_MS;
  const sleep = params.submitRetry?.sleep ?? defaultSleep;
  const proof = params.paymentProof;

  let taskId: string | null = null;
  let attempts = 0;
  let last: DelegationError | null = null;
  // Did any attempt possibly reach the relay and get admitted unseen?
  let ambiguous = false;
  for (;;) {
    attempts++;
    const attempt = await submitP2pOnce(params);
    if (attempt.kind === "accepted") {
      taskId = attempt.taskId;
      break;
    }
    last = attempt.error;
    if (attempt.kind === "aborted" || attempt.ambiguous) ambiguous = true;
    const canRetry =
      attempt.kind === "failed" &&
      attempt.retryable &&
      attempts <= delays.length &&
      params.signal?.aborted !== true;
    if (!canRetry) break;
    const waitMs = Math.max(
      delays[attempts - 1] ?? 0,
      Math.min(attempt.retryAfterMs ?? 0, MAX_SUBMIT_RETRY_AFTER_MS),
    );
    params.logger.warn("delegation.p2p_submit_retry", {
      txHash: proof.tx_hash,
      attempt: attempts,
      code: attempt.error.code,
      status: attempt.error.status,
      waitMs,
    });
    await sleep(waitMs);
  }

  if (taskId == null) {
    // Paid, not admitted. The payment is a fact; the task is not. Carry the
    // money so no caller can read this as "never hired" (#885 — the #433
    // double-pay shape one step earlier).
    const lastError = last ?? { code: "unknown" as const, message: "submission failed" };
    params.logger.warn("delegation.p2p_payment_not_admitted", {
      txHash: proof.tx_hash,
      attempts,
      ambiguous,
      code: lastError.code,
      status: lastError.status,
      message: lastError.message,
    });
    const tries = `${attempts} submission${attempts === 1 ? "" : "s"} of that same payment`;
    return {
      ok: false,
      error: {
        code: ambiguous ? "payment_admission_unconfirmed" : "payment_not_admitted",
        message: ambiguous
          ? `Paid onchain (tx ${proof.tx_hash}); after ${tries} the relay has not confirmed ` +
            `admitting the task — it may have, without the answer reaching this device. No ` +
            `second payment was made. Last relay answer: ${lastError.code}: ${lastError.message}`
          : `Paid onchain (tx ${proof.tx_hash}), but the relay refused the task (${tries}) — no ` +
            `second payment was made. Relay answer: ${lastError.code}: ${lastError.message}`,
        ...(lastError.status != null ? { status: lastError.status } : {}),
        submitError: {
          code: lastError.code,
          message: lastError.message,
          ...(lastError.status != null ? { status: lastError.status } : {}),
        },
        settledPayment: {
          txHash: proof.tx_hash,
          paidMicro: proof.amount_micro,
          feeMicro: proof.fee_amount_micro + (proof.b_fee_amount_micro ?? 0),
          taskId: paymentEntryId(proof.tx_hash),
        },
      },
    };
  }

  // Money moved and the relay holds the task: record before polling. A
  // hook failure must never abort a paid flow — the poll, and the
  // settlement carried on a poll failure below, matter more than the note.
  try {
    params.onTaskAccepted?.(taskId);
  } catch (err: unknown) {
    params.logger.warn("delegation.task_accepted_hook_failed", {
      taskId,
      txHash: params.paymentProof.tx_hash,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const result = await pollForReceipt({
    syncUrl: params.syncUrl,
    motebitId: params.motebitId,
    taskId,
    getQueryHeader: async () => `Bearer ${await params.authToken("task:query")}`,
    timeoutMs,
    startedAt,
    logger: params.logger,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  // Attach the onchain settlement fact from the proof we just submitted: the
  // worker net (`amount_micro`), the platform fee (single-op = `fee_amount_micro`;
  // federated = origin + executor fee legs), and the tx that paid them. The
  // delegator already broadcast this atomically before submission, so these are
  // settled facts, not a forecast.
  if (result.ok) {
    const proof = params.paymentProof;
    return {
      ...result,
      settlement: {
        mode: "p2p",
        txHash: proof.tx_hash,
        paidMicro: proof.amount_micro,
        feeMicro: proof.fee_amount_micro + (proof.b_fee_amount_micro ?? 0),
      },
    };
  }
  // The poll failed AFTER the payment settled onchain. Carry the settlement
  // fact into the error so the caller cannot mistake "I couldn't fetch the
  // result" for "the hire never happened" — the #433 double-pay shape. The
  // remedy for this failure is re-FETCHING `taskId`, never re-delegating.
  const paidProof = params.paymentProof;
  return {
    ok: false,
    error: {
      ...result.error,
      settledPayment: {
        txHash: paidProof.tx_hash,
        paidMicro: paidProof.amount_micro,
        feeMicro: paidProof.fee_amount_micro + (paidProof.b_fee_amount_micro ?? 0),
        taskId,
      },
    },
  };
}

/** Trivial hex → bytes (deterministic parse, no crypto/state/IO) — inlined per
 *  the layer-boundary convention rather than importing a codec for four lines. */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length === 0 || clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error(`invalid hex: ${hex.slice(0, 16)}…`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// Returns the shared error variant (not the wide DelegationResult) so it is
// assignable to every *Result type whose failure branch is { ok:false; error }
// — including ResolveP2pPaymentRequestResult.
const fail = (
  code: DelegationErrorCode,
  message: string,
  status?: number,
): { ok: false; error: DelegationError } => ({
  ok: false,
  error: status != null ? { code, message, status } : { code, message },
});

/**
 * Injected first-person worker selector. Given the capability-admissible
 * candidates — already past the HARD gates (advertises the capability
 * P2P-eligibly, declares a settlement address, is not self, satisfies any pin)
 * — returns the `motebit_id` to hire, ranked by the CALLER's own trust ledger,
 * or null to defer to the first admissible. It is an ORDERING, never a gate: a
 * pinned delegation bypasses it entirely, and the seam only consults it when
 * more than one candidate survives. Absent ⇒ today's first-eligible behavior.
 * Wired by the runtime over its `agent_trust` store; see
 * docs/doctrine/first-person-worker-routing.md.
 */
export type WorkerSelector = (
  candidates: ReadonlyArray<{ motebit_id: string; unitCost?: number; bonded?: boolean }>,
) => Promise<string | null> | string | null;

/**
 * A payment transaction the builder has SIGNED and is about to send (#885).
 * Its signature is fixed from signing, so the payer can record exactly
 * this transaction before any money can move, and later ask the chain
 * about exactly this transaction.
 */
export interface SignedP2pTransaction {
  signature: string;
  /** The block height after which the transaction can never land. */
  lastValidBlockHeight: number;
}

/**
 * Hooks a payer hands the builder (#885). `beforeBroadcast` runs once per
 * signed transaction, after signing and before sending; if it throws, that
 * transaction is not sent.
 */
export interface P2pBroadcastHooks {
  beforeBroadcast?: (tx: SignedP2pTransaction) => void | Promise<void>;
}

/**
 * The sovereign rail's atomic payment builder — structurally
 * `SolanaWalletRail.buildP2pPayment`. A rail that honours `hooks` also
 * exposes `confirmP2pPayment`; the pair is what binds a failed build to
 * its own transaction.
 */
export type BuildP2pPayment = (
  request: SovereignP2pPaymentRequest,
  hooks?: P2pBroadcastHooks,
) => Promise<P2pPaymentProof>;

/**
 * The rail's read-only question about ONE transaction this payer signed
 * (#885) — structurally `SolanaWalletRail.confirmP2pPayment`, declared here
 * so this rail-agnostic module never imports a wallet package. It never
 * signs or broadcasts, and it never attributes a payment by matching
 * transfers: a same-worker same-price hire running concurrently produces
 * an identical leg set, and a leg match would hand it this hire's money.
 */
export type ConfirmP2pPayment = (query: {
  request: SovereignP2pPaymentRequest;
  transaction: SignedP2pTransaction;
}) => Promise<P2pPaymentConfirmation>;

/** Verdict of a {@link ConfirmP2pPayment} lookup. */
export type P2pPaymentConfirmation =
  | { status: "landed"; proof: P2pPaymentProof }
  | { status: "absent" }
  /** `seen`: a node reported it in a block — a later `absent` is never accepted. */
  | { status: "pending"; recheckAtMs: number; seen?: true }
  | { status: "unknown"; reason: string };

/** The rail's confirmer, when the rail has one — read structurally, never assumed. */
export function p2pPaymentConfirmerOf(rail: unknown): ConfirmP2pPayment | undefined {
  if (rail == null || typeof rail !== "object") return undefined;
  const fn = (rail as { confirmP2pPayment?: unknown }).confirmP2pPayment;
  return typeof fn === "function" ? (fn as ConfirmP2pPayment).bind(rail) : undefined;
}

/** Default wait for a pending transaction: past the ~150s Solana landing window. */
const DEFAULT_PAYMENT_CONFIRM_MAX_WAIT_MS = 180_000;
/** Upper bound on status reads for one transaction while it is pending. */
const MAX_CONFIRM_LOOKS = 60;

export interface ResolveAndSubmitP2pDelegationParams {
  /** Standing-grant id (advisory; engages the relay revocation fence). */
  grantId?: string;
  /**
   * The session's paid-intent ledger. When present, a settled-but-
   * unretrieved prior payment refuses a duplicate delegation BEFORE
   * broadcast (`intent_already_paid`), and a new settled-unretrieved
   * failure is recorded. The runtime passes its instance on every paid
   * path (loop + granted) — enforcement lives HERE, in the shared
   * chokepoint, so the two paths cannot diverge.
   */
  paidIntentLedger?: PaidIntentLedger;
  /** The delegator's identity (submitter / owner of the task). */
  motebitId: string;
  /** Base URL of the relay. */
  syncUrl: string;
  /** Mints audience-scoped auth tokens (the listing read needs `market:listing`). */
  authToken: (audience?: TokenAudience) => Promise<string>;
  /** Task prompt to submit. */
  prompt: string;
  /** Capability the worker must advertise — used to discover + select + price. */
  capability: string;
  /**
   * Pin discovery to a SPECIFIC worker (`motebit_id`) instead of selecting the
   * first eligible P2P candidate for the capability. When set, only that worker
   * is considered; if it doesn't advertise the capability P2P-eligibly, the
   * result is `no_routing` (fail closed — never substitute another worker).
   */
  targetWorkerId?: string;
  /**
   * First-person ranker for the UNPINNED case — chooses among the admissible
   * candidates by the caller's own trust (see {@link WorkerSelector}). Absent
   * ⇒ first-eligible in discovery order. Ignored when `targetWorkerId` is set.
   */
  selectWorker?: WorkerSelector;
  /**
   * Cold-start acknowledgment for a new delegator↔worker pair — forwarded to
   * `submitP2pDelegation`. See its doc: without it the relay's single-op P2P
   * eligibility gate 403s a no-history pair after the payment already broadcast.
   */
  acknowledgeNoHistoryRisk?: boolean;
  /**
   * The relay's PINNED Ed25519 public key (hex), established at pairing. The
   * treasury the fee leg pays is derived from THIS — `base58Encode(pubkey)` —
   * never from a fetched response, so the irreversible onchain payment trusts
   * the pairing root rather than the network. A MITM on relay reads cannot
   * redirect the fee leg.
   */
  relayPublicKeyHex: string;
  /**
   * The sovereign rail's atomic multi-leg payment builder (injected so this
   * module stays provider-agnostic — it never imports a wallet package).
   * Absent → paid direct delegation is unavailable on this runtime.
   */
  buildP2pPayment?: BuildP2pPayment;
  /**
   * The rail's read-only "did the payment land anyway?" lookup, consulted
   * when `buildP2pPayment` throws (#885). Absent ⇒ every builder error that
   * is not provably pre-broadcast is `payment_status_unknown` — recorded,
   * never retried (fail-closed).
   */
  confirmP2pPayment?: ConfirmP2pPayment;
  /**
   * How long to keep asking `confirmP2pPayment` while a broadcast could
   * still land, from the moment the builder threw. Default 180s — past the
   * Solana landing horizon (150s), after which absence is authoritative.
   */
  paymentConfirmMaxWaitMs?: number;
  /** Retry policy for resubmitting the paid proof (see `submitP2pDelegation`). */
  submitRetry?: SubmitRetryPolicy;
  /** Clock (tests pin it). */
  now?: () => number;
  /** Sleep used while waiting on a pending confirmation (tests inject it). */
  sleep?: (ms: number) => Promise<void>;
  /** Invocation provenance — signature-bound on the resulting receipt. */
  invocationOrigin?: IntentOrigin;
  /**
   * Budget ceiling in micro-units over the ENTIRE resolved payment (worker
   * leg + every fee leg). Checked after pricing and BEFORE the atomic
   * broadcast — an over-budget resolution fails `budget_exceeded` with no
   * money moved and nothing submitted. Absent ⇒ no ceiling (caller trusts
   * the listing price).
   */
  maxTotalMicro?: number;
  /** Upper bound on end-to-end wait. Default 120s. */
  timeoutMs?: number;
  /** Structured logger. */
  logger: { warn(message: string, context?: Record<string, unknown>): void };
  /** Abort early. */
  signal?: AbortSignal;
}

/**
 * A relay's declared platform fee rate, read from its SIGNED discovery metadata
 * (`/.well-known/motebit.json`, spec/discovery-v1.md §3) and trusted only when
 * that metadata is signed by `expectedKeyHex` — the key this client already
 * trusts for the relay (the pinned key for the origin; the peer key the pinned
 * origin vouches for, for a federated executor). Never trusted from an unsigned
 * or unpinned read: the rate prices an irreversible payment, so it has the
 * treasury's trust root.
 *
 * - `fee_rate` absent → the protocol reference default `PLATFORM_FEE_RATE`
 *   (the field is optional in §3.2).
 * - `fee_rate` present but not a finite number in [0, 1) → refuse.
 * - Unreachable, unparseable, a different `public_key`, a different
 *   `relay_id` than expected, or a signature that does not verify under
 *   `expectedKeyHex` → refuse.
 *
 * Every refusal is `relay_fee_rate_unverified`, before any money moves.
 */
export async function fetchSignedRelayFeeRate(args: {
  relayUrl: string;
  expectedKeyHex: string;
  expectedRelayId?: string;
  signal?: AbortSignal;
}): Promise<
  { ok: true; feeRate: number; metadata: RelayMetadata } | { ok: false; error: DelegationError }
> {
  const refuse = (why: string) =>
    fail("relay_fee_rate_unverified", `Relay fee rate at ${args.relayUrl}: ${why}`);
  let document: unknown;
  try {
    const resp = await fetch(`${args.relayUrl}/.well-known/motebit.json`, {
      headers: { Accept: "application/json" },
      signal: args.signal,
    });
    if (!resp.ok) return refuse(`signed metadata unavailable (HTTP ${resp.status})`);
    document = await resp.json();
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return fail("timeout", "Aborted while reading relay metadata");
    }
    return refuse(
      `signed metadata unavailable (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const verified = await verifyRelayFeeRate(
    document,
    args.expectedKeyHex,
    args.expectedRelayId != null ? { expectedRelayId: args.expectedRelayId } : undefined,
  );
  if (!verified.ok) return refuse(verified.reason);
  return {
    ok: true,
    feeRate: verified.declaredFeeRate ?? PLATFORM_FEE_RATE,
    metadata: verified.metadata,
  };
}

/**
 * Resolve a paid direct delegation end to end: discover a payable worker,
 * derive the relay treasury from the PINNED key, price the task, broadcast the
 * delegator's atomic onchain payment, and submit the pinned task with the proof.
 *
 * Handles BOTH fee models transparently, chosen by the discovered worker:
 *   - LOCAL (worker on this relay) — fee ON TOP of unit_cost; a 2-leg proof
 *     (worker + origin-fee), priced from the worker's /listing.
 *   - FEDERATED (worker on a direct peer, identified by the peer relay key the
 *     origin surfaces in discovery) — unit_cost IS the budget; the fee comes OUT
 *     of it and splits 3 ways (`computeFederatedFeeSplit`, spec §7.1), adding an
 *     executor-relay (B) fee leg whose treasury is derived from the surfaced peer
 *     key. Priced from discovery (the origin cannot serve a remote /listing). The
 *     relay routes a non-local `target_agent` + proof to its `federatedP2pIntent`
 *     validator, which recomputes the same split + treasuries and rejects any leg
 *     mismatch — so client and relay cannot drift.
 *
 * Trust + safety:
 *   - The origin treasury (the A fee-leg recipient) is derived from
 *     `relayPublicKeyHex`, the key pinned at pairing — never from `/.well-known`
 *     or any fetched value — so the irreversible payment cannot be redirected by
 *     a MITM. The executor (B) treasury is derived from the peer key the PINNED
 *     origin relay vouches for in its discovery response, the same key it
 *     validates the forward against.
 *   - The fee rate is the one the relay DECLARES as `fee_rate` in its signed
 *     discovery metadata (spec/market-v1.md §5.1 — relays MAY set their own
 *     rate), trusted exactly like the treasury: only from metadata signed by
 *     the PINNED key (origin) or by the peer key the pinned origin vouches for
 *     (federated executor — each hop applies its own rate, relay-federation-v1
 *     §7.1). An absent field is the reference `PLATFORM_FEE_RATE`; unverifiable
 *     metadata or a malformed rate refuses before any payment
 *     (`relay_fee_rate_unverified`). See {@link fetchSignedRelayFeeRate}.
 *   - The payment is broadcast exactly once, then handed to `submitP2pDelegation`
 *     which never re-broadcasts on retry (no double-pay).
 *
 * Failure modes are explicit `DelegationErrorCode`s; nothing falls back to a
 * relay-custody path. Discovery is a public read; the listing read is
 * `market:listing`-audience authed.
 */
export interface ResolveP2pPaymentRequestParams {
  /** The delegator's identity (submitter / owner of the task). */
  motebitId: string;
  /** Base URL of the relay. */
  syncUrl: string;
  /** Mints audience-scoped auth tokens (the listing read needs `market:listing`). */
  authToken: (audience?: TokenAudience) => Promise<string>;
  /** Capability the worker must advertise — used to discover + select + price. */
  capability: string;
  /** Pin discovery to a SPECIFIC worker (fail-closed; never substitutes). */
  targetWorkerId?: string;
  /** First-person ranker for the UNPINNED case (see {@link WorkerSelector}). */
  selectWorker?: WorkerSelector;
  /** Cold-start acknowledgment for a new delegator↔worker pair. */
  acknowledgeNoHistoryRisk?: boolean;
  /** The relay's PINNED Ed25519 public key (hex) — treasury derives from THIS. */
  relayPublicKeyHex: string;
  /** Abort early. */
  signal?: AbortSignal;
}

export type ResolveP2pPaymentRequestResult =
  | {
      ok: true;
      /** The fully-priced atomic payment legs, ready to broadcast (or meter). */
      paymentRequest: SovereignP2pPaymentRequest;
      /** The selected worker's motebit_id — the submit target. */
      workerMotebitId: string;
      /** The selected worker's settlement address (the meter counterparty). */
      workerAddress: string;
    }
  | { ok: false; error: DelegationError };

/**
 * Resolve a P2P delegation's fully-priced payment request WITHOUT broadcasting
 * or submitting — discovery, pinned-treasury derivation, fee model, pricing,
 * and (single-operator) the pre-broadcast eligibility pre-flight. Extracted so
 * the two consumers share ONE discovery/pricing implementation: the live path
 * (`resolveAndSubmitP2pDelegation`, which then broadcasts + submits) and the
 * metered DRY-RUN path (`MotebitRuntime.executeGrantedDelegation`, which runs
 * the grant blast-radius meter over this `paymentRequest` and stops — no
 * broadcast, no submit, no fabricated receipt). A single resolver means the
 * dry-run meters the EXACT amount a live spend would.
 */
export async function resolveP2pPaymentRequest(
  params: ResolveP2pPaymentRequestParams,
): Promise<ResolveP2pPaymentRequestResult> {
  const { syncUrl, capability, motebitId } = params;

  // 1. Treasury from the PINNED relay key — the trust root, never fetched.
  let treasuryAddress: string;
  try {
    treasuryAddress = base58Encode(hexToBytes(params.relayPublicKeyHex));
  } catch (err: unknown) {
    return fail(
      "malformed_request",
      `Invalid pinned relay public key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2. Discover a payable worker (public read). Pick the first candidate that is
  //    not self, advertises p2p, and declares a settlement address. Capture the
  //    peer relay key — present ONLY for a direct-peer FEDERATED candidate (the
  //    origin attaches it from `relay_peers.public_key`) — and the discovery
  //    pricing, which is the only price source for a remote worker (the origin
  //    cannot serve a peer worker's /listing).
  let worker: {
    motebit_id: string;
    settlement_address: string;
    sourceRelayPublicKey?: string;
    sourceRelayId?: string;
    pricing: Array<{ capability?: string; unit_cost?: number }> | null;
  };
  try {
    const resp = await fetch(
      `${syncUrl}/api/v1/agents/discover?capability=${encodeURIComponent(capability)}`,
      { signal: params.signal },
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return {
        ok: false,
        error: classifyRelayError(resp.status, text, resp.headers.get("Retry-After")),
      };
    }
    const data = (await resp.json()) as {
      agents?: Array<{
        motebit_id: string;
        public_key?: string | null;
        settlement_address?: string | null;
        settlement_modes?: string | string[] | null;
        source_relay_public_key?: string | null;
        /** The hosting relay's relay_id — for a federated candidate, the peer. */
        source_relay?: string | null;
        pricing?: Array<{ capability?: string; unit_cost?: number }> | null;
        /** Relay-verified commitment bond (backing RPC-confirmed) — an
         * exploration-PRIORITY signal for the selector, never a gate. */
        bonded?: boolean | null;
      }>;
    };
    // HARD gates: not self, declares a settlement address, advertises p2p, and
    // — when pinned — is exactly that worker. These filter WHO is eligible.
    const admissible = (data.agents ?? []).filter((a) => {
      if (a.motebit_id === motebitId || a.settlement_address == null) return false;
      // Pinned hire: only the worker the user tapped is eligible — never
      // substitute another candidate for the same capability.
      if (params.targetWorkerId != null && a.motebit_id !== params.targetWorkerId) return false;
      const modes = Array.isArray(a.settlement_modes)
        ? a.settlement_modes
        : String(a.settlement_modes ?? "").split(",");
      return modes.includes("p2p");
    });

    // ORDER among the admissible. A pin already narrowed the set to that one
    // worker (deterministic override — never re-ranked). Unpinned with an
    // injected first-person selector: rank by the caller's OWN trust ledger and
    // hire the best (docs/doctrine/first-person-worker-routing.md). The selector
    // is never a gate — a null/unmatched result or an absent selector falls back
    // to the first admissible (discovery order), today's behavior. Only worth
    // ranking when more than one candidate survives the gates.
    let candidate = admissible[0];
    if (params.targetWorkerId == null && params.selectWorker != null && admissible.length > 1) {
      const priceFor = (a: (typeof admissible)[number]): number | undefined =>
        (a.pricing ?? []).find((p) => p.capability === capability)?.unit_cost ??
        (a.pricing ?? [])[0]?.unit_cost ??
        undefined;
      const chosenId = await params.selectWorker(
        admissible.map((a) => {
          const unitCost = priceFor(a);
          return {
            motebit_id: a.motebit_id,
            ...(unitCost != null ? { unitCost } : {}),
            ...(a.bonded === true ? { bonded: true } : {}),
          };
        }),
      );
      if (chosenId != null) {
        const chosen = admissible.find((a) => a.motebit_id === chosenId);
        if (chosen != null) candidate = chosen;
      }
    }
    if (candidate?.settlement_address == null) {
      return fail(
        "no_routing",
        params.targetWorkerId != null
          ? `Pinned worker "${params.targetWorkerId}" is not P2P-eligible for "${capability}".`
          : `No P2P-capable worker advertises "${capability}".`,
      );
    }

    // SETTLEMENT-AUTHORITY BINDING at the payer, BEFORE broadcast — the seam that
    // protects the DELEGATOR's funds (the relay's own check runs post-broadcast,
    // too late to prevent loss). A FEDERATED candidate (`source_relay_public_key`
    // set ⇒ hosted on a peer) carries a settlement address ASSERTED BY THAT PEER,
    // with no authed registration on our own relay proving the worker chose it —
    // so a malicious peer could redirect the worker's payments. Bind it
    // fail-closed: the peer-forwarded key must sovereign-bind to the worker's
    // motebit_id AND the address must derive from it. A LOCAL candidate's address
    // is authed by our own relay (the worker set it) — trusted, no check, so
    // custody separation stays legitimate. Non-bindable federated workers refuse
    // pre-broadcast (no funds move) until the signed/anchored rung ships (Inc 2/3).
    // docs/doctrine/settlement-authority-binding.md.
    if (candidate.source_relay_public_key != null) {
      const bound =
        candidate.public_key != null &&
        isDerivedSolanaSettlement(candidate.settlement_address, candidate.public_key) &&
        (await verifySovereignBinding(candidate.motebit_id, candidate.public_key));
      if (!bound) {
        return fail(
          "worker_settlement_unbound",
          `Federated worker "${candidate.motebit_id}" settlement address is not identity-bound; refusing to pay a peer-asserted destination.`,
        );
      }
    }
    worker = {
      motebit_id: candidate.motebit_id,
      settlement_address: candidate.settlement_address,
      ...(candidate.source_relay_public_key != null
        ? { sourceRelayPublicKey: candidate.source_relay_public_key }
        : {}),
      ...(candidate.source_relay != null ? { sourceRelayId: candidate.source_relay } : {}),
      pricing: candidate.pricing ?? null,
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return fail("timeout", "Aborted during discovery");
    }
    return fail("network_unreachable", err instanceof Error ? err.message : String(err));
  }

  // 3. Build the atomic payment's legs. Two fee models, selected by whether the
  //    worker lives on THIS relay (local) or a direct peer (federated):
  //      - LOCAL single-operator — fee is ON TOP of unit_cost (computeP2pFeeMicro);
  //        2 legs (worker + origin-fee). Priced from the worker's /listing.
  //      - FEDERATED cross-operator — unit_cost IS the budget; the fee comes OUT
  //        of it and splits 3 ways (computeFederatedFeeSplit, spec §7.1). A 3rd
  //        leg pays the executor relay (B) treasury, derived from the peer key
  //        the origin surfaced in discovery — `base58Encode(peer pubkey)` is
  //        exactly the `deriveSolanaAddress` the origin recomputes when it
  //        validates the forward, so the two cannot disagree. Priced from
  //        discovery (the origin cannot serve a remote /listing).
  let paymentRequest: SovereignP2pPaymentRequest;
  if (worker.sourceRelayPublicKey != null) {
    let executorTreasuryAddress: string;
    try {
      executorTreasuryAddress = base58Encode(hexToBytes(worker.sourceRelayPublicKey));
    } catch (err: unknown) {
      return fail(
        "malformed_request",
        `Invalid peer relay public key in discovery: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const priced =
      (worker.pricing ?? []).find((p) => p.capability === capability) ?? (worker.pricing ?? [])[0];
    if (priced?.unit_cost == null || priced.unit_cost <= 0) {
      return fail("worker_not_payable", `Remote worker has no positive price for "${capability}".`);
    }
    // Each hop's rate from THAT hop's signed metadata (relay-federation-v1
    // §7.1): the origin's under the PINNED key; the executor's under the peer
    // key the pinned origin vouches for, at the endpoint the pinned origin
    // lists for that peer in its own signed `federation_peers`.
    const origin = await fetchSignedRelayFeeRate({
      relayUrl: syncUrl,
      expectedKeyHex: params.relayPublicKeyHex,
      ...(params.signal != null ? { signal: params.signal } : {}),
    });
    if (!origin.ok) return origin;
    const peerEntry =
      worker.sourceRelayId != null
        ? (origin.metadata.federation_peers ?? []).find((p) => p.relay_id === worker.sourceRelayId)
        : undefined;
    if (peerEntry == null || typeof peerEntry.endpoint_url !== "string") {
      return fail(
        "relay_fee_rate_unverified",
        `The executor relay hosting "${worker.motebit_id}" is not a peer in the origin relay's signed metadata; its fee rate cannot be verified.`,
      );
    }
    const executor = await fetchSignedRelayFeeRate({
      relayUrl: peerEntry.endpoint_url.replace(/\/+$/, ""),
      expectedKeyHex: worker.sourceRelayPublicKey,
      expectedRelayId: peerEntry.relay_id,
      ...(params.signal != null ? { signal: params.signal } : {}),
    });
    if (!executor.ok) return executor;
    const budgetMicro = toMicro(priced.unit_cost);
    const split = computeFederatedFeeSplit(budgetMicro, origin.feeRate, executor.feeRate);
    paymentRequest = {
      workerAddress: worker.settlement_address,
      amountMicro: split.workerNetMicro,
      treasuryAddress,
      feeAmountMicro: split.originFeeMicro,
      executorTreasuryAddress,
      executorFeeAmountMicro: split.executorFeeMicro,
    };
  } else {
    // 3a. PRE-FLIGHT eligibility BEFORE the irreversible broadcast (single-op
    //     only — a federated worker has no eligibility gate at its forward site).
    //     The dedicated caller-bound /p2p-eligibility read returns the SAME
    //     decision the submission gate enforces; bail WITHOUT broadcasting
    //     (p2p_ineligible → relay-mode fallback in selectAndRunDelegation),
    //     closing the broadcast-then-403 fund-loss window.
    //     `acknowledge_no_history_risk` mirrors the submission body so pre-flight
    //     and submit agree.
    //
    //     FAIL CLOSED on the irreversible money path: we broadcast ONLY on an
    //     explicit `allowed: true`. A non-200 (older relay missing the endpoint),
    //     an unparseable body, or a network error means we CANNOT confirm
    //     eligibility — so we do NOT move funds; we return p2p_ineligible and let
    //     selectAndRunDelegation degrade to relay-mode. Trading P2P availability
    //     for never paying a worker the relay would reject is the correct call
    //     when the payment is irreversible (metabolic principle: deny on error).
    let preflightAllowed = false;
    // The pre-flight ALSO returns the canonical expected amounts (worker leg +
    // fee) — the SAME figures the submission gate validates. Preferring them
    // makes the relay the single source of truth for the payment, closing the
    // amount-mismatch fund-loss window that client-side listing arithmetic
    // (the dollars-vs-micro unit boundary) can open. Absent on an older relay →
    // fall through to the listing read below.
    let preflightAmountMicro: number | undefined;
    let preflightFeeMicro: number | undefined;
    try {
      const eligToken = await params.authToken("market:listing");
      const q = new URLSearchParams();
      if (params.acknowledgeNoHistoryRisk === true) q.set("acknowledge_no_history_risk", "true");
      if (capability) q.set("capability", capability);
      const qs = q.toString() ? `?${q.toString()}` : "";
      const resp = await fetch(
        `${syncUrl}/api/v1/agents/${worker.motebit_id}/p2p-eligibility${qs}`,
        { headers: { Authorization: `Bearer ${eligToken}` }, signal: params.signal },
      );
      if (resp.ok) {
        const data = (await resp.json()) as {
          allowed?: boolean;
          reason?: string;
          expected_amount_micro?: number;
          expected_fee_micro?: number;
        };
        if (data.allowed !== true) {
          return fail("p2p_ineligible", data.reason ?? "Not P2P-eligible for this worker");
        }
        preflightAllowed = true;
        preflightAmountMicro = data.expected_amount_micro;
        preflightFeeMicro = data.expected_fee_micro;
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        return fail("timeout", "Aborted during eligibility pre-flight");
      }
      // Fall through to the fail-closed guard below — never broadcast on a
      // pre-flight we couldn't complete.
    }
    if (!preflightAllowed) {
      return fail(
        "p2p_ineligible",
        "P2P eligibility could not be confirmed (pre-flight unavailable) — refusing to broadcast an unconfirmed payment.",
      );
    }

    // Prefer the relay's canonical amounts from the pre-flight — pay EXACTLY
    // what the submission gate validates, with no client-side unit math. The
    // separate listing read (3c) is the fallback for an older relay that didn't
    // return them.
    if (preflightAmountMicro != null && preflightAmountMicro > 0 && preflightFeeMicro != null) {
      return {
        ok: true,
        paymentRequest: {
          workerAddress: worker.settlement_address,
          amountMicro: preflightAmountMicro,
          treasuryAddress,
          feeAmountMicro: preflightFeeMicro,
        },
        workerMotebitId: worker.motebit_id,
        workerAddress: worker.settlement_address,
      };
    }

    // 3b. The relay's declared fee rate, from metadata signed by the PINNED
    //     key — before the listing read, so an unverifiable rate refuses
    //     before anything is priced.
    const declared = await fetchSignedRelayFeeRate({
      relayUrl: syncUrl,
      expectedKeyHex: params.relayPublicKeyHex,
      ...(params.signal != null ? { signal: params.signal } : {}),
    });
    if (!declared.ok) return declared;

    // 3c. Price from the worker's listing (market:listing-audience read).
    let unitCost: number;
    try {
      const listingToken = await params.authToken("market:listing");
      const resp = await fetch(`${syncUrl}/api/v1/agents/${worker.motebit_id}/listing`, {
        headers: { Authorization: `Bearer ${listingToken}` },
        signal: params.signal,
      });
      if (resp.status === 404) {
        return fail("worker_not_payable", "Worker has no service listing.");
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return {
          ok: false,
          error: classifyRelayError(resp.status, text, resp.headers.get("Retry-After")),
        };
      }
      const data = (await resp.json()) as {
        pricing?: Array<{ capability?: string; unit_cost?: number }>;
      };
      const entry =
        (data.pricing ?? []).find((p) => p.capability === capability) ?? (data.pricing ?? [])[0];
      if (entry?.unit_cost == null || entry.unit_cost <= 0) {
        return fail("worker_not_payable", `Worker has no positive price for "${capability}".`);
      }
      unitCost = entry.unit_cost;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        return fail("timeout", "Aborted during pricing");
      }
      return fail("network_unreachable", err instanceof Error ? err.message : String(err));
    }
    // Worker net = unit_cost; fee = computeP2pFeeMicro (the SAME primitive the
    // relay validator uses, at the relay's signed declared rate). Pinned treasury.
    const amountMicro = toMicro(unitCost);
    paymentRequest = {
      workerAddress: worker.settlement_address,
      amountMicro,
      treasuryAddress,
      feeAmountMicro: computeP2pFeeMicro(amountMicro, declared.feeRate),
    };
  }

  return {
    ok: true,
    paymentRequest,
    workerMotebitId: worker.motebit_id,
    workerAddress: worker.settlement_address,
  };
}

export async function resolveAndSubmitP2pDelegation(
  params: ResolveAndSubmitP2pDelegationParams,
): Promise<DelegationResult> {
  if (params.buildP2pPayment == null) {
    return fail(
      "no_sovereign_rail",
      "Paid direct delegation needs a sovereign wallet rail that can build an atomic payment.",
    );
  }

  // 1–3. Discover + price the worker into a ready-to-broadcast payment request.
  const resolved = await resolveP2pPaymentRequest({
    motebitId: params.motebitId,
    syncUrl: params.syncUrl,
    authToken: params.authToken,
    capability: params.capability,
    relayPublicKeyHex: params.relayPublicKeyHex,
    ...(params.targetWorkerId != null ? { targetWorkerId: params.targetWorkerId } : {}),
    ...(params.selectWorker != null ? { selectWorker: params.selectWorker } : {}),
    ...(params.acknowledgeNoHistoryRisk === true ? { acknowledgeNoHistoryRisk: true } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (!resolved.ok) return { ok: false, error: resolved.error };

  // 3a-bis. Paid-intent interlock — BEFORE any broadcast. If a prior payment
  //         to this worker+capability settled onchain and its result was never
  //         retrieved, a new delegation would buy the same work twice; refuse
  //         mechanically instead of trusting the caller to have read the
  //         PAYMENT_ALREADY_SETTLED message (#435/#436 — on the granted path
  //         there is no human between a retry loop and real money). The same
  //         lock covers a payment the relay never admitted and one whose
  //         landing could not be confirmed (#885).
  if (params.paidIntentLedger != null) {
    const verdict = params.paidIntentLedger.check(resolved.workerMotebitId, params.capability);
    if (verdict.locked) {
      const prior = verdict.prior;
      return {
        ok: false,
        error: {
          code: "intent_already_paid",
          message:
            verdict.scope === "pair"
              ? `${describePriorPayment(prior)} Refused before broadcast — no new money moved. ` +
                `${priorRemedy(prior)}; do not re-hire.`
              : `${params.paidIntentLedger.outstandingCount} paid delegations ` +
                (params.paidIntentLedger
                  .outstanding()
                  .every((e) => !isPaymentWithoutTaskId(e.taskId))
                  ? `have settled onchain without delivering results`
                  : `are outstanding (paid, and not delivered or not admitted)`) +
                ` — all new paid delegation is suspended until they are retrieved or dismissed. ` +
                `Refused before broadcast — no new money moved. Oldest: ` +
                `${describePriorPayment(prior)} ${priorRemedy(prior)}.`,
          settledPayment: {
            txHash: prior.txHash,
            paidMicro: prior.paidMicro,
            feeMicro: prior.feeMicro,
            taskId: prior.taskId,
          },
        },
      };
    }
  }

  // 3b. Budget ceiling — enforced on the RESOLVED total (worker + all fee
  //     legs), before any irreversible broadcast. The relay's price is the
  //     truth being checked, so client-side listing math can't under-guard.
  if (params.maxTotalMicro != null) {
    const totalMicro =
      resolved.paymentRequest.amountMicro +
      resolved.paymentRequest.feeAmountMicro +
      (resolved.paymentRequest.executorFeeAmountMicro ?? 0);
    if (totalMicro > params.maxTotalMicro) {
      return fail(
        "budget_exceeded",
        `Resolved payment total ${totalMicro} micro (worker + fees) exceeds the budget ceiling ${params.maxTotalMicro} micro — nothing was broadcast.`,
      );
    }
  }

  // 4. Sign, record, THEN send (#885). The builder reports each transaction
  //    it signs through `beforeBroadcast`, before sending it. The payment is
  //    written to the ledger under that exact signature at that moment — so
  //    it is on record before money can move — and a later throw is resolved
  //    by asking the chain about THAT transaction, never by looking for "a
  //    transaction that pays these legs" (a concurrent same-worker hire pays
  //    an identical leg set). A record that cannot be written stops the send.
  const ledger = params.paidIntentLedger;
  const request = resolved.paymentRequest;
  const paidMicro = request.amountMicro;
  const feeMicro = request.feeAmountMicro + (request.executorFeeAmountMicro ?? 0);
  const now = params.now ?? Date.now;
  const confirm = params.confirmP2pPayment;
  const entry = (txHash: string) => ({
    workerMotebitId: resolved.workerMotebitId,
    capability: params.capability,
    txHash,
    paidMicro,
    feeMicro,
    recordedAt: now(),
  });
  const signed: SignedP2pTransaction[] = [];
  // A holder, not a `let`: the hook writes it from inside a closure.
  const recordState: { failure: string | null } = { failure: null };
  const hooks: P2pBroadcastHooks = {
    beforeBroadcast: (tx) => {
      if (ledger != null) {
        try {
          ledger.recordBroadcast(entry(tx.signature));
        } catch (err: unknown) {
          recordState.failure = err instanceof Error ? err.message : String(err);
          params.logger.warn("paid_intent_ledger.write_failed", {
            op: "record_broadcast",
            taskId: paymentEntryId(tx.signature),
            txHash: tx.signature,
            error: recordState.failure,
          });
          throw new Error(`payment not sent: it could not be recorded (${recordState.failure})`, {
            cause: err,
          });
        }
      }
      signed.push(tx);
    },
  };

  let proof: P2pPaymentProof;
  try {
    proof = await params.buildP2pPayment(request, hooks);
  } catch (err: unknown) {
    // The grant blast-radius meter (wrapP2pPaymentWithMeter) throws BEFORE
    // broadcast on an over-ceiling / replay / unmeterable spend. Surface the
    // typed denial code — owner-safe (the overage quantity never rides here).
    if (err instanceof Error && err.name === "MoneyMeterDeniedError") {
      const denial = (err as { denial?: string }).denial;
      return {
        ok: false,
        error: {
          code: "money_meter_denied",
          message: err.message,
          ...(denial != null ? { denial } : {}),
        },
      };
    }
    // wallet-solana surfaces a funds shortfall as InsufficientUsdcBalanceError,
    // thrown only before any transaction is signed (adapter.ts contract).
    if (err instanceof Error && err.name === "InsufficientUsdcBalanceError") {
      return fail("insufficient_balance", err.message);
    }
    const errMessage = err instanceof Error ? err.message : String(err);

    // A rail that reports its signed transactions (it has a confirmer) and
    // reported none signed nothing — so it sent nothing.
    if (confirm != null && signed.length === 0) {
      return fail(
        "payment_broadcast_failed",
        recordState.failure != null
          ? `The payment could not be recorded before sending, so it was not sent — no funds ` +
              `moved (${recordState.failure}).`
          : `The payment failed before any transaction was signed — nothing was sent: ${errMessage}`,
      );
    }

    const verdict: OwnVerdict =
      confirm == null
        ? { status: "unknown", reason: "this wallet cannot confirm a failed payment", absent: [] }
        : await confirmOwnTransactions({
            confirm,
            request,
            transactions: signed,
            maxWaitMs: params.paymentConfirmMaxWaitMs ?? DEFAULT_PAYMENT_CONFIRM_MAX_WAIT_MS,
            now,
            sleep: params.sleep ?? defaultSleep,
          });
    if (verdict.status === "absent") {
      // Every transaction this hire signed is authoritatively dead: nothing
      // moved, and their entries stop locking.
      for (const tx of signed) voidEntry(ledger, params.logger, tx.signature);
      return fail(
        "payment_broadcast_failed",
        `P2P payment failed to broadcast, and the chain confirms its transaction can never ` +
          `land — no funds moved: ${errMessage}`,
      );
    }
    if (verdict.status === "unknown") {
      // Money MAY have left the wallet. Keep it on record — this session, a
      // restarted one, the granted path all refuse to pay for this intent
      // again until the owner reconciles the wallet. Never retried here.
      let ledgerId: string | undefined;
      let durable = true;
      if (ledger != null) {
        const open = signed.filter((tx) => !verdict.absent.includes(tx.signature));
        for (const tx of signed) {
          if (verdict.absent.includes(tx.signature)) voidEntry(ledger, params.logger, tx.signature);
        }
        if (open.length > 0) {
          for (const tx of open) {
            durable =
              recordOwed(ledger, params.logger, {
                ...entry(tx.signature),
                taskId: paymentEntryId(tx.signature),
              }) && durable;
          }
          ledgerId = paymentEntryId(open[0]!.signature);
        } else {
          // No transaction known (a rail without a confirmer).
          const rec = ledger.recordUnconfirmed({
            workerMotebitId: resolved.workerMotebitId,
            capability: params.capability,
            paidMicro,
            feeMicro,
            recordedAt: now(),
          });
          ledgerId = rec.taskId;
          if (!rec.durable) {
            durable = false;
            params.logger.warn("paid_intent_ledger.write_failed", {
              op: "record_unconfirmed",
              taskId: rec.taskId,
              txHash: "unknown",
            });
          }
        }
      }
      params.logger.warn("delegation.p2p_payment_status_unknown", {
        workerMotebitId: resolved.workerMotebitId,
        capability: params.capability,
        paidMicro,
        feeMicro,
        reason: verdict.reason,
        error: errMessage,
        transactions: signed.map((t) => t.signature),
        ...(ledgerId != null ? { ledgerId } : {}),
      });
      return {
        ok: false,
        error: {
          code: "payment_status_unknown",
          message:
            `The P2P payment failed (${errMessage}) and the chain could not say whether its ` +
            `transaction landed (${verdict.reason}). Money may have left the wallet. Nothing ` +
            `was submitted and nothing will be sent again for this hire — check the wallet's ` +
            `history before paying this worker again` +
            (ledgerId != null ? ` (then /result dismiss ${ledgerId}).` : ".") +
            (durable ? "" : NOT_DURABLE_NOTE),
          ...(durable ? {} : { ledgerWriteFailed: true as const, notice: NOT_DURABLE_NOTE.trim() }),
          unconfirmedPayment: {
            paidMicro,
            feeMicro,
            ...(ledgerId != null ? { ledgerId } : {}),
            reason: verdict.reason,
          },
        },
      };
    }
    // Landed: THIS hire's own transaction went through despite the error —
    // proceed with it, exactly as if the builder had returned it.
    proof = verdict.proof;
    for (const tx of signed) {
      if (tx.signature !== proof.tx_hash) voidEntry(ledger, params.logger, tx.signature);
    }
    params.logger.warn("delegation.p2p_payment_landed_despite_error", {
      txHash: proof.tx_hash,
      error: errMessage,
    });
  }

  // 4a. The builder returned. Its proof must be one of the transactions it
  //     reported (and recorded) before sending. Any OTHER transaction it
  //     signed (a re-sign after a blockhash expiry) is asked about by its own
  //     signature: voided only if the chain says it is dead; otherwise it is
  //     recorded as owed and reported on the result (`extraPayments`) — the
  //     wallet may have paid twice, and the owner must hear it. A rail that
  //     does not report its transactions is recorded now — late, but the
  //     money fact is kept.
  const paidTx = proof.tx_hash;
  const extraPayments: Array<{ txHash: string; status: "landed" | "unconfirmed" }> = [];
  let extrasDurable = true;
  if (signed.some((tx) => tx.signature === paidTx)) {
    for (const tx of signed) {
      if (tx.signature === paidTx) continue;
      // Asked, not assumed: only a transaction the chain calls dead is voided.
      let v: P2pPaymentConfirmation = { status: "unknown", reason: "no confirmer" };
      if (confirm != null) {
        try {
          v = await confirm({ request, transaction: tx });
        } catch (err: unknown) {
          v = { status: "unknown", reason: err instanceof Error ? err.message : String(err) };
        }
      }
      if (v.status === "absent") {
        voidEntry(ledger, params.logger, tx.signature);
      } else {
        // A second transaction from this hire may have moved money — never
        // voided, always recorded, and told to the caller (#885 round 3).
        params.logger.warn("delegation.p2p_extra_transaction_unresolved", {
          paidTx,
          txHash: tx.signature,
          status: v.status,
        });
        extraPayments.push({
          txHash: tx.signature,
          status: v.status === "landed" ? "landed" : "unconfirmed",
        });
        if (ledger != null) {
          extrasDurable =
            recordOwed(ledger, params.logger, {
              ...entry(tx.signature),
              taskId: paymentEntryId(tx.signature),
            }) && extrasDurable;
        }
      }
    }
  } else if (ledger != null) {
    ledgerWrite(params.logger, "record_broadcast", paymentEntryId(paidTx), paidTx, () =>
      ledger.recordBroadcast(entry(paidTx)),
    );
  }

  // 5. Submit the pre-built proof (retries resubmit the SAME proof; never
  //    re-broadcasts).
  const paidProof = proof;
  const submitted = await submitP2pDelegation({
    motebitId: params.motebitId,
    syncUrl: params.syncUrl,
    authToken: params.authToken,
    prompt: params.prompt,
    targetWorkerId: resolved.workerMotebitId,
    // The relay needs the capability to locate + price a federated worker on its
    // operator; pinned via the same capability used for discovery.
    requiredCapabilities: [params.capability],
    ...(params.acknowledgeNoHistoryRisk === true ? { acknowledgeNoHistoryRisk: true } : {}),
    paymentProof: paidProof,
    ...(params.invocationOrigin ? { invocationOrigin: params.invocationOrigin } : {}),
    ...(params.grantId != null ? { grantId: params.grantId } : {}),
    ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
    ...(params.submitRetry != null ? { submitRetry: params.submitRetry } : {}),
    logger: params.logger,
    ...(params.signal ? { signal: params.signal } : {}),
    // 5a. The relay admitted the task (#874 review, #885): the task entry
    //     takes over from the broadcast entry and reads "paid, result
    //     pending" from this moment. A process that dies mid-poll leaves it
    //     on record; the next session refuses a re-hire and `/result` can
    //     recover the work. Resolved below on delivery. The entry is IN
    //     FLIGHT: it locks nothing for this session (concurrent hires
    //     proceed as before the ledger existed), and any later session
    //     reads it as unretrieved.
    ...(ledger != null
      ? {
          onTaskAccepted: (taskId: string) =>
            ledgerWrite(params.logger, "record_in_flight", taskId, paidProof.tx_hash, () =>
              ledger.admitted(paidProof.tx_hash, {
                workerMotebitId: resolved.workerMotebitId,
                capability: params.capability,
                taskId,
                txHash: paidProof.tx_hash,
                paidMicro: paidProof.amount_micro,
                feeMicro: paidProof.fee_amount_micro + (paidProof.b_fee_amount_micro ?? 0),
                recordedAt: now(),
              }),
            ),
        }
      : {}),
  });

  // 6. Delivered ⇒ the work is no longer outstanding. A poll that ended
  //    without the result moves the task entry to UNRETRIEVED, and a
  //    submission the relay never admitted moves the broadcast entry
  //    (`p2p-payment:<tx>`, carried as `settledPayment.taskId`) to
  //    UNRETRIEVED — either way the pair lock and the suspend count now
  //    apply, in this session and every later one. Ledger writes never
  //    abort a paid flow: a failed write is logged loudly and the result —
  //    or the settlement carried on the error — is returned regardless.
  if (ledger != null && submitted.ok) {
    ledgerWrite(params.logger, "resolve", submitted.taskId, paidProof.tx_hash, () => {
      ledger.resolve(submitted.taskId);
    });
  }
  let owedDurable = true;
  if (ledger != null && !submitted.ok && submitted.error.settledPayment != null) {
    const sp = submitted.error.settledPayment;
    owedDurable = recordOwed(ledger, params.logger, {
      workerMotebitId: resolved.workerMotebitId,
      capability: params.capability,
      taskId: sp.taskId,
      txHash: sp.txHash,
      paidMicro: sp.paidMicro,
      feeMicro: sp.feeMicro,
      recordedAt: now(),
    });
  }
  return withExtraPayments(submitted, extraPayments, extrasDurable && owedDurable);
}

/**
 * The `payment_notice` stream chunk for a result that carries a money
 * warning (#885), or null. One builder for every door that streams.
 */
export function paymentNoticeChunk(result: DelegationResult): {
  type: "payment_notice";
  notice: string;
  extra_payments?: Array<{ tx_hash: string; status: "landed" | "unconfirmed" }>;
  ledger_write_failed?: true;
} | null {
  const src = result.ok ? result.settlement : result.error;
  if (src?.notice == null || src.notice === "") return null;
  return {
    type: "payment_notice",
    notice: src.notice,
    ...(src.extraPayments != null
      ? { extra_payments: src.extraPayments.map((x) => ({ tx_hash: x.txHash, status: x.status })) }
      : {}),
    ...(src.ledgerWriteFailed === true ? { ledger_write_failed: true as const } : {}),
  };
}

/**
 * The `default:` of a `switch (chunk.type)` over stream chunks (#885):
 * accepts every chunk EXCEPT `payment_notice`, so a consumer that forgets
 * to render the money warning fails to compile instead of dropping it.
 */
export function ignoreChunk(
  _chunk: Exclude<StreamChunkForNotice, { type: "payment_notice" }>,
): void {
  // Deliberately nothing — the point is the parameter type.
}

type StreamChunkForNotice = import("./runtime-config.js").StreamChunk;

/**
 * The owner-facing line for a `payment_notice` chunk (#885) — one short
 * system message, shared by every surface so the copy cannot drift.
 */
export function paymentNoticeCopy(chunk: {
  notice: string;
  extra_payments?: ReadonlyArray<{ tx_hash: string; status: "landed" | "unconfirmed" }>;
  ledger_write_failed?: true;
}): string {
  const parts: string[] = [];
  const extras = chunk.extra_payments ?? [];
  if (extras.length > 0) {
    const txs = extras.map((x) => `${x.tx_hash.slice(0, 8)}…`).join(", ");
    parts.push(
      `Your wallet also sent ${extras.length === 1 ? "another payment" : `${extras.length} other payments`} ` +
        `(tx ${txs}) that no task accounts for. Check your wallet before hiring again.`,
    );
  }
  if (chunk.ledger_write_failed === true) {
    parts.push(
      "A payment couldn't be saved to this device's record — reconcile it before restarting.",
    );
  }
  return parts.length > 0 ? parts.join(" ") : chunk.notice;
}

/**
 * Appended to a result's message when a payment owed could not be written
 * to the durable ledger (#885 round 3): the lock is held in memory for this
 * process only, so the owner must reconcile before restarting.
 */
const NOT_DURABLE_NOTE =
  " This payment could NOT be written to the local payment record: paid hiring of this " +
  "worker is held only while this process runs — reconcile it before restarting.";

/**
 * Record a payment as owed, fail-CLOSED: a durable write that throws leaves
 * an in-memory lock for the process lifetime (`PaidIntentLedger.recordOwed`)
 * and is logged loudly. Returns whether the write was durable.
 */
function recordOwed(
  ledger: PaidIntentLedger,
  logger: { warn(message: string, context?: Record<string, unknown>): void },
  e: {
    workerMotebitId: string;
    capability: string;
    taskId: string;
    txHash: string;
    paidMicro: number;
    feeMicro: number;
    recordedAt: number;
  },
): boolean {
  const durable = ledger.recordOwed(e);
  if (!durable) {
    logger.warn("paid_intent_ledger.write_failed", {
      op: "record_unretrieved",
      taskId: e.taskId,
      txHash: e.txHash,
      heldInMemory: true,
    });
  }
  return durable;
}

/**
 * Carry, on whatever the submit returned, (a) any OTHER transaction this
 * hire sent that may have moved money, and (b) a failed durable write — so
 * the caller, the model and the owner are told, never just a log line.
 */
function withExtraPayments(
  result: DelegationResult,
  extras: ReadonlyArray<{ txHash: string; status: "landed" | "unconfirmed" }>,
  durable: boolean,
): DelegationResult {
  if (extras.length === 0 && durable) return result;
  const extraNote =
    extras.length === 0
      ? ""
      : ` This hire's wallet ALSO sent ${extras.length === 1 ? "another payment" : `${extras.length} other payments`} ` +
        `(${extras.map((x) => `tx ${x.txHash}, ${x.status}`).join("; ")}) that no relay task ` +
        `accounts for — reconcile it against the wallet; do not hire again to fix it.`;
  if (result.ok) {
    return {
      ...result,
      settlement: {
        ...(result.settlement ?? { mode: "p2p" as const }),
        ...(extras.length > 0 ? { extraPayments: [...extras] } : {}),
        ...(durable ? {} : { ledgerWriteFailed: true as const }),
        ...(extraNote !== "" || !durable
          ? { notice: `${extraNote}${durable ? "" : NOT_DURABLE_NOTE}`.trim() }
          : {}),
      },
    };
  }
  return {
    ok: false,
    error: {
      ...result.error,
      message: `${result.error.message}${extraNote}${durable ? "" : NOT_DURABLE_NOTE}`,
      notice: `${extraNote}${durable ? "" : NOT_DURABLE_NOTE}`.trim(),
      ...(extras.length > 0 ? { extraPayments: [...extras] } : {}),
      ...(durable ? {} : { ledgerWriteFailed: true as const }),
    },
  };
}

/** "What was paid, and where it stands" for a prior ledger entry. */
function describePriorPayment(prior: {
  capability: string;
  taskId: string;
  txHash: string;
}): string {
  if (isPaymentWithoutTaskId(prior.taskId)) {
    return (
      `A payment to this worker for "${prior.capability}" may already have moved money ` +
      `(${prior.txHash === "unknown" ? "transaction unknown" : `tx ${prior.txHash}`}) and no ` +
      `relay task is confirmed for it (${prior.taskId}).`
    );
  }
  return (
    `A payment to this worker for "${prior.capability}" already settled onchain ` +
    `(tx ${prior.txHash}) and its result was never retrieved (task ${prior.taskId}).`
  );
}

/** The free next step for a prior ledger entry — never a re-hire. */
function priorRemedy(prior: { taskId: string }): string {
  if (isPaymentWithoutTaskId(prior.taskId)) {
    return (
      `There is no confirmed relay task to fetch; reconcile the payment against the wallet, ` +
      `then clear it with /result dismiss ${prior.taskId}`
    );
  }
  return `Re-fetch that task for free (retrieve_task_result, or /result ${prior.taskId})`;
}

/**
 * The payment entry of a transaction this hire signed, now known never to
 * move money (it expired or failed onchain), stops locking. Never aborts.
 */
function voidEntry(
  ledger: PaidIntentLedger | undefined,
  logger: { warn(message: string, context?: Record<string, unknown>): void },
  signature: string,
): void {
  if (ledger == null) return;
  ledgerWrite(logger, "void_unsent", paymentEntryId(signature), signature, () => {
    ledger.voidUnsent(signature);
  });
}

type OwnVerdict =
  | { status: "landed"; proof: P2pPaymentProof }
  | { status: "absent" }
  | { status: "unknown"; reason: string; absent: string[] };

/**
 * After `buildP2pPayment` threw (#885): ask the chain about the
 * transactions THIS hire signed — each by its own signature, nothing else.
 * A pending transaction is asked about again until `maxWaitMs` has passed.
 *
 *   - exactly one landed (and paying exactly the request), the rest dead ⇒ `landed`;
 *   - every one dead (expired, or failed onchain) ⇒ `absent`;
 *   - anything else — an RPC error, still pending at the end of the wait, a
 *     lookup that throws, a landed transaction that is not the requested
 *     payment, two landed ⇒ `unknown`: the caller must not pay again.
 */
async function confirmOwnTransactions(args: {
  confirm: ConfirmP2pPayment;
  request: SovereignP2pPaymentRequest;
  transactions: readonly SignedP2pTransaction[];
  maxWaitMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): Promise<OwnVerdict> {
  const deadline = args.now() + args.maxWaitMs;
  const landed: P2pPaymentProof[] = [];
  const absent: string[] = [];
  const undecided: string[] = [];
  for (const tx of args.transactions) {
    let final: P2pPaymentConfirmation | null = null;
    // Sticky pending (#885 round 5): once a look has seen this transaction
    // in a block, a later `absent` for it is not believed — it stays
    // pending until it lands or the wait ends (⇒ unknown).
    let seen = false;
    for (let look = 0; look < MAX_CONFIRM_LOOKS; look++) {
      let v: P2pPaymentConfirmation;
      try {
        v = await args.confirm({ request: args.request, transaction: tx });
      } catch (err: unknown) {
        v = { status: "unknown", reason: err instanceof Error ? err.message : String(err) };
      }
      if (v.status === "pending" && v.seen === true) seen = true;
      if (v.status === "absent" && seen) {
        v = { status: "pending", recheckAtMs: args.now() + 5_000, seen: true };
      }
      if (v.status !== "pending") {
        final = v;
        break;
      }
      if (v.recheckAtMs > deadline) break;
      await args.sleep(Math.max(0, v.recheckAtMs - args.now()));
    }
    if (final?.status === "absent") absent.push(tx.signature);
    else if (
      final?.status === "landed" &&
      final.proof.tx_hash === tx.signature &&
      proofMatchesRequest(final.proof, args.request)
    ) {
      landed.push(final.proof);
    } else {
      undecided.push(
        `${tx.signature}: ${final == null ? "still unconfirmed when the wait ended" : final.status === "unknown" ? final.reason : "landed, but not the requested payment"}`,
      );
    }
  }
  if (undecided.length === 0 && landed.length === 0) return { status: "absent" };
  if (undecided.length === 0 && landed.length === 1) return { status: "landed", proof: landed[0]! };
  return {
    status: "unknown",
    reason:
      undecided.length > 0
        ? undecided.join("; ")
        : `${landed.length} of this hire's transactions landed`,
    absent,
  };
}

/** Does a recovered proof pay exactly the requested legs? */
function proofMatchesRequest(proof: P2pPaymentProof, request: SovereignP2pPaymentRequest): boolean {
  return (
    typeof proof.tx_hash === "string" &&
    proof.tx_hash.length > 0 &&
    proof.to_address === request.workerAddress &&
    proof.amount_micro === request.amountMicro &&
    proof.fee_to_address === request.treasuryAddress &&
    proof.fee_amount_micro === request.feeAmountMicro &&
    (proof.b_fee_to_address ?? null) === (request.executorTreasuryAddress ?? null) &&
    (proof.b_fee_amount_micro ?? null) === (request.executorFeeAmountMicro ?? null)
  );
}

/**
 * Run one paid-intent ledger write without letting it abort the paid flow
 * around it (#874 review). The money has already moved when every caller
 * runs; a SQLITE_BUSY or a full disk must cost the note, never the poll or
 * the settlement facts the caller returns. Logged loudly with the task and
 * transaction so the payment can be reconciled by hand.
 */
function ledgerWrite(
  logger: { warn(message: string, context?: Record<string, unknown>): void },
  op: string,
  taskId: string,
  txHash: string,
  write: () => void,
): void {
  try {
    write();
  } catch (err: unknown) {
    logger.warn("paid_intent_ledger.write_failed", {
      op,
      taskId,
      txHash,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * A pre-broadcast route switch (#458): the sovereign P2P path was configured
 * and attempted, failed BEFORE any payment could move, and the delegation is
 * about to proceed relay-mode instead. Consent to a paid hire is framed
 * around the sovereign route ("pays from your wallet, onchain"), so the
 * switch to a different route must be NAMED, never silent — the surface
 * renders it, the tool result states it, and headless callers get the
 * structured `delegation.route_degraded` log line.
 *
 * Money safety note: the degraded relay-mode submission cannot spend the
 * wallet (no rail is invoked on that path) and a PAID direct delegation
 * without a P2P proof is refused by the relay's Arc 3.5 gate — the degrade
 * changes the ROUTE, not the spend. The dishonesty this type closes is
 * consent describing a mechanism that then didn't happen.
 */
export interface RouteDegrade {
  /** The route the consent framing described. */
  from: "p2p";
  /** The route the delegation actually takes. */
  to: "relay";
  /** The pre-broadcast P2P failure that forced the switch. */
  code: DelegationErrorCode;
  message: string;
}

export interface SelectDelegationParams {
  /**
   * Standing-grant id the current turn executes under (advisory wire
   * field for the relay's revocation fence; the metered rail seam is
   * the enforcement). Threaded to BOTH submit paths.
   */
  grantId?: string;
  /**
   * Fired when the P2P route degrades to relay-mode pre-broadcast (#458) —
   * the caller renders/records the switch. Optional; the structured
   * `delegation.route_degraded` log line fires regardless.
   */
  onRouteDegrade?: (degrade: RouteDegrade) => void;
  /** Session paid-intent ledger — threaded to the P2P path's interlock. */
  paidIntentLedger?: PaidIntentLedger;
  /** The delegator's identity (submitter / owner of the task). */
  motebitId: string;
  /** Base URL of the relay. */
  syncUrl: string;
  /** Mints audience-scoped auth tokens. */
  authToken: (audience?: TokenAudience) => Promise<string>;
  /** Task prompt to submit. */
  prompt: string;
  /**
   * Capabilities the target must advertise. Relay-mode routes on the full list;
   * the P2P path discovers + pins on the FIRST capability (one worker, one
   * pinned payment). Empty/absent → relay-mode (P2P needs a capability to
   * discover by).
   */
  requiredCapabilities?: string[];
  /**
   * Pin the delegation to a SPECIFIC worker (the agent the user tapped to hire)
   * instead of letting discovery pick the first eligible candidate. When set,
   * the P2P resolver discovers only THIS `motebit_id`; if that worker isn't
   * P2P-eligible for the capability, the delegation **fails closed** rather than
   * substituting a different worker or silently routing capability-mode — the
   * deterministic "pin who" surface-determinism requires. Absent ⇒ capability
   * routing picks (the chip path).
   */
  targetWorkerId?: string;
  /**
   * The relay's pinned Ed25519 public key (hex). With `buildP2pPayment`, enables
   * the P2P path (treasury derived from this key). Absent → relay-mode.
   */
  relayPublicKey?: string;
  /** The sovereign rail's atomic payment builder. Absent → relay-mode. */
  buildP2pPayment?: BuildP2pPayment;
  /** The rail's read-only lookup after a builder throw (#885) — see `resolveAndSubmitP2pDelegation`. */
  confirmP2pPayment?: ConfirmP2pPayment;
  /**
   * Cold-start acknowledgment for a new delegator↔worker pair — forwarded to the
   * P2P path. Only meaningful when the P2P path is taken. See
   * `SubmitP2pDelegationParams.acknowledgeNoHistoryRisk`.
   */
  acknowledgeNoHistoryRisk?: boolean;
  /** Routing strategy for relay-mode candidate ranking. */
  routingStrategy?: "cost" | "quality" | "balanced";
  /** Invocation provenance — signature-bound on the resulting receipt. */
  invocationOrigin?: IntentOrigin;
  /** Upper bound on end-to-end wait. */
  timeoutMs?: number;
  /** Structured logger. */
  logger: { warn(message: string, context?: Record<string, unknown>): void };
  /** Abort early. */
  signal?: AbortSignal;
}

/**
 * The single delegation-path selector shared by every entry point (the
 * deterministic `invokeCapability` and the AI-loop `delegate_to_agent`).
 * Centralizing it here is deliberate: divergence between the two paths was the
 * drift risk that motivated extracting `relay-delegation.ts` in the first place
 * (see this file's header).
 *
 * Picks P2P when a sovereign rail (`buildP2pPayment`) AND a pinned
 * `relayPublicKey` AND a capability to discover by are all present — a paid
 * cross-agent capability then settles peer-to-peer instead of relay-custody.
 * Falls back to the relay-mediated path when P2P is unconfigured, OR on the
 * PRE-BROADCAST codes (`no_routing` / `worker_not_payable` — a free task or no
 * payable p2p worker). It never falls back once a payment may have moved (any
 * other P2P error is surfaced verbatim), so a relay-custody re-submit can't
 * double-charge.
 */
export async function selectAndRunDelegation(
  params: SelectDelegationParams,
): Promise<DelegationResult> {
  const capability = params.requiredCapabilities?.[0];

  // A pinned hire ("pin who") can ONLY be honored on the P2P path. Relay-mode
  // capability routing does not accept a target (the submit body carries no
  // `target_agent` without a proof — see submitAndPollDelegation) — so falling
  // through to it would silently substitute a different worker for a free task,
  // or 402 opaquely for a paid one. Fail CLOSED when the pin cannot be served,
  // rather than routing capability-mode. This is the guard that makes the
  // SelectDelegationParams.targetWorkerId contract ("never substitute, never
  // silently route capability-mode") hold OUTSIDE the P2P branch too — without
  // it, the in-branch `return p2p` below only covers the rail-configured case.
  // surface-determinism: a user-tap that names a worker is deterministic or it
  // fails honestly; it never resolves to someone else.
  if (params.targetWorkerId != null) {
    if (capability == null) {
      return fail(
        "malformed_request",
        "A pinned hire requires a capability to discover the worker by.",
      );
    }
    if (params.buildP2pPayment == null || params.relayPublicKey == null) {
      return fail(
        "no_sovereign_rail",
        "Hiring a specific agent settles peer-to-peer and needs a configured sovereign wallet rail.",
      );
    }
  }

  if (params.buildP2pPayment != null && params.relayPublicKey != null && capability != null) {
    const p2p = await resolveAndSubmitP2pDelegation({
      motebitId: params.motebitId,
      syncUrl: params.syncUrl,
      authToken: params.authToken,
      prompt: params.prompt,
      capability,
      ...(params.targetWorkerId != null ? { targetWorkerId: params.targetWorkerId } : {}),
      relayPublicKeyHex: params.relayPublicKey,
      buildP2pPayment: params.buildP2pPayment,
      ...(params.confirmP2pPayment != null ? { confirmP2pPayment: params.confirmP2pPayment } : {}),
      ...(params.acknowledgeNoHistoryRisk === true ? { acknowledgeNoHistoryRisk: true } : {}),
      ...(params.invocationOrigin ? { invocationOrigin: params.invocationOrigin } : {}),
      ...(params.grantId != null ? { grantId: params.grantId } : {}),
      ...(params.paidIntentLedger != null ? { paidIntentLedger: params.paidIntentLedger } : {}),
      ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
      logger: params.logger,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (p2p.ok) return p2p;
    // A PINNED target never falls back to capability-routed relay-mode: that
    // would silently substitute a different worker than the one the user tapped
    // (a "pin who" violation, surface-determinism). Surface the P2P result
    // verbatim — including a pre-broadcast `p2p_ineligible`, which honestly
    // tells the user to opt into paying new agents rather than re-routing.
    if (params.targetWorkerId != null) return p2p;
    // Unpinned (capability-routed): fall back to relay-mode ONLY on PRE-BROADCAST
    // codes (no funds moved): no payable p2p worker, or the relay's pre-flight
    // said the pair is ineligible. Any other code may follow a broadcast →
    // surface verbatim so a relay-custody re-submit can't double-charge. This
    // allow-list is the ONE guard: every code that can follow a broadcast
    // (#885's included) is outside it by construction.
    if (
      p2p.error.code !== "no_routing" &&
      p2p.error.code !== "worker_not_payable" &&
      p2p.error.code !== "p2p_ineligible"
    ) {
      return p2p;
    }
    // The route is switching AFTER consent was (possibly) framed around the
    // sovereign wallet — name it (#458). Witnessed live 2026-07-29: the
    // approval band said "Pays from your sovereign wallet — onchain", the
    // pre-flight failed closed against a drowning relay, and the delegation
    // proceeded relay-mode under the differently-framed approval with
    // nothing rendered. Never silent again: structured log always, callback
    // for the surface/tool to render.
    const degrade: RouteDegrade = {
      from: "p2p",
      to: "relay",
      code: p2p.error.code,
      message: p2p.error.message,
    };
    params.logger.warn("delegation.route_degraded", {
      from: degrade.from,
      to: degrade.to,
      code: degrade.code,
      message: degrade.message,
    });
    params.onRouteDegrade?.(degrade);
  }

  return submitAndPollDelegation({
    motebitId: params.motebitId,
    syncUrl: params.syncUrl,
    authToken: params.authToken,
    prompt: params.prompt,
    ...(params.requiredCapabilities ? { requiredCapabilities: params.requiredCapabilities } : {}),
    ...(params.routingStrategy ? { routingStrategy: params.routingStrategy } : {}),
    ...(params.invocationOrigin ? { invocationOrigin: params.invocationOrigin } : {}),
    ...(params.grantId != null ? { grantId: params.grantId } : {}),
    ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
    logger: params.logger,
    ...(params.signal ? { signal: params.signal } : {}),
  });
}
