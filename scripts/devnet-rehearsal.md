# Devnet rehearsal — paid P2P delegation, end to end, $0

Proves the full paid-P2P loop (discover → cold-start eligibility → atomic
multi-output Solana tx → two-leg onchain verification → signed receipt) on
**Solana devnet** with zero real money, before the mainnet run. The mainnet run
is the identical harness invocation with the mainnet USDC mint, a mainnet RPC,
and a wallet holding real USDC.

The trick that removes all faucet friction for the _token_: we mint our own
6-decimal SPL "USDC" and point both the relay verifier and the harness at it via
`SOLANA_USDC_MINT`. The verifier only walks transfers of the configured mint —
it never checks the mint is canonical USDC. The one thing we still need from the
network is a little devnet **SOL** for gas + ATA rent (see the funding note).

## 0. Provision the delegator (mint + SOL + test-USDC)

```bash
pnpm exec tsx scripts/devnet-rehearsal-setup.ts
```

Idempotent — persists keys + the mint to `.devnet-rehearsal/state.json`
(gitignored) and reuses them on re-run. It prints an env block: copy out
`SOLANA_USDC_MINT` and `DELEGATOR_SEED_HEX`.

> **Funding note.** The script airdrops devnet SOL via the public RPC, which is
> heavily rate-limited (HTTP 429). If it can't airdrop, it prints the delegator
> address — fund it with ~1 devnet SOL from <https://faucet.solana.com> (GitHub
> login, free) and re-run. Mint creation + test-USDC minting then run
> programmatically; no further faucet calls.

## 1. Boot the relay on devnet (current `main`)

Must run current `main` — the harness pre-flight calls `/p2p-eligibility`, which
older deploys lack. `SOLANA_USDC_MINT` MUST equal the mint from step 0 or the
verifier walks the wrong mint's accounts and fail-verifies every leg.

```bash
cd services/relay && PORT=4500 \
  MOTEBIT_DB_PATH=$PWD/../../.devnet-rehearsal/relay.db \
  X402_PAY_TO_ADDRESS=<any base58 addr> \
  SOLANA_RPC_URL=https://api.devnet.solana.com \
  SOLANA_USDC_MINT=<mint from step 0> \
  MOTEBIT_API_TOKEN=devnet-rehearsal-token \
  pnpm exec tsx src/server.ts
```

The relay auto-generates + persists its identity on first boot; its
identity-derived Solana address is the fee-leg treasury (logged as
`relayTreasuryAddress`, and served at `/.well-known/motebit.json`, which the
harness pins). Confirm `p2p_verifier.started` + `relay.listening port 4500`.

## 2. Boot a P2P-enabled worker pointed at the relay

```bash
cd services/web-search && \
  MOTEBIT_PORT=3200 \
  MOTEBIT_DATA_DIR=$PWD/../../.devnet-rehearsal/worker \
  MOTEBIT_DB_PATH=$PWD/../../.devnet-rehearsal/worker/web-search.db \
  MOTEBIT_SYNC_URL=http://localhost:4500 \
  MOTEBIT_API_TOKEN=devnet-rehearsal-token \
  MOTEBIT_AUTH_TOKEN=devnet-rehearsal-token \
  MOTEBIT_SETTLEMENT_MODES=relay,p2p \
  MOTEBIT_PUBLIC_URL=http://localhost:3200 \
  pnpm exec tsx src/index.ts
```

The worker only _receives_ — `MOTEBIT_SETTLEMENT_MODES=relay,p2p` makes it
advertise a `settlement_address` (derived from its own identity) + p2p mode; no
onchain action on its side. Confirm it appears with `settlement_modes: "relay,p2p"`:

```bash
curl -s "http://localhost:4500/api/v1/agents/discover?capability=web_search"
```

## 3. Dry-run, then the real devnet broadcast

```bash
SEED=$(node -e "console.log(require('./.devnet-rehearsal/state.json').delegatorSeedHex)")
STAGING_RELAY_URL=http://localhost:4500 \
STAGING_AUTH_TOKEN=devnet-rehearsal-token \
DELEGATOR_MOTEBIT_ID=delegator-devnet-rehearsal-0001 \
DELEGATOR_SEED_HEX=$SEED \
SOLANA_RPC_URL=https://api.devnet.solana.com \
SOLANA_USDC_MINT=<mint from step 0> \
CAPABILITY=web_search \
pnpm run p2p-staging-proof          # dry run — prints the plan, NO broadcast
```

When the plan looks right and the balance is sufficient, prepend `DRY_RUN=0` to
broadcast the real (devnet) atomic multi-output tx. Watch the relay log for
`p2p_verifier.verified` (~1 min cycle) and the harness for the signed receipt.

## Mainnet

Identical to step 3 with `SOLANA_USDC_MINT` = mainnet USDC
(`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`), a mainnet `SOLANA_RPC_URL`, the
production relay (`https://relay.motebit.com`) + a P2P-enabled prod worker, and a
delegator wallet holding real USDC + a little SOL. No code differs — only the
chain.

## Teardown

```bash
# stop the relay + worker, then:
rm -rf .devnet-rehearsal      # devnet-only keys + mint, valueless
```
