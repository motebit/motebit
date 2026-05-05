---
"motebit": minor
---

Sovereign deletion now exits through the privacy-layer choke point on every surface. Pre-fix only desktop's UI memory-delete actually called `runtime.privacy.deleteMemory(..., "user_request")` — every other path (`/forget` slash command, web + mobile + spatial UI memory-delete, and user-driven conversation deletion across all surfaces) bypassed via `runtime.memory.deleteMemory(...)` or the storage adapter's `deleteConversation(...)`, producing silent erasures with no signed `mutable_pruning` cert, no `consolidation_flush` cert per message, no `delete_*` audit row, and no `DeleteRequested` event.

This change ties the user-driven axis of `docs/doctrine/retention-policy.md` together: `runtime.privacy.deleteConversation(id, "user_request")` lands as a sibling to `runtime.privacy.deleteMemory`, both emit `DeleteRequested` (intent) before signing (completion receipt) and erasing (decision 7 — physical erase, not tombstone). The runtime's `deleteConversation` wrapper became `async` and routes through the same choke; CLI's `/forget` and the `runtime.commands.cmdForget` slash-tool both signed-deletes now. Desktop's legacy fallback to `runtime.memory.deleteMemory` on privacy-layer failure was removed — privacy failure now surfaces as "delete failed, retry" rather than producing an unsigned, unaudited erase.

Drift gate `check-deletion-routes-through-privacy` (invariant #75) locks the contract: `<receiver>.memory.deleteMemory(` and `<receiver>.eraseMessage(` are forbidden outside the privacy layer, consolidation cycle, and storage-adapter implementation sites. Future surfaces cannot drift back into bypass.

```ts
// before — silent on web / mobile / spatial / cli
await runtime.memory.deleteMemory(nodeId);

// after — signed, audited, event-logged on every surface
await runtime.privacy.deleteMemory(nodeId, "user_request");

// new — conversations get the same contract
await runtime.deleteConversation(conversationId);
// → DeleteRequested event, one consolidation_flush cert per message,
//   per-row erase, conversation row drop, delete_conversation audit
```
