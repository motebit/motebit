# @motebit/evm-rpc

EVM JSON-RPC boundary behind a motebit-shaped interface. The `EvmRpcAdapter` surface is narrow (`getBlockNumber` + `getTransferLogs`); the `HttpJsonRpcEvmAdapter` concrete impl owns envelope construction, `fetch`, hex parsing, and error translation.

Layer 1. BSL-1.1. Zero internal deps, zero I/O outside the injected `fetch`. Sibling of `@motebit/wallet-solana`'s `SolanaRpcAdapter` — each chain's RPC plumbing owns its own wire format behind a motebit-shaped contract.

## Rules

1. **One way in, one way out.** Every failure mode — network error, non-2xx HTTP, JSON-RPC `error` field, malformed body — bubbles as a single `Error`. Callers have one `try/catch` shape to handle. Don't leak `error.code` / `error.response` / AbortError — if a caller needs to distinguish, add a discriminator to the thrown message, never a new exception type.
2. **`fetch` is injected.** Default to `globalThis.fetch`, but accept any `typeof fetch`. Tests inject deterministic mocks; edge environments inject their native fetch. Never reach for `node-fetch` or `undici` directly.
3. **Interface first, implementation second.** Adding RPC methods means widening `EvmRpcAdapter` before writing the `HttpJsonRpcEvmAdapter` arm. If a method doesn't make sense on a non-HTTP implementation (e.g. WebSocket subscriptions), it doesn't belong on the interface either.
4. **Motebit-shaped returns only.** `EvmTransferLog` fields are named for what they mean (`txHash`, `blockNumber`, `fromTopic`), never for what the wire called them (`transactionHash`, `blockNumber` as hex string, `topics[1]`). Hex decoding is this package's job.
5. **Token decoding is the caller's job.** `EvmTransferLog.amountHex` stays as raw 0x-hex; only the caller knows the token's decimals. Baking USDC/USDT decimals into the adapter would couple the package to a specific asset list.

## What NOT to add

- A state machine. Polling, cursor tracking, dedup — that's the consumer's concern.
- Token decoding. Micro-unit conversion belongs in the caller.
- Non-EVM chains. A new chain = a new package (the `SolanaRpcAdapter` precedent).
- A WebSocket client. Subscriptions are a different lifecycle; they want a different interface.
- Provider-specific quirks (Alchemy retry headers, Infura rate-limit parsing). Those belong in a consumer-side wrapper.

## Consumers

- `services/relay` — the deposit detector. `HttpJsonRpcEvmAdapter` polls USDC Transfer logs per supported CAIP-2 chain.
