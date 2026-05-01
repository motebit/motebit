---
"@motebit/sdk": minor
"@motebit/crypto": patch
---

Retention policy phase 3 — memory registers under `mutable_pruning`, tombstone→erase, signed deletion certs at the call site.

`@motebit/sdk`: `MemoryStorageAdapter` gains a required `eraseNode(nodeId)` method. Implementations physically remove the node row and every edge that references it; after `eraseNode(id)` resolves, `getNode(id)` returns `null` and `getEdges(id)` returns `[]`. The existing `tombstoneNode` method stays for soft-delete lifecycle paths (decay-pass / notability-pass) that intentionally do not issue a deletion cert. Required-not-optional addition because phase 3 ties the cert format's "bytes are unrecoverable" claim (decision 7) to the storage operation; admitting an adapter without `eraseNode` would silently weaken every cert it produces.

`@motebit/crypto`: the `self_enforcement` reason in `verifyDeletionCertificate`'s reason × signer × mode table is admitted in every deployment mode (sovereign / mediated / enterprise). The earlier sovereign-only restriction was over-tight — the subject's own runtime drives policy whether an operator exists or not, and only operator-driven enforcement is `retention_enforcement`. The doctrine table at `docs/doctrine/retention-policy.md` §"Decision 5" matches.

Both changes are caught by typecheck; downstream package implementations of `MemoryStorageAdapter` (browser-persistence, persistence/SQLite, desktop's tauri-storage, mobile's expo-sqlite, runtime's InMemoryMemoryStorage) all carry the new method.
