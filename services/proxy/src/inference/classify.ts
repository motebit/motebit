// Pre-stream inference-failure classification — OBSERVATION ONLY.
//
// This module answers "what happened" for a failed inference turn. It never
// decides "what to do" — no retries, no backoff, no failover. Recovery policy
// (a `RecoveryDecision` layer) is a deliberately separate, later PR; keeping
// classification pure keeps the observation honest and unit-testable.
//
// SCOPE BOUNDARY (PR1): this classifies failures observable BEFORE the response
// stream begins — an upstream provider HTTP non-2xx, or a transport throw
// before any HTTP response. It does NOT classify a 200 response that later
// refuses (`stop_reason: "refusal"`) or a mid-stream interruption; those live
// behind a future `classifyStreamTermination()` boundary and are out of scope.
//
// Edge-runtime-safe: pure functions, no Node APIs. `nowMs` is injected so the
// `Retry-After` HTTP-date path is deterministic in tests.

// Where the failure originated. This drives the event NAME (failure-response.ts)
// so the four operational questions stay un-contaminated:
//   request rejected? · no balance? · OUR infra failed? · the model path failed?
export type FailureSource =
  | "motebit_request" // client input/policy rejected (auth, validation, jurisdiction, allowlist)
  | "motebit_balance" // the user's virtual-account balance reached zero
  | "motebit_infrastructure" // OUR misconfiguration/outage (missing keys, unconfigured provider)
  | "provider" // upstream provider returned a non-2xx
  | "network"; // transport failed before any HTTP response

/** What kind of failure it was. Closed set; `unknown` is the honest fallback. */
export type FailureCategory =
  // source: motebit_balance
  | "balance_exhausted"
  // source: motebit_request
  | "authentication" // 401/403 (motebit token, or provider auth)
  | "model_unavailable" // 451 jurisdiction / 404 not_found / token allowlist
  | "malformed_request" // 400 bad request / invalid json / invalid messages / too large
  // source: motebit_infrastructure
  | "not_configured" // missing relay key / operator API key / unconfigured provider
  // source: provider
  | "rate_limited" // 429
  | "overloaded" // 529
  | "server_error" // 500 / 502 / 503
  | "context_overflow" // 413, or 400 with a context-window signal
  | "provider_billing_exhausted" // operator-key billing/credit exhaustion
  // source: network
  | "timeout"
  | "network"
  | "unknown";

export interface ProxyFailure {
  source: FailureSource;
  category: FailureCategory;
  /** Provider origin label when known (e.g. "anthropic"). */
  provider?: string;
  /** HTTP status; absent for transport failures. */
  status?: number;
  /** Upstream `error.type` (e.g. "rate_limit_error"). Never the raw body. */
  providerCode?: string;
  /** `retry-after` parsed (delta-seconds OR HTTP-date) → milliseconds. */
  retryAfterMs?: number;
  /** Upstream request id, for server-side tracing. Never user content. */
  providerRequestId?: string;
}

// ── header + body helpers ────────────────────────────────────────────────

type HeaderBag = Headers | Record<string, string> | undefined;

function headerGet(headers: HeaderBag, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * Parse `Retry-After`: either an integer count of delta-seconds, or an
 * HTTP-date (RFC 7231 §7.1.3). Returns milliseconds to wait, clamped at ≥ 0,
 * or undefined when absent/unparseable. `nowMs` is injected for determinism.
 */
export function parseRetryAfterMs(raw: string | undefined, nowMs: number): number | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (/^\d+$/.test(trimmed)) {
    const secs = Number(trimmed);
    return Number.isFinite(secs) ? secs * 1000 : undefined;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - nowMs;
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

// Anthropic returns `request-id`; other proxies/CDNs vary. Order = preference.
const REQUEST_ID_HEADERS = ["request-id", "anthropic-request-id", "x-request-id"];

function extractProviderRequestId(headers: HeaderBag, body: unknown): string | undefined {
  for (const h of REQUEST_ID_HEADERS) {
    const v = headerGet(headers, h);
    if (v) return v;
  }
  const r = asRecord(body);
  const fromBody = r?.request_id;
  return typeof fromBody === "string" ? fromBody : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/** Pull `error.type` (or top-level `type`) from a parsed provider error body. */
function extractProviderErrorType(body: unknown): string | undefined {
  const r = asRecord(body);
  if (!r) return undefined;
  const err = asRecord(r.error);
  const t = err?.type ?? r.type;
  return typeof t === "string" ? t : undefined;
}

/** Heuristic: does a 400 body signal a context-window overflow vs a generic bad request? */
function isContextWindowError(body: unknown): boolean {
  const r = asRecord(body);
  const err = asRecord(r?.error);
  const msg = typeof err?.message === "string" ? err.message.toLowerCase() : "";
  if (msg === "") return false;
  return (
    msg.includes("prompt is too long") ||
    (msg.includes("context") && (msg.includes("window") || msg.includes("token"))) ||
    msg.includes("max_tokens") ||
    msg.includes("too many tokens")
  );
}

// ── classifiers ───────────────────────────────────────────────────────────

/**
 * Classify an upstream provider HTTP non-2xx response. The caller reads the
 * (small) error body and passes the PARSED JSON (or null) — the raw body is
 * never retained or logged here.
 */
export function classifyProviderHttpFailure(input: {
  provider: string;
  status: number;
  headers?: HeaderBag;
  body?: unknown;
  nowMs: number;
}): ProxyFailure {
  const { provider, status, headers, body, nowMs } = input;
  const providerCode = extractProviderErrorType(body);
  const base: ProxyFailure = {
    source: "provider",
    category: "unknown",
    provider,
    status,
    providerCode,
    retryAfterMs: parseRetryAfterMs(headerGet(headers, "retry-after"), nowMs),
    providerRequestId: extractProviderRequestId(headers, body),
  };

  switch (status) {
    case 429:
      return { ...base, category: "rate_limited" };
    case 529:
      return { ...base, category: "overloaded" };
    case 500:
    case 502:
    case 503:
      return { ...base, category: "server_error" };
    case 402:
      return { ...base, category: "provider_billing_exhausted" };
    case 401:
    case 403:
      return {
        ...base,
        category:
          providerCode === "billing_error" ? "provider_billing_exhausted" : "authentication",
      };
    case 404:
      return { ...base, category: "model_unavailable" };
    case 413:
      return { ...base, category: "context_overflow" };
    case 400:
      return {
        ...base,
        category: isContextWindowError(body) ? "context_overflow" : "malformed_request",
      };
    default:
      return base;
  }
}

/** Classify a transport failure: `fetch` threw before any HTTP response. */
export function classifyProviderTransportFailure(input: {
  provider: string;
  errorName?: string; // e.g. "AbortError", "TimeoutError", "TypeError"
}): ProxyFailure {
  const name = (input.errorName ?? "").toLowerCase();
  const category: FailureCategory =
    name.includes("abort") || name.includes("timeout") ? "timeout" : "network";
  return { source: "network", category, provider: input.provider };
}

/** Construct a motebit-originated failure (request / balance / infrastructure). */
export function motebitFailure(
  source: "motebit_request" | "motebit_balance" | "motebit_infrastructure",
  category: FailureCategory,
  status: number,
): ProxyFailure {
  return { source, category, status };
}
