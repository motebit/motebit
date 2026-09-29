---
"@motebit/wallet-solana": minor
"@motebit/relay": patch
---

fix(relay,wallet-solana): every Solana chain id the relay records is read from its RPC's genesis hash, lazily, never defaulted to mainnet and never a boot gate (#954)

The relay labelled every Solana anchor and Solana treasury-reconciliation row
`solana:5eykt4Us…` (mainnet) because `createSolanaMemoSubmitter` and the
reconciler defaulted their network and the relay never passed one. On a devnet
RPC (staging) that records devnet anchors as mainnet, and a verifier checking
the claimed chain finds nothing.

**`@motebit/wallet-solana`.**

- New `network.ts`: `SolanaNetworkResolver` — a lazy, shared resolver over an
  RPC's `getGenesisHash`. Nothing is read at construction; `resolve()` reads
  on demand, every read is time-bounded (`SOLANA_GENESIS_READ_TIMEOUT_MS`,
  5s), `resolved` and `mismatch` are cached (a mismatch is permanent, so an
  endpoint alternating clusters can never slip a write through), a failed
  read is retried by the next call, concurrent callers share one read.
  Also `resolveSolanaNetwork` (one resolution, optional retries/timeout),
  `solanaCaip2FromGenesisHash` (`solana:` + the first 32 chars),
  `isSolanaCaip2`, the three clusters' genesis hashes and CAIP-2 ids
  (`SOLANA_TESTNET_CAIP2` is new, read from the public RPC, not transcribed),
  and `createSolanaGenesisHashReader(rpcUrl)` beside the web3.js adapter.
- `SolanaMemoSubmitter`: the `network ?? SOLANA_MAINNET_CAIP2` default is
  gone. Before each write it resolves its network (its own resolver, or a
  shared one passed as `networkResolver`); an omitted `network` is derived,
  a declared one that disagrees refuses every write (anchor, revocation,
  transparency) and makes `isAvailable()` false, an unreadable or hung read
  refuses that write and the next one retries.
- `OperatorSolanaTreasuryReconciler` / `createOperatorSolanaTreasuryReconciler`:
  `chain` is now required and must be a Solana CAIP-2 id; `chain` is a public
  readonly field. `SOLANA_TREASURY_DEFAULT_CHAIN` is deprecated.

**`@motebit/relay`.** `solana-network.ts` builds one lazy resolver over
`SOLANA_RPC_URL` (checked against the new optional `SOLANA_NETWORK`); boot
never awaits it (a warm-up read is fired, not awaited) and every Solana
subsystem is constructed as before. The memo submitter shares it; the Solana
reconciliation loop resolves the chain per cycle and records nothing (warn)
while unresolved; P2P admission reads the payer only once it resolves (a
retryable 503 otherwise, and permanently on a mismatch). A supervised
`solana-network` loop re-reads it while unresolved, and
`GET /api/v1/admin/health` carries `solana_network`
(`pending | resolved | unavailable | mismatch`, network, reason). The admin
treasury-reconciliation overview lists the live resolved chain plus any
Solana chain that already has rows — never a hard-coded mainnet entry.
Subsystems that record no chain id (Path-0 transfer, p2p and bond verifiers,
bond-backing reads, onramp) do not consult the network.
