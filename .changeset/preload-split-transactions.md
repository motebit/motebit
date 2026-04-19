---
"@motebit/browser-persistence": patch
---

`IdbConversationStore.preload()` no longer holds a single multi-store IndexedDB transaction across two awaits — splits the conversation read and the active-conversation message read into two separate readonly transactions.

The original implementation opened one transaction over both `conversations` and `conversation_messages`, awaited `idbRequest()` to load conversations, then issued a second `getAll` against the messages store inside the same transaction. IDB auto-commits a transaction when the current task has no pending requests, and `await` yields control to the microtask queue. Modern browsers preserve the transaction across that boundary in practice, but the spec doesn't guarantee it under stress (slow CPU, GC pause, very large query) and the failure mode is a hard `TransactionInactiveError` on the second op.

Two cheap readonly transactions are deterministic across browsers and load conditions. Same observable behavior — both existing preload tests pass unchanged.

Caught during a principal-engineer audit on 2026-04-18 prompted by an outside review that flagged the broader IDB layer. The "creature in a coma" framing of that review didn't hold — no active hangs in commits, tests, or user-visible bug reports — but `preload()` was the one genuinely brittle pattern in `packages/browser-persistence/src/`. The other 64 transaction call sites use the standard "fire-and-forget readwrite" IDB pattern, which auto-commits correctly and is not affected.
