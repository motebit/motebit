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
