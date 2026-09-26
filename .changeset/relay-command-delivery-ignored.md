---
"@motebit/relay": patch
---

**Remote commands reach the live daemon socket, keep their relay's deadline, and are answered only from the identity they were delivered to** (#691 items 1, 2, 4, 5, 6, and the compatible half of 7).

- **One delivery rule, `sendToOne`, in two tiers.** The delivered peer is recorded before the frame is sent. There is no fall-through to a second socket on silence, because a machine's replay guard would answer a second delivery "rejected: replay", or a second executor would run it.
  - **Verified sockets first, newest first.** A verified socket is one whose declared device id equals its signed token's `did`. Daemons declare and verify, and for them the newest socket is the live one: a half-open socket left after a sleep or network flap no longer takes the single-use frame from the reconnect beside it. A verified socket also outranks every declared-only one.
  - **Every other socket keeps main's order, oldest first.** For undeclared clients the newest socket is not the live one: web and desktop attach their command handler only to their first adapter, and a token refresh leaves the earlier socket open, so newer sockets are deaf. With no verified peer (device auth off, master-token runtimes, undeclared clients) the choice is exactly main's. #810 tracks that tier's declared-only impostor exposure and the rest of item 7.
  - **Verbs outside the unattended set use the same order.** A `state` read may reach a verified daemon rather than an older undeclared surface.
- **Who may answer.** An answer is accepted only from the delivered peer's stable identity, checked in this order:
  1. its declared device id — from a socket declaring the same id, or one declaring none whose token `did` is that id;
  2. else its signed token's `did`;
  3. else any socket of the motebit it was sent to. Main matched on the command id alone, across motebits.

  `handleCommandResponse` now requires the answering socket's origin (motebit, declared device id, token `did`). An answer from another motebit is always refused. An answer from another device of the same motebit is refused when the delivered peer has a declared device id or a token `did`. With a motebit-only key (master token, device auth off), any socket of the motebit may answer, as on main.

- **Nothing settles early.** The request waits until its deadline whatever happens to the socket, so a runtime's answer on its reconnect still lands. If the delivered socket closed or was retired and no answer came, the deadline's 504 now carries `outcome: "closed_after_delivery"`; otherwise it carries `outcome: "silent"`. The `outcome` field is additive, and both stay 504, which every client already reads as "delivered, no answer". `relay.close()` settles everything it still holds at once, as `closed_after_delivery`.
- **Per-relay deadline.** The deadline is `SyncRelayConfig.commandTimeoutMs` (default 30 s), held per relay.
