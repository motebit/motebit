/**
 * Jupiter swap adapter — glucose absorbed through the metabolic boundary.
 *
 * Jupiter is the Solana DEX aggregator. We don't build swap logic; we
 * call Jupiter's HTTP API to get a quote + serialized transaction, sign
 * it with the motebit's key, and submit it. The adapter is deliberately
 * minimal: quote + swap. Future operations (limit orders, DCA) are
 * separate adapters.
 *
 * Used by the gas floor primitive: when the wallet has USDC but no SOL,
 * auto-swap a tiny amount of USDC → SOL so the agent can pay transaction
 * fees. The user never sees the word "SOL."
 */

import { Connection, VersionedTransaction, type Commitment } from "@solana/web3.js";
import type { Keypair } from "@solana/web3.js";

/** SOL mint (native, wrapped). */
const SOL_MINT = "So11111111111111111111111111111111111111112";

/** USDC mint (mainnet). */
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Jupiter V6 API base URL. */
const JUPITER_API = "https://quote-api.jup.ag/v6";

export interface JupiterSwapResult {
  /** Transaction signature. */
  signature: string;
  /** Input amount in source token's smallest unit. */
  inputAmount: bigint;
  /** Output amount in destination token's smallest unit. */
  outputAmount: bigint;
}

/**
 * Swap USDC → SOL via Jupiter. Returns the transaction signature.
 *
 * @param usdcMicroAmount — Amount of USDC to swap in micro-units (6 decimals).
 *   For gas floor: 20000 micro = $0.02 ≈ 0.0001 SOL ≈ 20 transactions.
 *   Typical gas floor: 2000000 micro = $2.00 ≈ enough for thousands of txns.
 * @param keypair — The motebit's Solana keypair (signs the swap transaction).
 * @param connection — Solana RPC connection.
 * @param commitment — Confirmation level.
 * @param usdcMint — USDC mint address (override for devnet).
 */
export async function swapUsdcToSol(
  usdcMicroAmount: bigint,
  keypair: Keypair,
  connection: Connection,
  commitment: Commitment = "confirmed",
  usdcMint: string = USDC_MINT,
): Promise<JupiterSwapResult> {
  const walletAddress = keypair.publicKey.toBase58();

  // 1. Get quote
  const quoteUrl = new URL(`${JUPITER_API}/quote`);
  quoteUrl.searchParams.set("inputMint", usdcMint);
  quoteUrl.searchParams.set("outputMint", SOL_MINT);
  quoteUrl.searchParams.set("amount", usdcMicroAmount.toString());
  quoteUrl.searchParams.set("slippageBps", "100"); // 1% slippage for small amounts

  const quoteRes = await fetch(quoteUrl.toString());
  if (!quoteRes.ok) {
    throw new Error(`Jupiter quote failed: HTTP ${quoteRes.status}`);
  }
  const quote = await quoteRes.json();

  // 2. Get swap transaction
  const swapRes = await fetch(`${JUPITER_API}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: walletAddress,
      wrapAndUnwrapSol: true,
    }),
  });
  if (!swapRes.ok) {
    throw new Error(`Jupiter swap failed: HTTP ${swapRes.status}`);
  }
  const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };

  // 3. Deserialize, sign, submit
  const txBuffer = Buffer.from(swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(txBuffer);
  tx.sign([keypair]);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: commitment,
  });

  // 4. Confirm
  const latestBlockhash = await connection.getLatestBlockhash(commitment);
  await connection.confirmTransaction({ signature, ...latestBlockhash }, commitment);

  return {
    signature,
    inputAmount: usdcMicroAmount,
    outputAmount: BigInt((quote as { outAmount?: string }).outAmount ?? "0"),
  };
}
