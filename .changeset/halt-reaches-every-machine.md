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

Review round, and the sharpest finding was the grace window itself. `cmdHalt` awaits every registered stopper under a ten-second ceiling, while a machine with nothing to stop returns immediately — so the first answer is systematically from the machine with the least to do, and a three-second grace armed on it and then reported the machine that was _actually aborting work_ as "did not answer — silence is not a stop", with `acknowledged: false`, while it was still stopping. That is the fast-answerer bias this change exists to remove, inverted into a false negative on the one verb where a false negative costs most. The grace now outlasts the runtime's own ceiling, and a test with a six-second stopper holds it there.

Also from that round:

- **An unreachable machine is reported rather than vanishing.** Counting only successful sends dropped it from the target list, so the composed path was skipped and the caller got the live machine's raw `acknowledged: true` with no sign a second machine existed — one machine's acknowledgement standing in for the motebit's, returning through the accounting.
- **A folded undeclared bucket makes `acknowledged` unprovable, and says so.** Two connections that declared no device id collapse into one delivery, which is the right default for grouping; but they might be two hosts, so the composed report is forced even at one target and the claim is withheld.
- **Every machine is named.** Answers carry the device that sent them, so silence reads as "dev-2: no answer in time" rather than "1 runtime(s) did not answer" — the difference between a report and an actionable one.
- **Halt ids are machine-local, and the detail now says it.** Each machine writes its own halt row, so `resume <id>` reaches only the machine that wrote it; `resume all` is what lifts a broadcast halt everywhere.
- The target list is assigned before the first send rather than derived after it, so the ordering is an invariant rather than a property of today's transport; and the request timeout clears an armed grace timer instead of orphaning it.

Found while fixing those: the harness could not sequence two deliveries, so the test asserting "the second process refuses as a replay" raced envelope verification and passed or failed on scheduling. `deliver()` is awaitable now, and the suite is stable across repeated runs.
