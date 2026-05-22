/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Base URL of the relay whose receipts this verifier resolves identity for
   * (e.g. `https://relay.motebit.com`). When set, a verified receipt's binding
   * is upgraded from `integrity-only` toward `pinned`/`anchored` by fetching the
   * relay's identity material. Absent → the verifier stays purely offline.
   */
  readonly VITE_RELAY_BASE?: string;
  /** Solana JSON-RPC for the on-chain anchored-root cross-check. Defaults to mainnet-beta. */
  readonly VITE_SOLANA_RPC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
