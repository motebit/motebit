# @motebit/sdk Changelog

## 2.9.0

### Minor Changes

- c320175: `ANTHROPIC_MODELS` re-synced to the live catalog: adds `claude-fable-5-1`, removes `claude-opus-4-1-20250805`.

  Both ids copied verbatim from `GET /v1/models` — never constructed, no date suffix invented. That discipline is the point: fabricated ids are what #474 shipped.

  The removed row is the one that matters. `claude-opus-4-1-20250805` was in the shipped snapshot and **the provider no longer serves it** — a surface offering it would 404 a real user. The added row is the inverse: a live model we were behind on.

  Found by `check-model-catalog-drift`, which had been reporting exactly this **red every week since 2026-08-10** — five consecutive scheduled runs — with nothing surfacing it, because the workflow had no failure alert. Fixed in the same change.

  **Note on the bump.** This narrows an exported `readonly [...]` tuple, which is a type-level removal. Called minor rather than major deliberately: the removed literal names a model that no longer exists, so any consumer referencing it is already broken at runtime, and no consumer in the repo derives a type from `ANTHROPIC_MODELS[number]`. A major saying "nothing you use changed" teaches people to ignore majors. Overrule this before release if you read the tuple contract more strictly.

  Worth flagging separately: encoding a _churning provider catalog_ as a literal tuple makes every model retirement a potential semver event. `readonly string[]` would make catalog syncs non-breaking by construction — a one-time change, not urgent.

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

- 3c0d83a: `@motebit/sdk`: outbound URL policy — `checkOutboundUrl`, `assertOutboundUrl`, `fetchPublic`, `isPublicAddress`, `OutboundUrlRefusedError`. The one law for fetching a URL motebit did not author: http(s) only, no credentials, never loopback / private / link-local (cloud metadata) / multicast / reserved / `*.local` / `*.internal`, IPv4-in-IPv6 refused, resolved addresses checked when a resolver is injected, every redirect hop re-checked. Consumed by the web proxy's `/v1/fetch`, the `read_url` tool (and so the read-url and web-search atoms), and the relay's agent-registration, federation-proposal and MCP-forward seams.

  `motebit` (CLI): the local `read_url` tool refuses non-public destinations by default; `MOTEBIT_ALLOW_PRIVATE_URLS=1` is the explicit developer allowance for reading a localhost server.

  The sdk README documents the new surface; the test suite covers the full IANA special-purpose range table, IPv6 parser edges, and redirect method rewriting.

- 9bf98ea: Provider surfaces state what has been **witnessed**, not just what resolves.

  Two wire adapters cover the whole provider matrix — `AnthropicProvider` (native) and `OpenAIProvider` (the compat shape google / groq / deepseek / local-server all ride via `base_url`) — and both adapters are live-proven. Per **vendor** the picture is different: only `anthropic` and `local-server` have ever had a real turn run through them. The rest are wired, resolvable, and expected to work, but unwitnessed — and their model ids came from training-prior knowledge rather than a vendor listing endpoint, which is the exact class that already shipped 404-ing ids once (#474).

  The surfaces implied parity that does not exist. This is the honest half of #518 — the half that needs no API keys.

  New exports:

  - `ProviderVerification` — `"verified" | "available"`. `available` is not a warning; it distinguishes _supported_ from _witnessed_, and conflating those is how a catalog of fabricated ids ships unnoticed.
  - `VerifiableProvider` — the selectable vendor set the record covers.
  - `PROVIDER_VERIFICATION` — the canonical per-vendor status.
  - `PROVIDER_NOTE` — the one-line disambiguation each surface renders.

  `PROVIDER_NOTE.groq` carries an explicit _"Not xAI's Grok."_ The names differ by one letter and denote unrelated things — Groq is inference hardware (LPU) hosting other labs' open weights; Grok is xAI's frontier model, which motebit does not support. A picker that says only "Groq" will be misread, permanently.

  Consumed by the CLI's provider-validation error and by the web + desktop BYOK pickers, which render the note from this record rather than from prose in markup — so a surface cannot drift from what has actually been witnessed, and the Groq/Grok disambiguation lives in exactly one place.

  Additive only; no existing export changed.

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

### Patch Changes

- 2ff5740: `openai` is now verified live.

  A real turn ran through `OpenAIProvider` against `gpt-5.4-mini` — 39 streamed chunks and a tool call whose arguments reassembled intact — so `PROVIDER_VERIFICATION.openai` moves from `available` to `verified` and its note drops "no live turn witnessed yet".

  The status is evidence-backed rather than expected-to-work: the same probe found the vendor completely broken two runs earlier, 400-ing on every turn against a parameter the gpt-5 family had removed. That is what `available` was there to say.

  Only `openai` moves. `google`, `groq` and `deepseek` ride the same OpenAI-compat wire, and a passing openai turn is evidence about the SHAPE, never about their own quirks behind it — Gemini's compat gaps and DeepSeek's parameter rejections are exactly the kind of thing that hides behind a shared adapter. They stay `available` until each has its own key and its own passing probe.

- Updated dependencies [965136f]
- Updated dependencies [4ebe62b]
- Updated dependencies [89d3d08]
- Updated dependencies [f8dd5b3]
- Updated dependencies [578cf94]
- Updated dependencies [337bff7]
- Updated dependencies [62d9069]
- Updated dependencies [2db131e]
- Updated dependencies [1d0f3ec]
  - @motebit/protocol@3.18.0

## 2.8.2

### Patch Changes

- Updated dependencies [73a099a]
  - @motebit/protocol@3.17.0

## 2.8.1

### Patch Changes

- Updated dependencies [40d7b6e]
  - @motebit/protocol@3.16.0

## 2.8.0

### Minor Changes

- 134cd56: `SessionStateSnapshot` gains two `[Now]` proprioception fields (#530): `substrate` (the live provider model this motebit thinks through — follows `/model` switches) and `settledDelegations` (the exchange's completed paid delegations, produced by the streaming manager's own ledger). Both runtime-produced, never model-authored.

## 2.7.0

### Minor Changes

- b7a1bef: New capability-tier axis on the model registry: `modelCapabilityTier(model)` returns `"frontier" | "capable" | "minimal"` from family knowledge plus embedded parameter sizes (ollama `:NNb` tags and dash-form ids like `Llama-3.2-3B-Instruct…`), with `unknown → "capable"` so registry lag never lobotomizes a new model. The runtime keys money-tool exposure on it (#501); nothing here gates admission — a minimal model remains a legitimate sovereign choice.
- 31e6a27: The local model registry catches up to 2026: `LOCAL_SERVER_SUGGESTED_MODELS` refreshes from its all-2024 table (`llama3.2`, `gemma2`, `phi3`, `qwen2`…) to the current families (`qwen3`, `gpt-oss`, `gemma3`, `llama4`, `phi4-mini`, `deepseek-r1`, `mistral-small3.2`), and `DEFAULT_LOCAL_SERVER_MODEL` moves `llama3.2` → `qwen3`. Two vendor-hint misroutes fixed (both open-weights families the prefix heuristics sent to hosted-API refusals: `gpt-oss` → openai, `deepseek-r1` → deepseek), locked by a new admissibility invariant over the whole suggested table. New export `MODEL_DEFAULT_REVIEW_BY`: every `DEFAULT_*_MODEL` carries a review-by date — defaults as perishable inventory; the scheduled drift gate goes red past a lapsed date, and the fix is a deliberate human review, never an auto-bump.

## 2.6.0

### Minor Changes

- 0eb85b6: `ANTHROPIC_MODELS` now carries the full live catalog (11 ids, every one verified against `GET /v1/models` on 2026-07-30): adds `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-6`, `claude-sonnet-5`, and the dated legacy ids the provider still serves. Additive widening of the exported tuple — found by the new scheduled external drift gate (`check-model-catalog-drift`) on its first live run, which now keeps this snapshot honest weekly.

## 2.5.4

### Patch Changes

- 083867e: README fleet audit: correct every published-package README against the shipped bytes.

  Highlights: the CLI README now documents the recovery arc (`motebit restore`, `motebit seed`), the `grant` standing-delegation family, `id`/`wallet`, and the `--sovereign`/`--pay-new-agents` delegate flags; `@motebit/state-export-client` fixes a wrong first parameter on `verifyManifestAgainstBytes` (raw header string, not a parsed manifest); `create-motebit`'s agent quick start adds the required `MOTEBIT_PASSPHRASE`; `@motebit/crypto-appattest` fixes a non-JCS canonical-body example that produced the wrong digest when reproduced; `@motebit/crypto` drops a function removed at 3.0.0 and documents the hardware-attestation leaf family; `@motebit/protocol`'s example now typechecks; false zero-dependency claims corrected (sdk, verifier); `@motebit/verifier` is consistently described as library-only with `@motebit/verify` as the CLI; all relative repo links replaced with absolute URLs that survive npm rendering.

  An adversarial review pass then corrected two overstated scoring claims (android-keystore StrongBox, webauthn attestation_kind — both fields are surfaced but informational today), a wrong flag name (`skills audit --event-type`, also fixed in the CLI's own usage string), and an under-documented `deviceCheckContext` parameter on `verifyHardwareAttestationClaim`.

- Updated dependencies [083867e]
  - @motebit/protocol@3.15.1

## 2.5.3

### Patch Changes

- Updated dependencies [25d1e71]
- Updated dependencies [84fad0f]
  - @motebit/protocol@3.15.0

## 2.5.2

### Patch Changes

- Updated dependencies [e50d388]
- Updated dependencies [8548351]
  - @motebit/protocol@3.14.0

## 2.5.1

### Patch Changes

- Updated dependencies [e2c06cd]
  - @motebit/protocol@3.13.0

## 2.5.0

### Minor Changes

- e5d09c9: Promote `EvalAttestation` — the signed third-party-measurement artifact (subject ≠ signer; `docs/doctrine/evals-as-attestations.md` trigger #1 fired: the Auditor archetype is consumer #1).
  - `@motebit/protocol`: `EvalAttestation` / `EvalResult` wire types; `EvalKind` closed registry (eleventh registered registry — `ALL_EVAL_KINDS`, `isEvalKind`; single member `verification_audit`). Each result embeds a whole per-axis `VerificationVerdict` — no flattened booleans.
  - `@motebit/crypto`: `signEvalAttestation` / `verifyEvalAttestation` (JCS + Ed25519 + base64url under the pinned `EVAL_ATTESTATION_SUITE`). The verify law establishes "this issuer said this about this subject" and deliberately never measurement truth, issuer authority, key→id binding, or freshness; subject == issuer is valid (self-issued floor). Fail-closed structured reasons incl. closed-registry `unknown_eval_kind` intake via the crypto-side `EVAL_KINDS_MIRROR` (zero-runtime-deps discipline; four-way locked by `check-eval-kind-canonical`).
  - `@motebit/wire-schemas`: `EvalAttestationSchema` (+ `EvalResultSchema`, `VerificationVerdictSchema`, `RepairInstructionSchema`, `RevocationVerdictSchema`) with committed JSON Schema `spec/schemas/eval-attestation-v1.json`; spec `spec/eval-attestation-v1.md`; conformance corpus `spec/conformance/eval-attestation/`.
  - `@motebit/verifier`: re-exports the EvalAttestation family and widens the aggregator with the public-verification-surface laws an auditor composes (`verifySovereignBinding`, `verifyKeySuccession`, `verifySuccessionChain`, `verifyBondCommitment`, `verifyMerkleInclusion`) — services consume only the aggregator, never `@motebit/crypto` directly.
  - `@motebit/sdk`: the new protocol types ride the existing star re-export.

### Patch Changes

- Updated dependencies [e5d09c9]
- Updated dependencies [e5d09c9]
  - @motebit/protocol@3.12.0

## 2.4.1

### Patch Changes

- Updated dependencies [35af346]
  - @motebit/protocol@3.11.0

## 2.4.0

### Minor Changes

- 2c04e6c: `modelVendorHint` + `providerAcceptsModel` — provider ↔ model pre-flight admission in the canonical model registry (intelligence-pluggability contract, commitment 1). Born live 2026-07-06: `--provider anthropic` with a config-resident `default_model: llama3.2:latest` composed an illegal pairing that failed opaquely at the first API call. The predicate refuses ONLY known cross-vendor mismatches (registry membership + naming signatures); unknown ids stay permissive so new releases never brick startup; `local-server` accepts anything; the proxy accepts its routed cloud vendors. The CLI consumes it two ways: config residue yields politely (stale `default_model` from a previous provider era auto-resolves to the chosen provider's default, with a visible note), and explicit `--provider`/`--model` contradictions fail loud at startup naming both.

### Patch Changes

- Updated dependencies [e651f19]
- Updated dependencies [052cfbd]
  - @motebit/protocol@3.10.0

## 2.3.0

### Minor Changes

- 2dd2b93: New `ThinkingBlock` type + optional `thinking_blocks` on `AIResponse` and the `assistant` `ConversationMessage` variant — the round-trip carrier for Anthropic extended-thinking blocks (with signatures), required to preserve a valid multi-turn tool-use conversation when thinking is enabled. Opaque and never rendered (distinct from `reasoning`, the display text); absent unless extended thinking is enabled, so inert for every other provider/config.
- cae3028: `AIResponse` gains an optional `reasoning` field — the model's interior cognition (`<thinking>`), captured for the owner-facing `mind` embodiment organ (render-engine `EMBODIMENT_MODE_CONTRACTS.mind`, `source:"interior"`/`observer:"self"`). Previously the reasoning trace was stripped from the visible text and captured nowhere — destroyed before it could reach the surface built to render it. It stays stripped from the visible `text` (the chat register stays clean) and is INTERIOR-ONLY by contract: never synced, egressed, persisted to a shared surface, or sent to external AI. Additive and fail-closed — absent when the model emitted no reasoning. Increment 1 of the interior-cognition arc (`felt-interior.md`); the `mind`-organ render follows in Increment 2.

### Patch Changes

- Updated dependencies [74d2f67]
- Updated dependencies [74d2f67]
- Updated dependencies [74d2f67]
- Updated dependencies [6b6ce77]
- Updated dependencies [932fad9]
- Updated dependencies [74d2f67]
- Updated dependencies [74d2f67]
  - @motebit/protocol@3.9.0

## 2.2.8

### Patch Changes

- Updated dependencies [85c0b10]
  - @motebit/protocol@3.8.0

## 2.2.7

### Patch Changes

- Updated dependencies [09f4704]
- Updated dependencies [b4a1c9e]
- Updated dependencies [96a09fd]
  - @motebit/protocol@3.7.0

## 2.2.6

### Patch Changes

- Updated dependencies [7941af4]
- Updated dependencies [0045b07]
- Updated dependencies [a730451]
  - @motebit/protocol@3.6.0

## 2.2.5

### Patch Changes

- Updated dependencies [901f134]
- Updated dependencies [8ce3410]
  - @motebit/protocol@3.5.0

## 2.2.4

### Patch Changes

- Updated dependencies [d6ae64c]
- Updated dependencies [21e035d]
  - @motebit/protocol@3.4.0

## 2.2.3

### Patch Changes

- Updated dependencies [a0fb79c]
- Updated dependencies [dee96b8]
- Updated dependencies [2f6852f]
- Updated dependencies [99819c4]
- Updated dependencies [93ff63c]
- Updated dependencies [93ff63c]
- Updated dependencies [3044a2a]
  - @motebit/protocol@3.3.0

## 2.2.2

### Patch Changes

- Updated dependencies [8ec1140]
  - @motebit/protocol@3.2.0

## 2.2.1

### Patch Changes

- Updated dependencies [ac2d6e3]
- Updated dependencies [ffe7323]
  - @motebit/protocol@3.1.0

## 2.2.0

### Minor Changes

- 75babcf: Add the identity-sigil primitive — `deriveAgentSigil`, `oklchToRgb`, `shortFingerprint`, and `wordFingerprint` (with `AgentSigil`, `OklchColor`, `SigilSymmetry` types). Doctrine: `docs/doctrine/agents-as-first-person-trust-graph.md` §4.

  A pure, synchronous, deterministic function from an agent's stable identity string (its `motebit_id` — itself `SHA-256(pubkey)`-derived — or a public key) to perceptually-spread visual parameters (OKLCH primary + harmonic accent, symmetry, element count, density, rotation, stroke, and a 32-bit `geometrySeed`). This is the Ring-1 _param_ half of "the face is the identity"; each surface renders the params natively (Ring 3) — web/SVG, mobile/`StyleSheet`, CLI glyph, and the spatial droplet from the same `geometrySeed`. The module never emits pixels. (Callers should pass the `motebit_id`: it is present at every display site, so the same agent shows the same face everywhere, where a raw pubkey isn't reliably client-side.)

  Deliberately non-cryptographic: the sigil is a glance-level recognition aid, never identity proof — `shortFingerprint` (or the full key / signed receipts) stays the authority for any trust-bearing decision. Distinctness is spread across many orthogonal axes (not hue alone — lightness and the geometric axes stay discriminable under color-vision deficiency), per the doctrine's distinctness-budget bound. Distinct from the _chosen_ creature aesthetic in `color-presets.ts`: a peer's sigil is _derived_ and cannot be chosen.

  `wordFingerprint` is the human-comparable recognition aid (the doctrine's "word-pair"), rendering the key as BIP-39 words via the canonical, SHA-256-verified English wordlist (adopted, not minted — the metabolic principle) so the mapping never drifts. Like `shortFingerprint` it is a recognition aid, never identity proof.

  Additive (new exports only); no behavior change to existing surface. Cross-surface renderers and panel wiring are intentionally not included — they ship when a consumer (the live demo or a builder) needs them (a single unwired reference SVG renderer lives in `apps/web`, not the SDK).

- 82f5283: Add `MemorySelfState` and an optional `SessionStateSnapshot.memory` field — the typed memory self-state the runtime surfaces in the AI's `[Now]` block.

  This extends the existing `[Now]`-block grounding (which already prevents browser-state confabulation) to the motebit's own memory. `MemorySelfState` carries `total` (non-tombstoned nodes held), `newestAgeMs` (age of the most recent memory, or `null` when empty), and `formedThisSession` (count since the runtime woke up). The runtime composes it in `getSessionStateSnapshot()`; `@motebit/ai-core` renders it as a `Memory:` line.

  It closes the self-state sibling of the browser-state hallucination: asked "are you forming memories?", the AI would read its architecture description and answer "yes" even with zero formed this session. The typed count — `0 formed this session` — is the grounded truth it now reads instead of inferring. Additive and backward-compatible; the field is optional and the `[Now]` block omits the line when absent.

### Patch Changes

- 882b392: Upgrade the test runner from vitest 2.1.9 to 4.1.8 (with @vitest/coverage-v8), closing critical advisory GHSA-5xrq-8626-4rwp (Vitest UI server arbitrary file read/execute, fixed in 4.1.0). This is a dev-dependency change only — no runtime, API, or wire-format change to any published package; the bump is recorded as a patch because each package's published `package.json` devDependencies move to vitest ^4.1.8.

  vitest 4 bundles vite (^6 || ^7 || ^8), so the existing vite-^6 surfaces, jsdom 25, and @types/node ^22 are unchanged. Test-only migration fallout was handled in the same change: `ViteUserConfig` rename in the shared config, typed-mock assignability under v4 (`vi.fn()` now `Mock<Procedure|Constructable>`), constructor mocks converted from arrows to `function` (v4 disallows `new` on arrow mock implementations), the removed `environmentMatchGlobs` replaced by the per-file `@vitest-environment` directive, and an explicit `dist/` test-exclude restored for the one config-less package (vitest 4's default `exclude` no longer covers `dist/`).

- Updated dependencies [aefe5f6]
- Updated dependencies [781dbc0]
- Updated dependencies [c0faba1]
- Updated dependencies [cf26f38]
- Updated dependencies [85f7e10]
- Updated dependencies [403a725]
- Updated dependencies [19d1584]
- Updated dependencies [9cf876a]
- Updated dependencies [e3fb1f7]
- Updated dependencies [9ca54fd]
- Updated dependencies [271bb5c]
- Updated dependencies [7a2797f]
- Updated dependencies [810175b]
- Updated dependencies [8195e65]
- Updated dependencies [0f47485]
- Updated dependencies [49338ad]
- Updated dependencies [882b392]
  - @motebit/protocol@3.0.0

## 2.1.0

### Minor Changes

- 3d103ed: Add `inferenceIsFreeToUser(mode)` — the canonical predicate for whether inference under a given `ProviderMode` is free to the user (`on-device` / `byok`) versus operator-metered (`motebit-cloud`). Single source of truth for the "proactive consolidation defaults ON only when inference is free" policy; web / desktop / mobile consume it instead of inlining the mode comparison, so the default-on policy cannot drift between surfaces. Exhaustive switch — a future `ProviderMode` entry forces an explicit free-or-metered decision. See `docs/doctrine/proactive-interior.md` § "Default posture".
- bfa0168: Add `RelationType.DerivedFrom` — the eighth memory-graph edge. Provenance from a reflection-synthesized memory back to the source observations it was derived from (`source_id` = the insight, `target_id` = an antecedent observation); the reflection analog of `PartOf` (consolidation's cluster→summary edge). Additive enum member. See `docs/doctrine/memory-architecture.md`.

### Patch Changes

- 0d031b9: Re-target five past-due deprecation sunsets from `removed in 2.0.0` to `removed in 3.0.0`. These symbols (sdk `OLLAMA_SUGGESTED_MODELS` / `OllamaSuggestedModel`, crypto's `VerifyResult` alias + the typed `verify` overload, protocol's trust-thresholds alias) were promised for removal in 2.0.0 but 2.0.0 shipped with them still present. 2.0.0 is immutable on npm and removing a public export is breaking (major-only), so the honest fix is to keep the trivial since-1.0.0 aliases through 2.x and remove them at the next real 3.0.0. Comment-only change — no API or behavior change.
- Updated dependencies [0d031b9]
  - @motebit/protocol@2.0.1

## 2.0.0

### Major Changes

- 8a61d97: `@motebit/sdk` re-exports the entire `@motebit/protocol` surface via `export * from "@motebit/protocol"` (`src/index.ts:1`), so the `@motebit/protocol@2.0.0` breaking changes flow through the sdk's public surface unchanged. The sdk majors in lockstep to keep that honest.

  **Why this is a major bump.** Three protocol breaking changes are observable through `@motebit/sdk` imports, not just `@motebit/protocol`:
  1. `GuestRail.withdraw()` / `withdrawBatch?()` removed (now on the `WithdrawableGuestRail` marker only). `import { GuestRail } from "@motebit/sdk"; rail.withdraw(...)` no longer compiles.
  2. `P2pPaymentProof` gains required `fee_to_address` + `fee_amount_micro`, and `TxVerificationResult.confirmed` reshapes from `{ from, to, amountMicro }` to `{ from, transfers: ConfirmedTransferLeg[] }`. Constructing or reading these via the sdk re-export breaks.
  3. `SettlementRecord` gains a required `settlement_mode` field. Constructing one (directly or through `signSettlement(Omit<SettlementRecord, ...>, ...)`) imported from the sdk fails to typecheck.

  The sdk's _own_ contract — the provider-mode resolver, presets, config vocabularies, model registry — is unchanged. But per `packages/sdk/CLAUDE.md` rule 2, the sdk stays at its current major only "as long as the re-export surface stays compatible." These protocol changes break that surface, so shipping them as a minor would silently break any consumer importing the protocol types from `@motebit/sdk@^1`. The major bump versions the break honestly.

  ## Migration

  Identical to `@motebit/protocol@2.0.0` — the re-exported types are the same symbols. Narrow `GuestRail` through `isWithdrawableRail()` before calling `withdraw()`; supply `fee_to_address` / `fee_amount_micro` when constructing `P2pPaymentProof`; read `TxVerificationResult.confirmed.transfers[]` instead of `.to` / `.amountMicro`; supply `settlement_mode` when constructing a `SettlementRecord`.

### Minor Changes

- 4a7e281: Add `autoRoute?: boolean` to `ByokProviderConfig` — opts the user into auto-routing across the vendor's available models per turn. When `true`, surface runtimes (web today; desktop/mobile mirror following) consume the second-consumer half of the auto-routing primitive (`@motebit/policy::dispatchByokRouting`) to pick the best model for each turn's `TaskShape` from the vendor's catalog. When `false` or omitted, the surface uses the single configured `model` (backward-compat default).

  Closes the auto-routing PR 2 doctrine arc (`docs/doctrine/auto-routing-as-protocol-primitive.md` § "PR 2 — BYOK consumer"). The architectural payoff: with PR 1's motebit-cloud-proxy as the only consumer of `dispatchRouting`, the role-as-instance pattern was doctrine-shaped but unproven structurally. PR 2 validates that the dispatcher is consumer-neutral by landing a second concrete consumer with a different catalog source (`BYOK_MODEL_CATALOG[vendor]`), no balance filter (BYOK pays vendors directly), no jurisdiction filter, and heuristic shape detection instead of LLM classification — all via the same `dispatchRouting` entry point unchanged.

  Web consumer site lives at `apps/web/src/web-app.ts::WebApp.sendMessageStreaming` (the natural intercept point where the BYOK config and StreamingProvider reference both live). Registered as the 2nd CONSUMER in the drift gate `check-routing-decision-coverage` (#95). Per the gate's structural enforcement, the consumer references every `RoutingDecision.kind` value (`route` | `fallback` | `deny`).

  Per `feedback_sovereignty_orthogonal`: this flag is orthogonal to tier — BYOK auto-routing is never subscription-gated. The user already has the vendor's key; the surface's job is to compose the canonical dispatcher over it.

  Deferred follow-ups (named in the doctrine, not deferred indefinitely):
  - Desktop + mobile mirror of the web consumer wire-up. Same shape (`_byokAutoRouteVendor` + `_currentProvider` + `setModel` per turn); cross-surface mirror follows per the one-pass-delivery doctrine. Each surface adds its own `byok-runtime-{desktop,mobile}` entry to the drift gate's CONSUMERS registry.
  - Settings-side UI toggle exposing `autoRoute`. The flag is in the config type and respected by the runtime; the BYOK settings panel doesn't yet surface a toggle. Users today opt-in by editing localStorage or via a future settings UI commit.
  - Classifier-mode shape detection. The heuristic shape detector (`@motebit/policy::extractTaskShape`) is the cheap default; surfaces wanting LLM-classifier-level accuracy compose their own detector and pass directly to `dispatchRouting`.

- eed64ea: Add `autoRoute?: boolean` to `OnDeviceProviderConfig` — opts the user into per-turn auto-routing across the on-device backend's available models. When `true` AND the backend is multi-model (`local-server` today; `apple-fm` / `mlx` / `webllm` are single-model surfaces), surface runtimes consume the third-consumer half of the auto-routing primitive (`@motebit/policy::dispatchOnDeviceRouting`) to pick the best model for each turn's `TaskShape` from the backend's catalog. When `false` or omitted, the surface uses the single configured `model`.

  Closes the auto-routing PR 3 doctrine arc (`docs/doctrine/auto-routing-as-protocol-primitive.md` § "PR 3 — on-device consumer"). The architectural payoff: with PR 1 (motebit-cloud-proxy) + PR 2 (BYOK across web/desktop/mobile) shipped, the role-as-instance pattern (7th instance of `agility-as-role.md`) had two consumers — same risk shape as a 2-instance closed registry. PR 3 makes it three. The doctrine claim "auto-routing is consumer-neutral" is now structurally proven across the full sovereignty spectrum (subscription / pay-per-call / zero-marginal).

  Desktop consumer site lives at `apps/desktop/src/index.ts::DesktopApp.sendMessageStreaming` — the same intercept point PR 2 added for BYOK, now extended with a parallel on-device branch. The two state fields (`_byokAutoRouteVendor` + `_onDeviceAutoRouteBackend`) are mutually exclusive; `initAI` populates exactly one based on the unified config's mode + autoRoute flag.

  Drift gate `check-routing-decision-coverage` (#95) gains `on-device-runtime-desktop` consumer entry. Same desktop file as `byok-runtime-desktop`, different dispatcher entry (`dispatchOnDeviceRouting`). The gate now enforces **5 consumers × 3 decision kinds**.

  Per `feedback_sovereignty_orthogonal`: orthogonal to tier — on-device auto-routing is never subscription-gated. The user owns the hardware; the surface's job is to compose the canonical dispatcher over it.

  Deferred follow-ups (named in the doctrine, all triggered by real-consumer signal):
  - Web + mobile on-device consumer mirror. Web's WebLLM has download-cost per model swap making per-turn routing inappropriate (catalog is single-model on web today; dispatcher denies cleanly). Mobile's local-server is less common than desktop's Ollama. Mirror lands when there's surface-side signal.
  - Per-policy on-device routing — surface-specific `REFERENCE_LOCAL_SERVER_ROUTING_POLICY` mapping `TaskShape` → local model names (e.g., `code: "codellama"`, `chat: "llama3.2"`). Today every on-device dispatch lands in `fallback` because the canonical `REFERENCE_ROUTING_POLICY` names cloud models. The role-vs-policy distinction makes this a clean future swap.
  - Multi-model `apple-fm` / `mlx` / `webllm` catalogs. Today these backends are single-model; the dispatcher denies them by design (the honest signal). When per-backend multi-model support lands, the catalog grows additively.

### Patch Changes

- Updated dependencies [b0d068b]
- Updated dependencies [92c2800]
- Updated dependencies [6a46f33]
- Updated dependencies [53e11b5]
- Updated dependencies [2428248]
- Updated dependencies [f1d3308]
- Updated dependencies [a5abc51]
- Updated dependencies [904d744]
- Updated dependencies [91b582e]
- Updated dependencies [4ea0127]
- Updated dependencies [46189c6]
- Updated dependencies [00585fc]
- Updated dependencies [7dd54da]
- Updated dependencies [be9275a]
- Updated dependencies [343e81f]
- Updated dependencies [8262902]
  - @motebit/protocol@2.0.0

## 1.2.0

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

- 52ba36c: **Foundation-model agility — DeepSeek lands as the fourth `ByokVendor`.** The closed-set additive registry `ByokVendor = "anthropic" | "openai" | "google"` gains `"deepseek"`. Fourth instance of `agility-as-role` (alongside cryptosuite agility, permissive-floor, settlement-rail custody split); the role is "foundation-model vendor accessible via OpenAI-compatible (or Anthropic's) wire protocol." Same closure pattern as `SuiteId` — additive at the registry, exhaustive-switch enforced at the dispatch, baseline-locked at the api-extractor surface.

  **Why this fourth instance.** Motebit's founding doctrine claim from `CLAUDE.md` — _"A motebit is a droplet of intelligence under surface tension. You own the identity. The intelligence is pluggable."_ — was structurally contradicted by a 3-vendor BYOK registry of exclusively-expensive Big Tech providers (Anthropic, OpenAI, Google). Adding DeepSeek restores the doctrinal claim: the registry stays closed at the wire-vocab boundary (per `protocol/CLAUDE.md` rule 5) but the additive shape demonstrates "pluggable" is real. DeepSeek V3 (`deepseek-chat`) is roughly Claude-Sonnet-class on tool-use benchmarks at ~10× cheaper pricing ($0.27/M input · $1.10/M output vs Claude Sonnet's $3/$15), served via DeepSeek's OpenAI-compatible API at `https://api.deepseek.com`. The affordability path lands NOW for capital-constrained users.

  **What's in the SDK surface:**
  - `ByokVendor` union extended to `"anthropic" | "openai" | "google" | "deepseek"`
  - `DEEPSEEK_MODELS = ["deepseek-chat"] as const` in `models.ts` (single-entry today; expandable when `deepseek-reasoner` / R1 tool-use support is verified)
  - `DEFAULT_DEEPSEEK_MODEL = "deepseek-chat"` for the default-tier convention
  - `DEEPSEEK_CANONICAL_URL = "https://api.deepseek.com"` in `provider-resolver.ts`
  - `defaultModelForVendor("deepseek")` returns `DEFAULT_DEEPSEEK_MODEL`
  - `canonicalVendorBaseUrl("deepseek")` returns `DEEPSEEK_CANONICAL_URL`
  - Resolver's `byok` arm: DeepSeek dispatches as `wireProtocol: "openai"` (same arm as Google — DeepSeek's hosted API exposes the OpenAI chat-completions schema)

  **Important conceptual note for integrators.** DeepSeek is _open-source weights_ served via DeepSeek's hosted API. It belongs in BYOK (cloud inference, API key) not on-device (sovereign local inference). The on-device path stays for smaller open models that fit on consumer hardware (Llama 3.2, Qwen 7B-32B, Phi-4); the BYOK-DeepSeek path is for affordable cloud access to a Sonnet-class open-source model. Two distinct affordability/sovereignty paths, both real, both shipping.

  **Tests.** New "byok deepseek" describe block in `provider-resolver.test.ts` covering: dispatch to `wireProtocol: "openai"` at the canonical URL; default model fallback; CORS-proxy substitution via `env.cloudBaseUrl`. `defaultModelForVendor` + `canonicalVendorBaseUrl` exhaustive-vendor tests extended. Type-invariants config array gets `{ mode: "byok", vendor: "deepseek", apiKey: "k" }`.

  **API surface.** `sdk.api.md` baseline regenerated. Additive — `@public` exports (`ByokVendor`, `DEEPSEEK_CANONICAL_URL`, `DEEPSEEK_MODELS`, `DEFAULT_DEEPSEEK_MODEL`) ship with the union extension. No removals; closed-set additive entry.

  **Doctrine.** `docs/doctrine/agility-as-role.md` updated — fourth named instance ("Foundation-model agility") with full role/instance/migration/defense notes. The doctrine memo now closes the asymmetry it carried before this slice (the "intelligence is pluggable" doctrine claim ↔ "vendors are a closed additive registry" protocol shape now structurally aligned).

  Closed-registry discipline holds. The next vendor add (OpenRouter as meta-vendor, Groq, Together, Fireworks, or any sibling) is a registry append + three dispatch arms + a default model entry + parallel surface UIs. Mechanical template-match against this slice.

- 6347e9a: **Groq lands as the fifth `ByokVendor` — American-hosted open-source counterpart to DeepSeek.** The closed-set additive registry `ByokVendor = "anthropic" | "openai" | "google" | "deepseek"` gains `"groq"`. Same closure pattern + dispatch shape as the prior DeepSeek slice (registry append + three exhaustive-switch arms + a `*_MODELS` constant + parallel surface UIs). Fifth instance of `agility-as-role`; the pattern is now demonstrably mechanical for future open-source-via-API additions.

  **Why Groq specifically as the next vendor.** Two slices ago we added DeepSeek (open-source, Chinese-hosted, cheapest) to close the founding "intelligence is pluggable" doctrine contradiction. Groq is the natural sibling: open-source weights (Meta Llama 3.3 70B + OpenAI's GPT-OSS releases), American-hosted, fastest available inference (~280 tok/sec via Groq's LPU hardware). Cross-geography parity — users uncomfortable with Chinese hosting now have a comparable open-source option without falling back to the three closed-source Big Tech providers. Two distinct optimization targets surfaced via the same selector: DeepSeek for cheapest ($0.27/M input), Groq for fastest American ($0.59/M input). Both ~5–10× cheaper than American closed-source alternatives.

  **What's in the SDK surface:**
  - `ByokVendor` union extended to `"anthropic" | "openai" | "google" | "deepseek" | "groq"`
  - `GROQ_MODELS = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"] as const` in `models.ts` (Llama 3.3 70B is the default tool-use workhorse; GPT-OSS 120B is OpenAI's open-weights release hosted competitively only via Groq, MoE architecture comparable to GPT-4 class on tool benchmarks)
  - `DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile"`
  - `GROQ_CANONICAL_URL = "https://api.groq.com/openai/v1"` in `provider-resolver.ts` (note the `/openai/v1` namespace — Groq explicitly versions the OpenAI-shape API)
  - `defaultModelForVendor("groq")` returns `DEFAULT_GROQ_MODEL`
  - `canonicalVendorBaseUrl("groq")` returns `GROQ_CANONICAL_URL`
  - Resolver's `byok` arm: Groq dispatches as `wireProtocol: "openai"` (same arm as Google / DeepSeek — Groq's hosted API is OpenAI-compatible with minor caveats around logprobs / logit_bias / certain audio formats which don't affect motebit's tool-use loop)

  **Notable industry context (preserved for doctrine fidelity).** In December 2025 NVIDIA entered a $20B _non-exclusive licensing agreement_ with Groq, paying $20B to license Groq's LPU inference chip architecture and hire founder Jonathan Ross + most of the engineering leadership. Groq remains operationally independent under new CEO Simon Edwards; the API service continues unchanged. The structure is reportedly a "reverse acqui-hire" designed to avoid antitrust filing requirements (licensing deals are exempt from Hart-Scott-Rodino premerger notification). For motebit's vendor-agnostic stance this is _exactly_ the kind of consolidation the `agility-as-role` pattern absorbs cleanly — the role (foundation-model vendor accessible via OpenAI-compatible wire protocol) survives the instance's corporate relationships. Today the Groq API works as a first-class BYOK option; tomorrow, if NVIDIA fully absorbs Groq into their inference stack, the registry pattern can swap or supplement it without touching consumer code. This is the structural value of the agility-as-role discipline.

  **Tests.** New "byok groq" describe block in `provider-resolver.test.ts` covering: dispatch to `wireProtocol: "openai"` at the canonical URL; default model fallback; CORS-proxy substitution via `env.cloudBaseUrl`. `defaultModelForVendor` + `canonicalVendorBaseUrl` exhaustive-vendor tests extended (now 5 vendors). Type-invariants config array gets `{ mode: "byok", vendor: "groq", apiKey: "k" }`. 49/49 SDK tests green.

  **API surface.** `sdk.api.md` baseline regenerated. Additive — `@public` exports (`ByokVendor` union extension, `GROQ_CANONICAL_URL`, `GROQ_MODELS`, `DEFAULT_GROQ_MODEL`) ship with the union extension. No removals.

  **Doctrine.** `docs/doctrine/agility-as-role.md` updated — "four entries" → "five entries," with the cross-geography distinguishing-axis framing (DeepSeek = cheapest Chinese, Groq = fastest American) and the NVIDIA-licensing-agreement context preserved as a doctrinal example of how the role survives instance-level corporate shifts.

  Mechanical template-match against the prior DeepSeek slice. Future open-source-via-API additions (OpenRouter as meta-vendor, Together, Fireworks, Mistral La Plateforme) follow the same shape.

- 3b77bf0: ConversationMessage carries an optional `sensitivity` tier; runtime filters trimmed history at AI-context construction time.

  Closes the read side of the fifth (and final) egress-write boundary in the
  sensitivity-floor arc. Each variant of the `ConversationMessage` discriminated
  union (`user` / `assistant` / `tool`) now carries an optional
  `sensitivity?: SensitivityLevel` field, and the runtime's
  `ConversationManager.trimmed()` filters messages tagged above the current
  effective session tier before the conversation is handed to the AI loop.

  Untagged messages (legacy data persisted before the v1 floor, fixtures
  without a runtime) flow through unchanged for backward compat.

  Closes the cross-device leak shape: a Secret-effective turn on device A
  persists user/assistant messages at Secret (write-side floor, shipped in
  the prior commit); cross-device sync surfaces them to device B whose
  session is at None tier; the pre-call AI gate sees None × None and passes;
  trimmed history would carry the persisted-at-Secret messages into BYOK
  without this filter. The read-side filter closes the bypass — tagged
  messages above the current effective tier are excluded from trimmed
  history regardless of what the gate permits, because trimmed history is
  itself an egress shape.

  ```text
  ConversationManager.trimmed():
    1. compute effective = getEffectiveSensitivity?() ?? None
    2. filter messages: keep msg if msg.sensitivity == null OR
         rankSensitivity(msg.sensitivity) <= rankSensitivity(effective)
    3. trim filtered history into the token budget
  ```

  The filter is dynamic — driven by the runtime's `getEffectiveSessionSensitivity`
  getter at each call — not a static `CONTEXT_SAFE_SENSITIVITY` constant. A
  session whose tier elevates mid-conversation regains access to its own
  elevated messages; a session at None excludes Secret messages even if
  they are load-bearing for the current turn. Same posture the pre-call AI
  gate enforces upstream.

  Doctrine: `motebit-computer.md` §"Mode contract" — fifth boundary of the
  egress-shape arc, now both write and read closed.

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

- 28306ef: Vision-1 — pixel governance composes three gates instead of always
  stripping. The previous `projectForAi` rule ("AI never sees pixel
  bytes") was a safe floor mistakenly comment-elevated to doctrine; the
  endgame is provider-mode + sensitivity + consent-aware passthrough.

  Pixels are governed evidence, not automatic external context.

  New exports from `@motebit/sdk`:
  - `PixelConsentState` — `"denied" | "session"`. Per-session consent
    for pixel passthrough to external AI providers. Default `"denied"`
    is fail-closed; the user grants for a session via the `/vision
grant` slash command on web (and the future VisionConsentBand).
    Sovereign (`on-device`) providers bypass this gate entirely — bytes
    never cross a network boundary.
  - `DEFAULT_PIXEL_CONSENT` — `"denied"`. The fail-closed default for
    fresh sessions.
  - `PixelOmittedReason` — `"consent_required" | "sensitivity_blocked" |
"no_capability"`. Carried on the `bytes_omitted` directive when
    pixels are stripped, so the AI's perception doctrine routes to
    the right typed remediation surface (`/vision grant`,
    `/sensitivity none`, switch-providers) rather than parsing human
    text. Future variants are additive — consumers route on the cases
    they care about and ignore the rest.

  Composition (in `@motebit/ai-core`'s `projectForAi`):

  ```text
  sovereign provider                   → bytes pass (private)
  external + sensitivity > none        → strip, reason: sensitivity_blocked
  external + sensitivity = none + !consent → strip, reason: consent_required
  external + sensitivity = none + consent  → bytes pass (governed)
  ```

  Sensitivity composition matches `assertSensitivityPermitsAiCall` for
  outbound text — the same primitive now governs pixels at the same
  boundary. The receipts trail (`ToolInvocationReceipt` per
  `@motebit/mcp-client`) records every visual transfer; no new
  receipt infrastructure.

  Doctrine: `motebit-computer.md` §"Mode contract" composes pixels
  through the same three-axis decision (provider, sensitivity,
  consent) the rest of the runtime uses for outbound governance.
  `surface-determinism.md` (#90) forbids the AI from asking "may I
  see?" via prompt — consent is granted via the typed
  `/vision grant` affordance.

  Open string-literal unions — additive new states (e.g.
  `{ kind: "domain"; domains: string[] }` for per-domain remembered
  consent) land without breaking existing consumers.

- 2490143: Add optional `staleBytesOmissionReason` field to `SessionStateSnapshot` — typed-truth signal for "a prior tool result's `bytes_omitted_reason` is no longer the current gate's verdict."

  Additive (optional field). The runtime computes the staleness by tracking the most recent omission reason emitted by `projectForAi` and comparing against the current gate state at snapshot time. When the gate that fired has since flipped (consent denied → session, sensitivity elevated → none, etc.), the snapshot carries the prior reason so the prompt's PERCEPTION_DOCTRINE clause can teach the AI to re-take rather than re-recommend the affordance for the stale reason.

  Closes the failure mode where the AI tells the user "type /vision grant" after the user has already granted it — witnessed 2026-05-11 on the Google CAPTCHA flow. Same typed-truth-perception shape as `frame_stale` and `not_in_control`.

- 8b1d660: Add optional `task_step_narration?: string` field to `AIResponse` — the wire foundation for the slab chrome's `motebit × virtual_browser` register per [`docs/doctrine/chrome-as-state-render.md`](../docs/doctrine/chrome-as-state-render.md). The field carries a single first-person present-tense sentence ("Reading the page" / "Filling in the form" / "Hit a paywall — need your input") at the supervisor-cares-about granularity. Optional and additive: existing consumers ignore it; absence means the chrome recedes to the empty register.

  The field is typed-truth-validated at runtime (`validateTaskStepNarration` in `@motebit/ai-core`'s `narration-validation.ts`) before the chrome reads it — the third graduation of [`runtime-invariants-over-prompt-rules.md`](../docs/doctrine/runtime-invariants-over-prompt-rules.md), the typed-truth-perception triple applied to in-flight motebit-voiced text. A narration that contradicts wire-level typed truth (claims "Reading apple.com" while the page is on google.com) gets falsified and replaced with a runtime-templated fallback before the chrome renders it. The chrome's narration register's trust contract is: every line shown is wire-true regardless of what the model proposed.

  PR 1 first slice — the wire foundation. Subsequent slices add the chrome's state-driven render against `controlState × embodimentMode`, the `motebit × virtual_browser` register that consumes this field, the `user × virtual_browser` register (cobrowse-as-mode), and the `/wheel` + chip-tap handoff affordance per the doctrine memo's PR 1 scope.

  Backward-compatible (additive optional field). No consumer code changes required to keep working; consumers wanting the new register read the field when present and skip when absent.

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

- eec271d: Prompt-1 — runtime session-state surfaced to the AI's prompt as a
  `[Now]` block. Closes the runtime-state-confabulation hallucination
  class witnessed across the co-browse arc: the AI claims continuity
  ("the browser is already open on Hacker News") from conversation
  memory after a refresh / runtime restart / dispose — when the
  actual session is closed.

  New exports from `@motebit/sdk`:
  - `BrowserSessionInfo` — surface-supplied cloud-browser state.
    `status: "closed" | "open"`, plus optional `url` and
    `control: ControlState`. Surfaces register a provider via
    `runtime.setBrowserSessionProvider(...)`; absent provider →
    `{ status: "closed" }` default.
  - `SessionStateSnapshot` — the full runtime-side composition: the
    surface's `BrowserSessionInfo` plus the runtime's
    `sensitivity` and `pixelConsent` fields. Built by
    `runtime.getSessionStateSnapshot()` once per AI turn and threaded
    into `ContextPack.sessionState`.
  - `ContextPack.sessionState?: SessionStateSnapshot` — the new
    context-pack field. Loop threads it on every iteration (state
    can shift mid-turn — `/vision grant` flips consent; control
    transitions happen via the band).

  Wire path:

  ```text
  surface (web)              runtime                    ai-core
     │                          │                         │
     ├─ setBrowserSession        │                         │
     │  Provider(() => …)        │                         │
     │                          │                         │
                                getSessionStateSnapshot()
                                composes BrowserSessionInfo
                                + sensitivity + pixelConsent
                                │                         │
                                │   sendMessageStreaming  │
                                │   sessionState: …       │
                                │  ────────────────────►  │
                                │                         │
                                │                  contextPack
                                │                  .sessionState
                                │                         │
                                │                  formatSessionState
                                │                  → "[Now] Browser:
                                │                  open at … · Control:
                                │                  motebit driving · …"
  ```

  Format restraint — only emit lines that have something to say.
  Default state (closed browser, none sensitivity, denied consent)
  collapses to `[Now] Browser: closed`. Elevated tiers and granted
  consent get their own `·`-separated lines.

  The PERCEPTION*DOCTRINE block in `packages/ai-core/src/prompt.ts`
  extends with a rule: *"Runtime state is in the [Now] block — read
  it, don't infer it. Do NOT claim 'the browser is already open' or
  'we're on Hacker News' from conversation memory after a session
  resumption — page refreshes, runtime restarts, and explicit
  dispose calls all close sessions while leaving conversation
  history intact. The [Now] block is the truth this turn."\_

  Block named `[Now]` (not `[Session]`) to avoid collision with the
  existing `[Session]` block, which describes conversation
  continuity (when the user last spoke).

  Open string-literal — additive new fields (e.g. desktop_drive
  embodiment status, future per-domain consent) land without
  breaking existing consumers.

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

- 2b897ed: **Reorder the `ByokVendor` union — DeepSeek last to surface its geographic outlier-ness.** Changed from `"anthropic" | "openai" | "google" | "deepseek" | "groq"` to `"anthropic" | "openai" | "google" | "groq" | "deepseek"`. The four American-hosted vendors group first; DeepSeek (the sole Chinese-hosted instance) reads last so the geographic asymmetry surfaces as intentional structural ordering rather than oversight.

  Pure reorder — no breaking change. The union's membership is unchanged; switch statements and consumers that already handle all five vendors keep working identically. Test assertion order and sdk.api.md baseline regenerated to match the new declared order. Pairs naturally with the UI calm-down commit that immediately preceded this slice: DeepSeek's "Hosted in China" disclosure is the only descriptive note in the entire BYOK row, and it's now at the end of the row where the geographic-outlier framing reads cleanly.

  Sibling reorders on every surface (web HTML buttons + sections, desktop HTML buttons, mobile IntelligenceTab radio buttons + conditional sections, CLI VALID_PROVIDERS array + default-model fallback chain) land in the same commit per CLAUDE.md's one-pass-delivery principle. Doctrine `docs/doctrine/agility-as-role.md` updated with a one-line framing note explaining the order.

- bd6ed97: Slice 2i — model registry drift fix. Caught during the live smoke
  of the slab arc: the Settings dropdown advertised
  `claude-opus-4-6 — most capable`, a model that doesn't exist
  (current Opus is 4.7).

  **Root cause** — single source of truth was already in
  `packages/sdk/src/models.ts` (`ANTHROPIC_MODELS`), but
  `apps/web/src/ui/settings.ts` had a duplicate literal list with the
  stale entry. Two files, two truths; sdk's was a version behind.

  **Fix:**
  - `ANTHROPIC_MODELS` and `PROXY_MODELS` updated to `claude-opus-4-7`
    (matches the canonical Claude 4.X family — Opus 4.7 / Sonnet 4.6
    / Haiku 4.5).
  - `apps/web/src/ui/settings.ts` no longer redeclares the Anthropic
    list — imports `ANTHROPIC_MODELS` from `@motebit/sdk` and maps to
    UI labels via a local `ANTHROPIC_MODEL_LABELS` lookup. Single
    source of truth for the IDs; surface owns the human-readable
    copy.
  - OpenAI / Google dropdowns intentionally diverge from sdk's
    `OPENAI_MODELS` / `GOOGLE_MODELS` — sdk's lists are the
    proxy-routed gpt-5.4 / gemini-2.5 cost tiers; the BYOK dropdown
    shows older models users may already pay for. Different intent,
    not a shadow. Only Anthropic is unified because only Anthropic
    has aligned intent.
  - `check-preset-imports` (drift gate #40) gains an entry for
    `ANTHROPIC_MODELS` — future surfaces that try to redeclare it
    fail CI before merge. Same lock as `APPROVAL_PRESET_CONFIGS` /
    `COLOR_PRESETS` / etc.

  Doctrine: `packages/sdk/CLAUDE.md` § "Model registry" + Rule 4
  ("Surfaces must not shadow canonical identifiers").

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

- Updated dependencies [f1ba621]
- Updated dependencies [a5bf96e]
- Updated dependencies [1f5b8aa]
- Updated dependencies [45aff03]
- Updated dependencies [891a11b]
- Updated dependencies [f083b7a]
- Updated dependencies [f4aa40d]
- Updated dependencies [f9fd8f2]
- Updated dependencies [a2daccd]
- Updated dependencies [f174164]
- Updated dependencies [5851a24]
- Updated dependencies [5286de2]
- Updated dependencies [ea6dc4d]
- Updated dependencies [88d8550]
- Updated dependencies [22b6a39]
- Updated dependencies [b7f79b2]
- Updated dependencies [b42cee1]
- Updated dependencies [9c39980]
- Updated dependencies [3f2e370]
- Updated dependencies [e383c63]
- Updated dependencies [eeebf19]
- Updated dependencies [9def0cd]
- Updated dependencies [91299fd]
- Updated dependencies [7ba2761]
- Updated dependencies [c243dd2]
- Updated dependencies [7b87916]
- Updated dependencies [b0f38a8]
- Updated dependencies [f78a82a]
- Updated dependencies [28added]
- Updated dependencies [0c6196c]
- Updated dependencies [ee5f70f]
- Updated dependencies [ef49992]
  - @motebit/protocol@1.3.0

## 1.1.0

### Minor Changes

- 74042b2: Retention policy phase 3 — memory registers under `mutable_pruning`, tombstone→erase, signed deletion certs at the call site.

  `@motebit/sdk`: `MemoryStorageAdapter` gains a required `eraseNode(nodeId)` method. Implementations physically remove the node row and every edge that references it; after `eraseNode(id)` resolves, `getNode(id)` returns `null` and `getEdges(id)` returns `[]`. The existing `tombstoneNode` method stays for soft-delete lifecycle paths (decay-pass / notability-pass) that intentionally do not issue a deletion cert. Required-not-optional addition because phase 3 ties the cert format's "bytes are unrecoverable" claim (decision 7) to the storage operation; admitting an adapter without `eraseNode` would silently weaken every cert it produces.

  `@motebit/crypto`: the `self_enforcement` reason in `verifyDeletionCertificate`'s reason × signer × mode table is admitted in every deployment mode (sovereign / mediated / enterprise). The earlier sovereign-only restriction was over-tight — the subject's own runtime drives policy whether an operator exists or not, and only operator-driven enforcement is `retention_enforcement`. The doctrine table at `docs/doctrine/retention-policy.md` §"Decision 5" matches.

  Both changes are caught by typecheck; downstream package implementations of `MemoryStorageAdapter` (browser-persistence, persistence/SQLite, desktop's tauri-storage, mobile's expo-sqlite, runtime's InMemoryMemoryStorage) all carry the new method.

- 57c0e45: Skills v1 phase 2: wire `SkillSelector` into the runtime context-injection path so installed skills actually inject per-turn (spec/skills-v1.md §7).

  **`@motebit/sdk`** — adds the developer-contract surface for the runtime ↔ skill-runtime adapter boundary:

  ```text
  SkillInjection         { name, version, body, provenance }
  SkillSelectorHook      { selectForTurn(turn) -> Promise<SkillInjection[]> }
  ContextPack            new optional `selectedSkills` field
  ```

  The `SkillSelectorHook` is the abstraction the runtime binds to. Surfaces (CLI / desktop / mobile) provide concrete implementations behind this interface; the runtime stays unaware of the BSL `@motebit/skills` package per the adapter-pattern doctrine.

  **`motebit`** (CLI) — wires `NodeFsSkillStorageAdapter + SkillRegistry + SkillSelector` behind the `SkillSelectorHook` interface. Each turn the runtime calls `selectForTurn(text)`; the hook reads `~/.motebit/skills/` fresh (so `install`/`trust`/`remove` propagate without restart), runs the BM25-ranked selector with `sessionSensitivity: "none"` and `hardwareAttestationScore: 0` defaults appropriate to the CLI today, maps the result to `SkillInjection[]`, and returns top-K. `process.platform` maps to `SkillPlatform` for the OS gate.

  Selected skill bodies inject into the system prompt as labeled blocks per spec §7.3:

  ```text
  [skill: git-commit-motebit-style@1.0.0 — verified]
  <body>
  ```

  Verified skills get `verified` tag; operator-attested unsigned skills get `operator-trusted (unsigned)` tag — the agent sees provenance posture and can factor it into reasoning.

  Fail-closed: a hook that throws is logged via `runtime._logger.warn("skill_selector_failed", ...)` and treated as an empty result. Selector failures never block the AI loop.

  Phase 2 remaining work: `scripts/` quarantine + per-script approval (deferred until a skill bearing scripts/ ships; will use the existing tool-approval gate per the saved project memory). Phase 3: signed `SkillLoadReceipt` in `execution-ledger-v1`.

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

### Patch Changes

- Updated dependencies [c8c6312]
- Updated dependencies [e1d86f2]
- Updated dependencies [44d25cd]
- Updated dependencies [0233325]
- Updated dependencies [79dd661]
- Updated dependencies [fe0996e]
- Updated dependencies [374a960]
- Updated dependencies [a2ce037]
- Updated dependencies [4d05d70]
- Updated dependencies [98c1273]
- Updated dependencies [2a48142]
- Updated dependencies [cabf61d]
- Updated dependencies [9b4a296]
  - @motebit/protocol@1.2.0

## 1.0.1

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

- Updated dependencies [a428cf9]
- Updated dependencies [950555c]
- Updated dependencies [9923185]
  - @motebit/protocol@1.1.0

## 1.0.0

### Major Changes

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

### Patch Changes

- 699ba41: Rewrite three fixed-group `@deprecated` annotations to the four-field
  contract from `docs/doctrine/deprecation-lifecycle.md`:
  `OLLAMA_SUGGESTED_MODELS` and `OllamaSuggestedModel` in `@motebit/sdk`,
  and `cli_private_key` on `motebit`'s `FullConfig` shape. Each marker
  now carries `since`, `removed in`, a replacement pointer, and a reason
  — downstream consumers see a consistent deprecation format across the
  entire fixed-group publish surface, and the planned
  `check-deprecation-discipline` drift gate has a clean starting line
  when it lands post-1.0.

  No behavior change — JSDoc-only edits.

- 1e07df5: Ship `@motebit/verifier` — offline third-party verifier for every signed Motebit artifact (identity files, execution receipts, W3C verifiable credentials, presentations). Exposes `verifyFile` / `verifyArtifact` / `formatHuman` as a library and the `motebit-verify` CLI with POSIX exit codes (0 valid · 1 invalid · 2 usage/IO). Zero network, zero deps beyond `@motebit/crypto`. Joins the fixed public-surface version group.
- Updated dependencies [ceb00b2]
- Updated dependencies [8cef783]
- Updated dependencies [e897ab0]
- Updated dependencies [c64a2fb]
- Updated dependencies [bd3f7a4]
- Updated dependencies [54158b1]
- Updated dependencies [009f56e]
- Updated dependencies [620394e]
- Updated dependencies [4eb2ebc]
- Updated dependencies [85579ac]
- Updated dependencies [2d8b91a]
- Updated dependencies [e17bf47]
- Updated dependencies [58c6d99]
- Updated dependencies [54e5ca9]
- Updated dependencies [3747b7a]
- Updated dependencies [db5af58]
- Updated dependencies [1e07df5]
  - @motebit/protocol@1.0.0

## 0.8.0

### Minor Changes

- b231e9c: MIT/BSL protocol boundary, credential anchoring, unified Solana anchoring
  - **@motebit/crypto** — new package (replaces @motebit/verify). First npm publish. Sign and verify all artifacts with zero runtime deps. New: `computeCredentialLeaf`, `verifyCredentialAnchor` (4-step self-verification).
  - **@motebit/protocol** — new types: `CredentialAnchorBatch`, `CredentialAnchorProof`, `ChainAnchorSubmitter`, `CredentialChainAnchor`. Semiring algebra moved to MIT.
  - **@motebit/sdk** — re-exports new protocol types.
  - **create-motebit** — no API changes.
  - **motebit** — sovereign delegation (`--sovereign` flag), credential anchoring admin panel, unified Solana anchoring for settlement + credential streams.

  New specs: settlement@1.0, auth-token@1.0, credential-anchor@1.0, delegation@1.0 (4 new, 9 total).

### Patch Changes

- Updated dependencies [b231e9c]
  - @motebit/protocol@0.8.0

## 0.7.0

### Minor Changes

- 9b6a317: Move trust algebra from MIT sdk to BSL semiring — enforce IP boundary.

  **Breaking:** The following exports have been removed from `@motebit/sdk`:
  - `trustLevelToScore`, `trustAdd`, `trustMultiply`, `composeTrustChain`, `joinParallelRoutes`
  - `evaluateTrustTransition`, `composeDelegationTrust`
  - `TRUST_LEVEL_SCORES`, `DEFAULT_TRUST_THRESHOLDS`, `TRUST_ZERO`, `TRUST_ONE`

  These are trust algebra algorithms that belong in the BSL-licensed runtime, not the MIT-licensed type vocabulary. Type definitions (`TrustTransitionThresholds`, `DelegationReceiptLike`, `AgentTrustLevel`, `AgentTrustRecord`) remain in the SDK unchanged.

  Also adds CI enforcement (checks 9-10 in check-deps) preventing algorithm code from leaking into MIT packages in the future.

### Patch Changes

- Typed relay errors, storage parity, deletion policy, dead code cleanup.
  - Wire `SettlementError` and `FederationError` into relay paths (previously generic `Error`)
  - Pluggable logger in sync-engine encrypted adapter (replaces `console.warn`)
  - Scope knip to external deps (`@motebit/*` excluded from dead-code analysis)
  - Remove dead `@noble/ciphers` (Web Crypto API replaced it)
  - Remove dead code: `termWidth`, web error banner cluster (JS + CSS + HTML)
  - Encode deletion policy as architectural invariant in CLAUDE.md
  - Full storage parity: all surfaces wire complete `StorageAdapters` interface
  - Mark `verifyIdentityFile()` as deprecated in verify README
  - Override `@xmldom/xmldom` to >=0.8.12 (GHSA-wh4c-j3r5-mjhp)

- Updated dependencies [9b6a317]
  - @motebit/protocol@0.7.0

## 0.6.11

### Patch Changes

- [`4f40061`](https://github.com/motebit/motebit/commit/4f40061bdd13598e3bf8d95835106e606cd8bb17) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`0cf07ea`](https://github.com/motebit/motebit/commit/0cf07ea7fec3543b041edd2e793abee75180f9e9) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`49d8037`](https://github.com/motebit/motebit/commit/49d8037a5ed45634c040a74206f57117fdb69842) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.10

### Patch Changes

- [`d64c5ce`](https://github.com/motebit/motebit/commit/d64c5ce0ae51a8a78578f49cfce854f9b5156470) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`ae0b006`](https://github.com/motebit/motebit/commit/ae0b006bf8a0ec699de722efb471d8a9003edd61) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`94f716d`](https://github.com/motebit/motebit/commit/94f716db4b7b25fed93bb989a2235a1d5efa1421) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`fc765f6`](https://github.com/motebit/motebit/commit/fc765f68f104abafe17754d0e82290e03cae1440) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`d1607ac`](https://github.com/motebit/motebit/commit/d1607ac9da58da7644bd769a95253bd474bcfe3f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`6907bba`](https://github.com/motebit/motebit/commit/6907bba938c4eaa340b7d3fae7eb0b36a8694c6f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`067bc39`](https://github.com/motebit/motebit/commit/067bc39401ae91a183fe184c5674a0a563bc59c0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`3ce137d`](https://github.com/motebit/motebit/commit/3ce137da4efbac69262a1a61a79486989342672f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`d2f39be`](https://github.com/motebit/motebit/commit/d2f39be1a5e5b8b93418e043fb9b9e3aecc63c05) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`2273ac5`](https://github.com/motebit/motebit/commit/2273ac5581e62d696676eeeb36aee7ca70739df7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`e3d5022`](https://github.com/motebit/motebit/commit/e3d5022d3a2f34cd90a7c9d0a12197a101f02052) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`dc8ccfc`](https://github.com/motebit/motebit/commit/dc8ccfcb51577498cbbaaa4cf927d7e1a10add26) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`587cbb8`](https://github.com/motebit/motebit/commit/587cbb80ea84581392f2b65b79588ac48fa8ff72) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`21aeecc`](https://github.com/motebit/motebit/commit/21aeecc30a70a8358ebb7ff416a9822baf1fbb17) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`ac2db0b`](https://github.com/motebit/motebit/commit/ac2db0b18fd83c3261e2a976e962b432b1d0d4a9) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`b63c6b8`](https://github.com/motebit/motebit/commit/b63c6b8efcf261e56f84754312d51c8c917cf647) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`fc765f6`](https://github.com/motebit/motebit/commit/fc765f68f104abafe17754d0e82290e03cae1440) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.9

### Patch Changes

- [`0563a0b`](https://github.com/motebit/motebit/commit/0563a0bb505583df75766fcbfc2c9a49295f309e) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.8

### Patch Changes

- [`6df1778`](https://github.com/motebit/motebit/commit/6df1778caec68bc47aeeaa00cae9ee98631896f9) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`4ae74fe`](https://github.com/motebit/motebit/commit/4ae74fefb4c2f249deafe044052d53c8679c2bf4) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`4ae74fe`](https://github.com/motebit/motebit/commit/4ae74fefb4c2f249deafe044052d53c8679c2bf4) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c8928d6`](https://github.com/motebit/motebit/commit/c8928d6e700918fa3ea2bce8714a72eb5d4bfc80) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.7

### Patch Changes

- [`62cda1c`](https://github.com/motebit/motebit/commit/62cda1cca70562f2f54de6649eae070548a97389) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.6

### Patch Changes

- [`349939f`](https://github.com/motebit/motebit/commit/349939f7533ac2a73ef99cf4cc2413cd78849ce7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`349939f`](https://github.com/motebit/motebit/commit/349939f7533ac2a73ef99cf4cc2413cd78849ce7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.5

### Patch Changes

- [`e3173f0`](https://github.com/motebit/motebit/commit/e3173f0de119d4c0dd3fbe91de185f075ad0df99) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.4

### Patch Changes

- [`a58cc9a`](https://github.com/motebit/motebit/commit/a58cc9a6e79fc874151cb7044b4846acd855fbb2) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.6.3

### Patch Changes

- [`15a81c5`](https://github.com/motebit/motebit/commit/15a81c5d4598cacd551b3024db49efb67455de94) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8899fcd`](https://github.com/motebit/motebit/commit/8899fcd55def04c9f2b6e34a182ed1aa8c59bf71) Thanks [@hakimlabs](https://github.com/hakimlabs)! - Wrong passphrase: calm reset guide instead of jargon error

## 0.6.2

### Patch Changes

- [`f246433`](https://github.com/motebit/motebit/commit/f2464332f3ec068aeb539202bd32f081b23c35b0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`4a152f0`](https://github.com/motebit/motebit/commit/4a152f029f98145778a2e84b46b379fa811874cb) Thanks [@hakimlabs](https://github.com/hakimlabs)! - First-launch passphrase: explain identity before prompting

## 0.6.1

### Patch Changes

- [`1bdd3ae`](https://github.com/motebit/motebit/commit/1bdd3ae35d2d7464dce1677d07af39f5b0026ba1) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`2c5a6a9`](https://github.com/motebit/motebit/commit/2c5a6a98754a625db8c13bc0b5a686e5198de34d) Thanks [@hakimlabs](https://github.com/hakimlabs)! - First-run UX: calm setup guide instead of raw API key error

## 0.6.0

### Minor Changes

- [`ca36ef3`](https://github.com/motebit/motebit/commit/ca36ef3d686746263ac0216c7f6e72a63248cc12) Thanks [@hakimlabs](https://github.com/hakimlabs)! - v0.6.0: zero-dep verify, memory calibration, CLI republish
  - @motebit/sdk: Core types for the motebit protocol — state vectors, identity, memory, policy, tools, agent delegation, trust algebra, execution ledger, credentials. Zero deps, MIT
  - @motebit/crypto: Verify any motebit artifact — identity files, execution receipts, verifiable credentials, presentations. One function, zero runtime deps (noble bundled), MIT
  - create-motebit: Scaffold signed identity and runnable agent projects. Key rotation with signed succession. --agent mode for MCP-served agents. Zero runtime deps, MIT
  - motebit: Operator console — REPL, daemon, MCP server mode, delegation, identity export/verify/rotate, credential management, budget/settlement. BSL-1.1 (converts to Apache-2.0)
  - Memory system: calibrated tagging prompt, consolidation dedup (REINFORCE no longer creates nodes), self-referential filter, valid_until display filtering across all surfaces
  - Empty-response guard: re-prompt when tag stripping yields no visible text after tool calls
  - Governor fix: candidate modifications (confidence cap, sensitivity reclassification) now respected in turn loop

## 0.5.3

### Patch Changes

- [`268033b`](https://github.com/motebit/motebit/commit/268033b7c7163949ab2510a7d599f60b5279009b) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8efad8d`](https://github.com/motebit/motebit/commit/8efad8d77a5c537df3866771e28a9123930cf3f8) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`61eca71`](https://github.com/motebit/motebit/commit/61eca719ab4c6478be62fb9d050bdb8a56c8fc88) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`cb26e1d`](https://github.com/motebit/motebit/commit/cb26e1d5848d69e920b59d903c8ccdd459434a6f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`758efc2`](https://github.com/motebit/motebit/commit/758efc2f29f975aedef04fa8b690e3f198d093e3) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`95c69f1`](https://github.com/motebit/motebit/commit/95c69f1ecd3a024bb9eaa321bd216a681a52d69c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c3e76c9`](https://github.com/motebit/motebit/commit/c3e76c9d375fc7f8dc541d514c4d5c8812ee63ff) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`518eaf1`](https://github.com/motebit/motebit/commit/518eaf1f30beab0bd0cad741dfb0d4fb186f5027) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8eecda1`](https://github.com/motebit/motebit/commit/8eecda1fa7dc087ecaef5f9fdccd8810b77d5170) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`03b3616`](https://github.com/motebit/motebit/commit/03b3616cda615a2239bf8d18d755e0dab6a66a1a) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`ed84cc3`](https://github.com/motebit/motebit/commit/ed84cc332a24b592129160ab7d95e490f26a237f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`518eaf1`](https://github.com/motebit/motebit/commit/518eaf1f30beab0bd0cad741dfb0d4fb186f5027) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`ba2140f`](https://github.com/motebit/motebit/commit/ba2140f5f8b8ce760c5b526537b52165c08fcd64) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`e8643b0`](https://github.com/motebit/motebit/commit/e8643b00eda79cbb373819f40f29008346b190c8) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`6fa9d8f`](https://github.com/motebit/motebit/commit/6fa9d8f87a4d356ecb280c513ab30648fe02af50) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`10226f8`](https://github.com/motebit/motebit/commit/10226f809c17d45bd8a785a0a62021a44a287671) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`0624e99`](https://github.com/motebit/motebit/commit/0624e99490e313f33bd532eadecbab7edbd5f2cf) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c4646b5`](https://github.com/motebit/motebit/commit/c4646b5dd382465bba72251e1a2c2e219ab6d7b4) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`0605dfa`](https://github.com/motebit/motebit/commit/0605dfae8e1644b84227d386863ecf5afdb18b87) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`c832ce2`](https://github.com/motebit/motebit/commit/c832ce2155959ef06658c90fd9d7dc97257833fa) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`813ff2e`](https://github.com/motebit/motebit/commit/813ff2e45a0d91193b104c0dac494bf814e68f6e) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`35d92d0`](https://github.com/motebit/motebit/commit/35d92d04cb6b7647ff679ac6acb8be283d21a546) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`b8f7871`](https://github.com/motebit/motebit/commit/b8f78711734776154fa723cbb4a651bcb2b7018d) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`916c335`](https://github.com/motebit/motebit/commit/916c3354f82caf55e2757e4519e38a872bc8e72a) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`401e814`](https://github.com/motebit/motebit/commit/401e8141152eafa67fc8877d8268b02ba41b8462) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`70986c8`](https://github.com/motebit/motebit/commit/70986c81896c337d99d3da8b22dff3eb3df0a52c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8632e1d`](https://github.com/motebit/motebit/commit/8632e1d74fdb261704026c4763e06cec54a17dba) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`5427d52`](https://github.com/motebit/motebit/commit/5427d523d7a8232b26e341d0a600ab97b190b6cf) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`78dfb4f`](https://github.com/motebit/motebit/commit/78dfb4f7cfed6c487cb8113cee33c97a3d5d608c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`dda8a9c`](https://github.com/motebit/motebit/commit/dda8a9cb605a1ceb25d81869825f73077c48710c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`dd2f93b`](https://github.com/motebit/motebit/commit/dd2f93bcacd99439e2c6d7fb149c7bfdf6dcb28b) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.5.2

### Patch Changes

- [`daa55b6`](https://github.com/motebit/motebit/commit/daa55b623082912eb2a7559911bccb9a9de7052f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`1d06551`](https://github.com/motebit/motebit/commit/1d06551bff646336aa369b3c126bbd40aa13b806) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`1d06551`](https://github.com/motebit/motebit/commit/1d06551bff646336aa369b3c126bbd40aa13b806) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`fd9c3bd`](https://github.com/motebit/motebit/commit/fd9c3bd496c67394558e608c89af2b43df005fdc) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`5d285a3`](https://github.com/motebit/motebit/commit/5d285a32108f97b7ce69ef70ea05b4a53d324c64) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`54f846d`](https://github.com/motebit/motebit/commit/54f846d066c416db4640835f8f70a4eedaca08e0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`2b9512c`](https://github.com/motebit/motebit/commit/2b9512c8ba65bde88311ee99ea6af8febed83fe8) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`2ecd003`](https://github.com/motebit/motebit/commit/2ecd003cdb451b1c47ead39e945898534909e8b1) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`fd24d60`](https://github.com/motebit/motebit/commit/fd24d602cbbaf668b65ab7e1c2bcef5da66ed5de) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`7cc64a9`](https://github.com/motebit/motebit/commit/7cc64a90bccbb3ddb8ba742cb0c509c304187879) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`5653383`](https://github.com/motebit/motebit/commit/565338387f321717630f154771d81c3fc608880c) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`753e7f2`](https://github.com/motebit/motebit/commit/753e7f2908965205432330c7f17a93683644d719) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`10a4764`](https://github.com/motebit/motebit/commit/10a4764cd35b74bf828c31d07ece62830bc047b2) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

## 0.5.1

### Patch Changes

- [`9cd8d46`](https://github.com/motebit/motebit/commit/9cd8d4659f8e9b45bf8182f5147e37ccda304606) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`d7ca110`](https://github.com/motebit/motebit/commit/d7ca11015e1194c58f7a30d653b2e6a9df93149e) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`48d2165`](https://github.com/motebit/motebit/commit/48d21653416498f2ff83ea7ba570cc9254a4d29b) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`f275b4c`](https://github.com/motebit/motebit/commit/f275b4cccfa4c72e58baf595a8abc231882a13fc) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8707f90`](https://github.com/motebit/motebit/commit/8707f9019d5bbcaa7ee7013afc3ce8061556245f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`a20eddd`](https://github.com/motebit/motebit/commit/a20eddd579b47dda7a0f75903dfd966083edb1ea) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`8eef02c`](https://github.com/motebit/motebit/commit/8eef02c777ae6e00ca58f0d0bf92011463d4d3e7) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`a742b1e`](https://github.com/motebit/motebit/commit/a742b1e762a97e520633083d669df2affa132ddf) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`04b9038`](https://github.com/motebit/motebit/commit/04b9038d23dcadec083ae970d4c05b2f3ce27c3f) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`bfafe4d`](https://github.com/motebit/motebit/commit/bfafe4d72a5854db551888a4264058255078eab1) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

- [`527c672`](https://github.com/motebit/motebit/commit/527c672e43b6f389259413f440fb3510fa9e1de0) Thanks [@hakimlabs](https://github.com/hakimlabs)! - auto-generated patch bump

All notable changes to `@motebit/sdk` are documented here. For full project history, see the [root changelog](../../CHANGELOG.md).

## [0.3.0] - 2026-03-13

### Added

- Branded ID types: `AllocationId`, `SettlementId`, `ListingId`, `ProposalId` (join existing `MotebitId`, `DeviceId`, `NodeId`, `GoalId`, `EventId`, `ConversationId`, `PlanId`)
- `PrecisionWeights` interface for active inference precision feedback
- `exploration_weight` field on `MarketConfig`
- `CollaborativePlanProposal`, `ProposalParticipant`, `ProposalStepCounter`, `ProposalResponse`, `CollaborativeReceipt` interfaces
- `ProposalStatus` and `ProposalResponseType` enums
- `assigned_motebit_id` on `PlanStep` and `SyncPlanStep`
- `proposal_id` and `collaborative` on `Plan` and `SyncPlan`
- 5 new `EventType` values: `ProposalCreated`, `ProposalAccepted`, `ProposalRejected`, `ProposalCountered`, `CollaborativeStepCompleted`
- `AgentServiceListing` and `AgentTrustRecord` interfaces for capability market
- `MemoryContent` type separated from `MemoryNode` for safe wire serialization
- `did` field on `VerifyResult` and `AgentCapabilities`
- `ReputationSnapshot` type for Beta-binomial smoothed reputation
- `CandidateProfile` and `TaskRequirements` types for market scoring
- Trust semiring algebra: `trustAdd`, `trustMultiply`, `composeTrustChain`, `joinParallelRoutes`, `composeDelegationTrust`
- Canonical `TRUST_LEVEL_SCORES` mapping (single source of truth)
- W3C Verifiable Credentials types: `VerifiableCredential`, `VerifiablePresentation`, `CredentialProof`
- `ExecutionTimelineEntry` and `GoalExecutionManifest` types for execution ledger
- Budget allocation types: `BudgetAllocation`, `Settlement`
- `precisionContext` field on `ContextPack`

## [0.1.0] - 2026-03-08

### Added

- Core protocol types: `MotebitState`, `BehaviorCues`, `MemoryNode`, `EventLogEntry`, `PolicyDecision`, `RenderSpec`
- Identity types: `MotebitId`, `DeviceId`, `NodeId`, `GoalId`, `EventId`, `ConversationId`, `PlanId`
- Agent delegation types: `ExecutionReceipt`, `DelegationToken`, `AgentTrustLevel`
- Tool, policy, and sync interfaces
- MIT licensed, zero dependencies
