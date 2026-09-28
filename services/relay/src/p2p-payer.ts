/**
 * A P2P payment proof is bound to its PAYER (#918 round 2).
 *
 * A P2P `payment_proof` is a Solana transaction hash, and a transaction hash
 * is public the moment it lands. Before this, admission never asked who paid:
 * anyone who saw the transaction could submit it under their own route and
 * prompt. On main that got the thief free work; with the one-proof-one-task
 * binding it would also lock the payer out of the task their own money funds.
 *
 * The rule: a P2P submission is admissible only when the transaction's payer
 * (the single source of its transfer legs, `TxVerificationResult.from`) is
 * the SUBMITTER's identity-derived Solana address,
 * `deriveSolanaAddress(public_key)` — identity key = address, the derived
 * rung of docs/doctrine/settlement-authority-binding.md. The key is:
 *
 *   - for a caller authenticated by a signed token: the key that token
 *     verified under, in this request (possession proven now; every surface
 *     pays from the wallet its signing key derives — `identitySeed:
 *     signingKeys.privateKey`);
 *   - for the operator's master token acting for a body `submitted_by`: any
 *     key the relay holds for that identity (`keysHeldBy`) — the operator is
 *     the authority that asserts the submitter;
 *   - for anyone else: none, so the submission is refused.
 *
 * The check runs BEFORE any admission write, so a refusal claims nothing and
 * frees the Idempotency-Key.
 *
 * Reading the payer needs the chain. The relay reads it through the same
 * `SolanaRpcAdapter.getTransaction` the p2p verifier uses, synchronously at
 * submission — the bond gate's accept-time re-verification is the precedent.
 * Fail closed: no RPC configured, an RPC error, or a transaction not (yet)
 * visible at `confirmed` commitment refuses the submission as 503 (retryable,
 * nothing admitted), never admits an unverified payment.
 */
import {
  Web3JsRpcAdapter,
  deriveSolanaAddress,
  type SolanaRpcAdapter,
} from "@motebit/wallet-solana";
import type { DatabaseDriver } from "@motebit/persistence";
import { keysHeldBy } from "./identity-keys.js";

/** What the chain says about a P2P payment transaction's payer. */
export type P2pPayerVerdict =
  /** The transaction landed and its single payer is one of the candidates. */
  | { status: "payer" }
  /** The transaction landed and its payer is someone else. */
  | { status: "not_payer" }
  /** Not visible at the read commitment (not landed yet, or never). */
  | { status: "not_found" }
  /** The chain could not be read. */
  | { status: "unavailable"; reason: string };

/**
 * The relay's seam onto the chain for the payer question. Production is
 * {@link paymentChainFromAdapter}; tests inject a fake chain.
 */
export interface P2pPaymentChain {
  /** Did one of `candidates` (base58 Solana addresses) pay transaction `txHash`? */
  payerOf(txHash: string, candidates: ReadonlySet<string>): Promise<P2pPayerVerdict>;
}

/**
 * The production chain: `getTransaction` through the wallet-solana adapter,
 * the payer compared EXACTLY (base58 is case-sensitive) against the
 * candidates. The comparison lives here, in relay code, not in the adapter.
 */
export function paymentChainFromAdapter(
  adapter: Pick<SolanaRpcAdapter, "getTransaction">,
): P2pPaymentChain {
  return {
    async payerOf(txHash, candidates) {
      let tx: Awaited<ReturnType<SolanaRpcAdapter["getTransaction"]>>;
      try {
        tx = await adapter.getTransaction(txHash);
      } catch (err) {
        return { status: "unavailable", reason: err instanceof Error ? err.message : String(err) };
      }
      if (tx.status === "rpc_error") return { status: "unavailable", reason: tx.reason };
      if (tx.status === "not_found") return { status: "not_found" };
      return candidates.has(tx.from) ? { status: "payer" } : { status: "not_payer" };
    },
  };
}

const READ_ONLY_SEED = new Uint8Array(32);

/**
 * The chain configured by the environment (`SOLANA_RPC_URL`, and
 * `SOLANA_USDC_MINT` — the payer is read on the mint the legs are paid in),
 * or `null` when no RPC is configured. `null` refuses every P2P submission.
 */
export function paymentChainFromEnv(): P2pPaymentChain | null {
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) return null;
  return paymentChainFromAdapter(
    new Web3JsRpcAdapter({
      rpcUrl,
      identitySeed: READ_ONLY_SEED,
      ...(process.env.SOLANA_USDC_MINT ? { usdcMint: process.env.SOLANA_USDC_MINT } : {}),
    }),
  );
}

function addressOf(publicKeyHex: string): string | null {
  if (!/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) return null;
  try {
    return deriveSolanaAddress(Uint8Array.from(Buffer.from(publicKeyHex, "hex")));
  } catch {
    return null;
  }
}

/**
 * The addresses that may have paid for a submission by this caller. Empty
 * when the request proves no key: then nothing is admissible.
 */
export function payerCandidates(
  db: DatabaseDriver,
  caller: {
    /** The key the request's signed token verified under (lowercase hex). */
    verifiedKey: string | undefined;
    /** The master token authenticated the request (positively marked). */
    operator: boolean;
    /** The submitter the operator asserts. */
    submitter: string | undefined;
  },
): Set<string> {
  const out = new Set<string>();
  const add = (k: string) => {
    const a = addressOf(k);
    if (a !== null) out.add(a);
  };
  if (caller.verifiedKey != null) {
    add(caller.verifiedKey);
    return out;
  }
  if (caller.operator && caller.submitter != null) {
    for (const k of keysHeldBy(db, caller.submitter)) add(k);
  }
  return out;
}
