/**
 * Constants and error types for the Solana wallet rail.
 */

/** Mainnet USDC mint (base58). */
export const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Devnet USDC mint (base58). Useful for tests and development. */
export const USDC_MINT_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/** USDC has 6 decimals on Solana — same as motebit micro-units. */
export const USDC_DECIMALS = 6;

/**
 * Thrown when a USDC transfer is attempted but the agent's wallet
 * holds less than the requested amount. Distinct from RPC failures
 * so callers can present a clear "fund your wallet" message instead
 * of retrying.
 */
export class InsufficientUsdcBalanceError extends Error {
  readonly available: bigint;
  readonly requested: bigint;

  constructor(available: bigint, requested: bigint) {
    super(
      `Insufficient USDC balance: have ${available.toString()} micro-USDC, need ${requested.toString()} micro-USDC`,
    );
    this.name = "InsufficientUsdcBalanceError";
    this.available = available;
    this.requested = requested;
  }
}

/**
 * Thrown when a recipient address is not a valid Solana base58 public
 * key. The constructor message preserves the offending input so the
 * caller can surface it without re-parsing.
 */
export class InvalidSolanaAddressError extends Error {
  readonly address: string;

  constructor(address: string, cause?: unknown) {
    super(`Invalid Solana address: ${address}`, cause !== undefined ? { cause } : undefined);
    this.name = "InvalidSolanaAddressError";
    this.address = address;
  }
}
