---
"@motebit/relay": minor
---

A harness that stands two real runtimes against one relay — the prerequisite the return view's review rounds kept asking for.

Every relay test until now used a peer whose `send` recorded a payload. That proves the relay chose a peer; it proves nothing about what the peer DOES with the frame, and that is where this arc's defects have lived. A halt rejected as a replay by a machine's second process, a resume answered by the machine with nothing to do, a report naming the wrong machine — none of them can be expressed as an assertion about a recorded payload. So all of them were found by a person reading, and every fix was written blind. Thirteen review rounds, most of them correcting the round before.

**The fake socket is a wire, not a stub.** One end is the relay's real routing; the other is the real frame handler, on a real runtime, with real envelope verification, a real replay guard per machine, and a halt store per process. What it deliberately skips is the socket upgrade — the relay's own tests already cover that its WebSocket handler forwards to `handleCommandResponse`, and re-proving it would only make the harness slow enough that nobody runs it.

**One handler, not two.** `motebit run` and `motebit serve` each carried a copy of the sequence — verify the envelope, check the replay guard, execute, reply. Two copies of a security sequence is two places to get it wrong, and it showed: serve's copy refused when there was no registered identity key to verify against, and the daemon's did not. That guard is now structural in the shared handler, so a third caller cannot forget what the second one remembered. `handleCommandResponse` is exported from the relay for harnesses to close the loop with.

Seven sentences the repo could not previously assert, each one a defect a review round found by reading:

- a halt from the phone reaches the daemon and **stops it** — asserted against the runtime's own halt store, not the relay's word. The arc's central sentence, never tested end to end until now.
- the same envelope replayed is refused **by the runtime**, not by the transport.
- two processes on one machine share a replay guard, so one frame arrives and only the process that received it holds the halt — the whole of the multi-machine problem in one assertion.
- a dead socket beside a live one on the same machine does not lose the halt.
- `runs` goes to the ledger-holder and never to a task worker that can be stopped but keeps no run rows.
- an envelope signed by another key changes nothing, asserted from the runtime's side.
- a runtime with no identity key refuses rather than trusting the relay's forwarding.

Both halves were tamper-proven: routing `runs` by the wrong capability, and dropping the identity-key guard, each turn exactly one test red.

Next on this harness: issue #681, the multi-machine halt broadcast, which is blocked on it.
