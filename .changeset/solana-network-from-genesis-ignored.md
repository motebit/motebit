---
"@motebit/wallet-solana": minor
"@motebit/relay": patch
---

fix(relay,wallet-solana): every Solana chain id the relay records is read from its RPC's genesis hash, never defaulted to mainnet (#954)

The relay labelled every Solana anchor and Solana treasury-reconciliation row
`solana:5eykt4Us…` (mainnet) because `createSolanaMemoSubmitter` and the
reconciler defaulted their network and the relay never passed one. On a devnet
RPC (staging) that records devnet anchors as mainnet, and a verifier checking
the claimed chain finds nothing.

**`@motebit/wallet-solana`.**

- New `network.ts`: `resolveSolanaNetwork(readGenesisHash, { expected?, retryDelaysMs? })`
  → `resolved | mismatch | unavailable` (never throws, never defaults);
  `solanaCaip2FromGenesisHash` (`solana:` + the first 32 chars);
  `isSolanaCaip2`; the three clusters' genesis hashes and CAIP-2 ids
  (`SOLANA_TESTNET_CAIP2` is new, read from the public RPC, not transcribed).
  `createSolanaGenesisHashReader(rpcUrl)` lives beside the web3.js adapter.
- `SolanaMemoSubmitter`: the `network ?? SOLANA_MAINNET_CAIP2` default is
  gone. Before its first write it reads the RPC's genesis hash; an omitted
  `network` is derived from it, a declared one that disagrees refuses every
  write (anchor, revocation, transparency) and makes `isAvailable()` false.
  A failed read refuses that write and the next one retries. Reading
  `network` with neither a declaration nor a verified read throws.
- `OperatorSolanaTreasuryReconciler` / `createOperatorSolanaTreasuryReconciler`:
  `chain` is now required and must be a Solana CAIP-2 id (a shorthand such as
  `solana:mainnet` throws); `chain` is a public readonly field.
  `SOLANA_TREASURY_DEFAULT_CHAIN` is deprecated — it is nobody's default.

**`@motebit/relay`.** `solana-network.ts` resolves the network at boot
(four reads over ~7s) and checks it against the new optional `SOLANA_NETWORK`.
The derived id is passed to the memo submitter and the Solana reconciliation
loop (whose `chain` is now required), logged on
`operator_solana_transfer.configured`, and used by the admin
treasury-reconciliation overview, which now lists the live Solana chain plus
any Solana chain that already has rows — never a hard-coded mainnet entry.
A mismatch refuses every Solana subsystem (anchoring, reconciliation, Path-0
transfer, P2P verifier and admission, bond verifier); an unreadable genesis
hash leaves anchoring and Solana reconciliation off with an error log.
