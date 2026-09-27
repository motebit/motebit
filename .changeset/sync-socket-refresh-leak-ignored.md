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

Siblings closed in the same pass: a re-entered `startSync` (web, desktop)
or `connectRelay` (spatial) replaces the running socket MAKE-BEFORE-BREAK.
The new socket is built, its command/event handlers attached, the
runtime's sync remote pointed at it, its refresh timer set and the socket
connected in one synchronous step; only then is the old one retired, with
`WebSocketEventStoreAdapter.handOffTo(next)`, which moves the old adapter's
queued events to the new one and forwards anything still holding the old
adapter (a sync push in flight, a command reply being produced) instead of
writing into a closed socket. Before, the old socket was closed at the
claim while the runtime still pushed to it and before the new one had a
command handler, so events and commands in that window were lost. A start
claims the socket only once it has passed its early checks, so a newer
start that bails never displaces a running one. A start a stop overtakes
does nothing further unless the app has since been restarted against the
SAME relay, in which case its HTTP-side work (sync engines, delegation
config) still runs (web), or it may still build the socket for that run
(spatial) until the newer start replaces it. A re-entered start replaces
web's and spatial's plan/conversation pollers instead of adding a second.

Mobile keeps main's cadence — every 30-second tick starts a cycle and
every cycle runs its HTTP sync, however slow the previous one is — and
owns only the socket: a cycle may connect its socket only if no newer
cycle has connected one and its own run is still current, connecting
retires the socket it replaces into the new one (`handOffTo`), and an
overtaken cycle releases its
unconnected socket and still syncs over HTTP. A cycle whose run was
replaced by a stop and restart (or a re-entered `startSync`) to the SAME
relay finishes its HTTP sync on the current run's engines, as main does;
one whose controller is stopped, or whose run now targets ANOTHER relay,
does nothing further, so the old cycle never syncs the new run at the
old relay.

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

Spatial's plan-step delegation now presents a fresh token of the audience
the relay requires (`task:submit` / `task:query`), minted per call. It
had been handed the connect-time sync-audience token — 600 s old by the
second refresh, and the wrong audience from the first call.

The acceptance test for all of the above is a differential interleaving
matrix per surface (`src/__tests__/sync-interleavings.test.ts`): every
sequence of up to three lifecycle operations after a start, crossed with
five relay-key latencies, run against the real controller over a fake
relay and fake clock and compared cell by cell with origin/main's
controller (baselines committed beside the test).
