/**
 * Solana network identity — the CAIP-2 chain id of the cluster an RPC
 * endpoint actually talks to, read from the endpoint itself.
 *
 * The law (#954): every Solana CAIP-2 id a caller records or claims is
 * DERIVED from the RPC it writes through, never assumed. A default (the old
 * `network ?? mainnet`) labels a devnet anchor "mainnet", and a verifier
 * checking the claimed chain finds nothing there.
 *
 * Per the CAIP-2 Solana namespace, the reference is the first 32 characters
 * of the cluster's base58 genesis hash — the one value an RPC cannot answer
 * for a cluster other than its own. Known clusters (read from the public
 * RPCs on 2026-09-28, not transcribed from memory):
 *
 *   mainnet-beta  5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d
 *   devnet        EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
 *   testnet       4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY
 *
 * Pure: no `@solana/web3.js` import. The RPC read is injected as a
 * {@link SolanaGenesisHashReader}; the production reader is
 * `createSolanaGenesisHashReader` in `web3js-adapter.ts`.
 */

/** Genesis hash of Solana mainnet-beta. */
export const SOLANA_MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
/** Genesis hash of Solana devnet. */
export const SOLANA_DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
/** Genesis hash of Solana testnet. */
export const SOLANA_TESTNET_GENESIS_HASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";

/** CAIP-2 id of Solana mainnet-beta. */
export const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
/** CAIP-2 id of Solana devnet. */
export const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
/** CAIP-2 id of Solana testnet. */
export const SOLANA_TESTNET_CAIP2 = "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z";

const BASE58_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_CAIP2 = /^solana:[1-9A-HJ-NP-Za-km-z]{32}$/;

/**
 * The CAIP-2 id of the cluster whose genesis hash is `genesisHash`:
 * `solana:` + its first 32 characters. Throws on anything that is not a
 * base58 hash, so a garbage RPC answer can never become a label.
 */
export function solanaCaip2FromGenesisHash(genesisHash: string): string {
  if (typeof genesisHash !== "string" || !BASE58_HASH.test(genesisHash)) {
    throw new Error(`not a Solana genesis hash: ${JSON.stringify(genesisHash)}`);
  }
  return `solana:${genesisHash.slice(0, 32)}`;
}

/** Whether `network` is a well-formed Solana CAIP-2 id (`solana:` + 32 base58 chars). */
export function isSolanaCaip2(network: string): boolean {
  return SOLANA_CAIP2.test(network);
}

/** Reads the genesis hash of the cluster an RPC endpoint serves. */
export type SolanaGenesisHashReader = () => Promise<string>;

/** What a network resolution found. */
export type SolanaNetworkResolution =
  /** The RPC answered; `network` is the cluster it serves (and equals `expected` when one was declared). */
  | { status: "resolved"; network: string; genesisHash: string }
  /** A declared network is not the cluster the RPC serves. Nothing may be written under either label. */
  | { status: "mismatch"; expected: string; network: string; genesisHash: string }
  /** The RPC's cluster could not be read. There is no network — never a default. */
  | { status: "unavailable"; reason: string; attempts: number };

export interface ResolveSolanaNetworkOptions {
  /**
   * A declared CAIP-2 id (e.g. the operator's `SOLANA_NETWORK`). When set,
   * the derived id must equal it or the result is `mismatch`. It never
   * substitutes for the read: an unreadable RPC is `unavailable` even when a
   * network is declared.
   */
  expected?: string;
  /**
   * Delays (ms) before each retry after a failed read. `[]` (the default)
   * reads once. `[500, 1000]` reads up to three times.
   */
  retryDelaysMs?: readonly number[];
  /** Sleep seam for tests. Default: `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Resolve the CAIP-2 id of the cluster behind `readGenesisHash`. Never
 * throws and never defaults: a failed read after every retry is
 * `unavailable`, a declared id that disagrees with the chain is `mismatch`.
 * A malformed declared id is a mismatch too — it cannot equal any derived id.
 */
export async function resolveSolanaNetwork(
  readGenesisHash: SolanaGenesisHashReader,
  options: ResolveSolanaNetworkOptions = {},
): Promise<SolanaNetworkResolution> {
  const delays = options.retryDelaysMs ?? [];
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError = "";
  let attempts = 0;
  for (let i = 0; i <= delays.length; i++) {
    if (i > 0) await sleep(delays[i - 1]!);
    attempts++;
    let genesisHash: string;
    let network: string;
    try {
      genesisHash = await readGenesisHash();
      network = solanaCaip2FromGenesisHash(genesisHash);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (options.expected !== undefined && options.expected !== network) {
      return { status: "mismatch", expected: options.expected, network, genesisHash };
    }
    return { status: "resolved", network, genesisHash };
  }
  return { status: "unavailable", reason: lastError, attempts };
}
