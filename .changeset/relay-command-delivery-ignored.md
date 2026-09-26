---
"@motebit/relay": patch
---

**Remote commands reach the live socket, survive a reconnect, settle when their socket is gone, keep their relay's deadline, and are answered only by the device they were sent to** (#691 items 1, 2, 4, 5, 6, and the compatible half of 7).

- **One delivery rule, `sendToOne`.** Verified sockets (declared device id === the signed token's `did`) go before declared-only ones, and within each tier the NEWEST open socket goes first. It never falls through to a second socket on silence, because a machine's replay guard would answer a second delivery "rejected: replay", or a second executor would run it.
  - **The order changed for relays with no verified peer.** Before this change delivery went to the OLDEST open socket, so a half-open socket left after a sleep took the single-use frame from the live reconnect beside it. With no verified peer (device auth off, master-token runtimes, older clients) the order is now plain newest-first. That makes "connect last" the way a declared-only socket wins there. The exposure is tracked in #810.
  - **Verbs outside the unattended set follow the same order.** A `state` read, for example, may now reach a newer verified phone rather than the older daemon. The phone's remote verbs are all in the unattended set, so they are routed by capability first.
- **Settling when the delivered socket goes.** When the socket a command was delivered to closes or is retired, the request waits a short close grace (`SyncRelayConfig.commandCloseGraceMs`, default 5 s, never past the deadline). The daemon replies on whatever socket is current, so its answer on the reconnect still lands. With no answer in the grace, the request settles as a 504 with `outcome: "closed_after_delivery"`. `relay.close()` settles everything it still has pending the same way, at once.
- **The deadline 504** now carries `outcome: "silent"`. Both `outcome` fields are additive and both stay 504, which every client already reads as "delivered, no answer".
- **Per-relay deadline.** The deadline is `SyncRelayConfig.commandTimeoutMs` (default 30 s), held per relay.
- **Who may answer.** `handleCommandResponse` now takes the motebit AND device id of the socket an answer arrived on, both required. It settles only a request sent to that motebit and delivered to that device.
