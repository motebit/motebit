---
"@motebit/relay": patch
---

A halt reaches every machine, not the first that answers — issue #681, rebuilt test-first.

The halt store is local and nothing replicates it, and the relay delivered first-wins. So a sovereign with a daemon on a laptop and a worker on a VPS had one machine stopped and one still working, under the stopped one's acknowledgement — which reads as "stopped" for a motebit that is still running. The act is idempotent and machine-local, so the delivery that matches what the person asked for is to all of them.

**Per machine, not per connection.** `motebit run` and `motebit serve` on one host are two peers sharing a device id, a database and one replay guard, and the envelope carries a single signature — so a second frame to the same host is rejected as a replay by its own motebit. Within a machine, every connection is a candidate for that machine's one delivery: which of its sockets is alive is a different question from how many deliveries it should get.

**A broadcast is not a race.** `cmdResume` answers "Nothing is halted." synchronously when nothing is active, while the machine that actually holds the halt awaits its store — so the machine with the least to do reliably won. Resolving on the first reply also returns before the other machines have acted at all, which is how the harness found it: `await` on the request came back and the second machine had not halted yet. Every answer is gathered now, bounded by a short grace after the first, and a machine that does not answer is named as silent — _silence is not a stop_.

`acknowledged` survives composition and gets stricter: true only when every machine aimed at came back saying so. One machine's acknowledgement is not the motebit's, which is the sentence `cmdHalt` is built around.

**Written against the multi-runtime harness rather than by reading.** The same change was attempted inside the return-view PR and withdrawn after ten review rounds that never converged, because nothing in the repo could express what a runtime does with a forwarded frame. Every claim above is now a test that fails when the behaviour regresses.

Found on the way, and fixed in the harness itself: it had been running against a stale build in which `handleCommandResponse` was not exported, so every reply threw on its way back and the loop never closed — and nine tests passed anyway, because most assert on runtime-side state. The wire now reports its own faults and the suite asserts there were none, so a harness silently disconnected from its subject is a red test rather than a quietly weaker one.
