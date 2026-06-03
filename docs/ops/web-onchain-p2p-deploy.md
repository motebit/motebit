# Web surface — enable onchain P2P (prod)

What it takes for **motebit.com** to read the sovereign balance and run a real
paid P2P delegation. Three layers must all be current + configured: **relay**
(Fly), **worker** (Fly), **web** (Vercel). The web layer is the one that bites —
the browser needs a real Solana RPC, and the deployed bundle drifts behind `main`.

## The two things that block it (both web-side)

1. **Browser RPC.** `api.mainnet-beta.solana.com` **403s browser origins** — it
   can neither read the balance nor broadcast the payment tx. The web surface
   needs a CORS-capable provider. Without it the balance shows "—/Couldn't
   refresh" (after the false-zero fix) and any onchain send errors.
2. **Stale bundle.** A deployed web build behind `main` calls dead relay paths
   (e.g. `/agent/:id/budget` → 404) and lacks the current P2P client. Redeploy.

## Vercel env (Project → Settings → Environment Variables)

| Var                      | Value                                                                                                                                            | Why                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `VITE_SOLANA_RPC_URL`    | a browser-capable mainnet RPC, e.g. `https://mainnet.helius-rpc.com/?api-key=…` (Helius/Triton/QuickNode free tier — they allow browser origins) | balance read + P2P broadcast from the browser                                      |
| `VITE_MOTEBIT_RELAY_URL` | `https://relay.motebit.com`                                                                                                                      | canonical relay env (replaces the deprecated `VITE_PROXY_URL`; remove the old one) |

Redeploy after changing env (Vercel doesn't rebuild on env change alone).

### RPC key security

`VITE_*` vars ship in the client bundle, so the RPC key is publicly extractable.
The provider is commodity: it never touches keys or funds (it only relays signed
bytes and reads public chain data) and it is swappable behind `SolanaRpcAdapter`,
so the only exposure is quota abuse. Two mitigations:

- **Now:** in the Helius dashboard, restrict the key by allowed origin/domain
  (`motebit.com`). Rotate if abused (free tier — low stakes).
- **Later:** proxy RPC through our own relay (which already holds a server-side
  `SOLANA_RPC_URL`) so no key ships in the browser. Display reads proxy cleanly;
  the broadcast can move to a relay forward-signed-bytes endpoint (the relay
  forwards an already-signed tx — still sovereign; the relay never holds the key).

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
