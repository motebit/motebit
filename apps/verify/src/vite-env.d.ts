/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Sync/identity relay URL — the relay serving `/api/v1/identity/:motebitId` and
   * `/.well-known/motebit-transparency.json`. Same canonical var + default as
   * `apps/web` (`storage.ts`): defaults to `https://relay.motebit.com` so the
   * binding upgrade works out of the box; override to point at another relay.
   */
  readonly VITE_RELAY_URL?: string;
  /**
   * LOCAL-DEV override only. Defaults to motebit's server-side passthrough
   * (`https://api.motebit.com/v1/solana-rpc`, services/proxy), which holds the
   * provider key as a server secret. Never set a provider URL here — Vite
   * inlines it into public JS; the build refuses any value whose host is not
   * in its allowlist (motebit.com, receipt.computer, localhost), or that carries
   * userinfo, a query or a key-in-path segment (PUBLIC_BUILD_ENV,
   * scripts/lib/client-bundle-secrets.ts). Any unlisted VITE_* var refuses too.
   */
  readonly VITE_SOLANA_RPC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
