---
"motebit": minor
---

`motebit smoke x402 [--mainnet]` — paid-flow end-to-end probe. Sibling of `motebit smoke reconciliation`: where reconciliation validates the read side (loop is observing correctly), this validates the write side (a real settlement actually flows through every layer).

In-process: bootstraps two fresh motebit identities (buyer + worker) + two fresh EVM EOAs (`viem`'s `generatePrivateKey()`), persists the EOAs to `~/.motebit/smoke-x402-{buyer,worker}-eoa.txt` (mode 0600), posts a paid listing with the worker's pay-to address, drives the buyer's task POST through `@x402/fetch` (the 402 → sign → resubmit dance handled by Coinbase's official x402 client), constructs a signed Ed25519 ExecutionReceipt via `signExecutionReceipt`, posts it to `/agent/:workerId/task/:taskId/result`, and polls the task surface until `status=completed` confirms the relay wrote a `relay_settlements` row.

Defaults to Base Sepolia (testnet, free, faucet-funded). `--mainnet` switches to Base mainnet via the relay's CDP facilitator and costs ~$0.0105 USDC per run; first-run mainnet exits cleanly with funding instructions for the auto-generated buyer EOA so operators don't half-spend against an unfunded address.

Adds `@x402/fetch` + `viem` direct deps; bumps `@x402/core`/`@x402/evm`/`@x402/hono` to ^2.11.0 to keep the version family aligned (prevents private-property-incompatibility errors between hoisted x402-core copies).

Pairs with `motebit smoke reconciliation` for full-loop validation: run x402 to drive a settlement, wait one reconciliation interval, run reconciliation to verify the cycle observed the new fee. The two together exercise the entire economic loop end-to-end on a live relay.
