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
socket stayed open at the relay, inflating `sockets_open`. Spatial had the
same shape: its refresh built a new adapter without the command handler.

`WebSocketEventStoreAdapter.refreshConnection()` now swaps the socket
inside the same adapter and re-resolves the credential, so every handler,
pending event and `onCatchUp` carries over and the replaced socket is the
one that closes. Web, desktop and spatial call it from the refresh timer.
The swap is make-before-break: the authenticated socket keeps serving
(relay frames in, pushes and replies out) while the new one handshakes,
and closes the moment the new one authenticates (at most 10 s later), so a
command the relay routes to it during the handshake is still answered.
The adapter also no longer opens a socket when `disconnect()` lands while
a credential is still resolving, retries when the credential source
rejects, ignores a late auth timeout or `auth_result` from a replaced
socket, and queues a `sendRaw` made while it is not authenticated (sent on
its next authentication, bounded) instead of dropping it. New:
`drain(ms)` serves out the current socket, never reconnects, and
disconnects after `ms`.

Every socket replacement is make-before-break. A re-entered `startSync`
(web, desktop), `connectRelay` (spatial) or a newer sync cycle (mobile)
builds the new socket with its handlers, points the runtime's sync remote
at it and connects it; the socket it replaces keeps serving — its command
handler, its queued events — until the new one AUTHENTICATES, and is then
retired into it with `WebSocketEventStoreAdapter.handOffTo(next)`, which
forwards the old adapter's queued events and replies and anything still
holding it. `handOffTo` only forwards to the same identity on the same
relay: a successor for another motebit (a pairing adopted another id) or
another relay gets nothing of the old socket's. A socket for an identity
or relay the app has LEFT is never retired into the new one; it drains
(`drain`) — answers the commands it is executing, never reconnects — and
closes 15 s later, whether or not the new socket is up by then (counted
from the moment the app left it on spatial and mobile, whose new socket
can come long after; from the new start's claim on web and desktop, which
claim before their slow awaits). A start for an identity the app no
longer holds (desktop), or for a relay or identity it has since left
(spatial), builds no socket.

Command replies go out on the socket that is authenticated for that
identity and relay WHEN THE REPLY IS SENT — the current one, else one
still retiring or draining — as main answered through its current
adapter. The relay accepts an answer from the same runtime on any of its
sockets until the command's deadline, so a command in flight across a
Disconnect → Connect to the same relay is still answered.

A start claims the socket only once past its early checks, so a newer
start that bails never displaces a running one. A start a stop overtakes
does nothing further unless the app has since been restarted against the
SAME relay, in which case its HTTP-side work still runs (web; it reads
the app's current identity) or it may still build the socket for that
run (spatial, same identity only) until the newer start replaces it.
Mobile keeps main's 30-second cadence (every cycle runs its HTTP sync)
and owns only the socket; a cycle whose run was replaced finishes its HTTP
sync on the current run's engines only when the current run targets the
same relay, and never connects its socket.

Desktop resolves its socket credential per connect (the caller's token
first, a freshly minted one after), except that a configured relay master
token — which a device that never registered its key depends on — keeps
being presented on every connect and every catch-up pull, as on main. The
socket's catch-up pull authenticates per request on desktop and spatial,
so events published in a refresh gap are pulled after the first token
expires.

The acceptance test is a differential interleaving matrix per surface
(`src/__tests__/sync-interleavings.test.ts`): sequences of lifecycle
operations (stop, restart to the same or another relay, re-entered start,
identity switch, bail, refresh, drop, stall) after a start, crossed with
five relay-key latencies and four command execution times, run against
the real controller over a fake relay whose command rule matches the
relay's `command-route.ts`, and compared cell by cell with origin/main's
controller, raw and with its zombie sockets reaped (baselines committed
beside the test). The check that a cell where raw main does better holds
a zombie socket verifies the zombie's presence in that cell, not that it
caused the lead; the reaped comparison supplies the causation. By default
the test runs sequences of up to two operations (one on web);
`INTERLEAVING_MAX_OPS` widens it. On the full matrix (three operations,
two on web) this controller is not worse than reaped main in any of
22,220 cells on desktop; on web in 0 and 3 of 2,220 cells in two runs
(web cells vary run to run); and worse in 28 of 22,220 cells on spatial
and 104 of 22,220 on mobile, not all root-caused (see each test's header).
