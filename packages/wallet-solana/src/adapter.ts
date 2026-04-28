/**
 * SolanaRpcAdapter — the boundary between the rail interface and any
 * concrete Solana RPC client.
 *
 * The adapter is intentionally narrow: it does only the four things
 * the rail needs (own address, balance, send, reachability). All
 * @solana/web3.js (or @solana/kit, or any other library) coupling
 * lives in concrete implementations of this interface — never in the
 * rail itself.
 *
 * Tests inject a fake adapter; production wires the Web3JsRpcAdapter.
 */

export interface SendUsdcArgs {
  /** Recipient base58 Solana address. */
  toAddress: string;
  /** Amount in USDC micro-units (6 decimals). */
  microAmount: bigint;
}

export interface SendUsdcResult {
  /** Transaction signature (base58). */
  signature: string;
  /** Slot the transaction landed in (or 0 if not yet confirmed). */
  slot: number;
  /** Whether the network has reached the configured commitment level. */
  confirmed: boolean;
}

/**
 * Per-item outcome in a batch send. Either the item landed in a
 * confirmed transaction (ok=true, signature present) or it failed
 * (ok=false, reason present). Items within a single Solana transaction
 * are atomic — they all succeed or all fail together. Items that were
 * not submitted because a prior chunk failed return ok=false with
 * reason "prior chunk failed."
 */
export interface SendUsdcBatchItemResult {
  ok: boolean;
  signature: string | null;
  slot: number;
  reason: string | null;
}

/**
 * Closed, motebit-shaped result of looking up a Solana transaction by
 * signature. The discrimination is load-bearing: p2p payment
 * verification MUST distinguish `not_found` (authoritative null,
 * terminal, triggers trust downgrade) from `rpc_error` (transient,
 * retry, never downgrades trust). See `spec/settlement-v1.md` §11.1
 * Foundation Law: "Payment verification status MUST distinguish
 * between transaction not found (permanent) and RPC error
 * (transient/retryable). A transient error MUST NOT trigger trust
 * downgrade."
 *
 *   - `not_found`: the tx does not exist onchain at the configured
 *     commitment level. Also returned when the tx exists but carries
 *     no SPL transfer instruction the verifier can parse — the
 *     verifier should treat both the same (no verifiable payment).
 *   - `confirmed`: the tx landed at the configured commitment and an
 *     SPL transfer was extracted. `from` and `to` are base58 **owner**
 *     addresses (NOT Associated Token Account addresses); the verifier
 *     compares them directly to the declared `settlement_address`.
 *     `amountMicro` is the exact transfer amount — p2p §11.1 forbids
 *     `>=` matching. `asset` is the SPL mint's short name (today:
 *     always `"USDC"`).
 *   - `rpc_error`: any failure the RPC boundary couldn't classify as
 *     authoritative null. The caller retries; the settlement state
 *     stays pending.
 */
export type TxVerificationResult =
  | { status: "not_found" }
  | {
      status: "confirmed";
      from: string;
      to: string;
      amountMicro: bigint;
      slot: number;
      asset: string;
    }
  | { status: "rpc_error"; reason: string };

export interface SolanaRpcAdapter {
  /** The wallet's own base58 address (derived from the keypair seed). */
  readonly ownAddress: string;

  /** USDC balance in micro-units. Returns 0 if no token account exists yet. */
  getUsdcBalance(): Promise<bigint>;

  /** Native SOL balance in lamports. */
  getSolBalance(): Promise<bigint>;

  /**
   * Send USDC to a counterparty address. Creates the destination
   * Associated Token Account if it doesn't exist (payer = self).
   * Throws InsufficientUsdcBalanceError when the source balance is
   * lower than `microAmount`. Throws InvalidSolanaAddressError when
   * `toAddress` is not a valid base58 public key.
   */
  sendUsdc(args: SendUsdcArgs): Promise<SendUsdcResult>;

  /**
   * Send USDC to multiple counterparties in as few Solana transactions
   * as possible. Each transaction carries up to MAX_TRANSFERS_PER_TX
   * transfer instructions (conservative for the 1232-byte tx limit).
   * ATA creation instructions are prepended where needed.
   *
   * Chunking is internal. Fail-fast: if any chunk fails, subsequent
   * chunks are NOT submitted; their items return ok=false.
   */
  sendUsdcBatch(items: readonly SendUsdcArgs[]): Promise<SendUsdcBatchItemResult[]>;

  /**
   * Fetch a transaction by signature and extract transfer details
   * sufficient to verify a p2p payment proof. Closed three-state
   * discriminated union — see `TxVerificationResult` for why the
   * boundary is classification, not retrieval.
   *
   * This method is the only authorized boundary through which relay
   * code may read Solana transactions. `services/relay/src/p2p-verifier.ts`
   * consumes it; do not add a second RPC path.
   */
  getTransaction(signature: string): Promise<TxVerificationResult>;

  /** Whether the RPC endpoint is reachable. Best-effort, no retries. */
  isReachable(): Promise<boolean>;
}
