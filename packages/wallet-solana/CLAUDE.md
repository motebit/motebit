# @motebit/wallet-solana

Sovereign Solana USDC rail. Layer 1, BSL. The reference `SovereignRail` implementation.

## Rules

1. **`custody: "agent"` — relay never signs.** The motebit's Ed25519 identity key IS its Solana address (mathematical accident: Solana uses Ed25519 natively). `Keypair.fromSeed(identitySeed)` derives the wallet from the existing 32-byte identity seed. No second key, no custodial provider, no vendor approval.
2. **Compile-time rejection of relay registration.** `SettlementRailRegistry.register()` in `services/relay` accepts only `GuestRail`. Registering a `SovereignRail` is a `tsc` error. The negative proof lives in `services/relay/src/__tests__/custody-boundary.test.ts`. Do not widen.
3. **RPC is a swappable adapter.** `SolanaRpcAdapter` is the boundary. Default `Web3JsRpcAdapter` wraps `@solana/web3.js` + `@solana/spl-token`. Tests run against the adapter interface with no network. Do not import `@solana/web3.js` outside the adapter.
4. **The agent pays its own SOL fees.** Sovereign means you pay your own gas. Do not add a relay-subsidy path.
5. **`SolanaMemoSubmitter` is the reference `ChainAnchorSubmitter`.** Credential Merkle-batch anchoring and individual revocation events use it. Fire-and-forget — chain submission failure never blocks the artifact it anchors.
6. **Curve coupling is convention, not protocol law.** Future Ed25519-native chains (Aptos, Sui) satisfy the same `SovereignRail` interface. Non-Ed25519 chains would require a separate adapter under the same interface — identity and wallet stay architecturally decoupled in `spec/settlement-v1.md §3.3`.

The previous custodial rail (`DirectAssetRail` + `PrivyWalletProvider`) was deleted 2026-04-08. The relay does not sign agent transfers.
