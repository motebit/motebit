/**
 * The relay's Solana network — read from the RPC it talks to, never assumed
 * (#954).
 *
 * Every Solana CAIP-2 id the relay records or claims (the `network` column
 * on settlement / agent-settlement / credential / identity-log anchor rows,
 * the `chain` column on Solana treasury-reconciliation rows, the admin
 * reconciliation overview) must name the cluster `SOLANA_RPC_URL` actually
 * serves. The old wiring labelled everything mainnet by default, so a relay
 * on a devnet RPC would record devnet anchors as mainnet and a verifier
 * checking the claimed chain would find nothing.
 *
 * Boot reads the RPC's genesis hash once (with bounded retries) through the
 * `@motebit/wallet-solana` primitive and decides:
 *
 *   - `resolved`    — `network` is the derived id; every Solana subsystem starts.
 *   - `mismatch`    — `SOLANA_NETWORK` is set and the RPC serves another
 *                     cluster. The operator's declaration contradicts the
 *                     chain: EVERY Solana subsystem refuses to start (no
 *                     anchor, no reconciliation, no Path-0 transfer, no P2P
 *                     verification or admission).
 *   - `unavailable` — the genesis read failed on every attempt. There is no
 *                     network, so nothing that labels a chain starts
 *                     (anchoring, Solana treasury reconciliation); the
 *                     subsystems that only read or send through the RPC and
 *                     record no chain id keep running. Never a mainnet
 *                     fallback — restart once the RPC answers.
 */
import {
  createSolanaGenesisHashReader,
  resolveSolanaNetwork,
  type SolanaGenesisHashReader,
} from "@motebit/wallet-solana";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "solana-network" });

/** Default backoff between genesis-hash reads at boot: four reads over ~7s. */
export const SOLANA_NETWORK_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

export interface RelaySolanaNetwork {
  /** The CAIP-2 id of the cluster the RPC serves. Undefined ⇒ nothing may label a chain. */
  network: string | undefined;
  /** True when a declared network contradicts the RPC: no Solana subsystem may start. */
  refused: boolean;
}

export interface ResolveRelaySolanaNetworkOptions {
  rpcUrl: string;
  /** The operator's `SOLANA_NETWORK`, if set (an empty string counts as unset). */
  declared?: string;
  /** Backoff between reads. Default {@link SOLANA_NETWORK_RETRY_DELAYS_MS}. */
  retryDelaysMs?: readonly number[];
  /** Genesis reader seam. Default: `getGenesisHash` on `rpcUrl`. */
  readGenesisHash?: SolanaGenesisHashReader;
}

/** Resolve (and log) the relay's Solana network at boot. Never throws. */
export async function resolveRelaySolanaNetwork(
  options: ResolveRelaySolanaNetworkOptions,
): Promise<RelaySolanaNetwork> {
  const declared =
    options.declared !== undefined && options.declared.trim() !== ""
      ? options.declared.trim()
      : undefined;
  const outcome = await resolveSolanaNetwork(
    options.readGenesisHash ?? createSolanaGenesisHashReader(options.rpcUrl),
    {
      ...(declared !== undefined ? { expected: declared } : {}),
      retryDelaysMs: options.retryDelaysMs ?? SOLANA_NETWORK_RETRY_DELAYS_MS,
    },
  );
  switch (outcome.status) {
    case "resolved":
      logger.info("solana.network_resolved", {
        network: outcome.network,
        genesisHash: outcome.genesisHash,
        declared: declared ?? null,
      });
      return { network: outcome.network, refused: false };
    case "mismatch":
      logger.error("solana.network_mismatch", {
        declared: outcome.expected,
        network: outcome.network,
        genesisHash: outcome.genesisHash,
        consequence:
          "every Solana subsystem refuses to start: SOLANA_NETWORK names a cluster the SOLANA_RPC_URL does not serve — fix one of them",
      });
      return { network: undefined, refused: true };
    case "unavailable":
      logger.error("solana.network_unresolved", {
        reason: outcome.reason,
        attempts: outcome.attempts,
        consequence:
          "anchoring and Solana treasury reconciliation stay disabled: the RPC's cluster is unknown and no network is ever assumed — restart once getGenesisHash answers",
      });
      return { network: undefined, refused: false };
  }
}
