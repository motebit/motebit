# @motebit/protocol

## 3.18.0

### Minor Changes

- 965136f: The return view, from the surface you are actually holding — increment 5 of unattended execution.

  Increment 3 answered "show me evidence when I return", and answered it only where the daemon runs. A person coming back to their motebit is usually holding a phone, and the phone is already the consent root: it could stop the motebit and decide an approval, and could see nothing of what either was about. That is half a clause.

  **The data is not reachable locally, and that settled the design.** No other surface has the run ledger, the evidence table, or even the link from an outcome back to its run; the desktop has no goal stores at all and reads through inter-process calls. So this could not be a panel over a local store. It travels the way stopping already does: a signed request to the runtime that has the answer, which replies with a view of its own record. The runtime holds the port and the process that did the work supplies the reader, the same arrangement the goal-id resolver uses.

  **Two refusals, both about not offering proof that is not there.** The verbatim result does not cross the relay. A signed artifact is read on the machine that signed it, because a copy arriving over a relay cannot be checked against that signature by whatever surface receives it — presenting it as the result would hand someone proof they do not have. A bounded preview travels instead and says which it is. And every piece of text that does cross is masked at the boundary rather than trusted from the reader — see the sixth and seventh review rounds below for which membrane, and why it is not one membrane.

  **A surface that cannot see the ledger says so.** That sentence is not "no runs recorded", which is what a motebit that worked all night would otherwise appear to report to a phone that simply could not look. The relay routes the question only to a peer that runs unattended work, for the same reason it routes a halt there.

  What comes back is the shape the terminal already shows: the run's status, what it produced and whether that is signed, what its tools reported, evidence pointers with their sources and whole digests, and anything read and deliberately not kept. The structured form rides alongside the text, so a panel binding to it later needs no protocol change.

  **Found on the way, and fixed in the same pass:** the desktop's recent-outcomes view queries its tool audit by run id, and that column does not exist in the desktop schema — so the query did not return nothing, it threw, and every expansion showed "Failed to load" where the tool calls belong. The timestamp fallback beside it already handled exactly this case and was never reached.

  ## What this increment does NOT ship, and why

  A halt reaching only one machine of several is a real defect in the increment before this one, found while reviewing this PR. It was fixed here, and the fix is now withdrawn to [its own branch](https://github.com/motebit/motebit/tree/unattended/halt-broadcast-multi-machine), unmerged.

  The reason is a measurement, not a preference. Fixing it meant changing what delivery MEANS — first-wins became a broadcast, with answer-gathering, a grace window, per-machine attribution, a composed report and a strictened `acknowledged` aggregate. Ten review rounds went into that code and each of them found three to five defects, most of them introduced by the round before. It never converged, because nothing in it can be caught by a test that fails: the repo has no harness that stands two runtimes against one relay, so every one of those defects had to be found by a person reading, and every fix was written blind.

  Weighed against that: on a motebit with unattended runtimes on ONE machine — every deployment that exists today — the broadcast is a no-op. It delivers one frame, takes the single-target path and hands the answer back exactly as first-wins does. So the trade on offer was four hundred lines of unexercised coordination machinery, changing the semantics of the most safety-critical verb in the product, to fix a bug no current deployment can hit. That is the wrong side of the trade, and the multi-machine case is the same case the persistent-service installer will make common — which is the increment that should carry it, behind the harness that can test it.

  What ships here is the return view and the routing it needs. All of it is a read, all of it is additive, and all of it has tests that can fail.

  Review rounds — the findings that shaped what ships:

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

  Sixth review round. Two of the seven are older than the gathering, and one of those is the sharpest finding in the arc.

  **The return view crossed the wrong membrane.** `redactForRemoteDisclosure` ran the cloud-egress subset, which deliberately leaves SSNs, card numbers and bare base64 alone — and the stated reason for that carve-out is about a user's own typed message to a model they chose: financial and personal detail they often mean the model to use. None of that reasoning survives the move to this boundary. The text here is a goal's whole retrieved output and the reader is a relay operator the sovereign did not choose, where fail-closed privacy says financial and medical never cross. A nightly goal summarising a bank or patient portal put an account number in `response_full`, and opening that run from the phone sent it over the wire in the clear — under a file header claiming everything crossing goes through the membrane. It now runs the full set at this seam, for approval arguments as well. The cost is over-redaction in a view, which is legibility; the cost of the narrower set was someone's card number on a relay.

  **A run that was still running was labelled "needs you".** `holding` was derived from `listBlocking`, which returns `running` rows alongside the ones awaiting a person — they block their goal and ask nothing of anyone. So an owner checking the return view at 7am while the nightly goal was mid-execution saw it raised above everything that had finished and marked as requiring their action, and a stale `running` row from an unrecovered crash read identically. `goalRunNeedsPerson` is now a named predicate in persistence and `goalRunBlocksGoal` is defined in terms of it, so the two facts cannot drift apart again.

  - **A first-wins command is no longer wrapped in a per-machine report.** A stale-but-unreaped connection beside a live daemon made `runs` and `approve` come back as "Sent to 2 runtimes; 1 answered", replacing the handler's own payload — and on a decision verb it read as one approval fanned out to two queues, the thing the routing refuses to do. Only a broadcast reports per machine.
  - `runs list abc123` answered `No run matching "list"`. A verb now decides the shape and the rest is its argument, so no word after one is read as an id in its own right.
  - `runs ack` no longer tells someone standing on the machine that holds the record to go run it there — the interactive terminal wires this reader too.
  - A dead second failure channel on the pending-command entry is gone.

  Seventh review round, correcting the sixth. The membrane widened last round is shared with the approvals command, and widening it broke the thing it was meant to protect.

  **A payment approval rendered as two redaction markers.** The full set adds bare-base64, SSN and a Luhn card check. A base58 Solana address is forty-four characters and matches the first; $250 in micro-units is `250000000` and matches the second; roughly one epoch-millisecond timestamp in ten passes the third. So the phone showed `{"to":"[REDACTED:…]","amount_micro":[REDACTED:…]}` and asked someone to consent to it. A membrane that erases the decision is not protecting the decision, and the round that widened it reasoned about a report and applied the answer to a decision.

  There are two membranes now, split by what the person does with the text. **Read to decide** — an approval's arguments, and an evidence source, whose prose says to re-fetch it and hash the result — keeps the credential-class set, because a digest beside an erased URL proves nothing to anybody and neither does an amount that has been masked. **Read as a report** — a run's result preview, its error reason, its note — takes the full set, because losing a field there costs legibility and keeping one can cost a card number. The asymmetry is the design.

  - **The terminal no longer redacts the owner's own record.** `cmdRuns` masked unconditionally, so `/runs <id>` in the REPL disagreed with `motebit runs show <id>` in the same shell about the same run. Masking is for the wire, and the command now takes the origin it is answering — defaulting to remote, so a caller that forgets redacts rather than discloses.
  - The operator doc and the file header no longer describe the membrane as credential-class, which after this stopped being true of half of it.

  Eighth review round. Two of the five are half-fixes from earlier rounds — the label corrected without the behaviour behind it.

  - **A dead socket on one machine no longer loses that machine's halt.** Broadcast chose one connection per machine before attempting any send, so a laptop with a stale-but-unreaped `motebit run` socket beside a live `motebit serve` reported "not reached" and was never stopped — where first-wins would have fallen through and delivered. One delivery per machine is about the replay store the two processes share, not about which of their sockets is alive, so every connection on a machine is a candidate for that machine's one delivery.
  - **Every surface that forwards a relay frame now says so.** Four of them called `executeCommand` with no origin, so a command that arrived over the wire answered as if it had been typed there. Latent for the return view because none of them wires a run ledger yet, and already a small untruth in the halt record, which exists to say where the sovereign stopped their motebit from.
  - **A `running` run no longer takes the top of the page either.** The previous round split "waiting on a person" off "blocking" and applied it to the mark alone; the priority group was still every blocking run. Five stale `running` rows from unrecovered crashes kept the top of a ten-row page, saying nothing and asking nothing, and pushed five finished runs off it. The group and the mark are the same fact and now read the same predicate.
  - **One unattributed answer no longer reduces every silent machine to a tally.** An answer carrying no machine id could have come from any target, so it can only be subtracted from a count — but the naming was gated on a whole-set predicate, so a single older surface answering anonymously erased the names of the machines that had demonstrably not answered. That is the gap the attribution was added to close, reintroduced by its own guard.
  - **The desktop's time correlation closes.** Ending the window at `now` was harmless while the path was unreachable; making it the only path made it live, and expanding the newest outcome listed every tool call made in ordinary chat since that run — attributed to the goal, disclaimed by nine-pixel grey text. A correlation that widens without bound is not a correlation.

  Ninth review round. Two of the three are the previous round's fixes applied to one caller and not its sibling.

  - **`motebit runs list` was still conflating the two.** The split between "waiting on a person" and "blocking" reached the return view and the persistence predicate, and not the local subcommand — which printed a run the daemon was executing right now under `Holding their goal (needs you):` with an `ack` that does nothing, while `/runs` on the same machine, reading the same ledger, correctly left it unmarked. Two views of one run disagreeing is the failure this arc exists to remove. (`ps` had already done the split by hand; it now has a predicate to share.)
  - **The desktop's correlation ceiling was on one branch.** Capping only the newest outcome left every other one bounded by the next outcome's start — and that list is every goal's outcomes, so a quiet motebit with a weekly goal gave a seven-day window and the query returned the earliest fifty rows in it. The unbounded case moved one branch over rather than closing.
  - **`acknowledged` survives composition, and gets stricter.** `sendAgentCommand` documents that a result whose data says `acknowledged: true` is the motebit reporting that it stopped, not the relay reporting a delivery. Composing several machines' answers replaced the runtime's `data` wholesale and dropped that field on exactly the multi-machine deployment this arc is for. It is now true only when every machine the halt was aimed at came back saying so — one machine's acknowledgement is not the motebit's, which is the sentence the halt command is built around — and the client's contract documents the composed shape.

  Tenth review round. One of the four is a fix from an earlier round that was wrong on its premise, and one earns a drift gate.

  **The desktop's exact join was removed on a false premise, and removed where it worked.** An earlier round argued that `tool_audit_log` here cannot carry `run_id`, because the Rust schema does not declare it. But the desktop opens `~/.motebit/motebit.db` — the same file the CLI opens — and the CLI's migration registry adds that column; this surface's own audit writer already inserts into it. So on every machine where the goal daemon has ever run, which is the only place run-linked rows come from, the query returned the exact rows, and it was replaced by a time window filtered by neither goal nor run. What was true in that round is that a THROW is not a fallback signal. The column is probed once per session and remembered, and the two paths stay honestly ordered behind it.

  **A relay frame now goes through a door that says so, and a gate keeps it that way.** `executeCommand`'s `origin` has to default to `local` — that is what nearly every call site is, and a halt mislabelled `remote` is an untruth in the durable record — but the return view reads the same field to decide whether the credential membrane applies, where `local` means disclose. Two opposite safe defaults on one parameter is a thing a reader gets wrong, and did: five surfaces forwarded a relay frame with no origin at all. `executeRemoteCommand` is the one door for the wire, and `check-relay-frame-origin` (invariant #158) fails any file that handles a `command_request` and reaches `executeCommand` without saying where the command came from. A gate rather than a review because nothing fails when a surface forgets — the command runs, the answer returns, the tests pass, and the only thing wrong is a membrane that did not close.

  - **The broadcast's target list is complete before the first send.** Assigning it afterwards left a window where an answer arriving during the loop read the list as empty, short-circuited the gather, and handed back one machine's `Stopped.` as the motebit's — the failure the broadcast was built to remove, reachable through a fast enough transport.
  - **A `runs` question that cannot be routed says why and what to do.** It gets no legacy fallback on purpose, so for a while every installed daemon keeps a ledger and announces none — and a 404 naming neither the cause nor the remedy leaves a person staring at a healthy daemon.

  Eleventh review round. Three findings, all in the previous two rounds' own code, and all the same kind of mistake: a guard written from a plausible story rather than from what the value can actually be.

  - **An undeclared machine's answer was credited to a declared sibling.** An answer carrying no machine id was treated as unplaceable and spent as a generic credit on the first target — but it is perfectly placeable: it came from a peer that declared no id, which is exactly the bucket a broadcast aims its one undeclared delivery at. With an updated daemon and an older runtime, an answer from the older one printed under the declared one's id and left the bucket that actually replied listed as silent, so one report said the same machine had stopped and had not answered, and softened a genuine silence on the machine still running. Every answer is attributable, so the credit bookkeeping is gone.
  - **One transient database error downgraded the rest of the session.** The `run_id` column probe writes its answer into a session memo; the catch wrote `false`, so a single locked-database moment — the daemon writing, say — permanently sent every later expansion to the unfiltered time scan. The comment above it said "unknown stays unknown for this attempt", which is what the code did not do.
  - **`Number.isFinite` is not a guard against a null timestamp.** `db_query` maps SQL NULL to JSON null and `Number(null)` is `0`, which is finite — so a neighbouring outcome with a null `ran_at` produced an inverted window and an empty tool-call list for a run that demonstrably made tool calls. The `|| Date.now()` this replaced guarded exactly that case.

  Twelfth review round. The largest finding is the seventh round's own correction, corrected again — and the answer this time is that there were never two kinds of text at this boundary, there were three.

  **An evidence source is read to RE-FETCH, and neither credential membrane serves that.** The seventh round routed it through the credential-class set, reasoning that a source is read to act on like an approval's arguments. That set is _keyword-keyed_: `API_KEY` matches any long word beginning `key`, `api`, `token` or `secret`, so `…/apidocumentationandreference/v2` came back as `…/[REDACTED:API_KEY]/v2` and the owner was handed a digest beside a source they cannot see — the precise failure that round's comment claimed it was avoiding. And it let through what the report membrane had just been widened for: both credential sets exclude SSN and card numbers by design, so a statement URL crossed the relay with both in the clear, and the producer-side withholding check excludes them too, so nothing upstream caught it. A retrieved source now has its own membrane, split where its risk splits: the path is structure written by someone else and gets the shape-keyed set, which cannot be fooled by a stranger's vocabulary; the query and fragment are data and get the full set, because a false positive there costs a parameter and being wrong the other way costs someone's PII. A `ref` that will not parse as a URL takes the full set, because unparseable is not a licence to disclose.

  - **`motebit runs show` searches what the list shows.** Its two siblings — the reader behind `/runs` and `motebit runs ack` — already searched the union of held and recent runs; this one searched a 200-run window, so a held run old enough to scroll out was listed by `motebit runs`, opened by `/runs`, released by `ack`, and denied by `show`. The same two-halves-disagreeing failure the reader's own comment describes, fixed on two of three siblings.
  - **A silent machine is described in the verb that was asked.** One hardcoded halt sentence served all three broadcast verbs, so a `/resume` reported "what it stopped is unknown" about a command that stopped nothing — an untrue sentence about the one machine the reader most needs the truth about.
  - The `runs ack` reply no longer tells the reader to go to another machine; it is reachable from the terminal that holds the record, so the sentence has to be true read from either side.

  Thirteenth review round. Five findings, every one in the last three rounds' own code.

  - **The source membrane erased the host of any non-http scheme.** Rebuilding the head as `url.origin + url.pathname` looked reasonable and is wrong: `origin` is the literal string `"null"` for every non-special scheme, so `s3://reports/q3.csv` came back as `null/q3.csv` and `file:///Users/d/report.txt` as `null/Users/d/report.txt` — the bucket and the host dropped from the one string the owner is told to re-fetch, and userinfo swallowed with no marker. It splits the raw string at the first `?` or `#` now, which is what the split was always about and works for every scheme.
  - **The desktop's restored join matched only completed runs.** `outcome_id` equals `run_id` on exactly one writer; interrupted-run recovery and the rest mint a fresh outcome id and carry the run separately. So the join matched the runs a returning owner cares least about and dropped the interrupted ones — which have tool calls, and do expand — into the unfiltered time scan, on a machine that had the exact key sitting in `goal_outcomes.run_id`. It resolves the run through that column now, coalescing to the outcome id where the column has not arrived.
  - **A `no` from the column probe was remembered for the session.** The transient-failure path was fixed for exactly this staleness and the genuine-absent path had the same shape: a desktop window opened before the daemon had ever run would keep scanning by timestamp after the migration landed beneath it. A column never disappears, so only a `yes` is remembered.
  - **A comment claimed a guarantee the parameter does not give.** `cmdRuns`'s `origin` defaults to `remote`, but the only dispatcher passes `?? "local"` — so a caller reaching it through `executeCommand` and forgetting gets `local`. The default protects a direct import; what protects the wire is `executeRemoteCommand` and the gate that requires it, and the comment now says so.
  - **Two undeclared connections could be two hosts, and the fold hid it.** They are bucketed together on purpose — they might equally be one host's two processes sharing a replay store, and delivering twice into that store is the worse error — but with a single target the composed report short-circuited and handed back that one machine's `Stopped.` as the motebit's. The fold is reported now, and it forces the composed report even at one target.

  **Withdrawn with the broadcast, and preserved on its branch:** the per-machine delivery, the answer gathering and its grace window, the composed per-machine report, the silence and unreached lines, the undeclared-bucket attribution and collapse notice, and the strictened `acknowledged` aggregate. Rounds four through thirteen above narrate their defects as they were found; they are recorded because the pattern is the lesson, not because the code ships.

  Final round, after the scope correction — and the first finding is the same error one level down:

  - **`halt-status` is left exactly as it shipped.** The revert had moved it into the per-machine refusal, which is the same reasoning that governs an approval queue and would be right on its own. But on a two-machine motebit `halt` still delivers to one of them, so refusing the status leaves a phone able to stop the motebit and unable to see what stopped — strictly worse than the false negative it replaces, and a change to an already-shipped verb from an increment that only adds a read. Delivery and status are one problem and both belong to issue #681. This set gains exactly one member here: `runs`.
  - **The origin gate is checked per CALL, not per file.** One door anywhere in a file exempted every other call in it — and `apps/cli/src/daemon.ts` has two independent frame handlers, so a third could have been added calling `executeCommand` bare and stayed green forever. That is the latency the gate exists to close, in the one file that already has more than one handler.
  - **The gate's aperture line no longer overstates what it looked at.** It counted anything mentioning the string `command_request` — including the crypto package's envelope signer and the runtime's own barrel export — and claimed to have checked them. Matching an actual comparison against the frame type took the count from ten to five real handlers, which is the honest number.
  - **The detail is bounded, like everything else in the view.** Neither the tool-call query nor the evidence query carries a limit, and a note or an error reason was redacted but never cut, so an overnight run with a few hundred tool calls produced a response of hundreds of lines pushed through a thirty-second relay timeout and rendered on a phone as one message. The counts in the section headers stay the run's true totals, because a bounded list must not read as a complete one.
  - **A word that was never a run id is told so.** `runs help` answered `No run matching "help"`, an absence about a run nobody asked about. Judged after the lookup and never before it: the ledger is the authority on what exists, and the shape of the target only chooses the wording of a miss.

- 4ebe62b: Durable unattended execution, increment 1 — intent before the call, completion after, and a run ledger the daemon recovers from instead of re-firing.

  `@motebit/protocol`: `PolicyDecision.callId?` (additive) — the audit row the gate wrote the decision under, so the executor can close the same row.

  `@motebit/policy`: `PolicyGate.validate` now returns the `callId` of the decision row it appends BEFORE execution; new `PolicyGate.recordResult(ctx, decision, tool, args, ok, durationMs)` closes that row after (the previously unused `AuditLogger.logResult`, now redacting args like the decision row). New pure helpers `findUnresolvedActions(entries)` (allowed, un-paused decisions with no completion — external effect UNKNOWN) and `countCompletedActions(entries)`.

  `@motebit/ai-core`: the loop calls `recordResult` the moment `tools.execute` returns or throws; `approval_request` chunks carry `audit_call_id` + `turn_id` so an out-of-loop resume can close the same row.

  `@motebit/runtime`: the resume-after-approval path and `invokeLocalTool` both record completions; `invokeLocalTool` gains `humanApproved` (an out-of-band human decision satisfies the approval band like a tap — never a hard deny, never R4_MONEY).

  `@motebit/persistence`: migration #43 — `goal_runs` ledger (`SqliteGoalRunStore`, `goalRunBlocksGoal`) and `approval_queue.args_json` (the full arguments a post-restart decision executes exactly).

  `motebit` (CLI daemon): every goal run is a persisted row from before its first model call. Shutdown no longer denies pending approvals and restart no longer denies "orphans" — a human's decision survives the process. On restart, runs the old process died inside become `interrupted`; the tool audit log says whether anything external happened (completed actions, or decision rows with no completion = unknown), and if so the goal is HELD until `motebit runs ack <run_id>`. A decision made after a restart applies to exactly the one approved call (args hash re-checked, same policy gate, R4 never) — the paused turn is not re-run. New `motebit runs [list|ack]`; `motebit ps` marks held goals.

  Review follow-up in the same increment: recovery is itself an interruption point. Both out-of-loop execution paths (the daemon's live drain and its post-restart apply) now move the run to `running` BEFORE the call, and the executor appends an allowed, un-paused `approval_satisfied:<by>` row under the same `callId` (`PolicyGate.recordApprovalSatisfied`, called by `invokeLocalTool` for taps and human-approved recoveries and by the resume path) — so a death after the approved call reads as "prepared; effect unknown" and holds, never "nothing happened", and the approval is never executed twice. `invokeLocalTool` gains `runId` so the row is classifiable by run. The recovered outcome states the goal's remaining work was not resumed; `motebit runs ack` states the next run starts from scratch and may repeat effects.

  Second review follow-up: a decision applied after a restart closes its run and outcome as the new structural status `partial` (`GoalOutcome.status` / `GoalRunStatus`), never `completed` — the one approved action ran or was refused, the goal's remaining work was not resumed, and no projection may count it as goal success. `motebit runs ack` now requires `--allow-fresh-run`: the consequence (the next run starts from scratch and may repeat listed effects) is printed BEFORE anything is released, and the flag is the acceptance. A real-crash test (child process, file-backed SQLite, SIGKILL after the recovered call's effect and before its record) proves the next process holds the action as unknown and does not execute the approval again.

  PE review round (`/code-review 674 high`, 9 confirmed findings) — the recovery path had real defects, all fixed here:

  - **An approval whose paused turn was already voided is no longer executed out of band.** The runtime's own approval timeout (10 min) is shorter than the scheduler's TTL (1 h), so a human approving at minute 20 hit a drain that logged "nothing to resume" and then let the recovered-approval path run the tool anyway, long after the conversation recorded the call as failed. Both "not resuming" branches now close the run (`closeVoidedRun`); the recovered drain also refuses while any other approval is pending in the shared runtime.
  - **The 1-hour TTL now bounds the decision, not the sweep.** `motebit approvals approve|deny` refuses an approval past `expires_at` (and sweeps it), and the recovered drain refuses one whose `resolved_at` is past it — closing the daemon-was-down hole where a 3-day-old call executed.
  - **Every `running` transition has a failure transition.** A live resume that throws is caught: the run closes `failed` with an outcome, instead of sticking `running` forever (un-ackable, holding the goal until a restart).
  - **Restart recovery can no longer clobber a real outcome.** The live paths write the run-status transition before the outcome row, and the recovery outcome gets its own id instead of reusing `run_id` (`INSERT OR REPLACE` was overwriting a completed outcome with "interrupted").
  - **A graceful `stop()` mid-run closes the run** (abort + `failed`) instead of leaving it `running` for the next start to classify as interrupted and hold behind a human ack.
  - **Goal-scoped tools are registered while a recovered approval executes**, so an approved `create_sub_goal` / `complete_goal` / `report_progress` is not refused as "not available".
  - **`motebit runs ack` resolves by indexed id** (blocking runs first), so a held run stays ackable past 200 newer rows; **`motebit ps`** shows a live run as `running now`, not `HELD (interrupted …)`.
  - **One audit entry per call.** `recordResult` was appending a second full entry, which keyed sinks upsert but the browser IndexedDB and mobile Expo sinks duplicated — double-counting `queryStatsSince` and skewing the gradient. New optional `AuditLogSink.complete(entry)` writes `result` + `timestamp` onto the recorded entry (decision preserved); implemented on all six sinks, with the chain still recording both links.
  - Restored the four `#462` approval-binding tests the first cut had deleted, plus the resolved-approvals-untouched test.

- 89d3d08: Halt, and the consent root reaching the runtime — increment 2 of unattended execution.

  Increment 1 made a motebit's unattended work survivable across a crash. This one answers the other two clauses: **reach me when it needs authority, stop when I withdraw it.**

  **Halt is durable state, not a message.** A message a stopped process never receives is not a stop, and a stop a restart forgets is not a stop either. `HaltRequest` + `HaltStoreAdapter` (protocol) and migration #44's `halt_state` (persistence) keep `requested_at` and `acknowledged_at` as separate facts, because they are: a daemon that is offline has been ASKED to stop and has not stopped. No surface may render the first as the second, and the CLI waits a few seconds then says plainly which happened.

  **Three verbs, deliberately not one.** `runtime.requestHalt()` records that someone asked — any process may, including a one-shot CLI that is not the thing doing the work. `runtime.honorHalts()` is the executor stopping and saying what stopping entailed; it is idempotent, and a stopper that throws still acknowledges with the failure in the record rather than looking like "still running" forever. `runtime.liftHalt()` is a human giving the permission back.

  **The scheduler consults it in four places**: before a tick does anything, before each goal fires (a goal-scoped halt stops only that goal), before a recovered approval executes, and before idle consolidation runs — and the in-flight run is aborted. A halt outranks an approval granted before it: the later word wins, and the approval is kept rather than thrown away.

  **The first mutating verbs in the remote-command vocabulary**, and the first production minter of an `agent-command/{motebit_id}` envelope — the fail-closed verification stack has shipped on all five surfaces since the unification arc with nothing signing for it. `RelayClient.sendAgentCommand()` mints and sends; `motebit halt|resume|halt-status --remote` and the phone's `/halt`, `/resume`, `/halted` use it. No privilege is added: the envelope is signed by the motebit's own identity key, so the caller already holds sovereign authority. What is added is reach.

  **The phone can decide an approval.** `/pending`, `/approve <id>`, `/deny <id>` list and resolve the daemon's queue over the same signed channel; the daemon picks the verdict up on its next tick through the same policy gate (a money action is still never executed from a recovered run). What the phone is shown goes through the same credential-class redaction as any egress to a non-sovereign party — destination, path and amount visible so the decision is real, secrets masked, full arguments never leaving the machine — alongside a hash over the _whole_ argument set, so a truncated preview is detectable rather than merely trusted. `ApprovalItem` moves to `@motebit/protocol` (re-exported from persistence) because it now crosses a wire, and `ApprovalStoreAdapter` gains optional `listPending` / `get` / `resolve` so a consent surface can read and decide rather than only vote on quorum.

  **Not in this increment, and named rather than half-built:** the daemon's event log never leaves the machine, so "reach me" is pull (the phone asks) and not push (the motebit notifies). That gap is cross-surface — desktop and web have it too — and a push notification arc belongs on its own. A disconnected runtime also cannot receive a remote halt at all; the command says "not delivered" rather than pretending, and bounding that window with a contact lease is deferred.

  Review round (`/code-review 677 high`, 9 findings) — all fixed:

  - **Raw arguments no longer ride beside the redacted text.** The live-turn fallback returned `data.args` unredacted while redacting only the display string, and `data` is serialized whole through the relay — the exact leak the redaction exists to prevent.
  - **Scope travels structurally, never inside the reason.** A `goal <id> <reason>` grammar read `--reason "goal cleanup done"` as halting a goal named "cleanup": nothing was halted and the response said a goal had been stopped. A stop command that reports stopping something must have stopped something.
  - **A halt can interrupt work in progress.** Honoring ran inside the scheduler's single-flight guard, which a goal run holds for its whole duration (up to ten minutes), so a locally-written halt could not abort the run it was for. Phase 0 now runs outside the guard.
  - **A goal-scoped halt is genuinely scoped.** Both approval drains checked only the motebit-wide halt, so a narrow halt still executed that goal's approved call.
  - **The local CLI path emits its events.** `halt_requested` and `halt_lifted` were reachable only via `--remote`; the default path left no record of who asked or who lifted.
  - **Truncation is measured, not guessed.** A `length >= 500` threshold reported the 200-char previews most producers store as complete, so the phone saw a preview cut before the destination with nothing saying so. Now compared against the stored full arguments, with `null` for rows that predate them.
  - **The relay routes these verbs to a runtime that can serve them.** Every surface answers `command_request`, so a halt could be answered by the phone that sent it ("this surface cannot be halted") while the daemon kept running — indistinguishable from a refusal. They now go to a peer announcing `background`, or fail as undelivered.
  - Trailing text on an approve is no longer written as a denial reason, and a halt another actor acknowledged first is read from the record rather than inferred from a return value.

  A follow-on found in the fix itself: moving halt-honoring outside the scheduler's single-flight guard made concurrent entry ordinary (the daemon's interval and an inline remote `halt` overlap), and `honorHalts` emitted `HaltAcknowledged` unconditionally — two "it stopped" events for one stop, in the log that exists to be the honest record of exactly that. Honoring is now serialized, with callers queuing rather than sharing a result so a halt written mid-pass still gets a pass of its own.

  Second review round (`/code-review 677 high`) — eight findings, two of which meant the feature never worked at all:

  - **Every remote command was rejected with a 401 before the envelope was examined.** `/api/v1/agents/*` sits behind the agent auth middleware and this path is not public; the client sent no bearer, and the phone minted the `sync` audience where the route requires `admin:query`. Both paths now authenticate, and the CLI supplies a device key. The relay tests missed it because they authenticate with the operator master token, which takes a bypass branch; the mobile tests stubbed `fetch`.
  - **The phone's 401 handler gave a confident wrong diagnosis** — it blamed the device key for what was an audience mismatch. It now carries the relay's own reason and offers the key as a possibility.
  - **Routing by `background` did not select the daemon.** The desktop app announces it and wires neither store, so a halt could be answered "this surface cannot be halted" while the daemon kept running. New `DeviceCapability.UnattendedRuntime`, announced only by a surface that wired the halt and approval stores.
  - **Mutating verbs had no replay defence.** Freshness alone was enough while the vocabulary was read-only; a captured `resume` replayed inside the window would lift a halt. `CommandReplayGuard` (`@motebit/runtime`) refuses a repeated envelope signature.
  - **Moving halt-honoring above the tick body also moved it outside that body's try/catch**, turning a busy SQLite write into an unhandled rejection that would end the daemon. Phase 0 has its own guard, and a stopper that never settles is now bounded rather than wedging every later halt.
  - "No unattended runtime is connected" returns 404 rather than 500, so a consent surface can read it as "not delivered".
  - The structured halt scope requires a `goal_id` marker, so a reason like `{"deploy":"done"}` is no longer parsed and silently discarded.
  - The `args_hash` claim is narrowed to what is true: the remote surface carries it forward, it cannot verify it.

  And the test that would have caught it, added at the layer that defines the contract: the relay now pins that this route refuses a request with no bearer, refuses the `sync` audience (the exact mistake that made every phone command fail), and accepts `admin:query` — with `packages/relay-client` asserting the other half, that the client sends one. The two halves meet at the real middleware rather than at a stub that agreed with them.

  Third review round (`/code-review 677 high`) — six findings, all fixed:

  - **`motebit halt goal <prefix>` halted nothing while reporting a stop.** The docs prescribe the 8-character prefix `motebit goal list` prints, and the scope check is an exact match — the same class of failure as the reason-parsed-as-scope one, one layer along. The id is now resolved before anything is recorded or sent, and an id matching no goal is refused.
  - **The acknowledgement overclaimed.** It said "aborted run X" the moment the signal was raised, but the signal is observed between steps, so a tool call already dispatched runs to its end. It now says the abort was signalled and that an in-flight call finishes — the same honesty the two timestamps exist for, one layer down.
  - **A halt spent the goal's retry budget.** The abort surfaced as a run failure, so three stops over a week would auto-pause the goal, and lifting the halt would silently not be enough to start it again. A stop the human asked for is no longer counted as a failure.
  - **`motebit serve` wired the halt store but could neither be reached nor stopped.** It did not announce `unattended_runtime`, so the relay refused to route a halt to it; and with no goal scheduler nothing honored a local halt, so the row sat un-acknowledged while the worker kept accepting tasks. It now announces the capability, refuses relay-dispatched work while halted, and acknowledges on its own cadence.
  - Approvals keep expiring while halted, so the queue is not frozen overnight and then expired all at once on resume; and the stopper timeout is cleared rather than left pending, which would hang a short-lived process for ten seconds on exit.

  And the structural fix the pattern called for. Three rounds found three ways to record a halt whose scope matched nothing — a reason parsed as a goal name, an unresolved 8-character prefix, an id that did not exist — each producing the one failure a stop command must never have: the record said a goal was halted, `halt-status` listed it as in force, and the goal kept firing. Fixing the fourth call site would have been the fourth fix. `SqliteHaltStore.request` now refuses a goal-scoped halt whose goal does not exist for that motebit, so no caller — CLI, command layer, phone, or one not written yet — can record one.

  Fourth review round (`/code-review 677 high`) — six findings, all fixed, and one of them the recurring class again in a place the store-level guard could not reach:

  - **The acknowledgement claimed a signal it had not sent.** `stopForHalt` derived "signalled abort of run X" from `currentRunId`, but only the goal-fire path sets an abort controller — both approval drains set the run id with no abort channel at all. A halt landing while a recovered approved call executed reported an abort while the call ran to completion. The sentence now reads from the controller's presence, which is the fact, and says plainly when a run cannot be interrupted.
  - **An attached read/act surface could DECIDE an approval.** `approvals` stopped being a read-only listing when it gained approve/deny, so `command_execute` let a frontend frame resolve a queued R3/R4 call that the daemon then executed — routing around the consent surface, which the sibling `tool_execute` arm refuses on exactly that ground. Deciding now requires a consent surface; listing still works.
  - **A halted run left no ledger record.** Skipping the failure count was intended; skipping the outcome row and the `goal_executed` event was a side effect of the early `continue`, against the invariant asserted twenty lines below it. The record is written as `partial`; only the failure count is skipped.
  - `stop()` started a consolidation cycle unconditionally, after a halt whose acknowledgement had promised none would start. A floating `honorHalts()` in serve mode's task handler could crash the daemon on a busy database.
  - **The replay guard was per-process.** A machine running both `motebit run` and `motebit serve` has two peers announcing `unattended_runtime` and two independent guards, so a replayed `resume` landing on the sibling would lift a halt the sovereign had just applied. Migration #45 adds a shared, durable seen-signature set with an atomic check-and-record; a storage failure falls back to the in-memory set, which is narrower and never wider.

  Fifth review round — eight findings, one critical, and the critical was the recurring class a SIXTH time. Its root cause is now addressed rather than its symptom:

  - **Acknowledgement was one fact about N executors.** `halt_state.acknowledged_at` is a single column, but more than one process runs unattended work for one motebit — `motebit run` and `motebit serve`, same machine, same database, which is the stated reason migration #45 exists. Whichever ticked first wrote the acknowledgement; every other process then saw a non-null column, skipped the halt entirely, never ran its stopper, and its goal run continued to the wall clock while the phone was told `Stopped` with `acknowledged: true`. Migration #46 moves acknowledgement to one row per executor, keyed by process rather than device, and honoring asks "have _I_ stopped". This is the structural cause behind every earlier instance of the class: a single fact standing in for several.
  - **An attached frame could `resume`.** The previous round gated approve/deny on the attached read/act surface but `resume` had just joined the same allowlist — and restoring unattended autonomy wholesale is a larger authority act than deciding one call. `halt` and `resume` are both refused there now.
  - **A 504 was reported as "not delivered".** That status means the envelope _was_ delivered and the runtime did not answer in time, which is exactly when a halt is most likely to have been applied. Telling someone nothing was stopped is the same overclaim inverted. It now says delivered-no-answer and points at `halt-status`.
  - `--remote` resolved the goal id against the _local_ database, so halting a goal on another machine's runtime failed with "no goal matching" — the id now travels as given and the remote store's own validation refuses one that matches nothing. An unguarded `honorHalts()` in the halt command could report a recorded halt as an error. `CommandReplayGuard.size` silently read the wrong set once a store was wired.
  - A halted worker does not claim a relay-dispatched task, and the limitation is named rather than papered over: the relay's task protocol has no decline verb, so an invented refusal frame would be dropped — the appearance of a refusal without one. The task is re-dispatched until it times out; a real answer needs a decline verb in the task protocol.
  - `@motebit/sdk` widened its public API (`HaltStoreAdapter`, `StorageAdapters.haltStore`) with no changeset, and would have shipped the widening as a patch cascade.

  Sixth review round — eight findings, three high, and the fix this time is two chokepoints rather than eight patches:

  - **Every dispatched task now passes one guard.** Three sockets reach the same runtime entry (the daemon's relay socket, serve's relay socket, serve's MCP `motebit_task` tool) and two of them had no halt check — a halted worker kept accepting and executing relay work while `halt-status` said stopped. The check sits at that entry, ahead of the provider check, so a path added later inherits it.
  - **Every idle cycle now passes one guard.** Four callers reach the consolidation entry; the scheduler's two were guarded and the runtime's own idle tick and startup catch-up were not. The check moved inside the cycle.
  - **The approval-expiry path ran a model turn under a halt.** Expiring a suspended turn resumes it with a denial, and that continuation can make further non-approval-gated tool calls. The record still expires; the turn waits.
  - **The readers were still collapsing the per-executor model.** `halt_state.acknowledged_at` holds whichever process acknowledged first, and both the command layer and the CLI rendered it as "Stopped". The command now reads its own executor's row and lists the others; the CLI names who acknowledged and what each stopped, and never says a bare "Stopped".
  - `halt goal <prefix> --remote` was unusable with the ids people actually see: the prefix now resolves at the runtime that owns the goals, through a resolver the scheduler registers. And both envelope minters send a nonce, so two identical commands in the same millisecond are no longer refused as a replay — a false "this did not happen" on the one vocabulary where that costs most.

  Seventh review round — six findings, and the shape of them says the chokepoints held. None is a new ungated execution path:

  - **Expiring a suspended turn deleted it before checking the halt**, so the turn the guard claimed to preserve was already gone and the runtime wedged. The check moved above the delete; a bug introduced by the sixth round's own fix.
  - **The daemon claimed a task before consulting the halt**, so a stopped motebit still took work off the relay queue even though it then refused to run it.
  - **Serve mode never registered the goal-id resolver**, so a goal-scoped halt sent to a serving daemon matched nothing.
  - **A run that produced no receipt reported itself "completed".** A receipt is the only completion — the admission release already says so — so a halted worker was answering a paying delegator with the reverse of what happened. It reports `failed` with `receipt_missing` now. The test asserting "completed" had encoded the defect.
  - `approvals` routed only to peers announcing the new unattended-runtime capability, which would have stopped reaching every already-deployed daemon. It falls back to the capability those daemons announce.
  - A goal-scoped halt was still summarized as "Stopped" in two places, which reads as motebit-wide. Both name the goal.

  Eighth review round — eight findings, and three of them were one defect in three readers, so the fix is structural rather than three patches:

  - **`HaltRequest` no longer carries an acknowledgement.** It held the FIRST acknowledger's timestamp "for display", with a comment on the field saying it must never be read as "the motebit stopped". Three readers read it that way anyway — `halt-status` in the runtime, `halt-status` in the CLI, and the `halt_acknowledged` event, which was carrying another process's words under this process's stop. The fields are gone rather than better documented. Whether anything stopped is now reachable only through `acknowledgements(halt_id)`, which returns one row per process with the executor that produced it, so a reader cannot get the wrong answer because it cannot reach it. No surface says a bare "Stopped": they report how many processes answered and state plainly that a process which has not acknowledged is still running.
  - **The executor id no longer throws on a surface without `crypto.randomUUID`.** It is a class-field initializer, so it ran in every runtime constructor on every surface, halt wired or not — turning a secure-context-only browser API into a surface that could not boot. Guarded the way the sibling call in the same file already was.
  - **`motebit serve` honors halts without a relay URL.** The stopper, the goal-id resolver and the honoring ticker were registered inside the relay branch, so a serve process with no relay configured refused every task at the chokepoint while never acknowledging — reporting "no acknowledgement" about a worker that had in fact stopped.
  - **The legacy `approvals` fallback refuses instead of guessing.** The desktop app announces exactly the daemon's five capabilities, so with both connected the relay had no signal to tell them apart, and `/approve ap-1234` landing on the desktop app answers "no pending approval matching ap-1234" — a false refusal, which on the consent vocabulary is worse than an undelivered one. One legacy candidate is still accepted; more than one is refused with an instruction to update the daemon.
  - The phone reports a 504 as delivered-but-unanswered rather than a bare status line, so nobody re-sends a stop believing the first never landed.

  Ninth review round — five findings, all in the reporting and durability of a stop rather than its enforcement:

  - **An executor is a role, not a process lifetime.** The executor id was regenerated at every process start, so a daemon that restarted three times overnight re-honored the same active halt three times and `halt-status` reported "3 process(es) stopped" on a machine that had only ever run one. That is the same over-reporting the per-halt acknowledgement column was removed for, one level down. The daemon now names itself `run@<device>` and the worker `serve@<device>`, stable across restarts; a surface that really is one of many short-lived ones keeps the per-process default.
  - **A surface with no readable queue says so, instead of reporting an empty one.** Listing approvals returned "No pending approvals" whether the queue was empty or absent, and the relay's compatibility fallback can deliver that command to a surface that is not the daemon. The phone would have been told nothing was waiting while the daemon held a real pending call. The decide path already refused honestly; the list path agreed with whatever the caller feared least.
  - **A replay guard that cannot check refuses.** When the shared store threw, the guard fell back to its per-process set, described in its own comment as "narrower but never wider". It is wider exactly where it matters: the shared store exists to catch a replay landing on the sibling process, which a per-process set cannot see at all. A busy database would have let a captured `resume` accepted by one daemon be replayed to the other inside the freshness window, lifting a halt that had just been applied. It refuses now, and the refusal says which refusal it is, so "you already sent this" is never reported for "I could not check".
  - **`motebit serve` honors halts on every transport.** The registration was inside the http-and-relay branch, so a stdio worker refused every task at the chokepoint while never acknowledging. It is now at function scope, and the ticker and stopper are released on shutdown.
  - The phone carries the relay's own reason on an undelivered command rather than overwriting it with "the runtime is not connected", which was wrong whenever the relay refused for the other reason and threw away the only actionable sentence.

  Tenth review round — five findings. One was the arc's own defect class in its last hiding place:

  - **A stopper answers for the halt it was handed.** The worker daemon's ignored its argument and returned the motebit-wide sentence for every halt, including a goal-scoped one — while its enforcement only ever consults the motebit-wide halt. So `motebit halt goal a1b2c3d4` produced an acknowledgement saying this worker had stopped accepting dispatched tasks, and it went on accepting every one of them. That is the record saying a goal was halted while the work keeps running, which is the failure the store-level scope validation was added to prevent, reappearing one layer up. It now says plainly that nothing here runs under that goal and that dispatched tasks continue, which is both the honest answer and the true one.
  - **The worker registers its halt identity before its socket opens, not after.** The stable executor id, the stopper and the goal-id resolver were registered after the relay connection, the registry round-trip and an optional self-test — seconds later. A remote halt arriving in that window honored itself under the per-process default with no stopper, recorded "nothing was running", and was then honored again under the stable id: two acknowledgement rows for one process, the exact over-reporting the stable id exists to remove.
  - **Two unattended runtimes on two machines are refused rather than chosen between.** One machine announcing twice is harmless, because `motebit run` and `motebit serve` share a device id and a database. Two devices is a different fact: each has its own queue, so the relay picking one would answer `/pending` from the worker with "No pending approvals" while the laptop daemon held a real one. The refusal names the machines and says to run the command on the one you mean.
  - The `--remote` command line carries the relay's reason instead of printing a bare status line, matching the fix the phone received earlier in this branch.
  - A past-TTL approval is swept when a remote decision is refused, as the local command already did. Without it the row kept appearing in `/pending` and every attempt to decide it was refused, which reads as a broken command rather than an expired approval.

  Eleventh review round — six findings, two of them high, and one of them a regression introduced by the tenth round's own fix:

  - **`motebit serve --direct` executed work while halted.** That mode replaces `handleAgentTask` wholesale and executes tools itself, so it never reached the runtime entry where the halt is enforced — a halted worker went on running every task arriving over its MCP surface while reporting that it had stopped accepting them. The guard now sits on the MCP surface, ahead of task admission, where it covers every handler including ones not written yet. A chokepoint behind an injection point is not a chokepoint.
  - **The previous round's machine-grouping guard would have refused everything.** It keyed on the relay's device id, which no client ever sends — the relay invents a fresh one per connection. So the same-machine `motebit run` plus `motebit serve` pair, the exact configuration the per-executor model exists for, always read as two machines, and every remote halt would have 404'd. Clients now declare their device id, the relay records whether it was declared, and peers that declared none are delivered to rather than refused. Undeclared is unknown, and unknown must not refuse.
  - **Listing approvals sweeps expired rows, as deciding already did.** Fixing only the decide path fixed the half nobody sees first: the phone would report approvals waiting and then refuse every one of them, which reads as a broken command rather than an expired approval.
  - **`/halt goal <id>` works from the phone.** It is the syntax the command line and these docs teach, and the phone was reading it as free text — silently widening a goal-scoped stop into a motebit-wide one and recording "goal payments" as the reason. A stop that does more than it was asked is the mirror of the failure this arc is built around.
  - The identity private key is erased in a `finally`, so a signing failure cannot leave it live in memory.

  Twelfth review round — four findings, one high, and one of them a defect this branch had already fixed once:

  - **A process with no stoppers no longer signs the register as one.** Acknowledging means "I stopped my work", and any surface that wired the halt store was writing that row whether or not it ran unattended work. The interactive terminal wires the store and registers nothing to stop, so typing the stop command there answered "This runtime has stopped all unattended execution" while the goal daemon kept firing, and the status command counted that row as a process that had stopped. One acknowledgement standing in for the executor that actually matters is the failure the per-executor model exists to prevent, arriving through a different door. Silence is both the honest reading and the safe one: the halt is in force from the instant it is written, because enforcement never depended on acknowledgement.
  - **A reason that begins with the word "goal" is a reason.** The phone had gained a `goal <id> <reason>` grammar — the same grammar this branch's first review round removed from the command line, reintroduced on the one surface that is the consent root, where it is worse: an unmatched scope is refused by the store, so a person asking for a stop gets silence. Scope now travels in an explicit `--goal` marker, which a reason never begins with.
  - **A send that fails on a dead socket reports as undelivered, not as a relay fault.** Every send throwing is the ordinary case moments after a daemon dies, and it was surfacing to the phone as a bare server error for a halt that demonstrably did not land.
  - The halt read guarding idle consolidation is wrapped, so a locked database cannot take down the one process whose staying up is the point.

  Thirteenth review round — seven findings, none high:

  - **The success summary reports what this runtime stopped, never what was asked.** Both the goal daemon and the worker announce the unattended-runtime capability and share a device id, so the relay may deliver a motebit-wide halt to either. Landing on the worker, whose stopper only declines further dispatched tasks, the summary said "This runtime has stopped all unattended execution" while the goal daemon had not acknowledged and kept firing until its next tick. The ask rendered as the stop, one last time.
  - **An ambiguous resume prefix is refused rather than resolved arbitrarily.** Repeated halts each write a row, so several active halts sharing a short prefix is ordinary, and lifting whichever came first while reporting success gives back permission nobody named. The command line also reads the lift's result instead of printing "Resumed" regardless.
  - **An empty `device_id` on the wire counts as undeclared.** Otherwise every such peer would share one id and the machine-grouping would read unrelated machines as one.
  - The shutdown path's halt read is guarded, so a locked database cannot skip the socket close, the database close and the private-key erase that follow it.
  - The dispatch path logs both its halt-read and honoring failures. It runs inside a handler that swallows exceptions, so an unlogged throw there dropped the task with no record — a refusal indistinguishable from never having arrived.
  - A surface with no approval queue at all is told that, rather than that its queue is read-only.

  Fourteenth review round — three findings, none high:

  - **An ambiguous approval prefix is refused, and nothing is decided.** Pending approvals list oldest-first, so resolving to the first match meant `/approve 1` approved whichever queued call happened to be oldest among those starting with "1" — possibly a money action nobody named — and then confirmed it by tool name as though it were the one asked for. Resuming already refused an ambiguous halt prefix; deciding an approval is the more consequential of the two and was the one without the guard.
  - **Acknowledged is not stopped, and the readers no longer say it is.** A process acknowledging says it answered for itself, not that it had work to stop: the worker answers a goal-scoped halt with "nothing here runs under that goal — dispatched tasks continue", which is true and is not the goal having stopped. Counted under the word "stopped" it read as one, while the goal kept firing under the daemon. The status readers now count processes that acknowledged and print what each one stopped underneath.
  - The phone validates the shape of a command response instead of trusting it, so a runtime that does not recognise a verb produces an honest message rather than a raw type error.

  Fifteenth review round — five findings, none high:

  - **A remote halt reaches a runtime again when the two run on different machines.** The many-machines refusal is about QUEUES, and it belongs to `approvals` alone. A halt delivered to either machine is truthful — the acknowledgement is per executor and names what that executor stopped — and the halt is durable state the other machine honors on its own next tick. Applying the refusal to `halt` told a sovereign running the daemon on a laptop and the worker on a server to "run this command on the machine you mean", which is unusable advice for someone away from both. That is the situation this whole arc is for, so the guard was breaking the feature to protect a different one.
  - **`resume all` means the same thing on every surface.** The terminal compared case-sensitively and the phone did not, so `resume All` lifted every halt from one and exited with an error from the other, under one documented grammar.
  - **A halt whose audit event cannot be written says so.** The terminal is the only producer of the requested and lifted events on the local path, so a failing append left a history with stops in it and no record of who asked or who gave the permission back. It was silent about that; the runtime's twin already warned.
  - **A refused halt reads as a sentence, not a stack trace.** The store refuses a scope that cannot match, and that throw escaped as a fatal error on the one command where a person most needs a plain answer about whether anything stopped.
  - The daemon's two capability lists agree about what the process is.

  **Named, not built:** the replay guard is wired at the command-line's own two handlers rather than at the verification seam, so the four other surfaces that answer `command_request` inherit nothing. Nothing mutating is reachable through them today — the relay routes the stop verbs away from them, and their approval stores implement only the narrow quorum port, so a decision reaching one answers "read-only" — but the next mutating verb would inherit that gap rather than the guard. Pairing the guard with envelope verification is its own increment, and it is the one this arc hands forward.

- f8dd5b3: The machine roster's two artifacts and the reduction over them: `HostEnrollment`, `HostRetirement`, `verifyHostRoster`.

  "Every machine" is a statement about a set, and until now nothing owned the set — a relay inferred a motebit's machines from whichever sockets were live, so an offline machine was simply not a machine, and two attempts to make a verb reach every machine (#681, #687) were withdrawn for reporting against a set they had guessed. Membership is now something the sovereign signs and a relay only transports. Doctrine: `docs/doctrine/machine-roster.md`. Spec: `spec/machine-roster-v1.md` (`motebit/machine-roster@1.0`, the thirty-fifth).

  `@motebit/protocol`: the two wire types, `HOST_ROSTER_SPEC_ID`, the domain tags `HOST_ENROLLMENT_TYPE` / `HOST_RETIREMENT_TYPE`, and the shape guards `isHostEnrollment` / `isHostRetirement`.

  `@motebit/crypto`: `signHostEnrollment` / `verifyHostEnrollment`, `signHostRetirement` / `verifyHostRetirement`, `hostEnrollmentId` / `hostRetirementId`, `verifyHostRoster`. Still verifies standalone: the import from `@motebit/protocol` is type-only and the shape checks are restated locally, pinned to protocol's by a parity table.

  **The law**

  - **A set, not a chain.** Every machine of a motebit holds the same key and nothing coordinates them, so concurrent writers are the normal case. A 2P-set per entry, an observed-remove set per machine, merged by union.
  - **An entry's id is the SHA-256 of its signed body — never the whole artifact.** A signature's spelling is the one part of an artifact nothing signs. The first draft hashed it, and review showed with a probe that anyone holding a copy, with no key, could re-spell a _retired_ enrolment into a new id that still verified.
  - **The unit is the machine, not the entry.** A machine is `active` while any enrolment at its highest epoch stands, and the verdict lists exactly those, so a surface can retire all of them.
  - **A signed domain tag, and a frozen body.** Without `type`, this and a device self-registration are one suite over the same fields but one name. The body is frozen for major 1 — an id is a hash of it and validators are strict, so an added field would silently drop a producer's machines from every existing consumer's roster. Evolution is by new artifact types that reference an enrolment by id.
  - **As strict as the wire schema, even for authentic bytes** — exact keys, the literal suite and tag, lowercase hex, unix ms as an integer in [0, 2^53 − 1] and never `-0`, and a signature in its **one** canonical spelling: 86 characters of unpadded base64url whose last is `A`, `Q`, `g` or `w`. (Eighty-six characters carry four bits more than a signature has; the full alphabet in that last position gave every signature sixteen spellings that all verified.)
  - **An unusable question is refused, never answered with an empty roster.** An empty or non-string `motebit_id`, a missing set, an empty chain, a malformed or repeated key: `{ ok: false, reason }`. "A halt reached every machine" over zero machines is vacuously true, and a throw is something a caller catches and defaults.

  **Rotation — the part that failed review twice, and why it is different now**

  The first draft took two _unordered_ sets of keys, "trusted" and "superseded". Round one: rotating un-retired everything. Round two: a _second_ rotation un-retired a machine. Both were patched as special cases, and the second patch is what made it obvious the model was wrong: a key history is an **ordered chain**, and a verdict that depends on where "today" cuts it is not a verdict about the machine. The reduction now takes `keyChain`, oldest → newest, and two rules replace the special cases:

  - **Rule A — authority flows forward only.** A retirement ends an enrolment iff it was signed at the same epoch or a later one. A stolen old key can never strike a current machine, _and_ a retirement signed before a rotation keeps ending what it ended.
  - **Rule B — a machine's status is a function of its highest-epoch enrolments only.** So the verdict is monotone under rotation: appending a key can turn `active` into `superseded`, and nothing else.

  That design was reviewed adversarially _before_ it was coded, which the first draft's was not. The review found the two rules sound and seven problems around them, all taken: an empty or repeated-key chain now yields **no roster** rather than an empty one ("a halt reached every machine" over zero machines is vacuously true); the verdict carries the **chain head** it was computed under, because a consumer with a stale chain computes a confident wrong roster and nothing can make that fail-safe, only attributable; and each machine carries `authenticated` — **only a status at the current epoch is**. Below it, a holder of an old key can flip `superseded` ↔ `retired` and mint ghost lines, because there is no trusted clock; what it can never do is touch an `active` line, and quantified statements run over those. The spec says so rather than promising a durability it does not have.

  **Nothing a party with no key can add changes the outcome.** Code review of the rebuild found the one place this was false, and it was self-inflicted: a cap of eight signature spellings tried per entry, in sorted order — added to bound a flood — let anyone serve eight garbage copies that sort ahead of a real _retirement_. A consumer unioning that store with an honest one never reached the good copy, and the machine was active again. Withholding cannot do that under union; flooding could. The cap is gone (the spec forbids one), every well-formed copy is tried, a copy that is not well-formed can never displace one that is (`{...e, device_name: undefined}` canonicalizes to the same id _and_ signature), and the spec now requires a store to verify an entry before holding it, so a junk-signature copy cannot squat an id slot. `tombstones` lists only _pending_ ones — a retirement Rule A ignores is not a machine being retired — and `-0` is refused as a time, because it canonicalizes to `0`.

  **A signer refuses to mint what no verifier will accept.** `signHostEnrollment` / `signHostRetirement` build the body field by field — never a spread of the caller's object — check it against the shape guard, and check that `public_key` is the key doing the signing; otherwise they throw. The natural way to re-enrol under a new key is `{ ...oldEnrolment, public_key }`, TypeScript does not excess-check a spread, and the old `signature` rode along _inside the body being signed_: an artifact that signed fine and verified nowhere. A daemon caches and re-presents what it minted, so that is a machine silently absent from "every machine", for good.

  **A repeated key has no roster.** `[A, B, A]` verifies as a succession today. First-index strands the current key in the past; last-index makes `B`'s retirements of `A`-era enrolments stop applying, so rotating _back_ would un-retire machines. With no trusted clock neither reading is sound, so the reduction refuses (`duplicate_key`) and the spec says why; forbidding the rotation is the identity layer's job.

  **How it is tested.** The first draft passed sixteen example tests while wrong in seven ways, so the universal claims are now eleven **property tests** over an authentically signed pool spanning a four-key chain and a stranger — partition, whole-result order/multiplicity invariance, monotonicity under rotation, no backward authority, re-spelling invariance, monotonicity under union, suffix invariance of the active set, relative-order-only, unusable-chain refusal, and — added after review, because every other property drew only from authentically signed input — that no keyless addition (garbage-signature floods, not-well-formed twins, junk) moves any machine. Both of the first draft's real rotation bugs, re-introduced, turn them red. The draws are bounded (at most 8 enrolments and 12 retirements each): every admitted entry costs a signature verification, and unbounded draws made the suite 44 seconds locally and a timeout in CI under coverage. Bounded, it runs in 5 — and the same tampers still turn it red, which was re-checked rather than assumed. Every defect either review found is also a named scenario. Thirty-four rules were tamper-checked; four tests did not bite at first and were fixed — three because they _edited_ a signed artifact, so the signature broke before the rule under test was reached.

- 578cf94: `AgentTrustRecord.capability_stats` buckets gain an optional `paid_failure_penalty` — extra integer pseudo-failures the runtime records when a PAID hire fails, scaled by what was paid (`paidFailureWeight`: 1 for free, 2 at $0.003, capped at 5 by $0.04) so the first-person reliability posterior weighs a paid failure more than a free one. This is the trust-graph recourse `docs/doctrine/paid-failure-recourse.md` named in place of escrow, made real in the ledger the ranker reads. Local-only like the rest of the map; never on the wire. Additive and optional: existing records read unchanged.
- 337bff7: Documents the exact meaning of `routing_choice.routing_paths` and `alternatives_considered` on `DelegatedStepResult` and the execution-ledger step summary: `routing_paths[0]` is the PLANNED EXECUTION route — the hops the task takes from the caller to the worker (`[worker]` for a direct hire, `[peer_relay, worker]` for a federated one) — whose composed execution metrics `sub_scores` reflects; further entries are the non-dominated planned-route alternatives the policy weighed, best first. Adds the optional `trust_evidence_path?: string[]` — the vouching chain through every edge (recorded delegations included) behind `sub_scores.trust`, which may differ from the planned execution route. Every entry is a path that exists; a per-dimension optimum no single path attains is never reported. Neither path is a record of who executed the task (that is what receipts prove). Pinned hires report `[[worker]]` with `alternatives_considered: 0`. Types are unchanged; this pins the semantics that `motebit/execution-ledger@1.0` §4.1.1 and `motebit/delegation@1.0` §3.2 now state, matching the path-preserving ranking shipped in the reference relay.
- 62d9069: Evidence on return — increment 3 of unattended execution.

  Increments 1 and 2 answered "keep working when I leave" and "stop when I withdraw it". This one answers the last clause: **show me evidence when I return.** The distinction it turns on is between what a motebit says it did and what a stranger could check without trusting it.

  **A shipped claim was false, and its gate was green because it never looked.** `check-goal-artifact-signing` enumerated three surfaces — web, desktop, mobile — and the daemon was in neither its registry nor its allowlist. So for four months it printed that every registered goal-runner signs, which was true only of the three it registered, while the one surface that fires goals with nobody watching signed nothing, kept a 500-character summary, and discarded the artifact it had just produced. The doctrine memo said phase 3 shipped "across all surfaces"; all surfaces meant the three that were looked at. A scanning gate cannot go red about a file it never opens, so the fix is to widen the scan, never to disclose a narrower number — the gate now names four surfaces and states its aperture in its own header, and the drift-defenses row that recorded a path which does not exist is corrected too.

  **The daemon signs, and keeps the whole result.** Migration #47 brings `response_full` and `signed_manifest` to the shared schema, which desktop and mobile had added in their own per-surface registries and the shared one never did. An unsigned result is still recorded, and recorded as unsigned: `signGoalArtifact` returns nothing when no identity is loaded, and that stays nothing, because a placeholder signature is a lie with a checksum.

  **Run evidence is the sibling artifact the completion row already named.** `PolicyGate.recordResult`'s contract says plainly what the tool's verdict is not — "attribution + the tool's report, not an independent verification of the external effect — a claimed result should link to evidence from the affected system; that pointer is a sibling artifact, never inferred from this row." This is that artifact. `RunEvidenceEntry` and `RunEvidenceSink` join the protocol, the gate mints a pointer beside the completion row, and migration #47 keeps them.

  The pointer is minted **at the fetch, from the tool's own content-addressed bytes**, and never by a model summarizing afterwards. The span is the text the tool returned, which `ToolResult.source_digest`'s own contract guarantees is either a verbatim span of the raw bytes or the output of the named byte-deterministic recipe over them — so it is a substring of `projection(bytes)` by construction, which is exactly the law `verifyEvidenceProvenance` applies. A span nobody retrieved cannot enter the record, because the only writer is the retrieval. Tools that did not content-address anything produce no pointer: absence is honest, and a pointer the producer cannot back is worse than none.

  Spans are bounded at the producer. A prefix of a substring is still a substring, so the re-check law is unaffected, and a pointer never quietly becomes a copy of the retrieved document under a retention policy it never entered.

  **`motebit runs show <run_id>`** is the return view, and its three sections carry deliberately different weights of proof. The result is what the motebit produced, signed or else its own word. The tool calls are attribution plus each tool's verdict, never proof of an outside effect. The evidence is the only part a third party can re-check. An empty evidence section says "none recorded", and says in as many words that this is not the same as nothing having been read.

  Proven rather than asserted: a pointer this producer writes is round-tripped through the real `verifyEvidenceProvenance` over the real bytes — it passes, tampered bytes fail on the digest, a fabricated span fails as absent, and a recipe span fails closed as unresolved until the recipe is injected.

  **Not in this increment, and named rather than half-built:** nothing re-verifies evidence automatically on the way in — the pointers are for a person or a stranger to re-check, and motebit injects no projection resolver in production, so a recipe-path span is re-checkable by a party who wires the recipe themselves. Making the daemon re-verify its own evidence before presenting it is a separate increment with a separate honesty question, since a verifier that trusts its own producer proves nothing.

  Review round — nine findings, one of them the composition class this repo names:

  - **The evidence sink survived exactly until a policy setting changed.** It was wired once at construction, and changing any policy setting builds a whole new gate — so from that moment the runtime recorded nothing, silently, and every run afterwards reported "none recorded". That is the one reading this record must never have: a loss indistinguishable from an honest absence. The sink is a constructor parameter now, and the runtime holds it so the swap carries it.
  - **Credential-class content means no pointer, not a redacted one.** The sibling audit row redacts its arguments; this row carries verbatim retrieved text, which the return view prints. Redacting the span would be worse than either option, because the law is that the span is an exact substring of the bytes — a redacted span is a pointer asserting something that fails re-verification. Neither is recorded instead. The guard uses the credential-class filter, not the full redaction set.
  - **Evidence now dies with the audit row it sits beside.** The retention flush erased the audit row and left the more revealing sibling behind forever, which inverts the policy it was enforcing. They go together, under the same deletion certificate. This is also the only path that reaches rows written outside a goal run, which the run-scoped reader can never return.
  - **A run that paused for a human's yes wrote no result at all.** Signing went into one of the completion paths; the approval-resume path wrote no outcome row, so an approved run produced nothing to read and nothing signed — and the signing gate stayed green because it matches the call once per file. That is the same aperture blindness this increment was written to correct, reproduced inside the fix for it. There is one writer now, so a third path inherits signing rather than having to remember it.
  - **The pointer names what was read.** It carried the call id, so the return view said "re-fetch the source" while naming no source. The producing tool names it, because only the tool knows — a consumer guessing from an argument key would be putting domain knowledge in the layer that must not have it. The assurance rung travels the same way, and stays absent unless the tool declares it, so the strong rung is never claimed on behalf of a recipe that only meets the weaker one.
  - The outcome and the run are both fetched by id rather than scanned in a window. A goal on a short cadence pushed its own outcome out of the window within hours, after which the return view confidently reported that a signed result did not exist.
  - The deterministic-affordance path records evidence too, so what a run can prove no longer depends on whether a person or the model started the call.

  Second review round — nine findings, and one of them corrects a claim made above:

  - **I measured the redaction guard the wrong way round.** The first version used the full redaction set and I reported it as clean on realistic content. The inputs I happened to test avoided all three of its low-precision patterns. A commit hash is forty hexadecimal characters and trips the encoded-secret rule immediately, as does any bare nine-digit reference number — so a page whose opening lines carried either recorded no pointer and the owner was told "none recorded". The pattern table marks those three as unsuitable for exactly this reason. It now uses the credential-class subset the table defines, and the guard was narrowed twice more after that, each time against measured counter-examples.
  - **Unclassified content was the one record kept forever.** A tool call's retention floor comes from its sensitivity, nothing classifies tool calls today, so every one reads as the lowest tier — which is never delete. Inheriting that made verbatim retrieved third-party content the single thing this motebit would keep indefinitely, which is the inverse of what not knowing its contents should mean. Evidence now has a horizon of its own, set to the strictest finite tier.
  - **A refusal was being recorded as completed, signed work.** The shared writer was called unconditionally on the approval-resume path, so a run whose action a human denied landed in the outcome table as completed — and those rows are read back into the next run's prompt, which would have taught the agent that refused work was finished work.
  - Evidence is minted on all three paths that close the tool ledger, so what a run can prove no longer depends on whether a human had to approve it first.
  - The span is cut at a character boundary. A cut through an astral character left a lone surrogate, which storage turns into a replacement character, so the span read back would not be the span written and the pointer would fail its own law.
  - The resume-failure outcome is keyed by its run like every other, so the return view can find it; the view also renders the outcome's status and reason, and no longer tells a run halted today that it predates a feature which shipped with it.
  - The insert is plain rather than ignore-on-conflict, which bought no deduplication and would have swallowed a constraint violation into a silently missing row. The sibling erase has its own guard, so a secondary failure cannot be reported as the primary one failing.

  Third review round — ten findings, most of them consequences of the second round's own fixes:

  - **A secondary record could take down the work it describes.** The store raises on a bad write by design, but the evidence write ran unguarded and, on one path, before the completion row — so a locked database while writing a POINTER left the execution ledger open, which the next start reads as an interrupted run with side effects and holds the goal behind a human. Every evidence write now happens after its ledger row and inside a guard.
  - **The certificate named the wrong thing.** The horizon sweep signed a deletion certificate saying a tool-audit record had been flushed, and then erased only the evidence. Under this repo's own doctrine a certificate is the proof of deletion, so that is a false signed claim rather than a label slip. The vocabulary gains the target it actually deletes.
  - **A third path reached completion with no outcome at all.** An approval that expired continues the turn and closes the run, and wrote nothing — so a run that produced work reported none, with nothing signed. That is the same aperture blindness this increment set out to correct, found a second time inside the increment itself.
  - **Outcomes link to their run by a field now, not by an id convention.** The live paths key the outcome by the run id while the recovery paths mint a fresh one on purpose, so a reader could only find half the outcomes from a run — and the return view confidently reported no outcome for exactly the interrupted and recovered runs it exists to explain. Both conventions are right; a column serves both.
  - **The return view prints the source and the whole digest.** It said "re-fetch the source and check the span" while showing an abbreviated digest and no source, which made the affordance unusable from the only reader that ships.
  - **A credential in a URL is caught by its own rule.** The shared credential patterns key on a value's shape, and an opaque query parameter has none: `api_key=`, `token=`, `access_token=` and `sig=` all passed untouched and were stored for the retention horizon. In a URL the parameter name is the strong signal, which makes a name-keyed rule precise where a value rule cannot be.
  - Nothing to sign is not something to sign: an empty result produced a signature over zero bytes that the return view rendered as a signed result.
  - The horizon's stated reason is corrected. It is the medical and financial tier, which is not the strictest finite one, and the choice is deliberate rather than maximal.

  Fourth review round — seven findings, the two sharpest being defects introduced by the third round's own fix:

  - **A run awaiting a second approval was being recorded as completed.** The expired-approval continuation I added closed its run unconditionally, but a denied continuation can make another approval-gated call, and then the stream comes back suspended with a fresh decision already queued. The run vanished from the list of runs holding their goal, and its outcome claimed the action had not run while a second one waited. It mirrors the sibling path's guard now.
  - **And when that continuation threw, nothing closed the run.** The drain it replaced never rejected, so the close always ran; consuming for a result can throw, and logging alone left the run open with its suspended entry already gone. Nothing would have closed it until a restart reclassified it and asked a human to acknowledge it.
  - **The evidence horizon now respects a retention obligation.** The audit flush deliberately holds a call inside a settlement or dispute window past its sensitivity ceiling, and a flat horizon destroyed the re-checkable evidence for exactly those calls while the audit row beside them was being kept on purpose — the one case where re-checking matters most.
  - **The re-check instruction matches the pointer.** A projection-bearing span lives in the recipe's output, not in the raw bytes, so a reader following "hash the bytes and check the span is present" would get absent on a valid pointer and conclude the span was invented. That is the exact wrong conclusion for this command to cause.
  - The signed line no longer names a command the reader cannot run from what is on screen.
  - The evidence store raises on an entry with no provenance rather than dropping it, which is what its own comment says it chose a plain insert to avoid.
  - The advisory locator is gone. A tool-agnostic gate cannot know where a tool's excerpt begins in the projected text, and an absent advisory field costs a re-verifier nothing while a wrong one sends them to the wrong place.

  Fifth review round — six findings, one of which is that a previous fix in this same changeset was cosmetic:

  - **The false signed claim was not fixed, only relabelled.** The previous round set the certificate's target kind and called it corrected. That field reaches only the local audit row; the signed certificate carries a target id, a sensitivity, a reason and two timestamps, and no kind at all. So the signed attestation still said only that the record with that call id had been flushed while the audit row for the same call was still present, and a second, indistinguishable certificate followed when that row aged out. The identifier itself now names the record, which is the only place the signed artifact has to say it.
  - **The credential guard was still borrowing patterns meant for a person's own typing.** Two of them key on an English word rather than on a secret's shape, so a documentation page printing an example connection string, or a help page reading "Password: required", cost the owner the evidence for that fetch and reported that nothing had been retrieved. The pattern table gains an explicit axis for this, because the property that matters is whether a pattern still holds when the surrounding words belong to a stranger.
  - **A signature was covering a fragment while being presented as the whole.** A resumed turn's stream carries only the continuation, so for every approval-gated run the stored result, the signed manifest over it, and the summary the next run reads all covered the part after the pause. The text from before the pause is carried across the pause now.
  - **An evidence-write failure on the main path went nowhere at all.** It was absorbed so a pointer could not take down the work it describes, which is right, but absorbed without any report is the silence this vocabulary forbids. The failure is reported before it is absorbed.
  - The obligation guard added last round is inert, because nothing supplies the resolver it reads. It is kept as the shape the obligation will arrive into, and said to be inert rather than left reading like a protection in force; its scan is bounded the way its sibling already was.
  - The expired-approval continuation sets the run context, so a goal tool called from it no longer fails closed while the run is recorded as having reached an outcome.

  The evidence store, its horizon, and what a pointer round-trips to now have direct test coverage.

  Sixth review round — five findings, and the credential guard needed narrowing a third time:

  - **Two of the patterns I marked as shape-keyed are not.** The idea was right: a pattern is safe over a stranger's page only if it identifies a secret by its own shape rather than by an English word near it. My assignment was wrong. Twelve short lowercase words is a statistical shape that ordinary prose has, so a sentence matched a seed phrase. The key rule matches any long word beginning with "key", "api" or "secret", so a URL path segment matched. And the bearer rule's shape is the word "Bearer", which a sentence about bearer bonds has. All three are demoted, and a tightened vendor-key pattern replaces the coverage they were carrying — it keys on the mandatory punctuation separator that real key formats have and words do not, which also closes the residual this changeset recorded two rounds ago. Eight benign samples and seven real credentials are pinned as a test corpus, because a guard whose response is to record nothing costs an owner their evidence every time it is wrong.
  - **The primary failure path could still destroy a signed artifact.** The resume path was fixed for this and the main one was left behind: its catch wraps the successful path too, several statements can throw after the result is written, and a row keyed by the run would then replace it. The signed manifest would have been deleted by its own error handler.
  - **The pre-pause text still went missing in two places.** A turn that pauses a second time recorded only its second segment, and plan mode never recorded any, so the signature covered everything except the beginning. Both carry it now.
  - **The run context is restored rather than cleared.** The expired-approval continuation nulled it from a detached promise, which could strip a later, genuinely live run of the context that a stop uses to abort it.
  - **The evidence store is registered in the retention manifest.** It holds the most revealing thing a motebit keeps and was absent from the registry the coverage gate iterates, so the gate could not go red about it — omission there is invisible by construction. Registering it immediately failed the gate for a missing table mapping, which is the gate doing its job.

  **Regression cover for the cluster, rather than for the increment.** Six review rounds found defects in one place — the scheduler's approval paths — and every one was the same family: a record saying more or less than what happened. The existing tests there assert the lifecycle and never read the row it leaves behind, which is why none of them caught any of it. Four cases now pin what a completed run writes down: a denial is recorded as partial and never as completed work, because those rows feed the next run's prompt; the signed artifact spans the text from before the pause as well as the continuation; every outcome carries its run link, so a reader finds all of them rather than the half whose identifier happens to match; and an empty result is not signed. Each was verified to go red when the behaviour is reverted.

  Seventh review round — eight findings, three of which are that an earlier fix in this changeset was wrong:

  - **The run-context fix was both ineffective and harmful, so it is gone rather than corrected again.** The reason given for setting it was that the goal tools fail closed without it. They do, but this runs in the approval phase and those tools are registered in the goal phase after it, so they were not registered at all — the change bought nothing. It cost something: the continuation is fire-and-forget, so its cleanup lands at an arbitrary later moment, by which time a real run may hold that context, and writing anything back strips a live run of what a stop uses to abort it. Two versions were wrong in opposite directions; the third is not to write.
  - **Preserving a record and then not showing it is the same outcome as losing it.** A run can leave more than one row, and the failure row was given a distinct identifier precisely so it could not overwrite the signed result. The return view then took the newest and hid the result behind the failure, printing "not signed" while the manifest sat in a sibling row no reader could reach. It shows every outcome the run produced.
  - **The declared retention shape promised a motion the code does not make.** Registering the store as an append-only horizon sounded right, because its rows are never rewritten, but that shape commits a store to whole-prefix truncation under signed horizon certificates, and this one deletes scattered rows under flush certificates. A published manifest would have claimed something untrue in the same way a certificate naming the wrong record does. It is declared as what it does, with the classification column that shape requires.
  - **The two erase paths disagreed about what identifies an evidence row.** One named it explicitly and the other destroyed it under the audit row's certificate, so a record this codebase identifies one way was deleted with nothing attesting to it.
  - The credential rule reads the fragment and the userinfo, not only the query string. An implicit-grant callback and a URL with a password in it both walked past a guard whose stated purpose is that a credential in a reference is never stored, which is the mistake this guard had already made once.
  - The counters rejoin across a pause like the text did. An outcome built from the continuation alone reported the tool calls made after the pause and dropped the ones before it.
  - The evidence logger arrives with the sink rather than after it, so a gate that has somewhere to write and nowhere to report is not the easy thing to build.

  **The injection inside scope, finally run.** The arc has named this adversarial case since its first session and never executed it. It is the hard one because nothing in the permission model refuses it: the motebit was asked to read the mail, so fetching is correct; the injected instruction asks for a capability it already holds, so no boundary is crossed; and the text arrives with nothing marking it apart from the owner's own words. What stands between that and a sent email is the risk tier, which makes the approval the last line and makes what it shows load-bearing. The probe asserts the two things that actually protect an owner and nothing about detection, because a system whose safety depends on the model never being fooled has no safety: the call does not execute unattended and the goal does not roll on while a human owes it an answer; the row a human reads names the real destination, with the full arguments kept so a truncated preview stays checkable; expiry closes the door rather than drifting to execution; and a denial is final. Laundering the address out of the preview turns it red.

  Eighth review round — five findings, the first of them the same defect twice over:

  - **A deletion certificate is signed only when something is deleted.** The audit-path erase was gated on the sink existing rather than on there being anything to erase, so every tool call that aged out signed a certificate naming an evidence record — and most tool calls never content-address anything, so most had none. Worse, the two sweeps run on different clocks, so a call that did produce evidence collected a second identical certificate long after the first had already deleted it. That is the two-signed-claims-for-one-identifier defect this changeset records closing two rounds ago, reintroduced by splitting the horizons. Asking before signing is the whole fix.
  - The counters rejoin across a pause in plan mode too. Fixing only one of the two streams left the same tail-presented-as-whole defect in the numbers a person reads and the next run inherits.
  - **The per-run tool-call ceiling counts the calls carried across pauses.** It compared only the current stream's counter, so the budget reset at every approval and a goal that paused five times could make far more calls than the guard's stated limit.
  - The signature line is printed only for rows that could carry one. An approval pause writes its own row, so an approval-gated run rendered its real result as signed and then, under the same heading, the pause row as not signed — two verdicts for one run, from the command whose job is that a reader cannot misread the record.
  - The return view is discoverable. It was reachable only by someone who had read the pull request: the help text and the documentation table still listed the old subcommands, and no gate checks that direction.

  **The arc's sentence, walked from a run id.** Three increments each shipped one clause of "can it keep working when I leave, reach me when it needs authority, stop when I withdraw it, and show me evidence when I return", and each was found by review to claim more than it delivered. Every one of those defects lived in the seam between clauses rather than inside one: a stop that reported stopping, a signature covering a fragment, a record preserved and then not shown. A test that asserts a single clause cannot see any of that, which is why none of them did. This asserts the joins instead, starting from a run identifier and nothing else, because that is all a returning owner has. It reaches the result and whether it is signed, the approval that held the goal, the per-process acknowledgements of a stop, and a pointer that the real verification law accepts against the original bytes and refuses against a different record. It does not claim to prove the production wiring between the gate and the evidence store, which has its own coverage; the two halves meet at the identifier, which is where a returning owner meets them.

  Ninth review round — five findings, and the credential guard needed narrowing a fourth time:

  - **A credential hides in more places than a query parameter.** The rule anchored the parameter name to the separator, so every vendor-prefixed form escaped: measured, a presigned link's signature and its Google equivalent both walked past, and a key sitting in the path rather than the query escaped entirely. Each of the four gaps was somewhere I had not looked rather than a rule that was wrong, which is its own lesson about guards written from imagination instead of from examples. The name is matched anywhere within the parameter, the shape filter runs over the reference as well as the span, and nine cases are pinned in both directions.
  - **An optional method failing open kept content forever.** The count used to decide whether anything needs erasing treated an unimplemented method as "nothing there", so a sink that could erase but not count would have kept verbatim third-party content indefinitely while its audit row was flushed. Unknown now means erase; what is withheld is the certificate, because that is the thing that must not be signed for a record nobody could confirm.
  - The instruction names the encoding convention rather than leaving a stranger to discover it. The digest covers the decoded text, so a source served in another encoding will not match byte for byte.
  - Evidence flushes are counted like their siblings, so a cycle that signed certificates and deleted rows no longer reports having done nothing.

  **Named, not built: the run result has no retention shape.** The full result text is now stored where a 500-character summary used to be, and the outcome table is registered nowhere, so the model's own quotation of a page is kept indefinitely while a 512-character span of that same page expires on a horizon. The asymmetry is real. It is not simply an oversight to close, because that text is the artifact the signature is over, and expiring it leaves a manifest whose subject is gone — the verifiability this increment delivers would be the thing deleted. Registering the outcome store, and deciding what a signed artifact's retention means, is its own increment rather than a line in this one.

  **A withheld pointer is a record, not an absence.** The guard that declines to store credential-class content had the same flaw as the thing this whole vocabulary exists to remove. When it fired, the pointer simply vanished, so the return view said "none recorded" — which is exactly what it says when a tool retrieved nothing at all. Two opposite facts collapsed into one sentence, produced by the guard whose entire justification is that absences must not be ambiguous.

  It now writes what it declined and why. The row carries no digest, no span and no source, because keeping any of those would defeat the withholding and the source is itself one of the places a credential hides; it says only that something was read and deliberately not kept. That separates the two absences, and it makes a guard firing where it should not observable rather than invisible — which, after four corrections that a reviewer found and I did not, is the part that matters. The refusal ages out on the same horizon as a pointer and dies with the same call, so recording refusals cannot become its own quiet accumulation. The reason is a closed vocabulary with the usual iteration array and type guard, covered by its own test.

  Tenth review round — eight findings, and two of them were leaks rather than tidiness:

  - **The credential guard judged the part it would store, not the part it read.** It ran on the already-bounded span, so a secret whose pattern needs bytes past the cut could never match. A key block needs its opening and closing delimiters about 1.7 kilobytes apart, so an endpoint serving one had several hundred characters of it stored verbatim, printed on return, and kept for the retention horizon — past the guard whose entire purpose is that such content is never kept. The span is what gets stored; the result is what gets judged.
  - **One command could print another identity's content.** The indexed run lookup was not scoped to this motebit while the listing beside it was, and this is the first command that prints verbatim result text, tool rows and evidence spans. Against a database holding another identity's runs, a full identifier would have printed their content while the listing showed nothing.
  - **A pattern keyed on an English word was marked as keyed on shape.** That is the fourth time I have made the same misjudgement in this table. An API documentation page printing a token next to an example digest would have cost the owner that fetch's evidence and told them a credential was there.
  - **The evidence flush counter still reported nothing.** It was computed and returned one round ago and never reached the summary, so a cycle erasing hundreds of rows and signing hundreds of certificates still looked like a cycle that did nothing — the same silence the counter was added to end, one layer further out.
  - A module-level mutable predicate, reassigned on every call and shared across every gate, is now passed as an argument. It was correct only because the assignment sat one line above the use.
  - Five documentation blocks had drifted onto the wrong symbols, including the central type of this increment, which was shipping undocumented on the public interface. A stale note claiming a gap that this same change had already closed is corrected, and a paragraph duplicated onto the wrong guard is removed.

  Eleventh review round — five findings, none high, all closed before merge:

  - **The assurance class now reaches the signed receipt.** It travelled on the locally-kept pointer and stopped there, and absence of that class means the strong rung — so the artifact a stranger verifies would have claimed more than the one kept at home, for the same call. Latent, since nothing declares the weaker rung yet, but it is exactly the sibling boundary this repo's own rule says to audit in the same pass. Threaded through the tool result, the service, the receipt builder, the wire schema and the committed JSON Schema.
  - The evidence flush counts only rows confirmed to exist. A sink that cannot count is erased anyway, and counting there reported a flush for every audit row when none existed — a counter added to stop this cycle misreporting itself, misreporting itself.
  - The pause row carries the counts from before the pause, like the completion row already did.
  - The return view shows the union of a run's outcomes rather than one source or the other, so a legacy row written before the run link existed is not hidden behind a recovery row.
  - The horizon sweep has an index on the column it selects. It was a full scan bounded only by the horizon, which degrades quietly rather than failing — the kind of cost that never gets found.

- 2db131e: `ToolDefinition.slabProjection` gains `"band"`: the tool's act is narrated in the slab's chrome band and never opens a body item (for tools whose result is text the reply already carries). Additive to the closed union; `"none"` and `"tool_call"` unchanged. The runtime's tool policy applies `band` by default for search, file reads, and unknown tools (`docs/doctrine/motebit-computer.md` §"Not on the slab").
- 1d0f3ec: Task admission — priced work enters through the relay's gate (`docs/doctrine/task-admission.md`).

  `@motebit/protocol`: new `TokenAudience` registry entry `task:dispatch` (`TASK_DISPATCH_AUDIENCE`) — the relay-signed per-task admission artifact a worker requires before running `motebit_task` (`mid` = worker, `sub` = relay task id). Registry append; no wire-format change to existing audiences.

  `@motebit/crypto`: `SignedTokenPayload` and `MintAudienceTokenInput` gain optional, audience-specific `sub` (JWT subject) and `digest` (hex SHA-256 of the subject's content) claims, carried under the signature and omitted when absent. Additive — every existing audience is unaffected, and `verifySignedToken` behavior is unchanged.

  Consumers in this repo (private packages, no changeset): `@motebit/mcp-server` `McpServerConfig.taskAdmission` / `ServiceServerConfig.taskAdmission` and the new optional `dispatch_token` argument on `motebit_task` (spec `agent-mcp-surface` §5.1); `@motebit/molecule-runner` exposes `taskAdmission` (code-review and research opt in; the priced-by-default flip is deferred with a recorded trigger and a loud boot warning); the relay attaches the token to every MCP forward and returns it from `POST /agent/:id/task`; the Researcher forwards it to its atoms.

## 3.17.0

### Minor Changes

- 73a099a: `GET /api/v1/identity/:motebitId` is foundation law — its wire shapes move to the permissive floor.

  The identity-transparency endpoint has been `@experimental` since 2026-05-21, gated on the anchored on-chain root cross-check. That blocker closed 2026-05-22 and is continuously live: verified again at promotion time against Solana mainnet, where the relay's `motebit:anchor:v1:<root>:<count>` memo sits in a confirmed transaction and production bundles carry a non-null `anchored`.

  Promotion required moving the wire types out of the relay service, because an external verifier cannot be asked to code against a shape defined inside a BSL service with no pinned surface — the reciprocal obligation named in `docs/doctrine/agency-proof-integration.md` is a pinned API with a semver guarantee.

  New exports, all types (permissive-floor purity preserved — no I/O, no monorepo dependencies):

  - `IdentityBindingBundle` — the endpoint's response: current key, succession chain, and (once anchored) an inclusion proof.
  - `AnchoredInclusion` — inclusion proof plus the anchor transaction and its CAIP-2 network.
  - `IdentityLogProof` — the Merkle proof `verifyIdentityBindingAnchored` consumes; an absent `tree_hash_version` means `merkle-sha256-plain-v1`.
  - `IdentityBinding` — one `motebit_id → current key` leaf of the identity log.

  `KeySuccessionRecord` relocated from `src/index.ts` to `src/identity-binding.ts` to sit with the bundle that carries it. Same name, same shape, same package entry point — no consumer change.

  Additive only; no existing export changed or removed. `spec/identity-v1.md` gains §7.6 (with the wire-format subsection) and a ninth foundation-law route, and the relay's annotation becomes `@spec motebit/identity@1.0`. Changing these shapes is now a wire break.

## 3.16.0

### Minor Changes

- 40d7b6e: `roundSettlementSplitMicro` — conserving (net, fee) rounding for the money path.

  Rounds a settlement's two legs to whole micro-units so they still sum to the
  gross. Rounding each leg with `Math.round` independently breaks conservation on
  every gross ≡ 10 (mod 20) — exactly 5% of integer grosses at a 5% fee rate —
  each one recording a micro of fee the relay never retained into the signed
  `relay_settlements` row that feeds the treasury reconciler's
  `onchain >= recordedFeeSum` invariant. The fee is the rounded leg and the net
  takes the remainder, matching the dust direction of its siblings
  `computeP2pFeeMicro` and `computeFederatedFeeSplit`, so the relay-custody, P2P,
  and federated lanes agree on who absorbs the remainder.

## 3.15.1

### Patch Changes

- 083867e: README fleet audit: correct every published-package README against the shipped bytes.

  Highlights: the CLI README now documents the recovery arc (`motebit restore`, `motebit seed`), the `grant` standing-delegation family, `id`/`wallet`, and the `--sovereign`/`--pay-new-agents` delegate flags; `@motebit/state-export-client` fixes a wrong first parameter on `verifyManifestAgainstBytes` (raw header string, not a parsed manifest); `create-motebit`'s agent quick start adds the required `MOTEBIT_PASSPHRASE`; `@motebit/crypto-appattest` fixes a non-JCS canonical-body example that produced the wrong digest when reproduced; `@motebit/crypto` drops a function removed at 3.0.0 and documents the hardware-attestation leaf family; `@motebit/protocol`'s example now typechecks; false zero-dependency claims corrected (sdk, verifier); `@motebit/verifier` is consistently described as library-only with `@motebit/verify` as the CLI; all relative repo links replaced with absolute URLs that survive npm rendering.

  An adversarial review pass then corrected two overstated scoring claims (android-keystore StrongBox, webauthn attestation_kind — both fields are surfaced but informational today), a wrong flag name (`skills audit --event-type`, also fixed in the CLI's own usage string), and an under-documented `deviceCheckContext` parameter on `verifyHardwareAttestationClaim`.

## 3.15.0

### Minor Changes

- 25d1e71: Add `hexToBytes32(hex): Uint8Array | null` — the single canonical fail-closed decoder for a 64-char hex Ed25519 public key, sibling to `base58Encode`.

  Pure deterministic byte math (no I/O, permissive-floor pure): returns `null` on any non-64-hex input so a caller folds it into a boolean binding predicate without a try/catch. It collapses the ~5-line hex-decode prelude that was duplicated between `@motebit/wallet-solana`'s `isDerivedSettlementBinding` and the rail-agnostic settlement-binding check in `@motebit/runtime` — the two consumers already shared the `base58Encode` codec, so with this the "settlement address = base58 derivation of the identity key" identity-binding invariant has a single implementation rather than a per-package copy that could drift on malformed-input handling.

### Patch Changes

- 84fad0f: Internal cleanup: remove no-op type assertions flagged by typescript-eslint 8.65 (`no-unnecessary-type-assertion`), monorepo-wide. Type-level only — no runtime or API change. Where an assertion was masking a real hazard (`no-base-to-string` on unknown payload fields), the site now narrows with a typeof guard instead.

## 3.14.0

### Minor Changes

- e50d388: Add `CONTEXT_SAFE_SENSITIVITY` — the canonical set of sensitivity tiers whose content may cross to an external inference provider (everything below the medical egress ceiling: `none`, `personal`).

  Derived from `rankSensitivity` so it can never drift from the ceiling, it is the single source of truth for the "medical/financial/secret never reach external AI" filter that both the AI loop (auto-injected memory) and the runtime (the `recall_memories` tool) apply toward external providers, replacing per-site re-listing of `[none, personal]`.

- 8548351: RoutingDecisionTranscript — the routing arc's proof artifact (spec/routing-transcript-v1.md, motebit/routing-transcript@1.0). Additive: protocol gains the RoutingDecisionTranscript and TranscriptCandidate types plus ROUTING_TRANSCRIPT_SPEC_ID; crypto gains signRoutingTranscript / verifyRoutingTranscript (the integrity rung — suite, spec, winner-membership, signature over JCS-canonical bytes, fail-closed typed reasons); the verifier re-exports both plus the types. The faithfulness rung (decision recomputation under the pinned algorithm_version) ships in source-available @motebit/semiring, deliberately outside the permissive floor.

## 3.13.0

### Minor Changes

- e2c06cd: Capability-scoped competence in first-person worker routing — `AgentTrustRecord` gains an optional, local-only `capability_stats` map (`{capability: {successful_tasks, failed_tasks}}`).

  Competence is a skill, not a relationship: being reliable at `web_search` says nothing about `read_url`. The routing reliability posterior now scopes its success/fail counts to the capability being hired (`competenceCounts` in `@motebit/semiring`, `selectWorker(self, candidates, { capability })`), while the pairwise `trust_level` — the sybil edge and the cold-start prior — stays capability-agnostic. Additive and backward-compatible: the field is optional, never on the wire (the `.strict()` `TrustCredentialSubject` still carries only the aggregate counts), and callers that pass no capability get the aggregate counts, byte-identical to before. See `docs/doctrine/first-person-worker-routing.md` § "Competence is a skill".

## 3.12.0

### Minor Changes

- e5d09c9: Promote `EvalAttestation` — the signed third-party-measurement artifact (subject ≠ signer; `docs/doctrine/evals-as-attestations.md` trigger #1 fired: the Auditor archetype is consumer #1).
  - `@motebit/protocol`: `EvalAttestation` / `EvalResult` wire types; `EvalKind` closed registry (eleventh registered registry — `ALL_EVAL_KINDS`, `isEvalKind`; single member `verification_audit`). Each result embeds a whole per-axis `VerificationVerdict` — no flattened booleans.
  - `@motebit/crypto`: `signEvalAttestation` / `verifyEvalAttestation` (JCS + Ed25519 + base64url under the pinned `EVAL_ATTESTATION_SUITE`). The verify law establishes "this issuer said this about this subject" and deliberately never measurement truth, issuer authority, key→id binding, or freshness; subject == issuer is valid (self-issued floor). Fail-closed structured reasons incl. closed-registry `unknown_eval_kind` intake via the crypto-side `EVAL_KINDS_MIRROR` (zero-runtime-deps discipline; four-way locked by `check-eval-kind-canonical`).
  - `@motebit/wire-schemas`: `EvalAttestationSchema` (+ `EvalResultSchema`, `VerificationVerdictSchema`, `RepairInstructionSchema`, `RevocationVerdictSchema`) with committed JSON Schema `spec/schemas/eval-attestation-v1.json`; spec `spec/eval-attestation-v1.md`; conformance corpus `spec/conformance/eval-attestation/`.
  - `@motebit/verifier`: re-exports the EvalAttestation family and widens the aggregator with the public-verification-surface laws an auditor composes (`verifySovereignBinding`, `verifyKeySuccession`, `verifySuccessionChain`, `verifyBondCommitment`, `verifyMerkleInclusion`) — services consume only the aggregator, never `@motebit/crypto` directly.
  - `@motebit/sdk`: the new protocol types ride the existing star re-export.

- e5d09c9: Graduate the structured verification-verdict vocabulary (`IntegrityVerdict`, `IdentityBindingVerdict`, `AuthorityVerdict`, `RevocationStatus`, `RevocationFreshness`, `RevocationVerdict`, `TemporalBasis`, `RepairInstruction`, `VerdictSubject`, `VerificationVerdict`) from `@motebit/crypto` to `@motebit/protocol` — the closed verdict vocabulary's home, and the prerequisite for `EvalAttestation` (which embeds whole verdicts per measurement and whose wire schema can only see protocol).

  `@motebit/crypto` re-exports every name type-only, so its public surface is name-identical (the `EvidenceRef` graduation precedent); a compile-time `ArtifactType extends VerdictSubject` assert locks the two packages against drift. `VerdictSubject` is restated in protocol as an explicit closed literal union and widened additively with four new measurement subjects: `succession`, `revocation`, `bond_commitment`, `solvency_proof`. Consumers with exhaustive switches over `VerdictSubject` should add arms for the new members; no existing values changed.

## 3.11.0

### Minor Changes

- 35af346: New `proxy:token` audience + `PROXY_TOKEN_AUDIENCE` constant in the closed `TokenAudience` registry. The relay's proxy-token mint route (`POST /api/v1/agents/:id/proxy-token`) issues a cloud-inference billing token carrying the agent's balance; it is now caller===:motebitId authed under this least-privilege audience, so a generic read token cannot be replayed to mint a spending credential (closes the 2026-07-07 unauthenticated-mint exposure).

## 3.10.0

### Minor Changes

- e651f19: `AuthorityDelta` — every refusal a typed, owner-facing repair instruction. The protocol gains the closed residual type (missing scope, required-vs-posture risk, requires-verified-grant, spend overage in micro, window unlock time, quorum shortfall, terminal states) with two load-bearing invariants documented on the type: ASYMMETRY (owner surfaces get precision; model-visible channels carry only the coarse reason — a precise residual is a boundary oracle aimed at the one party who can mint the difference) and PREDICTOR-NEVER-AUTHORITY (the delta describes refusals; the gate and meter remain the sole enforcers). `PolicyDecision.missing_authority` extends additively. The policy gate populates it at every deny/raise site from a single producer module; the blast-radius evaluator emits exact spend overages and window-unlock times; the ai-core tool_status stream chunk (surface channel) carries it while the conversation-history push stays coarse — pinned by a leak test over every context pack the model receives; the CLI renders the exact repair owner-side. Constructors, not an algebra: composition helpers wait for a third consumer needing to compose authorities, per rule-of-three.
- 052cfbd: `ToolDefinition.moneyBinding?: "args" | "late"` — the R4 metering axis (standing-delegation §3.3 AND-composition). Absent/`"args"` keeps today's semantics: the loop meters the tool call's own `amount_micro`+`counterparty` before execution. `"late"` declares that the spend materializes inside execution (e.g. a delegation quote resolved after worker discovery): the loop still requires a verified grant + wired meter to admit a grant-cleared call, and the metering itself moves to the rail seam — the runtime binds the payment builder only through `wrapP2pPaymentWithMeter`, which meters the delegator's TOTAL outflow (worker net + every fee leg) at the last point before broadcast and refuses on deny (gate `check-ceiling-from-grant` assertion 4). First declarer: `delegate_to_agent` — the standing grant can now authorize a real paid delegation, metered.

## 3.9.0

### Minor Changes

- 74d2f67: `AccountBalanceResult` + `AccountBalanceTransaction` — the wire format of the relay's virtual-account balance read (`GET /api/v1/agents/{motebitId}/balance`), specified as market-v1 §2.6/§2.7 with a committed JSON Schema (`spec/schemas/account-balance-result-v1.json`). This is the market-v1 §2 account state projected across the HTTP boundary: all monetary fields are decimal USD (the §2.3 conversion happens only at the producer), all fields required, `transactions[].type` a free string for additive evolution of the §2.2 vocabulary (whose table now includes the previously code-only `waiver` type). The reference relay's producer binds via `satisfies`; `@motebit/relay-client` validates responses against the schema; panels' previously drifted local copy is now an alias.
- 74d2f67: `AccountWithdrawRequest` / `AccountWithdrawResult` / `AccountWithdrawalRecord` (+ documented `AccountWithdrawalStatus` union) — the wire format of the money-out boundary `POST /api/v1/agents/{motebitId}/withdraw`, specified as market-v1 §2.8/§2.9 with committed JSON Schemas and a first-class threat-model section (idempotency mandatory, positive amount, dispute-window hold, `account:withdraw` authorization; non-goal: a 200 is not settlement finality — a `pending` status is the fail-safe). Amounts are decimal USD (§2.3 conversion at the producer). `status` is typed `string` on the wire for additive forward-compat, matching the `AccountBalanceTransaction.type` discipline. The reference relay's producer binds via `satisfies`; `@motebit/relay-client` gains a validated `withdraw()` method. The `POST /deposit` endpoint is deliberately NOT specified in this increment — it records a self-declared balance credit, and naming a "deposit wire format" without describing it alongside the onchain deposit-detector path would risk implying verified funds.
- 6b6ce77: `TurnContext.verifiedGrant` gains two optional producer-only fields (money-execution Inc 3b): `token_issued_at` — the verified tick token's signed `issued_at`, consumed as the blast-radius replay nonce (one tick meters at most one money action) — and `spend_ceiling` — the verified grant's signed `SpendCeilingV1`, copied verbatim by the sole producer (`verifyGrantForTurn`, gate `check-money-authority`) so the dispatch seam enforces spend against the DELEGATOR'S commitment (spec §3.3 rule 2) without re-holding the grant. Additive: pre-@1.2 producers omit both and the meter denies fail-closed (`nonce_absent`/`ceiling_absent`).
- 932fad9: `SpendCeilingV1` + `StandingDelegation.spend_ceiling` (standing-delegation@1.2) — the delegator's signed autonomous-spend ceiling on the wire, closing the money-execution checkpoint's D3 axis (`docs/proposals/standing-delegation-execution-checkpoint.md`). The ceiling rides in the grant's signed body (spec §3.3; committed schemas `spend-ceiling-v1.json` + regenerated `standing-delegation-v1.json`), making the HOW-MUCH a cryptographic commitment rather than local config. Absence is fail-closed by construction: a @1.0/@1.1 grant verifies unchanged and authorizes NO autonomous money (`ceiling_absent`). Limits are integer micro-units, USD-denominated (pinned by spec prose; a future asset model is a new `schema` literal — an agility-axis append). No crypto changes — JCS signing already covers the new field, proven by tamper/strip/graft tests.
- 74d2f67: Complete the `TokenAudience` registry against enforcement-and-minting reality: register six audiences in live use that the closed registry omitted — `task:query`, `task:result` (relay task poll/result routes), `market:listing`, `credentials`, `credentials:present` (agent-registry dynamic per-path middleware), and `market:query` (minted by the planner sovereign-delegation adapter and the CLI delegate flow; spec-listed since auth-token-v1). New named constants `TASK_QUERY_AUDIENCE`, `TASK_RESULT_AUDIENCE`, `MARKET_LISTING_AUDIENCE`, `MARKET_QUERY_AUDIENCE`, `CREDENTIALS_AUDIENCE`, `CREDENTIALS_PRESENT_AUDIENCE`. Additive only — no existing value changes meaning. Discovered by typing the audience seams as `TokenAudience` on both planes — the relay's `verifySignedTokenForDevice`/`dualAuth` `expectedAudience` parameter (verify plane) and the client mint helpers (`getRelayAuthHeaders`, `createSyncToken`, planner/runtime `authToken`) — structural enforcement where the line-based `check-audience-canonical` gate is blind (positional args, `??` fallbacks, variable-assigned audiences).
- 74d2f67: `verifyWithdrawalReceipt` — the portable verifier for completed-withdrawal receipts, closing a self-attesting-system gap on the money-out path. A completed withdrawal is a truth the relay asserts (relay CLAUDE.md Rule 6: every such truth must be independently verifiable without relay contact), but until now the relay signed a `WithdrawalReceiptPayload` with no portable verifier — a third party could not confirm it.

  Changes: `WithdrawalReceiptPayload` moves to `@motebit/protocol` (permissive-floor wire law); `signWithdrawalReceipt` moves into the `@motebit/crypto` kernel and gains its mirror `verifyWithdrawalReceipt` (both re-exported from `@motebit/virtual-accounts` for back-compat, and from `@motebit/verifier` so external consumers verify through the pinned aggregate). The market-v1 §2.9 wire record gains `relay_id` — a signed-payload field that was absent, so the response is now self-verifiable from the record alone. Registered in `check-signed-artifact-verifiers` (gap → within/verifier).

### Patch Changes

- 74d2f67: Doc-only: `ACCOUNT_DEPOSIT_AUDIENCE`'s comment now records that the self-declared `POST /agents/:id/deposit` route was removed (a treasury-drain vector — it credited spendable balance from a client-supplied amount) and that the audience remains reserved for a future _funded_ deposit-initiation endpoint. No API-surface change; balance is credited only by verified server-side funding (onchain deposit-detector, Stripe webhook).

## 3.8.0

### Minor Changes

- 85c0b10: settlement-invoice@1.0 kernel — the bill that extends the receipt chain to the money.

  Adds `CostAttestationV1` + `InvoiceV1` (and their structured verdicts) to `@motebit/protocol`, and `executionReceiptDigest` / `costAttestationDigest` / `signCostAttestation` / `verifyCostAttestation` / `signInvoice` / `verifyInvoice` to `@motebit/crypto`. motebit owns the format; the issuer runs the rails — no charge/balance/ledger primitive. Offline-verifiable, structured per-axis verdicts (including the stale-cost-overstatement customer-protection axis). Spec: `spec/settlement-invoice-v1.md`. Forced by agency.computer stage-2 billing.

## 3.7.0

### Minor Changes

- 09f4704: Producer-side evidence provenance — motebit's own grounded-answer output now carries re-verifiable provenance down to the retrieved primary source (dogfooding the evidence-provenance protocol motebit owns; agency.computer was the first producer, this makes motebit one too). Covers both the raw-byte path (`text/*`) and the recipe path (HTML).

  Additive wire surface (back-compat by absence):
  - `@motebit/protocol`:
    - `Citation.provenance?: EvidenceProvenance` — a `"web"` citation's `text_excerpt` as a content-addressed span in the primary record at `locator`, re-checkable with `verifyEvidenceProvenance`.
    - `ToolResult.source_digest?: DigestRef` — set by a fetch-type tool (`read_url`) whose returned `data` is re-derivable from the raw fetched bytes; its presence is the signal. `ToolResult.source_projection?: string` — the byte-deterministic projection recipe id whose output `data` is, set alongside `source_digest` on the recipe path (HTML → `"agency.html-text.v1"`); ABSENT on the raw-byte path (`text/*`).
    - `ExecutionReceipt.source_digest?: DigestRef` + `ExecutionReceipt.source_projection?: string` — the signature-bound attestation of the raw-source digest (and the recipe id, when extracted), threaded from the tool into the signed receipt.
  - `@motebit/crypto`: `SignableReceipt.source_digest?` + `SignableReceipt.source_projection?` so the signer types + canonicalizes the fields (signed over `canonicalJson(body)` like every other field). `verifyEvidenceProvenance` is also re-exported through `@motebit/encryption` (the verify surface services consume).

  The honesty invariant is enforced structurally: the digest is over the RAW served bytes a stranger re-fetches (never extracted text — the not-independent trap). On the raw-byte path `projection` is absent and the span is located over the raw bytes directly. On the recipe path, `read_url` ADOPTS the world-public, content-addressed, immutable recipe `agency.html-text.v1` (the Metabolic Principle — a deterministic HTML→text transform is a solved commodity, not a motebit enzyme; one resolver re-checks both motebit's and agency's HTML citations) and names it in `source_projection`, so a re-verifier re-fetches the raw HTML, re-applies the published recipe, then locates the span. The `@motebit/crypto` verifier stays domain-blind — it injects the resolver, owns no recipe catalog. The production recipe impl (`projectAgencyHtmlTextV1`, exported from `@motebit/tools`) is conformance-tested byte-for-byte against the published fixture; a separate independent impl in `@motebit/crypto` is the §7 byte-determinism guard.

  Behavior change (read_url HTML): extraction is now the byte-deterministic `agency.html-text.v1` recipe — it decodes only the structural entities (`&amp;`/`&lt;`/`&gt;`/`&quot;`/`&apos;`/`&nbsp;` + numeric forms) and passes presentational entities (`&copy;`, `&mdash;`, …) through verbatim, trading cosmetic richness for cross-language re-verifiability. JSON output stays projection-absent (no provenance) until a JSON recipe lands. The browser `proxyUrl` path returns pre-stripped data without provenance — a known coverage gap (the edge proxy is not a producer of signed citations).

  Round-trip e2e proves a stranger re-verifies a real research citation against the raw source on BOTH paths, that the HTML path fails closed without the recipe (`projection_unresolved`), and that a fabricated excerpt fails closed (`span_absent`) — verifiable-locality applied to the agent's own factual answers. Doctrine: `docs/doctrine/evidence-provenance.md`; spec/evidence-provenance-v1.md.

- b4a1c9e: Evidence-provenance: a second projection conformance class (`projectionClass`) to keep §7 binary (agency.computer co-design).

  A PDF cannot meet §7 (`spec-reproducible`): PDF→text is a genuine inference (glyphs at coordinates, reading order is heuristic; `pdftotext`/`pdf.js`/`pdfminer`/`mupdf` disagree byte-for-byte). Shipping such a recipe under the same `projection` umbrella would soften §7 to "usually real" and a "verified" PDF span would silently re-verify only against the producer's exact library. Rather than corrupt §7, the protocol adds a second, honestly-named assurance class.

  `@motebit/protocol`: new closed registry `ProjectionClass` (`spec-reproducible` | `tool-pinned`) + `ALL_PROJECTION_CLASSES` + `isProjectionClass`, mirroring `DigestAlgorithm`'s lighter treatment (not the registered-registry ceremony). New optional `EvidenceProvenance.projectionClass` — ABSENT ⇒ `spec-reproducible`, so the weaker class is opt-in and can never be claimed by omission. Additive, back-compat.

  `@motebit/crypto` + `@motebit/verifier`: re-export `ProjectionClass` so a consumer pinning the aggregator reads the class off the SAME surface it consumes (agency-proof-integration contract). `verifyEvidenceProvenance` is UNCHANGED — the class is carried-but-law-advisory (like `binding`/`locator`); it is the assurance level the consumer policies on.

  `@motebit/wire-schemas`: `projectionClass` added to the zod schema + the committed `spec/schemas/evidence-provenance-v1.json` (parity-checked).

  `tool-pinned` is on-wire (visible per claim, so a consumer can policy-gate it) but its conformance obligations live in `spec/evidence-provenance-v1.md` §7-tool: a content-addressed, world-obtainable, version-pinned tool (reproducible-build preferred) + a committed fixture; the tool digest lives in the app-owned recipe spec (already bound by the immutable-recipe-id rule), never per-span on the wire. No `tool-pinned` recipe ships in-tree yet — this is the class vocabulary + obligations only.

- 96a09fd: Add `EventType.SecretRedactedFromEgress` + `SecretRedactedFromEgressPayload` — the privacy-egress audit event the runtime emits when `SecretRedactingProvider` masks credential-class secrets from an outbound payload to a non-sovereign provider. The sibling of `SensitivityGateFired` on the same axis (that records a BLOCKED crossing in a marked-sensitive session; this records a REDACTED one in an unmarked session), turning the otherwise-silent redaction into an inspectable trail. Strictly metadata — count + credential-class label names (e.g. `"API_KEY"`, `"JWT"`) + provider mode, never the secret content.

## 3.6.0

### Minor Changes

- 7941af4: Accrual basis — the Ring-1 contract for the felt-interior leverage register (felt-accumulation doctrine, Inc 1).

  Adds the typed shape of a "leverage moment": the basis an act carries when it was shaped by ACCRUED state — thesis #2 (the agent gets more capable the longer it runs) made felt, as the interior DRAWN UPON rather than its resting mass.
  - `AccrualKind` — closed, append-only union (`recalled_memory` / `trust_edge` / `consolidated_fact` / `prior_approval_pattern` / `standing_delegation`) with `ALL_ACCRUAL_KINDS`, `isAccrualKind`, and `ACCRUAL_KIND_MARKERS` (`Record<AccrualKind, string>` — append-without-marker is a compile error).
  - `AccrualBasis` (`{ kind, sourceRef, sensitivity }`) — the produced basis. `sourceRef` is an opaque pointer to the leveraged source for explicit reveal, never the source artifact itself (leverage reveals, never authorizes — for `trust_edge`/`standing_delegation` it points to the signed grant the act ran under). `sensitivity` bounds the render (summary-not-secret, the disclosure ceiling falls as the tier rises).
  - `AccrualAttributed` — the optional carrier mixin; absence is the fail-closed default (no leverage → no attribution → the act renders plain).

  LOCAL by construction (owner-facing, body-rendered, never synced) → a structural-lock closed union, not a registered wire registry. The produced-not-authored honesty floor lands as the Inc-5 gate `check-accrual-basis-canonical`; Inc 2 threads production at the real memory-graph / trust-graph seams.

- 0045b07: Commitment bond — the `BondCommitment` wire artifact + verifier (commitment-bond doctrine, phase 1 Inc 1).

  A commitment bond is an agent's OWN sovereign capital, posted as a self-signed proof-of-funds and RPC-verified by the relay, never custodied. **Phase 1 is an anti-sybil staked _signal_, NOT collateral / escrow / recourse** — honest naming is load-bearing; the recourse half (`BondCall` / `BondDefault`) is deferred-with-trigger.

  `@motebit/protocol`:
  - `BondCommitment` — the signed wire type (`motebit/bond@1.0`): `bonded_public_key` + `bonded_address` + `bond_amount_micro` + `asset` + `chain` (CAIP-2) + `issued_at`/`expires_at`. `BOND_COMMITMENT_SPEC_ID` pins the family; `isBondCommitment` is a structural guard (shape only — NOT signature or binding validity).

  `@motebit/crypto`:
  - `signBondCommitment` / `verifyBondCommitment` (+ `BOND_COMMITMENT_SUITE`). The bond is **self-anchoring**: signed by `bonded_public_key`, which IS the bonded address. `verifyBondCommitment` takes no external key and enforces, fail-closed, **the load-bearing anti-sybil binding** — `bonded_address` MUST equal `base58btc(bonded_public_key)` (the Solana address derivation, computed inside `@motebit/crypto` with zero monorepo deps). So one wallet cannot back many identities. Binding the bond to a claimed `motebit_id` (the key→id check) stays the verifying relay's separate responsibility (the `verifySovereignBinding` shape).

  The binding cannot be silently removed: `check-bond-address-binding` (drift invariant #132) locks the type fields, the verifier's fail-closed enforcement, and the `spec/bond-v1.md` §2 foundation law together. The bond is an additive eligibility input, never a new `SettlementMode`. Doctrine: `docs/doctrine/commitment-bond.md`.

- a730451: Evidence provenance — verifiable locality extended from signatures to EVIDENCE (agency.computer co-design).

  A `VerificationVerdict`'s `evidenceBasis` was a list of `{ kind, ref }` POINTERS — naming what a verdict used, but not independently re-checkable. This additive arc makes that pointer resolve to a re-verifiable provenance, so a verdict's evidence axis becomes locally re-checkable down to the primary record.

  `@motebit/protocol` (additive, back-compat by absence): `EvidenceRef` graduates here from `@motebit/crypto`'s free `{kind,ref}` (re-exported from crypto, so the verify-family surface is unchanged) and gains an optional `provenance?: EvidenceProvenance` — `{ digest: { algorithm, value }, projection?, span, locator?, binding? }`. `DigestAlgorithm` (`sha-256` today) rides its own role — a content digest is hashed, not signed, so it does NOT reuse `SuiteId`; a new hash is a registry append, not a wire break.

  `@motebit/crypto` (additive): `verifyEvidenceProvenance(bytes, provenance, { resolveProjection? }) → EvidenceProvenanceResult`, pure and I/O-free. The law: the named `span` is an exact substring of `projection(bytes)`, where the bytes content-address to `digest`. Re-verifies PRESENCE, never truth, no oracle. The projection is an INJECTED SEAM (same shape as `verifyStandingDelegation`'s `isRevoked`) so motebit stays domain-blind — projection absent → checks the raw bytes directly (re-verifiable by construction); projection present + injected resolver → apply, then check; projection present + no resolver → fails closed (`projection_unresolved`). `binding` is carried but NOT verified (issuer authority is app-layer); `locator` is advisory.

  Hostile corpus locks the law (span-absent, digest-mismatch, projection-unresolved fail-closed, raw-byte-happy, projection-applied, projection-divergence, binding-carried-not-verified). Deferred to agency's side (consumer-forces-shape): a published byte-deterministic projection recipe + its committed reference fixture (the real cross-implementation projection-divergence case), and the wire spec. Doctrine: `docs/doctrine/evidence-provenance.md`.

## 3.5.0

### Minor Changes

- 901f134: Add the `ConsolidationMutationManifest` artifact family — the felt-interior binding (`docs/doctrine/felt-interior.md`, `spec/consolidation-mutation-manifest-v1.md`).

  A motebit's consolidation receipt commits to structural counts only; its privacy boundary is the type. The new mutation manifest is the owner-facing adjunct: a separately-signed commitment to the exact formed/refined mutations of a cycle, joined to its counts-only receipt by `receipt_id` + `receipt_digest`. Each commitment carries a one-way `content_sha256` (never the content), plus the committed `provenance` and `sensitivity`, so a surface can prove the sentences it displays are exactly the signed cycle's mutations — the receipt never carrying memory text. Two artifacts, two privacy boundaries.
  - `@motebit/protocol` — new `ConsolidationMutationManifest` + `ConsolidationMutationCommitment` types. The receipt remains unchanged (counts-only). Domain separation is by a `manifest_type` discriminator inside the signed body, under the existing `motebit-jcs-ed25519-b64-v1` suite — no new `SuiteId`.
  - `@motebit/crypto` — `signConsolidationMutationManifest` / `verifyConsolidationMutationManifest` (fail-closed on suite, `manifest_type`, decode, and primitive failure), plus the shared `consolidationReceiptDigest` and `consolidationContentDigest` helpers producer and verifier use so the binding is reproducible.

- 8ce3410: standing-delegation@1.1: generic `subject_binding` on `StandingDelegation`

  A `StandingDelegation` can now carry an optional, generic `subject_binding`
  (`SubjectBindingV1`) that digest-binds a detached, vertically-typed subject-scope
  artifact. Because it rides in the signed body, the delegator's single signature
  reaches the EXACT resolved subjects the authority covers — closing the gap where
  an interpreter (not the delegator) chose the identities an agent acts on. The
  detached artifact needs no second signature (collision resistance binds it to the
  signed digest, the `SignedRequestEnvelope.payload_digest` pattern).
  - `@motebit/protocol`: new `SubjectBindingV1` type + optional `subject_binding` on
    `StandingDelegation`. Additive — @1.0 grants verify unchanged.
  - `@motebit/crypto`: `subjectBindingDigest(artifact)` (`hex(SHA-256(canonicalJson))`)
    and `verifySubjectBinding(binding, artifact)` (fail-closed: digest method,
    declared `artifact_schema`, digest match). Unsigned artifact ⇒ no signed-artifact
    verifier entry; authority is the grant's signature over the binding.
  - `@motebit/verifier`: re-exports both helpers + the type.

  `digest_method` is a HASH method (`jcs-sha256-hex`), deliberately NOT a signature
  `suite`. Subject _completeness_ (`attempted == signed`) is a monitor receipt-profile
  rule on top, never a property of this generic binding. Higher-assurance consumers
  MUST fail closed when `subject_binding` is absent.

## 3.4.0

### Minor Changes

- 21e035d: New `TokenAudience` registry entry: `runtime:attach` (+ `RUNTIME_ATTACH_AUDIENCE` constant). The device-key-signed attach handshake on the machine-local runtime-host socket — a frontend process authenticating to the machine's coordinator runtime, per the daemon–desktop unification doctrine (one sovereign runtime per machine, frontends attach). Verified exclusively by the local coordinator; the relay and every network verifier reject it by audience binding, so the token never authorizes anything beyond the machine boundary. Additive: existing audiences, verifiers, and wire formats are unchanged.

### Patch Changes

- d6ae64c: Pin the failed-vs-denied status semantics on `ExecutionReceipt` and `ToolInvocationReceipt`. The discriminator is who refused: `denied` is the governance boundary's verdict (a policy gate blocked the task's actions and no permitted work completed), `failed` is the execution interior's verdict (crashes, timeouts, and the worker's own principled refusals all included). Doc-comment clarification only — no wire-format or runtime change; existing receipts stand as minted. Canonical prose lives in `spec/execution-ledger-v1.md` §11.1 "Status semantics".

## 3.3.0

### Minor Changes

- a0fb79c: `EventStoreAdapter.redactMemoryContent?(motebitId, nodeId)` — the optional storage operation behind deletion propagation: erase the content of stored `memory_formed` events for a deleted memory node, replacing it with the `"[REDACTED]"` sentinel + `redacted: true` + `redacted_reason: "deleted"`. Joins the sanctioned deletion-shaped mutation family (`tombstone` / `compact` / `truncateBeforeHorizon`); the `DeleteRequested` event remains the surviving audit record. Encrypted payloads are opaque and skipped by design — the client-side key lifecycle is the erasure mechanism for ciphertext. Consumed by the relay: a synced `DeleteRequested` for a memory node now erases that node's relay-stored formation content, so a subject's signed deletion certificate is not outlived by the relay's copy.
- dee96b8: Declare `redacted_reason?: "deleted"` on `MemoryFormedPayload` — close the wire-contract gap on the deletion tombstone.

  The deletion-propagation arc (`a0fb79ce`) made user-initiated forget reach the relay: when a `memory_deleted` syncs, a conforming store rewrites the matching `memory_formed` payload in place, blanking `content` to the `"[REDACTED]"` sentinel and stamping `redacted_reason: "deleted"`. That field is already written by every producer (`EventStoreAdapter.redactMemoryContent` in event-log + persistence, the relay `deletion-propagation.ts`, and the relay backfill migration) and is _load-bearing_ — `event-log/index.ts` and `persistence/index.ts` both read `payload.redacted_reason === "deleted"` to keep the rewrite idempotent. But it was declared nowhere in the wire contract: not on `MemoryFormedPayload`, not in `MemoryFormedPayloadSchema`, not in `spec/memory-delta-v1.md`. The `.passthrough()` envelope kept it from failing validation, so the drift was silent — exactly the spec-vs-code divergence the synchronization-invariants principle forbids.

  `redacted_reason` is the sole discriminator between the two mechanisms that both blank `content`: sync-forwarder **sensitivity** redaction (`redacted: true` + `redacted_sensitivity`, original re-requestable from the emitter) versus a **deletion tombstone** (content terminally erased; a conforming consumer MUST NOT re-form a node from it). A third party implementing `memory-delta` from the schema could not previously tell "stripped, recoverable" from "erased, terminal".

  Additive and replay-compatible: optional literal, absent ⇒ sensitivity redaction or no redaction; 1.0–1.3 logs replay identically. Lands the protocol type, the zod schema (`@motebit/wire-schemas`, regenerated `spec/schemas/memory-formed-payload-v1.json`), and `spec/memory-delta-v1.md` (§5.1 field + new §6.1 deletion-tombstone section + version-history 1.4; the stale `**Version:** 1.2` header is corrected to 1.4 in the same pass).

- 2f6852f: The standing-authority invariant — memory never confers authority (`docs/doctrine/memory-never-confers-authority.md`).

  `TurnContext.verifiedGrant?: { grant_id, verified_at }` — a cryptographically verified standing-delegation grant covering the turn. Populated exclusively by the runtime's dispatch-layer grant verifier (`verifyGrantForTurn`: `verifyStandingDelegation` + `verifyTokenAgainstGrant` + a revocation check over signed artifacts), never from model output, recalled memory, trust level, or configuration. Its sole consumer is the policy gate's new step 8b: an R4_MONEY tool call auto-executes only when `verifiedGrant` is present; otherwise it requires live human approval regardless of any approval-lowering path — the Trusted-caller bypass, the service-motebit adjustment, and governance presets are subordinated for R4 (they still clear R0–R3). `denyAbove` is never overridden by a grant; the deterministic `invokeCapability` tap path is untouched.

  Companion fix: `delegate_to_agent` now registers with an explicit `riskHint` (`R4_MONEY` + irreversible when a payment rail is configured, `R2_WRITE` otherwise) — previously it carried no hint and the risk-model patterns classified the money-capable delegation tool `R0_READ`, letting it auto-execute as read-class.

  Gate-enforced by `check-money-authority` (drift-defenses #123): block present + ordered after the trust switch, explicit riskHint, single audited producer of `verifiedGrant`.

- 99819c4: `MemorySource` — the memory-provenance closed registry (tenth registered registry per `docs/doctrine/registry-pattern-canonical.md`).

  Memory candidates carried no provenance: a memory formed from a web page, a peer agent's message, or a tool result was byte-indistinguishable from one the user stated directly — the persistent-prompt-injection and hallucinated-authority channel (absorbed third-party content reads as durable user intent on recall, then informs delegation and policy).

  New exports:
  - `MemorySource` — `"user_stated" | "agent_inferred" | "tool_derived" | "peer_agent" | "consolidation_derived"`. `web_content` deliberately deferred until the loop can honestly distinguish web tools from other tools at formation time (registry append when it can).
  - `ALL_MEMORY_SOURCES` (frozen iteration array), `isMemorySource` (type guard — inbound wire values degrade to `undefined` on mismatch, never fail open to a trusted tier).
  - `MEMORY_SOURCE_MARKERS` / `MEMORY_SOURCE_MARKER_UNKNOWN` — the canonical `[from:X]` render-marker map, `Record<MemorySource, string>` so a registry append without a marker is a compile error.
  - `MemoryContent.source?` / `MemoryContent.source_turn_id?` and `MemoryCandidate.source?` / `source_turn_id?` — optional on reads (legacy nodes render as provenance `unknown`, honestly absent, never fabricated). `source_turn_id` is local provenance only and never rides the wire.
  - `AttributedMemoryCandidate = MemoryCandidate & { source: MemorySource | undefined }` — the asymmetric-typing enforcement (same shape as `WritableSettlementMode`): formation entry points take the attributed type, so every formation call site is a compile error until it declares a source. The key is required but the value admits explicit `undefined` — a deliberate declaration of unknown provenance for the one legitimate case (supersede inheriting from a pre-provenance legacy node); declared-unknown beats fabricated, omission stays impossible.

  Wire: `MemoryFormedPayload.source?` (memory-delta@1.3, additive and replay-compatible; forwarder-immutable; canonical JSON Schema regenerated at `spec/schemas/memory-formed-payload-v1.json`).

  Authorship rule (interop law, gate-enforced by `check-memory-source-canonical`, drift-defenses #122): `source` is assigned by the forming code path — never parsed from model output (no `source` attribute on `<memory>` tags) and never accepted from a peer's self-declaration (MCP writes are `peer_agent` only). Doctrine: `docs/doctrine/memory-provenance.md`.

- 93ff63c: Land `seed-escrow@1.0` — durability without custody.

  A `SeedEscrowPayload` is an identity's Ed25519 seed, AES-256-GCM-encrypted under a key only the owner's authenticator can reproduce (v1: a WebAuthn passkey's PRF output), parked with a custodian that is **structurally unable to open it**. Escrow, not custody — restore is relay-optional, exactly as the identity doctrine requires. The sibling of `KeyTransferPayload`: transfer moves a key between parties under key agreement; escrow parks a seed with a custodian under an authenticator-held secret (no X25519 ephemeral, `kdf` as a closed registry, same `identity_pubkey_check` post-decryption verification).

  Forced by agency (Q2), who run it in production (`apps/app/lib/passkey.ts`).

  Adds:
  - `@motebit/protocol`: the `SeedEscrowPayload` type.
  - `@motebit/wire-schemas` (private): zod schema + committed `spec/schemas/seed-escrow-payload-v1.json` (parity-locked, drift-tested).
  - `spec/seed-escrow-v1.md`.

  Unsigned by design — integrity is the AES-GCM tag, correctness is the mandatory `identity_pubkey_check`, and placement is authenticated by `signed-request-envelope@1.0` (the two compose; no signing primitive). "Escrow, not custody" is enforceable foundation law: a custodian that can decrypt its escrows is in protocol violation, and conformance requires demonstrating it can't. The fresh-device restore anchor is the identity registry / key-transparency log, not the payload's self-asserted `identity_pubkey_check` (review note folded into §6).

- 93ff63c: Land `signed-request-envelope@1.0` — stateless per-request identity authentication.

  A `SignedRequestEnvelope` authenticates a single request from a registered motebit identity to a service endpoint: the key is the login. It binds the requesting `motebit_id`, a timestamp, a SHA-256 digest of the (detached) request body, and an audience into one Ed25519 signature, verified against the identity's **registered** public key — never a key the request self-asserts. The stateless sibling of `auth-token@1.0`, for a different caller and trust root.

  Forced by agency (Q1), who run the inline-payload predecessor in production (`apps/app/lib/signed-request.ts`); their module collapses to a re-export now that the primitives publish.

  Adds:
  - `@motebit/protocol`: the `SignedRequestEnvelope` type.
  - `@motebit/crypto`: `signRequestEnvelope(payload, fields, identityPrivateKey)` + `verifyRequestEnvelope(envelope, registeredPublicKey, options?)` — JCS + Ed25519 + base64url-sig, same suite as the rest of the identity family; the registered key is a verify-side parameter (the trust move). Self-verifiable per crypto rule 4.
  - `@motebit/verifier`: re-exports both, so a consumer validates the whole flow through the package it already pins.
  - `@motebit/wire-schemas` (private): zod schema + committed `spec/schemas/signed-request-envelope-v1.json` (parity-locked).
  - `spec/signed-request-envelope-v1.md` + `scripts/check-signed-artifact-verifiers.ts` REGISTRY entry (`SignedRequestEnvelope` → `verifyRequestEnvelope`).

  Three review improvements over agency's draft are folded in: the detached `payload_digest` (envelope detaches from the body), the verifier MUST parse-then-canonicalize the received body (§7.2), and `aud` is a free-form audience string rather than the coarse `TokenAudience` registry.

- 3044a2a: standing-delegation v1.1 — optional `not_before` on `DelegationToken` makes pre-minting honest.

  agency, building standing monitors on `standing-delegation@1.0`, surfaced a real gap: a sovereign delegator (passkey-gated seed) can't sign per-tick tokens at tick time, so the conformant pattern is **pre-minting** — sign every cadence slot's token at grant-creation. But `DelegationToken` had no activation field and `verifyDelegation` checked only `expires_at`, so a future-windowed pre-minted token verified **early** — offline, a slot's token was indistinguishable from one minted at its slot.

  Fix (additive, fully backward-compatible — 1.0 tokens replay identically):
  - `@motebit/protocol`: `DelegationToken` gains an optional `not_before` (Unix ms).
  - `@motebit/crypto`: `verifyDelegation` rejects when `now < not_before` (gated under `checkExpiry`, so historical chain verification skips it like expiry). `@motebit/wire-schemas` zod + regenerated `spec/schemas/delegation-token-v1.json`.
  - Spec: `standing-delegation-v1.md` §1/§4 reframed — the per-tick token is **signed by the delegator** (the prose said "the delegate mints"; the code rejects delegate-signed ticks, so the prose was the drift), pre-minting is the documented v1.0 model, and cadence is bound cryptographically by the signed token set rather than demoted to a rate-limit. `market-v1.md` §12.1 gains the `not_before` field + verification step.

  Holder-side (delegate-signed) minting stays a deliberate **non-goal in v1.0** — agency's doctrine-grounded call: for a receipts-over-trust product, keeping cadence cryptographic beats deleting pre-mint code. A future version MAY add it behind an explicit trigger.

## 3.2.0

### Minor Changes

- 8ec1140: Add the standing-delegation authorization primitive (standing-delegation@1.0): a `StandingDelegation` grant that authorizes minting short-lived per-tick `DelegationToken`s within a fixed scope ceiling and cadence, for a long-but-finite, revocable lifetime — the missing shape for cadence-scoped standing work ("daily research on subject S until revoked"). Unlike a `DelegationToken`, which authorizes one act and is short-lived by invariant, the standing authority lives only on the grant; each minted token stays 1h/task-scoped; revocation lives on the grant.

  `@motebit/protocol` (Apache-2.0, types only): `StandingDelegation`, `DelegationRevocation`, and an optional `grant_id?` on `DelegationToken` (absent ⇒ today's standalone semantics — backward compatible).

  `@motebit/crypto` (Apache-2.0): `signStandingDelegation` / `verifyStandingDelegation` (signature + `not_before` + expiry + an injected `isRevoked` seam mirroring `isAgentRevoked`), `verifyTokenAgainstGrant` (a per-tick token is a valid tick iff its own signature/expiry verify, `grant_id` matches, the grant verifies, parties match, scope narrows within the grant ceiling, and TTL ≤ `max_token_ttl_ms`), and `signDelegationRevocation` / `verifyDelegationRevocation`. Same suite (`motebit-jcs-ed25519-b64-v1`), JCS + Ed25519 + base64url conventions as `signDelegation`. Self-verifiable per crypto rule 4 — a third party verifies a standing monitor's authorization root, every per-tick token, and a revocation with only this package and the signer's public key, no relay contact.

  Forced by a real external consumer (agency's standing-monitor vertical) and closes a gap that exists independently: delegation previously had no published revocation story. Revocation is terminal in v1; the canonical source of truth is the signed, offline-verifiable revocation (a relay deny-list is a cache, not the authority). Cadence is a mint/relay-side rate limit, not checked by single-token verify.

  Follow-ups (separate): the committed `spec/standing-delegation-v1.md` + wire-schemas, `@motebit/verifier` integration, and the relay-side revocation feed + scheduler seam.

## 3.1.0

### Minor Changes

- ac2d6e3: Add the `receipts:read` token audience.

  New entry in the `TokenAudience` registered registry (+ `RECEIPTS_READ_AUDIENCE` constant) for the relay's user-owned receipt-retrieval endpoints: a motebit reads its OWN signed execution receipts back from the relay archive (gated on this audience + caller-owns-motebitId) and re-verifies them offline. Additive — existing audiences and consumers are unaffected.

- ffe7323: Signed approval/consent decisions: the "approve" governance band is now a verifiable artifact, not a plaintext row.

  Interactive approval pause/resume already existed (`streaming.ts` `resumeAfterApproval`/`resolveApprovalVote` across all surfaces, with quorum + timeout + a durable daemon path). The gap was that the consent _decision_ itself was unsigned — a plaintext `approval_queue` row + event, with mid-turn denial injected as the literal string `"User denied this tool call."` This left the governance triad asymmetric: the auto band proves itself with a `ToolInvocationReceipt` and the deny band with an agent-signed `ExecutionReceipt{status:"denied"}`, but the approve band's verdict was unverifiable.
  - `@motebit/protocol`: new `ApprovalDecision` interface — a JCS + Ed25519 signed-artifact-family member committing to `approval_id` (the gated `tool_call_id`, bound so a verdict is non-portable), `args_hash` (never raw args), `risk_level`, `verdict`, and requested/resolved timestamps.
  - `@motebit/crypto`: `signApprovalDecision` / `verifyApprovalDecision` (+ `APPROVAL_DECISION_SUITE`), mirroring `signAdjudicatorVote` and embedding the approver's `public_key` for offline verification. Registered in `check-signed-artifact-verifiers`.
  - `@motebit/runtime`: `resumeAfterApproval` produces and signs the decision with the **approver's** device key (consent is the approver's own assertion, the way the worker signs its own refusal), for every final verdict — single-approver, deny, and quorum-met. Delivered via a new `onApprovalDecision` sink and buffered in `getRecentApprovalDecisions()` — the exact buffer + forward shape as `onToolInvocation` (a sink, not a new StreamChunk variant, so no surface switch changes; and no runtime event-log append, which would double-emit against the daemon's existing goal-audit event).

  The decision verifies offline with the approver's public key, no relay contact. Deferred (consumer-forced shape, mirroring how the refusal path shipped retrieval separately): durable cross-restart archival + a dedicated retrieval surface, per-quorum-vote signing, and signing the timeout-expiry auto-deny.

## 3.0.0

### Major Changes

- 271bb5c: Remove the API symbols deprecated for removal in 3.0.0.
  - `@motebit/crypto`: removed `verifyIdentityFile` and `LegacyVerifyResult` (deprecated since 1.0.0). Use `verify(content, { expectedType: "identity" })`, which returns the typed `VerifyResult` discriminated union (`type` discriminator + structured `errors: Array<{ message }>`).
  - `@motebit/protocol`: removed `DEFAULT_TRUST_THRESHOLDS` (deprecated since 1.0.1). Use `REFERENCE_TRUST_THRESHOLDS` — a bit-identical value; the `REFERENCE_` prefix signals "reference-implementation default, implementers MAY override," not interop law.

  Internal consumers (`@motebit/semiring`, `@motebit/market`) were migrated to `REFERENCE_TRUST_THRESHOLDS` and no longer re-export the alias.

  ## Migration
  - `@motebit/crypto`: replace `verifyIdentityFile(content)` with `verify(content, { expectedType: "identity" })`. The result is a `VerifyResult` discriminated union — gate on `result.type === "identity" && result.valid`, and read the first error via `result.errors?.[0]?.message` (the old flat `result.error` field is gone). Replace any `LegacyVerifyResult` type annotations with `VerifyResult`.
  - `@motebit/protocol`: replace `DEFAULT_TRUST_THRESHOLDS` with `REFERENCE_TRUST_THRESHOLDS`. The value is bit-identical; only the name changed (reference-implementation default, not interop law).

- 7a2797f: Name the payee in the settlement receipt, and ship the portable per-agent settlement-anchor verifier that closes the self-attesting loop.

  **Why.** A `SettlementRecord` is the proof a worker holds that it was paid. It named the relay-internal `allocation_id` but not the payee — so the receipt could not stand on its own; a verifier had to ask the relay to resolve the allocation. And the per-agent settlement anchor (`AgentSettlementAnchorProof`, served publicly at `/api/v1/settlements/:id/anchor-proof`) had every piece shipped — producer, endpoint, wire types, spec — except the verifier. The verifier was a tracked gap in `check-signed-artifact-verifiers` because it could not be written honestly: the producer's Merkle leaf was a hand-typed field projection that swapped `allocation_id`→`motebit_id` and dropped the optional `x402_*` fields, so it did not equal the hash of the signed record a worker holds. A spec-faithful verifier would have rejected every real proof; a producer-faithful one would have required a field absent from the worker's record. The leaf must be the hash of the exact signed object — the SCITT / RFC 6962 invariant — never a re-typed subset.

  **What changed.**
  - `SettlementRecord` gains a required `motebit_id` — the payee, equal to the executing agent's `ExecutionReceipt.motebit_id`. The receipt now names who was paid in its signed body. (`@motebit/protocol`, major.)
  - `signSettlement` therefore requires `motebit_id` in its input. (`@motebit/crypto`, major.)
  - New portable verifier `verifyAgentSettlementAnchor(record, proof, chainVerifier?)` plus `computeAgentSettlementLeaf(record)` and `AGENT_SETTLEMENT_ANCHOR_SUITE` — a worker verifies offline, with only the signed record, the inclusion proof, and the relay's public key, that the relay anchored exactly that record. The leaf is `SHA-256(canonicalJson(record))` over the whole signed object, never a projection. Third Merkle consumer of the canonical `verifyMerkleInclusion` primitive. (`@motebit/crypto`, additive.)
  - The anchor batch payload now binds `suite` inside the signed bytes (cryptosuite-agility), matching the sibling credential-anchor.

  `check-signed-artifact-verifiers` moves `AgentSettlementAnchorProof` from a tracked gap to a portable verifier (and `AgentSettlementAnchorBatch` to `within`) — one fewer hole in the self-attesting moat.

  ## Migration

  Constructing a `SettlementRecord` (or calling `signSettlement`) now requires the `motebit_id` payee field:

  ```ts
  const record: SettlementRecord = {
    settlement_id,
    allocation_id,
    motebit_id, // NEW — the payee (the executing agent's motebit_id)
    receipt_hash,
    // …unchanged…
  };
  ```

  Relays derive it from the receipt that earned the settlement (`receipt.motebit_id`); `settleOnReceipt` does this automatically. Per-surface SQLite stores add a nullable `motebit_id` column (relay, agent persistence, desktop, mobile migrations included); legacy rows read back an empty payee and fail wire-schema validation, the intended fail-closed signal that the row predates the field.

### Minor Changes

- aefe5f6: Add `motebit/agent-revocation@1.0` — operator de-listing of agents from the relay's discovery registry, made sovereign-verifiable. A permissionless registry accumulates junk (spam, abandoned test agents, abusive capabilities) and the only automatic remedy is the 90-day no-heartbeat TTL — too slow for live abuse. The operator needs a de-list tool, but a silent de-list is exactly the trust root the relay is forbidden from being (`services/relay/CLAUDE.md` rule 6). So the power is made accountable, not refused: every revoke/reinstate is a signed, reasoned, publicly-fetchable record against the relay's pinned key — declared posture → proven posture.

  Invariants: **de-list, not de-identify** (sets `agent_registry.revoked`, which Discover filters; identity/key/succession/receipts stay served — distinct from identity revocation, which anchors an on-chain memo); **hygiene, not curation** (discovery stays permissionless); **operator-only** (master token; agents self-deregister, never de-list a peer); reversible + append-only.
  - `@motebit/protocol`: `AgentRevocationReason` (ninth registered registry, full eight-artifact set + gate `check-agent-revocation-reason-canonical`), `AgentRevocationRecord` / `AgentRevocationFeed` / `AgentRevocationActor` signed wire types, `AGENT_REVOCATION_SUITE` / `AGENT_REVOCATION_SPEC_ID`. Additive — no existing export changes.
  - `@motebit/state-export-client`: portable `verifyAgentRevocationRecord` / `verifyAgentRevocationFeed` against the relay's pinned key (same key as `verifyTransparencyDeclaration`). Additive.

  Spec: `spec/agent-revocation-v1.md` (25th spec). Doctrine: `docs/doctrine/agents-as-first-person-trust-graph.md` §8. The relay producer + wire-schemas (both ignored packages) ride the sibling `-ignored` changeset.

- 781dbc0: Add an optional first-person `petname` field to `AgentTrustRecord` — a local-only nickname for a peer agent (what _I_ call them, in my own namespace), never on the wire and never sent to a peer or the relay. Naming is first-person, the petname resolution to Zooko's triangle (doctrine: `docs/doctrine/agents-as-first-person-trust-graph.md` §3), distinct from a peer's squattable self-asserted listing name. Additive and optional; absent ⇒ no petname.

  Persisted by the SQLite trust store (migration v39 adds a nullable `agent_trust.petname` column; in-memory and IndexedDB stores carry it for free via whole-record upsert), settable via `runtime.setAgentPetname(remoteMotebitId, petname)` (display-only — not a routing input, so it does not invalidate the agent graph). The panel UI and any auto-suggestion remain held behind the §5 fork.

  Note: regenerating `etc/protocol.api.md` for this change also brought the protocol baseline back in line with source — federation P2P symbols (`SovereignP2pPaymentRequest`, `computeFederatedFeeSplit`, `FederatedFeeSplit`) from the in-flight settlement-anchor major weren't yet in the committed baseline. That lag is the documented behavior of `check-api-surface`'s pending-major carve-out (a standing `@motebit/protocol: major` changeset makes surface divergence a warning, not a failure), not a gate bug. Baseline now matches source.

- cf26f38: Add `computeFederatedFeeSplit(budgetMicro, feeRate)` (+ `FederatedFeeSplit`) — the canonical cross-operator federated P2P fee-from-budget split (spec `relay-federation-v1` §7.1): a budget splits into origin-relay fee, executor-relay fee, and worker net, the three legs summing to the budget exactly. Interop law on the money path: the origin relay's forward-site validator and the delegator client that builds the 3-leg proof must compute it identically or the proof is rejected leg-by-leg, so it lives in `@motebit/protocol` as one source of truth (sibling of `computeP2pFeeMicro`). The relay's `services/relay/src/tasks.ts` federated validator now consumes it.
- 85f7e10: `P2pPaymentProof` gains optional `b_fee_to_address` + `b_fee_amount_micro` — the executor-relay (B) fee leg for cross-operator federated P2P settlement. Additive: present only when a paid task is delegated to a worker hosted on a different operator (the delegator's atomic Solana tx then carries THREE legs — worker net + origin-relay fee + executor-relay fee, per `spec/relay-federation-v1.md` §7.1 fee-from-budget). Single-operator P2P proofs are unchanged (two legs, fields absent).

  Doctrine: `docs/doctrine/off-ramp-as-user-action.md` § "Cross-operator federated P2P".

- 403a725: Federation settlement anchoring becomes self-verifiable offline — the closing convergence (PR6) of the RFC 6962 §2.1 tree-hash arc (doctrine: `docs/doctrine/merkle-tree-hash-versioning.md` §8; the deferred item-4 in `spec/agent-settlement-anchor-v1.md` §9.1). The federation settlement stream was the only anchoring stream not yet self-verifiable with `@motebit/crypto` alone; this closes all three counts §9.1 named.

  **`@motebit/protocol` (new types):**
  - `FederationSettlementRecord` — a relay's signed record of one federation settlement (the verbatim-artifact leaf). Each relay signs its own copy; the signature commits the `(gross, fee, net, rate)` tuple so it cannot issue inconsistent records to different peers. Suite `motebit-jcs-ed25519-b64-v1`.
  - `FederationSettlementAnchorProof` (+ `FederationSettlementChainAnchor`) — the self-verifiable Merkle inclusion proof, mirroring `AgentSettlementAnchorProof`: suite-bound `batch_signature`, `siblings`/`layer_sizes`, and the optional `tree_hash_version?` (absent ⇒ `merkle-sha256-plain-v1`, unknown ⇒ reject fail-closed).

  **`@motebit/crypto` (new exports — the FOURTH Merkle consumer):**
  - `verifyFederationSettlementAnchor(record, proof, chainVerifier?)` — the portable peer-audit verifier. A peer holding the signed record, the proof, and the relay's public key verifies offline that the relay anchored exactly that record into a Merkle root (hash → Merkle inclusion → batch signature → optional onchain), dispatching the RFC 6962 leaf/node tags on `proof.tree_hash_version`.
  - `computeFederationSettlementLeaf(record)` — the leaf hash: `canonicalLeaf` over the whole signed record (never a field projection), so producer and holder derive the identical leaf.
  - `signFederationSettlement` / `verifyFederationSettlement` (+ `FEDERATION_SETTLEMENT_RECORD_SUITE`) — sign/verify the record itself.
  - `FEDERATION_SETTLEMENT_ANCHOR_SUITE`, `FederationSettlementAnchorProofFields`, `FederationSettlementAnchorVerifyResult`.

  The convergence replaces the old hand-typed 9-field column projection (a leaf a holder could not reproduce) with the verbatim-artifact hash the per-agent and credential streams already use. The federation producer flips to `merkle-sha256-rfc6962-v2` in the same pass (relay-side change, separate ignored changeset); `relay-federation-v1.md` §7.6 is updated to the converged wire format and §7.6.9 declares the tree-hash version. Backward-compatible: a proof with no `tree_hash_version` resolves to `merkle-sha256-plain-v1`.

- 19d1584: Land the leaf-tag half + the `tree_hash_version?` wire field of the RFC 6962 domain-separation migration (PR1 part 2b — doctrine: `docs/doctrine/merkle-tree-hash-versioning.md`). Additive and dormant: every change is byte-identical under `merkle-sha256-plain-v1` (the absent ⇒ v1 default), so all existing callers and every proof minted to date verify unchanged. No producer emits v2 yet — that lands with the first real producer (agent-settlement) in PR2.

  `@motebit/crypto` gains three exports: `hashLeaf(entry, treeHashVersion?)` — the single dispatch point for the RFC 6962 §2.1 `0x00` leaf-domain tag (the leaf-side mirror of 2a's `0x01` node tag), `canonicalLeaf(value, treeHashVersion?)` — JCS-canonicalize then `hashLeaf` (v1 is byte-identical to `canonicalSha256`), and `resolveTreeHashVersion(raw)` — the verifier-boundary resolver (`absent ⇒ v1`, known ⇒ itself, unknown ⇒ `null` so the caller rejects fail-closed). All four leaf builders route their leaf hash through `canonicalLeaf` (`computeAgentSettlementLeaf`, `computeCredentialLeaf`, `identityLogLeaf`, and the consolidation-anchor leaf via `@motebit/encryption`), and the high-level verifiers (`verifyAgentSettlementAnchor`, `verifyCredentialAnchor`, `verifyConsolidationAnchor`, `verifyIdentityBindingAnchored`) resolve the proof's version at their boundary and thread it to both the leaf builder and the Merkle primitive. Verifiers return false / a fail-closed result on an unknown version (never throw, never silent-downgrade); the producer-side `hashLeaf` throws loud on an unimplemented version.

  `@motebit/protocol` adds the optional `tree_hash_version?: MerkleTreeVersion` wire field to `AgentSettlementAnchorProof`, `CredentialAnchorProof`, and `ConsolidationAnchor`, mirrored in `@motebit/wire-schemas` zod sources and the regenerated `spec/schemas/*.json` (private packages, no version bump). The leaf-tag byte layout is pinned by routing the named `transparency-dev/merkle` `rfc6962_test.go` (`78493b07`) `HashLeaf("L123456")` vector through `hashLeaf` itself, and two end-to-end v2 negative fixtures confirm a stripped `tree_hash_version` is rejected (not silently downgraded): the agent-settlement field-stripped proof fails both hash and Merkle steps, and the consolidation field-stripped anchor fails on Merkle root mismatch.

  `MerkleTreeVersion` becomes the eighth registered registry: the new coverage gate `check-merkle-tree-hash-canonical` (drift-defense #114) is `check-suite-dispatch`-shaped, not vacuous registry self-consistency — it localizes the domain-tag bytes to the two Merkle primitives, asserts every leaf builder routes through `hashLeaf`/`canonicalLeaf` (or sits on a documented exclusion list), keeps the registry ↔ dispatch arms in sync, and carries a dormant Option-A spec-claim arm that activates when the first v2 producer's spec declares it (PR2). `REGISTERED_REGISTRIES` 7 → 8; inventory 115 → 116 invariants, 105 → 106 hard CI gates.

- 9cf876a: Add the `MerkleTreeVersion` tree-hash version registry — the agility axis for Merkle leaf/node domain separation (RFC 6962 §2.1). This is the protocol-layer foundation of the staged migration that gives anchor proofs the leaf-vs-node second-preimage resistance their RFC 6962 citation promises (doctrine: `docs/doctrine/merkle-tree-hash-versioning.md`). Additive and dormant — no consumer wires it yet; the Merkle primitives + the `tree_hash_version` wire field land next, all defaulting absent ⇒ v1 so every existing proof keeps verifying.

  A `MerkleTreeVersion` is a separate axis from `SuiteId`: that names the signature recipe over a batch payload; this names the tree-hash recipe that builds the root the signature commits to. Scope is exactly `(leaf tag, node tag, hash function)` — it does NOT cover payload canonicalization, which versions independently.

  New exports:
  - `MerkleTreeVersion` — closed union: `"merkle-sha256-plain-v1"` (legacy, no domain separation — the original behavior) and `"merkle-sha256-rfc6962-v2"` (RFC 6962 §2.1 `0x00` leaf / `0x01` node tags).
  - `MERKLE_TREE_VERSION_REGISTRY` / `ALL_MERKLE_TREE_VERSIONS` — the frozen registry + iteration array (mirrors `SUITE_REGISTRY` / `ALL_SUITE_IDS`); each entry carries `leafTag` / `nodeTag` (the RFC 6962 prefix bytes, `null` for v1), `hash`, `status`, and a description.
  - `DEFAULT_MERKLE_TREE_VERSION` — `"merkle-sha256-plain-v1"`, the load-bearing downgrade-safety default: a proof with no `tree_hash_version` resolves to v1, never silently upgraded.
  - `isMerkleTreeVersion` / `getMerkleTreeVersionEntry` — type guard + lookup (fail-closed on unknown IDs).
  - `MerkleTreeVersionEntry` / `MerkleTreeVersionStatus` / `MerkleHashFunction` — supporting types.

- 9ca54fd: Add `computeP2pFeeMicro(netCostMicro, feeRate)` — the canonical P2P settlement fee-leg primitive (`gross - net` where `gross = round(net / (1 - feeRate))`, in micro-units). This is interop law on the money path: the relay's `requiresP2pProof` submission validator and the delegator client that builds the payment proof must compute the fee identically, or the proof is rejected (`TASK_P2P_FEE_AMOUNT_MISMATCH`). Hosting it in `@motebit/protocol` (which both the relay and the runtime depend on, but `@motebit/market` is not a runtime dep) gives one source of truth instead of two inline copies that can drift. The relay's `services/relay/src/tasks.ts` validator now consumes it.
- 810175b: Settlement-summary export — the money side of the first-person trust graph (published half; the `@motebit/relay` + `@motebit/panels` half is in the sibling changeset). Doctrine: `docs/doctrine/agents-as-first-person-trust-graph.md` §6.
  - `@motebit/protocol`: `settlement-summary` added to the `ContentArtifactType` registry (14th type) + the `SettlementSummaryExport` / `SettlementSummaryPeer` / `SettlementSummaryUnattributed` wire-body types. A per-peer economic projection over the relay's signed settlement ledger — a materialized projection in micro-units, never a denormalized balance.
  - `@motebit/state-export-client`: `verifiedSettlementSummaryFetch` + `settlementSummaryUrl` — typed, fail-closed verified fetch for `/api/v1/agents/:motebitId/settlements`. Centralizes the URL (so surfaces can't fetch the money history without verifying it) and rejects a manifest signed for a different export (`unexpected_artifact_type`, the new fail-closed reason on `StateExportVerificationFailureReason`).

- 8195e65: Add the optional `SovereignWalletRail.buildP2pPayment?` capability (+ the `SovereignP2pPaymentRequest` port type). It builds a verifiable `P2pPaymentProof` by broadcasting the delegator's atomic multi-leg settlement — the worker leg plus the relay-fee leg(s) — in a single transaction. This is the port the interior consumes so a PAID direct delegation can satisfy the relay's Arc-3.5 P2P-proof gate (`requiresP2pProof`); the reference `SolanaWalletRail` in `@motebit/wallet-solana` implements it via `buildP2pPaymentProof`. The method is optional so existing rails are unaffected and a rail that cannot pay multiple recipients atomically degrades honestly rather than splitting the legs across transactions (the relay verifier walks one `tx_hash`). Single-operator P2P uses two legs; cross-operator federated P2P adds the executor-relay fee leg via the request's `executor*` fields.
- 0f47485: Add the sovereign-wallet-rail port and a chain-agnostic base58 codec to the open protocol surface.
  - `SovereignWalletRail` — a new interface extending `SovereignRail` with the `send(toAddress, microAmount)` and `isAvailable()` operations the interior invokes, plus `SovereignSendResult` (`{ signature, slot, confirmed }`) for the transfer outcome. This is the port the runtime consumes; a concrete rail (`@motebit/wallet-solana`'s `SolanaWalletRail`) satisfies it structurally. The interior defines the port, the provider implements it — the adapter principle as a type.
  - `base58Encode(bytes)` — a pure, chain-agnostic base58btc codec (Bitcoin alphabet; shared by Solana addresses, IPFS CIDv0, etc.), sibling to the `toMicro`/`fromMicro` money converters. NOT a Solana primitive — the "Solana address = base58 of the 32-byte Ed25519 pubkey" knowledge stays at the call site.

  Motivation: the runtime can now derive a sovereign address and consume the wallet rail through these protocol exports, with zero dependency on a settlement-rail provider package. This is what let the fail-closed money/identity coverage-registry membership gate (`check-money-identity-path-canonical`, Amendment-2) move from gated-off to enforced — `@motebit/runtime` no longer imports `@motebit/wallet-solana`.

  Purely additive — no existing export changed.

- 49338ad: Narrow the `suite` field of the last 3 straggler signed-artifact types from the
  wide `SuiteId` union to the single `z.literal` each artifact's wire schema (and
  its committed JSON Schema `$id`) already pins — bringing them in line with the
  ~20 other signed artifacts that already pin a literal:
  - `@motebit/protocol`: `SignedTransparencyDeclaration.suite` and
    `RetentionManifest.suite` → `motebit-jcs-ed25519-hex-v1`;
    `HorizonWitnessRequestBody.suite`, the four DeletionCertificate signature
    envelopes (`SubjectSignature` / `OperatorSignature` / `DelegateSignature` /
    `GuardianSignature`), the `append_only_horizon` cert arm, and
    `SkillManifestMotebit.signature.suite` → `motebit-jcs-ed25519-b64-v1`. The
    `TRANSPARENCY_SUITE` const is correspondingly narrowed (`as const`).
  - `@motebit/crypto`: `DELETION_CERTIFICATE_SUITE` narrowed (`as const`) to match.

  Each artifact emits exactly one suite (per its spec signing recipe); cryptosuite
  agility happens through a new artifact version with a new schema pin, never by
  widening to `SuiteId`. A single literal is assignable into any `SuiteId`-typed
  position, so this is breaking only for an external consumer that assigned a
  non-literal `SuiteId` value to one of these specific fields — which no producer
  does (the suite is per-artifact). Aligns the TS type with the published JSON
  Schema. No runtime or wire change.

### Patch Changes

- c0faba1: Recalibrate coverage thresholds for the vitest-4 `coverage-v8` measurement change. vitest 4's coverage-v8 counts branches/statements more granularly than v2 (notably JSX/conditional branches in render-heavy code), so measured coverage dropped across the workspace even though the actual tests and source are unchanged — the ruler changed, not the code. This is a forced consequence of the vitest-4 security upgrade (closed critical GHSA-5xrq-8626-4rwp; cannot be reverted without re-opening the CVE, and coverage-v8 must match the vitest major). Each failing threshold is set to its new v4-measured floor; passing thresholds are untouched.

  This is a one-time recalibration to a new measurement tool, not a relaxation of the testing bar — the same tests cover the same code. The recalibrated thresholds are a temporary floor: they should be raised back toward the prior targets as coverage improves under the new tool. Money/identity-path packages all stayed ≥80% after recalibration (crypto branches 85, crypto-appattest statements 86, etc.), so none crossed the `coverage-graduation.json` <80% raise-by trigger. Doctrine: `docs/doctrine/foundational-tool-adoption.md` (vitest-4 worked example).

- e3fb1f7: Correct the `MemoryAuditPayload.missed_patterns` doc comment. The field was
  documented as "Sensitivity tags" — misleading: the only producer
  (`detectUntaggedMemoryPatterns` in `@motebit/ai-core`) emits label-prefixed
  pattern strings (`preference: "…"`, `goal: "…"`, `personal_fact: "…"`,
  `correction: "…"`), not `SensitivityLevel` values. The type is and stays
  `ReadonlyArray<string>`; only the comment changes. The misleading comment had
  led the wire schema to validate `missed_patterns` as `z.array(SensitivityLevel)`,
  which would have rejected every real `MemoryAudit` event — fixed in
  `@motebit/wire-schemas` in the same pass.
- 882b392: Upgrade the test runner from vitest 2.1.9 to 4.1.8 (with @vitest/coverage-v8), closing critical advisory GHSA-5xrq-8626-4rwp (Vitest UI server arbitrary file read/execute, fixed in 4.1.0). This is a dev-dependency change only — no runtime, API, or wire-format change to any published package; the bump is recorded as a patch because each package's published `package.json` devDependencies move to vitest ^4.1.8.

  vitest 4 bundles vite (^6 || ^7 || ^8), so the existing vite-^6 surfaces, jsdom 25, and @types/node ^22 are unchanged. Test-only migration fallout was handled in the same change: `ViteUserConfig` rename in the shared config, typed-mock assignability under v4 (`vi.fn()` now `Mock<Procedure|Constructable>`), constructor mocks converted from arrows to `function` (v4 disallows `new` on arrow mock implementations), the removed `environmentMatchGlobs` replaced by the per-file `@vitest-environment` directive, and an explicit `dist/` test-exclude restored for the one config-less package (vitest 4's default `exclude` no longer covers `dist/`).

## 2.0.1

### Patch Changes

- 0d031b9: Re-target five past-due deprecation sunsets from `removed in 2.0.0` to `removed in 3.0.0`. These symbols (sdk `OLLAMA_SUGGESTED_MODELS` / `OllamaSuggestedModel`, crypto's `VerifyResult` alias + the typed `verify` overload, protocol's trust-thresholds alias) were promised for removal in 2.0.0 but 2.0.0 shipped with them still present. 2.0.0 is immutable on npm and removing a public export is breaking (major-only), so the honest fix is to keep the trivial since-1.0.0 aliases through 2.x and remove them at the next real 3.0.0. Comment-only change — no API or behavior change.

## 2.0.0

### Major Changes

- b0d068b: Introduce `WithdrawableGuestRail extends GuestRail` marker interface; remove `withdraw()` and `withdrawBatch?()` from the `GuestRail` base. Arc 1 Commit 2 of the off-ramp arc (sibling of `path-0-solana-sovereign-withdrawal` changeset). Same shape as the existing `DepositableGuestRail` / `BatchableGuestRail` discriminant-narrowing pattern, applied to the withdrawal axis.

  **Why this is a major bump.** `withdraw()` is no longer on the base `GuestRail` interface — any external code that called `someRail.withdraw(...)` after typing the variable as bare `GuestRail` will fail to compile. The migration is mechanical (narrow through `isWithdrawableRail()` before calling) but it IS a breaking change in the public surface.

  **Why this matters doctrinally.** The off-ramp arc's load-bearing invariant is _"Motebit is not a transmitter of user funds."_ Path 0 (Arc 1 Commit 1) made the sovereign return-of-custody path the structurally-preferred route. This commit makes the previously-bank-shaped fallback (Bridge user withdrawal) structurally impossible: `BridgeSettlementRail` cannot satisfy `WithdrawableGuestRail` because it carries `supportsWithdraw: false` and the `withdraw` method has been removed at the package level. The fence isn't a drift gate or a type narrowing at a single call site — it's the absence of the method on the type itself. Anywhere in the workspace, anywhere in any future contributor's code, `bridgeRail.withdraw(...)` is a compile error because the method does not exist.

  ## Migration

  Before:

  ```ts
  import type { GuestRail } from "@motebit/protocol";

  function autoSettleWithdrawal(rail: GuestRail, ...args) {
    return rail.withdraw(motebitId, amount, currency, destination, idempotencyKey);
  }
  ```

  After:

  ```ts
  import type { GuestRail, WithdrawableGuestRail } from "@motebit/protocol";
  import { isWithdrawableRail } from "@motebit/protocol";

  function autoSettleWithdrawal(rail: GuestRail, ...args) {
    if (!isWithdrawableRail(rail)) {
      // Rail is registered for something other than user-facing withdrawal
      // (treasury orchestration, deposit intake). Skip or route elsewhere.
      return null;
    }
    // After narrowing, `rail` is `WithdrawableGuestRail` and `withdraw` is callable.
    return rail.withdraw(motebitId, amount, currency, destination, idempotencyKey);
  }

  // Alternatively, type the parameter as WithdrawableGuestRail directly
  // when the caller has already done the narrowing:
  function fireWithdrawal(rail: WithdrawableGuestRail, ...args) {
    return rail.withdraw(motebitId, amount, currency, destination, idempotencyKey);
  }
  ```

  Rails that previously implemented `GuestRail` with a `withdraw()` method must now declare `implements WithdrawableGuestRail` instead, and add `readonly supportsWithdraw = true as const` alongside the existing `supportsDeposit` / `supportsBatch` discriminants. Rails that are registered for non-user-facing purposes (treasury orchestration, deposit-only, anchor submission) should declare `readonly supportsWithdraw = false as const` and either delete their `withdraw()` method or leave it undeclared — the structural absence IS the invariant.

  The `BatchableGuestRail` interface now extends `WithdrawableGuestRail` (batch is a specialization of single withdraw). Batchable rails must implement both `supportsWithdraw: true` and `supportsBatch: true`.

  **Rationale.** Marker-interface narrowing is the strongest structural enforcement available — stronger than drift gates (which catch at CI), stronger than type fences at a single dispatch site (which the next refactor can route around), stronger than `@deprecated` JSDoc (which compiles fine). The method's absence from the type IS the negative-proof. The pattern is already used in this package for deposit (`DepositableGuestRail`) and batch (`BatchableGuestRail`); the withdrawal axis now follows the same shape.

  **Reference consumers** (not in changeset scope): `@motebit/settlement-rails` (major bump in its own changeset — `BridgeSettlementRail.withdraw` removed) and `services/relay/src/budget.ts` (Path 2 dispatch + Bridge webhook handler deleted; Path 1 narrows through `isWithdrawableRail`).

- a5abc51: Arc 2 of the off-ramp arc — P2P fee leg now composes as a direct delegator→treasury leg in the same atomic Solana multi-output tx. `P2pPaymentProof` gains required `fee_to_address` + `fee_amount_micro` fields. `TxVerificationResult.confirmed` shape evolves from single-recipient `{from, to, amountMicro}` to `{from, transfers[]}` to support multi-recipient transactions cleanly. New `ConfirmedTransferLeg` type exported alongside.

  **Why this is a major bump.** Two breaking shape changes:
  1. `P2pPaymentProof.fee_to_address` and `P2pPaymentProof.fee_amount_micro` are required (not optional). Pre-Arc-2 callers that constructed `P2pPaymentProof` without these fields will fail to typecheck. The wire-format change is the structural enforcement: a delegator's P2P task submission cannot omit the fee leg because the type system rejects it. Closes the sibling-doc contradiction the settlement_mode arc surfaced (`CLAUDE.md` "5% applies through both lanes" vs `services/relay/CLAUDE.md` rule 8's pre-Arc-2 "Fee: zero on P2P").
  2. `TxVerificationResult.confirmed` variant changed from `{from, to, amountMicro, slot, asset}` to `{from, transfers: ConfirmedTransferLeg[], slot, asset}`. Consumers that read `result.amountMicro` or `result.to` now read `result.transfers[i].amountMicro` / `result.transfers[i].to`. Multi-recipient transactions are now first-class (no longer rejected as `not_found`); single-payer is still required (multi-payer remains ambiguous). The only authorized consumer of this surface (`services/relay/src/p2p-verifier.ts`) was updated in the same arc.

  ## Migration

  `P2pPaymentProof` before:

  ```ts
  const proof: P2pPaymentProof = {
    tx_hash,
    chain,
    network,
    to_address: workerSolanaAddress,
    amount_micro: workerNetMicro,
  };
  ```

  After:

  ```ts
  import { deriveSolanaAddress } from "@motebit/wallet-solana";

  const proof: P2pPaymentProof = {
    tx_hash,
    chain,
    network,
    to_address: workerSolanaAddress,
    amount_micro: workerNetMicro,
    // NEW — required after Arc 2. Treasury address derives from the
    // relay's published Ed25519 public key.
    fee_to_address: deriveSolanaAddress(relayPublicKeyBytes),
    fee_amount_micro: Math.round(workerNetMicro / (1 - platformFeeRate)) - workerNetMicro,
  };
  ```

  The delegator's runtime must construct a single atomic Solana transaction with TWO SPL Transfer instructions: one to `to_address` for `amount_micro`, one to `fee_to_address` for `fee_amount_micro`. Both signed by the same delegator keypair. The relay's `p2p-verifier` walks `transfers[]` on the tx and validates both legs match the declared amounts + addresses.

  `TxVerificationResult` before:

  ```ts
  const r = await adapter.getTransaction(sig);
  if (r.status === "confirmed") {
    console.log(r.from, "→", r.to, ":", r.amountMicro);
  }
  ```

  After:

  ```ts
  const r = await adapter.getTransaction(sig);
  if (r.status === "confirmed") {
    for (const leg of r.transfers) {
      console.log(r.from, "→", leg.to, ":", leg.amountMicro);
    }
  }
  ```

  **Rationale.** The atomic multi-output composition is the doctrinally-clean answer to the sibling-doc contradiction surfaced during the settlement_mode arc. The five-iteration discipline converged on Option 2 (delegator-pays-relay-direct) over Options 1 (worker-pays-relay) or 3 (no settlement fee). Option 2 preserves the `endgame_architecture` 5%-at-settlement-checkpoint moat on every settlement while keeping the relay structurally out of the user-funds custody chain. The fee leg is the relay's own service-revenue collection (not held in trust for anyone) — distinguishable from FinCEN money transmission by the same logic that makes a vendor invoice payment legitimate.

  Doctrine: [`docs/doctrine/off-ramp-as-user-action.md`](../docs/doctrine/off-ramp-as-user-action.md) "What Arc 1 did NOT close" → Arc 2 shipped section.

- 343e81f: Add `settlement_mode: SettlementMode` as a required field on the signed `SettlementRecord` body — lane discriminant (`"relay"` vs `"p2p"`) is now part of the relay's attestation, not derivable from sibling fields. Doctrine: [`docs/doctrine/settlement-rails.md`](https://github.com/motebit/motebit/blob/main/docs/doctrine/settlement-rails.md) § "Lanes for external readers".

  **Why this is a major bump.** Adding a required field to an interface is a breaking change for any caller constructing a `SettlementRecord` (directly or through `signSettlement(Omit<SettlementRecord, "signature" | "suite">, ...)`). External code that built receipts under the prior shape will fail to typecheck until it supplies the new field.

  The custody split was already enforced at the type level (`GuestRail` vs `SovereignRail`), and the agent-registry already carried `settlement_modes: "relay" | "p2p"`, but the lane was missing from the per-settlement signed body. An auditor reading a `SettlementRecord` previously had to derive the custody posture from `custody × settlement_mode-on-table × x402_tx_hash-presence`. Now the lane is a required wire field on the signed receipt: instantly legible, signed into the canonical bytes, and structurally impossible for a relay to silently relabel after the fact.

  Putting the lane inside the signature commits the relay to a specific custody posture per settlement. Tamper with `settlement_mode` and the Ed25519 signature stops verifying — same self-attestation contract as `amount_settled` and `platform_fee_rate`. This closes the legibility-but-not-architecture gap: graduation from `"relay"` to `"p2p"` was already mechanized via `evaluateSettlementEligibility`, but the lane chosen for each individual settlement was inferred, not declared.

  **Reuses an existing registry.** `SettlementMode` is the seventh registered registry per [`registry-pattern-canonical.md`](https://github.com/motebit/motebit/blob/main/docs/doctrine/registry-pattern-canonical.md) — promoted 2026-05-15. This change adds a new wire-format consumer of the existing closed union; no new vocabulary, no new registry, no naming drift. `"treasury"` is deliberately not a member: treasury reconciliation is structurally a different audit shape (own-account operator fee accrual vs onchain balance) and never appears as a settlement lane.

  ## Migration

  Before:

  ```ts
  const record: SettlementRecord = {
    settlement_id,
    allocation_id,
    receipt_hash,
    ledger_hash,
    amount_settled,
    platform_fee,
    platform_fee_rate,
    status: "completed",
    settled_at,
    issuer_relay_id,
    suite: "motebit-jcs-ed25519-b64-v1",
    signature,
  };
  ```

  After:

  ```ts
  const record: SettlementRecord = {
    settlement_id,
    allocation_id,
    receipt_hash,
    ledger_hash,
    amount_settled,
    platform_fee,
    platform_fee_rate,
    settlement_mode: "relay", // NEW — required; "relay" or "p2p"
    status: "completed",
    settled_at,
    issuer_relay_id,
    suite: "motebit-jcs-ed25519-b64-v1",
    signature,
  };
  ```

  Pick the lane by custody intent: `"relay"` when the relay holds the money (virtual-account credit/debit on its books — the default for guest-rail settlement), `"p2p"` when funds move agent-to-agent onchain via a `SovereignRail` and the relay records the audit only.

  If you read pre-migration rows from a database, default to `"relay"` — the prior schema's only persisted lane was relay-custody since p2p audit rows already wrote their lane explicitly via raw SQL.

  Rationale: the lane belongs in the signed body, not in storage-side metadata. A relay that custodied a settlement cannot retroactively relabel it as p2p; the signature commits the relay to its claimed custody posture. Auditors and counsel reading a single `SettlementRecord` should see the lane directly without consulting sibling fields or table-level defaults.

### Minor Changes

- 92c2800: Arc 3 of the off-ramp arc — type-level scaffolding for closing the in-flow direction of user funds. Introduces:

  **`WritableSettlementMode`** — `type WritableSettlementMode = Extract<SettlementMode, "p2p">`. The asymmetric-typing enforcement shape: reads accept the full `SettlementMode` union (legacy `"relay"` rows must remain readable for audit + verifier + federation compat); writes are structurally restricted to `"p2p"`. Documents the post-Arc-3 architectural intent that new worker-settlement code should write only `"p2p"`. The Layer 1 enforcement shape is documentary at land — the type is exported and consumed at the `SettlementEligibility` result; future arcs (Arc 3.5, multi-hop-as-P2P) tighten the operational enforcement by adopting the narrow type at write sites.

  **`SettlementEligibility`** evolves from `{ allowed: boolean; mode: SettlementMode; reason: string }` to a disjunctive shape:

  ```ts
  type SettlementEligibility =
    | { allowed: true; mode: WritableSettlementMode; reason: string }
    | { allowed: false; reason: string };
  ```

  The allowed branch carries `mode: "p2p"` (the only `WritableSettlementMode` value); the disallowed branch has no `mode` field because there's no fallback rail to route to (Arc 3 collapsed the relay-custody fallback for eligible-pair checks). Consumers that destructure `mode` must narrow via `if (result.allowed)` first — the type forces explicit handling of the disallowed case.

  **Migration**: callers that read `result.mode` directly will fail to typecheck. Narrow via `if (result.allowed) { ... result.mode ... }`. Pre-Arc-3 callers that wrote `mode: "relay"` on the disallowed branch are no longer valid — disallowed has no mode field.

  **Composition with prior arcs**: this is the third enforcement shape in the off-ramp arc's Layer 1 library. Arc 1 demonstrated surface deletion (`BridgeSettlementRail.withdraw` removed entirely) + marker interface (`WithdrawableGuestRail`). Arc 3 demonstrates asymmetric typing — the shape to reach for when reads must stay open but writes must be closed (legacy compat + structural future-closure). See the [`architecture_disjointness_by_construction`](../../../../../.claude/projects/-Users-daniel-src-motebit/memory/architecture_disjointness_by_construction.md) memory for the full six-shape library and the meta-principle.

  **Companion** (not in changeset scope — relay is ignored): `services/relay/src/task-routing.ts` `evaluateSettlementEligibility` rewrites to the disjunctive form with established-pair branch (trust ≥ 0.6 AND interactions ≥ 5) OR new-pair branch (`delegatorAcknowledgesNoHistoryRisk` parameter). `services/relay/src/tasks.ts` task-submission payload gains optional `delegator_acknowledges_no_history_risk?: boolean` field that flows through to the eligibility check. The disjunctive gate solves the cold-start problem (new workers with no trust history) via explicit delegator consent rather than weakening the trust algebra with a free-starting-trust hack — see [`trust_as_economic_membrane`](../../../../../.claude/projects/-Users-daniel-src-motebit/memory/trust_as_economic_membrane.md) for the structural-floor-plus-economic-ceiling pattern.

  **Arc 3.5 deferred**: the operational submission gate (`TASK_P2P_PROOF_REQUIRED` — reject paid direct delegation without payment_proof) was prototyped during Arc 3 implementation but rolled back because it breaks 32 existing E2E tests that exercise the relay-custody path as legacy contract. Migrating the test suite + production delegator clients to construct P2P payment_proofs for every paid direct delegation is its own bounded arc (Arc 3.5). Until then, paid direct delegation can still use the relay-custody path; new delegator clients SHOULD prefer P2P but aren't structurally required to. The structural enforcement at the protocol type level is in place; the submission-boundary enforcement lands in Arc 3.5.

  Doctrine: [`docs/doctrine/off-ramp-as-user-action.md`](../docs/doctrine/off-ramp-as-user-action.md) § "Arc 3 scope and Arc 3.5 deferred" + "Arc 3 carve-outs."

- 6a46f33: Auto-router as protocol primitive — `f(TaskShape × ProviderCapability × Constraints) → RoutingDecision`. Additive types for the model-selection primitive (drift gate #95, doctrine memo `auto-routing-as-protocol-primitive.md`).

  New exports:

  ```ts
  type TaskShape = "quick" | "chat" | "reasoning" | "code" | "research" | "creative" | "math";
  type InferenceHost = "anthropic" | "openai" | "google" | "groq"; // lifted from services/proxy
  type ModelLab = "anthropic" | "openai" | "google" | "meta"; // lifted from services/proxy
  type Jurisdiction = "US" | "CN" | "EU"; // lifted from services/proxy
  interface ProviderCapability {
    modelName;
    host;
    lab;
    jurisdiction;
    inputCostPerMillion;
    outputCostPerMillion;
  }
  interface RoutingConstraint {
    jurisdiction?;
    maxInputCostPerMillion?;
    maxOutputCostPerMillion?;
    requiresToolUse?;
    sensitivityCeiling?;
  }
  type RoutingDecision =
    | { kind: "route"; model; reason }
    | { kind: "fallback"; primary; backup; reason }
    | { kind: "deny"; reason };
  ```

  Plus `ALL_TASK_SHAPES` frozen iteration, `isTaskShape` type guard, named constants per shape (`QUICK_TASK_SHAPE`, etc.). Additive — no existing exports renamed or removed.

  The `InferenceHost` / `ModelLab` / `Jurisdiction` unions were previously declared in `services/proxy/src/validation.ts`; lifting them here makes the auto-router primitive in `@motebit/policy` consumable across motebit-cloud (proxy, PR 1), BYOK (PR 2), and on-device (PR 3) consumers. The proxy re-exports the unions for back-compat with proxy-internal callers; new code imports from `@motebit/protocol` directly.

  The dispatcher itself (`dispatchRouting`, `applyBalanceFilter`, `REFERENCE_ROUTING_POLICY`) lives in `@motebit/policy` (private/BSL — separate ignored changeset). Three-instance-deep endgame validation (motebit-cloud / BYOK / on-device) mirrors chrome-as-state-render's web/mobile/spatial rollout.

  Drift gate `check-routing-decision-coverage` (#95) enforces consumer registry. `TaskShape` literal coverage is TypeScript-enforced via the dispatcher's exhaustive switch with `never` fallthrough — gate doesn't scan it (redundant ceremony). Inventory: 96 → 97 invariants, 86 → 87 hard CI gates.

  Doctrine: `docs/doctrine/auto-routing-as-protocol-primitive.md` (PR 1 scope, three-instance endgame validation, role-vs-policy distinction). `agility-as-role.md` extends from 6 → 7 instances: `TaskShape` is the role (closed registry); routing-policy is a consumer-side function — NOT a role. The plan-review session that produced this PR caught the role/policy conflation in an earlier draft; the correction is preserved in the doctrine.

- 53e11b5: `EventType` promoted to canonical registry (sixth registered registry per `docs/doctrine/registry-pattern-canonical.md`). Additive, non-breaking: the existing enum + 59 entries are preserved; new exports are `ALL_EVENT_TYPES` (frozen iteration array, declaration order) and `isEventType` (type guard narrowing `unknown` to `EventType`). Same shape as `ALL_TASK_SHAPES` + `isTaskShape`, `ALL_SENSITIVITY_LEVELS` + `isSensitivityLevel`.

  First template-growth proof of the meta-gate (`check-closed-registry-canonical`, #98) — the doctrine's claim that adding a sixth registry is mechanical-not-design holds. New per-registry coverage gate `check-event-type-canonical` (#99) enforces the three-way structural lock between the enum, `ALL_EVENT_TYPES`, and the gate's mirror; wire-format compliance verifies all 59 values are snake_case identifier-shaped. `REGISTERED_REGISTRIES` advances from 5 → 6 entries.

- 2428248: Add `"goal-result"` as the 13th entry in the closed `ContentArtifactType` registry — the **first non-relay-state-export consumer** of the C2PA-shape content-provenance primitive. The prior twelve entries are all relay-assembled state-export bundles signed by `relayIdentity`; `goal-result` is signed by the **agent's** motebit identity at fire-time (per the goal-results Phase 3 doctrine close, `docs/doctrine/goal-results.md` §"Phase 3").

  The registry's stated semantic generalizes cleanly — "content-artifact category for C2PA-shape provenance," not "relay state-export bundle." The producer-identity dimension is orthogonal to the category dimension: same JCS-canonical signing, same suite-dispatch verification, same `motebit-verify content-artifact` CLI entry point; just a different signer. Future motebit-direct artifacts (chat-bundle exports, generated documents, tool-call-result bundles) compose against this same shape without further registry expansion.

  New exports:
  - `"goal-result"` literal added to the `ContentArtifactType` union.
  - `GOAL_RESULT_ARTIFACT` named constant.
  - `ALL_CONTENT_ARTIFACT_TYPES` iteration array gains the new entry.

  The runtime helper that consumes the new type (`@motebit/runtime::signGoalArtifact(content, { goalId, runId })`) wraps the artifact bytes via `signContentArtifact` from `@motebit/crypto` (pinned suite `motebit-jcs-ed25519-hex-v1`). Identity-load-pending fires return `null` fail-safe — never silently sign with a placeholder. Drift gate `check-artifact-type-canonical` mirrors the registry addition (scanned 896 files; passes).

  Sibling doctrine updates:
  - `docs/doctrine/goal-results.md` §"Phase 3" marked SHIPPED 2026-05-14.
  - `docs/doctrine/receipts-unified.md` table extended (`ContentArtifactManifest` signer column now reads "Relay identity **or** agent (`goal-result`)").
  - `docs/doctrine/nist-alignment.md` §8 gains "First non-relay-state-export consumer shipped 2026-05-14" paragraph naming the expansion + the verifier auto-support path + which drift gates scope to which producer (`check-state-export-signed` only to relay; `check-artifact-type-canonical` to both).

  Test `artifact-type.test.ts` count assertion adjusted 12→13; named-constant enumeration updated.

- f1d3308: Land the on-device auto-routing primitive — third-consumer half of the auto-router PR-3 arc (doctrine: `docs/doctrine/auto-routing-as-protocol-primitive.md` § "Three-instance endgame"). PR 1 (2026-05-13) shipped motebit-cloud-proxy; PR 2 (2026-05-14) shipped BYOK across web/desktop/mobile; PR 3 (this commit) closes the three-instance-deep validation by landing the third concrete consumer with fundamentally different cost semantics: zero marginal $/token (on-device runs on user hardware), no balance filter, no jurisdiction filter (the user's device IS the jurisdiction), dynamic catalog (what's installed locally varies per user).

  The architectural payoff: validates the doctrine claim that `dispatchRouting(TaskShape × ProviderCapability × Constraints) → RoutingDecision` is consumer-neutral across all three sovereignty postures, not just two. With PR 1 + PR 2, the role-as-instance pattern (7th instance of `agility-as-role.md`) had two consumers — same risk shape as a 2-instance closed registry. PR 3 makes it three. Same dispatcher, same `RoutingDecision` discriminated union, same `REFERENCE_ROUTING_POLICY`, same closed `TaskShape` registry — across three consumers with three fundamentally different cost models (subscription / pay-per-call / zero-marginal).

  **`@motebit/protocol`** — closed-registry expansions for the on-device case:
  - `InferenceHost` += `"local-server"`. The on-device case: requests route to the user's own inference server (Ollama, LM Studio, llama.cpp, Jan, vLLM, text-generation-webui — all expose `/v1/chat/completions` via the OpenAI-compat shim). Mirrors the `OnDeviceBackend` value of the same name in `@motebit/sdk`. The proxy NEVER routes to `local-server` — defensive arms in `services/proxy/src/app/v1/messages/route.ts::getProviderApiKey` (returns null) and `buildProviderRequest` (throws) name the structural violation rather than silently degrading.
  - `ModelLab` += `"mistral" | "microsoft" | "alibaba"`. The labs the canonical `LOCAL_SERVER_SUGGESTED_MODELS` set draws from: Mistral AI trains Mistral, Microsoft trains Phi-3, Alibaba trains Qwen2. The proxy never sees these labs (it doesn't host their models); the registry expansion is purely consumer-side (the on-device dispatcher's catalog), which is why the registry's stated semantic "who trained the weights" generalizes cleanly without protocol-layer churn.

  **`@motebit/policy`** — new on-device router primitive (`on-device-router.ts`):
  - `ON_DEVICE_MODEL_CATALOG: Record<OnDeviceBackend, readonly ProviderCapability[]>` — per-backend `ProviderCapability` catalog. Single populated backend today is `local-server` with 8 entries (Llama 3.2 / 3.1 / 3, Mistral, Codellama, Gemma2, Phi-3, Qwen2 — mirrors `LOCAL_SERVER_SUGGESTED_MODELS` in `@motebit/sdk/models.ts`). Single-model backends (`webllm`, `apple-fm`, `mlx`) ship empty catalogs by design — they're surfaces where the user picks one model at config time. All `local-server` entries have `inputCostPerMillion: 0` + `outputCostPerMillion: 0` (the truthful representation of marginal cost on user hardware) and `host: "local-server"` (the new InferenceHost registry entry). `as const satisfies Record<OnDeviceBackend, ...>` enforces backend coverage structurally.
  - `buildOnDeviceCatalog(backend)` — pure dispatch on the union.
  - `dispatchOnDeviceRouting(text, backend, constraints?)` — composed entry point. Reuses `extractTaskShape` from `byok-router.ts` (the heuristic detector is the right shape for any consumer that can't afford per-message LLM classification). Returns `RoutingDecision`; surfaces handle all three discriminator values.

  Single-model backends return `{ kind: "deny" }` from the dispatcher because their catalog is empty — the honest signal ("nothing to auto-route across"). The same `RoutingDecision.kind === "deny"` channel covers both "constraints empty the catalog" (BYOK) and "catalog was empty to begin with" (on-device single-model). One shape; two semantic origins.

  Coverage: 11 new tests under `__tests__/on-device-router.test.ts`, pure-function. Tests pin (a) backend coverage of `OnDeviceBackend`, (b) the zero-marginal-cost invariant, (c) every catalog entry routes through `host: "local-server"` (defense against a future bug smuggling a remote-host entry into the on-device catalog), (d) lab-coverage invariant matching `LOCAL_SERVER_SUGGESTED_MODELS`, (e) the composed dispatcher's behavior across the multi-model `local-server` path AND the single-model paths (which deny by design).

  What this commit deliberately defers to commit B (sibling, this week):
  - Desktop on-device consumer wire-up — `_onDeviceAutoRouteBackend` field on `DesktopApp`, `OnDeviceProviderConfig.autoRoute` flag in sdk, per-turn dispatch in desktop's `sendMessageStreaming`, drift-gate `on-device-runtime-desktop` consumer registration, doctrine PR 3 close. Land alongside the verifiable end-to-end consumer site.
  - Web / mobile on-device mirror. Same shape as desktop; cross-surface mirror per one-pass-delivery follows when there's verifiable signal. Web's WebLLM path has download-cost per model swap making per-turn routing inappropriate; mobile's local-server is less common today than desktop's.

- 904d744: `ProviderCapability` gains an optional `contextWindowTokens?: number` field per the new
  [`intelligence-pluggability-contract`](../docs/doctrine/intelligence-pluggability-contract.md)
  doctrine. Consumers performing pre-flight admission read this to decide whether the
  selected model can carry the assembled prompt before invoking it:

  ```text
  systemPromptBudget + toolSchemaBudget + renderedStateBudget + userMessageReserve + outputReserve
    ≤ providerCapability.contextWindowTokens
  ```

  Auto-routing dispatch does not consume this field today — it is a sibling deny semantic to
  auto-router deny: "I cannot pick among catalog entries" (auto-routing) vs "the picked
  model cannot carry the assembled prompt" (admission). The two share one calm-software
  surface via the chrome's `routingNarration` slot but answer different questions.

  Additive + optional. No existing consumer or implementer breaks.

- 91b582e: Bi-temporal validity wire fields (memory-delta-v1 §3.5): optional `valid_from` / `valid_until` on `MemoryFormedPayload` and `superseded_valid_until` on `MemoryConsolidatedPayload`. Additive — pre-existing memory events replay unchanged. These let a memory's validity interval (already tracked in-store via `MemoryContent.valid_from`/`valid_until`) sync across devices and federation, not just live locally; supersession carries the validity-time at which the superseded belief ended so peers close the same interval.
- 4ea0127: Add `SensitivityCleared<T>` phantom-type brand to `packages/protocol/src/sensitivity.ts`. Pure type-level precondition: `T` carrying an opaque type-level proof that `assertSensitivityPermitsAiCall()` fired before the value was produced. Symbol is `declare const`-only (no runtime), so the brand can be produced only via an explicit `as SensitivityCleared<T>` cast — and that cast lives inside the runtime's gate implementation as the single authorized production site.

  **Layer 1 promotion of the privacy doctrine** ("Medical/financial/secret never reach external AI"). The brand sits on the `MotebitLoopDependencies` parameter of `runTurn` / `runTurnStreaming` in `@motebit/ai-core`, propagating through every indirect AI-egress path (`StreamingManager` resume-after-tool-approval in `@motebit/runtime`, `PlanEngine` per-step execution in `@motebit/planner`). Any code that reaches `runTurn` without threading the brand from a gate-firing producer is now a compile error — closes the off-gate cross-file and cross-package paths that the static `check-sensitivity-routing` drift gate cannot scan.

  **Third Layer 1 promotion mechanism** in motebit's idiom — distinct from the view-type pattern (`BootedApp = Omit<WebApp, ...>` for callsite enforcement) and the phase-typing pattern (`UnbootedWebApp.bootstrap() → WebApp` for state-machine enforcement). Branded preconditions encode "you did X before consuming Y" at the type system; the production site is the only privileged cast, consumers are structurally locked to typed proof.

  The static `check-sensitivity-routing` gate stays for `provider.generate(...)` direct calls (housekeeping completions: title generation, summarization, classification). Brand-typing for that family is a future arc — separate signature change with its own propagation surface.

  Additive change. No existing consumer breaks; the brand is opt-in for callers that want to require it on their parameters.

- 46189c6: Add `"summarizeConversation"` and `"runReflection"` to the `SensitivityGateEntry` closed union in `packages/protocol/src/perception.ts`. Third category of sub-axis entries (alongside direct AI-call entries and indirect continuation-site entries from the prior sub-axis arc): **indirect AI-call entries (housekeeping sites)** — the runtime fires the gate on background AI work that doesn't go through `runtime.generateCompletion`'s surface-facing path.

  Pre-this-change, two cross-package direct-provider-call sites had **no gate enforcement at all**:
  - `ConversationManager.summarize` / `runSummarization` (in `@motebit/runtime`) reached `summarizeConversation` (in `@motebit/ai-core`) with an unbranded provider lookup via `getProvider()`. Full conversation history fed to the AI with no sensitivity gate.
  - `MotebitRuntime.reflect` / `reflectAndStore` reached `performReflection` (in `@motebit/reflection`) which read its provider via `deps.getProvider()`. History + memories + past reflections + audit summary composed into the prompt with no gate.

  Both are bytes-leave moments with payload shapes meaningfully richer than `generateCompletion` (single-shot prompt). Reusing `"generateCompletion"` as the audit entry would conflate the housekeeping bundle category and hide the actual blocked site from a forensic consumer. The doctrinally accurate split names the actual entry — same justification that drove the prior `"resumeAfterToolApproval"` / `"executePlanStep"` continuation-site split.

  Sub-axis refinement (not a registered registry) — the eight-artifact obligation does not apply. The union grew 7 → 9 across the two sub-axis arcs landed 2026-05-16.

  Additive change: existing consumers of `SensitivityGateEntry` continue to compile against the wider union; no wire-format break (the payload field type widens but every previously-valid value remains valid).

- 00585fc: Add `"resumeAfterToolApproval"` and `"executePlanStep"` to the `SensitivityGateEntry` closed union in `packages/protocol/src/perception.ts`. Sub-axis refinement (not a registered registry) — the union enumerates indirect-entry-point identifiers for audit, not an interop-law typed vocabulary; the doctrine for the structural-lock pattern with bespoke coverage applies.

  Pre-this-change, the runtime's two indirect-entry call sites borrowed `"sendMessageStreaming"` as the audit label: `StreamingManager.resumeAfterApproval` (continuation after the user approves a paused tool call) and `PlanExecutionManager.executePlan` / `resumePlan` (per-step plan execution and resume). Both are bytes-leave moments and both fire the sensitivity gate, but the audit trail attributed every blocked egress to the surface-facing `sendMessageStreaming` entry — a consumer trying to localize a leak risk to "which continuation site went sovereign-blocked" had to cross-reference the stack rather than read the entry.

  The two new entries split the audit category:
  - `"resumeAfterToolApproval"` — `StreamingManager.resumeAfterApproval`. Sensitivity may have elevated during the pause for approval (a slab item dropped, a tier-bounded tool result observed); the dedicated entry attributes the blocked egress to the actual continuation site.
  - `"executePlanStep"` — `PlanExecutionManager.executePlan` and `PlanExecutionManager.resumePlan`. Both fire the gate per-step. Single audit category for "the gate firing for a plan-step's bytes-leave moment" — initial execute and post-pause resume share the same audit identity.

  Additive change: existing consumers of `SensitivityGateEntry` (audit projection in `@motebit/panels`, gate-fired tests in `@motebit/runtime`) continue to compile against the wider union. No wire-format break — the payload field type widens but every previously-valid value remains valid.

- 7dd54da: Canonical registry tooling for `SensitivityLevel` (additive). `ALL_SENSITIVITY_LEVELS` (frozen iteration array, ordered `none` → `secret`) and `isSensitivityLevel` (type guard, narrows `unknown` to `SensitivityLevel`) land alongside the existing enum + `SENSITIVITY_RANK` algebra. Same shape as `ALL_SUITE_IDS` + `isSuiteId`, `ALL_TOKEN_AUDIENCES` + `isTokenAudience`, `ALL_CONTENT_ARTIFACT_TYPES` + `isContentArtifactType`, `ALL_TASK_SHAPES` + `isTaskShape`.

  Closes the asymmetry surfaced by the registry-gate-family audit on 2026-05-14: `SensitivityLevel` was the only top-tier closed registry without the canonical `ALL_X` + `isX` iteration + guard pair. The new drift gate `check-sensitivity-canonical` (#97) holds the four-way structural lock between the enum, the iteration array, `SENSITIVITY_RANK`, and the gate's own reference mirror — a tier insertion is intentional protocol-level work across all four sites. The enum and all existing exports are preserved; no breaking changes.

- be9275a: Sub-phase A of the asset-pluggability commitment named in [`docs/doctrine/off-ramp-as-user-action.md`](../docs/doctrine/off-ramp-as-user-action.md) § "The settlement-asset registry — sub-phase A SHIPPED."

  **`SettlementAsset`** — closed union `type SettlementAsset = "USDC"`. Single member at land — USDC is the bootstrap stablecoin. The vocabulary IS the interop boundary: a third-party motebit receiving a sovereign-rail announcement with an unknown asset (`"USDT"`, `"DAI"`) must fail-closed at the type guard, not silently treat it as a settlement asset.

  **`ALL_SETTLEMENT_ASSETS`** — frozen iteration array, same shape as `ALL_SETTLEMENT_MODES` / `ALL_EVENT_TYPES`.

  **`isSettlementAsset(value: unknown): value is SettlementAsset`** — type guard for narrowing wire-format payloads at intake (discovery responses, signed `SovereignRail` declarations, peer-negotiation messages).

  **`SovereignRail.asset` tightened from `string` to `SettlementAsset`** — the structural enforcement site. Reads remain backwards-compatible (a `SettlementAsset` value is still a `string`); implementers of `SovereignRail` outside the monorepo must now produce a value assignable to the closed union. The single in-tree implementer (`SolanaWalletRail` in `@motebit/wallet-solana`) already declared `asset = "USDC" as const`, so no implementation change was required. Adopters of `SovereignRail` who produce an unknown asset symbol will see a TypeScript error and must either register their asset (sub-phase B) or wrap in an adapter.

  **Sub-phase B (deferred)** — promotion to the 8th registered registry per `docs/doctrine/registry-pattern-canonical.md` (per-registry coverage gate, perturbation probe, drift-defenses inventory entry, `REGISTERED_REGISTRIES` append) lands when a second asset (PYUSD, USDP, etc.) arrives as a real consumer. The sub-phase-A iteration array + type guard are already shaped so the promotion is a one-line `REGISTERED_REGISTRIES` append plus the per-registry coverage gate, not a refactor.

  **Sibling-audit note** (not in this changeset): `SovereignReceiptRequest.asset: string` in `@motebit/runtime` and the matching wire-format declaration in `spec/delegation-v1.md` § 8.1 carry the same semantic. They retain `string` typing pending a follow-on that narrows the HTTP receipt-exchange boundary via the type guard at JSON intake. Two-step approach (type guard at boundary, then tighten the interface) so the tightening is purely additive on the wire format.

  **Architectural intent**: the registry membership IS the protocol-vs-product wall named in `docs/doctrine/protocol-primacy.md` — if `"MOTE"` is ever added to `ALL_SETTLEMENT_ASSETS`, it's protocol; if it isn't, it's a motebit-cloud product overlay that converts to/from a protocol-level asset at its boundaries. See the `feedback_no_mote_stablecoin` memory for the current deferral framing.

  Composes with the off-ramp arc's prior Layer 1 enforcement shapes (per the `architecture_disjointness_by_construction` memory): surface deletion (`BridgeSettlementRail.withdraw`), marker interface (`WithdrawableGuestRail`), asymmetric typing (`WritableSettlementMode`). Sub-phase A adds the **typed vocabulary** shape — a closed string-literal union whose membership is the protocol-vs-product wall.

- 8262902: Promote `SettlementMode` to a registered registry — seventh instance of the canonical registry pattern per `docs/doctrine/registry-pattern-canonical.md`.

  `SettlementMode` (the closed `"relay" | "p2p"` union in `packages/protocol/src/settlement-mode.ts`) discriminates how money moves for a task: through the relay's virtual accounts, or directly onchain. The union was already cross-package interop law — relays route on `SettlementEligibility.mode`, agent discovery declares `settlement_modes[]`, peer negotiation depends on agreement — but lacked the canonical iteration + guard primitives that every other interop-law typed vocabulary in `@motebit/protocol` carries.

  This release adds the two new public exports:
  - `ALL_SETTLEMENT_MODES: readonly SettlementMode[]` — frozen iteration array, the single source of truth for "every settlement mode."
  - `isSettlementMode(value: unknown): value is SettlementMode` — type guard for narrowing values pulled from wire-format payloads or external sources.

  Same shape as `ALL_EVENT_TYPES` / `isEventType` (sixth registry, shipped 2026-05-14), `ALL_SUITE_IDS` / `isSuiteId`, `ALL_TOKEN_AUDIENCES` / `isTokenAudience`, `ALL_CONTENT_ARTIFACT_TYPES` / `isContentArtifactType`, `ALL_TASK_SHAPES` / `isTaskShape`, `ALL_SENSITIVITY_LEVELS` / `isSensitivityLevel`. Adding a settlement mode is now intentional protocol-level work: new union arm + new entry in `ALL_SETTLEMENT_MODES` + gate-reference update; the per-registry coverage gate (`check-settlement-mode-canonical`) and the meta-gate (`check-closed-registry-canonical`) together enforce the sibling-alignment.

  The minor bump reflects the additive surface (two new exports); no existing wire format or type contract changes.

## 1.3.0

### Minor Changes

- f1ba621: audit-chain-runtime-wire — `ChainedAuditSink` is now a composable
  wrapper that auto-wires when surfaces supply both a `toolAuditSink`
  and an `auditChainStore` adapter. Closes the gap from audit-chain-1
  - audit-chain-2 where the primitives existed but had zero consumers
    in production.

  **`@motebit/protocol` (minor):** new `AuditChainEntry` and
  `AuditChainStoreAdapter` interfaces. Wire-format permissive-floor
  types so `StorageAdapters.auditChainStore` can reference them
  without sdk crossing into BSL `@motebit/policy`. Concrete primitives
  (`appendAuditEntry`, `verifyAuditChain`, the `crypto.subtle`
  hashing) stay in `@motebit/policy/audit-chain.ts` — only the type
  moves; same algorithm. `@motebit/policy` re-exports
  `AuditEntry` / `AuditChainStore` as type aliases for backward
  compatibility with existing in-package callers.

  **`@motebit/sdk` (minor):** `StorageAdapters.auditChainStore?:
AuditChainStoreAdapter` — surfaces opt in by passing
  `new SqliteAuditChainStore(driver)` (cli, web, future surfaces with
  SQLite) or omitting (in-tree tests, minimal sandboxes).

  **Runtime auto-wire:** when both `toolAuditSink` and
  `auditChainStore` are present, the runtime constructs
  `new ChainedAuditSink({ inner: toolAuditSink, chainStore, motebitId })`
  and passes the wrap to `PolicyGate`. Inner sink keeps doing what it
  does (persistence, sync queries); chain layer runs in parallel for
  tamper-evidence.

  **ChainedAuditSink refactor — composable wrapper, not extends-
  in-memory:** the prior shape extended `InMemoryAuditSink`,
  duplicating the persistence layer. New shape implements
  `AuditLogSink` directly and delegates `append` / `query` /
  `getAll` / `queryStatsSince` / `queryByRunId` / `enumerateForFlush`
  to the supplied `inner` sink. Cleaner architecturally, surface-
  agnostic — the same primitive composes over `SqliteToolAuditSink`,
  `TauriToolAuditSink`, `ExpoToolAuditSink`, or any future
  implementation.

  **MotebitDatabase exposes `auditChainStore: SqliteAuditChainStore`**
  alongside the existing `toolAuditSink`. CLI threads both into its
  `StorageAdapters`; the runtime auto-wraps. Web + mobile surfaces
  follow the same pattern when they migrate.

- a5bf96e: Co-browse Slice 0 — control-state primitive at the protocol layer.

  Co-browse (the user driving inside motebit's isolated browser) is the
  threshold UX motebit has been building toward: when the slab feels
  like Chrome with motebit watching, helping, and able to take over with
  permission, the product becomes obviously different from Cursor,
  Claude Code, and normal browsers. Slice 0 lands the consent contract
  _before_ the wire path — pointer/keyboard forwarding (Slice 1+) will
  attach to a state machine that already encodes the trust model, not
  the other way around.

  The primitive is `ControlState`, a discriminated union over four
  states the user named in their directive:

  ```ts
  type ControlState =
    | { kind: "user" }
    | { kind: "motebit" }
    | { kind: "handoff_pending"; current: ControlHolder; requesting: ControlHolder }
    | { kind: "paused"; previousDriver: ControlHolder };
  ```

  Plus `CO_BROWSE_TRANSITION_KINDS` (closed enum: `request_control`,
  `grant_control`, `deny_control`, `reclaim_control`, `release_control`,
  `pause`, `resume`, `disconnect`) and `CoBrowseControlChangedPayload`
  for the audit-event shape.

  Why a discriminated union, not a flat enum: `handoff_pending` needs to
  know who currently holds and who's requesting (so a `deny` resolves to
  the right side); `paused` needs to remember `previousDriver` so
  `resume` restores continuity. Carrying that data in optional fields on
  a flat enum would mean "remember to inspect this field when kind is
  X." Discriminated union keeps the per-state shape a compile-time fact.

  `EventType.CoBrowseControlChanged` enters the audit-event union. Every
  transition emits one of these with full from/to state, so a verifier
  replaying the log can independently rebuild the state machine without
  re-running transition functions. Doctrine: the agent's awareness is
  the integral of receipts over time — control transitions are
  receipt-level events.

  Runtime state machine and tests ship in the companion ignored
  changeset.

- 1f5b8aa: Co-browse Slice 1 — protocol additions for the executeAction gate.

  `COMPUTER_FAILURE_REASONS` gains `not_in_control` — fired when a
  session's optional `coBrowseControl` machine reports
  `state.kind !== "motebit"` at dispatch time. Distinct from
  `user_preempted` (active halt) and `policy_denied` (governance):
  this is "who is allowed to act" rather than "what acts are
  allowed."

  `ComputerSessionActionRecord` gains optional
  `control_state_at_denial?: ControlState`. Present iff
  `failure_reason === "not_in_control"` — control state at non-control
  denials would be category noise. The runtime stamps the literal
  state on the per-action ledger; the field flows through
  `actions_hash` into the session receipt's signed commitment, so any
  retroactive edit to the recorded state breaks the signature. The
  audit answers "what state were we in" without cross-referencing
  adjacent `co_browse_control_changed` events.

  @alpha — same release status as the rest of computer-use.ts.

- 45aff03: Co-browse Slice 2c-batching-1 — wheel input. The first continuous
  event class on top of Slice 2c's discrete substrate.

  **New `wheel` variant on `UserInputEvent`** — `{ kind: "wheel"; x,
y, dx, dy, event_count }`. Logical-pixel cursor anchor + CSS-pixel
  scroll deltas matching `WheelEvent.deltaX`/`deltaY` axis convention
  (positive `dy` scrolls down). `event_count` reports how many native
  wheel events the capture surface coalesced into this one.

  **Coalescing contract (foundation law).** Capture surfaces MUST
  coalesce native wheel events at ≤60Hz — one wire event per ~16ms
  window. Sustained scrolling at 100Hz native rate (modern trackpads)
  must NOT produce 100 wire events/sec. Without this constraint
  POST-per-event saturates the wire. The capture surface sums dx/dy
  across the window and uses the LATEST cursor position so a swipe
  that drifts mid-scroll lands at the user's actual cursor.

  **Audit shape extension** — `UserInputForwardedDetail` gains a
  `wheel` variant: `{ kind: "wheel"; x_norm, y_norm, dx, dy,
event_count }`. Anchor coords normalize to [0, 1] like clicks;
  deltas pass through unchanged (CSS-pixel scroll amounts aren't
  sensitivity-bearing content).

  **Spec** — `spec/computer-use-v1.md` §5.5 documents the wire +
  audit shapes and the coalescing contract.

  Drag, continuous pointermove, selection-drag remain deferred —
  they need either burst-aggregated audit (one entry per drag rather
  than per frame) or a WebSocket-shaped substrate to sustain >60Hz.
  This slice is wheel only; it ships the simplest continuous event
  class that works on the existing POST substrate.

- 891a11b: Co-browse Slice 2c — protocol additions for user-driven input forwarding.

  The driveability substrate. With Slice 2c wired the user can click,
  type, and paste inside the cloud Chromium when `controlState.kind ===
"user"`; Slice 1's gate continues to deny motebit dispatch unless
  state === motebit. The consent loop opened by Slice 2b's slab band +
  the AI-side `request_control` tool now has both sides.

  **New wire format** — `UserInputEvent` discriminated union (click |
  key | paste). Carries the raw data Chromium needs to dispatch (text,
  logical-pixel coordinates, modifier flags). Coordinate system
  matches the existing `ComputerAction.click` shape — logical pixels
  against the cloud Chromium viewport. The capture surface is
  responsible for translating CSS rect → logical pixels before
  forwarding.

  **Discrete events only.** Click + key + paste only. Wheel, drag,
  continuous pointermove, selection-drag, and file-drag are
  explicitly out of v1 — POST-per-event cannot sustain 50+ events/sec
  at 30-100ms RTT; those classes require batching/coalescing or a
  WebSocket-shaped substrate, deferred to a follow-up slice.

  **New audit shape** — `UserInputForwardedPayload`, redacted by
  construction:
  - Keys log as `character_class` (letter / digit / punct / whitespace
    / control / modifier / unknown) plus `key_role` (enter / tab /
    escape / backspace / arrow / shortcut / printable / unknown).
    Raw key value NEVER logged. Multi-char unrecognized key names
    (IME composition strings) MUST collapse to `character_class:
"unknown"` rather than being classified by their first character.
  - Pastes log `length`, `line_count`, `looks_like_url`. Content
    NEVER logged.
  - Pointer events log normalized [0, 1] coordinates against the
    rendered screencast rect. Raw pixels NEVER logged.

  `control_state_at_forwarding` mirrors the `control_state_at_denial`
  field on motebit-side denials (Slice 1) — verifiers reconstruct
  context without cross-referencing adjacent control events.

  **New `EventType.UserInputForwarded`** entry on the audit-event
  enum. Emitted on every forward attempt — successes and rejections
  both — so the audit trail records who tried to drive when.

  **Closed-set rejection reasons** (`UserInputRejectionReason`):
  `not_in_user_state` | `session_closed` | `transport_error` |
  `not_supported`. Verifiers discriminate exhaustively.

  **Spec** — `spec/computer-use-v1.md` §5.5 documents both wire and
  audit formats, codifies the discrete-events-only scope, and pins
  the sensitivity-boundary deferral (user-driven frames are still
  observations; existing classification policy applies; medical /
  financial / secret co-browse use requires an explicit policy pass
  on the screencast surface itself).

  Surface scope: `virtual_browser` only. `desktop_drive` has no
  co-browse machine to drive — the user's real OS is the source —
  and surfaces without a `ControlState` machine MUST NOT register
  the affordance.

- f083b7a: Co-browse Slice 2d — user-side address-bar navigation.

  When `controlState.kind === "user"`, the user can type a URL into
  an address-bar surface and navigate the slab's cloud Chromium.
  Click + type + paste + scroll (Slice 2c-wheel) plus this gives
  honest browser-driveability inside the slab. Genuine search
  ("best laptops 2026" → search engine) deferred — Slice 2d is URL
  navigation only.

  **New `navigate` variant on `UserInputEvent`** — `{ kind:
"navigate"; url: string }`. The wire carries the normalized URL.
  Address-bar surfaces SHOULD normalize bare hostnames (`example.com`
  → `https://example.com`) before forwarding, mirroring the
  server-side regex (`^[a-z][a-z0-9+.-]*:\/\/`). Server-side dispatch
  is `page.goto(url, { waitUntil: "domcontentloaded" })`. The
  screencast surfaces the new page; navigate returns 204 (no inline
  screenshot like motebit-side `ComputerAction.navigate`).

  **URL-redacted audit shape** — `UserInputForwardedDetail.navigate`:
  `{ kind: "navigate"; scheme; host; has_path; has_query }`. URL host
  preserved; **path and query stripped**. URLs commonly carry session
  tokens, bearer tokens, or sensitive identifiers (`?reset_token=...`,
  `/patient/12345`); the user's signed audit log is more permanent
  than a browser history, so conservative redaction is correct.
  `has_path` / `has_query` retain "did the user submit a deep link"
  without leaking the contents. Malformed URLs collapse to all-`unknown`.

  **Spec** — `spec/computer-use-v1.md` §5.5 documents the wire +
  audit shapes and the URL-redaction contract (mirrors browser-history
  privacy: origin retained, path/query gone).

- f4aa40d: Co-browse Slice 2e — browser history navigation + click-ripple
  feedback. The last slice before the "Chrome-feel" demo speaks.

  **Three new parameter-less variants on `UserInputEvent`** —
  `{ kind: "back" }`, `{ kind: "forward" }`, `{ kind: "reload" }`.
  Server-side: `page.goBack` / `page.goForward` / `page.reload`,
  all with `{ waitUntil: "domcontentloaded", timeout: 15_000 }`.
  Empty-history semantics: `back` / `forward` against a session
  with no matching history MUST be a no-op (Playwright returns
  null; the wire treats null as 204 success). Matches real-browser
  UX.

  **Audit shapes are equally minimal** — `{ kind: "back" | "forward"
| "reload" }`. Nothing to redact; history navigation carries no
  user-supplied data.

  **Spec** — `spec/computer-use-v1.md` §5.5 documents all three
  wire + audit variants and the empty-history no-op contract.

  After this slice: click + type + paste + scroll + navigate +
  back/forward/reload. The local end-state ("user can drive a
  browser inside the slab") is now honest.

- f9fd8f2: Co-browse Slice 2f — slab control-chrome cleanup. Smoke test surfaced
  that `request_control` was rendering as a giant empty `tool_call`
  slab item AND the doorbell was clipped at the page top — state
  chrome was pretending to be content. Three structural fixes.

  **`ToolDefinition.slabProjection?: "none" | "tool_call"`** — new
  optional field. Default `"tool_call"` (or omitted) preserves the
  existing card-per-call behavior. `"none"` declares the tool as
  **state chrome** rather than a body act; the runtime suppresses
  the slab item projection entirely. Closed string-literal union —
  additive (a future `"observation"` variant could narrow further
  without breaking existing callers).

  Threaded through the AI loop's `tool_status` chunk
  (`AgenticChunk.tool_status.slabProjection`) so the runtime's
  projection site can read it without re-walking the registry.
  Mirrors the existing `embodimentMode` plumbing (5 emit sites in
  `ai-core/loop.ts`, one chunk-shape addition).

  Doctrine: motebit-computer.md — slab content is body acts (browser,
  peer viewport, memory artifact, tool result, desktop surface).
  Slab CHROME is state-aware overlays (control band, address bar,
  halt indicator). State-chrome tools belong in the latter; the
  slab item projection is for the former. Without this field,
  state-chrome tools would render duplicate UI: the affordance
  card AND the chrome both visible, competing for attention and
  obscuring the chrome's interactive elements.

- a2daccd: Co-browse Slice 2h — `read_page`, the first ax-tier tool. Fills the
  documented middle slot of the hybrid-engine cost hierarchy
  (`api → ax → pixels` per `tool-mode.ts`). Until this slice no tool
  declared `mode: "ax"`; the AI's only option against an open browser
  session was a pixel screenshot (~30k tokens, crosses the
  whole-screen privacy surface).

  **`ReadPageResult` wire format** — new exported type carrying the
  structured page observation: `url`, `title`, body `text` (bounded;
  `text_truncated: bool` flags the cap), `headings: ReadPageHeading[]`
  in document order (h1-h6 + visible text), `links: ReadPageLink[]`
  (visible label + absolute href). Plus `kind: "read_page"`,
  `session_id`, `extracted_at`. Closed shape so sandbox / dispatcher
  / runtime / ai-core / tools all agree without drift.

  Server-side bounds (in `services/browser-sandbox`): `text` capped
  at 8KB UTF-8 (≈2K tokens vs ~30K for a screenshot), `headings`
  and `links` capped at 100 entries each. Defends the AI context
  against pathological pages.

  **Spec update** — `spec/computer-use-v1.md` §4 codifies `read_page`
  as a `SHOULD register` companion to `computer` for surfaces with
  a `virtual_browser` embodiment. The MUST-NOT-leak-pixels invariant
  is reaffirmed: page text crosses the AI boundary subject to the
  existing sensitivity + outbound gates that govern `read_url` /
  `web_search`; **screenshot bytes still never leave the device for
  external AI**.

  Doctrine: `CLAUDE.md` Principle 96 (Hybrid engine, structural
  preference) — the registry sort `api → ax → pixels` already ranked
  `mode: "ax"` between `mode: "api"` and `mode: "pixels"`, but the
  middle tier was empty. `read_page` is its first tenant; the AI's
  default tool selection now lands on structured text when "what's
  on the page" is the question, falling back to pixels only when
  visual context is genuinely required.

- f174164: v1.5 — `ComputerSessionReceipt` closes the asymmetry where delegation
  has signed receipt chains but virtual_browser / desktop_drive sessions
  emit only lifecycle events. Every computer-use session now crystallizes
  at close into one signed artifact a third party with the signer's
  public key can verify without contacting any relay — the moat thesis
  ("accumulated trust") applied to the embodiment that previously had
  none.

  `@motebit/protocol` (Apache-2.0, permissive floor) adds three types
  under `computer-use.ts`:
  - `ComputerSessionActionRecord` — per-action structural roll-up
    (`kind` + timing + outcome + `failure_reason`). Carries no targets,
    args, or observation bytes — privacy invariant of the session-level
    receipt is compositional with the audit invariant of per-action
    `ToolInvocationReceipt`s.
  - `SignableComputerSessionReceipt` — body before signing (counts,
    outcomes_summary, failure_breakdown by `ComputerFailureReason`,
    was_halted, max_sensitivity envelope, opened/closed timestamps,
    display dimensions, embodiment_mode, JCS-canonicalized SHA-256
    `actions_hash`).
  - `ComputerSessionReceipt` — signed; `suite:
"motebit-jcs-ed25519-b64-v1"` + `signature` (base64url).

  `@motebit/crypto` adds `signComputerSessionReceipt`,
  `verifyComputerSessionReceipt`, and `hashComputerSessionActions` —
  sibling pattern to `signToolInvocationReceipt` / `hashToolPayload`.
  Same JCS+Ed25519+base64url pipeline; same fail-closed verifier rules.

  `@motebit/runtime` extends `ComputerSessionManager`:
  - Per-action structural ledger appended on every `executeAction`
    call (including halt-rejected calls — `was_halted: true` +
    `user_preempted` failures land in the receipt honestly).
  - Sensitivity envelope lifts off `governance.classifyObservation`'s
    output; uses an explicit `sensitivity_level` when the classifier
    supplies one, falls back to inferring `"financial"` from
    `strip_bytes` (the conservative floor of the medical/financial/secret
    bytes-strip trio per CLAUDE.md). High-water mark, never decays.
  - New `summarize(sessionId, deps)` produces the unsigned body. Caller
    injects the receipt-id generator, the embodiment_mode (apps stamp
    per-dispatcher per v1.1), and the `hashActions` function (typically
    wired to `@motebit/crypto`'s `hashComputerSessionActions`). Closed
    sessions remain summarizable via a bounded post-close retention
    buffer (FIFO, capacity 64).
  - `halt()` now stamps `was_halted: true` on every active session;
    sticky across `resume()` so the receipt commits to "the user paused
    at least once," not to terminal halt state.

  Wiring the signed receipt into the audit-event stream and surfacing it
  on the slab as a detachable artifact is the next slice (the runtime
  piece is the gate; UI follows). 14 crypto sign/verify tests + 11
  runtime summarize tests + all 41 prior session-manager tests pass.

- 5851a24: `computer-use@1.0`: `navigate(url)` action lands as the tenth action kind.

  Cloud-browser dispatcher (`services/browser-sandbox`, headless Playwright)
  has no address-bar UI for `key` / `type` to drive — the spec's promotion
  path (§"v1 limits — No new wire-format actions… real-usage-driven, not
  speculative") fired when the AI hit `navigate to tesla.com` against the
  sandbox surface. Real consumer demand, real action.

  Wire shape:

  ```ts
  interface NavigateAction {
    readonly kind: "navigate";
    readonly url: string;
  }
  ```

  Implementations SHOULD normalize relative-looking inputs (`example.com`
  → `https://example.com`) but MAY reject malformed URLs with
  `not_supported`.

  Cloud-browser dispatcher implements via `page.goto(url, { waitUntil:
"domcontentloaded" })`. Desktop dispatcher (Tauri Rust + xcap +
  enigo) does NOT implement — OS-level computer-use has no notion of "the
  active browser context"; the user controls which app is focused. The
  dispatcher-parity check (`scripts/check-computer-use-dispatcher-parity`)
  carries an explicit ALLOWLIST entry naming desktop as deferred until
  an OS-level navigation use-case proves itself.

  Stays within `@alpha` annotations on the `computer-use@1.0` types —
  spec-shaped wire format, additive change, JSON Schema regenerated.
  Companion ignored-package work in
  `computer-use-navigate-action-ignored.md`.

- 5286de2: Close the `ContentArtifactType` registry — `ContentArtifactManifest.artifact_type` is now a typed literal union (`@motebit/protocol`) instead of a free string. Three seed types match the consumers shipping or pending: `audit-trail`, `memory-export`, `execution-ledger`. New exports:

  ```ts
  import {
    type ContentArtifactType,
    ALL_CONTENT_ARTIFACT_TYPES,
    isContentArtifactType,
    AUDIT_TRAIL_ARTIFACT,
    MEMORY_EXPORT_ARTIFACT,
    EXECUTION_LEDGER_ARTIFACT,
  } from "@motebit/protocol";
  ```

  Drift gate `check-artifact-type-canonical` mirrors `check-audience-canonical` — every `artifact_type: "<literal>"` / `artifactType: "<literal>"` site is scanned against the registry. Pre-registry, a producer-site typo (`artifact_type: "audit_trail"` vs `"audit-trail"`) was a verifier-side classification miss with no compile-time signal.

  Type narrowing on `@motebit/crypto` — the `artifact_type` field on `ContentArtifactManifest` and the `artifactType` field on `SignContentArtifactOptions` now require a member of the registry. The primitive was published 2026-05-10 (commit c47251c0) with no external consumers yet; this hardening lands within the same day as the initial shape.

- ea6dc4d: element-1 — structurally-addressed element actions for the
  `computer` tool. Closes the action-truth gap witnessed 2026-05-08:
  AI couldn't reliably click the search box on google.com because it
  had no way to address page elements except by coordinate, and the
  coordinate inference path required vision (gated by default + UX
  friction). Production browser-agent platforms (Browserbase,
  Playwright codegen, Anthropic's computer-use cookbook) converge on
  the same primitive — durable structural element addressing,
  coordinates as fallback for visual-only tasks.

  New types:
  - `ReadPageInput` — typeable input field with server-issued
    `element_id`, `tag` (input/textarea), `input_type`, optional
    `name`/`placeholder`/`aria_label`/`value`. Capped at 100 entries
    in the read_page response; values capped at 256 chars.
  - `ReadPageButton` — button-shaped clickable element with
    `element_id`, `tag` (button/input/a), visible `text` (or
    aria-label fallback for icon-only buttons), optional `input_type`
    for `<input type="submit/button/reset">`. Capped at 100 entries.

  `ReadPageResult` extended with `inputs: ReadPageInput[]` and
  `buttons: ReadPageButton[]` arrays. Backward compatible — existing
  consumers reading `text` / `headings` / `links` ignore the new
  fields.

  Three new actions in `ComputerAction`:
  - `ClickElementAction` — `{ kind: "click_element", element_id }`.
    Server resolves the stamped `data-motebit-id`, scrolls into view,
    clicks center. Returns truth-feedback on the result envelope:
    `clicked_tag`, `focused_typeable`, `navigation_triggered`.
  - `FocusElementAction` — `{ kind: "focus_element", element_id }`.
    Focus without the click side-effects (no dropdown opens, no
    modal triggers). Truth: `tag`, `focused`.
  - `TypeIntoAction` — `{ kind: "type_into", element_id, text,
per_char_delay_ms?, clear_first? }`. Composes focus + clear +
    type into one semantic action. Default `clear_first: true`
    (mirrors human "type fresh into this field" intent). Same truth-
    feedback shape as the lower-level `type` action: `focused`,
    `active_element`, `value`, `text_appeared`.

  On staleness — page navigated since read_page, page reloaded,
  element removed by JS — actions return
  `{ ok: false, reason: "element_not_found", message }` so the AI
  knows to re-read.

  Server-side strategy (`services/browser-sandbox`):
  - `extractStructuredPageContent` walks the DOM, clears prior stamps,
    and stamps each interactive element with
    `data-motebit-id="motebit-N"`. Per-extraction counter; ids are
    scoped to the response that issued them.
  - `click_element` / `focus_element` / `type_into` resolve the
    stamped attribute via `page.locator('[data-motebit-id="..."]')`,
    scroll-into-view, then act. Element*id format is validated server-
    side (regex `^[a-zA-Z0-9*-]+$`) to defend against selector
    injection.

  PERCEPTION_DOCTRINE update teaches the AI to prefer element-
  addressed actions over coordinates when the target was discovered
  via read_page; coordinate `click` / `type` remain available for
  purely-visual tasks (drag a slider to a position seen in pixels).

  Dispatcher parity — desktop_drive's `ComputerPlatformDispatcher`
  does NOT yet implement these three kinds. The
  `check-computer-use-dispatcher-parity` allowlist gains entries for
  each, naming the deferred state: desktop's equivalent primitive
  needs an accessibility-tree adapter (macOS AXUIElement, Windows
  UIA, Linux AT-SPI) so click_element resolves an AX node id instead
  of a DOM data-attribute. Same wire shape, different resolver.
  Lands in a follow-up.

  Open-ended on the type union — additive new actions land without
  breaking existing consumers; the `default: never` exhaustive arm
  in the cloud dispatcher catches missing handlers at compile time.

- 88d8550: Extend `motebit/execution-ledger` from v1.0 to v1.1 — additive, non-breaking. The `GoalExecutionManifest` reconstruction shape gains an optional `signed_receipts?: string[]` field carrying byte-identical canonical-JSON of each delegated motebit's signed `ExecutionReceipt`. New constants `EXECUTION_LEDGER_SPEC_V1_0` and `EXECUTION_LEDGER_SPEC_V1_1` for type-safe spec-version literals.

  ```ts
  import { type GoalExecutionManifest, EXECUTION_LEDGER_SPEC_V1_1 } from "@motebit/protocol";

  // v1.1 bodies carry signed_receipts when the relay has the byte-identical archive
  const ledger = (await fetch(`${relay}/api/v1/execution/${motebitId}/${goalId}`).then((r) =>
    r.json(),
  )) as GoalExecutionManifest;

  if (ledger.spec === EXECUTION_LEDGER_SPEC_V1_1 && ledger.signed_receipts) {
    for (const receiptJson of ledger.signed_receipts) {
      const receipt = JSON.parse(receiptJson);
      // Verify each inner motebit's signature independently — no relay trust required.
      // The bytes are canonical-JSON byte-identical with what the motebit signed.
    }
  }
  ```

  **Why this closes the operator-trust gap:**

  Before v1.1, `delegation_receipts` carried `signature_prefix` — the first 16 characters of the motebit's Ed25519 signature. Display-only, not verifiable. A relay could falsely claim "motebit X did this work" and a verifier had to trust the relay's word (the outer relay-signed manifest on the bundle attests to bundle assembly, not to inner motebit attestation).

  With v1.1, the verifier holds the byte-identical canonical JSON of each inner `ExecutionReceipt` — sourced from the relay's `relay_receipts.receipt_json` archive (per `services/relay/CLAUDE.md` Rule 11). Each entry parses to a full `ExecutionReceipt`, including its `public_key`, `suite`, and `signature` fields. The verifier checks each Ed25519 signature against the named motebit's public key, independent of the relay. A relay that lies about which motebit did the work is detectable; cross-relay verification becomes possible; federation peers can audit each other's claims.

  **Why this is additive, not breaking:**
  - v1.0 consumers continue to parse v1.1 bodies — JSON.parse ignores the unknown `signed_receipts` field
  - Relays that don't have the archive populated (testnet, ephemeral deploys, partial sync) continue to emit `spec: "motebit/execution-ledger@1.0"` — graceful degradation
  - The spec literal type widens from `"motebit/execution-ledger@1.0"` to `"motebit/execution-ledger@1.0" | "motebit/execution-ledger@1.1"`; consumers narrowing on the v1.0 literal will see a TypeScript widening but their runtime behavior continues

  Producer wiring lives in `services/relay/src/state-export.ts` (BSL, reference relay). Drift gate `check-execution-ledger-receipts-archived` (drift-defense #89) prevents silent regression back to v1.0 summary-only semantics.

  Doctrine: `spec/execution-ledger-v1.md` §4.3 (Inner Signed Receipts — v1.1 additive); `docs/doctrine/nist-alignment.md` §8 "Inner-receipt verification closed 2026-05-11"; `docs/doctrine/self-attesting-system.md` extends to relay-assembled bundles now that inner signatures pass through byte-identical.

- 22b6a39: `ToolDefinition.embodimentMode` lands as the per-dispatcher embodiment
  stamp the slab uses to pick the correct mode contract per surface.

  The wire-format problem this closes: the `computer` tool name is
  shared between cloud-browser (apps/web → CloudBrowserDispatcher,
  isolated Chromium) and OS-drive (apps/desktop → Tauri Rust bridge,
  real OS) — two physically distinct dispatchers, two different
  embodiments per `motebit-computer.md` §"Embodiment modes" (cloud →
  `virtual_browser`, desktop → `desktop_drive`). `tool-policy.ts` is
  name-keyed and surface-blind, so a single mode would mis-tag one
  surface. The previous safe-floor (`tool_result`) under-claimed the
  embodiment for both.

  Resolution: ToolDefinition now carries an optional `embodimentMode`
  field. Each dispatcher's registration site stamps its own
  embodiment (`apps/web/src/computer-tool.ts` →
  `embodimentMode: "virtual_browser"`; `apps/desktop/src/computer-tool.ts`
  → `embodimentMode: "desktop_drive"`). ai-core forwards the mode on
  every `tool_status` chunk; the runtime's `projectSlabForTurn` picks
  `chunk.mode` over `tool-policy.ts`'s generic floor.

  The string union itself (`"mind" | "tool_result" | "virtual_browser"
| "shared_gaze" | "desktop_drive" | "peer_viewport"`) is canonically
  declared as `EmbodimentMode` in `@motebit/render-engine`. Typed here
  as `string` to avoid a protocol→render-engine layer break — promoting
  the type into `@motebit/protocol` is a separate slice the doctrine
  names as deferred.

  Doctrine: `motebit-computer.md` §"v1 implementation status —
  Deferred to v1.5+: per-dispatcher mode stamping" — landed as v1.1
  of the virtual_browser arc.

- b7f79b2: Drag-drop perception substrate — protocol-layer types for the gesture the slab doctrine has named since landing.

  ```ts
  export type DropPayloadKind = "url" | "text" | "image" | "file" | "artifact";

  export type DropTarget = "slab" | "creature" | "ambient";

  export type DropPayload =
    | {
        kind: "url";
        url: string;
        sourceFrame?: string;
        target?: DropTarget;
        attestation: UserActionAttestation;
      }
    | {
        kind: "text";
        text: string;
        mimeType?: string;
        target?: DropTarget;
        attestation: UserActionAttestation;
      }
    | {
        kind: "image";
        bytes: Uint8Array;
        mimeType: string;
        target?: DropTarget;
        attestation: UserActionAttestation;
      }
    | {
        kind: "file";
        bytes: Uint8Array;
        filename: string;
        mimeType: string;
        target?: DropTarget;
        attestation: UserActionAttestation;
      }
    | {
        kind: "artifact";
        receiptHash: string;
        payloadJson: string;
        target?: DropTarget;
        attestation: UserActionAttestation;
      };

  export interface UserActionAttestation {
    readonly kind: "user-drag";
    readonly timestamp: number;
    readonly surface: "web" | "desktop" | "mobile" | "spatial" | "cli";
    readonly contentHashSha256?: string;
  }

  export function resolveDropTarget(payload: DropPayload): DropTarget;
  ```

  Two-level pattern, same shape as `SuiteId` / `GuestRail` / `ToolMode` (the agility-as-role pattern in `docs/doctrine/agility-as-role.md`). Categorical drop kinds are closed at the protocol layer — adding a kind is a protocol bump (additive, registry append). Per-kind handlers are runtime-extensible via `MotebitRuntime.registerDropHandler(kind, handler)`; v1 default handlers stage slab items for `url`, `text`, `image` in **`shared_gaze` mode** — the user is the driver, motebit is the observer, source is `user-source`, consent fires per-source. (`mind` would be a category error: `mind` is interior cognition, not user-fed external material.) The doctrine's three drop targets (`slab` / `creature` / `ambient`) carry as an optional hint defaulting to `slab`; spatial Phase 1B unlocks the other two without a wire-format change.

  `UserActionAttestation` is **attestation of intentional delivery, not content authenticity.** The user's gesture proves they meant to deliver the payload — it does NOT prove the payload is authentic, unforged, or what it claims to be. A user can drag a forged PDF; the gesture still attests only that delivery was intentional. Authenticity comes from separate provenance — a source URL the runtime fetched, a cryptographic signature on the bytes, an `ExecutionReceipt`, or a content hash a trusted source previously published. Audit prose must keep the two distinct.

  The three `DropTarget` values are **not equivalent drop zones with different visual effects.** They carry meaningfully different persistence and governance: `slab` is turn/session-scoped perception, `creature` is identity-adjacent state mutation requiring explicit confirmation / signed user intent, `ambient` is workspace-scoped reference with source-consent + expiration. v1 surfaces only ever set `slab`; `creature` and `ambient` unlock together with the per-target governance UX in spatial Phase 1B (never separately).

  **Ambient invariant: consultable context, not automatic prompt context.** The motebit can reach for an ambient drop when a turn calls for it (retrieval-shaped), but the drop itself does NOT auto-fill the prompt at the next AI call. Future implementations will be tempted to dump ambient bytes into every turn's context pack; this invariant exists to prevent that failure mode.

  **Dimensionality is not the gate; governance is.** A 2D web surface CAN distinguish the three targets via raycast pick at drop time (creature mesh hit, slab plane hit, no hit ≡ ambient). The actual gate is the per-target governance UX (creature confirmation modal + chosen mutation semantic; ambient consultable-context store + retrieval API). Until those exist, `MotebitRuntime.feedPerception` fails closed on non-slab targets with `DropTargetGovernanceRequiredError` (re-exported from `@motebit/runtime`) — same fail-closed pattern as `SovereignTierRequiredError`. The error names the missing consumer so a future implementer can wire it up by replacing the rejection with the governance-aware handler.

  Drop-out provenance — when a motebit-produced artifact leaves the slab toward another destination — uses `ExecutionReceipt` (already in the protocol). This release covers the in-direction substrate.

  Drift gate `check-drop-handlers` (#77) enforces both arms: every `DropPayloadKind` has a registered handler or an explicit allowlist entry, AND every per-surface drop handler routes through `runtime.feedPerception` (never constructs a prompt and calls `sendMessage` — the prompt-backdoor failure mode named in `motebit-computer.md` §"Failure modes specific to supervised agency").

  Doctrine: `motebit-computer.md` §"Perception input — drop kinds and handlers" + `liquescentia-as-substrate.md` §"Cohesive permeability" (the membrane physics every drop crosses under conditions).

- b42cee1: Add `BROWSER_SANDBOX_GRANT_AUDIENCE` (`"browser-sandbox-grant"`) and `BROWSER_SANDBOX_AUDIENCE` (`"browser-sandbox"`) constants for the audience-bound signed-token primitive.

  These ship the relay-mediated dispatcher-token flow that replaces the v1 shared-bearer model in `services/browser-sandbox`. The first audience binds a motebit's grant request to the relay; the second binds the relay-signed token the motebit attaches to browser-sandbox requests. Single trust anchor (the pinned relay public key) and end-to-end audit attribution via the `mid` claim.

  Same canonical-audience pattern as the existing `sync` / `task:submit` / `admin:query` audiences (still string literals at consumer sites; promoting them to typed constants is follow-up work, not a blocker for this migration).

  ```ts
  import { BROWSER_SANDBOX_GRANT_AUDIENCE, BROWSER_SANDBOX_AUDIENCE } from "@motebit/protocol";
  ```

- 9c39980: Add `frame_stale` to `COMPUTER_FAILURE_REASONS` — typed-truth reason for the Playwright navigation race during action dispatch.

  Additive (new union member). Before this entry, Playwright's "Execution context was destroyed" / "frame was detached" / "Target closed" / "Target page, context or browser has been closed" errors fell through the browser-sandbox route handler's general catch into `platform_blocked` (HTTP 500). The AI received an opaque server-fault and verbally interpreted it as "the platform is blocking key presses" — prose interpretation of a typed event.

  `frame_stale` is the proper typed reason for "the page navigated underneath the action; the executor's frame reference is stale." Distinct from `session_closed` (the session is still open; only the frame changed) and `platform_blocked` (OS-level synthetic-input block). Paired with one-shot retry in `services/browser-sandbox` and a `PERCEPTION_DOCTRINE` clause in `@motebit/ai-core` so the AI surfaces the recovery path ("the page changed — let me re-read") instead of confabulating about platform failure.

- 3f2e370: Add canonical money primitives to the permissive-floor protocol surface: `MICRO`, `CENTS`, `toMicro`, `fromMicro`, `toCents`, `fromCents`. Pure algebra over numbers — interop law for integer-unit accounting. Every motebit implementation in any language uses the same formula at the API boundary.

  Two reference precisions:

  ```ts
  import { toMicro, toCents } from "@motebit/protocol";

  toMicro(0.5); // 500_000  — USDC 6-decimal ledger precision
  toCents(0.5); // 50       — Stripe / fiat-rail precision
  ```

  `@motebit/virtual-accounts/money.ts` continues to export `MICRO`, `toMicro`, `fromMicro` — they re-export from the new canonical home, so existing imports work unchanged. Settlement rails (Stripe, x402) consume these directly instead of re-rolling `Math.round(amount * 100|1_000_000)` inline.

  A new drift gate (`scripts/check-money-boundary.ts`) forbids inline copies of the converter formula in money-touching packages. Same closure pattern as cryptosuite agility — one canonical family, additive: a third precision (RWA tokens, JPY rails) is a new function in the same file, not a third inline copy.

- e383c63: Add optional `submit_button_id?: string` to `ReadPageResult` — typed-truth hint naming the page's primary submit button by `element_id`.

  Additive (new optional field). Detected at extraction time by the cloud-browser dispatcher via two signals in order: (1) HTML semantic — first button with `input_type === "submit"` wins; (2) label heuristic fallback — first button label matching a submit-class word (`Search`, `Submit`, `Send`, `Sign in`, `Log in`, `Continue`, `Go`, `Subscribe`, `Next`, `Save`, `Post`), case-insensitive, whole-label-or-prefix match. Absent when the page has no submit-class element.

  Converts the AI's form-submission decision from prompt-only teaching (the 14-line `click_element-over-key("Enter")` bullet) to runtime-backed typed-truth: the wire field carries the "right tool for this page" signal that the AI's selection would otherwise have to derive from unstructured prompt rules. Doctrine: `docs/doctrine/runtime-invariants-over-prompt-rules.md` — exemplar of B→A graduation. Gated by `check-typed-truth-perception` (#80, registered as the 10th typed-truth field) so the prompt-teaching and dispatch-emission halves cannot drift apart.

- eeebf19: Promote token audiences to a closed registry. Adds `TokenAudience` literal union, named constants for every canonical audience, `ALL_TOKEN_AUDIENCES` (frozen iteration order), and `isTokenAudience` type guard.

  The registry covers fifteen audiences across multi-device + identity lifecycle (`sync`, `device:auth`, `pair`, `rotate-key`, `push:register`), task routing (`task:submit`, `admin:query`, `proposal`), virtual accounts (`account:{balance,deposit,withdraw,withdrawals,checkout}`), and the browser-sandbox dispatcher token flow (`browser-sandbox-grant`, `browser-sandbox`).

  ```ts
  import {
    TokenAudience,
    ALL_TOKEN_AUDIENCES,
    isTokenAudience,
    TASK_SUBMIT_AUDIENCE,
    // …
  } from "@motebit/protocol";

  const aud: TokenAudience = TASK_SUBMIT_AUDIENCE; // typo at literal sites is a compile error
  ```

  Same closure pattern as `SuiteId`, `SettlementRail`, `ToolMode`. The drift gate `check-audience-canonical` (lands alongside this) scans every `aud: "<literal>"` and `createSyncToken("<literal>")` against `ALL_TOKEN_AUDIENCES`; a typo at a signing site that pre-registry would have been a runtime 401 is now caught at compile time + at CI.

  `SignedTokenPayload.aud` stays `string` for wire-format compatibility (any `string` still flows through the verifier, which compares against `expectedAudience` literally). The narrowing happens at signing-site callers — they pass `TokenAudience` values; literals outside the registry fail the gate.

  Adding an audience is intentional protocol-level work: a new entry in the union, a matching named constant, a registration in `ALL_TOKEN_AUDIENCES`, a doctrine update at `services/relay/CLAUDE.md` Rule 5. Renaming a literal is a wire break; deletions break running deployments.

  Existing consumers do not need to migrate; the registry is additive over the existing string literals.

- 9def0cd: Codify the trust-anchor primitive — `spec/relay-transparency-v1.md` (Stage 2b-i) ships. New exports from `@motebit/protocol`:

  ```ts
  import {
    type SignedTransparencyDeclaration,
    type TransparencySignedPayload,
    type TransparencyAnchorRecord,
    TRANSPARENCY_SUITE,
    TRANSPARENCY_ANCHOR_MEMO_PREFIX,
    TRANSPARENCY_SPEC_ID,
    isSignedTransparencyDeclaration,
  } from "@motebit/protocol";
  ```

  `SignedTransparencyDeclaration` is the binding wire shape of the operator-transparency declaration at `/.well-known/motebit-transparency.json`. The declaration is the trust anchor every motebit verifier pins: `relay_public_key` commits the operator to one Ed25519 identity, and every content-artifact manifest, settlement receipt, and federation handshake verifies against that key. The `content` field is operator-extensible per `spec/relay-transparency-v1.md` §3.1 — the protocol commits to the envelope, not to the posture vocabulary inside.

  Companion zod schema in `@motebit/wire-schemas::SignedTransparencyDeclarationSchema`; JSON Schema (Apache-2.0) committed to `spec/schemas/signed-transparency-declaration-v1.json`.

  **Why now, not deferred per the doctrine's original trigger:** the original `docs/doctrine/operator-transparency.md` Stage 2 deferral bundled "wire-format spec" and "operator-comparison vocabulary" under one "second operator forces field standardization" trigger. The savant-gap critique surfaced the first split (2a onchain-anchor lifted from 2b wire-format); examining 2b under the same lens surfaced a second split: trust-anchor codification (single-operator independent) and operator-comparison fields (multi-operator). After the previous commits made `transparency.json` load-bearing as the trust anchor for state-export verification, the asymmetry between transparency (no spec) and every other trust anchor in motebit (`identity`, `execution-ledger`, `credential`, `credential-anchor`, `settlement` — all with specs) was the gap to close. Stage 2b-ii (operator-comparison fields) stays deferred behind the original trigger.

  The reference relay (`services/relay/src/transparency.ts`) now consumes the canonical types from `@motebit/protocol` instead of declaring them inline; `services/relay/src/transparency.ts::SignedDeclaration` is a narrowing of the protocol type that pins `content` to the relay's specific `DECLARATION_CONTENT` shape (operator-extensibility preserved at the protocol layer, narrowed at the consumer).

  Doctrine: `spec/relay-transparency-v1.md`, `docs/doctrine/operator-transparency.md` § Stage 2 (split into 2a + 2b-i shipped, 2b-ii deferred), `docs/doctrine/nist-alignment.md` §8.

- 91299fd: v1.3 of the virtual_browser arc — `ScreencastFrame` wire-format type
  for live JPEG streaming from the cloud-browser service.

  Per-action screenshots produced "moments" — the slab read as a
  slideshow of stills, not a window into a browser. v1.3 swaps that for
  a continuous JPEG frame stream from CDP `Page.startScreencast`.
  `ScreencastFrame` is the wire shape both the server (`services/
browser-sandbox`) and the dispatcher (`@motebit/runtime`'s
  `CloudBrowserDispatcher`) consume:

  ```ts
  interface ScreencastFrame {
    readonly jpeg_base64: string;
    readonly timestamp: number; // wall-clock ms, normalized from CDP seconds
    readonly device_width: number;
    readonly device_height: number;
  }
  ```

  Lives at the protocol layer next to the `ComputerSession*` cluster —
  both producer and consumer reference one canonical shape, no drift
  between server JSON and client decode.

  Slice 1 of v1.3 (data path). The cloud-browser service ships the
  `GET /sessions/:id/screencast` NDJSON-streaming endpoint; the
  dispatcher ships `openScreencast({onFrame, onError})`; the slab UI
  swap follows in slice 2.

- 7ba2761: v1.3 slice 2 — slab UI swap. The `live_browser` slab item kind
  crystallizes the continuous JPEG screencast into a single visual
  element on the plane, replacing the "slideshow of stills" register
  that per-action screenshots produced.

  `@motebit/protocol` adds `ScreencastFrameSource` — minimal
  subscribe-shape interface (`{subscribe(callback): () => void}`) the
  producer (apps' frame bus) and consumer (the slab's live element)
  both consume. Sibling pattern to other observer surfaces in the
  package.

  `@motebit/render-engine` adds:
  - `live_browser` to the `SlabItemKind` union; `defaultEmbodimentMode`
    maps it to `virtual_browser` so callers that don't pass `mode`
    explicitly land at the right mode boundary.
  - `buildLiveBrowserElement(source)` — pure DOM builder. Returns
    `{element, dispose}`. The element is an `<img>` wrapped in a
    `slab-live-browser` div with a placeholder until the first frame
    arrives. Each subscribed frame replaces the placeholder, locks the
    aspect ratio to the captured viewport, and updates `img.src` with
    the JPEG data URL. Latest-wins on `timestamp` so out-of-order CDP
    frames don't paint backwards. `dispose` is idempotent; post-dispose
    publishes are silently dropped.
  - 9 jsdom tests cover the subscribe → first-frame → subsequent-frames
    → dispose lifecycle plus the latest-wins ordering and the dispose
    → no-paint contract.

  Why `<img>` and not `<canvas>`. `data:` URL src updates defer JPEG
  decode + paint to the rendering thread; canvas would buy composite
  control v1.3 doesn't need. If a future slice adds cursor overlays or
  click ripples on the frame surface, swap to canvas as a contained
  renderer change — the `(source) => {element, dispose}` contract
  stays.

- c243dd2: Sensitivity-gate audit event — turns the shipped fail-closed gate from invisible-but-correct into observable-and-provable.

  ```ts
  enum EventType {
    // ...
    SensitivityGateFired = "sensitivity_gate_fired",
  }

  type SensitivityGateEntry =
    | "sendMessage"
    | "sendMessageStreaming"
    | "generateActivation"
    | "generateCompletion"
    | "outbound_tool";

  type SensitivityElevationSource = "session" | "slab_item";

  interface SensitivityGateFiredPayload {
    readonly entry: SensitivityGateEntry;
    readonly session_sensitivity: SensitivityLevel;
    readonly effective_sensitivity: SensitivityLevel;
    readonly provider_mode: "on-device" | "motebit-cloud" | "byok" | "unset";
    readonly elevated_by?: {
      readonly via: SensitivityElevationSource;
      readonly slab_item_id?: string;
    };
    readonly tool_name?: string;
  }
  ```

  Every `assertSensitivityPermitsAiCall` block now emits a structured `SensitivityGateFired` event to the EventStore BEFORE throwing `SovereignTierRequiredError`. The four shipped egress closures (session-elevated state, drops, tool outputs, memory writes) all leave inspectable evidence. Audit consumers query via `events.query({ event_types: [EventType.SensitivityGateFired] })` for the trail of every blocked egress crossing.

  **Strictly metadata.** Payload contains entry name, session/effective tier, provider mode, elevation attribution (with content-free slab item ID for forensic correlation), and tool name when applicable. NEVER raw drop content, tool result bytes, slab item payloads, or prompt strings. Logging the payload that triggered the block would itself be a leak surface — same kind of leak the gate exists to prevent. Field naming choice (`elevated_by.via` rather than `source`) avoids false-positives in `check-mode-contract-readers` (#76) where the destructure-detection regex can't distinguish object-literal write from contract-field read.

  Companion change: `MotebitRuntime.assertSensitivityPermitsAiCall` promoted from `private` to public. The gate predicate is motebit's named primitive for sensitivity-tier-vs-provider routing — the mechanism every commit in the four-egress-shape arc is built around. Surfaces, tests, and audit tooling now have a typed entry point. Internal sites (sendMessage, sendMessageStreaming, generateActivation, generateCompletion, the outbound-tool wrap) call the same method — the public promotion adds no new code path, it just names what was already the architectural seam.

  Doctrine: `motebit-computer.md` §"Mode contract — six declarations per mode." Closes the audit-trail pivot named after the four-egress-shape arc.

- 7b87916: Sensitivity ladder algebra graduates to the protocol layer.

  `rankSensitivity`, `maxSensitivity`, and `sensitivityPermits` are now
  exported from `@motebit/protocol` (and re-exported through `@motebit/sdk`
  via the existing `export *`). Pure deterministic math over the closed
  `SensitivityLevel` enum — qualifies as a permissive-floor primitive
  per `packages/protocol/CLAUDE.md` rule 1 ("deterministic math").

  ```text
  rankSensitivity(level): number               // None=0 .. Secret=4
  maxSensitivity(a, b):   SensitivityLevel     // join-semilattice composition
  sensitivityPermits(upper, candidate): bool   // candidate <= upper
  ```

  The ladder is interop law. Every motebit implementation must agree on
  which tier dominates which, or the cross-implementation gate isn't
  interoperable: device A persisting a turn at "secret" must mean the
  same thing to device B's session-tier filter. Hosting the math at the
  protocol layer makes the ordering a one-file change at the canonical
  source rather than four duplicated copies that drift independently.

  Graduation history: `rankSensitivity` had three local copies as of
  2026-05-07 (runtime/motebit-runtime.ts, runtime/conversation.ts,
  ai-core/loop.ts) plus a fourth-shaped table (`LEVEL_RANK` +
  `higherLevel` in policy-invariants/computer-sensitivity.ts). The
  ai-core copy's JSDoc explicitly named the trigger: "if a third reader
  appears, the helper graduates." Past trigger.

  Three runtime/ai-core copies are removed and the consumers now import
  from `@motebit/sdk`. policy-invariants's local `LEVEL_RANK` table is
  left in place because it operates on a separate string-literal
  `SensitivityLevel` type for computer-use sensitivity classification —
  cross-package type unification is a separate concern and not load-
  bearing for the gate-composition arc.

  Math properties verified by 13 new protocol-package tests:

  ```text
  rankSensitivity:    strictly monotonic; every adjacent pair differs by 1
  maxSensitivity:     None is identity; idempotent; commutative; associative
  sensitivityPermits: dual of maxSensitivity (max(upper, c) === upper iff
                      sensitivityPermits(upper, c)); reflexive
  ```

  `@motebit/sdk` is patch because it picks up the new exports through
  `export * from "@motebit/protocol"` without changing its own surface
  intentionally.

  Added to `PERMISSIVE_ALLOWED_FUNCTIONS` in `scripts/check-deps.ts`
  with a load-bearing review note tying the entries to the graduation
  trigger and the interop-law justification.

- f78a82a: Add `"skill_audit"` to `RuntimeStoreId` and register a `consolidation_flush` retention shape for it in `RUNTIME_RETENTION_REGISTRY`. Mirrors the existing `tool_audit` registration — append-only operator-act ledger with a `sensitivity` column on the `skill_consent_granted` variant; the consolidation cycle's flush phase respects sensitivity-tier retention ceilings. No min-floor resolver because skill audit doesn't gate settlement.

  The new store ships with the durable consent-audit arc on web (`packages/browser-persistence/src/idb-skill-audit.ts`) and mobile (`apps/mobile/src/adapters/expo-sqlite.ts` — `ExpoSqliteSkillAuditSink` over the `skill_audit` SQLite table). Closes the consent-gate arc's runtime gap: `SkillConsentGrantedEvent` now lands in a registered, retention-aware durable store instead of the protocol-only type slot it occupied before.

- 0c6196c: Extend `ContentArtifactType` registry from 3 → 12 types — one per state-export endpoint in `services/relay/src/state-export.ts`. New named constants: `STATE_SNAPSHOT_ARTIFACT`, `GOAL_LIST_ARTIFACT`, `CONVERSATION_LIST_ARTIFACT`, `CONVERSATION_MESSAGES_ARTIFACT`, `DEVICE_LIST_ARTIFACT`, `PLAN_LIST_ARTIFACT`, `PLAN_DETAIL_ARTIFACT`, `GRADIENT_HISTORY_ARTIFACT`, `SYNC_PULL_ARTIFACT` (9 added; `AUDIT_TRAIL_ARTIFACT`, `MEMORY_EXPORT_ARTIFACT`, `EXECUTION_LEDGER_ARTIFACT` carried over).

  ```ts
  import {
    type ContentArtifactType,
    STATE_SNAPSHOT_ARTIFACT,
    GOAL_LIST_ARTIFACT,
    PLAN_DETAIL_ARTIFACT,
    // ...
    ALL_CONTENT_ARTIFACT_TYPES,
    isContentArtifactType,
  } from "@motebit/protocol";
  ```

  Closes the doctrine §8 coherency gap (`docs/doctrine/nist-alignment.md`): every state-export endpoint now wraps its body in a relay-asserted `ContentArtifactManifest` emitted via the `X-Motebit-Content-Manifest` HTTP header. The registry expansion follows the same closure-by-construction pattern as `TokenAudience` and `SuiteId`. Sixth closed-registry drift gate (`check-state-export-signed`, drift-defense #86) makes consumer-side coherency permanent.

  Type-level note: the literal union was introduced 2026-05-10; this extension expands the union from 3 → 12 members. Consumers that exhaustively switch on `ContentArtifactType` (rare — most callers narrow via `isContentArtifactType` or compare against specific named constants) will see TypeScript narrowing flag any missing cases.

- ee5f70f: `ToolResult` gains optional `reason?: string` — a structured
  failure category set by handlers that wrap a typed error carrying
  its own `reason` field (e.g. `ComputerDispatcherError` from
  `@motebit/runtime`). Lets downstream consumers route on category
  without parsing the human-readable `error` text.

  v1 carrier: `not_in_control` — Slice 1 co-browse gate denial.
  The runtime's slab projection uses the structured field to
  suppress a body `tool_call` item; the slab control band
  (Slice 2b doorbell) is the canonical surface for the resolution
  affordance, and a duplicate body card competes for attention.

  Replaces the earlier string-prefix probe on the failure message,
  which silently broke when `@motebit/tools`'s `computer` handler
  started wrapping the error as `"computer: ${msg}"` (witnessed
  2026-05-08: a wall of denial text on the slab body next to an
  already-shown Grant/Deny band). Doctrine pre-authorized the
  graduation in `motebit-runtime.ts` §"if more reasons land later,
  graduate to a structured `failure_reason` field rather than
  extending the prefix list."

  Open string-literal — additive. New reason categories land
  without breaking existing consumers (route on values you care
  about; ignore the rest).

  Wire path: `ComputerDispatcherError(reason, msg)` →
  tools-package handler's catch (lifts `.reason` onto the
  envelope) → ai-core's `done` chunk
  (`AgenticChunk.tool_status.reason`) → runtime's
  `StreamChunk.tool_status.reason` → `projectSlabForTurn`'s
  `isControlStateFailure` check.

- ef49992: typed-intent-implicit-grant — `UserActionAttestation` widens from a
  fixed `kind: "user-drag"` interface to a discriminated union over
  `"user-drag" | "user-typed-intent"`. The new arm carries a typed
  chat-input submit through perception alongside the existing drag
  gesture; producers stay structurally compatible, consumers gain a
  second case to discriminate on.

  **Why this matters.** The runtime threads
  `options.userActionAttestation` through `sendMessageStreaming` so
  tools that need consent can distinguish a user-driven turn from
  proactive idle work. The first consumer is `request_control` on
  the web cloud-browser surface: when the AI's reach for `computer`
  fails with `not_in_control` inside a turn the user typed and sent,
  the `request_control` flow auto-grants instead of opening the
  slab band's Grant/Deny doorbell. Re-confirming what the user can
  already see they did would violate the calm-software doctrine
  (`CLAUDE.md` § UI). Proactive paths (`generateActivation`,
  idle-tick consolidation) never run through `sendMessageStreaming`,
  so they never get a typed-intent attestation — the prompt band
  fires as before, fail-closed by default.

  **`@motebit/protocol` (minor):**

  ```text
  - export interface UserActionAttestation { kind: "user-drag"; ... }
  + export type UserActionAttestation =
  +   | { kind: "user-drag"; timestamp; surface; contentHashSha256? }
  +   | { kind: "user-typed-intent"; timestamp; surface };
  ```

  Additive new arm; the existing `user-drag` shape is preserved
  field-for-field. Exhaustive consumers that switch on `kind` gain
  one new case to handle.

  **`@motebit/sdk` (minor):** re-exports the widened type through
  `* from "@motebit/protocol"`. Surfaces that construct the
  attestation pass `kind: "user-typed-intent"` from chat-input
  handlers (today: web; sibling stamp on desktop / mobile when
  they grow a virtual_browser surface). The minor cascade is
  the structural one — the SDK's own surface didn't gain new
  exports.

  **Audit shape.** Auto-grant emits both control transitions
  (`request_control` initiated by motebit, `grant` initiated by
  user) synchronously in the same JS task; the band's reactive
  subscribers see `handoff_pending → motebit` back-to-back before
  the browser repaints, so no visible band flicker. The audit log
  reads identically to a band-tap grant; the differentiator
  (typed-intent vs band-tap) lives in the surface's chat history
  alongside the message timestamp.

### Patch Changes

- b0f38a8: Break init-order cycle in `sensitivity.ts` so the bundled dist boots.

  Switched the `SensitivityLevel` import to `import type` and replaced
  enum-member computed keys (`[SensitivityLevel.None]`) with the
  string-literal keys the enum's runtime values evaluate to (`none`).

  The bundled tsup output evaluates modules in linear order — `sensitivity.ts`
  initializes its `SENSITIVITY_RANK` record before `index.ts` assigns the
  enum's runtime values, so `[SensitivityLevel.None]: 0` crashed on first
  access ("Cannot read properties of undefined (reading 'None')"). vitest
  masked this with live TS bindings; the dist-smoke gate caught it on the
  companion minor's push attempt.

  No public-API change: the `Record<SensitivityLevel, number>` type still
  binds keys to the enum at the type layer, so a future tier rename
  remains a single-file edit at the enum site. Pairs with the same-PR
  `feat(protocol): sensitivity ladder algebra` minor.

- 28added: **Third slice of PR 1 of the agent-surface pivot — cobrowse-as-mode reshape (protocol half).** Adds `yield_control` to the `CO_BROWSE_TRANSITION_KINDS` closed registry. Symmetric protocol-level partner to `release_control` (motebit yields to user) on the user side, closing the polarity-asymmetry where the protocol named "user takes" (`reclaim_control`) but not "user gives." Implicit when the user was the always-default driver; named explicitly now that motebit-default is the new register. Doctrine: [`chrome-as-state-render.md`](https://github.com/hakimlabs/motebit/blob/main/docs/doctrine/chrome-as-state-render.md) § "user register — cobrowse mode entered."

  Why a distinct transition rather than re-using `request_control + grant_control` as a compound: a single explicit `yield_control` produces one audit event with the right semantics ("user handed back"); the request-then-grant compound would produce two events that a verifier would have to recognize as a paired pattern. The audit log is the source of truth for "who was driving when"; one transition kind keeps the log legible.

  Additive `@alpha` registry entry; existing verifiers see the new kind as an unknown literal and reject (closed-set discipline). API-extractor baseline regenerated. The runtime-side counterpart — `yieldControl(by: "user")` method on `CoBrowseControlMachine`, web-side `/back` slash command + "motebit waiting" chip-button + handler wiring — ships in the ignored sibling `.changeset/slab-chrome-cobrowse-as-mode-ignored.md`.

## 1.2.0

### Minor Changes

- c8c6312: Hardware-attestation badge ship 2 of 3 — surface the most-recent verified `HardwareAttestationClaim` per peer agent.

  Adds an optional `hardware_attestation?: HardwareAttestationClaim` field to `AgentTrustRecord`. The field is **never persisted** on the `agent_trust` row — it's projected at read time from the latest peer-issued `AgentTrustCredential` carrying the claim. The credential is the authoritative source; caching the claim on the trust row would invite drift on revocation or re-attestation.

  This closes the data-flow half of the doctrine breach documented in `docs/doctrine/self-attesting-system.md`: hardware attestation factors into peer ranking via `HardwareAttestationSemiring` (`packages/semiring/src/hardware-attestation.ts`) but was previously invisible in the Agents panel UI. Ship 1 (`756a38c3`) added the panels-controller types + helpers; this ship lights up runtime + relay forwarding; ship 3 will add per-surface badge rendering and the `check-trust-score-display` drift gate.

  Backwards-compatible. Consumers that don't read the new field are unaffected. The field is optional and absent for peers with no peer-issued `AgentTrustCredential` carrying a `hardware_attestation` claim.

- e1d86f2: Surface observed latency as a routing-input on `AgentTrustRecord`.

  Adds an optional `latency_stats?: { avg_ms; p95_ms; sample_count }` field to `AgentTrustRecord`. The field is **never persisted** on the `agent_trust` row — it's projected at read time from the local `LatencyStatsStore` (or the relay's `relay_latency_stats` view). The store is the authoritative source; caching avg/p95 on the trust row would invite drift on every new delegation.

  This closes the latency arm of the doctrine breach in `docs/doctrine/self-attesting-system.md`: latency factors into peer ranking via `agent-graph.ts`'s latency map (default 3000ms when stats are absent) but was previously invisible in the Agents-panel renderer. Sibling extension to the `hardware_attestation` field added in the HA badge ship — same shape, same projection-not-persistence pattern, same self-attesting-system doctrine.

  Backwards-compatible. Consumers that don't read the new field are unaffected. The field is optional and absent for peers with zero samples in the store.

  Field-name choice: `latency_stats` matches existing wire vocabulary (`task-routing.ts:387`, `listings.ts:180`) rather than introducing `latency_ms`. Object members (`avg_ms`, `p95_ms`, `sample_count`) match the `LatencyStatsStoreAdapter.getStats` return shape exactly.

  Runtime projection (`@motebit/runtime`), relay enricher (`@motebit/relay`), and per-surface rendering (`@motebit/{desktop,web,mobile}`) ship in the sibling `latency-surface-ignored.md` changeset.

- 44d25cd: Retention policy phase 4a + 4b-1 + 4b-2 — event-log horizon advance (per-motebit + operator-wide), signed `append_only_horizon` cert wiring, four production storage adapters implement `truncateBeforeHorizon`, and phase 3 regression fix.

  `@motebit/protocol`: `EventStoreAdapter` gains an optional `truncateBeforeHorizon(motebitId, horizonTs)` method — whole-prefix retention truncation for `append_only_horizon`-shaped stores per `docs/doctrine/retention-policy.md` §"Decision 4". Distinct from the existing `compact` (state-snapshot, version-clock-keyed); `truncateBeforeHorizon` is the storage operation behind a horizon deletion certificate. Optional in phase 4a (local-only horizon advance ships first); phase 4b tightens to required when federation co-witness lands.

  `@motebit/event-log`: new `EventStore.advanceHorizon(storeId, horizonTs, signer, options?)` — signs the cert via `signHorizonCertAsIssuer` first, then truncates. Order is load-bearing (sign-then-truncate) so no window exists where entries are gone but no cert attests it. Both subject kinds supported: per-motebit (signed by motebit identity key, truncates that motebit's slice) and operator-wide (signed by operator key, takes `motebitIdsForOperator: readonly string[]` and truncates each). Empty motebit set is permitted for no-tenant relays — the cert is still signed and represents the operator's commitment. Witness array stays empty until phase 4b-3 ships the federation co-witness solicitation; `witness_required` is derived as `false` for no-peer deployments per decision 9, which satisfies the verifier today.

  Adapter tightening — every production `EventStoreAdapter` that physically owns bytes now implements `truncateBeforeHorizon`: `@motebit/persistence` (better-sqlite3), `@motebit/browser-persistence` (IndexedDB cursor scan), `apps/desktop/src/tauri-storage.ts` (Tauri SQL plugin), `apps/mobile/src/adapters/expo-sqlite.ts` (expo-sqlite). Sync-engine adapters (ws/http/encrypted) remain proxy-only and don't implement local truncation. The interface stays optional so non-storage adapters can compose without false implementation; `EventStore.advanceHorizon` throws if the bound adapter doesn't implement it.

  Phase 3 regression fix: the consolidation cycle's retention-enforcement path now passes `self_enforcement` (subject's runtime drives policy, signed by motebit identity key) rather than `retention_enforcement` (which requires operator signature per decision 5's reason × signer table). Latent issue — no production consumer was running `verifyDeletionCertificate` against these certs yet, but the cert format was structurally invalid until this fix. Locked by the round-trip test in `@motebit/privacy-layer`. The doctrine table is updated to reflect that `self_enforcement` is admitted in every deployment mode, not sovereign-only.

  Two storage-side cleanups landed alongside: `apps/desktop/src/memory-commands.ts`'s `deleteMemory` UI command now passes `user_request` (was passing the motebit id as the reason string, which normalized silently to `user_request` after phase 3 but obscured the intent). The `MemoryGraph.deleteMemory (tombstoning)` test was renamed and rewritten as `MemoryGraph.deleteMemory (erase)` to match decision 7's storage semantics.

- 0233325: Retention policy phase 5-ship — conversations + tool-audit register under `consolidation_flush`.

  `@motebit/protocol`: thread the `sensitivity` field through the conversation/tool-audit type contracts so the consolidation cycle's flush phase has the input it needs to compute the per-record retention floor. Five additive type changes:
  - `ConversationStoreAdapter.appendMessage`'s `msg` shape gains `sensitivity?: SensitivityLevel`; `loadMessages`'s return-row shape mirrors. Two new optional methods — `enumerateForFlush(motebitId, beforeCreatedAt)` and `eraseMessage(messageId)` — wire the flush phase to per-row erase. Optional so non-storage adapters (e.g. desktop's IPC-cache renderer) can compose without false implementation; the flush phase is a no-op for adapters that omit them.
  - `SyncConversationMessage` gains `sensitivity?: SensitivityLevelString`. Optional in v1: peers running pre-phase-5 builds drop the field on push, and the receiver lazy-classifies on flush per `docs/doctrine/retention-policy.md` §"Decision 6b" using the operator's `pre_classification_default_sensitivity`.
  - `ToolAuditEntry` gains `sensitivity?: SensitivityLevel`. The flush phase computes `max(sensitivity_floor, obligation_floor)` per decision 3 — sensitivity is one input, obligation (settlement window, dispute window, regulatory floor) is the other. The obligation resolver lives at the runtime layer (`ConsolidationCycleDeps.toolAuditObligationFloorMs`) and defaults to 0 today.
  - `AuditLogSink` gains optional `enumerateForFlush(beforeTimestamp)` and `erase(callId)` methods, sibling to the conversation-store additions. Same composition rule.
  - `ConsolidationReceipt`'s `phases_run` / `phases_yielded` unions admit `"flush"`; the `summary` shape gains `flushed_conversations` and `flushed_tool_audits` counters. Adding a phase is a protocol-coordinated change; the cert format closes under additions.

  Wire-format-compatible at the protocol surface — every new field is optional. Peers running pre-phase-5 builds continue to interoperate; the receiver lazy-classifies missing fields on flush.

  The runtime flush phase, ConversationManager threading, three at-rest schemas, three migration registries (mobile v19 / persistence v34 / desktop v1), the relay manifest's `honest_gaps` three-category split, and the privacy-layer's `signFlushCert` primitive ship in the sibling `retention-policy-phase-5-ship-ignored.md`.

- 79dd661: Retention policy phase 6b — `RUNTIME_RETENTION_REGISTRY` + `check-retention-coverage` hard drift gate.

  `@motebit/protocol`: new `RUNTIME_RETENTION_REGISTRY` constant — the canonical registry of runtime-side stores subject to retention doctrine, mapping each `RuntimeStoreId` (`memory` | `event_log` | `conversation_messages` | `tool_audit`) to its registered `RetentionShapeDeclaration`. Per-motebit runtimes project this registry into their published retention manifests. The relay's deployment doesn't host these stores; its retention manifest declares `out_of_deployment:` for them by design (sibling boundary preserved).

  New drift gate `scripts/check-retention-coverage.ts` (invariant #67, sibling enforcement pattern to `check-consolidation-primitives` and `check-suite-declared`). Bidirectional check across the runtime-side surfaces (`apps/mobile`, `apps/desktop`, `packages/persistence`, `packages/browser-persistence`):
  - **Forward**: every entry in `RUNTIME_RETENTION_REGISTRY` has a matching `CREATE TABLE` in at least one runtime-side surface; `consolidation_flush`-shape entries also carry a `sensitivity` column (in the at-rest schema or via `ALTER TABLE ADD COLUMN` migration).
  - **Reverse**: every `CREATE TABLE` with a `sensitivity` column maps to a registered store. A future schema adding `sensitivity TEXT` without registering would otherwise leak past the doctrinal ceiling because the consolidation cycle's flush phase doesn't see unregistered stores.

  The doctrine reserved drift-defense slot #52 in phase 1; that slot was occupied during post-doctrine renumbering, so the gate landed at the next free invariant number (#67). Doctrine prose at `docs/doctrine/retention-policy.md` §"Drift defense" updated to reflect the durable assignment.

  Closes the meta-version of the original CLAUDE.md gap that motivated the entire retention-policy arc — "fail-closed privacy" claimed retention enforcement existed; phases 2–5 built the enforcement; this gate makes the doctrinal claim self-attesting at CI time.

- fe0996e: Retention policy phase 2 — protocol algebra + signed `DeletionCertificate` verifier dispatcher + retention manifest wire schema.

  Lands the typed surface for `docs/doctrine/retention-policy.md`'s ten phase-1 decisions. New types in `@motebit/protocol`: `RetentionShape` and `DeletionCertificate` discriminated unions (three arms each — `mutable_pruning`, `append_only_horizon`, `consolidation_flush`); `RetentionManifest` for the operator-published, signed declaration; `MAX_RETENTION_DAYS_BY_SENSITIVITY` interop-law ceiling and `REFERENCE_RETENTION_DAYS_BY_SENSITIVITY` reference defaults; `FederationGraphAnchor` and `MerkleInclusionProof` reservations for phase 4's quorum mechanism; per-arm signature blocks (`SubjectSignature`, `OperatorSignature`, `DelegateSignature`, `GuardianSignature`) keyed by the action-class table from decision 5.

  New verifier dispatcher in `@motebit/crypto`: `verifyDeletionCertificate(cert, ctx)` routes by `kind`, checks the reason × signer × mode table for admissible signer composition, then verifies every present signature through `verifyBySuite`. Per-arm sign helpers (`signCertAsSubject`, `signCertAsOperator`, `signCertAsDelegate`, `signCertAsGuardian`, `signHorizonCertAsIssuer`, `signHorizonWitness`) construct the canonical signing bytes once per arm. Multi-signature certs sign identical canonical bytes (cert minus all `*_signature` fields) — same shape as identity-v1 §3.8.1 dual-signature succession. Witnesses on `append_only_horizon` certs sign the body minus `witnessed_by`, so co-signing is asynchronous; the issuer's separate signature commits to the assembled witness array, catching forgery or substitution.

  The legacy unsigned `DeletionCertificate` in `@motebit/encryption` is marked `@deprecated`; the new union is the replacement. Phase 3 wires memory's prune phase to the signed cert path; phase 4 lands the federation co-witness handshake; phase 5 registers conversations and tool-audit under `consolidation_flush`; phase 6 ships `/.well-known/motebit-retention.json` plus the `check-retention-coverage` drift gate.

  Backwards-compatible at the protocol surface — purely additive type and schema growth. The `@motebit/encryption` deprecation is private-package signal only; concrete callers (privacy-layer, runtime consolidation cycle) migrate in phase 3.

- 374a960: Retention phase 4b-3 commit 1 — protocol shape for federation co-witness solicitation.

  Adds the type-level surface for Path A quorum's soft accountability layer on `append_only_horizon` retention certs.

  `EMPTY_FEDERATION_GRAPH_ANCHOR` is the canonical self-witnessed encoding — `algo: "merkle-sha256-v1"`, `merkle_root` is the SHA-256 of zero bytes, `leaf_count: 0`. The verifier dispatch arm in `@motebit/crypto` (commit 2) admits this anchor with an empty `witnessed_by[]` so deployments without federation peers continue to issue valid horizon certs. The `federation_graph_anchor` field stays optional at the type level for pre-4b-3 grandfathering; verifier policy enforces presence-when-peered once relay-side machinery lands.

  `WitnessOmissionDispute` is the dispute artifact a peer files within 24h of `cert.issued_at` when they believe `witnessed_by[]` wrongly omits them. Two evidence shapes: `inclusion_proof` (the disputant proves anchor membership via `MerkleInclusionProof` against the cert's published `merkle_root`) and `alternative_peering` (the disputant supplies a signed peering artifact from the cert issuer covering `horizon_ts`, claiming the anchor itself is incomplete). Evidence is a discriminated union — exactly one shape per dispute. The existing `DisputeResolution` adjudication path consumes both; certificates remain terminal per `retention-policy.md` decision 5, so a sustained dispute is a reputation hit on the issuer, not a cert invalidation.

  Backwards-compatible. The new exports are additive; the change to `DeletionCertificate.append_only_horizon` only adds a JSDoc note next to the already-optional `federation_graph_anchor?` field. Sign + verify primitives, the 24h window constant, and the dispute test suite land in commit 2 (`@motebit/crypto`); zod + JSON schema emission lands in commit 3 (`@motebit/wire-schemas`).

- a2ce037: Retention phase 4b-3 commit 3 — protocol shapes for the federation co-witness solicitation RPC, paired with zod + JSON Schema emission in the (private) `@motebit/wire-schemas` package.

  Adds the type-level surface for the relay↔relay envelope that operationalizes Path A quorum:

  `HorizonWitnessRequestBody` is the cert body witnesses canonicalize and sign. Mirrors the `append_only_horizon` arm of `DeletionCertificate` minus `witnessed_by[]` and minus the top-level `signature` field — exactly the shape `canonicalizeHorizonCertForWitness` in `@motebit/crypto/deletion-certificate.ts` produces at verification time. Witness signatures are portable across witness compositions of the same body; the issuer's eventual `cert.signature` is what binds the assembled `witnessed_by[]`.

  `WitnessSolicitationRequest` is the issuer relay's outbound RPC body to a federation peer (`POST /federation/v1/horizon/witness`, lands in commit 4). Carries `cert_body`, the issuer's identifier, and the issuer's base64url Ed25519 signature over `canonicalJson(cert_body)`. The signature payload is byte-equal to what the witness will sign, so the peer's verify-the-issuer + sign-as-witness paths share canonical-bytes derivation.

  `WitnessSolicitationResponse` is the peer's reply — structurally identical to a `cert.witnessed_by[]` entry (`motebit_id`, `signature`, optional `inclusion_proof`). Distinct named type from `HorizonWitness` for RPC-surface clarity; the issuer copies the response verbatim into the assembled cert before producing its final cert signature.

  The zod schemas, JSON Schema artifacts (`spec/schemas/witness-{omission-dispute,solicitation-request,solicitation-response}-v1.json`), and drift gate (`drift.test.ts` extended with three new cases) all land in this commit. `@motebit/wire-schemas` is in the changeset-ignored list — the schemas ride this changeset for the protocol-side type additions only.

  Backwards-compatible. All three exports are additive. The `WitnessOmissionDispute` schema lands here against the protocol type added in commit 1; verifier dispatching against it lives in `@motebit/crypto` from commit 2. Relay-side endpoints + horizon-advance flow lands in commit 4; spec bump (`relay-federation-v1` 1.0 → 1.1) lands in commit 6.

- 4d05d70: Wire-format additions for §6.2 federation dispute orchestration (`relay-federation@1.2` §16, `dispute-v1` §6.4 + §6.5 + §8.3).

  Two changes, both additive at the package level:

  ```ts
  // AdjudicatorVote — new field
  interface AdjudicatorVote {
    dispute_id: string;
    round: number; // NEW — 1 for original, 2 for §8.3 appeal
    peer_id: string;
    vote: DisputeOutcome;
    rationale: string;
    suite: "motebit-jcs-ed25519-b64-v1";
    signature: string;
  }

  // VoteRequest — new type (leader-to-peer fan-out body for §16)
  interface VoteRequest {
    dispute_id: string;
    round: number;
    dispute_request: DisputeRequest;
    evidence_bundle: DisputeEvidence[];
    requester_id: string;
    requested_at: number;
    suite: "motebit-jcs-ed25519-b64-v1";
    signature: string;
  }
  ```

  `AdjudicatorVote.round` is signature-bound per `dispute-v1.md` §6.5 + §8.3 — round-1 vote bytes do not satisfy round-2 binding even for the same evidence. Cross-round vote replay is cryptographically rejected, not enforced by leader bookkeeping. The §8.3 round-isolation property holds at the wire-format level.

  `VoteRequest` carries the leader's signature over `canonicalJson(body minus signature)`, binding `dispute_id`, `round`, `requester_id`, and the evidence bundle.

  Sibling consumers updated:
  - `@motebit/wire-schemas` regenerated `adjudicator-vote-v1.json` + new `vote-request-v1.json`
  - `@motebit/crypto`'s `signAdjudicatorVote` / `verifyAdjudicatorVote` already operate on `canonicalJson(body)`, so the new field is bound automatically without primitive changes — sibling test added (`verify-artifacts.test.ts`) for the round-binding invariant
  - `services/relay/src/federation.ts` adds the `POST /federation/v1/disputes/:disputeId/vote-request` peer-side handler
  - `dispute-v1.md` stays at @1.0 Draft per the convention (Draft accumulates additive normative changes without bump)
  - `relay-federation-v1.md` H1 bumps 1.1 → 1.2 + new §16

  No existing in-the-wild `AdjudicatorVote` consumer is broken by the new required `round` field — federation orchestration was 409-blocked under the §6.5 self-adjudication guard prior to this arc; the type existed but no one was producing or consuming the wire artifact. Minor bump rather than major reflects the empty-shipped-consumer-set + Draft-spec-status combination; if a downstream pinned to the pre-round shape, this would have been major.

- 98c1273: Privacy doctrine — sensitivity-aware tool dispatch (v2 of sensitivity routing), protocol-surface half.

  `ToolDefinition` gains `outbound?: boolean`. Independent of `riskHint` (which captures local risk: file overwrite, irreversible side effect); `outbound` captures the network axis. Default `false`/absent ≡ local — matches the pre-existing builtin set (`read_file`, `recall_memories`, `current_time`).

  **The principle generalized.** "Medical/financial/secret never reach external AI" was originally framed around AI providers. The architectural framing is broader: the doctrine is about any byte-leaving-the-device boundary. AI provider calls (v1) and outbound tool calls (v2) are two instances of the same boundary; the gate predicate is shared. Future ships extending the same predicate to other outbound surfaces (e.g., relay-side delegation gating, direct webhook tools) compose cleanly — same flag, same gate, same error type.

  Backwards-compatible. Tools that don't set `outbound` default to `false` (local). The runtime/tools/mcp-client consumer wiring ships in the sibling `sensitivity-routing-v2-tool-gate-ignored.md` changeset.

- 2a48142: Skills v1 phase 3: per-skill audit entries in the execution ledger (spec/skills-v1.md §7.4).

  Every skill the runtime's `SkillSelector` pulls into context now produces one `EventType.SkillLoaded` event-log entry, immediately after the selector returns and before the AI loop receives the system prompt. The audit trail lets a user prove later: _"the obsidian skill ran on date X with this exact signature value at session sensitivity Y."_

  **`@motebit/protocol`** — adds the wire-format type and event:

  ```text
  SkillLoadPayload  { skill_id, skill_name, skill_version, skill_signature,
                      provenance, score, run_id?, session_sensitivity }
  EventType.SkillLoaded
  ```

  **`@motebit/sdk`** — extends `SkillInjection` with two audit-only fields the runtime threads into the ledger entry:

  ```text
  SkillInjection.score      BM25 relevance — surfaces selection rationale
  SkillInjection.signature  Envelope signature.value — content-addressed pointer
                            to the exact bytes loaded; empty for trusted_unsigned
  ```

  The AI loop's prompt builder ignores both fields (rendering stays unchanged). They ride only into the `SkillLoaded` event payload.

  **`motebit`** (CLI) — runtime-factory's hook now passes `score` + `signature` through from the BSL `SkillSelector` result.

  Best-effort emission: a failed `eventStore.append` is logged via `runtime._logger.warn("skill_load_event_append_failed", ...)` and the AI loop proceeds. Audit absence (skill loaded without matching event) is preferable to a turn blocked on a transient storage error.

  Skill_signature audit utility: a stale ledger entry whose signature does not resolve in the current registry is itself a useful signal — the skill was re-signed (legitimate update) or removed (less common). Both provable from the audit trail without retaining the original bytes.

  Wire-schema artifact: `spec/schemas/skill-load-payload-v1.json` ships under Apache-2.0 alongside the existing skills schemas.

  4 new runtime tests cover: emit-with-payload, empty-selector, selector-throw (loop continues), no-hook-wired. 683/683 runtime, all 54 drift gates green.

- cabf61d: Add `motebit/skills-registry@1.0` wire types — the relay-hosted index of submitted, signature-verified skill envelopes.

  Five new exported types: `SkillRegistryEntry` (one row in the index), `SkillRegistrySubmitRequest` and `SkillRegistrySubmitResponse` (POST /api/v1/skills/submit), `SkillRegistryListing` (GET /api/v1/skills/discover, paginated), `SkillRegistryBundle` (GET /api/v1/skills/:submitter/:name/:version, full payload).

  Spec: [`spec/skills-registry-v1.md`](https://raw.githubusercontent.com/motebit/motebit/main/spec/skills-registry-v1.md). The submitter component of every addressing tuple is canonical — derived from `envelope.signature.public_key` by the relay, never user-provided. Submission is permissive-by-signature; discovery is curated-by-default with full opt-in. The relay stores submitted bundles byte-identical so consumers re-verify offline against the embedded signature key — relay is a convenience surface, not a trust root.

  Why this lands here, not in a new package: registry types are wire format, not runtime logic. They follow the same layering as `SkillEnvelope` and `SkillManifest` — protocol types in `@motebit/protocol`, zod schemas in `@motebit/wire-schemas`, runtime in `services/relay` and `apps/cli`. No new package boundaries.

  Backwards-compatible. Pure additive change.

- 9b4a296: Add agentskills.io-compatible procedural-knowledge runtime per `spec/skills-v1.md`.

  Skills are user-installable markdown files containing procedural knowledge — when to use a tool, in what order, with what verifications. Open standard from Anthropic adopted across Claude Code, Codex, Cursor, GitHub Copilot. This release layers motebit-namespaced extensions on top of the standard frontmatter, ignored by non-motebit runtimes.

  **`@motebit/protocol`** — adds wire types for the new skill artifacts:

  ```text
  SkillSensitivity            "none" | "personal" | "medical" | "financial" | "secret"
  SkillPlatform               "macos" | "linux" | "windows" | "ios" | "android"
  SkillSignature              { suite, public_key, value }
  SkillHardwareAttestationGate { required?, minimum_score? }
  SkillManifest               full parsed frontmatter
  SkillEnvelope               content-addressed signed wrapper
  SKILL_SENSITIVITY_TIERS, SKILL_AUTO_LOADABLE_TIERS, SKILL_PLATFORMS  frozen const arrays
  ```

  **`@motebit/crypto`** — adds offline-verifiable sign/verify pipeline using the `motebit-jcs-ed25519-b64-v1` suite (sibling to execution receipts, NOT W3C `eddsa-jcs-2022`):

  ```text
  canonicalizeSkillManifestBytes(manifest, body)  -> Uint8Array
  canonicalizeSkillEnvelopeBytes(envelope)        -> Uint8Array
  signSkillManifest / signSkillEnvelope
  verifySkillManifest / verifySkillEnvelope (+ Detailed variants)
  decodeSkillSignaturePublicKey(sig)              -> Uint8Array
  SKILL_SIGNATURE_SUITE                           const
  ```

  **`motebit`** (CLI) — adds the user-facing surface:

  ```text
  motebit skills install <directory>
  motebit skills list
  motebit skills enable | disable <name>
  motebit skills trust | untrust <name>
  motebit skills verify <name>
  motebit skills remove <name>
  /skills                       (REPL slash — list with provenance badges)
  /skill <name>                 (REPL slash — show full details)
  ```

  Install is permissive (filesystem record, sibling to `mcp_trusted_servers` add); auto-load is provenance-gated (the act layer). The selector filters by enabled+trusted+platform+sensitivity+hardware-attestation before BM25 ranking on description. Manual trust grants emit signed audit events to `~/.motebit/skills/audit.log` without manufacturing cryptographic provenance.

  Two new drift gates land alongside: `check-skill-corpus` (every committed reference skill verifies offline against its committed signature) and `check-skill-cli-coverage` (every public `SkillRegistry` method has a `motebit skills <verb>` dispatch arm).

  Phase 1 ships frontmatter + envelope + signature scheme + sensitivity tiers + trust gate + the eight subcommands + REPL slashes + drift gates + one signed dogfood reference (`skills/git-commit-motebit-style/`). Phase 2: `SkillSelector` wired into the runtime context-injection path, plus `scripts/` quarantine + per-script approval. Phase 3: signed `SkillLoadReceipt` in `execution-ledger-v1`. Phase 4: sibling-surface skill browsers + curated registry.

## 1.1.0

### Minor Changes

- a428cf9: Ship `@motebit/crypto-android-keystore` — the canonical Apache-2.0 verifier for Android Hardware-Backed Keystore Attestation. Sibling of `crypto-appattest` / `crypto-tpm` / `crypto-webauthn` in the permissive-floor crypto-leaf set; replaces `crypto-play-integrity` as the sovereign-verifiable Android primitive.

  ## Why

  Hardware attestation has three architectural categories — see `docs/doctrine/hardware-attestation.md` § "Three architectural categories". `crypto-play-integrity` was scaffolded as a sovereign-verifiable leaf, but Google's Play Integrity API is per-app-key / network-mediated by deliberate design — verification cannot satisfy motebit's invariant of public-anchor third-party verifiability. Android Hardware-Backed Keystore Attestation IS the architecturally-correct Android primitive: device chains terminate at Google's published Hardware Attestation roots, exactly the FIDO/Apple-App-Attest pattern.

  Time-sensitive: Google rotated the attestation root family between Feb 1 and Apr 10, 2026. The legacy RSA-4096 root stays valid for factory-provisioned devices; new RKP-provisioned devices switched exclusively to ECDSA P-384 after 2026-04-10. Verifiers shipping today MUST pin both — `crypto-android-keystore` does.

  ## What shipped

  ```text
  @motebit/crypto-android-keystore@1.0.0  (initial release)
    src/google-roots.ts            both Google roots pinned with SHA-256 fingerprints + source attribution
    src/asn1.ts                    hand-rolled DER walker for the AOSP KeyDescription extension
    src/verify.ts                  X.509 chain validation + KeyDescription constraint enforcement
    src/index.ts                   androidKeystoreVerifier(...) factory + public types
    src/__tests__/google-roots.test.ts   trust-anchor attestation (parse, fingerprint, validity)
    src/__tests__/verify.test.ts         25 tests covering happy path + every rejection branch
  ```

  Verification: 28/28 tests pass; coverage 86.01% statements / 74.41% branches / 100% functions / 86.01% lines (thresholds 85/70/100/85); typecheck + lint + build clean; `check-deps`, `check-claude-md`, `check-hardware-attestation-primitives` all pass.

  ## Protocol surface threading
  - `@motebit/protocol` — adds `"android_keystore"` to `HardwareAttestationClaim.platform` union.
  - `@motebit/wire-schemas` — adds to the zod enum + regenerates committed JSON schemas.
  - `@motebit/crypto` — adds `androidKeystore` slot to `HardwareAttestationVerifiers` interface + dispatcher case.
  - `@motebit/semiring` — adds `android_keystore` to the hardware-platform scoring case (same `1.0` floor as siblings).

  All additive; no breaking changes. Consumers that don't emit or accept the new platform are unaffected.

  ## Real-fixture coverage

  Synthetic chain coverage exercises every verifier branch via in-process fabricated certs with the AOSP KeyDescription extension. A real-device fixture (matching the WebAuthn moat-claim pass) ships in a follow-up — privacy review needed because Android Keystore chains carry `verifiedBootKey` and `attestationApplicationId` data that may be device-identifying.

- 950555c: Add optional `hardware_attestation_credential` field to `DeviceRegistration`.

  ## Why

  Phase 1 of the hardware-attestation peer flow needs an identity-metadata channel for a worker's self-issued `AgentTrustCredential` (carrying a `hardware_attestation` claim) to be discoverable by peer verifiers. The cascade-mint primitives have shipped on all five surfaces since 2026-04-19, but the credentials they produce have been inert because `/credentials/submit` rejects self-issued credentials by spec §23.

  The peer-flow architecture (per `lesson_hardware_attestation_self_issued_dead_drop.md`) is: subject mints + holds; peers verify + issue. For peers to verify, they need a discovery channel for the subject's self-issued claim. The `/credentials/submit` carve-out approach was rejected on review (it reintroduces the wire shape commit `63fa2199` unwound). The right home is identity metadata: the device record carries the credential; the existing `GET /agent/:motebitId/capabilities` endpoint exposes it.

  ## What shipped
  - `DeviceRegistration` interface gains `hardware_attestation_credential?: string`. JSON-serialized signed VC. Optional — NULL/omitted preserves the existing wire format and storage shape.
  - The persistence layer (`@motebit/persistence`) adds a `hardware_attestation_credential TEXT` column to the `devices` table via migration #33. Backwards compatible — existing rows have NULL, behave as before.
  - The `/credentials/submit` self-issued rejection (`spec/credential-v1.md` §23, §9.1.5) is **unchanged**. The new field lives on the device record, not the credential index.

  Additive optional field; consumers that don't read the field are unaffected. The change is `minor` per semver.

### Patch Changes

- 9923185: Rename `DEFAULT_TRUST_THRESHOLDS` → `REFERENCE_TRUST_THRESHOLDS` (additive + deprecation, no behavior change).

  ## Why

  `DEFAULT_TRUST_THRESHOLDS` is exported from `@motebit/protocol` — the permissive-floor layer whose rule (see `packages/protocol/CLAUDE.md` rule 1) is "types, enums, constants, deterministic math." The values (`promoteToVerified_minTasks: 5`, `demote_belowRate: 0.5`, etc.) are constants, so they technically fit, but the **name** claimed more protocol authority than they carry:
  - The semiring algebra above (`trustAdd`, `trustMultiply`, `TRUST_LEVEL_SCORES`, `TRUST_ZERO`, `TRUST_ONE`) IS interop law — two motebit implementations MUST compute trust the same way to exchange scores across federation boundaries.
  - The transition thresholds (when to promote an agent, when to demote) are **motebit product tuning** — a federated implementation can choose stricter or looser values and still interoperate. The scores are compared; the policy that derives them is not.

  The `DEFAULT_` prefix read as "THE value every motebit implementation uses." `REFERENCE_` correctly signals "motebit's reference default; implementers MAY choose their own."

  ## What shipped
  - New export: `REFERENCE_TRUST_THRESHOLDS` from `@motebit/protocol` (identical values, clearer name)
  - Deprecation: `DEFAULT_TRUST_THRESHOLDS` marked `@deprecated since 1.0.1, removed in 2.0.0` with pointer to the new name and the reason above
  - Internal consumers (`@motebit/semiring`, `@motebit/market`, reference tests) migrated to the new name
  - Parity test in `packages/protocol/src/__tests__/trust-algebra.test.ts` asserts `DEFAULT_TRUST_THRESHOLDS === REFERENCE_TRUST_THRESHOLDS` until the 2.0.0 removal, preventing silent divergence during the deprecation window

  ## Impact

  Zero runtime change. Third-party consumers pinned to `@motebit/protocol@1.x` keep working — the old export is re-exported as an alias. Consumers should migrate to `REFERENCE_TRUST_THRESHOLDS` at their convenience before 2.0.0. The `check-deprecation-discipline` gate (drift-defenses #39) tracks the sunset.

## 1.0.0

### Major Changes

- ceb00b2: Add `dispute_id` to `AdjudicatorVote`. The signature now covers
  `dispute_id`, preventing vote-replay across disputes.

  Closes audit finding #3 from the cross-plane review. The previous
  shape (no `dispute_id` in the signed body) meant a vote signed for
  dispute A could be replayed verbatim into dispute B's
  `adjudicator_votes` array. Foundation law §6.5 calls for individual
  per-peer votes for federation auditability — without dispute_id
  binding, a malicious adjudicator collecting old votes from other
  disputes could stuff them into a new resolution and the per-vote
  signatures would still verify.

  Zero current production impact: no production code today signs or
  verifies AdjudicatorVote (no `signAdjudicatorVote` /
  `verifyAdjudicatorVote` in `@motebit/crypto`), and the relay's
  production dispute code hardcodes `adjudicator_votes: []` for
  single-relay adjudication. This is a forward-design fix, shipped
  before federation adjudication ships so the wire format is
  replay-safe from day one rather than carrying migration debt.

  ## Migration

  `AdjudicatorVote.dispute_id` is now a required field in the wire
  format. Any consumer constructing an `AdjudicatorVote` must add it:

  ```diff
   const vote: AdjudicatorVote = {
  +  dispute_id: "<dispute UUID this vote applies to>",
     peer_id: "<federation peer motebit_id>",
     vote: "upheld",
     rationale: "...",
     suite: "motebit-jcs-ed25519-b64-v1",
     signature: "<base64url Ed25519 over canonical JSON of all fields except signature>",
   };
  ```

  Signers MUST include `dispute_id` in the canonical body before
  computing the Ed25519 signature. Verifiers reconstructing the
  canonical bytes MUST include `dispute_id` for the signature to
  verify.

  No database migration needed (single-relay adjudication writes
  `"[]"` to `relay_dispute_resolutions.adjudicator_votes` in the
  relay; federation adjudication is not yet shipped). Future
  federation adjudication implementations consume the new shape from
  day one.

  Spec: `spec/dispute-v1.md` §6.4 wire format updated; §6.5 foundation
  law adds the binding requirement.

- 009f56e: Add cryptosuite discriminator to every signed wire-format artifact.

  `@motebit/protocol` now exports `SuiteId`, `SuiteEntry`, `SuiteStatus`,
  `SuiteAlgorithm`, `SuiteCanonicalization`, `SuiteSignatureEncoding`,
  `SuitePublicKeyEncoding`, `SUITE_REGISTRY`, `ALL_SUITE_IDS`, `isSuiteId`,
  `getSuiteEntry`. Every signed artifact type gains a required `suite:
SuiteId` field alongside `signature`. Four Ed25519 suites enumerated
  (`motebit-jcs-ed25519-b64-v1`, `motebit-jcs-ed25519-hex-v1`,
  `motebit-jwt-ed25519-v1`, `motebit-concat-ed25519-hex-v1`) plus the
  existing W3C `eddsa-jcs-2022` for Verifiable Credentials.

  Verifiers reject missing or unknown `suite` values fail-closed. No
  legacy compatibility path. Signers emit `suite` on every new artifact.

  Identity file signature format changed:
  - Old: `<!-- motebit:sig:Ed25519:{hex} -->`
  - New: `<!-- motebit:sig:motebit-jcs-ed25519-hex-v1:{hex} -->`

  The `identity.algorithm` frontmatter field is deprecated (ignored with
  a warning when present; no longer emitted on export).

  Post-quantum migration becomes a new `SuiteId` entry + dispatch arm in
  `@motebit/crypto/suite-dispatch.ts`, not a wire-format change.

  ## Migration

  This release is breaking for every consumer that constructs, signs, or verifies a motebit signed artifact. The change is mechanical — add one field on construction, pass one argument on sign, re-sign identity files once — but there is no legacy acceptance path, so every caller must update in lockstep. Verifiers reject unsuited or unknown-suite artifacts fail-closed. Migration steps follow, grouped by the consumer surface.

  ### For consumers of `@motebit/protocol` types

  Every signed-artifact type now has a required `suite: SuiteId` field.
  Anywhere you construct one (tests, mocks, fixtures), add the correct
  suite value for that artifact class — see `SUITE_REGISTRY`'s
  `description` field for the per-artifact assignment, or consult
  `spec/<artifact>-v1.md §N.N` for the binding wire format.

  ```ts
  // Before
  const receipt: ExecutionReceipt = {
    task_id, motebit_id, ...,
    signature: sigHex,
  };

  // After
  import type { SuiteId } from "@motebit/protocol";
  const receipt: ExecutionReceipt = {
    task_id, motebit_id, ...,
    suite: "motebit-jcs-ed25519-b64-v1" satisfies SuiteId,
    signature: sigHex,
  };
  ```

  ### For consumers of `@motebit/crypto` sign/verify helpers

  Sign helpers that previously accepted just keys now require a `suite`
  parameter constrained to the suites valid for the artifact class:

  ```ts
  // Before
  const receipt = await signExecutionReceipt(body, privateKey);

  // After
  const receipt = await signExecutionReceipt(body, privateKey, {
    suite: "motebit-jcs-ed25519-b64-v1",
  });
  ```

  Verify helpers route through the internal `verifyBySuite` dispatcher;
  direct calls are unchanged at the boundary, but behavior now rejects
  artifacts without a `suite` field (legacy-no-suite path is deleted).

  ### For consumers of `motebit.md` identity files

  Identity files signed before this release will fail to parse. Re-sign
  by running `motebit export --regenerate` (or the CLI equivalent) after
  upgrading. The `identity.algorithm` YAML field is ignored on new
  parses and no longer emitted on export.

  ### For consumers of `DelegationToken` (`@motebit/crypto`)

  `DelegationToken` carries two breaking changes beyond the suite addition.
  Public keys are now **hex-encoded** (64 chars, lowercase) instead of
  base64url — consistent with every other Ed25519-key-carrying motebit
  artifact. And `signDelegation` takes `Omit<DelegationToken, "signature"
| "suite">` (the signer stamps the suite).

  ```ts
  // Before
  const token = await signDelegation(
    {
      delegator_id,
      delegator_public_key: toBase64Url(kp.publicKey),
      delegate_id,
      delegate_public_key: toBase64Url(otherKp.publicKey),
      scope,
      issued_at,
      expires_at,
    },
    kp.privateKey,
  );

  // After
  const token = await signDelegation(
    {
      delegator_id,
      delegator_public_key: bytesToHex(kp.publicKey),
      delegate_id,
      delegate_public_key: bytesToHex(otherKp.publicKey),
      scope,
      issued_at,
      expires_at,
    },
    kp.privateKey,
  );
  // token.suite is stamped as "motebit-jcs-ed25519-b64-v1"
  ```

  Verifiers reject tokens without `suite` (or with any value other than
  `"motebit-jcs-ed25519-b64-v1"`) fail-closed, and decode `delegator_public_key`
  from hex. Base64url-encoded tokens issued before this release do not
  verify — pre-launch, no migration tool is provided; re-issue tokens
  after upgrading.

  ### Running the new drift gates locally

  `pnpm run check` now runs ten drift gates (previously eight). Two new
  gates — `check-suite-declared` and `check-suite-dispatch` — enforce
  that every signed Wire-format spec section names a `suite` field and
  that every verifier in `@motebit/crypto` dispatches via the shared
  `verifyBySuite` function (no direct primitive calls).

- 2d8b91a: **Permissive floor flipped from MIT to Apache-2.0. Every contributor's work on the floor now carries an explicit, irrevocable patent grant and a patent-litigation-termination clause.**

  The `@motebit/protocol`, `@motebit/sdk`, `@motebit/crypto`, `@motebit/verifier`, `create-motebit`, the four `@motebit/crypto-*` hardware-attestation platform leaves (Apple App Attest, Google Play Integrity, TPM 2.0, WebAuthn), and the `motebit-verify` GitHub Action — the permissive-floor packages — have moved from MIT to Apache-2.0 in a coordinated release. The `spec/` tree carries Apache-2.0 too; every committed JSON Schema artifact under `spec/schemas/*.json` carries `"$comment": "SPDX-License-Identifier: Apache-2.0"` as its first field.

  ## Why
  1. **Patent clarity across the floor.** The floor now includes four verifiers operating against vendor attestation chains in heavy patent territory — Apple, Google, Microsoft, Infineon, Nuvoton, STMicroelectronics, Intel, Yubico, the FIDO Alliance. The VC/DID space the protocol builds on also carries patent filings. Apache-2.0 §3 grants every contributor's patent license irrevocably; §4.2 terminates the license of anyone who litigates patent claims against the Work. MIT is silent on patents.
  2. **Convergence.** The BSL runtime converts to Apache-2.0 at the Change Date (four years after each version's first public release). With the floor at MIT, the end state was MIT floor + Apache-2.0 runtime — two licenses forever. With the floor at Apache-2.0, the end state is one license: one posture, one patent grant, one procurement decision. Motebit's meta-principle is "never let spec and code diverge"; a built-in two-license end state is exactly the drift the rest of the codebase is designed to prevent.
  3. **Enterprise and standards-track posture.** Identity infrastructure that serious operators bet on ships Apache-2.0: Kubernetes, Kafka, Envoy, Istio, OpenTelemetry, SPIFFE, Keycloak. The IETF and W3C working groups that may eventually carry motebit specs also ship reference implementations under Apache-2.0. The license is part of the signal that motebit is protocol infrastructure, not an npm utility library.

  ## What changed at npm
  - `@motebit/protocol` `license` field: `"MIT"` → `"Apache-2.0"`.
  - `@motebit/sdk` `license` field: `"MIT"` → `"Apache-2.0"`.
  - `@motebit/crypto` `license` field: `"MIT"` → `"Apache-2.0"`.
  - `@motebit/verifier` `license` field: `"MIT"` → `"Apache-2.0"`.
  - `create-motebit` `license` field: `"MIT"` → `"Apache-2.0"`.
  - Each package's `LICENSE` file is replaced with the canonical Apache-2.0 text plus the existing trademark-reservation paragraph.
  - The `@motebit/crypto-appattest`, `@motebit/crypto-play-integrity`, `@motebit/crypto-tpm`, `@motebit/crypto-webauthn` leaves (currently private, bundled into `@motebit/verify`) also flip to Apache-2.0 at the source level.
  - A new `NOTICE` file at the repository root names the project, copyright holder, and trademark reservation per Apache §4.
  - The orphaned root `LICENSE-MIT` file is removed; the protocol badge and doctrine now point at `LICENSING.md` and the per-package `LICENSE` files.
  - `spec/` LICENSE is rewritten to Apache-2.0; the 52 committed JSON Schema artifacts under `spec/schemas/*.json` carry the `Apache-2.0` SPDX stamp.

  ## Migration

  For downstream consumers of the floor packages: **no code change required**. Apache-2.0 is strictly broader than MIT — everything permitted under MIT remains permitted under Apache-2.0. The `license` field in the npm manifest changes value, the installed `LICENSE` text changes shape, and the published `NOTICE` file appears, but nothing about importing or calling these packages changes.

  ```diff
    // Before — consumer's package.json
    "dependencies": {
  -   "@motebit/protocol": "^0.8.0"   // MIT
  +   "@motebit/protocol": "^1.0.0"   // Apache-2.0
    }
  ```

  ```ts
  // Before and after — no code change; same imports, same behavior
  import type { ExecutionReceipt } from "@motebit/protocol";
  import { verify, signExecutionReceipt } from "@motebit/crypto";
  ```

  For downstream contributors: the contributions you submit to the permissive floor now carry an explicit Apache §3 patent grant and are covered by the §4.2 litigation-termination clause. Inbound = outbound: what you grant to the project is what the project grants to users. The signed CLA (`CLA.md`) is updated in the same commit to reflect the new license instance. No re-signing is required for contributors who have already signed; the inbound-equals-outbound principle does the right thing automatically.

  For operators: the root `LICENSE` BSL text is unchanged. The embedded "Apache-2.0-Licensed Components" section lists the ten permissive-floor packages and `spec/`. A new `NOTICE` file at the repo root carries the Apache §4 attribution. The orphan `LICENSE-MIT` file at the repo root is removed.

  ## Backwards compatibility

  Apache-2.0 is broader than MIT — everything permitted under MIT remains permitted under Apache-2.0. Existing consumers of the floor packages do not need to change anything to continue use. The new additions are the patent grant (you, as a contributor, pass one) and the termination clause (you, as a contributor, lose your license if you sue over patents).

  ## Naming

  Identifier-level code (`PERMISSIVE_PACKAGES`, `PERMISSIVE_IMPORT_ALLOWED`, `PERMISSIVE_ALLOWED_FUNCTIONS`, the `check-spec-permissive-boundary` CI gate, the `permissive-client-only-e2e.test.ts` adversarial test) uses the architectural role name — "permissive floor" — not the specific license instance. Same pattern the codebase already uses for cryptosuite agility (one `SuiteId` registry; specific instances like `motebit-jcs-ed25519-b64-v1` are replaceable). Doctrine prose names `Apache-2.0` concretely where instance-level precision matters.

- e17bf47: Publish the four hardware-attestation platform verifier leaves as first-class
  Apache-2.0 packages, joining the fixed-group release at 1.0.0.

  Stop-ship finding from the 1.0 pre-publish audit: `@motebit/verify@1.0.0`
  declared runtime dependencies on four `@motebit/crypto-*` adapters marked
  `"private": true`, which would have caused `npm install @motebit/verify` to
  404 on the adapters. The root `LICENSE`, `README.md`, `LICENSING.md`, and the
  hardware-attestation doctrine all claim these adapters as public Apache-2.0
  permissive-floor packages — the `"private": true` markers were doctrine drift
  left behind from scaffolding.

  This changeset closes the drift by publishing the adapters and wiring them
  into the fixed group so they bump in lockstep with the rest of the protocol
  surface:
  - `@motebit/crypto-appattest` — Apple App Attest chain verifier (pinned
    Apple root)
  - `@motebit/crypto-play-integrity` — Google Play Integrity JWT verifier
    (pinned Google JWKS; structurally complete, fail-closed by default pending
    operator key wiring)
  - `@motebit/crypto-tpm` — TPM 2.0 Endorsement-Key chain verifier (pinned
    vendor roots)
  - `@motebit/crypto-webauthn` — WebAuthn packed-attestation verifier (pinned
    FIDO roots)

  Each carries the standard permissive-floor manifest (description, `exports`,
  `files`, `sideEffects: false`, `NOTICE`, keywords, homepage/repository/bugs,
  `publishConfig: public`, `lint:pack` with `publint` + `attw`, focused README
  showing how to wire the verifier into `@motebit/crypto`'s
  `HardwareAttestationVerifiers` dispatcher).

  Also in this changeset:
  - `engines.node` aligned to `>=20` across `@motebit/protocol`, `@motebit/sdk`,
    and `@motebit/crypto` — matches the rest of the fixed group and removes
    downstream consumer confusion (a `@motebit/verify` consumer on Node 18
    previously got inconsistent engines-check signals between libraries).
  - `NOTICE` added to `motebit` (the bundled CLI's tarball, required by Apache
    §4(d) because the bundle inlines Apache-licensed code from the permissive
    floor).

  No code changes — all four adapter implementations and public APIs are
  unchanged. The flip is manifest + metadata + README + fixed-group wiring.

  ## Migration

  **For `@motebit/verify` consumers:** no action required. `npm install -g @motebit/verify@1.0.0` now correctly pulls the four platform adapter packages from npm instead of failing on unpublished `workspace:*` refs. Before this changeset, `npm install @motebit/verify@1.0.0` would have 404'd on `@motebit/crypto-appattest@1.0.0` et al.

  **For direct library consumers (new capability):** the four platform adapters can now be imported independently when a third party wants only one platform's verifier without pulling the full CLI. Wiring into `@motebit/crypto`'s dispatcher:

  ```ts
  // Before (1.0.0-rc and earlier — adapters not installable from npm):
  // only possible via @motebit/verify's bundled verifyFile():
  import { verifyFile } from "@motebit/verifier";
  import { buildHardwareVerifiers } from "@motebit/verify";
  const result = await verifyFile("cred.json", {
    hardwareAttestation: buildHardwareVerifiers(),
  });

  // After (1.0.0 — fine-grained composition):
  import { verify } from "@motebit/crypto";
  import { deviceCheckVerifier } from "@motebit/crypto-appattest";
  import { webauthnVerifier } from "@motebit/crypto-webauthn";

  const result = await verify(credential, {
    hardwareAttestation: {
      deviceCheck: deviceCheckVerifier({ expectedBundleId: "com.example.app" }),
      webauthn: webauthnVerifier({ expectedRpId: "example.com" }),
      // tpm / playIntegrity omitted — verifier returns `adapter-not-configured` for those platforms
    },
  });
  ```

  **For Node 18 consumers of `@motebit/protocol`, `@motebit/sdk`, or `@motebit/crypto`:** the `engines.node` field now declares `>=20` across the entire fixed group (previously drifted: protocol/sdk/crypto said `>=18`, other packages said `>=20`). npm does not hard-enforce `engines` by default, so installs continue to succeed — but teams running strict-engine linters should upgrade to Node 20 LTS. Node 18 entered maintenance-only status April 2025.

  **For third-party protocol implementers:** no wire-format changes. The four platform attestation wire formats (`AppAttestCbor`, Play Integrity JWT, `TPMS_ATTEST`, WebAuthn packed attestation) are unchanged — this changeset only publishes the reference TypeScript verifiers for each.

- 58c6d99: **@motebit/verify resurrected as the canonical CLI, three-package lineage locked in.**

  The entire published protocol surface bumps to 1.0.0 in a coordinated release. What changes at npm:
  - **`@motebit/verify@1.0.0`** — fresh lineage superseding the deprecated `0.7.0` zero-dep library. Ships the `motebit-verify` CLI binary with every hardware-attestation platform bundled (Apple App Attest, Google Play Integrity, TPM 2.0, WebAuthn) and motebit-canonical defaults pre-wired (bundle IDs, RP ID, integrity floor). Network-free, self-attesting. License: Apache-2.0 — the aggregator encodes no motebit-proprietary judgment (defaults are overridable flags, not trust scoring or economics), so it sits on the permissive floor alongside the underlying leaves. Runs `npm install -g @motebit/verify` to get the tool, no license friction in CI pipelines or enterprise audit tooling.
  - **`@motebit/verifier@1.0.0`** — library-only. The `motebit-verify` CLI that used to live here has moved to `@motebit/verify` (above). This package now ships only the Apache-2.0 helpers (`verifyFile`, `verifyArtifact`, `formatHuman`, `VerifyFileOptions` with the optional `hardwareAttestation` injection point). Third parties writing Apache-2.0-only TypeScript verifiers compose this with `@motebit/crypto` — and optionally any subset of the four Apache-2.0 `@motebit/crypto-*` platform leaves — without pulling BSL code.
  - **`@motebit/crypto@1.0.0`** — role unchanged; version bump marks 1.0 maturity of the primitive substrate. Apache-2.0 (upgraded from MIT in the same release; the floor flip gives every contributor's work an explicit patent grant and litigation-termination clause), zero monorepo deps.
  - **`@motebit/protocol@1.0.0`** — wire types + algebra. Apache-2.0 permissive floor. 1.0 signals the protocol surface is stable enough to implement against.
  - **`@motebit/sdk@1.0.0`** — stable developer-contract surface. 1.0 locks the provider-resolver / preset / config vocabulary for integrators.
  - **`create-motebit@1.0.0`** — scaffolder bumps to match.
  - **`motebit@1.0.0`** — operator console CLI bumps to match.

  The three-package lineage for verification tooling follows the pattern that survives decades — git / libgit2, cargo / tokio, npm / @npm/arborist:

  ```
  @motebit/verify                Apache-2.0  the CLI motebit-verify + motebit-canonical defaults over the bundled leaves
  @motebit/verifier              Apache-2.0  library: verifyFile, verifyArtifact, formatHuman
  @motebit/crypto                Apache-2.0  primitives: verify, sign, suite dispatch
  @motebit/crypto-appattest      Apache-2.0  Apple App Attest chain verifier (pinned Apple root)
  @motebit/crypto-play-integrity Apache-2.0  Google Play Integrity JWT verifier (pinned Google JWKS)
  @motebit/crypto-tpm            Apache-2.0  TPM 2.0 EK chain verifier (pinned vendor roots)
  @motebit/crypto-webauthn       Apache-2.0  WebAuthn packed-attestation verifier (pinned FIDO roots)
  ```

  All seven packages in the verification lineage ship Apache-2.0 — the full verification surface lives on the permissive floor. Each answers "how is this artifact verified?" against a published public trust anchor, the permissive side of the protocol-model boundary test. The BSL line holds at `motebit` (the operator console) and everything below it, where the actual reference-implementation judgment lives (daemon, MCP server, delegation routing, market integration, federation wiring). See the separate `permissive-floor-apache-2-0` and `verify-cli-apache-2-0` changesets for the rationale behind the floor licensing.

  ## Migration

  The 1.0 release is a coordinated major bump across the fixed release group. The APIs exported by `@motebit/protocol`, `@motebit/sdk`, `@motebit/crypto`, `create-motebit`, and `motebit` have NOT broken — this major marks endgame-pattern maturity, not a code-shape change. The actual behavioral shifts are confined to the verification-tooling lineage:

  **1. `@motebit/verifier` bin removed (breaking).**

  ```ts
  // Before — @motebit/verifier@0.8.x shipped a `motebit-verify` binary.
  // After  — @motebit/verifier@1.0.0 is library-only.
  // Install `@motebit/verify@^1.0.0` for the CLI:
  //   npm install -g @motebit/verify
  //   motebit-verify cred.json
  // The programmatic library surface is unchanged:
  import { verifyFile, formatHuman } from "@motebit/verifier"; // ← still works
  ```

  **2. `@motebit/verify@0.7.0` (deprecated library) → `@motebit/verify@1.0.0` (resurrected CLI).**

  | You were using (0.7.0)                               | Migrate to                                                                          |
  | ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
  | `verify()` function in TypeScript                    | `import { verify } from "@motebit/crypto"` — same shape, more features              |
  | `verifyFile` / `formatHuman` / programmatic wrappers | `import { verifyFile } from "@motebit/verifier"`                                    |
  | Running `motebit-verify` on the command line         | `npm install -g @motebit/verify` at `^1.0.0` — same command, full platform coverage |

  Users pinned to `"@motebit/verify": "^0.7.0"` stay on the deprecated 0.x line automatically — semver prevents auto-bumps to 1.0.0. The 0.x tarballs remain immutable on npm; archaeology is preserved.

  ## Rationale

  The entire published protocol surface hits 1.0 together as the endgame-pattern milestone. The three-package lineage for verification tooling (verify / verifier / crypto) follows the shape long-lived tool families use — git / libgit2, cargo / tokio, npm / @npm/arborist. The coordinated major signals that this is the architecture intended to hold long-term.

  **Operator follow-up — run immediately after `pnpm changeset publish` returns:**

  ```bash
  npm deprecate @motebit/verify@0.7.0 \
    "Superseded by @motebit/verify@1.x — the canonical CLI. For the library, see @motebit/crypto."
  ```

  The current deprecation message on `0.7.0` dates from the 2026-04-09 package rename and still claims "Same MIT license" — factually correct then, stale the moment 1.0.0 ships (the permissive floor is now Apache-2.0). The replacement message points at both migration paths — the CLI (`@motebit/verify@1.x`) and the library (`@motebit/crypto`) — and makes no license claim that can age. Running it immediately after publish keeps the stale-message window down to minutes, not days.

- 3747b7a: Sign SettlementRecord — protocol-layer support. Closes audit
  finding #1 from the cross-plane review.

  `services/api/CLAUDE.md` rule 6 states: "Every truth the relay
  asserts (credential anchor proofs, revocation memos, settlement
  receipts) is independently verifiable onchain without relay
  contact." Federation settlements deliver this through Merkle
  batching + onchain anchoring (relay-federation-v1.md §7.6). **Per-
  agent settlements did not** — the wire format was unsigned, so a
  relay could issue inconsistent records to different observers (e.g.
  show the worker `{amount_settled: 95, fee: 5}` and an auditor
  `{amount_settled: 80, fee: 20}`) and both would "validate" because
  no signature committed the relay to either claim.

  This commit adds the protocol-layer self-attestation primitive:
  - `SettlementRecord` gains `issuer_relay_id` + `suite` + `signature`
    fields (`@motebit/protocol`)
  - `signSettlement(record, issuerPrivateKey)` and
    `verifySettlement(record, issuerPublicKey)` shipped in
    `@motebit/crypto`, re-exported from `@motebit/encryption`
  - `@motebit/wire-schemas` SettlementRecord flips back to `.strict()`
    with the three new required fields; `additionalProperties: false`
    in the published JSON Schema
  - Spec `delegation-v1.md` §6.3 wire-format table updated; §6.4
    foundation law adds: "Every emitted SettlementRecord MUST be
    signed by its issuer_relay_id. The signature covers the entire
    record except `signature` itself, including `amount_settled`,
    `platform_fee`, and `platform_fee_rate` — committing the relay
    to the exact values it published. A relay that issues
    inconsistent records to different observers fails self-
    attestation: at most one of the records verifies."

  Crypto-layer round-trip + tampering tests added: amount tampering,
  fee_rate tampering, wrong-key, unknown-suite all reject as
  expected. Determinism (same input → same signature) verified.

  ## Migration

  `SettlementRecord.issuer_relay_id`, `suite`, and `signature` are
  now required fields in the wire format. Any consumer constructing
  a `SettlementRecord` literal must add them:

  ```diff
   const record: SettlementRecord = {
     settlement_id: "...",
     allocation_id: "...",
     receipt_hash: "...",
     ledger_hash: null,
     amount_settled: 950_000,
     platform_fee: 50_000,
     platform_fee_rate: 0.05,
     status: "completed",
     settled_at: Date.now(),
  +  issuer_relay_id: "<relay motebit_id>",
  +  suite: "motebit-jcs-ed25519-b64-v1",
  +  signature: "<base64url Ed25519 over canonical body minus signature>",
   };
  ```

  Use `signSettlement(unsignedRecord, issuerPrivateKey)` from
  `@motebit/crypto` (or `@motebit/encryption`) to produce a valid
  signed record from the body fields:

  ```ts
  import { signSettlement } from "@motebit/encryption";

  const signed = await signSettlement(
    {
      settlement_id,
      allocation_id,
      receipt_hash,
      ledger_hash,
      amount_settled,
      platform_fee,
      platform_fee_rate,
      status,
      settled_at,
      issuer_relay_id,
    },
    relayPrivateKey,
  );
  // signed.suite + signed.signature are now set
  ```

  Verifiers use `verifySettlement(record, issuerPublicKey)` —
  returns `true` only if the signature matches the canonical body
  under the embedded suite.

  `@motebit/api` (services/api) is NOT updated by this commit. The
  SettlementRecord-shaped output the relay produces today will fail
  the new wire schema validation until the relay integration commit
  (C) lands. That commit adds the `signature` column to
  `relay_settlements`, signs at INSERT time, and emits the signed
  shape on the audit-facing endpoints. The protocol-layer ships
  first so the contract is unambiguous before consumer code is
  modified.

  Drift defense #22 (zod ↔ TS ↔ JSON) and #23 (spec ↔ schema) both
  green after `api:extract` baseline refresh.

### Minor Changes

- 8cef783: Per-agent settlement anchoring becomes a first-class protocol artifact.

  The `/api/v1/settlements/:id/anchor-proof` and `/api/v1/settlement-anchors/:batchId`
  endpoints shipped on 2026-04-18 returned ad-hoc shapes with no spec, no
  JSON Schema, and no protocol type. This pass closes the full doctrinal
  stack so the worker-audit pyramid (signed `SettlementRecord` floor +
  Merkle inclusion proof + onchain anchor ceiling) is externally legible
  without bundling motebit:
  - **Spec:** `spec/agent-settlement-anchor-v1.md` — parallel artifact to
    `credential-anchor-v1.md`. Defines leaf hash (whole signed
    `SettlementRecord` including signature), batch wire format,
    proof wire format, verification algorithm, and §9 distinguishing
    per-agent from federation (relay-federation-v1.md §7.6) and
    credential anchoring. Cross-references §7.6 for the shared Merkle
    algorithm — same precedent credential-anchor uses.
  - **Protocol types** (`@motebit/protocol`): `AgentSettlementAnchorBatch`,
    `AgentSettlementAnchorProof`, `AgentSettlementChainAnchor`. Same
    shape grammar as the credential-anchor pair so verifiers built for
    one work for the other with a field-name swap.
  - **Wire schemas** (`@motebit/wire-schemas`): published
    `agent-settlement-anchor-batch-v1.json` and
    `agent-settlement-anchor-proof-v1.json` JSON Schemas at stable `$id`
    URLs. A non-motebit Python/Go/Rust verifier consumes them at the
    URL and validates without any monorepo dependency. Drift gate #22
    pins them; gates #9 and #23 ensure spec ↔ TS ↔ JSON Schema parity.
  - **Endpoint shape aligned to spec.** The 2026-04-18 endpoints used
    `{leaf_hash, proof, ...}` (older federation-style vocabulary).
    Per-agent now matches the credential-anchor convention:
    `{settlement_hash, siblings, layer_sizes, relay_id,
relay_public_key, suite, batch_signature, anchor: {...} | null}`.
    Hours-old code, zero external consumers, alignment matters more
    than churn.
  - **Architecture page** lists the new spec (`check-docs-tree` enforces).
  - **Test setup** for per-agent anchoring uses the test relay's actual
    identity from `relay_identity` instead of synthesizing a fresh
    keypair — the proof-serve path looks up the relay's public key from
    that table, so this tests the production wiring end-to-end.
  - **Cosmetic regen** of 14 previously-committed JSON Schemas to match
    the canonical `build-schemas` output (compact arrays expanded to
    one-element-per-line). Drift test was tolerant of the difference
    but the next `build-schemas` run would have surfaced them anyway.

- e897ab0: Ship the three-tier answer engine.

  Every query now routes through a knowledge hierarchy with one shared
  citation shape: **interior → (federation) → public web**. The motebit's
  own answer to "what is Motebit?" now comes from the corpus it ships with,
  not from a Brave index that returns Motobilt (Jeep parts) because
  open-web signal for a new product is near-zero.

  ### Ship-today scope
  - **Interior tier:** new `@motebit/self-knowledge` package — a committed
    BM25 index over `README.md`, `DROPLET.md`, `THE_SOVEREIGN_INTERIOR.md`,
    `THE_METABOLIC_PRINCIPLE.md`. Zero runtime dependencies, zero network,
    zero tokens. Build script `scripts/build-self-knowledge.ts` regenerates
    the corpus deterministically; source hash is deterministic so the file
    is diff-stable when sources don't change.
  - **`recall_self` builtin tool** in `@motebit/tools` (web-safe), mirroring
    `recall_memories` shape. Registered alongside existing builtins in
    `apps/web` and `apps/cli`. (Spatial surface intentionally deferred — it
    doesn't register builtin tools today; `recall_self` would be ahead of
    the parity line.)
  - **Site biasing:** new `BiasedSearchProvider` wrapper in `@motebit/tools`
    composes with `FallbackSearchProvider`. `services/web-search` wraps its
    Brave→DuckDuckGo chain with the default motebit bias rule —
    `"motebit"` queries are rewritten to include
    `site:motebit.com OR site:docs.motebit.com OR site:github.com/motebit`.
    Word-boundary matching prevents "Motobilt" from tripping the rule.
  - **`CitedAnswer` + `Citation` wire types** in `@motebit/protocol`
    (Apache-2.0 permissive floor). Universal shape for grounded answers
    across tiers: interior citations are self-attested (corpus locator,
    no receipt); web and federation citations bind to a signed
    `ExecutionReceipt.task_id` in the outer receipt's `delegation_receipts`
    chain. A new step in `permissive-client-only-e2e.test.ts` proves an
    auditor with only the permissive-floor surface (`@motebit/protocol` +
    `@motebit/crypto`) can verify the chain.
  - **`services/research` extended with the interior tier.** New
    `motebit_recall_self` tool runs locally inside the Claude tool-use
    loop (no MCP atom, no delegation receipt — interior is self-attested).
    System prompt instructs recall-self-first for motebit-related
    questions. `ResearchResult` adds `citations` and `recall_self_count`
    fields alongside existing `delegation_receipts` / `search_count` /
    `fetch_count`.
  - **`IDENTITY` prompt augmented** in `@motebit/ai-core` with one concrete
    sentence about Motebit-the-platform. New `KNOWLEDGE_DOCTRINE` constant
    in the static prefix instructs: "try recall_self first for self-queries;
    never fabricate; say you don't know when sources come up empty."

  ### Deferred
  - **Agent-native search provider** — a follow-up PR adds an adapter for
    a search index with long-tail recall better suited to niche / new
    domains than the current generic web index. Slots into
    `FallbackSearchProvider` as the primary; current chain stays as
    fallback. Separate from this change so the biasing-wrapper impact is
    measurable in isolation.
  - **Federation tier** (`answerViaFederation`): blocked on peer density.
  - **Multi-step synthesis loop** (fact-check pass over draft answers):
    orthogonal quality improvement.
  - **`recall_self` on spatial surface:** comes when spatial's builtin-tool
    suite lands; today it has no `web_search` / `recall_memories` parity
    either.

  ### Drift-gate infrastructure

  `scripts/check-deps.ts` gains an `AUTO-GENERATED`/`@generated` banner
  exception to its license-in-source rule — the committed
  `packages/self-knowledge/src/corpus-data.ts` carries verbatim doc content
  that incidentally includes BSL/Apache license tokens (from README badges).
  Banner skip is the generic pattern; future generated modules benefit.

- c64a2fb: Add withdrawal aggregation primitives for `spec/settlement-v1.md` §11.2.

  `@motebit/protocol` gains four additive exports: `BatchWithdrawalItem`,
  `BatchWithdrawalResult`, `BatchableGuestRail`, and the `isBatchableRail`
  type guard. `GuestRail` grows a required `supportsBatch: boolean`
  discriminant and an optional `withdrawBatch(items)` method — narrowing
  via `isBatchableRail` is the runtime cousin of `isDepositableRail`. The
  addition is backward-compatible at the call site: every rail shipped
  today declares `supportsBatch = false` and the relay falls back to
  serial `withdraw` per item when the rail does not implement the batch
  primitive.

  `@motebit/market` gains `shouldBatchSettle(aggregatedMicro,
perItemFeeMicro, oldestAgeMs, policy)`, the pure predicate that drives
  the relay's batch worker, along with the `BatchPolicy` type and
  `DEFAULT_BATCH_POLICY` constant. The defaults fire when the aggregated
  queue is ≥ 20× the per-item fee (fees ≤ 5%) or ≥ 24 hours old, with a
  $1 absolute floor.

  These primitives are additive and optional — existing
  `requestWithdrawal` callers are unaffected, and rail implementations
  that do not opt in continue to work. The relay's sweep routes through
  the new queue only when the operator sets `SweepConfig.sweepRail`;
  unset preserves the legacy immediate-admin-complete path.

- bd3f7a4: Computer use — full-fidelity viewport protocol surface. Endgame pattern
  from `docs/doctrine/workstation-viewport.md` §1: the Workstation plane
  on surfaces that can reach the OS (today: desktop Tauri) shows a live
  view of the user's computer; the motebit observes via screen capture +
  accessibility APIs and acts via input injection, all under the signed
  ToolInvocationReceipt pipeline. Every observation signed, every action
  governance-gated, user-floor always preempts.

  **This commit ships the contract.** The Rust-backed Tauri bridge that
  actually captures pixels and injects input is deferred to a dedicated
  implementation pass — that's platform work (`xcap`, `enigo`, macOS
  Screen Recording + Accessibility permissions, Windows UIA, frame
  streaming to the Workstation plane) that can't be verified from a
  single session without on-device permission dialogs. Shipping the
  protocol first means the Rust side has a stable target; every piece
  downstream (governance, audit, UI wiring) builds against a locked
  contract.

  **Additions:**
  - `spec/computer-use-v1.md` (Draft) — foundation law + action taxonomy
    - wire format + sensitivity boundary + conformance. Four payload
      types: `ComputerActionRequest`, `ComputerObservationResult`,
      `ComputerSessionOpened`, `ComputerSessionClosed`.
  - `packages/protocol/src/computer-use.ts` — TypeScript types re-
    exported from `@motebit/protocol`.
  - `packages/wire-schemas/src/computer-use.ts` — zod schemas + JSON
    Schema emitters + `_TYPE_PARITY` compile-time assertions. Registered
    in `scripts/build-schemas.ts`; committed JSON artifacts in
    `packages/wire-schemas/schema/`.
  - `packages/tools/src/builtins/computer.ts` — the `computer` tool
    definition (one tool, action-discriminated, 9 action values covering
    observation + input). Handler factory `createComputerHandler` with
    optional `dispatcher` interface — surfaces without OS access register
    no dispatcher and get a structured `not_supported` error; the desktop
    surface will supply a dispatcher backed by its Tauri Rust bridge.
  - `apps/docs/content/docs/operator/architecture.mdx` — spec tree +
    count updated to include `computer-use-v1.md`. Spec count: 15 → 16.

  **Tests:** +4 in `packages/tools/src/__tests__/computer.test.ts`
  covering tool definition parity, dispatcher-absent error path,
  dispatcher-present pass-through, and thrown-error normalization.

  **Not in this commit (by design):**
  - Tauri Rust bridge — screen capture, input injection, OS
    accessibility integration, permission-dialog flow.
  - Frame streaming from Rust to the Workstation plane's UI layer.
  - Sensitivity-classification implementation (ML model / app-bundle
    allowlist). The protocol boundary is pinned; the classifier is
    implementation-defined in v1.
  - Multi-monitor coordinate support (v2 extension).

  All 28 drift gates pass. 171 tools tests green; 382 wire-schemas tests
  green.

- 54158b1: `computer-use-v1.md` revision — applies Tier 1 + Tier 2 #9 of an
  external expert review (Draft → Draft, breaking-to-Draft permitted).
  Structural refactor; same governance posture, tighter protocol.

  **Discriminated-union action shape.** `ComputerActionRequest.action`
  is now a nested variant `{ kind, ... }`, not a flat envelope with
  action-conditional optional fields. Nine variants:
  `screenshot`, `cursor_position`, `click`, `double_click`,
  `mouse_move`, `drag`, `type`, `key`, `scroll`. Impossible states
  (drag fields on a click, type fields on a scroll) are structurally
  unrepresentable. Zod `discriminatedUnion` emits clean JSON Schema
  `oneOf` branches; the `computer` tool's `inputSchema` mirrors this
  so modern AI models (Claude 4.x, GPT-5.x) generate rigorous tool
  calls.

  **Artifact references, not inline bytes.** Screenshot payloads now
  carry `artifact_id + artifact_sha256` pointing into the receipt
  artifact store (spec/execution-ledger-v1.md), not embedded
  `image_base64`. Signed receipts stay O(metadata) instead of
  O(image). Redacted projections add optional
  `projection_artifact_id + projection_artifact_sha256` so a
  verifier with authorization can fetch either raw or redacted bytes.

  **Structured redaction metadata.** `redaction_applied: boolean`
  replaced with a `ComputerRedaction` object:
  `{ applied, projection_kind, policy_version?,
classified_regions_count?, classified_regions_digest? }`. A
  verifier can now prove _what_ was redacted, under _which_ policy
  version, and whether the AI saw raw or projected bytes.

  **Optional `target_hint` on pointer actions.** Click, double_click,
  mouse_move, drag variants can carry advisory
  `{ role?, label?, source }`. Execution still happens at pixel
  `target`; the hint lets verifiers and approval UX explain "motebit
  clicked the Send button" instead of only "(512, 384)". Source
  field tracks provenance ("accessibility", "dom", "vision",
  "user_annotation"). Doesn't break the existing accessibility-tree
  out-of-scope decision.

  **Mechanically-testable user-floor invariant.** §3.3 replaces
  "preempt within the same input frame" with six specific
  requirements: sampling before each synthetic dispatch, max atomic
  batch = 1, max detection latency = 50 ms, 500 ms quiet period,
  in-flight atomic MAY complete, preempted actions emit
  `reason: "user_preempted"` receipts.

  **Outcome taxonomy.** New §7.1 table defines 10 structured failure
  reasons (`policy_denied`, `approval_required`, `approval_expired`,
  `permission_denied`, `session_closed`, `target_not_found`,
  `target_obscured`, `user_preempted`, `platform_blocked`,
  `not_supported`). `ComputerFailureReason` type + `COMPUTER_FAILURE_REASONS`
  const exported from `@motebit/protocol`; tools package renames
  `ComputerUnsupportedReason` → `ComputerFailureReason`.

  **Platform realism.** New §7.2 acknowledges macOS permission
  requirements (Screen Recording + Accessibility), Windows UIAccess
  - elevation-symmetry constraints, and Linux variance (v1 MAY
    declare not_supported on Linux).

  **Coordinate semantics clarified.** `display_width` /
  `display_height` explicitly logical pixels; `scaling_factor` is
  logical-to-physical; screenshot dimensions match logical.

  **Deferred to v1.1 (acknowledged as gaps):**
  - Idempotency / sequencing fields (`request_id`, `sequence_no`).
  - Session-capabilities advertisement at open.
  - Semantic observations (focused element, active app, window title).

  Review credit: external principal-level reviewer. Rating before
  revision: 8.4/10 draft, 6.8/10 interop. This revision targets the
  interop score.

  All 28 drift gates pass. 173 tools tests green (+6 vs. prior
  computer.test.ts), 382 wire-schemas tests green. 3-way pin
  (TS ↔ zod ↔ JSON Schema) holds across all four payload types.

- 620394e: Ship `spec/goal-lifecycle-v1.md` and `spec/plan-lifecycle-v1.md` —
  event-shaped wire-format specs for the goal and plan event families
  already emitted by `@motebit/runtime` and its CLI / desktop callers.

  Pattern matches `memory-delta-v1.md` (landed 2026-04-19): each event
  type gets a `#### Wire format (foundation law)` block, a payload type
  in `@motebit/protocol`, a zod schema in `@motebit/wire-schemas` with
  `.passthrough()` envelope + `_TYPE_PARITY` compile-time assertion, a
  committed JSON Schema artifact at a stable `$id` URL, and a roundtrip
  case in `drift.test.ts`.

  **Goal-lifecycle (5 events):**
  - `goal_created` — initial declaration or yaml-driven revision
  - `goal_executed` — one run's terminal outcome
  - `goal_progress` — mid-run narrative note
  - `goal_completed` — goal's terminal transition
  - `goal_removed` — tombstone via user command or yaml pruning

  **Plan-lifecycle (7 events):**
  - `plan_created` — plan materialized with N steps
  - `plan_step_started` / `_completed` / `_failed` / `_delegated`
  - `plan_completed` / `plan_failed` — plan-level terminal transitions

  `@motebit/runtime` now declares implementation of both specs in its
  `motebit.implements` array (enforced by `check-spec-impl-coverage`,
  invariant #31). Cross-spec correlation with memory-delta and future
  reflection/trust specs is via `goal_id` on plan events.

- 4eb2ebc: Hardware attestation primitives — three additive extensions that ship the
  "rank agents by hardware-custody strength" dimension ahead of demand.

  Lands three pieces per the architectural proximity claim:
  1. `DeviceCapability.SecureEnclave` — new enum value alongside `PushWake` /
     `StdioMcp` / friends. Declares that a device holds its identity key
     inside hardware (Secure Enclave, TPM, Android StrongBox, Apple
     DeviceCheck) and can produce signatures the private material never
     leaves.
  2. `HardwareAttestationClaim` — new wire-format type in
     `@motebit/protocol`, exported as `HardwareAttestationClaimSchema` +
     committed `hardware-attestation-claim-v1.json` from `@motebit/wire-
schemas`. Carried as the optional `hardware_attestation` field on
     `TrustCredentialSubject`. Fields: `platform`
     (`secure_enclave`/`tpm`/`play_integrity`/`device_check`/`software`),
     `key_exported?`, `attestation_receipt?`. The outer `AgentTrustCredential`
     VC envelope's `eddsa-jcs-2022` proof covers the claim; no new
     signature suite needed.
  3. `HardwareAttestationSemiring` in `@motebit/semiring` — fifth semiring
     consumer after agent-routing / memory-retrieval / notability /
     trust-propagation / disambiguation. `(max, min, 0, 1)` on `[0, 1]`
     scalars — structurally identical to `BottleneckSemiring` under a
     different interpretation. Parallel routes pick the strongest
     attestation; sequential delegation is as strong as the weakest link.

  Fully additive. No existing credential, receipt, or routing call changes.
  A consumer that ignores the new optional field observes the exact same
  wire format it did before this change. Spec: `spec/credential-v1.md` §3.4
  (new subject-field-extension subsection under §3.2 + new §3.4 type
  block).

  Doctrinal note: shipped ahead of demand on "inevitable-anyway" reasoning
  — keeps the adapter boundary clean when a real partner (Apple DeviceCheck
  / Play Integrity / TPM-quote-parsing vendor) lands. Per the metabolic
  principle the attestation verification itself is glucose (absorbed via
  platform adapters); the ranking algebra + claim interpretation is the
  enzyme this change lands.

- 85579ac: The Memory Trinity — Layer-1 index + tentative→absolute promotion +
  agent-driven rewrite. The sovereign, event-sourced answer to Claude
  Code's leaked self-healing three-layer memory architecture.

  **Layer-1 memory index (`@motebit/memory-graph/memory-index.ts`).**
  New `buildMemoryIndex(nodes, edges, {maxBytes})` produces a compact
  ≤2KB list of `[xxxxxxxx] summary (certainty)` pointers over the live
  graph, ranked by decayed confidence + pin bonus + connectivity. Designed
  to be injected into every AI turn's system prompt at a stable offset
  for prompt caching. Certainty labels: `absolute` ≥ 0.95, `confident` ≥
  0.7, `tentative` otherwise. Tombstoned nodes excluded. Deterministic
  ordering.

  **`memory_promoted` event type (spec/memory-delta-v1.md §5.8).** Spec
  bumps to v1.1. Additive event emitted when a confidence update crosses
  `PROMOTION_CONFIDENCE_THRESHOLD` (0.95) from below. Paired with the
  idempotency contract — no re-emission on subsequent reinforcement.
  Wired into `MemoryGraph`'s REINFORCE + NOOP paths via a new private
  `maybePromote` method using the pure heuristic in
  `@motebit/memory-graph/promotion.ts`.

  **`rewrite_memory` tool (`@motebit/tools`).** Agent-driven self-healing
  path — when the motebit learns a stored claim is wrong, it corrects
  the entry in-conversation by short node id (from the index) rather than
  waiting for the consolidation tick. Handler emits
  `memory_consolidated` with `action: "supersede"` — reuses existing wire
  format, preserves the original `memory_formed` event for audit.
  Sovereign-verifiability property autoDream's file rewrites can't offer.

  ## Protocol drift gates
  - `check-spec-coverage` picks up `MemoryPromotedPayload` automatically
    (exported from `@motebit/protocol`).
  - `check-spec-wire-schemas` picks up the new JSON Schema artifact at
    `packages/wire-schemas/schema/memory-promoted-payload-v1.json`.
  - Additive `.passthrough()` envelope; v1.0 implementations still
    validate v1.1 payloads.

  ## Tests
  - 12 new promotion tests in `@motebit/memory-graph/__tests__/promotion.test.ts`
  - 12 new memory-index tests in `@motebit/memory-graph/__tests__/memory-index.test.ts`
  - 11 new rewrite_memory tests in `@motebit/tools/__tests__/rewrite-memory.test.ts`
  - All 205 memory-graph tests + 160 tools tests green
  - 374 wire-schemas tests pass (184 drift cases, 4 new for memory-promoted)

- 54e5ca9: Close the three convergence items from goal-lifecycle-v1 §9 and both
  from plan-lifecycle-v1 §8 — spec bumps to v1.1 on each.

  **New primitive: `runtime.goals`** (`packages/runtime/src/goals.ts`).
  Single authorship site for every `goal_*` event in the runtime
  process. Five methods (`created / executed / progress / completed /
removed`) mirror the spec event types, each typed against
  `@motebit/protocol`'s `Goal*Payload`. Migrates emission out of three
  surfaces (`apps/cli/src/subcommands/{goals,up}.ts`,
  `apps/cli/src/scheduler.ts`, `apps/desktop/src/goal-scheduler.ts`) into
  one runtime-owned surface. Desktop and CLI both call
  `runtime.goals.*`; no surface constructs goal event payloads inline.

  **Failure-path emission (goal v1.1 additive).** `GoalExecutedPayload`
  gains an optional `error` field. Failed goal runs in the CLI scheduler
  now emit `goal_executed { error }` alongside the existing
  `goal_outcomes` projection row, fixing the §1 "ledger is the semantic
  source of truth" violation that left failures invisible to event-log
  replay.

  **Terminal-state guard.** The goals primitive accepts an optional
  `getGoalStatus` resolver; when registered (the CLI scheduler does this
  on start), `executed / progress / completed` calls against a goal in a
  terminal state are dropped with a logger warning. `goal_removed` is
  exempt — spec §3.4 explicitly permits defensive re-removal.

  **Plan step-lifecycle state machine (plan v1.1 enforcement).**
  `_logPlanChunkEvent` in `plan-execution.ts` tracks per-`step_id` state
  (pending → started → (delegated)? → terminal) and rejects invalid
  transitions inline. Out-of-order and double-delegation chunks log a
  warning and are not appended to the event log.

  **Payload-direct delegation correlation (plan v1.1 additive).**
  `PlanStepCompletedPayload` and `PlanStepFailedPayload` gain an optional
  `task_id` field. Terminal events that close a delegated step now carry
  the `task_id` from the preceding `plan_step_delegated`, so receivers
  reconstruct the delegation chain by payload join rather than
  cross-referencing sibling events.

  All wire changes are additive under `.passthrough()` envelopes — v1.0
  implementations continue to validate v1.1 payloads. Drift defenses #9,
  #22, #23, #31, #33 all pass; type parity between protocol / zod / JSON
  Schema holds across all 12 payload types.

- db5af58: Add `ToolInvocationReceipt` — a per-tool-call signed artifact that
  complements `ExecutionReceipt`. Where the task receipt commits to the
  turn as a whole, the tool-invocation receipt commits to each individual
  tool call inside the turn, letting the agent-workstation surface show
  (and a third party verify) exactly which tool ran, with what argument
  shape, and what it returned — one signature per call.

  Why a sibling artifact instead of a nested field:
  - Third-party verifiers checking a single tool's output do not need the
    enclosing task's receipt — the per-call receipt is independently
    self-verifiable with just the signer's public key.
  - The workstation surface emits these live as tool calls complete,
    before the enclosing task finishes; nesting inside `ExecutionReceipt`
    would force the UI to wait for the outer receipt.
  - Delegation is already recursive at the task level
    (`delegation_receipts`); keeping tool-invocation receipts separate
    avoids tangling two different recursion shapes in one artifact.

  Commits to structural facts only: tool name, JCS-canonical SHA-256
  hashes of the args and the result, the terminal status, the motebit +
  device identities, and timestamps. The raw args and raw result bytes
  are _not_ part of the receipt; a verifier who holds them can recompute
  the hash and check it against the signature.

  New exports — `@motebit/protocol`:
  - `ToolInvocationReceipt` interface.

  New exports — `@motebit/crypto`:
  - `SignableToolInvocationReceipt` interface (structurally compatible
    with the protocol type; matches the existing `SignableReceipt`
    pattern).
  - `TOOL_INVOCATION_RECEIPT_SUITE` constant.
  - `signToolInvocationReceipt` — JCS canonicalize, dispatch through
    `signBySuite`, base64url-encode. Freezes the returned receipt.
  - `verifyToolInvocationReceipt` — fails closed on unknown suite, bad
    base64, or signature mismatch; same rules as `verifyExecutionReceipt`.
  - `hashToolPayload` — canonical SHA-256 helper for args/result hashing.

  Tests: 12 new cases in `verify-artifacts.test.ts` covering round-trip,
  tamper detection on `tool_name` / `result_hash` / `invocation_origin`,
  wrong-key rejection, determinism, public-key embedding, fail-closed
  suite check, and `hashToolPayload` canonicalization invariance.

  This commit lands only the primitive. Emission (extending the
  `tool_status` chunk in `@motebit/ai-core` with args + tool_call_id and
  composing/signing the receipt in `@motebit/runtime`'s streaming
  manager) follows in a separate change. No runtime behavior changes
  yet — adding a new signed artifact to the toolbox.

  Part of the agent-workstation surface work: receipts are the
  motebit-unique layer underneath any execution mode. The workstation
  panel subscribes to these as they land.

### Patch Changes

- 1e07df5: Ship `@motebit/verifier` — offline third-party verifier for every signed Motebit artifact (identity files, execution receipts, W3C verifiable credentials, presentations). Exposes `verifyFile` / `verifyArtifact` / `formatHuman` as a library and the `motebit-verify` CLI with POSIX exit codes (0 valid · 1 invalid · 2 usage/IO). Zero network, zero deps beyond `@motebit/crypto`. Joins the fixed public-surface version group.

## 0.8.0

### Minor Changes

- b231e9c: MIT/BSL protocol boundary, credential anchoring, unified Solana anchoring
  - **@motebit/crypto** — new package (replaces @motebit/verify). First npm publish. Sign and verify all artifacts with zero runtime deps. New: `computeCredentialLeaf`, `verifyCredentialAnchor` (4-step self-verification).
  - **@motebit/protocol** — new types: `CredentialAnchorBatch`, `CredentialAnchorProof`, `ChainAnchorSubmitter`, `CredentialChainAnchor`. Semiring algebra moved to MIT.
  - **@motebit/sdk** — re-exports new protocol types.
  - **create-motebit** — no API changes.
  - **motebit** — sovereign delegation (`--sovereign` flag), credential anchoring admin panel, unified Solana anchoring for settlement + credential streams.

  New specs: settlement@1.0, auth-token@1.0, credential-anchor@1.0, delegation@1.0 (4 new, 9 total).

## 0.7.0

### Minor Changes

- 9b6a317: Move trust algebra from MIT sdk to BSL semiring — enforce IP boundary.

  **Breaking:** The following exports have been removed from `@motebit/sdk`:
  - `trustLevelToScore`, `trustAdd`, `trustMultiply`, `composeTrustChain`, `joinParallelRoutes`
  - `evaluateTrustTransition`, `composeDelegationTrust`
  - `TRUST_LEVEL_SCORES`, `DEFAULT_TRUST_THRESHOLDS`, `TRUST_ZERO`, `TRUST_ONE`

  These are trust algebra algorithms that belong in the BSL-licensed runtime, not the MIT-licensed type vocabulary. Type definitions (`TrustTransitionThresholds`, `DelegationReceiptLike`, `AgentTrustLevel`, `AgentTrustRecord`) remain in the SDK unchanged.

  Also adds CI enforcement (checks 9-10 in check-deps) preventing algorithm code from leaking into MIT packages in the future.
