---
"@motebit/wallet-solana": patch
"@motebit/runtime": patch
"@motebit/molecule-runner": patch
"@motebit/research": patch
---

First-party molecules can no longer sign a mainnet-USDC transfer under any environment or secret configuration. Their wallet rails sign only for the mints in one constant, and that constant is devnet USDC.

- `@motebit/wallet-solana`: `SolanaWalletRail` and `createSolanaWalletRail` accept an optional, construction-time `spendableMints` allowlist. With one, `send`, `sendBatch` and `buildP2pPayment` throw `RailSpendRefusedError` (`code: "rail_spend_refused"`) as their first statement, before the gas check, unless the adapter's parsed mint is listed; an adapter that reports no mint is refused. `Web3JsRpcAdapter` takes the same allowlist and repeats the check in `sendUsdc`, `sendUsdcBatch` and `sendUsdcDurable`. `SolanaRpcAdapter` gains an optional read-only `usdcMint` (the web3 adapter reports the mint it parsed). The rail exposes read-only `spendableMints`, `usdcMint` and `spendRefused`, and `confirmSend` reads the refusal as `absent`. Without an allowlist nothing changes.
- `@motebit/runtime`: `wrapP2pPaymentWithMeter` takes an optional reader of the rail's refusal and checks it before the meter, so a payment the rail is certain to refuse never charges the grant's ceiling. `executeGrantedDelegation` returns `{ ok: false, code: "rail_spend_refused" }` at the top of its live branch, before discovery, the meter and the paid-intent ledger; the dry run is unchanged. `resolveAndSubmitP2pDelegation` classes the refusal as thrown before signing: the result code is `rail_spend_refused` and nothing is written to the paid-intent ledger. `DelegationErrorCode` gains `rail_spend_refused`. The rail's `spendRefused` is read structurally (`railSpendRefusedOf`); the protocol's rail type is unchanged.
- `@motebit/molecule-runner`: `MOLECULE_SPENDABLE_MINTS` (`[USDC_MINT_DEVNET]`) is passed to the money-execution rail and the earnings-sweep rail, both built by `createMoleculeWalletRail`. The runner refuses to start unless every rail it holds, test overrides included, carries exactly that list (`assertMoleculeRailContained`). It logs each rail's posture and parsed mint at boot, and does not start the sweep when the sweep rail refuses to sign for its mint.
- `@motebit/research`: a paid sub-hop refused with `rail_spend_refused` tells the model not to call the tool again and to write from what it has. The priced work is not done on the free lane.
- New gate `check-molecule-spend-containment` pins the constant's value and its use at both rail constructions.

The code `rail_spend_refused` is lower-case to match the codes it travels with (`money_meter_denied`, `no_sovereign_rail`, `budget_exceeded`).

Deployment: staging Research must keep `MOTEBIT_SOLANA_USDC_MINT` set to the devnet USDC mint, or its paid hops are refused. Production Research and Clerk (mainnet mint) refuse every live spend and every sweep until the constant is changed in a reviewed commit. Earnings a production molecule receives stay on its wallet meanwhile.
