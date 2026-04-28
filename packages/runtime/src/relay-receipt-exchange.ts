/**
 * Relay-mediated receipt exchange transport — the paved convenience tier.
 *
 * Pairs with `http-receipt-exchange.ts` to give motebit runtimes a
 * dual-transport model for sovereign receipts:
 *
 *   - **HTTP direct** (the sovereign floor): two motebits with public
 *     addressability can exchange receipts peer-to-peer, no relay
 *     in the loop, maximum protocol purity. Best for server-shaped
 *     motebits with stable endpoints.
 *
 *   - **Relay-mediated** (this file): most real motebits (laptops,
 *     phones, Tauri desktop apps, browsers) are NAT-bound, have
 *     dynamic IPs, and are intermittently online. They cannot be
 *     HTTP servers. The relay becomes a dumb-pipe meeting point:
 *     the payer POSTs to a relay endpoint; the payee long-polls the
 *     same relay; the relay routes messages by motebit ID without
 *     inspecting or modifying receipt contents. Same doctrinal role
 *     as multi-device sync — a legitimate meeting point, not an
 *     authority (see CLAUDE.md "sync is the floor of legitimate
 *     centralization").
 *
 * Both transports implement the same `SovereignReceiptExchangeAdapter`
 * interface, so runtimes can pick one or the other (or, with a future
 * composition primitive, both with fallback semantics) without any
 * protocol changes. Rails are plural, receipts are singular; same
 * shape applied one layer up: transports are plural, receipt protocol
 * is singular.
 *
 * ## Wire protocol
 *
 * Three endpoints on the relay, all under `/api/v1/receipts/`:
 *
 *   - `POST /exchange` — payer submits a request; relay routes to
 *     payee, holds connection until payee responds or timeout fires
 *   - `GET /pending?motebit_id=X` — payee long-polls for incoming
 *     requests; returns empty on timeout so payee can re-poll
 *   - `POST /respond` — payee submits the signed receipt; relay
 *     matches on `request_id` and resolves the payer's pending promise
 *
 * The relay does not inspect, verify, authorize, or modify any
 * receipt content. It only routes by motebit ID. See
 * `services/relay/src/receipt-exchange.ts` for the authoritative relay
 * implementation.
 *
 * ## BigInt handling
 *
 * Like the HTTP direct transport, this adapter handles `bigint` fields
 * in `SovereignReceiptRequest.amount_micro` by tagging them as
 * `{__bigint__: "..."}` on the wire and restoring them on the other
 * side. This is essential for amounts above `Number.MAX_SAFE_INTEGER`.
 *
 * ## Fetch injection
 *
 * The adapter takes a `fetch` function as a config option. Production
 * uses the global `fetch`. Tests pass a custom function that delegates
 * to `relay.app.request(...)` (Hono's in-process request API), so the
 * integration test can exercise the full round trip without starting
 * a real HTTP listener.
 */

import type {
  SovereignReceiptExchangeAdapter,
  SovereignReceiptRequest,
  SovereignReceiptResponse,
} from "./sovereign-receipt-exchange.js";

// ── Configuration ─────────────────────────────────────────────────────

export interface RelayReceiptExchangeConfig {
  /** Base URL of the relay, e.g. `"https://relay.motebit.com"`. */
  relayUrl: string;
  /**
   * The motebit ID this adapter is scoped to. When operating as a
   * payee, the background long-poll loop polls with this ID. When
   * operating as a payer, this ID is recorded but not used directly
   * (the `payee_motebit_id` in each request is what routes).
   */
  ownMotebitId: string;
  /**
   * Optional auth token (Bearer). Passed as `Authorization: Bearer {token}`
   * on every request. Most relay deployments require one.
   */
  authToken?: string;
  /**
   * Optional custom fetch function. Defaults to `globalThis.fetch`.
   * Tests inject a function that delegates to `relay.app.request(...)`
   * (Hono's in-process request API) for integration-test speed.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * How long to wait for the payer's POST response before timing out.
   * Should be slightly longer than the relay's exchangeTimeoutMs so
   * that a slow payee doesn't cause false client-side timeouts.
   * Default: 35000ms.
   */
  requestTimeoutMs?: number;
  /**
   * How long the payee's long-poll request is held open. Should match
   * the relay's pollTimeoutMs (default 25000ms) so that re-polling
   * resumes immediately after a timeout. Default: 30000ms.
   */
  pollTimeoutMs?: number;
  /**
   * Delay before retrying a failed long-poll (network error, 5xx).
   * Default: 1000ms.
   */
  pollRetryDelayMs?: number;
}

export interface RelayReceiptExchange extends SovereignReceiptExchangeAdapter {
  /**
   * Shut down the background poll loop and cancel any in-flight
   * requests. Idempotent. MUST be called during test teardown and app
   * shutdown to prevent hanging the process on background loops.
   */
  close(): Promise<void>;
  /**
   * Whether the background poll loop is currently running. Useful for
   * tests to verify lifecycle.
   */
  readonly polling: boolean;
}

// ── JSON encoding for bigints ─────────────────────────────────────────

function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return { __bigint__: value.toString() };
  }
  return value;
}

function bigintReviver(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    "__bigint__" in value &&
    typeof (value as { __bigint__: unknown }).__bigint__ === "string"
  ) {
    return BigInt((value as { __bigint__: string }).__bigint__);
  }
  return value;
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value, bigintReplacer);
}

function decodeJson<T>(text: string): T {
  return JSON.parse(text, bigintReviver) as T;
}

// ── Factory ───────────────────────────────────────────────────────────

/**
 * Build a relay-mediated receipt exchange adapter.
 *
 * The adapter is BOTH a payer and a payee:
 *
 *   - As a payer, calling `request(payeeMotebitId, req)` POSTs to the
 *     relay's `/api/v1/receipts/exchange` endpoint and awaits the
 *     payee's response (routed through the relay).
 *
 *   - As a payee, the runtime calls `onIncomingRequest(handler)` once
 *     at construction. The adapter immediately starts a background
 *     long-poll loop against the relay's `/api/v1/receipts/pending`
 *     endpoint. When an incoming request arrives, the handler is
 *     called, and the result is POSTed to `/api/v1/receipts/respond`.
 *
 * The background poll loop is started LAZILY when `onIncomingRequest`
 * is called, not at construction time. This allows payer-only motebits
 * (CLI demos, test scenarios) to use the adapter without paying for
 * unnecessary background traffic.
 *
 * ## Usage
 *
 * ```ts
 * const aliceTransport = createRelayReceiptExchange({
 *   relayUrl: "https://relay.motebit.com",
 *   ownMotebitId: "alice",
 *   authToken: aliceAuthToken,
 * });
 *
 * const alice = new MotebitRuntime({
 *   motebitId: "alice",
 *   signingKeys: aliceKeys,
 *   sovereignReceiptExchange: aliceTransport,
 * }, ...);
 *
 * // Later:
 * await alice.requestSovereignReceipt("bob", { ...request });
 * // -> POSTs to relay, relay routes to bob, bob signs, returns through relay
 *
 * await aliceTransport.close();
 * ```
 */
export function createRelayReceiptExchange(
  config: RelayReceiptExchangeConfig,
): RelayReceiptExchange {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const requestTimeoutMs = config.requestTimeoutMs ?? 35_000;
  const pollTimeoutMs = config.pollTimeoutMs ?? 30_000;
  const pollRetryDelayMs = config.pollRetryDelayMs ?? 1_000;

  const authHeaders: Record<string, string> = {};
  if (config.authToken) {
    authHeaders["Authorization"] = `Bearer ${config.authToken}`;
  }

  let handler: ((req: SovereignReceiptRequest) => Promise<SovereignReceiptResponse>) | null = null;
  let closed = false;
  let pollPromise: Promise<void> | null = null;
  let pollAbortController: AbortController | null = null;

  // Normalize relay URL (strip trailing slash)
  const baseUrl = config.relayUrl.replace(/\/+$/, "");

  // ── Payer side: POST /exchange ────────────────────────────────────

  async function request(
    payeeMotebitId: string,
    req: SovereignReceiptRequest,
  ): Promise<SovereignReceiptResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await fetchFn(`${baseUrl}/api/v1/receipts/exchange`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
        },
        body: encodeJson({
          payee_motebit_id: payeeMotebitId,
          request: req,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return {
          error: {
            code: "unknown",
            message: `Relay returned HTTP ${response.status} ${response.statusText}`,
          },
        };
      }

      const text = await response.text();
      const body = decodeJson<{ response?: SovereignReceiptResponse; error?: string }>(text);

      if (!body.response) {
        return {
          error: {
            code: "unknown",
            message: body.error ?? "Relay returned an empty response envelope",
          },
        };
      }

      return body.response;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        error: {
          code: "unknown",
          message: msg.includes("abort")
            ? `Timeout after ${requestTimeoutMs}ms contacting the relay`
            : msg,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Payee side: long-poll loop ────────────────────────────────────

  /**
   * Background loop that polls the relay's `/pending` endpoint,
   * dispatches incoming requests to the handler, and posts responses
   * back via `/respond`. Runs until `close()` is called.
   */
  async function pollLoop(): Promise<void> {
    while (!closed) {
      pollAbortController = new AbortController();
      const timer = setTimeout(() => pollAbortController?.abort(), pollTimeoutMs + 2_000);

      try {
        const response = await fetchFn(
          `${baseUrl}/api/v1/receipts/pending?motebit_id=${encodeURIComponent(
            config.ownMotebitId,
          )}`,
          {
            method: "GET",
            headers: { ...authHeaders },
            signal: pollAbortController.signal,
          },
        );

        clearTimeout(timer);

        if (closed) break;

        if (!response.ok) {
          // Transient relay error — wait and retry.
          await sleep(pollRetryDelayMs, pollAbortController.signal);
          continue;
        }

        const text = await response.text();
        const body = decodeJson<{
          request_id?: string;
          request?: SovereignReceiptRequest;
        }>(text);

        // Empty body means the long poll timed out with no request —
        // just continue the loop and re-poll.
        if (!body.request_id || !body.request) continue;

        // Dispatch to the handler. Wrap in try/catch so a handler
        // exception becomes an error response, not a poll-loop crash.
        let result: SovereignReceiptResponse;
        if (!handler) {
          result = {
            error: {
              code: "unknown",
              message: "No incoming-request handler registered",
            },
          };
        } else {
          try {
            result = await handler(body.request);
          } catch (err: unknown) {
            result = {
              error: {
                code: "unknown",
                message: err instanceof Error ? err.message : String(err),
              },
            };
          }
        }

        // POST the response back. Best-effort — if this fails, the
        // payer times out and retries; we don't want to block the
        // next poll cycle on response delivery.
        void (async (): Promise<void> => {
          try {
            await fetchFn(`${baseUrl}/api/v1/receipts/respond`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...authHeaders,
              },
              body: encodeJson({
                request_id: body.request_id,
                response: result,
              }),
            });
          } catch {
            // Best-effort; payer will time out if we can't deliver.
          }
        })();
      } catch (err: unknown) {
        clearTimeout(timer);
        if (closed) break;

        // Abort during close() is expected; other errors are transient
        // and we retry after a backoff.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("abort")) {
          await sleep(pollRetryDelayMs, pollAbortController.signal);
        }
      }
    }

    pollAbortController = null;
  }

  async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // ── Adapter object ────────────────────────────────────────────────

  const adapter: RelayReceiptExchange = {
    get polling(): boolean {
      return pollPromise !== null && !closed;
    },

    request,

    onIncomingRequest(incomingHandler): void {
      handler = incomingHandler;
      // Start the background poll loop on first registration. Idempotent.
      if (pollPromise === null) {
        pollPromise = pollLoop();
      }
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      pollAbortController?.abort();
      if (pollPromise) {
        try {
          await pollPromise;
        } catch {
          // Poll loop shutdown errors are expected/ignored.
        }
        pollPromise = null;
      }
    },
  };

  return adapter;
}
