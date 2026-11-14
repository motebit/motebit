/**
 * Jupiter swap adapter — DISABLED (containment).
 *
 * Jupiter is the Solana DEX aggregator. This adapter used to fetch a quote
 * and a serialized swap transaction from Jupiter's HTTP API, deserialize the
 * bytes, sign them with the motebit's IDENTITY keypair and broadcast them.
 * Nothing inspected the transaction's instructions, accounts or amounts, so a
 * compromised or MITM'd API response could have had the identity key sign a
 * USDC transfer-out, a SetAuthority on the USDC token account, or a System
 * Assign — anything at all. Two paths reached it: the rail's automatic gas
 * top-up (`SolanaWalletRail.ensureGas`) and the owner-invoked `wallet swap`.
 *
 * Containment: every function here refuses BEFORE any network call and
 * before the keypair is touched, through ONE choke point
 * (`refuseJupiterSwap`). The fetch-deserialize-sign code is deleted, not
 * guarded: `scripts/check-third-party-tx-signing.ts` fails CI on any code
 * that signs an externally built transaction outside a registered validator
 * module, and that registry is empty. Swaps return only with an
 * intent-bound transaction validator — a separately gated design.
 *
 * The signatures are kept so callers compile and receive the typed refusal.
 */

import type { Commitment, Connection, Keypair } from "@solana/web3.js";

/** Machine-readable code of {@link JupiterSwapDisabledError}. */
export const JUPITER_SWAP_DISABLED = "jupiter_swap_disabled" as const;

/** The swaps this adapter offered. */
export type JupiterSwapOperation = "swapUsdcToSol" | "swapSolToUsdc";

/**
 * Thrown by every Jupiter swap function. Nothing was fetched, nothing was
 * signed, nothing was broadcast: the refusal happens before any of it.
 */
export class JupiterSwapDisabledError extends Error {
  readonly code = JUPITER_SWAP_DISABLED;
  /** Which swap was refused. */
  readonly operation: JupiterSwapOperation;

  constructor(operation: JupiterSwapOperation) {
    super("swaps are disabled until intent-bound transaction validation exists");
    this.name = "JupiterSwapDisabledError";
    this.operation = operation;
  }
}

/**
 * THE choke point. Every function that would sign a Jupiter-built
 * transaction calls this first, and it never returns. Exported so a surface
 * offering a swap affordance (the CLI's `wallet swap`) refuses through the
 * same door, before it asks for the passphrase.
 */
export function refuseJupiterSwap(operation: JupiterSwapOperation): never {
  throw new JupiterSwapDisabledError(operation);
}

export interface JupiterSwapResult {
  /** Transaction signature. */
  signature: string;
  /** Input amount in source token's smallest unit. */
  inputAmount: bigint;
  /** Output amount in destination token's smallest unit. */
  outputAmount: bigint;
}

/**
 * Swap USDC → SOL via Jupiter. DISABLED: always rejects with
 * {@link JupiterSwapDisabledError} before any network call or signature.
 */
export function swapUsdcToSol(
  _usdcMicroAmount: bigint,
  _keypair: Keypair,
  _connection: Connection,
  _commitment?: Commitment,
  _usdcMint?: string,
): Promise<JupiterSwapResult> {
  return Promise.resolve().then(() => refuseJupiterSwap("swapUsdcToSol"));
}

/**
 * The gas floor — the SOL balance below which the rail refuses to sign a
 * transfer (`InsufficientSolForGasError`) instead of letting it fail onchain.
 * 0.005 SOL ≈ thousands of standard transfers of headroom.
 */
export const GAS_FLOOR_LAMPORTS = 5_000_000n;

/**
 * Swap SOL → USDC via Jupiter. DISABLED: always rejects with
 * {@link JupiterSwapDisabledError} before any network call or signature.
 */
export function swapSolToUsdc(
  _solLamports: bigint,
  _keypair: Keypair,
  _connection: Connection,
  _commitment?: Commitment,
  _usdcMint?: string,
): Promise<JupiterSwapResult> {
  return Promise.resolve().then(() => refuseJupiterSwap("swapSolToUsdc"));
}
