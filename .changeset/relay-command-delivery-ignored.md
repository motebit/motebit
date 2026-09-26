---
"@motebit/relay": patch
---

**Remote commands reach a machine's live reconnect, keep their relay's deadline, and are answered only from the identity they were delivered to** (#691 items 1, 2, 4, 5, 6).

- **Delivery picks what it picked before, with one exception.** `sendToOne` is now the one delivery rule. It takes the same pick as before: the first open candidate, in connection order, whose send does not throw.
  - **The exception:** when that pick is a verified socket (declared device id === its signed token's `did`), the frame goes to the newest open verified socket of the SAME device id instead. That is the same machine's reconnect. After a sleep or a network flap, a half-open old socket no longer takes the single-use frame from the live one beside it.
  - **Nothing else is reordered.** There is no swap across device ids, none for an unverified pick, and no ranking of verified over other peers. For undeclared web and desktop clients the oldest socket is the one listening, and a newer verified socket can be a half-open one while an older phone or daemon is live.
  - **Deferred to #810:** which of a verified and a declared-only peer should win. A declared-only socket that connected first still gets the frame, as before.
  - **No fall-through.** The delivered peer is recorded before the frame is sent. There is no fall-through to a second socket on silence, because a machine's replay guard would answer a second delivery "rejected: replay", or a second executor would run it.
- **Who may answer.** An answer is accepted only from the delivered peer's stable identity, checked in this order:
  1. its declared device id — from a socket declaring the same id, or one declaring none whose token `did` is that id;
  2. else its signed token's `did`;
  3. else any socket of the motebit it was sent to. Before this change the relay matched on the command id alone, across motebits.

  `handleCommandResponse` now requires the answering socket's origin (motebit, declared device id, token `did`). An answer from another motebit is always refused. An answer from another device of the same motebit is refused when the delivered peer has a declared device id or a token `did`. With a motebit-only key (master token, device auth off), any socket of the motebit may answer, as before. Two reconnect transitions are not covered, and each costs a 504 at the deadline, never a wrong answer: signed → master token, and declared → undeclared without a matching `did`.

- **Nothing settles early.** The request waits until its deadline whatever happens to the socket, so a runtime's answer on its reconnect still lands. If the delivered socket closed or was retired and no answer came, the deadline's 504 now carries `outcome: "closed_after_delivery"`; otherwise it carries `outcome: "silent"`. The `outcome` field is additive, and both stay 504, which every client already reads as "delivered, no answer". `relay.close()` settles everything it still holds at once, as `closed_after_delivery`.
- **Per-relay deadline.** The deadline is `SyncRelayConfig.commandTimeoutMs` (default 30 s), held per relay.
