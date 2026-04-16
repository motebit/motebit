/**
 * EvmRpcAdapter — chain RPC plumbing, hidden behind a motebit-shaped interface.
 *
 * ## Why this adapter exists
 *
 * Per `services/api/CLAUDE.md` rule 1, the relay must never inline protocol
 * plumbing. Rule 13 extends the doctrine to **medium plumbing** — third-party
 * webhook schemas, provider SDK churn, and here, external chain RPC protocols.
 * The deposit-detector previously constructed raw JSON-RPC payloads
 * (`eth_blockNumber`, `eth_getLogs`) and `fetch`ed them directly. That couples
 * the relay's credit/cursor state machine to EVM RPC's quirks.
 *
 * This adapter follows the same pattern as
 * `settlement-rails/x402-rail.ts` (X402FacilitatorClient) and
 * `webhooks/stripe-webhook-adapter.ts` (SubscriptionEventAdapter): the
 * interface speaks motebit, the implementation speaks the foreign protocol.
 *
 * Sibling in `@motebit/wallet-solana` (SolanaRpcAdapter) owns the Solana RPC
 * boundary for the sovereign rail. The EVM RPC boundary has no existing owner
 * — inline adapter suffices until a second consumer appears, at which point
 * package extraction is a trivial follow-up.
 *
 * ## Shape
 *
 *   - `EvmTransferLog` — motebit-shaped log record. Topic hex and amount hex
 *     are preserved verbatim; decoding to micros is the caller's
 *     responsibility (only the caller knows the token's decimals).
 *   - `EvmRpcAdapter` — interface exposing only what the detector needs:
 *     `getBlockNumber()` and `getTransferLogs(args)`.
 *   - `HttpJsonRpcEvmAdapter` — concrete implementation that owns the raw
 *     JSON-RPC envelope, `fetch` call, hex parsing, and error handling.
 *
 * All failure modes (network error, non-2xx HTTP, JSON-RPC `error` field,
 * malformed result) bubble as a single `Error`. The detector's existing
 * try/catch already collapses failures to "return 0 credits, advance no
 * cursor"; a narrow exception path matches that shape.
 */

/**
 * Motebit-shaped Transfer log record. The caller applies token-specific
 * decoding (decimals → micro-units).
 */
export interface EvmTransferLog {
  /** Block number the log was emitted in. */
  blockNumber: bigint;
  /** Transaction hash (0x-prefixed). */
  txHash: string;
  /** The log's index within the transaction. */
  logIndex: number;
  /** topics[1] — indexed `from` parameter, 0x-prefixed 32-byte hex. */
  fromTopic: string;
  /** topics[2] — indexed `to` parameter, 0x-prefixed 32-byte hex. */
  toTopic: string;
  /** The log's `data` field — 0x-prefixed hex encoding the uint256 value. */
  amountHex: string;
}

/** Arguments for {@link EvmRpcAdapter.getTransferLogs}. */
export interface GetTransferLogsArgs {
  fromBlock: bigint;
  toBlock: bigint;
  /** ERC-20 contract address (0x-prefixed). */
  contractAddress: string;
  /** Event topic0 — e.g., keccak256("Transfer(address,address,uint256)"). */
  topic0: string;
  /**
   * Optional filter on the indexed `to` topic. Unused today (the detector
   * filters in-memory against its agent-wallet map), but kept on the
   * interface so future consumers can narrow server-side.
   */
  toAddressTopic?: string;
}

/**
 * Minimal EVM RPC surface the deposit detector consumes. Tests inject mocks.
 */
export interface EvmRpcAdapter {
  /** Current head block number. */
  getBlockNumber(): Promise<bigint>;
  /** Fetch ERC-20 Transfer-shaped logs in an inclusive block range. */
  getTransferLogs(args: GetTransferLogsArgs): Promise<EvmTransferLog[]>;
}

// ── HTTP JSON-RPC implementation ─────────────────────────────────────────

export interface HttpJsonRpcEvmAdapterConfig {
  /** HTTP(S) JSON-RPC endpoint. */
  rpcUrl: string;
  /** Per-request timeout in ms. Default: no timeout (relies on `fetch`'s). */
  requestTimeoutMs?: number;
  /** Injected fetch for testability. Default: `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Shape of a JSON-RPC log entry returned by `eth_getLogs`. Intentionally
 * narrow — we decode only the fields the detector needs.
 */
interface RawJsonRpcLog {
  transactionHash: string;
  logIndex: string;
  topics: string[];
  data: string;
  blockNumber: string;
}

/**
 * Concrete {@link EvmRpcAdapter} that speaks HTTP JSON-RPC. Owns envelope
 * construction, `fetch`, hex parsing, and error translation.
 */
export class HttpJsonRpcEvmAdapter implements EvmRpcAdapter {
  private readonly rpcUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number | undefined;

  constructor(config: HttpJsonRpcEvmAdapterConfig) {
    this.rpcUrl = config.rpcUrl;
    this.fetchFn = config.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = config.requestTimeoutMs;
  }

  async getBlockNumber(): Promise<bigint> {
    const result = await this.call<string>("eth_blockNumber", []);
    if (typeof result !== "string" || !result.startsWith("0x")) {
      throw new Error(`eth_blockNumber returned malformed result: ${String(result)}`);
    }
    return BigInt(result);
  }

  async getTransferLogs(args: GetTransferLogsArgs): Promise<EvmTransferLog[]> {
    const topics: (string | null)[] = [args.topic0];
    if (args.toAddressTopic !== undefined) {
      // topics[1] = from (unconstrained), topics[2] = to (filtered).
      topics.push(null, args.toAddressTopic);
    }

    const result = await this.call<RawJsonRpcLog[]>("eth_getLogs", [
      {
        address: args.contractAddress,
        topics,
        fromBlock: "0x" + args.fromBlock.toString(16),
        toBlock: "0x" + args.toBlock.toString(16),
      },
    ]);

    if (!Array.isArray(result)) {
      throw new Error("eth_getLogs returned non-array result");
    }

    const out: EvmTransferLog[] = [];
    for (const log of result) {
      if (
        typeof log !== "object" ||
        log === null ||
        typeof log.transactionHash !== "string" ||
        typeof log.logIndex !== "string" ||
        typeof log.data !== "string" ||
        typeof log.blockNumber !== "string" ||
        !Array.isArray(log.topics)
      ) {
        throw new Error("eth_getLogs returned malformed log entry");
      }
      if (log.topics.length < 3) continue;
      if (log.topics[0] !== args.topic0) continue;

      out.push({
        blockNumber: BigInt(log.blockNumber),
        txHash: log.transactionHash,
        logIndex: parseInt(log.logIndex, 16),
        fromTopic: log.topics[1]!,
        toTopic: log.topics[2]!,
        amountHex: log.data,
      });
    }
    return out;
  }

  /**
   * Execute a JSON-RPC call. Collapses every failure mode
   * (network / non-2xx / JSON-RPC error / malformed envelope) to an `Error`.
   */
  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const controller =
      this.requestTimeoutMs !== undefined && typeof AbortController !== "undefined"
        ? new AbortController()
        : null;
    const timeoutHandle =
      controller && this.requestTimeoutMs !== undefined
        ? setTimeout(() => controller.abort(), this.requestTimeoutMs)
        : null;

    let res: Response;
    try {
      res = await this.fetchFn(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller?.signal,
      });
    } catch (err) {
      throw new Error(`RPC ${method} network error`, { cause: err });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    if (!res.ok) {
      throw new Error(`RPC ${method} returned HTTP ${res.status}`);
    }

    let json: { result?: unknown; error?: { code?: number; message?: string } };
    try {
      json = (await res.json()) as typeof json;
    } catch (err) {
      throw new Error(`RPC ${method} returned non-JSON body`, { cause: err });
    }

    if (json.error != null) {
      const code = json.error.code ?? "?";
      const message = json.error.message ?? "unknown";
      throw new Error(`RPC ${method} error ${code}: ${message}`);
    }
    if (json.result === undefined) {
      throw new Error(`RPC ${method} response missing result field`);
    }
    return json.result as T;
  }
}
