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

/**
 * Thrown by a transfer (`send`, `sendBatch`, `buildP2pPayment`, and the
 * adapter's `sendUsdc` / `sendUsdcBatch` / `sendUsdcDurable`) when the wallet
 * was constructed with a `spendableMints` allowlist and the mint it would
 * sign for is not on it — BEFORE the gas check, before any RPC read, and
 * before anything is signed or broadcast. Also thrown when the allowlist is
 * present and the adapter reports no mint (fail closed).
 *
 * The mint is part of what gets signed (a transfer names token accounts
 * derived from it), so the refusal needs no network read and does not depend
 * on which cluster the RPC serves.
 */
export class RailSpendRefusedError extends Error {
  readonly code = "rail_spend_refused" as const;
  /** The mint the wallet would have signed for; `null` when the adapter reports none. */
  readonly mint: string | null;
  /** The mints this wallet may sign for. */
  readonly spendableMints: readonly string[];

  constructor(mint: string | null, spendableMints: readonly string[]) {
    super(
      `Spend refused before signing: this wallet may sign transfers only for mint(s) [${spendableMints.join(", ")}], and its mint is ${mint ?? "not reported by the adapter"}. Nothing was signed or sent.`,
    );
    this.name = "RailSpendRefusedError";
    this.mint = mint;
    this.spendableMints = spendableMints;
  }
}

/**
 * Is a transfer in `mint` refused under `spendableMints`? No allowlist ⇒ never
 * refused (unrestricted). With an allowlist, refused unless `mint` is reported
 * and listed — an adapter that reports no mint is refused.
 */
export function isSpendRefused(
  spendableMints: readonly string[] | undefined,
  mint: string | undefined,
): boolean {
  if (spendableMints === undefined) return false;
  return mint === undefined || !spendableMints.includes(mint);
}
