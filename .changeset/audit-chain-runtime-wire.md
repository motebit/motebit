---
"@motebit/protocol": minor
"@motebit/sdk": minor
---

audit-chain-runtime-wire — `ChainedAuditSink` is now a composable
wrapper that auto-wires when surfaces supply both a `toolAuditSink`
and an `auditChainStore` adapter. Closes the gap from audit-chain-1

- audit-chain-2 where the primitives existed but had zero consumers
  in production.

**`@motebit/protocol` (minor):** new `AuditChainEntry` and
`AuditChainStoreAdapter` interfaces. Wire-format permissive-floor
types so `StorageAdapters.auditChainStore` can reference them
without sdk crossing into BSL `@motebit/policy`. Concrete primitives
(`appendAuditEntry`, `verifyAuditChain`, the `crypto.subtle`
hashing) stay in `@motebit/policy/audit-chain.ts` — only the type
moves; same algorithm. `@motebit/policy` re-exports
`AuditEntry` / `AuditChainStore` as type aliases for backward
compatibility with existing in-package callers.

**`@motebit/sdk` (minor):** `StorageAdapters.auditChainStore?:
AuditChainStoreAdapter` — surfaces opt in by passing
`new SqliteAuditChainStore(driver)` (cli, web, future surfaces with
SQLite) or omitting (in-tree tests, minimal sandboxes).

**Runtime auto-wire:** when both `toolAuditSink` and
`auditChainStore` are present, the runtime constructs
`new ChainedAuditSink({ inner: toolAuditSink, chainStore, motebitId })`
and passes the wrap to `PolicyGate`. Inner sink keeps doing what it
does (persistence, sync queries); chain layer runs in parallel for
tamper-evidence.

**ChainedAuditSink refactor — composable wrapper, not extends-
in-memory:** the prior shape extended `InMemoryAuditSink`,
duplicating the persistence layer. New shape implements
`AuditLogSink` directly and delegates `append` / `query` /
`getAll` / `queryStatsSince` / `queryByRunId` / `enumerateForFlush`
to the supplied `inner` sink. Cleaner architecturally, surface-
agnostic — the same primitive composes over `SqliteToolAuditSink`,
`TauriToolAuditSink`, `ExpoToolAuditSink`, or any future
implementation.

**MotebitDatabase exposes `auditChainStore: SqliteAuditChainStore`**
alongside the existing `toolAuditSink`. CLI threads both into its
`StorageAdapters`; the runtime auto-wraps. Web + mobile surfaces
follow the same pattern when they migrate.
