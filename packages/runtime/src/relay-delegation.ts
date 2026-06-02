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
import type { P2pPaymentProof, SovereignP2pPaymentRequest } from "@motebit/protocol";
import {
  base58Encode,
  toMicro,
  computeP2pFeeMicro,
  computeFederatedFeeSplit,
  PLATFORM_FEE_RATE,
} from "@motebit/protocol";

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
   * Pre-flight. A worker was discovered but cannot be paid directly — it has no
   * service listing, no positive price, or no settlement address. Distinct from
   * `no_routing` (no worker at all) and `insufficient_balance` (the delegator's
   * shortfall).
   */
  | "worker_not_payable"
  /**
   * Pre-flight. The delegator's atomic onchain payment failed to broadcast or
   * confirm, so NO task was submitted (the proof is never sent to the relay
   * without a confirmed payment). The funds did not move — distinct from a
   * confirmed-but-rejected proof.
   */
  | "payment_broadcast_failed"
  /** Pre-flight. Trust below the capability's threshold. */
  | "trust_threshold_unmet"
  /** Pre-flight. No agent advertises the capability. */
  | "no_routing"
  /** Pre-flight. HTTP 400 — malformed submission. Code bug, surface loudly. */
  | "malformed_request"
  /** In-flight. Polling exceeded `timeoutMs` without a receipt. */
  | "timeout"
  /** In-flight. Relay reported the agent failed mid-task. */
  | "agent_failed"
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
}

export type DelegationResult =
  | { ok: true; receipt: ExecutionReceipt; taskId: string }
  | { ok: false; error: DelegationError };

export interface SubmitAndPollParams {
  /** This motebit's identity (the submitter/owner of the task). */
  motebitId: string;
  /** Base URL of the relay. */
  syncUrl: string;
  /** Mints audience-scoped auth tokens. */
  authToken: (audience?: string) => Promise<string>;
  /** Task prompt to submit. */
  prompt: string;
  /** Capabilities the target agent must advertise. */
  requiredCapabilities?: string[];
  /** Routing strategy for candidate ranking. */
  routingStrategy?: "cost" | "quality" | "balanced";
  /** Invocation provenance — signature-bound on the resulting receipt. */
  invocationOrigin?: IntentOrigin;
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

  // Mint audience-specific tokens. The relay enforces `aud` binding:
  // task:submit for POST, task:query for GET on the task record.
  let submitHeader: string;
  let queryHeader: string;
  try {
    const [submitToken, queryToken] = await Promise.all([
      params.authToken("task:submit"),
      params.authToken("task:query"),
    ]);
    submitHeader = `Bearer ${submitToken}`;
    queryHeader = `Bearer ${queryToken}`;
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
  return pollForReceipt({
    syncUrl: params.syncUrl,
    motebitId: params.motebitId,
    taskId,
    queryHeader,
    timeoutMs,
    startedAt,
    logger: params.logger,
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

interface PollForReceiptArgs {
  syncUrl: string;
  motebitId: string;
  taskId: string;
  queryHeader: string;
  timeoutMs: number;
  startedAt: number;
  logger: { warn(message: string, context?: Record<string, unknown>): void };
  signal?: AbortSignal;
}

/**
 * Poll the relay for a task's receipt. Tasks are stored under the submitter's
 * motebitId. Returns on the first signed receipt, an explicit agent-failed
 * status, abort, or timeout. Network glitches mid-poll are retried silently
 * (calm-software doctrine). Extracted so the relay-mode and P2P delegation
 * paths share one poll implementation — divergence here was the drift risk.
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

    try {
      const resp = await fetch(`${args.syncUrl}/agent/${args.motebitId}/task/${args.taskId}`, {
        headers: { Authorization: args.queryHeader },
        signal: args.signal,
      });

      if (!resp.ok) {
        args.logger.warn("delegation poll failed", {
          taskId: args.taskId,
          status: resp.status,
          body: await resp.text().catch(() => ""),
        });
        continue;
      }

      const data = (await resp.json()) as {
        task: { status: string };
        receipt: ExecutionReceipt | null;
      };

      // Agent-failed status arrives either as receipt.status === "failed" (with
      // a signed receipt — preferred) or as task.status === "failed" without
      // one. Both are terminal for a single invocation — no retry.
      if (data.receipt != null) {
        return { ok: true, receipt: data.receipt, taskId: args.taskId };
      }
      if (data.task.status === "failed") {
        return {
          ok: false,
          error: { code: "agent_failed", message: "Agent reported failure without a receipt" },
        };
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        return { ok: false, error: { code: "timeout", message: "Aborted mid-poll" } };
      }
      // Network glitch — silent retry, per calm-software doctrine.
    }
  }

  const elapsedMs = Date.now() - args.startedAt;
  return {
    ok: false,
    error: { code: "timeout", message: `No receipt within ${Math.round(elapsedMs / 1000)}s` },
  };
}

export interface SubmitP2pDelegationParams {
  /** The delegator's identity (submitter / owner of the task). */
  motebitId: string;
  /** Base URL of the relay. */
  syncUrl: string;
  /** Mints audience-scoped auth tokens. */
  authToken: (audience?: string) => Promise<string>;
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
   * transient submission failure the caller MUST retry with the SAME proof,
   * never rebuild: rebuilding broadcasts a second payment, whereas resubmitting
   * the same `tx_hash` is safe (the relay's settlement is keyed on the tx and
   * its replay guard rejects a *settled* proof but allows resubmitting an
   * unsettled one). Separating the irreversible broadcast from the retryable
   * submit is what makes "no double-pay" structural rather than a convention.
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
 * On a relay-side proof rejection (address/amount/fee mismatch → HTTP 400)
 * the result is `malformed_request`: the proof the caller built does not match
 * what the relay expects, which is a construction bug, not a user condition.
 */
export async function submitP2pDelegation(
  params: SubmitP2pDelegationParams,
): Promise<DelegationResult> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  let submitHeader: string;
  let queryHeader: string;
  try {
    const [submitToken, queryToken] = await Promise.all([
      params.authToken("task:submit"),
      params.authToken("task:query"),
    ]);
    submitHeader = `Bearer ${submitToken}`;
    queryHeader = `Bearer ${queryToken}`;
  } catch (err: unknown) {
    return {
      ok: false,
      error: {
        code: "auth_expired",
        message: `Auth token mint failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  let taskId: string;
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
    if (params.invocationOrigin) {
      body.invocation_origin = params.invocationOrigin;
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

  return pollForReceipt({
    syncUrl: params.syncUrl,
    motebitId: params.motebitId,
    taskId,
    queryHeader,
    timeoutMs,
    startedAt,
    logger: params.logger,
    ...(params.signal ? { signal: params.signal } : {}),
  });
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

const fail = (code: DelegationErrorCode, message: string, status?: number): DelegationResult => ({
  ok: false,
  error: status != null ? { code, message, status } : { code, message },
});

export interface ResolveAndSubmitP2pDelegationParams {
  /** The delegator's identity (submitter / owner of the task). */
  motebitId: string;
  /** Base URL of the relay. */
  syncUrl: string;
  /** Mints audience-scoped auth tokens (the listing read needs `market:listing`). */
  authToken: (audience?: string) => Promise<string>;
  /** Task prompt to submit. */
  prompt: string;
  /** Capability the worker must advertise — used to discover + select + price. */
  capability: string;
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
  buildP2pPayment?: (request: SovereignP2pPaymentRequest) => Promise<P2pPaymentProof>;
  /** Invocation provenance — signature-bound on the resulting receipt. */
  invocationOrigin?: IntentOrigin;
  /** Upper bound on end-to-end wait. Default 120s. */
  timeoutMs?: number;
  /** Structured logger. */
  logger: { warn(message: string, context?: Record<string, unknown>): void };
  /** Abort early. */
  signal?: AbortSignal;
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
 *   - The fee rate is the protocol-canonical `PLATFORM_FEE_RATE`, the same rate
 *     the relay validator enforces; a relay running a non-canonical rate fails
 *     CLOSED (the proof is rejected) rather than silently mispaying.
 *   - The payment is broadcast exactly once, then handed to `submitP2pDelegation`
 *     which never re-broadcasts on retry (no double-pay).
 *
 * Failure modes are explicit `DelegationErrorCode`s; nothing falls back to a
 * relay-custody path. Discovery is a public read; the listing read is
 * `market:listing`-audience authed.
 */
export async function resolveAndSubmitP2pDelegation(
  params: ResolveAndSubmitP2pDelegationParams,
): Promise<DelegationResult> {
  const { syncUrl, capability, motebitId } = params;

  if (params.buildP2pPayment == null) {
    return fail(
      "no_sovereign_rail",
      "Paid direct delegation needs a sovereign wallet rail that can build an atomic payment.",
    );
  }

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
        settlement_address?: string | null;
        settlement_modes?: string | string[] | null;
        source_relay_public_key?: string | null;
        pricing?: Array<{ capability?: string; unit_cost?: number }> | null;
      }>;
    };
    const candidate = (data.agents ?? []).find((a) => {
      if (a.motebit_id === motebitId || a.settlement_address == null) return false;
      const modes = Array.isArray(a.settlement_modes)
        ? a.settlement_modes
        : String(a.settlement_modes ?? "").split(",");
      return modes.includes("p2p");
    });
    if (candidate?.settlement_address == null) {
      return fail("no_routing", `No P2P-capable worker advertises "${capability}".`);
    }
    worker = {
      motebit_id: candidate.motebit_id,
      settlement_address: candidate.settlement_address,
      ...(candidate.source_relay_public_key != null
        ? { sourceRelayPublicKey: candidate.source_relay_public_key }
        : {}),
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
    const budgetMicro = toMicro(priced.unit_cost);
    const split = computeFederatedFeeSplit(budgetMicro, PLATFORM_FEE_RATE);
    paymentRequest = {
      workerAddress: worker.settlement_address,
      amountMicro: split.workerNetMicro,
      treasuryAddress,
      feeAmountMicro: split.originFeeMicro,
      executorTreasuryAddress,
      executorFeeAmountMicro: split.executorFeeMicro,
    };
  } else {
    // LOCAL: price from the worker's listing (market:listing-audience read).
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
    // relay validator uses, at the canonical rate). Pinned treasury.
    const amountMicro = toMicro(unitCost);
    paymentRequest = {
      workerAddress: worker.settlement_address,
      amountMicro,
      treasuryAddress,
      feeAmountMicro: computeP2pFeeMicro(amountMicro, PLATFORM_FEE_RATE),
    };
  }

  // 4. Broadcast the atomic payment ONCE. A throw here means nothing settled on
  //    the relay — the proof is never submitted without a confirmed payment.
  let proof: P2pPaymentProof;
  try {
    proof = await params.buildP2pPayment(paymentRequest);
  } catch (err: unknown) {
    // wallet-solana surfaces a funds shortfall as InsufficientUsdcBalanceError.
    if (err instanceof Error && err.name === "InsufficientUsdcBalanceError") {
      return fail("insufficient_balance", err.message);
    }
    return fail(
      "payment_broadcast_failed",
      `P2P payment failed to broadcast: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 5. Submit the pre-built proof (retry-safe; never re-broadcasts).
  return submitP2pDelegation({
    motebitId,
    syncUrl,
    authToken: params.authToken,
    prompt: params.prompt,
    targetWorkerId: worker.motebit_id,
    // The relay needs the capability to locate + price a federated worker on its
    // operator; pinned via the same capability used for discovery.
    requiredCapabilities: [capability],
    paymentProof: proof,
    ...(params.invocationOrigin ? { invocationOrigin: params.invocationOrigin } : {}),
    ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
    logger: params.logger,
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

export interface SelectDelegationParams {
  /** The delegator's identity (submitter / owner of the task). */
  motebitId: string;
  /** Base URL of the relay. */
  syncUrl: string;
  /** Mints audience-scoped auth tokens. */
  authToken: (audience?: string) => Promise<string>;
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
   * The relay's pinned Ed25519 public key (hex). With `buildP2pPayment`, enables
   * the P2P path (treasury derived from this key). Absent → relay-mode.
   */
  relayPublicKey?: string;
  /** The sovereign rail's atomic payment builder. Absent → relay-mode. */
  buildP2pPayment?: (request: SovereignP2pPaymentRequest) => Promise<P2pPaymentProof>;
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

  if (params.buildP2pPayment != null && params.relayPublicKey != null && capability != null) {
    const p2p = await resolveAndSubmitP2pDelegation({
      motebitId: params.motebitId,
      syncUrl: params.syncUrl,
      authToken: params.authToken,
      prompt: params.prompt,
      capability,
      relayPublicKeyHex: params.relayPublicKey,
      buildP2pPayment: params.buildP2pPayment,
      ...(params.invocationOrigin ? { invocationOrigin: params.invocationOrigin } : {}),
      ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
      logger: params.logger,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    if (p2p.ok) return p2p;
    if (p2p.error.code !== "no_routing" && p2p.error.code !== "worker_not_payable") {
      return p2p;
    }
  }

  return submitAndPollDelegation({
    motebitId: params.motebitId,
    syncUrl: params.syncUrl,
    authToken: params.authToken,
    prompt: params.prompt,
    ...(params.requiredCapabilities ? { requiredCapabilities: params.requiredCapabilities } : {}),
    ...(params.routingStrategy ? { routingStrategy: params.routingStrategy } : {}),
    ...(params.invocationOrigin ? { invocationOrigin: params.invocationOrigin } : {}),
    ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
    logger: params.logger,
    ...(params.signal ? { signal: params.signal } : {}),
  });
}
