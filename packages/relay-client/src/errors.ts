/**
 * One error shape out — the same discipline `@motebit/evm-rpc` applies to
 * JSON-RPC: every wire-level failure (network, non-2xx, malformed body,
 * schema mismatch, missing credentials) collapses to a single thrown
 * `RelayClientError` with a closed `kind`, so consumers write one catch
 * arm instead of re-deriving the relay's failure taxonomy per call site.
 */

/** Closed set of client-side failure classes. */
export type RelayClientErrorKind =
  /** fetch itself failed — DNS, refused connection, aborted, offline. */
  | "network"
  /** The relay answered with a non-2xx status. `status` is set. */
  | "http"
  /** The response body was not the JSON the endpoint promises. */
  | "parse"
  /** The body parsed as JSON but failed wire-schema validation. */
  | "schema"
  /** No usable credential for an endpoint that requires one. */
  | "auth";

export class RelayClientError extends Error {
  readonly kind: RelayClientErrorKind;
  /** HTTP status when `kind === "http"`. */
  readonly status?: number;
  /** Request path (no origin, no query) — safe for logs. */
  readonly path: string;
  /** Relay-provided error body text when available (non-2xx responses). */
  readonly body?: string;

  constructor(
    kind: RelayClientErrorKind,
    path: string,
    message: string,
    options?: { status?: number; body?: string; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "RelayClientError";
    this.kind = kind;
    this.path = path;
    this.status = options?.status;
    this.body = options?.body;
  }
}
