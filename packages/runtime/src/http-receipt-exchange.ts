/**
 * HTTP direct receipt exchange transport — pure peer-to-peer.
 *
 * The simplest possible real network transport for the sovereign
 * receipt exchange protocol. Two motebits on different processes (or
 * different machines) can exchange signed receipts via HTTP POST, with
 * no relay, no broker, no third party in the loop. Each motebit runs
 * a tiny HTTP server on a port, the payer POSTs a
 * `SovereignReceiptRequest` to the payee's URL, the payee's server
 * routes the request to the runtime's handler, signs the receipt, and
 * returns it in the HTTP response.
 *
 * This is the protocol-shaped answer to "how do two sovereign motebits
 * actually talk to each other without any relay":
 *
 *   - The server side uses Node's built-in `http` module, loaded via
 *     dynamic `import("node:http")` so web bundles don't accidentally
 *     pull in Node-only code. The server only materializes when the
 *     caller actually passes a `server` config to `createHttp
 *     ReceiptExchange`.
 *
 *   - The client side uses global `fetch` (Node 18+, browsers). Every
 *     surface that has fetch can be a payer; only Node surfaces can
 *     be a payee via this specific transport. Web surfaces that want
 *     to be payees would use a different adapter (relay-mediated WS,
 *     WebRTC, libp2p) — that's why the protocol is transport-plural.
 *
 *   - Peer discovery is NOT solved by this transport. The payer is
 *     told the payee's URL directly, via a `peers` map passed at
 *     construction time or updated later via `registerPeer`. Discovery
 *     (DNS, well-known, registry, DHT) is a separate concern that
 *     future work will address; it lives above this transport layer.
 *
 * ## Wire format
 *
 * - `POST {baseUrl}/receipts` — the only endpoint.
 * - Body: `application/json`, contains a `SovereignReceiptRequest`.
 * - Response: `application/json`, contains a `SovereignReceiptResponse`.
 * - Status codes: 200 for a valid response (even if the response
 *   carries an `error` payload — that is a protocol-level error, not
 *   an HTTP error), 400 for malformed JSON, 500 for unexpected server
 *   failures.
 *
 * The wire format is deliberately tiny. A future spec
 * (`motebit/sovereign-receipt-exchange@1.0`) may formalize it, at
 * which point this file becomes one reference implementation among
 * many.
 *
 * ## BigInt handling
 *
 * `SovereignReceiptRequest.amount_micro` is a `bigint`. JSON does not
 * natively carry bigints — they serialize to strings and deserialize
 * back to bigints via custom reviver logic. This file handles that
 * conversion transparently on both the client and server sides so
 * callers work with `bigint` end to end.
 *
 * ## Security posture
 *
 * This transport has **no auth and no TLS by default**. The receipts
 * it carries are cryptographically signed, so tampering in transit
 * breaks verification at the payer (fail-closed). But request/response
 * bodies are readable by anyone on the network path. Production
 * deployments SHOULD:
 *
 *   - Run behind TLS (reverse proxy, or use `https.createServer`)
 *   - Optionally add an auth token (the auth is per-motebit and
 *     orthogonal to the receipt's cryptographic binding)
 *   - Consider rate limiting at the reverse proxy layer
 *
 * None of these are implemented here — they are operational concerns
 * layered on top of the transport, not the transport itself.
 */

import type {
  SovereignReceiptExchangeAdapter,
  SovereignReceiptRequest,
  SovereignReceiptResponse,
} from "./sovereign-receipt-exchange.js";

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Configuration for an HTTP direct receipt exchange adapter.
 *
 * Both `server` and `peers` are optional. A motebit that only pays
 * (never gets paid) needs only `peers`. A motebit that only receives
 * payments (never pays) needs only `server`. A typical motebit that
 * does both specifies both.
 */
export interface HttpReceiptExchangeConfig {
  /**
   * Server config. When present, the adapter spins up a Node HTTP
   * server on the specified port and routes incoming requests to the
   * handler registered via `onIncomingRequest`. When absent, the
   * adapter is client-only — it can send requests but cannot receive
   * them.
   */
  server?: {
    /** Port to listen on. Required. */
    port: number;
    /** Host to bind to. Defaults to "127.0.0.1" (localhost-only). */
    host?: string;
    /**
     * Path prefix for the receipt exchange endpoint. The full endpoint
     * URL is `${host}:${port}${pathPrefix}/receipts`. Defaults to "".
     */
    pathPrefix?: string;
  };
  /**
   * Known peer map: motebit ID → base URL. The base URL should include
   * the scheme, host, port, and any path prefix, e.g.
   * "http://localhost:4002". Additional peers may be added later via
   * `registerPeer`.
   */
  peers?: Map<string, string> | Record<string, string>;
  /**
   * Request timeout in milliseconds. Defaults to 30000 (30 seconds).
   * Requests that don't resolve within this window return an error
   * response with code "unknown" and a timeout message.
   */
  timeoutMs?: number;
}

/**
 * The returned adapter extends `SovereignReceiptExchangeAdapter` with
 * three additional methods for peer management and server lifecycle.
 */
export interface HttpReceiptExchange extends SovereignReceiptExchangeAdapter {
  /** Register or update a peer's base URL. */
  registerPeer(motebitId: string, baseUrl: string): void;
  /** Remove a peer from the registry. */
  removePeer(motebitId: string): void;
  /**
   * Shut down the HTTP server (if running) and release the port.
   * Idempotent — safe to call multiple times or when no server is
   * running. Returns a promise that resolves once the server is fully
   * closed. MUST be called during test teardown and app shutdown to
   * prevent port leaks.
   */
  close(): Promise<void>;
  /**
   * The actual base URL the server is listening on. Null when no
   * server was configured. Useful in tests where the port may be
   * assigned dynamically.
   */
  readonly baseUrl: string | null;
}

// ── JSON encoding for bigints ─────────────────────────────────────────

/**
 * JSON replacer that converts bigints to tagged strings. Receipt
 * payloads carry `amount_micro: bigint`, which JSON does not natively
 * support. We tag the serialized string with a marker so the reviver
 * can identify and restore the bigint on the other side.
 */
function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return { __bigint__: value.toString() };
  }
  return value;
}

/**
 * JSON reviver that restores tagged bigint strings back to bigints.
 */
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
 * Build an HTTP direct receipt exchange adapter. Returns an object
 * implementing `SovereignReceiptExchangeAdapter` plus peer-management
 * and lifecycle methods.
 *
 * Typical usage:
 *
 * ```ts
 * // Payee side
 * const bobTransport = await createHttpReceiptExchange({
 *   server: { port: 4002 },
 * });
 * const bob = new MotebitRuntime({
 *   motebitId: "bob",
 *   signingKeys: bobKeys,
 *   sovereignReceiptExchange: bobTransport,
 * }, ...);
 *
 * // Payer side
 * const aliceTransport = await createHttpReceiptExchange({
 *   peers: { bob: "http://localhost:4002" },
 * });
 * const alice = new MotebitRuntime({
 *   motebitId: "alice",
 *   signingKeys: aliceKeys,
 *   sovereignReceiptExchange: aliceTransport,
 * }, ...);
 *
 * await alice.requestSovereignReceipt("bob", { ...request });
 * // Alice's trust store now reflects Bob, no relay touched.
 *
 * // Teardown
 * await aliceTransport.close();
 * await bobTransport.close();
 * ```
 */
export async function createHttpReceiptExchange(
  config: HttpReceiptExchangeConfig,
): Promise<HttpReceiptExchange> {
  const peers = new Map<string, string>();
  if (config.peers instanceof Map) {
    for (const [k, v] of config.peers) peers.set(k, v);
  } else if (config.peers) {
    for (const [k, v] of Object.entries(config.peers)) peers.set(k, v);
  }
  const timeoutMs = config.timeoutMs ?? 30_000;

  let handler: ((req: SovereignReceiptRequest) => Promise<SovereignReceiptResponse>) | null = null;

  // Server lifecycle. The server is created lazily inside this async
  // factory because it requires a Node-only dynamic import — web
  // bundles won't reach this code path unless they ask for it.
  let server: import("node:http").Server | null = null;
  let boundBaseUrl: string | null = null;

  if (config.server) {
    // Dynamic import keeps @motebit/runtime importable from web bundles.
    // `node:http` is Node-only; the dynamic import ensures bundlers
    // don't statically pull it into browser builds.
    const http = await import("node:http");
    const port = config.server.port;
    const host = config.server.host ?? "127.0.0.1";
    const pathPrefix = config.server.pathPrefix ?? "";
    const endpointPath = `${pathPrefix}/receipts`;

    server = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== endpointPath) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      // Collect the body (small — sovereign receipt requests are <2KB)
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        (async (): Promise<void> => {
          try {
            const bodyText = Buffer.concat(chunks).toString("utf8");
            const parsedRequest = decodeJson<SovereignReceiptRequest>(bodyText);

            if (!handler) {
              const response: SovereignReceiptResponse = {
                error: {
                  code: "unknown",
                  message: "No incoming-request handler registered",
                },
              };
              res.statusCode = 200;
              res.setHeader("Content-Type", "application/json");
              res.end(encodeJson(response));
              return;
            }

            let response: SovereignReceiptResponse;
            try {
              response = await handler(parsedRequest);
            } catch (err: unknown) {
              response = {
                error: {
                  code: "unknown",
                  message: err instanceof Error ? err.message : String(err),
                },
              };
            }

            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end(encodeJson(response));
          } catch (err: unknown) {
            // Malformed JSON or other unexpected error. Return 400 so
            // the caller knows the request itself was invalid.
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          }
        })().catch(() => {
          // Should not reach here — the inner try/catch covers all paths.
          // If it does, close the response to avoid hanging the client.
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.end();
          }
        });
      });
    });

    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(port, host, () => {
        server!.removeListener("error", reject);
        resolve();
      });
    });

    const address = server.address();
    const actualPort = typeof address === "object" && address != null ? address.port : port;
    boundBaseUrl = `http://${host}:${actualPort}${pathPrefix}`;
  }

  const adapter: HttpReceiptExchange = {
    get baseUrl() {
      return boundBaseUrl;
    },

    registerPeer(motebitId: string, baseUrl: string): void {
      peers.set(motebitId, baseUrl);
    },

    removePeer(motebitId: string): void {
      peers.delete(motebitId);
    },

    async request(
      payeeMotebitId: string,
      req: SovereignReceiptRequest,
    ): Promise<SovereignReceiptResponse> {
      const baseUrl = peers.get(payeeMotebitId);
      if (!baseUrl) {
        return {
          error: {
            code: "unknown",
            message: `No peer registered for motebit ${payeeMotebitId}`,
          },
        };
      }

      const endpoint = `${baseUrl}/receipts`;
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: encodeJson(req),
          signal: controller.signal,
        });

        if (!response.ok) {
          return {
            error: {
              code: "unknown",
              message: `HTTP ${response.status} from ${endpoint}`,
            },
          };
        }

        const text = await response.text();
        return decodeJson<SovereignReceiptResponse>(text);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          error: {
            code: "unknown",
            message: msg.includes("abort")
              ? `Timeout after ${timeoutMs}ms contacting ${endpoint}`
              : msg,
          },
        };
      } finally {
        clearTimeout(timeoutHandle);
      }
    },

    onIncomingRequest(incomingHandler) {
      handler = incomingHandler;
    },

    async close(): Promise<void> {
      if (!server) return;
      const srv = server;
      server = null;
      boundBaseUrl = null;
      await new Promise<void>((resolve, reject) => {
        srv.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };

  return adapter;
}
