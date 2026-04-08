/**
 * Sovereign Receipt Exchange — the transport-agnostic protocol for
 * getting a signed SovereignPaymentReceipt from a payee after paying
 * them directly via the sovereign rail.
 *
 * ## Problem
 *
 * Motebit A pays Motebit B via `runtime.sendUsdc(bAddress, amount)`.
 * The USDC moves onchain. But A has no trust-bearing artifact from B
 * until B signs a SovereignPaymentReceipt acknowledging the payment
 * and the service rendered. B's signature on that receipt is what
 * feeds A's local trust store via `bumpTrustFromReceipt` — the final
 * step in the sovereign trust loop.
 *
 * The gap between "payment sent" and "receipt received" is a message
 * exchange: A asks B for a receipt, B signs one, B returns it.
 *
 * ## Protocol shape
 *
 * This module defines the **protocol** — the message format and the
 * transport interface. It does NOT define any specific transport.
 * The protocol is rails-plural in the same sense as settlement:
 *
 *   - Rails are plural, receipts are singular (settlement spec §3.5).
 *   - Transports are plural, request/response format is singular.
 *
 * Valid transports include:
 *
 *   - Relay-mediated A2A messaging (existing infrastructure, simplest)
 *   - Direct HTTP callback to a well-known endpoint (pure p2p, requires
 *     counterparty to advertise a reachable URL)
 *   - WebRTC / libp2p mesh (fully peer-to-peer, no intermediaries)
 *   - Shared memory / IPC (for in-process tests and same-device flows)
 *
 * This file provides two things:
 *
 *   1. The `SovereignReceiptRequest` / `SovereignReceiptResponse`
 *      message format that every transport MUST carry.
 *   2. The `SovereignReceiptExchangeAdapter` interface that the runtime
 *      consumes. Surfaces inject a concrete implementation at runtime
 *      construction time; the runtime calls `request(...)` to send and
 *      registers a handler via `onIncomingRequest(...)` to receive.
 *
 * An in-memory reference implementation (`InMemoryReceiptExchangeHub`)
 * is provided for tests and in-process scenarios — two runtimes share
 * a hub, and requests are routed directly between them without any
 * network call. This is the implementation the end-to-end sovereign
 * trust loop test uses.
 *
 * Real network transports (A2A-relayed, HTTP direct, libp2p) are
 * deferred to future work blocks. Each is a separate adapter that
 * implements `SovereignReceiptExchangeAdapter` from its own package,
 * with no changes required to the runtime or this file.
 *
 * ## Protocol conformance
 *
 * An implementation is receipt-exchange-conformant iff:
 *
 *   1. The request carries all fields needed to reconstruct the
 *      signed receipt payload (tx_hash, amounts, hashes, timestamps,
 *      service description, tools used).
 *   2. The response contains either a signed `ExecutionReceipt` or an
 *      error with a machine-readable code.
 *   3. The signed receipt, once returned, is verifiable by the payer
 *      using only the payee's public Ed25519 key (embedded in the
 *      receipt's `public_key` field) — no relay lookup required.
 *   4. The transport does NOT authorize or modify the receipt. It is
 *      a dumb pipe between payer and payee.
 *
 * The runtime's verification step enforces (3) by calling
 * `verifyExecutionReceipt` before feeding the receipt into the trust
 * loop. Malformed or unsigned receipts are rejected and do not
 * affect local trust.
 */

import type { ExecutionReceipt } from "@motebit/sdk";

// ── Message types ─────────────────────────────────────────────────────

/**
 * Request sent by the payer to the payee asking for a signed
 * SovereignPaymentReceipt after an onchain payment has been submitted.
 *
 * All fields are required because the payee uses them to reconstruct
 * the exact receipt payload that will be signed. The `tx_hash` field
 * anchors the request to a specific onchain event — an optional
 * verifier adapter can cross-check this against the public ledger
 * before signing.
 */
export interface SovereignReceiptRequest {
  /** The payer's motebit ID. Used by the payee for context and audit. */
  payer_motebit_id: string;
  /** The payer's device ID. Included for audit trail completeness. */
  payer_device_id: string;
  /** The payee's motebit ID. The recipient of this request routes on this. */
  payee_motebit_id: string;
  /** Rail identifier (e.g., "solana", "aptos", "sui"). */
  rail: string;
  /** Onchain transaction signature/hash. Anchors the receipt to a public proof. */
  tx_hash: string;
  /** Payment amount in micro-units (6 decimals for USDC). */
  amount_micro: bigint;
  /** Asset symbol (e.g., "USDC"). */
  asset: string;
  /**
   * The payee's expected receiving address. Used by the payee to verify
   * that the onchain payment (if cross-checked) landed at its own wallet.
   */
  payee_address: string;
  /** Human-readable description of the service being paid for. */
  service_description: string;
  /** SHA-256 hash of the original request payload. */
  prompt_hash: string;
  /** SHA-256 hash of the result payload delivered to the payer. */
  result_hash: string;
  /** Tools the payee used to render the service. Empty array is valid. */
  tools_used: string[];
  /** When the payer submitted the request to the payee (unix milliseconds). */
  submitted_at: number;
  /** When the payee completed the work (unix milliseconds). */
  completed_at: number;
}

/**
 * Response returned by the payee. Exactly one of `receipt` or `error`
 * is set — never both, never neither.
 *
 * When the payee signs, `receipt` carries the full ExecutionReceipt
 * with the payee's Ed25519 signature over the canonical JSON of the
 * receipt fields. The payer verifies using `verifyExecutionReceipt`.
 *
 * When the payee declines, `error` carries a machine-readable code
 * and a human-readable message. Codes are intentionally coarse; a
 * richer error ontology is deferred until real transports ship.
 */
export interface SovereignReceiptResponse {
  /** Set on success — the signed receipt bound to the onchain payment. */
  receipt?: ExecutionReceipt;
  /** Set on failure — the payee declined to sign. */
  error?: {
    code:
      | "payment_not_verified"
      | "service_not_rendered"
      | "address_mismatch"
      | "duplicate_request"
      | "unknown";
    message: string;
  };
}

// ── Transport interface ───────────────────────────────────────────────

/**
 * The adapter the runtime uses to send and receive sovereign receipt
 * requests. Surfaces inject a concrete implementation at runtime
 * construction time via `RuntimeConfig.sovereignReceiptExchange`.
 *
 * Implementations MUST:
 *
 *   - Route requests to the motebit identified by `payee_motebit_id`
 *   - Deliver the response back to the caller, even if the transport
 *     is asynchronous under the hood
 *   - Not modify, inspect, or authorize the request/response contents
 *     beyond what is strictly required for routing
 *   - Be safe to call concurrently from multiple payer interactions
 *
 * Implementations MAY:
 *
 *   - Retry transient failures (with exponential backoff)
 *   - Cache responses briefly (but not modify them)
 *   - Log request/response metadata for diagnostics (NOT content)
 *   - Timeout long-outstanding requests and return an `error` response
 */
export interface SovereignReceiptExchangeAdapter {
  /**
   * Send a receipt request to the target motebit and await the
   * response. The target is identified by `req.payee_motebit_id`;
   * the first argument is a convenience for transports that route
   * on the outer envelope rather than inspecting the payload.
   *
   * Timeout and retry policy are transport-specific. Implementations
   * SHOULD resolve within a bounded time (e.g., 30 seconds) or return
   * an error response with code `"unknown"` and a timeout message.
   */
  request(payeeMotebitId: string, req: SovereignReceiptRequest): Promise<SovereignReceiptResponse>;

  /**
   * Register a handler that produces receipt responses for incoming
   * requests. The handler is called once per incoming request. The
   * runtime sets this exactly once at construction time; implementations
   * MAY replace the handler if called a second time or MAY throw.
   *
   * The handler's return value becomes the response. Exceptions
   * thrown by the handler SHOULD be mapped to an `error` response
   * with code `"unknown"` by the transport before delivery.
   */
  onIncomingRequest(
    handler: (req: SovereignReceiptRequest) => Promise<SovereignReceiptResponse>,
  ): void;
}

// ── In-memory reference implementation ────────────────────────────────

/**
 * An in-process hub that connects multiple runtimes directly. Used by
 * tests and by surfaces that want two motebits to exchange receipts
 * without any network transport (e.g., a CLI demo running two
 * identities in the same process).
 *
 * Usage:
 *
 * ```ts
 * const hub = new InMemoryReceiptExchangeHub();
 * const alice = new MotebitRuntime(
 *   { motebitId: "alice", sovereignReceiptExchange: hub.adapterFor("alice") },
 *   ...
 * );
 * const bob = new MotebitRuntime(
 *   { motebitId: "bob", sovereignReceiptExchange: hub.adapterFor("bob") },
 *   ...
 * );
 *
 * // alice.requestSovereignReceipt("bob", ...) routes through the hub
 * // directly to bob.handleSovereignReceiptRequest, no network call.
 * ```
 *
 * The hub is thread-safe for single-threaded JavaScript. It is NOT a
 * production transport — it has no network, no persistence, no
 * delivery guarantees across process restarts. Use a real network
 * adapter for cross-process or cross-device settings.
 */
export class InMemoryReceiptExchangeHub {
  private readonly handlers = new Map<
    string,
    (req: SovereignReceiptRequest) => Promise<SovereignReceiptResponse>
  >();

  /**
   * Return a transport adapter scoped to a specific motebit ID. Pass
   * this to the corresponding runtime's `sovereignReceiptExchange`
   * config field. Each motebit sharing the hub gets its own adapter;
   * the hub routes requests between them by motebit ID.
   */
  adapterFor(motebitId: string): SovereignReceiptExchangeAdapter {
    return {
      request: async (
        payeeMotebitId: string,
        req: SovereignReceiptRequest,
      ): Promise<SovereignReceiptResponse> => {
        const handler = this.handlers.get(payeeMotebitId);
        if (!handler) {
          return {
            error: {
              code: "unknown",
              message: `No handler registered for motebit ${payeeMotebitId}`,
            },
          };
        }
        try {
          return await handler(req);
        } catch (err: unknown) {
          return {
            error: {
              code: "unknown",
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
      },
      onIncomingRequest: (handler) => {
        this.handlers.set(motebitId, handler);
      },
    };
  }

  /**
   * Remove a motebit's handler from the hub. Useful for test teardown
   * to prevent leaked handlers between test cases.
   */
  disconnect(motebitId: string): void {
    this.handlers.delete(motebitId);
  }

  /** Number of connected motebits. Useful for tests and diagnostics. */
  get size(): number {
    return this.handlers.size;
  }
}
