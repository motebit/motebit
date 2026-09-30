# Web surface — enable onchain P2P (prod)

What it takes for **motebit.com** to read the sovereign balance and run a real
paid P2P delegation. Three layers must all be current + configured: **relay**
(Fly), **worker** (Fly), **web** (Vercel). The web layer is the one that bites —
the browser needs a real Solana RPC, and the deployed bundle drifts behind `main`.

## The two things that block it (both web-side)

1. **Browser RPC.** `api.mainnet-beta.solana.com` **403s browser origins** — it
   can neither read the balance nor broadcast the payment tx. The web surface
   calls motebit's server-side passthrough `https://api.motebit.com/v1/solana-rpc`
   (`services/proxy`, `src/solana-rpc.ts`), which holds the provider key as the
   server secret `SOLANA_RPC_UPSTREAM_URL`. Unset ⇒ the passthrough answers 503
   and the balance shows "—/Couldn't refresh" (never a false $0).
2. **Stale bundle.** A deployed web build behind `main` calls dead relay paths
   (e.g. `/agent/:id/budget` → 404) and lacks the current P2P client. Redeploy.

## Env

| Where                                                                | Var                           | Value                                                                                        |
| -------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| proxy (Vercel, `services/proxy`)                                     | `SOLANA_RPC_UPSTREAM_URL`     | the provider mainnet URL **with its key** — a server secret, never `VITE_*`                  |
| proxy (optional)                                                     | `SOLANA_RPC_ALLOWED_ORIGINS`  | extra https origins (comma list) beyond the defaults below                                   |
| web (Vercel project `motebit-web`)                                   | `VITE_PROXY_URL`              | a motebit origin (`https://…motebit.com`) — deprecated alias of `VITE_MOTEBIT_RELAY_URL`     |
| web (Vercel project `motebit-web`)                                   | `VITE_BROWSER_SANDBOX_URL`    | the `services/browser-sandbox` origin (`*.motebit.com` or `motebit-browser-sandbox.fly.dev`) |
| web (Vercel project `motebit-web`)                                   | `VITE_STRIPE_PUBLISHABLE_KEY` | a Stripe **publishable** key (`pk_live_…`) — public by design                                |
| verify (Vercel project `receipt-computer`, https://receipt.computer) | —                             | sets **no** `VITE_*` var; defaults to the passthrough                                        |

The proxy's default browser origins are `https://motebit.com`, `https://www.motebit.com`,
`https://receipt.computer` (apps/verify) and the localhost dev ports.

**The web + verify builds are deny-by-default on public env.** Vite inlines every
`VITE_*` value into public JS — incident 2026-09-30: a Helius `?api-key=` shipped
in `motebit.com/assets/main-*.js`, the credits were drained and the provider
halted every key on the account. `apps/web` and `apps/verify` `vite.config.ts`
now refuse the build when the build env carries ANY public-prefixed var (any
case) not named in `PUBLIC_BUILD_ENV` (`scripts/lib/client-bundle-secrets.ts`),
or a named one whose value fails its validator: URL vars must be `https:` to a
host in that var's allowlist (motebit.com / \*.motebit.com / the named Fly
origin / receipt.computer for verify; `http:` only for localhost), with no
userinfo, query, fragment or key-shaped path segment; the Stripe var must be
`pk_live_`/`pk_test_`. So a provider URL — with its key in a query OR a path
(Alchemy `/v2/<key>`, QuickNode `/<hex>/`, Triton `/<uuid>`) — cannot be built
into a browser surface under any name. Adding a var to Vercel means adding it
to `PUBLIC_BUILD_ENV` first (a reviewed edit with a validator and a why), or the
next deploy fails loudly. Vercel's auto-exposed `VITE_VERCEL_*` system vars are
dropped before Vite reads them (no source reads them). **Never set
`VITE_SOLANA_RPC_URL` in a deployed project** — it is a local-dev override only.
`check-no-secrets-in-client-bundles` (#166) also scans the built bundles.
Redeploy after changing env (Vercel doesn't rebuild on env change alone).

## Deploy

- Git-connected: a production deploy of `main` (push, or dashboard **Redeploy**
  on the latest `main` commit). Confirm the deployed commit == `main` HEAD.
- The bundle hash in the page (`index-*.js`) changes on a successful redeploy.

## Worker (Fly) — already P2P-enabled, documented for repeat

```bash
fly secrets set MOTEBIT_SETTLEMENT_MODES=relay,p2p -a motebit-web-search
```

Worker derives its `settlement_address` from its identity key and advertises
`relay,p2p` on discovery. Receive-only (no sweep wired) — earnings accrue at the
derived address, operator-controlled via the worker seed. Revert:
`fly secrets unset MOTEBIT_SETTLEMENT_MODES -a motebit-web-search`.

## Post-deploy smoke check

```bash
# 1. worker advertises p2p + a settlement address
curl -s "https://relay.motebit.com/api/v1/agents/discover?capability=web_search" | grep -o '"settlement_modes":"[^"]*"'
# expect: "settlement_modes":"relay,p2p"

# 2. eligibility route exists (401 = present + needs auth, NOT 404)
curl -s -o /dev/null -w "%{http_code}\n" "https://relay.motebit.com/api/v1/agents/<workerId>/p2p-eligibility?acknowledge_no_history_risk=true"
# expect: 401
```

In the browser (motebit.com), signed in:

- **Sovereign Reserve** reads your real onchain USDC (not `0.00`, not `—`). If it
  shows `—/Couldn't refresh`, the RPC env is wrong/missing.
- Settings → **Governance** shows "Pay new agents directly" + the Approval Preset.
- Set **Autonomous** + **Pay new agents directly** on → Save.
- Fund the sovereign wallet (address in Settings → Identity → Sovereign Wallet):
  ~$0.50 USDC + ~0.02 SOL on Solana mainnet (USDC mint
  `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`).
- Ask the motebit to web-search → approve the ~$0.0526 → **Sovereign Reserve
  ticks down + a receipt lands.** First prod paid delegation.

## Verify the money moved (any machine)

```bash
# delegator (your sovereign wallet), worker, relay treasury — USDC balances
# delegator −$0.052632 · worker +$0.05 · treasury +$0.002632 (5% fee)
```

Or watch the relay log for `p2p_verifier.verified` (~1 min cycle).

## If the first run falls back to relay-mode / 402

The web bundle is still behind the June-2 P2P seam fixes (`payment_proof` wire
key + `required_capabilities`) — redeploy `main` and retry. No bad-spend risk:
pre-broadcast failures move no funds.
