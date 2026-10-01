/**
 * EvmRpcAdapter — EVM JSON-RPC plumbing behind a motebit-shaped interface.
 *
 * The interface exposes only what a deposit detector / log reader needs:
 * `getBlockNumber()` and `getTransferLogs(args)`. Concrete implementations
 * own envelope construction, fetch, hex parsing, and error translation —
 * all failure modes (network error, non-2xx HTTP, JSON-RPC `error` field,
 * malformed result) bubble as a single `Error`.
 *
 * Sibling of `@motebit/wallet-solana`'s `SolanaRpcAdapter`. Each chain's RPC
 * boundary owns its own wire format behind a motebit-shaped contract so the
 * relay's credit/cursor state machines never see raw JSON-RPC envelopes.
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

/** Arguments for {@link EvmRpcAdapter.getBalance}. */
export interface GetBalanceArgs {
  /** ERC-20 contract address (0x-prefixed). */
  contractAddress: string;
  /** Account address to query (0x-prefixed). */
  accountAddress: string;
}

/**
 * Minimal EVM RPC surface the deposit detector + treasury reconciliation consume.
 * Tests inject mocks.
 */
export interface EvmRpcAdapter {
  /** Current head block number. */
  getBlockNumber(): Promise<bigint>;
  /** Fetch ERC-20 Transfer-shaped logs in an inclusive block range. */
  getTransferLogs(args: GetTransferLogsArgs): Promise<EvmTransferLog[]>;
  /**
   * Query an ERC-20 `balanceOf(address)` via `eth_call`. Returns the raw
   * uint256 as a `bigint` — token decimal conversion is the caller's job
   * (rule 5: token decoding is not this package's concern).
   *
   * Used by treasury reconciliation to compare onchain balance against
   * recorded fee accumulation. Stateless (single call per query, no cursor).
   */
  getBalance(args: GetBalanceArgs): Promise<bigint>;
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

  async getBalance(args: GetBalanceArgs): Promise<bigint> {
    // ERC-20 `balanceOf(address)` selector: keccak256("balanceOf(address)")[0:4]
    // = 0x70a08231. Append the address as a 32-byte left-padded uint256.
    const BALANCE_OF_SELECTOR = "0x70a08231";
    if (!args.accountAddress.startsWith("0x") || args.accountAddress.length !== 42) {
      throw new Error(
        `eth_call balanceOf: malformed accountAddress "${args.accountAddress}" (want 0x-prefixed 20-byte hex)`,
      );
    }
    const paddedAddress = args.accountAddress.slice(2).toLowerCase().padStart(64, "0");
    const data = BALANCE_OF_SELECTOR + paddedAddress;

    const result = await this.call<string>("eth_call", [
      { to: args.contractAddress, data },
      "latest",
    ]);

    if (typeof result !== "string" || !result.startsWith("0x")) {
      throw new Error(`eth_call balanceOf returned malformed result: ${String(result)}`);
    }
    // `0x` alone (zero-length) means revert / no return data — treat as 0.
    if (result === "0x") return 0n;
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
   *
   * `requestTimeoutMs` is two bounds on one abort timer:
   *   - HEADERS: the response headers must arrive within `requestTimeoutMs`;
   *   - BODY: an IDLE bound — the timer re-arms on every body chunk, so the
   *     read fails only after `requestTimeoutMs` with NO progress.
   * A stalled body (headers, then silence) cannot hang the caller (a periodic
   * deposit tick); a slow body that keeps progressing — a large `eth_getLogs`
   * on catch-up after downtime — completes however long it takes in total.
   * A total bound would fail that catch-up on every tick and stall crediting.
   */
  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const ms = this.requestTimeoutMs;
    const controller =
      ms !== undefined && typeof AbortController !== "undefined" ? new AbortController() : null;
    // A holder, not a `let`: the handle is reassigned inside `arm`.
    const timer: { handle: ReturnType<typeof setTimeout> | undefined } = { handle: undefined };
    const arm = (): void => {
      if (!controller || ms === undefined) return;
      clearTimeout(timer.handle);
      timer.handle = setTimeout(() => controller.abort(), ms);
    };
    arm();
    try {
      return await this.callWithin<T>(method, params, controller?.signal, arm);
    } finally {
      clearTimeout(timer.handle);
    }
  }

  private async callWithin<T>(
    method: string,
    params: unknown[],
    signal: AbortSignal | undefined,
    onProgress: () => void,
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal,
      });
    } catch (err) {
      throw new Error(`RPC ${method} network error`, { cause: err });
    }
    // Headers arrived — the timer becomes the body's idle bound.
    onProgress();

    if (!res.ok) {
      throw new Error(`RPC ${method} returned HTTP ${res.status}`);
    }

    let json: { result?: unknown; error?: { code?: number; message?: string } };
    try {
      json = (await readBodyJson(res, onProgress)) as typeof json;
    } catch (err) {
      if (signal?.aborted === true) {
        throw new Error(
          `RPC ${method} timed out reading the response body (no progress for ${String(this.requestTimeoutMs)}ms)`,
          { cause: err },
        );
      }
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

/**
 * Read a response body as JSON, calling `onProgress` per chunk (the idle
 * bound re-arms on it). A `Response` without a readable stream (an injected
 * fetch) falls back to `json()`.
 */
async function readBodyJson(res: Response, onProgress: () => void): Promise<unknown> {
  const reader = res.body?.getReader();
  if (reader === undefined) return res.json();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onProgress();
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode()) as unknown;
}
