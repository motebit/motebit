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
  /**
   * Executor-relay (B) treasury address — `deriveSolanaAddress(peerRelayPublicKey)`.
   * Present ONLY for cross-operator FEDERATED P2P (delegation to a worker hosted
   * on a different operator). Adds a THIRD leg to the atomic tx (the executor
   * relay's fee). When set, `executorFeeAmountMicro` MUST also be set. The
   * caller sources the peer relay's public key from the discovery response / the
   * peer's transparency declaration. See `docs/doctrine/off-ramp-as-user-action.md`
   * § federated P2P.
   */
  executorTreasuryAddress?: string;
  /** Executor-relay fee leg amount in micro-units (federated P2P only). */
  executorFeeAmountMicro?: number;
  /** CAIP-2 network identifier. Defaults to Solana mainnet. */
  network?: string;
}

/**
 * Broadcast the delegator's atomic legs and return a `P2pPaymentProof` carrying
 * the confirmed signature. Two legs for single-operator P2P (worker + relay
 * treasury); THREE for cross-operator federated P2P (worker + origin-relay fee +
 * executor-relay fee, when `executorTreasuryAddress`/`executorFeeAmountMicro`
 * are supplied).
 *
 * All legs MUST land in a single transaction — the relay verifiers walk one
 * `tx_hash` for the legs they own. `sendUsdcBatch` packs up to 8 transfer
 * instructions per transaction, so two or three legs are always one
 * transaction; we still assert every leg succeeded under one shared signature
 * and throw otherwise, rather than emit a proof the verifier will reject (or,
 * worse, a non-atomic payment where one leg landed and the others did not).
 *
 * @throws if any leg failed to confirm, or the legs did not share one signature.
 */
export async function buildP2pPaymentProof(
  adapter: SolanaRpcAdapter,
  args: BuildP2pPaymentProofArgs,
): Promise<P2pPaymentProof> {
  // Federated (cross-operator) P2P adds a third leg — the executor relay's fee.
  // Both executor fields travel together; reject a half-specified executor leg
  // so a caller can't silently drop the leg the executor relay will require.
  const isFederated = args.executorTreasuryAddress != null || args.executorFeeAmountMicro != null;
  if (
    isFederated &&
    (args.executorTreasuryAddress == null || args.executorFeeAmountMicro == null)
  ) {
    throw new Error(
      "Federated P2P proof requires BOTH executorTreasuryAddress and executorFeeAmountMicro",
    );
  }

  const legs = [
    { toAddress: args.workerAddress, microAmount: BigInt(args.amountMicro) },
    { toAddress: args.treasuryAddress, microAmount: BigInt(args.feeAmountMicro) },
    ...(isFederated
      ? [
          {
            toAddress: args.executorTreasuryAddress!,
            microAmount: BigInt(args.executorFeeAmountMicro!),
          },
        ]
      : []),
  ];
  const results = await adapter.sendUsdcBatch(legs);

  const workerLeg = results[0];
  // Every leg must confirm under ONE shared signature — the relay verifiers walk
  // a single tx_hash for the legs they own. A partial/non-atomic broadcast must
  // never become a proof.
  if (results.length !== legs.length || results.some((r) => !r?.ok)) {
    throw new Error(
      `P2P payment broadcast failed (legs: ${results.map((r) => r?.reason ?? "ok").join(", ")})`,
    );
  }
  const sig = workerLeg!.signature;
  if (!sig || results.some((r) => r.signature !== sig)) {
    throw new Error(
      "P2P payment legs did not settle in a single atomic transaction — proof would fail verification",
    );
  }

  return {
    tx_hash: sig,
    chain: "solana",
    network: args.network ?? SOLANA_MAINNET_CAIP2,
    to_address: args.workerAddress,
    amount_micro: args.amountMicro,
    fee_to_address: args.treasuryAddress,
    fee_amount_micro: args.feeAmountMicro,
    ...(isFederated
      ? {
          b_fee_to_address: args.executorTreasuryAddress,
          b_fee_amount_micro: args.executorFeeAmountMicro,
        }
      : {}),
  };
}
