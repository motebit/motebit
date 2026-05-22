/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Sync/identity relay URL — the relay serving `/api/v1/identity/:motebitId` and
   * `/.well-known/motebit-transparency.json`. Same canonical var + default as
   * `apps/web` (`storage.ts`): defaults to `https://relay.motebit.com` so the
   * binding upgrade works out of the box; override to point at another relay.
   */
  readonly VITE_RELAY_URL?: string;
  /** Solana JSON-RPC for the on-chain anchored-root cross-check. Defaults to mainnet-beta. */
  readonly VITE_SOLANA_RPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
