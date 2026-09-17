---
"@motebit/protocol": minor
"@motebit/sdk": minor
"motebit": minor
---

The return view, from the surface you are actually holding — increment 5 of unattended execution.

Increment 3 answered "show me evidence when I return", and answered it only where the daemon runs. A person coming back to their motebit is usually holding a phone, and the phone is already the consent root: it could stop the motebit and decide an approval, and could see nothing of what either was about. That is half a clause.

**The data is not reachable locally, and that settled the design.** No other surface has the run ledger, the evidence table, or even the link from an outcome back to its run; the desktop has no goal stores at all and reads through inter-process calls. So this could not be a panel over a local store. It travels the way stopping already does: a signed request to the runtime that has the answer, which replies with a view of its own record. The runtime holds the port and the process that did the work supplies the reader, the same arrangement the goal-id resolver uses.

**Two refusals, both about not offering proof that is not there.** The verbatim result does not cross the relay. A signed artifact is read on the machine that signed it, because a copy arriving over a relay cannot be checked against that signature by whatever surface receives it — presenting it as the result would hand someone proof they do not have. A bounded preview travels instead and says which it is. And every piece of text that does cross passes through the same credential-class membrane an approval's arguments pass through, applied at the boundary rather than trusted from the reader.

**A surface that cannot see the ledger says so.** That sentence is not "no runs recorded", which is what a motebit that worked all night would otherwise appear to report to a phone that simply could not look. The relay routes the question only to a peer that runs unattended work, for the same reason it routes a halt there.

What comes back is the shape the terminal already shows: the run's status, what it produced and whether that is signed, what its tools reported, evidence pointers with their sources and whole digests, and anything read and deliberately not kept. The structured form rides alongside the text, so a panel binding to it later needs no protocol change.

**Found on the way, and fixed in the same pass:** the desktop's recent-outcomes view queries its tool audit by run id, and that column does not exist in the desktop schema — so the query did not return nothing, it threw, and every expansion showed "Failed to load" where the tool calls belong. The timestamp fallback beside it already handled exactly this case and was never reached.

Review round — six findings, one of them this arc's own defect reproduced:

- **The structured payload bypassed the membrane the text went through.** The result object is serialized whole and returned through the relay, so a carefully redacted string beside a raw object is no protection at all. That is precisely what the second increment found in the approvals command, whose comment says so in as many words, and the test I wrote asserted only on the text — which is exactly how it went unnoticed. Both outputs now derive from one redacted value, passed field by field so that adding a field without deciding what it means here is a type error rather than a quiet leak.
- **A lookup now says which of three things happened.** A prefix that matches several runs is not a prefix that matches none, and returning nothing for both made this view answer "no such run" about a run the list had just printed — the ambiguous absence the whole vocabulary exists to remove, reproduced inside its own reader.
- The lookup searches what the list shows. A held run is exactly the kind that stays open while newer ones accumulate, so on a short cadence it scrolls out of any fixed window within a day, and then the list shows it while asking for it by the identifier printed right there answers that it does not exist.
- The signature line is emitted only for rows that could carry one, which the terminal view was already corrected for.
- The list and the detail agree about whether a result is signed. They read different outcome sets, so a run whose only signed row predates the run link was reported unsigned in the list and signed in the detail.
- An undeliverable read-only question no longer reports that nothing was stopped or decided. That answers something nobody asked and implies an attempt that was never made.

Second review round — five of six were the same shape, a decision made correctly on one path and left undecided on the one beside it:

- **The list payload crosses the membrane the detail's does.** `note` is written from a caught error, so a run that failed against a token-bearing URL carried that token into the summary row, and `data` is serialized whole through the relay. The detail path was the one fixed above; this is its sibling, one function along in the same file.
- **The many-machines refusal is keyed on per-machine records, not on the word "approvals".** A halt is the same act wherever it lands, so the relay may pick; an approval queue and a run ledger are local databases, where picking changes the answer. Adding `runs` to the unattended set silently made the relay choose a machine for a question whose answer _is_ that machine's database, and explained it by naming an approval queue the reader had not asked about.
- **The reason is rendered, not merely fetched.** Runs holding a goal are listed first because they are waiting on a person, and a line that says `interrupted` without saying what is needed sends that person looking for something the row already holds.
- **`runs list` and `runs show <id>` are verbs.** Every word after the command was read as a run id, so the list verb answered `No run matching "list"` — an absence about a run nobody asked about, manufactured by the parser inside the command built to stop exactly that.
- The second undeliverable branch is split like its sibling: only a verb that could have changed something is told that nothing was changed.
- `RunLedgerReader`'s documentation had been orphaned by a type inserted between the comment and its interface, so it and `RunEvidenceSink` both shipped undocumented.

Third review round. Ten findings; the two that matter most are about a record being read wrong, and one is in the increment before this.

**A refused tool call was reported as "prepared; effect unknown".** The policy gate writes its audit row _before_ execution, so a call it denied — deny-list, out of delegated scope, over the risk ceiling, out of budget — has a decision and never a result. Deriving the verdict from the result alone told a returning owner that the outside world may have been touched by a call that was refused before it ran. That is the worst direction for this view to be wrong in, and `decision.allowed` was on the row the whole time.

**A halt reached one machine of several.** Not this increment's code, found checking whether a per-machine read belonged in the new routing set. The halt store is local and nothing replicates it, and the relay delivered to the first peer whose socket accepted — so a sovereign with a daemon on a laptop and a worker on a VPS stopped one of them and got back that one's acknowledgement, which reads as "stopped" for a motebit that is still working. Halt and resume now go to every unattended runtime, and an answer that speaks for one of several says so. `approvals` is deliberately not broadcast: repeating a halt is the same act, deciding an approval twice is two decisions on two records, which is why that one refuses instead.

- **`halt-status` is a per-machine read and now routes like one.** It reads this machine's halt store, so answered from whichever machine the relay picked it could say "Running — nothing is halted" while the other sat halted.
- **The preview was bounded before it was redacted.** Every credential pattern is length-anchored — a vendor key needs sixteen more characters after its separator, a seed phrase twelve whole words — so a secret straddling the cut was reduced to a stub no pattern matched and crossed in the clear, through the one boundary built to stop it. The reader hands the body over whole; the bound is applied after the membrane has read it.
- **A pointer with no provenance is no longer counted as checkable.** It has no digest, and the prose beneath it says "re-fetch the source and hash its text" — an instruction to verify something that was never recorded.
- **Held runs are marked, and no longer crowd out what happened.** Status alone cannot say it: an acknowledged `interrupted` run and one still waiting read identically, and only one asks anything of the reader. The held group was also prepended unbounded before a single slice, and oldest-first, so a motebit with ten runs waiting answered "what happened while you were away" with ten of the oldest held runs and nothing that happened.
- **Times are rendered.** They were fetched, typed and redaction-passed into the payload, and every remote consumer renders text — so on the phone the return view had no times at all.
- `runs ack <id>` and a bare `runs show` are answered as what they are rather than as missing runs — the same manufactured absence as the list verb, two verbs along.
- The desktop's outcome expansion no longer runs a query that cannot succeed. Its `tool_audit_log` has no `run_id` column and no migration adds one, so the catch that made it work turned a permanent condition into an exception: a failing round-trip on every expansion, and genuine database failures swallowed into a silently different answer.

Fourth review round. Three of the five are defects the third round introduced, and the remaining two are about a process answering for a record it does not have.

**A broadcast was delivering into one replay store twice.** `motebit run` and `motebit serve` on one host are two connections sharing a device id, a database and — by construction — one replay guard, and the envelope carries a single signature. Broadcasting to every connection meant the second process rejected its own motebit's halt as a replay, and that rejection was a candidate for the answer the person read. The replay guard's own comment names this sibling-delivery case as the hole it closes. A broadcast now delivers once per machine, which is also the right granularity on its own terms: the halt store both would write is the same file.

**A broadcast is not a race.** `cmdResume` answers "Nothing is halted." synchronously when nothing is active, while the machine that actually has the halt awaits its store — so the machine with the least to do reliably won, and a successful remote resume rendered as a no-op. Every answer is now gathered, bounded by a short grace after the first, and a runtime that does not answer is named as silent rather than dropped: an unanswered halt is the one case a reader must not read as "stopped".

**`halt-status` asks both machines instead of refusing.** Adding it to the many-machine refusal made it honest and unusable in the same move — a person who had just halted a laptop-and-VPS motebit had no way to see what stopped. Unlike an approval queue, these two answers compose: what each runtime has stopped _is_ the picture.

- **A call the owner personally refused was still reported as "prepared; effect unknown".** The gate writes `{allowed: true, requiresApproval: true}` before pausing, and appends the approval under the same call id when a person approves — the table replaces on that key — so a row that still says it is waiting is a call whose approval was never satisfied. Waiting or refused, it did not run. The previous round fixed this for the gate's refusals and left it on the refusal that matters most.
- **`runs` routes by the record, not by the ability to act.** `motebit serve` announces `unattended_runtime` truthfully and keeps no run rows of its own, so on its own machine it answered "No runs recorded yet" about a motebit that had worked all night. The many-machine refusal only caught that when every peer had declared a device id. A new `run_ledger` capability, announced by the goal daemon alone, catches it always — and serve no longer wires a reader over a database that is not the record.

Fifth review round, all six in the gathering the fourth round introduced. Each is the same shape: a report that drops one of the machines it is reporting on.

- **An unreadable answer erased the readable ones.** Returning the unparseable reply alone threw away the acknowledgement from the machine that did stop, leaving the reader no evidence of it — the inverse of the invariant the gathering exists for. Every machine gets a line, including one whose answer the relay could not read.
- **A machine whose socket was already dead disappeared from the report.** Counting successful sends rather than attempts meant a halt to two machines came back as a plain "Stopped." while one of them was never reached. Attempts and failures are now tracked apart, and an unreached machine is named.
- **The request timeout discarded answers already in hand.** A reply landing near the thirty-second ceiling armed a grace window that outlived the timer, so an acknowledged halt was deleted and reported to its owner as "the agent did not respond". An answer in hand is not a timeout.
- **Answers are attributed to the machine that sent them.** Numbering by arrival order told a reader that one runtime was silent without saying which — knowing something is still running and not where is the actionable half missing.
- The routing doc block had drifted onto the wrong constant, leaving "the subset of the above" pointing at prose rather than a set. Same orphaning as round two's, in the file that fixed it.
- `runs show <id> <stray word>` fell through to being read whole as an id. One stray word from the manufactured absence the parser was written to remove.
