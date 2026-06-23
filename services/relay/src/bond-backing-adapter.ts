/**
 * Lazy read-only Solana adapter for accept-time bond-backing re-verification.
 *
 * spec/bond-v1.md §6: a relying party that grants an effect on the strength of a
 * bond MUST re-verify backing AT DECISION TIME — a fresh cached read within the
 * staleness bound, else a synchronous balance check. The settlement-eligibility
 * gate (`evaluateSettlementEligibility`) is that relying party; this is the
 * synchronous-check seam it uses when a bond's cached reading is stale or the
 * bond was just submitted (still `pending`, never checked by the verifier loop).
 *
 * One process-lifetime instance, constructed on first use. Returns `null` when
 * `SOLANA_RPC_URL` is unset — bonds are inert, so the gate simply never has an
 * adapter and a stale read fails closed. The zero seed makes the read-only intent
 * explicit: `getUsdcBalanceOf` never derives or uses a keypair. Reads, never
 * moves — no custody implication (CLAUDE.md rule 19).
 *
 * This is the relay's medium-plumbing boundary for the bond path — the same
 * `Web3JsRpcAdapter` the bond verifier loop and the p2p verifier use, constructed
 * once here so the per-submission hot path does not build a fresh client.
 */

import { Web3JsRpcAdapter, type SolanaRpcAdapter } from "@motebit/wallet-solana";

/** The narrow capability the eligibility gate needs — backing reads only. */
export type BondBackingReader = Pick<SolanaRpcAdapter, "getUsdcBalanceOf">;

const READ_ONLY_SEED = new Uint8Array(32);

let cached: BondBackingReader | null | undefined;

/**
 * The shared read-only backing reader, or `null` when no Solana RPC is
 * configured (bonds inert). Memoized for the process lifetime.
 */
export function getBondBackingAdapter(): BondBackingReader | null {
  if (cached !== undefined) return cached;
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    cached = null;
    return cached;
  }
  cached = new Web3JsRpcAdapter({
    rpcUrl,
    identitySeed: READ_ONLY_SEED,
    ...(process.env.SOLANA_USDC_MINT ? { usdcMint: process.env.SOLANA_USDC_MINT } : {}),
  });
  return cached;
}

/**
 * Test seam — inject a stub reader (or `null` to force the no-adapter path) and
 * reset between cases. Never called in production.
 */
export function __setBondBackingAdapterForTest(reader: BondBackingReader | null | undefined): void {
  cached = reader;
}
