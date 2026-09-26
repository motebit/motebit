---
"@motebit/relay": patch
---

**Remote commands reach the live socket, keep their relay's deadline, and are answered only from the identity they were delivered to** (#691 items 1, 2, 4, 5, 6, and the compatible half of 7).

- **One delivery rule, `sendToOne`.** Verified sockets (declared device id === the signed token's `did`) go before declared-only ones, and within each tier the NEWEST open socket goes first. The delivered peer is recorded before the frame is sent. There is no fall-through to a second socket on silence, because a machine's replay guard would answer a second delivery "rejected: replay", or a second executor would run it.
  - **The order changed for relays with no verified peer.** Before this change delivery went to the OLDEST open socket, so a half-open socket left after a sleep or network flap took the single-use frame from the live reconnect beside it. With no verified peer (device auth off, master-token runtimes, older clients) the order is now plain newest-first. That makes "connect last" the way a declared-only socket wins there; #810 tracks that exposure and the rest of item 7.
  - **Verbs outside the unattended set follow the same order.** A `state` read, for example, may now reach a newer verified phone rather than the older daemon. The phone's remote verbs are all in the unattended set, so they are routed by capability first.
- **Who may answer.** An answer is accepted only from the delivered peer's stable identity, checked in this order:
  1. its declared device id;
  2. else its signed token's `did`;
  3. else any socket of the motebit it was sent to (main matched on the command id alone, across motebits).
     `handleCommandResponse` now requires the answering socket's origin (motebit, declared device id, token `did`). An answer from another motebit, or from another device of the same motebit, is refused and logged.
- **Nothing settles early.** The request waits until its deadline whatever happens to the socket, so a runtime's answer on its reconnect still lands. If the delivered socket closed or was retired and no answer came, the deadline's 504 now carries `outcome: "closed_after_delivery"`; otherwise it carries `outcome: "silent"`. The `outcome` field is additive, and both stay 504, which every client already reads as "delivered, no answer". `relay.close()` settles everything it still holds at once, as `closed_after_delivery`.
- **Per-relay deadline.** The deadline is `SyncRelayConfig.commandTimeoutMs` (default 30 s), held per relay.
