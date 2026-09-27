---
"@motebit/sync-engine": patch
"@motebit/web": patch
"@motebit/desktop": patch
"@motebit/mobile": patch
---

Sync socket token refresh no longer leaks deaf sockets (#816).

Web and desktop built a new `WebSocketEventStoreAdapter` on every
4.5-minute token refresh, left the `command_request` / `task_request`
handler on the first adapter, and closed the first adapter every time.
After one refresh the surface answered no command, and every refreshed
socket stayed open at the relay, inflating `sockets_open`.

`WebSocketEventStoreAdapter.refreshConnection()` now swaps the socket
inside the same adapter and re-resolves the credential, so every handler,
pending event and `onCatchUp` carries over and the replaced socket is the
one that closes. Web and desktop call it from the refresh timer; desktop
now resolves its socket credential per connect (the caller's token for
the first connect, a freshly minted one after), so a drop-and-reconnect
no longer presents an expired token either. The adapter also no longer
opens a socket when `disconnect()` lands while a credential is still
resolving, and it retries when the credential source rejects.

Siblings closed in the same pass: a re-entered `startSync` on web and
desktop now closes the running socket and refresh timer before building
a new one, and a `startSync` superseded across an await (by `stopSync`
or a newer `startSync`) no longer connects its socket. Mobile, which
rebuilds its socket each 30-second cycle, no longer connects the socket
of a cycle that a later cycle superseded while it awaited the relay key.
