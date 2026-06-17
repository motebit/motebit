// Shared failure surface for the edge proxy: emit exactly one structured
// observability event and attach a traceable request id to the response.
//
// Privacy invariant: the event NEVER carries raw provider bodies, prompts,
// API keys, user content, or `motebitId`. The activation/money causal join
// lives in the relay (its own trust domain, keyed on `motebitId`); the proxy
// stream stays identity-free so it can ship to centralized infra safely.
// Correlate a user-reported incident via the `X-Motebit-Request-Id` header.

import type { FailureSource, ProxyFailure } from "./classify";

/**
 * The event name is derived from the failure SOURCE so the reliability metric
 * stays clean — four un-contaminated operational questions:
 *   - `proxy.request_rejected`  — client never admitted (auth, validation, policy)
 *   - `proxy.balance_exhausted` — economic admission boundary (activation signal)
 *   - `proxy.internal_failure`  — OUR misconfiguration/outage (missing keys, etc.)
 *   - `proxy.inference_failure` — the model path actually failed (provider / transport)
 * An operator outage must NOT read as malformed client traffic, and vice versa.
 */
function eventNameForSource(source: FailureSource): string {
  switch (source) {
    case "motebit_request":
      return "proxy.request_rejected";
    case "motebit_balance":
      return "proxy.balance_exhausted";
    case "motebit_infrastructure":
      return "proxy.internal_failure";
    case "provider":
    case "network":
      return "proxy.inference_failure";
  }
}

/**
 * Emit exactly one structured proxy-failure event. The event name is chosen by
 * source (rejection / balance / inference), so this is deliberately NOT named
 * for inference — a caller must not assume every invocation is a model failure.
 * No identity, no body, no prompts.
 */
export function emitProxyFailure(args: {
  requestId: string;
  model?: string;
  mode?: "proxy-token" | "byok";
  failure: ProxyFailure;
}): void {
  const { requestId, model, mode, failure } = args;
  // Mirrors the existing `proxy.usage` console event shape (route.ts) — the
  // proxy's established structured-log channel for the edge runtime.
  console.log(
    JSON.stringify({
      event: eventNameForSource(failure.source),
      schemaVersion: 1,
      requestId,
      model,
      mode,
      source: failure.source,
      category: failure.category,
      provider: failure.provider,
      status: failure.status,
      providerCode: failure.providerCode,
      retryAfterMs: failure.retryAfterMs,
      providerRequestId: failure.providerRequestId,
    }),
  );
}

/**
 * Build a JSON failure Response for a motebit-constructed body: logs one event
 * and attaches `X-Motebit-Request-Id`, preserving the given status. Use the
 * raw `emitProxyFailure` + a manual Response when passing an upstream body
 * through unmodified (so the provider's body/Content-Type are preserved).
 */
export function failureResponse(args: {
  requestId: string;
  status: number;
  bodyObj: Record<string, unknown>;
  headers: Record<string, string>;
  model?: string;
  mode?: "proxy-token" | "byok";
  failure: ProxyFailure;
}): Response {
  emitProxyFailure({
    requestId: args.requestId,
    model: args.model,
    mode: args.mode,
    failure: args.failure,
  });
  return new Response(JSON.stringify(args.bodyObj), {
    status: args.status,
    headers: {
      ...args.headers,
      "Content-Type": "application/json",
      "X-Motebit-Request-Id": args.requestId,
    },
  });
}
