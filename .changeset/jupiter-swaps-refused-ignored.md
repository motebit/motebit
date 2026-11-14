---
"@motebit/wallet-solana": patch
"@motebit/molecule-runner": patch
---

Jupiter-built transactions are refused until intent-bound transaction validation exists.

- `swapUsdcToSol` and `swapSolToUsdc` reject with `JupiterSwapDisabledError` (`code: "jupiter_swap_disabled"`) through one choke point, `refuseJupiterSwap`, before any network call and without touching the keypair. The fetch, deserialize, sign and broadcast code is deleted. The rail's legacy `autoGas: true` path and `rail.swapSolToUsdc` call the choke point before reading the keypair.
- `createSolanaWalletRail` always builds the rail with automatic gas off; `disableAutoGas` is deprecated and has no effect. A rail constructed directly with `autoGas: true` reaches only the refusal.
- `send`, `sendBatch` and `buildP2pPayment` check the gas floor (`GAS_FLOOR_LAMPORTS`, 0.005 SOL; 0.01 recommended) and throw `InsufficientSolForGasError` (`code: "insufficient_sol_for_gas"`) before signing when SOL is below it. `confirmSend` reads that error as `absent` (nothing was sent). With enough SOL the three behave as before.
- New gate `check-third-party-tx-signing` fails on a transaction decoded from external bytes, or raw bytes decoded from a network value, reaching a signer (or a raw broadcast) outside a registered validator module (the registry is empty). It does not see a transaction built locally from third-party-supplied instructions; its printed blind spots say so.
- `@motebit/molecule-runner`: the sweep comment names the floor (comment only).

Deployment: after redeploy, every molecule service built on `@motebit/molecule-runner` — auditor, clerk, code-review, read-url, research, summarize, web-search — needs at least 0.005 SOL (0.01 recommended) at its identity address. Below it, its wallet sweep and any paid sub-delegation are refused before signing; nothing tops SOL up.

The CLI side is in `jupiter-swaps-refused.md`.
