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
import type { P2pPaymentProof } from "@motebit/protocol";

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
      p2p_payment_proof: params.paymentProof,
    };
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
