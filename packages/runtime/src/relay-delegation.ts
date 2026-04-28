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

/** Map a relay error envelope to a `DelegationErrorCode`. */
function classifyRelayError(
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

  // Poll. Tasks are stored under the submitter's motebitId.
  const maxPolls = Math.ceil(timeoutMs / POLL_INTERVAL_MS);
  for (let i = 0; i < maxPolls; i++) {
    if (params.signal?.aborted) {
      return { ok: false, error: { code: "timeout", message: "Aborted mid-poll" } };
    }

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, POLL_INTERVAL_MS);
      params.signal?.addEventListener(
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
      const resp = await fetch(`${params.syncUrl}/agent/${params.motebitId}/task/${taskId}`, {
        headers: { Authorization: queryHeader },
        signal: params.signal,
      });

      if (!resp.ok) {
        params.logger.warn("delegation poll failed", {
          taskId,
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
        return { ok: true, receipt: data.receipt, taskId };
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

  const elapsedMs = Date.now() - startedAt;
  return {
    ok: false,
    error: { code: "timeout", message: `No receipt within ${Math.round(elapsedMs / 1000)}s` },
  };
}
