---
"@motebit/sync-engine": patch
"@motebit/web": patch
"@motebit/desktop": patch
"@motebit/mobile": patch
"@motebit/spatial": patch
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
a new one. A start claims the socket only once it has passed its early
checks, so a newer start that bails (no runtime, no keypair, a failed
token) never orphans a running one. A start superseded before it reaches
that point builds nothing. One superseded across the relay-key await
(by `stopSync` or a newer start that claimed) has already built its
adapter — and on desktop connected it, since desktop connects before
that await — so it is torn down after the await instead: it wires no
handler, sets no refresh timer, and nothing stays open.

Mobile keeps main's cadence — every 30-second tick starts a cycle and
every cycle runs its HTTP sync, however slow the previous one is — and
owns only the socket: a cycle may connect its socket only if no newer
cycle has connected one, connecting closes the socket it replaces, and
an overtaken cycle releases its unconnected socket and still syncs over
HTTP. A cycle of a stopped or restarted run does nothing further, so a
stop and restart to another relay no longer lets the old cycle drive the
new run's engines at the old relay.

The socket's catch-up pull now authenticates: desktop and spatial give
the HTTP fallback a per-request credential (web already did), so events
published in a refresh gap are pulled after the first token expires. A
late auth timeout or `auth_result` from a replaced socket no longer acts
on the adapter: stopping mid-handshake no longer reopens a socket 5 s
later, and a refresh mid-handshake no longer kills the new socket.

Spatial had the same deaf-handler shape: its refresh closed the current
socket but built a new adapter without the `command_request` handler, so
after one refresh spatial answered no command. It now calls
`refreshConnection()` on its one adapter with a per-connect credential,
tears down a running socket on a re-entered `connectRelay`, and builds no
socket for a `connectRelay` superseded by `disconnectRelay`.
