# @motebit/deposit-detector

EVM `Transfer` event scanner → onDeposit callback. Polls a chain's log stream, filters for transfers to known wallets, dedups by `(txHash, logIndex)`, and invokes a consumer callback for each newly-detected deposit. The callback is responsible for the cross-table atomic write (credit virtual account + record dedup entry) — the package owns the scanning, filtering, and cursor logic; it never touches a DB.

Layer 1. BSL-1.1. Takes an injected `EvmRpcAdapter` (type-only dep on `@motebit/evm-rpc`), a `DepositDetectorStore` (DB inversion — cursor, wallets, dedup check), and an `onDeposit` callback. Demonstrates Layer-1 composition: the consumer wires the store to SQLite, the adapter to `HttpJsonRpcEvmAdapter`, and the callback to `@motebit/virtual-accounts`'s `AccountStore.credit`.

## Rules

1. **One RPC call per cycle, regardless of wallet count.** The scanner fetches ALL `Transfer` logs in the block range with a single `eth_getLogs` call and filters in-memory against the known-wallets map. O(1) RPC calls whether one wallet or one million. Do not add a per-wallet RPC call.
2. **Dedup is the consumer's transactional responsibility.** The package calls `store.hasProcessedLog(txHash, logIndex)` before invoking `onDeposit`. The consumer's `onDeposit` handler must atomically (a) record the dedup entry and (b) credit the account, so a concurrent cycle cannot re-credit the same log. The package's happy path assumes the consumer did this correctly; retries on transient errors remain safe by virtue of the dedup check.
3. **RPC failures collapse to zero credits.** Network error, non-2xx, malformed response — all produce the same shape: `detectDeposits` returns 0, no cursor advance. Same contract as the pre-extraction loop.
4. **Cursor advance is unconditional once the scan succeeds.** When `onDeposit` throws for an individual log, the package logs and continues; the cursor still advances to `toBlock` so the failed log isn't re-scanned forever. The dedup table is the safety net, not the cursor.
5. **Token decoding is not our problem.** The `Transfer` event's `value` is whatever width the ERC-20 uses. For USDC (6 decimals == USDC on-chain == motebit micro-units), the 1:1 mapping is done at the caller. The package passes `amountOnchain: bigint` to `onDeposit` — the consumer multiplies by whatever factor applies.

## What NOT to add

- Non-EVM chains. The scanner is specific to the `Transfer(address,address,uint256)` event shape. Solana deposits use a different detection path (SolanaRpcAdapter + confirmed-signature polling) in `@motebit/wallet-solana`.
- Token decoding. Adding a `decimals` config parameter binds the package to a specific asset list and creates drift; the caller owns the micro-unit conversion.
- Multiple chains per instance. One `DepositDetector` instance tracks exactly one `(chain, contract)` pair. Multiple chains mean multiple instances.
- Provider-specific quirks (Alchemy logs-API pagination, Infura rate-limit headers). Those belong in the `EvmRpcAdapter` implementation, not here.

## Consumers

- `services/api` — the relay. Provides `SqliteDepositDetectorStore`, wires the `onDeposit` callback to `sqliteAccountStoreFor(db).credit`, runs one instance per supported chain.
