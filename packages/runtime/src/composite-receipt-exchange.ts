/**
 * Composite receipt exchange — try multiple transports in order,
 * fall back on transport-level errors.
 *
 * Motebits typically want a dual-transport configuration: an HTTP
 * direct adapter (the sovereign floor — pure peer-to-peer, no relay)
 * paired with a relay-mediated adapter (the paved convenience tier
 * for NAT-bound, dynamic-IP, or intermittently-online peers). This
 * composite is the primitive that lets the runtime use both without
 * caring which one succeeds.
 *
 * ## Semantics
 *
 * ### Outbound (request side)
 *
 * Iterate adapters in the order they were passed to
 * `createCompositeReceiptExchange`. For each adapter:
 *
 *   1. Call `adapter.request(payeeMotebitId, req)`.
 *   2. If the response contains a `receipt`, return it immediately.
 *      The first transport that delivers a valid signed receipt wins.
 *   3. If the response contains an `error` with code `"unknown"`,
 *      treat it as a transport-level failure (network unreachable,
 *      timeout, no peer registered, HTTP 5xx, queue full). Remember
 *      the error and try the next adapter.
 *   4. If the response contains an `error` with any other code
 *      (`"address_mismatch"`, `"payment_not_verified"`,
 *      `"service_not_rendered"`, `"duplicate_request"`), **stop
 *      falling back.** These are deterministic payee-level outcomes:
 *      the payee will respond the same way regardless of which
 *      transport delivered the request. Retrying on a different
 *      transport is pure waste.
 *   5. If all adapters fail, return the last remembered error.
 *
 * This policy gives the caller the best of both worlds: automatic
 * failover for transport problems, and fail-fast for semantic errors
 * that no transport choice can fix.
 *
 * ### Inbound (incoming request side)
 *
 * When the runtime calls `onIncomingRequest(handler)`, the composite
 * registers the SAME handler on every wrapped adapter. This is
 * critical: a motebit operating as a payee needs to accept incoming
 * requests from ANY of its configured transports, not just the first
 * one. If a peer reaches us via HTTP direct, we respond. If another
 * peer reaches us via the relay, we respond to that too. Same
 * handler, same signing key, same local state — the transport is
 * invisible to the handler.
 *
 * ## Not in scope
 *
 * This composite does not implement:
 *
 *   - Per-peer transport selection (always iterates the same order)
 *   - Circuit breakers (no short-term skipping of transports that
 *     recently failed)
 *   - Parallel dispatch (each adapter is tried sequentially)
 *   - Lifecycle management (does not close wrapped adapters)
 *
 * Those are all worthwhile enrichments but not necessary for the
 * MVP dual-transport pattern. Callers manage wrapped adapter
 * lifecycles directly; the composite is a pure routing layer.
 *
 * ## Usage
 *
 * ```ts
 * const direct = await createHttpReceiptExchange({
 *   server: { port: 4002 },
 *   peers: { bob: "http://bob.local:4001" },
 * });
 * const relayed = createRelayReceiptExchange({
 *   relayUrl: "https://relay.motebit.com",
 *   ownMotebitId: "alice",
 *   authToken: token,
 * });
 *
 * // Try direct first, fall back to relay.
 * const composite = createCompositeReceiptExchange([direct, relayed]);
 *
 * const runtime = new MotebitRuntime(
 *   { motebitId: "alice", sovereignReceiptExchange: composite, ... },
 *   ...
 * );
 *
 * // At teardown, close each wrapped adapter (composite doesn't own them):
 * await direct.close();
 * await relayed.close();
 * ```
 */

import type {
  SovereignReceiptExchangeAdapter,
  SovereignReceiptRequest,
  SovereignReceiptResponse,
} from "./sovereign-receipt-exchange.js";

/**
 * A composite adapter extends the base interface with a read-only
 * view of the wrapped adapters, useful for tests and diagnostics.
 */
export interface CompositeReceiptExchange extends SovereignReceiptExchangeAdapter {
  /** The wrapped adapters, in the order they are tried on outbound requests. */
  readonly adapters: readonly SovereignReceiptExchangeAdapter[];
}

/**
 * Create a composite receipt exchange adapter wrapping the provided
 * adapters. The order matters: outbound requests are tried from
 * first to last, falling back only on transport-level errors.
 *
 * Passing an empty array is allowed but defeats the purpose — every
 * outbound request returns an error response, and no incoming
 * requests are ever received. The adapter logs no warning in this
 * case; the caller is responsible for configuring sensibly.
 */
export function createCompositeReceiptExchange(
  adapters: SovereignReceiptExchangeAdapter[],
): CompositeReceiptExchange {
  const frozenAdapters: readonly SovereignReceiptExchangeAdapter[] = [...adapters];

  return {
    adapters: frozenAdapters,

    async request(
      payeeMotebitId: string,
      req: SovereignReceiptRequest,
    ): Promise<SovereignReceiptResponse> {
      if (frozenAdapters.length === 0) {
        return {
          error: {
            code: "unknown",
            message: "No transports configured on composite receipt exchange",
          },
        };
      }

      let lastError: SovereignReceiptResponse["error"];

      for (const adapter of frozenAdapters) {
        const response = await adapter.request(payeeMotebitId, req);

        // First success wins.
        if (response.receipt) {
          return response;
        }

        // No receipt, no error: protocol violation. Remember as a
        // synthetic error and try the next adapter.
        if (!response.error) {
          lastError = {
            code: "unknown",
            message: "Transport returned neither a receipt nor an error",
          };
          continue;
        }

        lastError = response.error;

        // Payee-level errors are deterministic — the payee will
        // respond the same way regardless of transport. Fail fast
        // so the caller gets the semantic error without wasted
        // retries.
        if (response.error.code !== "unknown") {
          return response;
        }

        // Transport-level error: fall back to the next adapter.
      }

      // All adapters failed with transport-level errors. Return the
      // last remembered error so the caller sees something useful.
      return {
        error: lastError ?? {
          code: "unknown",
          message: "All transports failed with no error details",
        },
      };
    },

    onIncomingRequest(
      handler: (req: SovereignReceiptRequest) => Promise<SovereignReceiptResponse>,
    ): void {
      // Register the same handler on every wrapped adapter. Incoming
      // requests from any transport flow to the same runtime handler.
      for (const adapter of frozenAdapters) {
        adapter.onIncomingRequest(handler);
      }
    },
  };
}
