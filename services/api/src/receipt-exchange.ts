/**
 * Relay-mediated sovereign receipt exchange.
 *
 * This module provides the three endpoints that turn the relay into a
 * dumb-pipe meeting point for sovereign receipt exchange between
 * motebits that cannot reach each other directly (NAT-bound, dynamic
 * IPs, intermittently online). The relay does NOT inspect, verify,
 * authorize, or modify the receipt contents — it only routes messages
 * by motebit ID. Same legitimacy as multi-device sync: a meeting
 * point for intermittently-connected parties, not an authority.
 *
 * ## Architecture
 *
 * Three HTTP endpoints, in-memory message queues, long-polling on the
 * payee side. The wire format is the same as the in-runtime transport
 * interface (SovereignReceiptRequest / SovereignReceiptResponse), so
 * any adapter implementing SovereignReceiptExchangeAdapter in the
 * runtime can use this relay as its transport.
 *
 * ```
 * Payer                         Relay                         Payee
 *  │                             │                              │
 *  │ POST /receipts/exchange     │                              │
 *  │    {payee_id, request}      │                              │
 *  │────────────────────────────>│                              │
 *  │                             │  (holds connection)          │
 *  │                             │                              │
 *  │                             │                              │  GET /receipts/pending
 *  │                             │<─────────────────────────────│    ?motebit_id=payee
 *  │                             │                              │  (long poll)
 *  │                             │                              │
 *  │                             │  {request_id, request}       │
 *  │                             │─────────────────────────────>│
 *  │                             │                              │
 *  │                             │                              │  (payee handler
 *  │                             │                              │   signs receipt)
 *  │                             │                              │
 *  │                             │                              │  POST /receipts/respond
 *  │                             │<─────────────────────────────│    {request_id, response}
 *  │                             │                              │
 *  │                             │─────────────────────────────>│  200 OK
 *  │                             │                              │
 *  │ 200 OK                      │                              │
 *  │    {response}               │                              │
 *  │<────────────────────────────│                              │
 * ```
 *
 * ## Relay's role
 *
 * The relay is a **dumb pipe**. Specifically:
 *
 *   - It does NOT verify the receipt signature. The payer does that
 *     using the payee's embedded public key.
 *   - It does NOT verify the onchain payment exists. That's the
 *     payer's concern (or an optional verifier adapter).
 *   - It does NOT modify the request or response payloads.
 *   - It does NOT persist anything. In-memory only. If the relay
 *     restarts, in-flight requests are lost and the payer gets a
 *     timeout error (fail-closed).
 *   - It DOES route messages by `payee_motebit_id` to the correct
 *     payee's pending queue.
 *   - It DOES enforce a timeout on each request so stuck pollers
 *     don't accumulate forever.
 *
 * ## Doctrinal fit
 *
 * This endpoint is the "paved convenience tier" for receipt exchange,
 * paralleling the HTTP direct transport ("sovereign floor") in
 * packages/runtime/src/http-receipt-exchange.ts. Both implement the
 * same SovereignReceiptExchangeAdapter interface from the runtime's
 * perspective; the choice is operational, not architectural.
 *
 * See CLAUDE.md "Sync is the floor of legitimate centralization" for
 * why this form of relay mediation is protocol-conformant under the
 * foundation law: the relay is an optional, replaceable, spec-
 * governed service — not authoritative for any part of the protocol.
 */

import type { Hono } from "hono";

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Opaque message payloads. The relay intentionally does not depend on
 * the runtime's SovereignReceiptRequest / SovereignReceiptResponse
 * types because this is protocol-level routing: the relay should not
 * care about receipt semantics.
 */
type OpaquePayload = Record<string, unknown>;

interface PendingRequest {
  /** Unique ID assigned by the relay at POST time. Used to correlate response. */
  readonly request_id: string;
  /** The payload the payer sent. Opaque to the relay. */
  readonly request: OpaquePayload;
  /** When the request was enqueued (for TTL enforcement). */
  readonly enqueued_at: number;
}

interface WaitingPoller {
  readonly resolve: (req: PendingRequest | null) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface WaitingResponder {
  readonly resolve: (response: OpaquePayload) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

// ── Configuration ─────────────────────────────────────────────────────

export interface ReceiptExchangeConfig {
  /**
   * How long a payer's POST /receipts/exchange request is held open
   * while waiting for the payee to respond. After this timeout the
   * relay returns an error response to the payer and the pending
   * request is dropped. Default: 30000ms.
   */
  exchangeTimeoutMs?: number;
  /**
   * How long a payee's GET /receipts/pending request is held open
   * while waiting for an incoming request. After this timeout the
   * relay returns an empty response and the payee should re-poll.
   * Default: 25000ms — slightly shorter than the exchange timeout so
   * re-polling completes before the payer times out.
   */
  pollTimeoutMs?: number;
  /**
   * Maximum number of pending requests queued per payee before new
   * requests are rejected with HTTP 503. Prevents unbounded growth
   * when a payee is offline indefinitely. Default: 100.
   */
  maxPendingPerPayee?: number;
}

// ── Module-level state ────────────────────────────────────────────────

/**
 * Create a fresh receipt exchange hub. The hub owns the in-memory
 * queues and registers the three routes on the provided Hono app.
 * Returns a `close` function that clears all pending state — useful
 * for test teardown to prevent leaked timers between test cases.
 *
 * The hub is instance-local. A single relay process has one hub
 * (created once in index.ts). Tests create their own hub via
 * createTestRelay().
 */
export function registerReceiptExchangeRoutes(
  app: Hono,
  config: ReceiptExchangeConfig = {},
): { close: () => void } {
  const exchangeTimeoutMs = config.exchangeTimeoutMs ?? 30_000;
  const pollTimeoutMs = config.pollTimeoutMs ?? 25_000;
  const maxPendingPerPayee = config.maxPendingPerPayee ?? 100;

  /** Queued requests waiting for the payee to pick them up, by motebit ID. */
  const pendingByPayee = new Map<string, PendingRequest[]>();

  /** Payer promises waiting for the payee's response, by request_id. */
  const waitingForResponse = new Map<string, WaitingResponder>();

  /** Payee long-poll promises waiting for incoming requests, by motebit ID. */
  const waitingPollers = new Map<string, WaitingPoller[]>();

  // ── Shared helper: deliver a request to a payee ──────────────────

  /**
   * Try to deliver a pending request to the payee. If the payee has
   * a waiting poller, resolve it immediately. Otherwise enqueue the
   * request for later pickup.
   */
  function deliverOrEnqueue(
    payeeMotebitId: string,
    pending: PendingRequest,
  ): { enqueued: boolean } {
    const pollers = waitingPollers.get(payeeMotebitId);
    if (pollers && pollers.length > 0) {
      // Hand directly to a waiting poller — zero queue delay.
      const poller = pollers.shift()!;
      if (pollers.length === 0) waitingPollers.delete(payeeMotebitId);
      clearTimeout(poller.timer);
      poller.resolve(pending);
      return { enqueued: false };
    }

    // No poller waiting — enqueue for later pickup.
    const queue = pendingByPayee.get(payeeMotebitId) ?? [];
    queue.push(pending);
    pendingByPayee.set(payeeMotebitId, queue);
    return { enqueued: true };
  }

  // ── POST /api/v1/receipts/exchange ────────────────────────────────
  //
  // Payer sends a receipt request. Relay generates a request_id,
  // routes the request to the payee's pending queue (or directly to
  // a waiting poller), then holds the HTTP connection open until the
  // payee responds or the exchange timeout fires.

  app.post("/api/v1/receipts/exchange", async (c) => {
    let body: { payee_motebit_id?: string; request?: OpaquePayload };
    try {
      body = await c.req.json<{ payee_motebit_id?: string; request?: OpaquePayload }>();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const payeeMotebitId = body.payee_motebit_id;
    const request = body.request;
    if (typeof payeeMotebitId !== "string" || !payeeMotebitId) {
      return c.json({ error: "payee_motebit_id is required" }, 400);
    }
    if (request == null || typeof request !== "object") {
      return c.json({ error: "request is required" }, 400);
    }

    const existingQueue = pendingByPayee.get(payeeMotebitId);
    if (existingQueue && existingQueue.length >= maxPendingPerPayee) {
      return c.json({ error: "payee pending queue is full" }, 503);
    }

    const requestId = crypto.randomUUID();
    const pending: PendingRequest = {
      request_id: requestId,
      request,
      enqueued_at: Date.now(),
    };

    // Create the response promise BEFORE delivering the request so
    // there is no race where the payee responds before we've registered.
    const responsePromise = new Promise<OpaquePayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        waitingForResponse.delete(requestId);
        reject(new Error("payee did not respond within timeout"));
      }, exchangeTimeoutMs);
      waitingForResponse.set(requestId, { resolve, reject, timer });
    });

    deliverOrEnqueue(payeeMotebitId, pending);

    try {
      const response = await responsePromise;
      return c.json({ response });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(
        {
          response: {
            error: {
              code: "unknown",
              message: msg,
            },
          },
        },
        200,
      );
    }
  });

  // ── GET /api/v1/receipts/pending ──────────────────────────────────
  //
  // Payee long-polls for incoming requests. If the queue has items,
  // returns immediately. Otherwise holds the connection open for up
  // to pollTimeoutMs, returning an empty response on timeout so the
  // payee can re-poll.

  app.get("/api/v1/receipts/pending", async (c) => {
    const motebitId = c.req.query("motebit_id");
    if (typeof motebitId !== "string" || !motebitId) {
      return c.json({ error: "motebit_id query parameter is required" }, 400);
    }

    // If there's a pending request already, return it immediately.
    const queue = pendingByPayee.get(motebitId);
    if (queue && queue.length > 0) {
      const pending = queue.shift()!;
      if (queue.length === 0) pendingByPayee.delete(motebitId);
      return c.json(pending);
    }

    // Otherwise hold the connection open.
    const pending = await new Promise<PendingRequest | null>((resolve) => {
      const timer = setTimeout(() => {
        // Remove ourselves from the waiting pollers list on timeout.
        const list = waitingPollers.get(motebitId);
        if (list) {
          const idx = list.findIndex((p) => p.resolve === resolve);
          if (idx !== -1) list.splice(idx, 1);
          if (list.length === 0) waitingPollers.delete(motebitId);
        }
        resolve(null);
      }, pollTimeoutMs);

      const list = waitingPollers.get(motebitId) ?? [];
      list.push({ resolve, timer });
      waitingPollers.set(motebitId, list);
    });

    if (pending == null) {
      return c.json({}, 200); // empty — payee re-polls
    }
    return c.json(pending);
  });

  // ── POST /api/v1/receipts/respond ─────────────────────────────────
  //
  // Payee returns the signed receipt (or an error). Relay matches on
  // request_id and resolves the payer's pending promise.

  app.post("/api/v1/receipts/respond", async (c) => {
    let body: { request_id?: string; response?: OpaquePayload };
    try {
      body = await c.req.json<{ request_id?: string; response?: OpaquePayload }>();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const requestId = body.request_id;
    const response = body.response;
    if (typeof requestId !== "string" || !requestId) {
      return c.json({ error: "request_id is required" }, 400);
    }
    if (response == null || typeof response !== "object") {
      return c.json({ error: "response is required" }, 400);
    }

    const waiting = waitingForResponse.get(requestId);
    if (!waiting) {
      // The payer timed out or never existed. Silently accept — the
      // payee doesn't need to know the payer is gone.
      return c.json({ accepted: false, reason: "no payer waiting" }, 200);
    }

    clearTimeout(waiting.timer);
    waitingForResponse.delete(requestId);
    waiting.resolve(response);

    return c.json({ accepted: true }, 200);
  });

  // ── Lifecycle ──────────────────────────────────────────────────────

  return {
    close(): void {
      // Drain all pending state. Reject any outstanding response
      // promises so tests don't hang on leaked timers.
      for (const waiting of waitingForResponse.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error("relay shutting down"));
      }
      waitingForResponse.clear();

      for (const list of waitingPollers.values()) {
        for (const poller of list) {
          clearTimeout(poller.timer);
          poller.resolve(null);
        }
      }
      waitingPollers.clear();

      pendingByPayee.clear();
    },
  };
}
