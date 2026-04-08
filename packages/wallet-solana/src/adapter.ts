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

export interface SolanaRpcAdapter {
  /** The wallet's own base58 address (derived from the keypair seed). */
  readonly ownAddress: string;

  /** USDC balance in micro-units. Returns 0 if no token account exists yet. */
  getUsdcBalance(): Promise<bigint>;

  /**
   * Send USDC to a counterparty address. Creates the destination
   * Associated Token Account if it doesn't exist (payer = self).
   * Throws InsufficientUsdcBalanceError when the source balance is
   * lower than `microAmount`. Throws InvalidSolanaAddressError when
   * `toAddress` is not a valid base58 public key.
   */
  sendUsdc(args: SendUsdcArgs): Promise<SendUsdcResult>;

  /** Whether the RPC endpoint is reachable. Best-effort, no retries. */
  isReachable(): Promise<boolean>;
}
