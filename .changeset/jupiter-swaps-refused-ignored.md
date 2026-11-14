---
"@motebit/wallet-solana": patch
---

Jupiter-built transactions are refused until intent-bound transaction validation exists.

- `swapUsdcToSol` and `swapSolToUsdc` reject with `JupiterSwapDisabledError` (`code: "jupiter_swap_disabled"`) through one choke point, `refuseJupiterSwap`, before any network call and without touching the keypair. The fetch, deserialize, sign and broadcast code is deleted.
- `createSolanaWalletRail` always builds the rail with automatic gas off; `disableAutoGas` is deprecated and has no effect. A rail constructed directly with `autoGas: true` reaches only the refusal.
- `send`, `sendBatch` and `buildP2pPayment` check the gas floor (`GAS_FLOOR_LAMPORTS`, 0.005 SOL) and throw `InsufficientSolForGasError` (`code: "insufficient_sol_for_gas"`) before signing when SOL is below it. `confirmSend` reads that error as `absent` (nothing was sent). With enough SOL the three behave as before.
- New gate `check-third-party-tx-signing` fails on any code that signs a transaction decoded from external bytes outside a registered validator module (the registry is empty).

The CLI side is in `jupiter-swaps-refused.md`.
