/**
 * Delegator-side P2P payment-proof construction — the production counterpart to
 * the relay test helper of the same name. The test helper fakes `tx_hash`; this
 * one broadcasts the delegator's real atomic two-leg SPL transfer and assembles
 * the proof from the confirmed signature.
 *
 * After Arc 2 of the off-ramp arc, paid P2P settlement is one signed Solana
 * transaction composing two SPL Transfer instructions: the worker leg
 * (delegator → worker, the listing unit_cost the worker earns net) and the fee
 * leg (delegator → relay treasury, the platform fee). After Arc 3.5 the relay
 * REQUIRES this proof for paid cross-agent direct delegation (`requiresP2pProof`
 * in services/relay/src/tasks.ts) — this primitive is what lets a real client
 * satisfy that gate.
 *
 * Mechanics only: this function takes the two leg amounts already computed and
 * does not own fee policy. Fee math (`computeGrossAmount`) lives in
 * `@motebit/market`; the caller computes `feeAmountMicro` there so this Layer-1
 * Solana package stays free of pricing policy and cannot drift from the relay's
 * validator. See `docs/doctrine/off-ramp-as-user-action.md`.
 */

import type { P2pPaymentProof } from "@motebit/protocol";
import type { SolanaRpcAdapter } from "./adapter.js";
import { SOLANA_MAINNET_CAIP2 } from "./memo-submitter.js";

export interface BuildP2pPaymentProofArgs {
  /** Worker's declared settlement address (base58 owner address). */
  workerAddress: string;
  /**
   * Relay treasury address — `deriveSolanaAddress(relayPublicKey)`. The caller
   * MUST source the relay public key from a verified channel (the relay's
   * `/.well-known/motebit.json` or transparency declaration); a wrong address
   * sends the fee leg astray and the relay's verifier fails it closed.
   */
  treasuryAddress: string;
  /** Worker leg amount in micro-units — the listing unit_cost, what the worker earns net. */
  amountMicro: number;
  /** Fee leg amount in micro-units — `gross - net`, computed by the caller via `computeGrossAmount`. */
  feeAmountMicro: number;
  /** CAIP-2 network identifier. Defaults to Solana mainnet. */
  network?: string;
}

/**
 * Broadcast the delegator's atomic worker + treasury legs and return a
 * `P2pPaymentProof` carrying the confirmed signature.
 *
 * Both legs MUST land in a single transaction — the relay's verifier walks one
 * `tx_hash` for both legs. `sendUsdcBatch` packs up to 8 transfer instructions
 * per transaction, so two legs are always one transaction; we still assert both
 * legs succeeded under one shared signature and throw otherwise, rather than
 * emit a proof the verifier will reject (or, worse, a non-atomic payment where
 * one leg landed and the other did not).
 *
 * @throws if either leg failed to confirm, or the two legs did not share one signature.
 */
export async function buildP2pPaymentProof(
  adapter: SolanaRpcAdapter,
  args: BuildP2pPaymentProofArgs,
): Promise<P2pPaymentProof> {
  const results = await adapter.sendUsdcBatch([
    { toAddress: args.workerAddress, microAmount: BigInt(args.amountMicro) },
    { toAddress: args.treasuryAddress, microAmount: BigInt(args.feeAmountMicro) },
  ]);

  const [workerLeg, feeLeg] = results;
  if (!workerLeg?.ok || !feeLeg?.ok) {
    throw new Error(
      `P2P payment broadcast failed (worker leg: ${workerLeg?.reason ?? "ok"}; fee leg: ${feeLeg?.reason ?? "ok"})`,
    );
  }
  if (!workerLeg.signature || workerLeg.signature !== feeLeg.signature) {
    throw new Error(
      "P2P payment legs did not settle in a single atomic transaction — proof would fail verification",
    );
  }

  return {
    tx_hash: workerLeg.signature,
    chain: "solana",
    network: args.network ?? SOLANA_MAINNET_CAIP2,
    to_address: args.workerAddress,
    amount_micro: args.amountMicro,
    fee_to_address: args.treasuryAddress,
    fee_amount_micro: args.feeAmountMicro,
  };
}
