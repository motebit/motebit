/**
 * Constants and error types for the Solana wallet rail.
 */

/** Mainnet USDC mint (base58). */
export const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Devnet USDC mint (base58). Useful for tests and development. */
export const USDC_MINT_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

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

/**
 * Thrown by a transfer (`send`, `sendBatch`, `buildP2pPayment`) when the
 * wallet holds less SOL than the gas floor — BEFORE anything is signed or
 * broadcast. The automatic USDC → SOL top-up is disabled (Jupiter swaps are
 * refused until intent-bound transaction validation exists), so the remedy
 * is to fund the wallet with SOL directly.
 */
export class InsufficientSolForGasError extends Error {
  readonly code = "insufficient_sol_for_gas" as const;
  /** SOL held, in lamports. */
  readonly availableLamports: bigint;
  /** The gas floor, in lamports. */
  readonly requiredLamports: bigint;

  constructor(availableLamports: bigint, requiredLamports: bigint) {
    super(
      `Insufficient SOL for network fees: have ${availableLamports.toString()} lamports, need at least ${requiredLamports.toString()} lamports. Fund this wallet's address with SOL directly; automatic USDC-to-SOL top-up is disabled.`,
    );
    this.name = "InsufficientSolForGasError";
    this.availableLamports = availableLamports;
    this.requiredLamports = requiredLamports;
  }
}
