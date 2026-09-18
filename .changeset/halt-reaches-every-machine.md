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
- **A folded undeclared bucket is reported.** Two connections that declared no device id collapse into one delivery, which is the right default for grouping; but they might be two hosts, so the composed report is forced even at one target and the claim is withheld.
- **Every machine is named.** Answers carry the device that sent them, so silence reads as "dev-2: no answer in time" rather than "1 runtime(s) did not answer" — the difference between a report and an actionable one.
- **Halt ids are machine-local, and the detail now says it.** Each machine writes its own halt row, so `resume <id>` reaches only the machine that wrote it; `resume all` is what lifts a broadcast halt everywhere.
- The target list is assigned before the first send rather than derived after it, so the ordering is an invariant rather than a property of today's transport; and the request timeout clears an armed grace timer instead of orphaning it.

Found while fixing those: the harness could not sequence two deliveries, so the test asserting "the second process refuses as a replay" raced envelope verification and passed or failed on scheduling. `deliver()` is awaitable now, and the suite is stable across repeated runs.

Second review round, and it found a category error at the centre of the first one.

**The relay was synthesizing a verdict about the interior.** The composed payload AND-ed `data.acknowledged` across machines and the previous round called that "stricter". It was not stricter, it was wrong, and two ordinary paths proved it: `cmdResume` never emits `acknowledged` at all — it reports `lifted` — so every _successful_ multi-machine resume published `acknowledged: false`; and a goal-scoped halt can only be honoured by the one machine that owns the goal, so the conjunction was false about a goal that had in fact been stopped.

The relay knows what it sent and what came back. It does not know what a goal is, which machine owns one, or what `resume` means — and it sells coordination precisely because it is not the authority on the interior. A composed reply now carries transport facts (`sent_to`, `reached`, `answered`, `unreached`) and each machine's own `data` verbatim beside the device that sent it. There is no `acknowledged` key: absent is the fail-closed reading, a single-machine motebit still returns the runtime's own reply untouched, and the question "did my motebit stop" is answered by the per-machine replies or by `halt-status`, which is the command whose job that is.

**And the grace window is gone.** It was wrong at three seconds and still wrong at twelve: `honorHalts()` awaits a nested loop over pending halts × registered stoppers, each under its own ten-second ceiling, so a machine returning from a restart with two un-acknowledged halts answers at about twenty. Nothing bound the relay's constant to the runtime's, so any change to either silently re-opened the gap. The lesson is not to measure it better — the relay cannot compute this bound, because it depends on interior work the relay has no view of by design. It waits for every machine it reached, and composes at the request's own deadline instead of rejecting. That also fixed a conflation one layer down: timing out with answers in hand let the CLI print "Delivered, no answer yet" about a machine the relay knew it never reached.

- **Quorum counts machines, not answers.** A runtime replying twice satisfied a quorum counted on the raw array and closed the request before a real target had been heard from; an answer from a machine the request never aimed at counted as evidence about it.
- **The summary counts machines reached.** "Sent to 2 runtimes" sat above a detail line reading "dev-1: not reached", and the CLI prints the summary first — a first sentence contradicting the report it introduces.
