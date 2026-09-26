# motebit CLI Changelog

## 1.15.0

### Minor Changes

- 9c87f80: `motebit run` and `motebit serve` enrol the machine in the motebit's machine roster, and `motebit machines` reads it.

  A process that announces it hosts unattended work now passes through the roster's mint step after it registers with the relay: the first start signs a `HostEnrollment` for this machine and presents it; later starts re-present the bytes they hold and mint nothing. A `run` and a `serve` starting together on one machine mint one enrolment between them (the mint is taken under `~/.motebit/machine-roster.json.mint.lock`). A machine that was retired from the roster never re-enrols on its own; it says so once and keeps running. Nothing is minted automatically unless both the relay's key chain and its roster were read that start, and never while this machine has lines its key chain cannot place (a lost local copy after a rotation reads as that, not as "no line"). A failed relay read, a relay that keeps omitting entries this machine holds, or an unreadable local copy means nothing is minted that start. None of it ever blocks the daemon.

  `motebit machines [--json]` reduces the roster on this machine, under a key chain it resolved itself, and prints each machine with what the relay observed of it. A count is printed only when nothing suppressed it, and the chain head is cited by key. `motebit machines retire <device_id>` signs a retirement for every standing entry of a machine; `motebit machines enroll <device_id> [--force]` undoes one, and refuses ids that could never answer unless forced.

  `motebit rotate` records this machine's roster status under the old key before it sends the rotation, and after the local commit enrols the machine under the new key only if that record says it was an active host — never from what the relay holds after the rotation was recorded. A rotation resumed later uses the record its first attempt took. Only a line this machine enrolled itself is carried across a rotation; a machine enrolled from another surface needs `motebit machines enroll` again after rotating.

  The replica lives at `~/.motebit/machine-roster.json` (owner-only, written atomically under a lock; an unreadable one is moved aside with its bytes kept). Every roster request is authenticated by this machine's own device key, never the operator's master token.

  `motebit machines retire` and `enroll` say plainly when the relay did not take the act, or refused it for good because its roster is full. No count is printed while this machine's own copy of the roster could not be read and has not since been re-confirmed from the relay.

  When this device cannot place a machine's enrolments in its key chain (a failed key-chain read, or a guardian recovery with no guardian pinned here), `motebit machines`, `retire` and `enroll` say so, and never call that machine unenrolled. An empty roster says what this device actually holds (for example, retirements for enrolments it has not seen), and no count is printed when the key chain could not be refreshed from the relay. Refusal and remedy messages state only what this device can see, with the command to run. A machine is called connected only while the relay believes a socket is open; a status read without the relay is labelled as this device's copy.

### Patch Changes

- 9e32cf9: `~/.motebit/config.json` is now read and written under three rules, at every reader and writer — it holds `cli_encrypted_key` (for a CLI identity, the only copy of the private key) and, for anyone who has not migrated, the deprecated `cli_private_key` in plaintext.

  - **Absence is not damage.** A missing config is a first run. A config that exists but cannot be read, does not parse, or parses to something other than an object (`null`, `[]`, a number) is now refused with a message naming the file — it was previously read as "no config", which told the user they had no identity and let the next save overwrite whatever was recoverable.
  - **Damage is never overwritten.** A save over a damaged config first keeps its bytes as `config.json.clobbered-<time>` — the name `motebit doctor`, `migrate-keyring` and the missing-key remedy already point at, and which nothing previously wrote — or refuses. `motebit restore` (where `doctor` sends a user with a damaged config) now completes over one, on both of its config reads, and says where the old bytes went; an aborted restore leaves the file untouched.
  - **Atomic and owner-only.** A save stages a new file created `0600`, fsyncs it, renames it over the config and fsyncs the directory, so a crash, full disk or kill leaves the old file or the new one, never a partial one; the scratch copy is removed on failure. A config written world-readable by an earlier version is narrowed to `0600` the next time it is loaded.

  `motebit doctor` reports a damaged config as a failing check (exit 1) — before, it reported "not created yet", and the CLI's top-level error handler prints the refusal as a message rather than a stack trace. `pending-rotation.json` (a rotation's encrypted new key) and the `motebit.md` snapshots written by `rotate` and `export` use the same atomic replacement.

  The rotation write-ahead (`pending-rotation.json`) follows the same split: a file that exists but cannot be read, parsed, or is missing a field is now `"unreadable"`, never "nothing held" — it may be the only copy of a new key the relay already accepted. `motebit rotate` stops on it and leaves it in place; `motebit restore` refuses a passphrase reset while one is present, and on a fresh install or a replace keeps its bytes as `pending-rotation.json.clobbered-<time>` instead of deleting it. `restore` now never deletes a write-ahead at all: a rotation of the identity being restored, in flight from the seed's own key, is left in place with a note to finish it with `motebit rotate` under the passphrase it was started with; every other one — including another identity's, whose new key may exist nowhere else if the relay accepted it — is kept as `pending-rotation.json.clobbered-<time>` when the restore commits (an aborted restore moves nothing). A write-ahead readable by group or others is narrowed to `0600` when loaded, as `config.json` is.

  `motebit restore` no longer destroys the key of the identity it replaces. Before a replace — or a "fresh install" over a config that has a key but no `motebit_id` — overwrites a config carrying `cli_encrypted_key` or `cli_private_key`, that config is kept as `config.json.clobbered-<time>` (`0600`), whatever its state; the REPLACE warning now says so instead of claiming the old identity can only come back from its own seed.

  Deliberate edges, stated so nobody mistakes them for regressions:

  - **Symlinked config.** A `config.json` that is a symlink is replaced at the file it points to, so the link survives (a rename over the link would have turned it into a regular file). A preserved copy is always of the REAL file's bytes — a byte copy created `0600` from the start (a hard link only for a file this process cannot read) — never a second name for the symlink, which on Linux would have read the new contents after the save. A symlink that cannot be resolved is refused rather than "preserved".
  - **Group-readable configs are narrowed.** Loading narrows any config readable by group or others to `0600`, including one made group-readable on purpose. The key file's confidentiality outranks that rare setup; keep a separate, deliberately shared copy if you need one.
  - **An empty or whitespace-only config is damage**, not a first run: it is refused (and preserved before any overwrite) like any other unparseable file. Only a missing file is a first run.

- 9e32cf9: Key-file durability, build 3 (`docs/proposals/key-file-durability-v1.md`, lane A) — every door onto a file that holds an identity key now follows the same three rules: absence is not damage, key material is never destroyed, writes are atomic and owner-only.

  - **No lost update on `config.json`.** A command that read the config before another process committed a new key (a `motebit` REPL open while `motebit rotate` runs elsewhere, `register`, `up`, a passphrase prompt) can no longer write the old key back: a save that does not change the identity keeps the identity on disk, and a save that does change it is refused if the identity changed since it was read. Replaced key or signed-identity material is kept as `config.json.clobbered-<time>`. Saves take an advisory lock, `config.json.lock` (exclusive create, the holder's pid; a dead holder's lock is broken, a live one is waited on for up to 5 s).
  - **Identity bootstrap never mints over a key.** A config that holds a key but no `motebit_id`, a key that will not open under the passphrase, or a key that derives to a public key other than the config's is refused with a message, never replaced by a fresh identity. A first launch writes the key and its identity in one atomic write, and a binding that must be refused is refused before any key is stored.
  - **Rotation keeps what the relay has not confirmed.** A rotation write-ahead that belongs to another identity, that a fresh rotation supersedes, or that the relay refused is kept as `pending-rotation.json.clobbered-<time>` instead of being deleted — it may be the only copy of a key the relay accepted. The retired key is erased only when the relay recorded the succession; when the relay holds no key for the identity, it is kept and `motebit rotate` says where.
  - **Restore** keeps a key it replaces on every plan, including a passphrase reset over a config whose encrypted key is not the seed's, and refuses (changing nothing) if the config changed while the passphrases were typed.
  - **Damaged and dangling files.** A key file readable by others is narrowed to `0600` on every load, including a load that reports it damaged. A symlinked key file whose target is missing is damage, never "no file": it is refused, and the link is never replaced.
  - **Preserved copies are byte copies** (`0600`, directory fsync'd), so an older writer rewriting the live file in place cannot change them; a hard link is used only for a file this process cannot read.
  - **`migrate-keyring`** never erases key bytes: after migrating, the plaintext keyring is moved aside to `dev-keyring.json.migrated-<time>` (`0600`) instead of being zeroed and deleted, and a keyring that holds more than the migrated key (the desktop's rotation write-ahead, preserved keys, other pending entries) is left in place. `--force` keeps the replaced encrypted key; a symlinked keyring's target is never touched; a keyring the desktop already moved into the OS keychain is reported as such.
  - **`init --file … --force`** refuses to write over a key or identity file.
  - **`motebit relay up`**: `~/.motebit/relay/` is created `0700`, and the relay database (which holds the relay's private key, in plaintext unless a passphrase is set) is created `0600` and narrowed, with its journal files, on every start.
  - **`smoke-x402`**: its EVM key files are written atomically `0600`, narrowed on load, and never regenerated over a file that cannot be read or does not hold a key.
  - **`export`** keeps another identity's `motebit.md` (in the export directory or the `~/.motebit` snapshot) as `motebit.md.clobbered-<time>` instead of overwriting it.
  - **`doctor`** lists every kept or stranded key copy (`*.clobbered-*`, `create-motebit rotate`'s `pre-rotation-*` / `rotation-next-*`, stranded `*.tmp`), and fails on a stranded `rotation-next-*`.
  - `~/.motebit` (and a scaffolded agent's `.motebit`) is created `0700`.
  - The `write_file` / `undo_write` tools refuse to write inside `~/.motebit`, `$MOTEBIT_CONFIG_DIR` or any `.motebit` directory; their backups are `0600` in a `0700` directory, and a file that cannot be backed up is not overwritten.

  The rotation adapter stays a thin surface-kit adapter: the compare-and-swap before a rotation commit (`refuseIfKeyReplacedSince`) and the retired-key ruling (`retiredKeyChange`) live in `config.ts`, and the write-ahead port type (`PendingRotationPort`) in `pending-rotation.ts`.

  A kept copy is refused, rather than attempted, when the file to keep cannot be resolved at all (a dangling or looping link, or nothing there): nothing is changed.

  A config that names an identity but holds no CLI key — what the desktop app writes into the shared `~/.motebit/config.json`, or a CLI identity whose key was lost — is refused with a pointer to `motebit migrate-keyring` / `motebit restore`, never replaced by a freshly minted identity. An identity-changing save now also keeps the replaced `motebit_id` / `device_id` / `device_public_key`. A second `undo_write` no longer re-applies the write the first one undid. `doctor` also lists `dev-keyring.json.migrated-*` and `motebit.md.clobbered-*`. Every creation of `~/.motebit` (grants, skills, the update check) is `0700`. A stale config lock is broken atomically, so two waiters never both hold it.

  The config lock identifies a lock by its CONTENT (`<pid> <nonce>`), not its inode: Linux reuses inode numbers, so an inode check could break a fresh lock. A holder releases only a lock that still carries its own token.

- 10c6b5c: The machine roster takes evidence from a local `motebit.md` only when the key this machine holds signed it (#800).

  `motebit machines`, the mint step at `motebit run` / `motebit serve`, and the rotation hook read `motebit.md` from the working directory and every parent directory. Before this fix, any self-signed file naming this motebit counted: a file planted in a parent directory, signed by an unrelated key and naming a guardian, could make the machine's key look like the identity key, show a count, and have a retirement signed and presented. A file now contributes succession records, and its guardian, only when its signature verifies, it names this motebit, and its current key is exactly the key in hand. Any other file contributes nothing. The rotation hook reads the new link only from a file whose current key is the committed key.

- 3f063a8: `motebit migrate-keyring` no longer tells you the desktop app moved your keys into the OS keychain — no shipped desktop uses the OS keychain. When `~/.motebit/dev-keyring.json` is gone but a `dev-keyring.json.migrated-*` copy is present, it now says what that copy is: a previous `migrate-keyring` run's retired plaintext keyring, kept owner-only. It then points you at `motebit restore`, or at moving the copy back and running the command again. When the only thing present is a `keychain-index.json`, it says that a pre-release desktop build left it, and does not claim that a previous run retired anything.
- 49e7c92: `motebit machines` no longer mistakes a desktop session for the machine's daemon.

  Where the relay serves `host_sockets_open`, the roster reads it for two things: whether an active machine is running ("the relay believes a socket is open"), and the "two machines may share this id" hint, so a desktop app or an interactive CLI beside the daemon no longer trips it. An active machine with only a session open says "a session (not the host) is connected" beside when it was last seen.

  "Retired, but connected", a device that is not enrolled but is connected, and the check that a device holds the current key still read `sockets_open` (any bound socket), because a session proves those exactly as a daemon does. Against an older relay that does not serve the field, behaviour is unchanged.

- 96be50f: `motebit rotate` reaches the relay, and cannot strand the identity between two keys.

  It used to erase the old key, then tell the relay with a bearer the relay could never verify, then swallow the refusal — every rotation left the identity on a key the relay had never heard of, with no way back. Now it reads where the relay stands first (from the public succession route, no token), writes the new key to disk encrypted before anything is sent, submits signed by the key being retired, and moves local state only after the relay confirms. A lost response is resolved on the next run by reading, never by re-signing or replaying; an unreachable relay stops with the old key intact; a relay that holds some other key names it and points at guardian recovery; an identity the relay never knew rotates locally and says so. The relay is resolved the same way `motebit up` resolves it, default included. `motebit restore`'s passphrase reset refuses while a rotation is in flight, since the held key is encrypted under the current passphrase.

- 96be50f: `motebit rotate` takes the relay's own answer to "may a rotation depart from this key" instead of re-deriving it — a daemon that had shut down (its key held only on a device row) no longer reads as unregistered. The departing key comes from the config's private key, an interrupted commit is finished from the write-ahead, a stale write-ahead is reported and cleared rather than left to block a passphrase change, and every relay-facing command resolves the relay through one shared resolver.
- 36f62fb: `motebit rotate` now runs the same rotation state machine as web, mobile and desktop (`@motebit/surface-kit`), so the four cannot drift. Two edges are handled more carefully: a rotation interrupted between its two local writes is finished from its write-ahead rather than treated as stale, and a write-ahead that is present but cannot be read stops the run with the honest next step instead of being mistaken for none.
  - @motebit/state-export-client@0.5.26

## 1.14.0

### Minor Changes

- 78eb373: A record of when this machine was actually awake, and `doctor` reporting it as a measurement.

  A motebit only works while something is hosting it, and a laptop is asleep most of the night. Nothing recorded that, so there was no way to answer "was my motebit even running when it should have been" — and no way for `doctor` to tell an owner what their hardware actually gives them. It reports the number now: _"this machine was awake 38% of the last 7 days (~9.1h/day)"_, with the longest gaps named, because an owner acts on **when** it was down rather than on a percentage. Measured, never promised: saying "your motebit runs unattended" without this is a claim the product cannot keep on the hardware most people have.

  **A sleep is a gap even though the process never died,** and getting that wrong is the whole difficulty. Closing a laptop lid does not restart `motebit run` — the process survives and its interval simply stops firing, then fires again on resume. Refreshing the same row there stretches it from 01:00 to 09:00, so eight hours of sleep read back as eight hours of continuous uptime, and a record built to show the gap reports its opposite. So a tick arriving long after the last one opens a NEW session rather than extending the old, detected at write time by the only party that can tell: whoever noticed that time passed without a tick. The writer's threshold and the reader's tolerance are one exported constant, because a writer that stretched across a gap the reader would call downtime produces a record contradicting itself.

  Below that threshold nothing is a gap: `last_seen_at` lags by up to a tick and a restart costs another, so treating that seam as downtime would tell an owner their motebit slept when it did not. And `awakeMs` is the window minus the gaps rather than a sum of sessions, so the two numbers cannot disagree — summing made "97% awake, gaps: none" possible, two figures about one fact contradicting each other on the same screen.

  **Coverage is per MACHINE.** These rows live in the database of the machine that wrote them, so a laptop's reader answers for the laptop and never for the motebit. The union across machines — where a motebit's uptime is the union of its machines' uptimes — needs the same cross-machine plumbing as coordinator handoff. Named rather than faked.

  **What this deliberately does NOT do: explain why a goal fired late.** The first version did, and it was wrong in the way this arc keeps finding. There are at least five reasons a goal is late — the machine was asleep, the scheduler did not fire, the owner halted it, an approval was pending, the goal was disabled and re-enabled — and inferring the cause from lateness plus coverage collapses them into two. That collapse accused the scheduler of a defect for a week the owner had halted it themselves, and fabricated a hosting gap for every goal due before this record existed. Causes belong to whoever knows them: the scheduler knows why it skipped, at the moment it skips. Recording that is its own increment; reconstructing it afterwards from two signals that do not determine it is the same "two absences collapsed into one" error this arc exists to remove.

  **The installer is not here either.** Issue #685 says increment 4's content is the coverage record rather than the plist, and the record stands alone — people already run `motebit run` by hand. The installer is also what makes two-machine setups easy while a remote `halt` is still refused on two (#686), so it should not land before that story is whole (#681, #687).

  Found alongside: a persistence test hardcoded the latest migration version, with a comment asking the next person to bump it "so CI catches a forgotten version bump in the migrate block". There is no such block — `runMigrations` derives the version from the registry — so the literal guarded nothing and failed on every migration. It asserts the relationship now.

  Review round, and the sharpest finding was the same error one layer over. `doctor` asked for seven days unconditionally, so a machine that had been hosting for weeks was told it was **not hosted for six days** — because that is when the table was created. Fabricating absence out of missing records is exactly what the lateness inference was removed for, reproduced in the headline that replaced it.

  The fix is in the READER rather than in each caller's arithmetic: a coverage window is clamped to this machine's first record, and reports what it OBSERVED. No record at all is an empty window, never a gap — absence of evidence is not evidence of absence, and a caller renders that as "no record of running" rather than as downtime. The percentage's denominator is the observed period, so it cannot be a share of days nobody was recording.

  - **`wasAwakeAt` is derived from `between`**, so the two cannot disagree about one instant. They did: one granted an unconditional grace after a session ended while the other only forgave a seam when a following session began within tolerance, so for up to one tolerance after the last tick before a real sleep, an instant was inside a reported gap _and_ reported awake — on exactly the distinction this module exists to draw.
  - **A clock stepping backward starts a new session.** The continuity check was true for negative deltas, so an NTP correction kept extending one row with an earlier timestamp, leaving an inverted interval that reports downtime over time the machine was awake — or drops the running session from the read entirely.
  - **A failing liveness write is reported once**, not swallowed in silence. Not taking the daemon down is right; saying nothing meant `doctor` could report hours of "not hosted" for a machine that was awake and ticking the whole time, with nothing anywhere explaining why.
  - The coverage read has its own try/catch and its own message — folded into the recent-outcomes block, a failure here printed "could not read recent outcomes" and skipped the outcomes report that would have worked.
  - The index is keyed on `last_seen_at`, which is what the window read filters on first.

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

- f71d5d7: A harness that stands two real runtimes against one relay — the prerequisite the return view's review rounds kept asking for.

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

  **A live defect, found on day one by the harness being wrong.** It modelled a dead socket as one whose `send` throws. `ws@8` only throws while CONNECTING; on CLOSING or CLOSED it swallows the frame and returns. So the relay's `try/catch` counted a stale connection as a delivery, short-circuited, never tried the live process beside it on the same machine, and the caller learned nothing until a thirty-second timeout answered "the agent did not respond" — about a runtime that was connected and willing the whole time. That is the ordinary case moments after a process restarts, and a halt is the worst verb to lose. Every other send site in the relay already checked `readyState`; this one did not. The harness models the transport truthfully now, and reproduces the production symptom exactly when the guard is removed.

  **The `motebit run` behaviour change this ships:** the daemon refuses a relay command when no registered identity key is available to verify the envelope against, where before it executed. `motebit serve` already refused; the copies had drifted, and the guard is structural in the shared handler now.

  Next on this harness: issue #681, the multi-machine halt broadcast, which is blocked on it.

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

- 2d1fb2c: Security: `motebit fund` no longer shell-interpolates the relay-supplied checkout URL — it is parsed (HTTPS only; plain HTTP only for loopback dev relays; no credentials) and handed to the platform opener as a single argv element via `execFile`. Approved skill scripts now run with a scrubbed environment (PATH, HOME, locale, terminal and temp variables only) instead of inheriting the operator's full environment, so approving a script no longer discloses API keys, relay tokens or motebit configuration; the approval prompt states this.
- bc30fd8: `motebit run` and `motebit serve` now register with the relay as themselves: every discovery call (bootstrap → register → listing → heartbeat → deregister) carries a short-lived token signed by the motebit's own device key, bound to the audience each route expects. The relay operator's master token (`--sync-token` / `MOTEBIT_API_TOKEN` / `MOTEBIT_SYNC_TOKEN`) is no longer used for registration, and registration is never sent unauthenticated. Fixes two long-standing gaps: a daemon on a hosted relay without the operator's secret never appeared in discovery (its unauthenticated register returned 401), and `serve` reused one 24-hour token for heartbeats and signed the pricing listing with the wrong audience. Heartbeats now mint a fresh token per tick; the listing is signed with `market:listing`; a motebit id already bound to a different key on the relay is refused loudly instead of retried. The master token is still honored where it is the operator's own call (WebSocket sync fallback, plan sync, self-test relay auth).
- 7418ae3: Security dependency triage: `hono` ^4.13.5 (query-fragment and `parseBody` nesting fixes); transitive `ws`, `fast-uri`, `qs`, `uuid` patched via upper-bounded overrides. Full ledger with reachability and lift triggers in `docs/security/dependency-triage.md`.
- 3c0d83a: `@motebit/sdk`: outbound URL policy — `checkOutboundUrl`, `assertOutboundUrl`, `fetchPublic`, `isPublicAddress`, `OutboundUrlRefusedError`. The one law for fetching a URL motebit did not author: http(s) only, no credentials, never loopback / private / link-local (cloud metadata) / multicast / reserved / `*.local` / `*.internal`, IPv4-in-IPv6 refused, resolved addresses checked when a resolver is injected, every redirect hop re-checked. Consumed by the web proxy's `/v1/fetch`, the `read_url` tool (and so the read-url and web-search atoms), and the relay's agent-registration, federation-proposal and MCP-forward seams.

  `motebit` (CLI): the local `read_url` tool refuses non-public destinations by default; `MOTEBIT_ALLOW_PRIVATE_URLS=1` is the explicit developer allowance for reading a localhost server.

  The sdk README documents the new surface; the test suite covers the full IANA special-purpose range table, IPv6 parser edges, and redirect method rewriting.
  - @motebit/state-export-client@0.5.25

## 1.13.3

### Patch Changes

- @motebit/state-export-client@0.5.24

## 1.13.2

### Patch Changes

- @motebit/state-export-client@0.5.23

## 1.13.1

### Patch Changes

- 0f098ea: Background tasks no longer borrow a model you didn't choose (#533): the task router's `default` tier now resolves to the current model — the sovereign's choice — in every provider family, instead of the family's workhorse SKU (which silently hopped brain and billing for every routed internal operation, witnessed when the mode row caught the deferred memory-formation pass mid-borrow on sonnet-5 under a sonnet-4-6 session). `strongest` and `fast` keep their family mappings — they express deliberate deviation. Found and diagnosed live by the 1.13.0 observability stack: the mode row surfaced the hop, and the substrate facet's second ask confirmed race-not-leak.

## 1.13.0

### Minor Changes

- 134cd56: The motebit now knows what model it thinks through and what money it moved this turn (#530). Two new `[Now]` facets: `Substrate: <model>` — asked "what model are you running?", it cites the live fact instead of an honest-but-unnecessary "I don't know" (witnessed on motebit.com beside chrome rendering the very answer); and `Settled this turn: <capability> (paid) — done, never re-propose` — a completed hire sits in the model's premises, so denying it or proposing to re-buy it can't survive contact with the ledger (the structural endgame of the amnesiac-middle-manager class, after #521/#522 patched the individual mouths). Both produced by the runtime's execution paths, gate-enforced to travel with their prompt clause and tests.

### Patch Changes

- 1462655: The turn-closing fallback can no longer deny actions it took (#521). Witnessed on the first local-brain paid hire: a silent model made the runtime say "I didn't take any action there" three times — while its own hire sat pending approval, after the approved $0.25 hire completed, and after the human's refusal. The approval path now threads what it did into the continuation loop, and the floor gained honest variants: pending → "that needs your approval — the request is right above"; refused → "you declined `X` — nothing ran"; completed → "`X` completed — the result is above." Floor invariant: no-action is only claimable when no call was emitted.
- 415c33d: A purchased result can no longer vanish when the model fails to relay it (#522). The inline receipt block now ends with a dim pointer (`· full result: /receipt <id>`), and `/receipt` renders the artifact itself — unwrapping JSON envelopes to the report the buyer paid for. And when a paid delegation has already settled this exchange, any subsequent approval band says so ("a paid hire already completed this turn — this proposes another spend"), stamped by the runtime's own count, never model-authored. Both halves witnessed on the first local-brain hire: a $0.25 report reached the human only as a receipt, followed by a redundant re-spend proposal with nothing on the band naming the money that had already moved.
- 9705585: The runtime-host election root now follows the config root (#512): with `MOTEBIT_CONFIG_DIR` set, the coordinator socket and lockfile live inside it instead of always at `~/.motebit/` — a sandboxed or scaffolded instance is a different sovereign and elects its own coordinator, never silently attaching its chat turns to the user's live runtime under the user's identity. The normal case is byte-identical. Unix socket paths past the OS `sun_path` limit (~104 chars) now fail loud at construction naming the repair (a shorter config dir), and the election-failure message distinguishes bind problems (path/permissions/stale socket) from attach problems (incompatible coordinator) instead of blaming the wrong one.

## 1.12.1

### Patch Changes

- 47833a3: The live `/model` catalog now teaches the cross-provider path the offline list always had: a dim footer names each other provider with its restart command and default model (`--provider anthropic (claude-sonnet-4-6) · …`). The live list shows only what the active provider serves — correct, but from inside it the other providers were invisible with no path named.
- 24120c7: `/model` accepts what the local server actually serves: ollama's live catalog returns tagged ids (`llama3.2:latest`) while users — and motebit's own defaults — use bare family names, so `/model qwen3` and `/model llama3.2` were refused as "not served" on a machine that served both (witnessed on the 1.12.0 live pass). Live-catalog membership now normalizes the `:latest` form, and the active-model marker in the `/model` list matches across the same normalization.
- 462754d: The shell-command teach line and the `→ /slash` routing arrow now fold in above the owned bottom region instead of gluing onto the mode row (witnessed live 2026-08-01: `── llama3.2 · local-serverthat's a shell command…`) — REPL-loop output routes through the renderer, never a raw console write while the region is painted.
- b432c98: Below-frontier models now get an imperative first-person voice block in the prompt's dynamic suffix (#519): "You ARE this motebit… your self-knowledge is your own body and history, not a document to summarize," with a wrong/right example. Witnessed on qwen3: asked about itself, it delivered a third-person book report of its own anatomy — strong models inhabit the identity, weaker ones need the register spelled out. Follows mid-session `/model` switches; the cached static prefix stays byte-identical across models.

## 1.12.0

### Minor Changes

- b7a1bef: Capability-tiered tool admission (#501): a minimal-tier model (e.g. a 3B local model) is no longer offered money-moving tools by default — the runtime omits `R4_MONEY`-classified tools from the model-visible list and fail-closes execution, so the witnessed incident class (a weak model fabricating a real-money hire proposal from noise) becomes unrepresentable instead of merely caught by the approval gate. A rail-less `delegate_to_agent` (no wallet bound) stays available — the tool crosses the withholding line exactly when it can move money. Mid-session `/model` switches adjust exposure live. Sovereignty preserved: set `offer_money_tools_to_minimal_models: true` in `~/.motebit/config.json` to restore full exposure; the CLI says what's withheld in one dim line at launch and on `/model` switch, never mid-conversation. User-tap `/invoke` is unaffected (a tap is its own authorizer).

### Patch Changes

- 0475f94: Two rendering nits witnessed in the 1.11.3 live pass. Exit lines no longer glue onto the mode row: `destroyTerminal()` now retires the owned bottom region (flushes the partial line and any in-flight input as history, clears the status/mode rows, parks the cursor on a fresh line) before shutdown output prints. `/receipt` is now usable from its own render: the rendered receipt shows a truncated task id, so the command accepts a unique prefix (a pasted trailing "…" is stripped), lists candidates on an ambiguous prefix, and with no argument re-renders the session's latest receipt.
- 31e6a27: The CLI's model defaults now consume the sdk registry as single source (`defaultModelForProvider` restated literals; a refresh in one place drifted the other), so the local-server first-run default becomes `qwen3` — a 2026 tool-capable model instead of a 2024 3B one. `/model` gains `qwen3` and `gpt-oss` aliases; refusal teach lines name the current default.
- a3f0512: A full CLI invocation typed at the chat prompt (`motebit --provider anthropic`, `motebit seed reveal`) now renders a dim teach line instead of reaching the model (#500) — no human means a shell command as conversation, and the fall-through once let a weak model fabricate an unrelated money intent from exactly this noise (governance held; this closes the affordance gap). The vocabulary is the committed cli-surface baseline the `check-cli-surface` gate keeps honest against the real dispatcher, so the detector can never claim a command the binary doesn't have. Only a known subcommand or `--flag` after the `motebit` prefix triggers; sentences that merely start with the word "motebit", questions, and unknown tokens stay chat. The command is never executed on the user's behalf. Both the coordinator and attached REPLs are covered.

## 1.11.3

### Patch Changes

- e61bd44: The REPL now nudges when a newer motebit is on npm — one dim line in the seed-nudge register (`motebit 1.11.2 available — npm i -g motebit`), because a global npm install never self-updates and the gap was invisible. The registry check is cached for a day and refreshed in the background for the NEXT launch: startup never blocks on the network, offline is silent, and `MOTEBIT_NO_UPDATE_CHECK=1` opts out entirely.
- 0b74b86: An implicit model now follows a persisted `default_provider` flip (found live on the founder's first 1.11.2 launch): the parse-time model default was derived from the parse-time provider, so a config-persisted provider switch left the old provider's default behind — bare `motebit` rendered `local-server · claude-sonnet-4-6`, the exact illegal pairing the admission gate exists to prevent, minted by the fallback path itself. The yield target is now derived through `defaultModelForProvider`, never trusted from residue; an explicit `--model` remains the user's word. Locked by an invariant test: every provider's own default is admissible on that provider.

## 1.11.2

### Patch Changes

- 6586590: Known runtime events now render as designed sentences in the REPL instead of `key=value` dumps (#480): route degrade (`direct payment route unavailable — this task goes through the relay; no onchain payment leaves the wallet`), the volatile grant-spend-store warning, and relay key-pin rotation/mismatch. The compact context form remains the fallback for unknown events — and for a known event whose context doesn't match the shape its sentence was written for.
- 0455cbd: A persistent mode row now sits above the REPL input (#480): `── claude-opus-4-6 · anthropic`, one dim rule line of current-truth chrome. The launch banner stays scrollback history; a `/model` switch updates the row in place, closing the stale-banner tension. The attached REPL shows its own truth (`── attached · coordinator pid N`). No box-drawing frames — the surface reads as an application because its state is legible, not because it is boxed.
- 45a38ad: One vertical rhythm and one indentation grammar for the REPL (#480): a new idempotent `writeGap()` renderer primitive guarantees exactly one blank row at every boundary (receipt blocks, end-of-turn) however many writers ask — the double/triple blank-line class is gone. Indentation now encodes nesting: 2-space records at act level, 4-space detail under a live act (logger lines included). Sub-second tools read `<1s` instead of a suspicious `0s`.
- 426c368: The per-turn `[state: attention=…]` and `[Body]` lines no longer render after every REPL turn (#480). They were operation-level readouts in the product register; the felt-interior unit is the durable mutation, so `[memories: …]` still renders when a memory forms, and the full state vector remains available behind `/state`. Same treatment on the non-streaming path.
- e9b0b3b: A thinking-status row now covers model latency in the REPL (#480, second queued #456 increment): the gap between your Enter and the first token, and between a tool's done-line and the model's next words, shows a calm `· thinking · 3s` pulse instead of a blank `mote>`. Streamed text is its own progress indicator, so the row yields the moment tokens flow. Same treatment on the attached REPL.
- 5f8c8b8: REPL input now wraps across rows instead of h-scrolling behind an ellipsis — the full line stays visible while typing or editing (#480, first queued #456 increment). The input row is one logical row of arbitrary width; clearing and cursor parking both derive from the same reflow math, so repaints, resize, and mid-line edits stay exact at any width.
- 7865d8b: `/model` now lists the ACTIVE provider's live catalog (#475): Anthropic and OpenAI via their models endpoints, local servers via ollama's `/api/tags` (with the OpenAI-compatible `/v1/models` as second shot). The list shown is the list served — a live id outside the static alias table is admissible, and an aliased id the provider no longer serves is refused with the reason. The static table demotes to name resolution plus a clearly marked offline fallback (`offline list — live catalog unavailable (…)`); any fetch failure degrades softly, never blocks the command.
- 6017998: `/model` is no longer provider-blind (#471): the list names each model's provider and dims rows the active provider can't serve; switching to an unservable model refuses with the repair (`claude-opus-5 is a hosted anthropic model — restart with --provider anthropic, or pick a local model`) instead of renaming the model, moving the marker, and persisting a broken default. An admitted switch now persists the provider+model PAIR, so a later bare `motebit` launch restores the provider the model was chosen on. Launch-side admission gains the same CLI strictness — a persisted hosted-vendor id no longer rides onto local-server to 404 at the first message.
- dc3aafb: A conversational hire now ends with its receipt (#493): the runtime emits `delegation_complete` with the worker's signed `full_receipt` on the `delegate_to_agent` path — both routes, including post-approval execution — so the CLI archives and renders the offline-verified receipt block (`/receipt <task-id>` now works for AI-loop hires), the same beat `/invoke` users already had. The streaming layer peeks the receipt stash without draining it, so the parent receipt's `delegation_receipts` chain is untouched.

## 1.11.1

### Patch Changes

- 20a263f: A human "no" to a money approval is now terminal for that tool for the rest of the exchange — however the model rewords the arguments (#470). The exact-args denied-intent ledger deliberately let a reworked proposal ask once more; witnessed live, a weak model reworded a denied paid hire trivially and re-prompted seconds after the refusal. The new exchange-scoped brake suppresses any same-tool approval request until the human's next message (which always releases it — a human-initiated follow-up is never swallowed), renders a calm owner-visible line when it fires, and tells the model to return to the conversation instead of retrying. Per-tool, not global: unrelated approval-gated proposals in the same exchange still prompt.
- 8b03e3e: The `<narration>` tag no longer leaks into visible chat text (witnessed on the first live Opus round: the raw tag rendered above its own dim echo). The narration contract promises the typed `task_step_narration` chunk is the tag's only carrier; the display-strip now keeps that promise, including holding back partially streamed tags.
- 821a754: Requests to the Opus 4.7+/Claude-5 model family are now shaped to what those models accept (#471 sibling, witnessed live: every claude-opus-5 turn 400'd because the CLI's personality default temperature rode every request — Anthropic removed sampling parameters on that family). The provider now omits `temperature` at the request-body build for models that reject it, whatever any caller configured, and extended thinking emits the adaptive shape instead of the removed `budget_tokens` form on the same family. Models that still accept sampling (Opus 4.6, Sonnet 4.5, Haiku 4.5, local models) are untouched.
- d265f06: Claude model ids are now real (#471, first half). `/model opus` pointed at a fabricated id (`claude-opus-4-6-20250414` — Anthropic 404s it) and `sonnet` at the equally fictional `claude-sonnet-4-5-latest`; switching persisted the broken id as the session default. The alias table now carries the current live aliases (`claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5`), and the task router's model tiers — which fed unservable family names like `claude-opus` straight into the provider — resolve to the same real ids. The provider-blind half of #471 (offering models the active provider cannot serve, and persisting an un-admitted default) remains open as designed work.

## 1.11.0

### Minor Changes

- f1b608c: `motebit keychain enroll` — opt-in passphrase enrollment in the macOS login Keychain (the third leg of the recovery arc: "remember a passphrase" stops being a single point of identity loss, with zero operator involvement).

  Once enrolled, commands unlock silently: the resolution chain is `MOTEBIT_PASSPHRASE` → session cache → enrolled keychain (validated against the encrypted key; a stale enrollment falls through to the prompt with a re-enroll hint, never a lockout) → interactive prompt. `motebit keychain` shows status; `motebit keychain remove` undoes it.

  Honest by design: the item is protected by your macOS account, not biometrics (v1 uses `/usr/bin/security` — no native modules, no gyp builds); any process running as your user can read it, which is why enrollment is opt-in and never a default; it does not replace the recovery seed (keychain and disk die with the machine — the seed nudge stays until a backup is acknowledged); and `motebit seed reveal` always asks interactively, enrolled or not. Other platforms report unsupported honestly.

- 73b3d02: Paid-intent interlock: a delegation whose payment settled without delivering a result can never be paid for twice — mechanically, on every path.

  The #433 fix told the model that money already moved; the last line of defense was still the model reading that message correctly, and on the standing-grant auto-execute path there is no human between a retry loop and real money at all. Now a session-scoped ledger, seeded only by verified settled-payment facts, refuses a duplicate hire of the same worker and capability before any broadcast (typed `intent_already_paid`, fail-closed, carrying the prior task and tx), and suspends all new paid delegation once two payments are outstanding. Enforcement lives inside the shared submit chokepoint, so the interactive loop path and the granted deterministic path cannot diverge.

  Also from the standing-grant audit: `executeGrantedDelegation` no longer flattens a paid-but-undelivered hire into a bare failure code (the settled-payment facts now survive into the result and the operator log); `motebit grant show` and `grant list` display lifetime spend and remaining headroom read from the durable spend store; the session-start grant preflight shows headroom before the first spend and refuses arming on an exhausted ceiling; and metering real money against an in-memory spend store now warns that the lifetime ceiling re-arms on restart.

- 5442a55: REPL: bare capability names now invoke the capability, not the AI loop.

  Typing `wallet` (or the shell habit `motebit wallet`) inside the REPL used to route to chat and come back as an essay — actively obscuring a money-critical answer when the user wanted their funded address. New slash commands `/id`, `/wallet`, and `/ledger <goal-id>` invoke the capabilities deterministically (`/wallet` reuses the key the REPL already unlocked — no re-prompt), and exact bare names from a curated read-only set (`wallet`, `id`, `balance`, `ledger <goal-id>`, `help`) resolve to their slash with a dim `→ /wallet` teaching line. The resolver is deliberately narrow: questions and sentences stay chat, and money or mutating commands never route from bare text.

### Patch Changes

- a3298b5: An approval that expires can never end in silence again.

  Approvals wait ten minutes; answering after the timer had voided one used to render nothing at all — an approved irreversible-money action ending with an empty prompt (witnessed live: the human approved, the runtime returned zero output, and only the blockchain could confirm no money moved). Now the expiry announces itself the moment the timer fires, a late answer renders a plain "this approval expired before your answer arrived — nothing was executed; no money moved," and the REPL prints an honest fallback if a resumed approval ever yields nothing. Every approval answer ends in a rendered terminal outcome.

- f13126e: Pending approvals can no longer be voided or resolved by other actors invisibly. A new user turn that sets aside a pending approval now renders the void on both surfaces (typed `approval_voided` chunk + `onApprovalVoided` callback) and is never recorded as a refusal; proactive turns refuse to start instead of voiding human consent; resume/vote hold the single-writer turn lock; and the goals scheduler resolves only the approval it owns (bound by the gate's `tool_call_id`), never whatever happens to be pending.
- 74e6114: CLI rendering: the REPL now owns the bottom of the screen (#456, #455). One renderer discipline (clear region, append scrollback, repaint) replaces print-and-hope: resizing repaints the prompt in place instead of stacking duplicates; in-flight delegation shows a calm status row with the current step narration, elapsed time, and poll-attempt count instead of animated dots; runtime warnings (delegation poll failures above all) flow through the renderer as calm text instead of raw JSON dumped into the input line. Same treatment on the attached REPL and the background goal scheduler.
- fb25e75: Prompt for the identity passphrase once per invocation, not once per unlock.

  `motebit export` prompted four times in a single run — once at the top, then once per relay-auth header minted through `loadActiveSigningKey`'s default getter — which on screen looked like Enter not registering (the prompt line "duplicating" after every submit). `delegate` could reach six prompts, `market` five.

  The passphrase is now cached in process memory for the life of the invocation, seeded only at proof points: a successful AES-GCM decrypt of the identity key, or the encrypt call that sets the passphrase. An unverified prompt never seeds it, `MOTEBIT_PASSPHRASE` still takes precedence, nothing is persisted, and the decrypted key is still securely erased after each use. A cached value that stops decrypting (key replaced mid-process) self-heals by clearing and re-prompting. The relay key passphrase is a different secret on a different path and is unaffected.

- 083867e: README fleet audit: correct every published-package README against the shipped bytes.

  Highlights: the CLI README now documents the recovery arc (`motebit restore`, `motebit seed`), the `grant` standing-delegation family, `id`/`wallet`, and the `--sovereign`/`--pay-new-agents` delegate flags; `@motebit/state-export-client` fixes a wrong first parameter on `verifyManifestAgainstBytes` (raw header string, not a parsed manifest); `create-motebit`'s agent quick start adds the required `MOTEBIT_PASSPHRASE`; `@motebit/crypto-appattest` fixes a non-JCS canonical-body example that produced the wrong digest when reproduced; `@motebit/crypto` drops a function removed at 3.0.0 and documents the hardware-attestation leaf family; `@motebit/protocol`'s example now typechecks; false zero-dependency claims corrected (sdk, verifier); `@motebit/verifier` is consistently described as library-only with `@motebit/verify` as the CLI; all relative repo links replaced with absolute URLs that survive npm rendering.

  An adversarial review pass then corrected two overstated scoring claims (android-keystore StrongBox, webauthn attestation_kind — both fields are surfaced but informational today), a wrong flag name (`skills audit --event-type`, also fixed in the CLI's own usage string), and an under-documented `deviceCheckContext` parameter on `verifyHardwareAttestationClaim`.

- ccf319a: Consent describes what actually happens: the money-approval band now states that the payment route is late-bound (if peer payment is unavailable, the task reroutes through the relay with no wallet payment), the route switch renders and is stated in the delegation result when it occurs, and the relay-mode settlement note no longer overclaims a payment. Also: attached surfaces render approval expiry/void outcomes, and the goals daemon contains drain errors instead of leaking unhandled rejections.
- 48c1ee5: Three sibling fixes around the identity snapshot and its refresh path. `motebit export` no longer corrupts passphrase input (the masked prompt detaches the caller's readline for the duration of the read — a paused terminal readline kept echoing and consuming keystrokes, so the correct passphrase read as incorrect), and its wrong-passphrase message now names the real remedies (unlimited offline attempts; `motebit restore` resets a forgotten passphrase) instead of advising deletion of the config that holds your key and funds. Export also refreshes `~/.motebit/motebit.md` in place, so the snapshot can no longer silently diverge from the live identity after a key change; `motebit doctor` flags any remaining divergence with an advisory warning — the live key is `config.device_public_key`, never the .md, which is a portable snapshot.
  (The on-disk surface baseline records the refreshed `~/.motebit/motebit.md` path.)
- Updated dependencies [083867e]
  - @motebit/state-export-client@0.5.22

## 1.10.0

### Minor Changes

- 08e86f6: The self-recovery door is now lit before loss, not found missing at loss time. New `motebit restore [motebit.md]` recovers an identity from its recovery seed — full-bundle restore with a motebit.md (works for legacy ids), seed-only restore that re-derives a sovereign id, and a third case discovered live: when the seed matches the key already on this machine, the flow is a plain passphrase reset with nothing replaced and no confirmation theater. Replacing a different resident identity requires both the cryptographic key-match and typing `REPLACE IDENTITY`, per the identity-restore doctrine's cross-surface invariants. New `motebit seed` shows backup status with identity-type-honest copy (a sovereign id re-derives from its seed alone; a legacy id rides only in motebit.md — back up both), and `motebit seed reveal` prints the seed once, passphrase-gated, recording the backup acknowledgment only after an explicit confirm. `motebit doctor` gains an advisory `warn` tier and reports seed-backup posture without failing readiness; the REPL shows a single dim reminder line until a backup is confirmed. The README's "no consumer key recovery" paragraph now pairs the sovereignty fact with the self-recovery story instead of reading as abandonment. (Internally, `deriveSovereignMotebitId` joins @motebit/encryption's product-layer re-exports so app surfaces never reach the Layer-0 floor.)

### Patch Changes

- da58e84: The approval prompt now names the stakes. A money action renders a distinct `⚠ MONEY · IRREVERSIBLE` band, states that it pays from your sovereign wallet, and shows either the `--budget` ceiling or an honest "amount set by the worker's listing at hire time" — never a fabricated figure, since a delegation's price is late-bound. The action itself reads in human language ("Hire an agent on the motebit network to: …") instead of raw tool JSON, and the context renders as output with a single-line prompt, which also fixes the block duplicating on screen as you typed your answer. Delegation progress now animates on the post-approval execution path, which previously rendered nothing at all while a paid task ran.
- 8ca1c01: Fix npm README drift and complete the `--help` provider list. The README claimed 19 open specs (actual: 34), listed only 2 of the 7 supported providers, referenced `spec/skills-v1.md` as bare text that resolves to nothing on npmjs.com, and described the package as a "binary". The `--help` Providers section now documents `groq` and `deepseek`, which were fully wired but undocumented. The README's Providers table now leads with the provider-neutrality framing: a motebit's identity, memory, and trust persist independently of its model provider.
- 0676954: Money-safety and human-veto integrity for paid delegation. A human "no" on an approval is now terminal: the model is told the refusal is a decision (not a retryable failure), and a re-proposal of the same tool + arguments is never shown to the human again. A paid delegation whose result could not be retrieved now reports `PAYMENT_ALREADY_SETTLED` with the amount, tx hash, and task id — so an autonomous caller cannot mistake a delivery failure for a failed hire and broadcast a second payment for work already bought.
- f3f11ab: Bump the CLI's LSP transport deps: `vscode-jsonrpc` 8 → 9, `vscode-languageserver`
  9 → 10 (tracks LSP protocol 3.18). Only import change: v10 renamed the Node
  subpath `vscode-languageserver/node.js` → `vscode-languageserver/node`. All LSP
  tests pass unchanged. Also drops a stale `zod-to-json-schema` mention left over
  from the zod-4 migration.
- 5b9ca67: Add `mintAudienceToken` — the canonical mint seam for audience-bound auth tokens — and sweep every monorepo mint site through it (drift gate `check-token-mint-canonical`, invariant #147).

  `createSignedToken` deliberately fills no defaults, so every call site restated `iat` / `exp` / `jti` / TTL — 23 sites across 17 files as of 2026-07-23, grown from ~9 a month earlier. Each restatement is a place for the freshness window or replay nonce to silently drift: the identity→authz instance of the shadow-the-constant class named in `docs/doctrine/composition-preserves-enforcement.md` (reduce the seams where enforcement can disappear). The helper owns the assembly (`iat` = now, `exp` = `iat + ttlMs` defaulting to `DEFAULT_SIGNED_TOKEN_TTL_MS`, `jti` from the platform CSPRNG with a fail-closed no-CSPRNG error) and returns `{ token, payload }` so sites that surface expiry read `payload.exp` instead of re-deriving it. Injected-clock callers (relay-client's token cache, runtime-host's attach handshake) pass `nowMs` — the adapter-pattern clock idiom, not a freshness bypass.

  The sweep covers CLI, web, mobile, desktop, spatial, planner, molecule-runner, mcp-client, relay-client, runtime-host, and the relay's browser-sandbox minter; planner's injected `SovereignDelegationConfig.createSignedToken` field became `mintAudienceToken` (mint-shaped) so the seam covers injected minters too. `createSignedToken` stays public API — adversarial test fixtures need exact payload control — but non-test monorepo source minting through it now fails CI. Inventory: 146 → 147 invariants, 134 → 135 hard CI gates.

- a5aba85: Wrong-passphrase handling no longer leads with a destructive remedy. The prompt now retries a few times within one run (offline, no lockout), and on giving up it warns — instead of instructing `rm ~/.motebit/config.json`, which erases the identity key and any wallet funds it controls — that attempts are unlimited and offline, and that deletion is irreversible without a recovery seed. A non-interactive session (`MOTEBIT_PASSPHRASE`) still gets a single attempt.
- ea9b19d: `motebit delegate --sovereign` now works without `--plan`: the plain delegate path pays the worker directly from the sovereign Solana wallet via a single-step paid P2P delegation (discovery or `--target`, cold-start via `--pay-new-agents`, honest `Paid:` settlement line). Previously the flag was silently ignored — the command fell through to relay-custody, hit the empty virtual account, and misdirected a funded sovereign user to `motebit fund`. Every missing prerequisite now refuses loudly with its remedy, and nothing falls back to relay-custody. `--budget` is enforced as a hard pre-broadcast ceiling over the entire resolved payment (worker + all fee legs) — an over-budget resolution fails `budget_exceeded` with no money moved. (`@motebit/protocol` becomes a declared CLI dependency — previously reached only transitively.)
- 974473a: Bump `stripe` SDK 17 → 22. The runtime API version stays pinned at
  `2025-03-31.basil` (unchanged); the bump aligns the SDK's TypeScript types with
  that pinned version, which surfaced two field-location fixes on the relay money
  path (see PR for the latent-bug detail): `invoice.subscription` →
  `invoice.parent.subscription_details.subscription`, and subscription
  `current_period_end` → `items.data[0].current_period_end`.
- 84fad0f: Internal cleanup: remove no-op type assertions flagged by typescript-eslint 8.65 (`no-unnecessary-type-assertion`), monorepo-wide. Type-level only — no runtime or API change. Where an assertion was masking a real hazard (`no-base-to-string` on unknown payload fields), the site now narrows with a typeof guard instead.
- d056c67: Migrate to zod 4 (`^4.4.3`) across the four zod-using packages (`@motebit/wire-schemas`, `@motebit/mcp-server`, `@motebit/relay-client`, and the `motebit` CLI).

  The user-visible surface is internal: the CLI's YAML-config validation, its `motebit-yaml-v1.json` schema (now generated by native `z.toJSONSchema` with `io: "input"`), its LSP `schema-walker` (updated for zod 4's introspection API — `ZodEffects` → `ZodPipe`, the `.description` getter), and `verify-wire`'s zod-error formatting (zod 4 issue paths are `PropertyKey[]`) all run on zod 4.

  The substantive work is in `@motebit/wire-schemas` (private): its committed `spec/schemas/*-v1.json` are now generated by zod 4's native `z.toJSONSchema` (`src/assemble.ts`), replacing `zod-to-json-schema@3` — which is zod-3-only and, under zod 4, silently emits empty schemas. All 85 published schemas were regenerated in place as v1: verified a validation-preserving reformat (nullable `type:[X,null]` → `anyOf`, `additionalProperties: true` → `{}`, discriminated-union `anyOf` → `oneOf`) with **zero value-constraints lost and 151 gained** (native captures `.min`/`.max` bounds the old tool dropped, so the published schemas are strictly more faithful to the runtime zod validation).
  - @motebit/state-export-client@0.5.21

## 1.9.0

### Minor Changes

- 7d0476b: As-of memory recall — the `recall_memories` tool gains an optional `as_of` (ISO date) parameter to reconstruct what the agent believed at a past point in time.

  Bi-temporal recall was already in the memory graph but unreachable by the agent. Passing `as_of` now filters memories to those valid `[valid_from, valid_until)` around that instant, and the result is framed as a historical snapshot (superseded beliefs are reported as past belief, never current fact). Omitting `as_of` is unchanged current recall. An unparseable date is a hard error rather than a silent fall-back to current recall.

- 319ff57: History memory recall — the `recall_memories` tool gains an optional `include_history` flag to return every version of a belief at once (current and since-superseded), each labelled.

  Completes the bi-temporal recall surface alongside `as_of`. Where `as_of` gives a point-in-time snapshot, `include_history` returns all versions with a per-entry `[current]` / `[superseded <date>]` label so a revised belief can never be read as current fact; the two modes are mutually exclusive. Also corrects the `rewrite_memory` tool description: a superseded memory is no longer described as "tombstoned" — it is kept and reconstructable via `as_of` / `include_history`, matching the actual (non-destructive) supersede behavior.

### Patch Changes

- @motebit/state-export-client@0.5.20

## 1.8.3

### Patch Changes

- @motebit/state-export-client@0.5.19

## 1.8.2

### Patch Changes

- @motebit/state-export-client@0.5.18

## 1.8.1

### Patch Changes

- 70579a2: CLI credential reads (`motebit credentials`, `motebit export`) now send the least-privilege `credentials` / `credentials:present` audience tokens the relay requires for the newly owner-private credential + presentation routes.
  - @motebit/state-export-client@0.5.17

## 1.8.0

### Minor Changes

- e651f19: `AuthorityDelta` — every refusal a typed, owner-facing repair instruction. The protocol gains the closed residual type (missing scope, required-vs-posture risk, requires-verified-grant, spend overage in micro, window unlock time, quorum shortfall, terminal states) with two load-bearing invariants documented on the type: ASYMMETRY (owner surfaces get precision; model-visible channels carry only the coarse reason — a precise residual is a boundary oracle aimed at the one party who can mint the difference) and PREDICTOR-NEVER-AUTHORITY (the delta describes refusals; the gate and meter remain the sole enforcers). `PolicyDecision.missing_authority` extends additively. The policy gate populates it at every deny/raise site from a single producer module; the blast-radius evaluator emits exact spend overages and window-unlock times; the ai-core tool_status stream chunk (surface channel) carries it while the conversation-history push stays coarse — pinned by a leak test over every context pack the model receives; the CLI renders the exact repair owner-side. Constructors, not an algebra: composition helpers wait for a third consumer needing to compose authorities, per rule-of-three.
- 49bb515: Grant pre-flight — the refusal that teaches, applied to the product. `motebit --grant <id>` now walks the entire authorization chain the first money turn will need (grant artifact → due tick → governance posture → payment rail → relay pin → working capital) and prints either one calm armed-line or each blocker with its exact remedy — the gate-repair-instructions contract extended from CI to the sovereign user. Born from the first-metered-dollar ceremony (2026-07-06/07), where five correct-but-silent boundary refusals cost a night of debugging that a launch-time verdict would have collapsed into minutes. Advisory only: the verifier, gate, and meter remain the authorities — the pre-flight predicts, the boundary decides.
- f02f63f: `motebit verify-release` — the self-signing body, self-verifying. Hashes the RUNNING bundle's own bytes and checks them against the relay's signed release witness (`/.well-known/motebit-releases.json` — the operator's signed observation of the npm registry: tarball integrity + per-file bundle hashes, in the same envelope and via the same canonical verifier as the transparency declaration, under the same key pinned at `motebit register`). Closes the one unverifiable claim the bundled-CLI distribution model leaves open: that the artifact npm delivered is the artifact the operator published. Read-only, passphrase-free by design (a binary asking you to unlock your identity to "verify itself" would be the attack). Stated honestly: this proves the operator's word about the artifact, not a reproducible build — that rung is a later arc.
- 2c04e6c: `motebit wallet swap <sol-amount>` — owner-invoked SOL → USDC normalization (wallet homeostasis, funding side; born from the first live funding: the founder sent SOL expecting the wallet to normalize). A deterministic affordance: the owner's passphrase is the authorization; the Jupiter adapter enforces a fail-closed gas floor (0.005 SOL — the wallet never metabolizes its last fuel) with the refusal naming the max swappable amount. `motebit wallet` now teaches its own funding posture (USDC on the SOLANA network; SOL is auto-managed gas). Autonomous posture normalization stays deferred-with-trigger — it would ride the standing-grant meter like any autonomous money.
- 186eaa5: The last seam of the first-metered-dollar path: the CLI now wires the sovereign Solana rail and the PINNED relay key into the runtime. (1) `createRuntime` accepts and threads `solanaWallet`; the REPL constructs the rail from the decrypted identity seed — its presence is what makes `delegate_to_agent` a real money tool (R4 hint, late-bound metering, wrapped P2P payment builder). (2) `motebit register` pins the relay operator's public key trust-on-first-use from the SIGNED transparency declaration, verified via the canonical `@motebit/state-export-client` verifier; a later mismatch fails loud (a relay that changes identity is never silently re-trusted); fetch failure warns without failing registration. (3) The REPL threads the pinned key into the delegation config — the treasury address derives FROM the pin, never from a fetched response at payment time. Discovered live 2026-07-07: every layer of the metering stack was sound and unreachable — delegation registered as R2 (no rail ⇒ no R4 hint), and relay-mode paid delegation 402'd in a retry loop.

### Patch Changes

- 4ea830f: Typed `quit`/`exit` now exits the process explicitly, mirroring the Ctrl+C path. Previously "Goodbye!" printed but the process survived on any live handle (the sovereign rail's RPC connection, an MCP socket), leaving a zombie REPL holding the terminal.
  - @motebit/state-export-client@0.5.16

## 1.7.0

### Minor Changes

- 335574d: `motebit grant` (money-execution Inc 4) — mint, inspect, and revoke standing-delegation grants from the CLI. `grant create --scope … --subject … --lifetime-usd …` signs a `StandingDelegation` whose `spend_ceiling` (standing-delegation@1.2) is the delegator's cryptographic commitment, plus the v1.0 PRE-MINTED tick schedule (one future-dated `not_before`-gated 1h `DelegationToken` per cadence slot — the signed token set IS the cadence). Money-grant shape enforced at mint: lifetime ceiling required, ≤30-day life (spec §6 D4). Artifacts stored verbatim at `~/.motebit/grants/<grant_id>.json` (files, out of the sync surface). `grant revoke` signs the terminal `DelegationRevocation` and best-effort propagates it to the relay cache; offline revocation still bites locally. `motebit --grant <id>` presents the due tick per REPL turn via the runtime's in-process `delegation` option — no due tick means an honestly grantless turn.

### Patch Changes

- 74d2f67: The REPL delegate flow (submit → poll) and `/balance` now ride `@motebit/relay-client`, the typed relay transport. This fixes two live defects in the hand-rolled path: task submission previously sent no `Idempotency-Key` (the relay unconditionally rejects submission without one, HTTP 400), and the poll leg replayed the `task:submit`-audience token against the task-query route (audience mismatch → 403, silently swallowed by the poll loop until a 60s timeout for device-token users). The typed client mints the correct registry audience per leg and requires the idempotency key at the type level. Auth is unchanged: master token preferred, signed device token fallback, bridged through the sdk `CredentialSource` contract.
- 74d2f67: Type-safety only, no behavior change: every audience parameter on the CLI's token-minting seams (`getRelayAuthHeaders`, delegate/daemon/self-test mint closures, x402 smoke helper) narrows from `string` to the closed `TokenAudience` registry union re-exported by `@motebit/sdk`. A typo'd or unregistered audience at any CLI signing site is now a compile error instead of a runtime 401. All previously minted values are registry members (including the newly registered `market:query`), so minted tokens are byte-identical.

## 1.6.1

### Patch Changes

- 4110ea9: Internal lint cleanup in the CLI — no behavior change. Two
  `@typescript-eslint/strict-boolean-expressions` sites made explicit:
  `slash-commands.ts` (`!match` → `match == null` on a nullable enum lookup) and
  `subcommands/discover.ts` (`capabilities?.length` → `capabilities != null &&
capabilities.length > 0`, keeping a zero-length list correctly falsy). Part of a
  repo-wide pass that cleared all 59 pre-existing ESLint warnings; the rest landed
  in private packages and don't carry a version.

## 1.6.0

### Minor Changes

- cb8ab21: A coordinator daemon now serves its interior to attached frontends — attach-mode parity (daemon-desktop unification, increment 6). The runtime-host protocol (v2) gains two typed frame pairs: `query` reads records (memory export, events, audit rows, trusted agents, state, gradient) and `act` performs the narrow set of typed panel affordances (delete/pin memory, set petname, set session sensitivity) — records vs acts stays typed end-to-end, and the closed kind registries live with the runtime, which refuses unknown kinds and malformed params fail-closed. An attached desktop's panels render the daemon's real interior, its mutation buttons act through the daemon's own choke points (memory deletion still emits the signed certificate), and its data export produces the full bundle over the wire.

  Money-shaped acts are structurally absent from the act registry — R4 stays behind the policy gate and verified standing grants, never behind a panel button on a renderer. Protocol v1↔v2 skew refuses honestly with both versions named.

- 063b4a2: `motebit serve` alongside a running coordinator now attaches instead of refusing — an MCP frontend over the coordinator's interior (daemon-desktop unification, attach-mode parity). Tools are listed pre-filtered by the coordinator's policy gate and execution is re-validated coordinator-side regardless of the frontend's pre-flight; memory writes run the coordinator's governance with `peer_agent` provenance; the synthetic chat tool rides the chat frame. An attached serve opens no database handle, registers nothing with the relay, and runs no worker mode — `motebit_task` is absent because signing authority never proxies over the socket; the coordinator stays the machine's one authority and its one relay presence.

  Desktop slash commands gain the same parity: an attached window's `/state`, `/memories`, `/gradient`, and the rest of the shared command layer execute on the coordinator (validated against the command registry), and `/sensitivity` reads and sets the coordinator's live gate — the tier you see is the tier that actually gates.

### Patch Changes

- 05d1242: Self-test probe gates its completion poll on whether the agent is serving. The shared `cmdSelfTest` submits a self-delegation task; device auth and the sybil defenses are proven the moment it submits and returns a `task_id`. The 30-second completion poll is a secondary "live network participant" check that can only resolve when a worker executes the task, so `cmdSelfTest` now takes a `serving` flag (default false) and returns a terminal `auth_verified` status on non-serving surfaces instead of polling to a guaranteed timeout. The CLI daemon's `--self-test` runs inside its serving registration, so it passes `serving: true` and its behavior is unchanged — it still polls for execution.

## 1.5.0

### Minor Changes

- 5b1103e: Remote command ingress is now fail-closed (daemon-desktop unification, increment 4). `command_request` — previously an unsigned relay-forwarded message every surface trusted implicitly — requires a `signed-request-envelope@1.0` signed by the agent's own identity, audience-bound to the target (`agent-command/{motebit_id}`, registered in the spec's audience-convention table) and digest-bound to the exact `{command, args}` payload.

  `@motebit/crypto` gains the convention helpers: `signAgentCommandEnvelope`, `verifyAgentCommandEnvelope` (verdict-shaped, honest rejection reasons), `agentCommandAudience`, `agentCommandPayload`. The relay verifies at ingress against the registered identity key as defense in depth and forwards the envelope verbatim; every consuming surface (CLI daemon, `motebit serve`, desktop, mobile, web, spatial) re-verifies fail-closed before executing — the relay remains a convenience layer, never the trust root.

  Breaking only for unsigned senders, of which there are none advertised: the `/command` route was `@internal` with no production callers, so this flip carries no migration window. This closes the product-posture precondition for ever advertising remote-trigger.

- 73e0666: A coordinator daemon can now drive an attached desktop's computer — bridged organs surface as policy-gated tools (daemon-desktop unification, the capability-bridging consumer step). When a desktop attaches to a running `motebit run` / `motebit serve` coordinator, its contributed `computer_use` organ registers in the coordinator's tool registry as the canonical `computer` tool — same definition, same `desktop_drive` embodiment stamp, and the same policy gate as a local registration; risk is declared, never inferred. Tools appear when the contributing frontend attaches and are removed the moment it disconnects, and a disconnect mid-action fails honestly with the reason — never a silent retry across the authority boundary.

  The Secure-Enclave attestation organ is deliberately not exposed to the AI loop: hardware-attestation minting is a user-initiated identity affordance, and wiring it as a model-chosen tool is refused at startup, fail-closed.

- 6105070: One coordinator runtime per machine — the CLI adopts the runtime-host election (daemon-desktop unification, increment 2). Every entry point elects before constructing a runtime: the first motebit process binds `~/.motebit/runtime.sock` and coordinates; the rest attach or refuse honestly.
  - `motebit run` and `motebit serve` are coordinator-role: a second start no longer silently runs a parallel authority over the same identity key and database — it exits naming the live coordinator's pid. This is the single-instance enforcement the unification doctrine called for.
  - The bare `motebit` REPL attaches as a rendering frontend when a coordinator (for example a running daemon) is live: chat, `/invoke`, and approval votes proxy over the local socket with a device-key-signed `runtime:attach` handshake. The coordinator acts; the terminal renders. `/exit` leaves the coordinator running.
  - Authority cannot be asserted over the socket: wire-supplied options are narrowed to a rendering-safe subset before reaching the runtime — grant and attestation fields are stripped at the boundary.

  No flags, no migration: with no coordinator running, every command behaves exactly as before (and now also serves the socket for later frontends).

### Patch Changes

- f2fabf3: Internal: the runtime-host wire→runtime authority-field strip (`verifiedGrant` / `userActionAttestation` / `goalContext` never forwarded from an attached frontend) moved from CLI-local code into `@motebit/runtime-host` (`pickSafeChatOptions` / `pickSafeInvokeOptions`) so the desktop coordinator applies the identical guard. No behavior change at the CLI surface.
- eef8729: `motebit delegate --plan` now runs the runtime-host election before touching shared state (daemon-desktop unification follow-up — closes the "one-shot subcommands" residual). The plan run constructs a transient runtime over the shared `~/.motebit` database and, in sovereign mode, signs with the identity key — a full authority while it lives, however briefly. It is now coordinator-role for its lifetime: it binds `~/.motebit/runtime.sock` before opening the database and releases the bind when the plan completes, or refuses honestly — naming the live coordinator's pid — when another motebit process already coordinates the machine. A delegate run can no longer race a running daemon as a second signing authority over the same key and database.

  With no coordinator running, `motebit delegate` behaves exactly as before.

## 1.4.4

### Patch Changes

- 614f5fd: Memory provenance threading (`docs/doctrine/memory-provenance.md`): every memory-formation call site now declares a `MemorySource`, enforced at compile time by `AttributedMemoryCandidate`. In the CLI: the daemon's MCP `storeMemory` wiring stamps the literal `peer_agent` after governance (an external caller can never self-declare a trusted provenance tier), and the scheduler's plan-reflection learnings + goal-outcome memories stamp `agent_inferred`. New `memory_nodes.source` / `source_turn_id` columns land via persistence migration v40; legacy rows read back as provenance `unknown` — never a fabricated default.

## 1.4.3

### Patch Changes

- e584b76: Remove the dead internal `isPlanEmpty` helper from the `up` subcommand — it was exported but had zero callers (not a CLI command or public API). No behavior change.
- d9a9476: Remove the unused `listArchivedReceipts` helper — it listed an in-memory per-REPL session archive (not a durable store) and had zero callers; the by-id `getArchivedReceipt` (used within a single `invoke` run) stays. No behavior change.

## 1.4.2

### Patch Changes

- d789bc9: Add `--pay-new-agents`, the CLI's paid-P2P cold-start opt-in — surface parity with the web/desktop/mobile "Pay new agents directly" toggle.

  The cold-start acknowledgment (`acknowledgeNoHistoryRisk`) was wired only on web. On the CLI, `enableInteractiveDelegation` / `enableInvokeCapability` omitted it, so the runtime's auto-bound sovereign P2P path was a no-op for a first paid delegation to a worker with no trust history — it silently degraded to relay-mode with no operator control. The new flag forwards the ack into both delegation entry points (`apps/cli/src/index.ts` chat + invoke paths, `apps/cli/src/subcommands/delegate.ts`).

  Process-lifetime config, so a plain boolean — no live getter (unlike the web/desktop localStorage and mobile in-memory-mirror getters that let an interactive toggle take effect without a re-enable). Default OFF (sovereign fail-closed): without `--pay-new-agents`, a paid delegation to an unknown worker still settles through the relay ledger. Use `motebit run --pay-new-agents` (or `delegate`) to allow direct peer-to-peer payment of new agents from the sovereign wallet.

- 882b392: Upgrade the test runner from vitest 2.1.9 to 4.1.8 (with @vitest/coverage-v8), closing critical advisory GHSA-5xrq-8626-4rwp (Vitest UI server arbitrary file read/execute, fixed in 4.1.0). This is a dev-dependency change only — no runtime, API, or wire-format change to any published package; the bump is recorded as a patch because each package's published `package.json` devDependencies move to vitest ^4.1.8.

  vitest 4 bundles vite (^6 || ^7 || ^8), so the existing vite-^6 surfaces, jsdom 25, and @types/node ^22 are unchanged. Test-only migration fallout was handled in the same change: `ViteUserConfig` rename in the shared config, typed-mock assignability under v4 (`vi.fn()` now `Mock<Procedure|Constructable>`), constructor mocks converted from arrows to `function` (v4 disallows `new` on arrow mock implementations), the removed `environmentMatchGlobs` replaced by the per-file `@vitest-environment` directive, and an explicit `dist/` test-exclude restored for the one config-less package (vitest 4's default `exclude` no longer covers `dist/`).

## 1.4.1

### Patch Changes

- c61fa51: Route the CLI's micro→USDC display conversion through the canonical `fromMicro` (re-exported by `@motebit/sdk`) instead of an inline `/ 1_000_000` in `wallet` and `migrate`. Value-identical (`fromMicro` is `micro / MICRO`), display-only — the ledger is unchanged — but it makes the converter the single audit point for unit conversion. Imported via `@motebit/sdk` (apps consume the product vocabulary, not `@motebit/protocol` directly — `check-app-primitives`).
- d9a24c0: The CLI receipt view now distinguishes signature integrity from identity binding. It previously fed each receipt's own embedded `public_key` into chain verification as if it were a trusted key, then printed "verified locally · chain intact" — a binding claim it could not back (a forged receipt embedding its own key rendered as verified).

  `renderReceipt` now verifies against an optional `trustedAnchor` (the embedded fallback still checks signatures with no anchor) and prints one of three honest states: "verified locally · chain intact" only when every node in the chain resolved its key from the trusted anchor; "signature verified · identity not anchored" when the signature is valid but checked against the receipt's own embedded key; and "verification failed" otherwise. Mirrors the render-engine receipt card's binding-aware display.

## 1.4.0

### Minor Changes

- 1570cf9: Activity + Retention panels land on desktop and mobile — the sovereignty-visible pair (signed-action timeline + browser-verified operator retention manifest) is now true on every shipping surface. Web shipped at `eb10bac6` / `ac622b64`; desktop and mobile mount the same `@motebit/panels` controllers against their own runtime accessors, with surface-specific render. The cross-surface contract is locked by drift gate `check-panel-controllers` (#33), which now enumerates `activity` and `retention` as additional families alongside `sovereign` / `agents` / `memory` / `goals` — any future surface that ships the panel UI but bypasses the controller fails CI.

  Desktop: `apps/desktop/src/ui/activity.ts`, HTML markup + inline CSS, `/activity` slash command, escape-key wiring.

  Mobile: `apps/mobile/src/components/ActivityPanel.tsx`, RN Modal + FlatList + chip filter row, `/activity` slash command.

  Both surfaces refresh on every panel open: re-fetches `/.well-known/motebit-{transparency,retention}.json`, runs the same hex-pubkey decode + verifier-dispatch flow as web, renders the verification status badge + per-tier retention table above the audit timeline. Operator promise above, signed-action log below — same calm-software pattern, three surfaces, one controller pair.

  ```ts
  // Same shape on every surface — surfaces wire the adapter:
  const activityCtrl = createActivityController({
    queryAudit: ({ limit }) => runtime.auditLog.query(motebitId, { limit }),
    queryEvents: ({ eventTypes, limit }) =>
      runtime.events.query({
        motebit_id: motebitId,
        event_types: eventTypes as EventType[],
        limit,
      }),
  });
  const retentionCtrl = createRetentionController({
    fetchTransparency: () => fetchJson("/.well-known/motebit-transparency.json"),
    fetchRetentionManifest: () => fetchJson("/.well-known/motebit-retention.json"),
    verifyManifest: async (m, k) => verifyRetentionManifest(m, hexToBytes(k)),
  });
  ```

  Surface gap that remains: skill-audit log (web IDB / mobile SQLite / CLI fs) is rendered only by `motebit skills audit` today — the Activity panel doesn't merge it yet. The `ActivityKind` union has `consent` / `trust` / `skill` slots reserved for it; adding a third source to the controller's adapter is the natural follow-up.

- eb10bac: Activity panel — sovereignty-visible read view. The deletion choke-point shipped in `d5e66e34` made every user-driven memory and conversation deletion signed, audited, and event-logged with `DeleteRequested` — but the receipts were invisible. The audit log accumulated `delete_memory` / `delete_conversation` / `flush_record` rows, the event log accumulated `DeleteRequested` and `ExportRequested` intents, and no surface rendered them. This commit closes the visibility half of the sovereignty arc.

  Cross-surface controller in `@motebit/panels` (`createActivityController`, `filterActivityView`, `ActivityEvent`, `ActivityKind`) — same Layer 5 BSL pattern as memory/skills/goals/sovereign. Two-source merge (audit log + event log), kind classification, deterministic sort, search + chip filters. Web is the first consumer: `/activity` URL route + `motebit:open-activity` event + slash-command + escape-key wiring. Mobile and desktop will mount the same controller against their own runtime accessors as a follow-up — the panels CLAUDE.md drift-gate idiom ("the second consumer is when the gate lands") applies.

  ```ts
  const ctrl = createActivityController({
    queryAudit: ({ limit }) => runtime.auditLog.query(motebitId, { limit }),
    queryEvents: ({ eventTypes, limit }) =>
      runtime.events.query({
        motebit_id: motebitId,
        event_types: eventTypes as EventType[],
        limit,
      }),
  });
  await ctrl.refresh();
  ctrl.toggleKind("deletion"); // chip filter
  ctrl.setSearch("conversation"); // substring on action / target
  const view = ctrl.filteredView(); // most-recent-first, deterministic ties
  ```

  15 controller tests covering projection (audit + event), classification, signature surfacing, default noise filter (`list_memories` / `inspect_memory` hidden), tombstone exclusion, sort + tiebreak, kind toggle, search, error paths, subscribe lifecycle.

- 81b0f56: Add `motebit skills audit [skill-name] [--event-type=…] [--limit=N] [--json]` — first read-side consumer of the durable skill audit trail. Reads `~/.motebit/skills/audit.log` (the line-delimited JSON stream emitted by `registry.trust` / `registry.untrust` / `registry.remove` and the panels-side `RegistryBackedSkillsPanelAdapter`'s `skill_consent_granted` events), filters + formats + prints. Most-recent-first ordering matches the panels-side `getAll()` convention on web (IDB) and mobile (SQLite).

  Closes the doctrine gap shipped by the consent-audit arc — the protocol type and durable persistence existed, but no surface answered "did I approve installing this medical skill?" without grepping the log file directly. `motebit skills audit` answers it. Operator-grade UI; per-skill timeline / federation-dispute flows are deferred until those consumers arrive.

  Adds `--event-type` flag (string) for filtering by `SkillAuditEvent` discriminator (`skill_trust_grant` / `skill_trust_revoke` / `skill_remove` / `skill_consent_granted`). Additive to the existing `--limit` and `--json` flags.

- 0e191ce: Add `/trust` slash command to the CLI's command registry.

  Surfaces the canonical 5-dimension trust-accumulation summary (memories + conversations + signed receipts + signed deletions + federation peers) computed by `cmdTrust` in `@motebit/runtime`. The same command was already registered on web, desktop, and mobile this session; the CLI registration closes the four-surface contract that `check-trust-slash-cross-surface` (drift-defense #82, landing this commit) locks in.

  Doctrine: `docs/doctrine/runtime-invariants-over-prompt-rules.md` § trust-accumulation visibility arc.

- 5ef2cac: Add `/welcome` onboarding slash command — Phase 1 of the onboarding arc.

  A calm one-message tour that names the three thesis pillars (persistent sovereign identity, accumulated trust, governance at the boundary) and points to universal slash commands every surface ships (`/trust`, `/memories`, `/forget`, `/help`). The thesis is now visible at multiple surfaces but discoverable only by typing slash commands the user doesn't yet know exist; `/welcome` is the forcing function that makes the architecture's accumulated state legible at first encounter rather than only on the third slash command the user thinks to type.

  `cmdWelcome` lives in `@motebit/runtime`'s shared command dispatcher, so the same tour fires on web/desktop/mobile/CLI. Surface-specific suggestions (`/cookies` on web, `/computer` on web+desktop) can be layered by each surface's slash handler as overlay — same pattern `/trust` uses for the web cookies dimension.

  Phase 2 (deferred): auto-fire `/welcome` on first-conversation via the existing `contextPack.firstConversation` flag. Today's ship is the on-demand discovery affordance.

  Doctrine: `docs/doctrine/runtime-invariants-over-prompt-rules.md` § trust-accumulation visibility arc.

- ac622b6: Operator retention manifest, browser-verified, embedded in the Activity panel. Activity (`d5e66e34`'s deletion choke + `eb10bac6`'s timeline panel) shows what the motebit DID. The retention widget shows what the operator PROMISED — the second axis of sovereignty visibility. Together they're the pair: the operator's signed retention claim is re-verified in the browser without trusting the relay, and the user's motebit's actual signed-deletion log sits below it.

  The verifier (`verifyRetentionManifest`) was shipped at `fda8dd08` (phase 6a of the retention doctrine). The relay has been serving the signed JSON at `/.well-known/motebit-retention.json` ever since, with operator pubkey at `/.well-known/motebit-transparency.json`. No surface rendered them. This commit closes that.

  Cross-surface controller in `@motebit/panels` (`createRetentionController`, `summarizeRetentionCeilings`, `RetentionVerification`) — same Layer 5 BSL pattern. Two-fetch coordination (transparency manifest first for the key, then retention manifest for the body), verifier dispatch, discrete verification status (`idle | loading | verified | invalid | unreachable`). `summarizeRetentionCeilings` projects the manifest's per-store `mutable_pruning` shapes into a single per-sensitivity table sorted strictest-first, taking the worst-case ceiling across all stores that hold each tier.

  Web embeds it as a header block inside the Activity panel, above the filter chips. `@motebit/encryption` re-exports `verifyRetentionManifest` (matching the established `verifySkillBundle` pattern) so apps consume product vocabulary, not protocol primitives. Drift gate `check-app-primitives` enforces the layering.

  11 controller tests covering verification status state machine (verified / invalid / unreachable / loading), error paths (transparency null, retention null, fetch throws, verifier throws), summary projection (sort order, multi-store strictest-ceiling, ignore non-mutable_pruning shapes).

  Mobile + desktop will mount the same controller as a follow-up — the panels CLAUDE.md drift-gate idiom applies.

- c264a16: Self-test affordance — third leg of the sovereignty-visible trifecta. Activity (`eb10bac6`) shows what the motebit DID; Retention (`ac622b64`) shows what the operator PROMISED; this commit ships the third axis: **the user can probe that the protocol's security boundary still holds.** One click, green/red receipt, every surface.

  `cmdSelfTest` (the canonical adversarial-onboarding probe per `CLAUDE.md` "Adversarial onboarding") submits a self-delegation task through the live relay, exercising the real device-auth + audience-binding + sybil-defense flow production agents use. It's run once on every onboarding today, but the result was logged to console and never surfaced. The user couldn't ask "is my motebit still secure?" without `console.log` — until now.

  Cross-surface controller in `@motebit/panels`:

  ```ts
  const ctrl = createSelfTestController({
    runSelfTest: () => app.runSelfTestNow(),
  });
  ctrl.subscribe(setState);
  ctrl.run(); // kicks off the probe; concurrent calls coalesce.
  // state.status: idle | running | passed | failed | task_failed | timeout | skipped
  ```

  Discrete status state machine, idempotent under concurrent clicks, `selfTestBadgeLabel(status)` projection so every surface renders the same calm-software badge. Adapter throws are caught and projected into `failed` with the error in `summary` — surfaces never see a rejected promise.

  Each surface ships:
  - **Web** (`apps/web/src/web-app.ts`): `runSelfTestNow()` public method that mints `task:submit` token, calls `cmdSelfTest`, returns the structured result.
  - **Desktop** (`apps/desktop/src/index.ts`): same shape, dynamic-imports `@tauri-apps/api/core` for `invoke`, fetches device keypair, mints token.
  - **Mobile** (`apps/mobile/src/mobile-app.ts`): same shape against `await getSyncUrl()` + `createSyncToken("task:submit")`.
  - All three Activity panels render a "Run security self-test" button with status badge below the retention summary, inside the existing retention block. Inline summary surfaces failure hint when relay returns 401 ("device may not be registered") / 402 ("fund the agent's budget") / etc.

  Drift gate `check-panel-controllers` (#33) extends with `self-test` family — any surface that ships the button but bypasses the controller fails CI. Same shape as the existing `activity` + `retention` enforcement.

  10 controller tests covering state machine (idle → running → terminal), adapter throw → `failed` projection, hint + httpStatus passthrough, concurrent-call coalescing, subscribe/dispose lifecycle, badge label projection.

  The trifecta on every surface, locked by gate, demo-ready.

- d5e66e3: Sovereign deletion now exits through the privacy-layer choke point on every surface. Pre-fix only desktop's UI memory-delete actually called `runtime.privacy.deleteMemory(..., "user_request")` — every other path (`/forget` slash command, web + mobile + spatial UI memory-delete, and user-driven conversation deletion across all surfaces) bypassed via `runtime.memory.deleteMemory(...)` or the storage adapter's `deleteConversation(...)`, producing silent erasures with no signed `mutable_pruning` cert, no `consolidation_flush` cert per message, no `delete_*` audit row, and no `DeleteRequested` event.

  This change ties the user-driven axis of `docs/doctrine/retention-policy.md` together: `runtime.privacy.deleteConversation(id, "user_request")` lands as a sibling to `runtime.privacy.deleteMemory`, both emit `DeleteRequested` (intent) before signing (completion receipt) and erasing (decision 7 — physical erase, not tombstone). The runtime's `deleteConversation` wrapper became `async` and routes through the same choke; CLI's `/forget` and the `runtime.commands.cmdForget` slash-tool both signed-deletes now. Desktop's legacy fallback to `runtime.memory.deleteMemory` on privacy-layer failure was removed — privacy failure now surfaces as "delete failed, retry" rather than producing an unsigned, unaudited erase.

  Drift gate `check-deletion-routes-through-privacy` (invariant #75) locks the contract: `<receiver>.memory.deleteMemory(` and `<receiver>.eraseMessage(` are forbidden outside the privacy layer, consolidation cycle, and storage-adapter implementation sites. Future surfaces cannot drift back into bypass.

  ```ts
  // before — silent on web / mobile / spatial / cli
  await runtime.memory.deleteMemory(nodeId);

  // after — signed, audited, event-logged on every surface
  await runtime.privacy.deleteMemory(nodeId, "user_request");

  // new — conversations get the same contract
  await runtime.deleteConversation(conversationId);
  // → DeleteRequested event, one consolidation_flush cert per message,
  //   per-row erase, conversation row drop, delete_conversation audit
  ```

### Patch Changes

- 748e784: Internal: widen `makeAuditSink` in `motebit skills install/list/...` subcommands to accept the broader `SkillAuditEvent` union (now including `skill_consent_granted` from the consent-gate arc). The body still writes the JSON-serialized event verbatim to `~/.motebit/skills/audit.log`, so any consumer that consumed the prior `SkillTrustGrantEvent`-only stream sees the new variant as just another event line — no log-format break, no behavior change. Companion to the protocol-side widening shipped in `cfa3d42d`.
- b9e721e: Add explicit `case "trust":` + `case "welcome":` arms in the CLI REPL slash-command dispatcher (`apps/cli/src/slash-commands.ts`). Both delegate to `trySharedCommand` (same path the `default` arm uses for shared-runtime commands), but the explicit dispatch satisfies the CLI's `command-registry` test that pins every COMMANDS registry entry to a corresponding switch case. Functionally identical to the prior default-arm fallback; no runtime behavior change.

  Caught by pre-push principal review of the 36-commit session arc — the registry-pin test surfaced when `pnpm test` ran (the drift-defense gates passed because they don't include unit tests).

- 18e978a: Internal: re-route `NodeFsSkillStorageAdapter` + `resolveDirectorySkillSource` imports through `@motebit/skills/node-fs` instead of the top-level `@motebit/skills` entry. The CLI's runtime / slash-commands / `motebit skills *` subcommands all consume the same Node-fs adapter; the import path move is mechanical, no behavior change.

  Why the entry-point split: `@motebit/skills`'s top-level index re-exported the Node-fs adapter, which destructures `node:fs` eagerly at module evaluation. Tree-shaking handles it in production builds, but vite dev mode evaluates ES modules eagerly — any browser-side consumer that imports `SkillRegistry` from the top-level entry triggered a `node:fs` stub access and crashed the page before the renderer's animation loop started. The hot-fix splits the package so the bare entry is browser-safe and Node-fs ships behind `/node-fs`. CLI is the only published consumer affected; the rest of the consumers are private workspace packages.

## 1.3.0

### Minor Changes

- c332fce: `motebit smoke reconciliation` — operator-runnable end-to-end probe that asserts the treasury reconciliation loop is enabled, fresh (last cycle within 30 min), and reporting consistent state. Master token required; exits non-zero on `stale` or `drift` verdicts so it slots into CI / cron without ceremony.

  Five terminal verdicts: `healthy`, `stale`, `drift`, `no_cycles_yet` (recent boot, no failure), `loop_disabled` (testnet relay or mainnet without `X402_PAY_TO_ADDRESS`, no failure). Canonical `verdict=...` output for grep.

  Complements the free `Treasury reconciliation` probe in `motebit doctor` — same five branches, but `doctor` is read-only and degrades for non-operators while `smoke reconciliation` is hard-failing and operator-required. Sibling-but-distinct primitive vs the deposit-detector — canonical doctrine in `packages/treasury-reconciliation/CLAUDE.md` Rule 1.

  The paid-flow companion (`motebit smoke x402` — buyer/worker settlement that gives reconciliation a non-zero `recorded_fee_sum_micro` to observe) is a future deliverable; this changeset ships the read-side validation that the paid flow's `--verify-reconciliation` step will eventually call.

- b30cd40: `motebit smoke x402 [--mainnet]` — paid-flow end-to-end probe. Sibling of `motebit smoke reconciliation`: where reconciliation validates the read side (loop is observing correctly), this validates the write side (a real settlement actually flows through every layer).

  In-process: bootstraps two fresh motebit identities (buyer + worker) + two fresh EVM EOAs (`viem`'s `generatePrivateKey()`), persists the EOAs to `~/.motebit/smoke-x402-{buyer,worker}-eoa.txt` (mode 0600), posts a paid listing with the worker's pay-to address, drives the buyer's task POST through `@x402/fetch` (the 402 → sign → resubmit dance handled by Coinbase's official x402 client), constructs a signed Ed25519 ExecutionReceipt via `signExecutionReceipt`, posts it to `/agent/:workerId/task/:taskId/result`, and polls the task surface until `status=completed` confirms the relay wrote a `relay_settlements` row.

  Defaults to Base Sepolia (testnet, free, faucet-funded). `--mainnet` switches to Base mainnet via the relay's CDP facilitator and costs ~$0.0105 USDC per run; first-run mainnet exits cleanly with funding instructions for the auto-generated buyer EOA so operators don't half-spend against an unfunded address.

  Adds `@x402/fetch` + `viem` direct deps; bumps `@x402/core`/`@x402/evm`/`@x402/hono` to ^2.11.0 to keep the version family aligned (prevents private-property-incompatibility errors between hoisted x402-core copies).

  Pairs with `motebit smoke reconciliation` for full-loop validation: run x402 to drive a settlement, wait one reconciliation interval, run reconciliation to verify the cycle observed the new fee. The two together exercise the entire economic loop end-to-end on a live relay.

### Patch Changes

- 3e8fb9c: `motebit doctor` — new `Treasury reconciliation` probe surfaces relay-side reconciliation-loop liveness. Catches the silent failure mode where the loop has stopped firing (a dead loop emits no logs, so the loop itself can't surface the problem). Read-only, free, no money cost.

  Operator-side concern, gracefully degrades for non-operators: with `MOTEBIT_API_TOKEN` set the probe reports healthy / stale / disabled / drift-detected; without a master token it reports `skipped — operator-only check`. Stale threshold is 30 min (2× the loop's default 15-min cadence).

  Sibling-but-distinct primitive vs the deposit-detector — canonical doctrine in `packages/treasury-reconciliation/CLAUDE.md` Rule 1. The probe is the doctor-level partner to the runtime alert (`treasury.reconciliation.drift` structured log) and the admin endpoint (`GET /api/v1/admin/treasury-reconciliation`).

- f8842ad: `motebit smoke reconciliation` review pass: extracted `SMOKE_STALE_THRESHOLD_MS` (= 30 min) to a top-level named constant since the same value is referenced by `motebit doctor` and named as a contract in `docs/doctrine/treasury-custody.md` § Phase 1 step 7. Added two tests for non-2xx HTTP responses (401 wrong token, 500 server error) — previously only the network-rejection path was tested. No functional change.
- 4e4b758: `motebit smoke x402` principal-engineer review fix: the settlement-polling step at `assertSettlementLanded` was minting tokens with `aud: "admin:query"` (the bootstrap-time fallback) and re-using them for `GET /agent/:id/task/:taskId` polls. That endpoint requires `aud: "task:query"` (services/relay/src/tasks.ts:2147) — every poll would have 401-failed against a real relay and the smoke would have produced a misleading "settlement did not land within 60s" timeout instead of the audience-mismatch error.

  Fixed by minting a fresh per-call-site token for each audience boundary instead of pre-minting and re-using a single bootstrap-time token. Removed the unused `signedToken` field from the internal `BootstrappedMotebit` shape, since per-audience minting is now uniform across listing/task-submit/task-result/task-query.

  Also captures the last non-2xx HTTP body in the polling timeout error so future failures distinguish auth issues from settlement-pipeline stalls.

  No surface-level CLI change; pure correctness fix on the wire-format contract with the relay.

## 1.2.0

### Minor Changes

- 4dbca3e: `motebit federation mesh <url1> <url2> ...` — pair-wise peer N relays.

  Generalizes the K4 staging mesh stopgap (`scripts/staging-federation-mesh.mjs`, deleted) to any N≥2. Each pair uses the same `/peer/propose` self-mode + `/peer/confirm` flow as `motebit federation peer <url>`, refactored into a private `runPeerHandshake` helper consumed by both. Per-pair failure isolation: a single failed handshake is reported in the summary, not a fatal abort — operators bringing up federation meshes need to see the full pair-grid status, not stop at the first transient hiccup.

  ```text
  $ motebit federation mesh https://r1 https://r2 https://r3
  Mesh-peering 3 relay(s) — 3 pair handshake(s):

    ✓ r1 ↔ r2
    ✓ r1 ↔ r3
    ✓ r2 ↔ r3

  3/3 pair(s) active.
  Mesh established. Verify with `motebit federation peers` on each relay.
  ```

  `spec/dispute-v1.md` §6.2 + §6.5 require ≥3-peer quorum for adjudication, so N=4 is the single-operator floor (each leader sees 3 others). N=3 fails the floor — each leader would see only 2 others, and §6.5 forbids self-adjudication when defendant.

  `docs/operator/federation-live-test.md` updated to invoke the CLI command instead of the deleted script.

- 15a0d99: `motebit federation peer-remove <peer-url>` — packaged un-peering primitive.

  Sibling to `motebit federation peer <url>`. Closes the operator-onboarding gap where un-peering required ssh into the source relay, sqlite3 against `relay_identity` to extract the private key, ad-hoc Ed25519 sign of the raw `relay_motebit_id` bytes, then a curl POST to the target's `/peer/remove` — the HTTP-with-DB-keys recipe `cli_peer_remove_followup` flagged.

  Two HTTP calls under the hood:

  ```text
  1. Admin-authed GET to OUR relay's signing oracle:
     GET /api/v1/admin/federation/peer-removal-signature
     → { relay_id, signature }   (our relay signs its own relay_motebit_id raw bytes)

  2. Unauth'd POST to the PEER's /federation/v1/peer/remove with that
     { relay_id, signature } — the signature itself is the auth.
  ```

  The new oracle endpoint is admin-authed, NOT a public self-mode (mirror of `/peer/propose` self-mode). That call was deliberate: `/peer/propose` self-mode is safe because the existing handler already signs `(relay_id, nonce)` for any unauth'd caller — self-mode adds no new oracle. `/peer/remove` takes a signature over the BARE `relay_id` (no nonce, no suite-binding), so a public self-mode would create a replayable artifact: any HTTP caller could fetch this and POST it to every known peer, federation-DoS'ing the relay. Auth required.

  Wire-format `/federation/v1/peer/remove` is unchanged; only the operator-side affordance is new.

- 70c7909: Skills phase 2 — operator-gated script execution via `motebit skills run-script <skill> <script-name> [args...]`.

  Closes the `spec/skills-v1.md` §10 + §13 gap where `scripts/` files were stored at install but never executable. The directory layout IS the quarantine (no auto-execution path exists); each invocation is gated through the canonical operator approval queue (`SqliteApprovalStore` from `@motebit/persistence`) — same store the existing `motebit approvals list/show/approve/deny` surface reads. Per-script invocation creates a row at `RiskLevel.R3_EXECUTE` with `tool_name: "skill.script:<skill>/<script>"`.

  ```text
  $ motebit skills run-script my-skill build.sh --release
    Skill script execution requested
    Skill:        my-skill
    Script:       build.sh (412 bytes)
    Args:         --release
    Approval ID:  appr-skill-lq8r…

    Approve execution? [y/N] y
    ↳ ./build.sh runs with stdio inherited; exit code passes through
  ```

  Interpreter detection: shebang takes precedence (POSIX `#!` line); fallback by extension (`.js`/`.mjs`/`.cjs` → `node`, `.py` → `python3`, `.sh`/`.bash` → `bash`, `.rb` → `ruby`); reject if neither resolves so the audit row's approval doesn't grant execution of an opaque format. `--auto-approve` (or `MOTEBIT_AUTO_APPROVE=1`) skips the prompt for scripted/CI use but STILL records the approval row pre-resolved for audit.

  Drift gate `check-skill-script-uses-tool-approval` (invariant #69) catches any TS file that reads bytes from a skill's `scripts/` tree, imports `node:child_process`, and calls a spawn primitive but never invokes `approvalStore.add(...)`. Heuristic gate (lexical co-occurrence within a single file); `// eslint-disable check-skill-script-uses-tool-approval` near the spawn site escapes a known false positive. Effectiveness probe in `check-gates-effective.ts` plants a fixture that bypasses the approval store; the gate fires.

  AI-callable scripts as registered tools (the runtime exposes `skill.script:*` to the AI's tool catalog with the same approval gate) is deferred to phase 2.5 — bigger surface (tool registration + args schema + per-tool MCP-style description).

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

### Patch Changes

- d7dd911: Thread the local motebit's hardware-attestation score into the SkillSelector — published-runtime consumer half. Closes the documented-feature-doesn't-work gap where the bundled reference runtime hardcoded `hardwareAttestationScore: 0` regardless of what the local platform actually attested.

  **The gap.** Skills can declare `hardware_attestation: { required: true, minimum_score: X }` in their manifest per `spec/skills-v1.md` §4. The selector enforces: if `required && minimum_score > localScore` → skip. Until this ship, every surface hardcoded `localScore: 0`, so any skill demanding any positive score silently failed to load — even on hardware-attested devices. The four-ship HA infrastructure that landed across April was scoring OTHER agents (peers); the LOCAL motebit's own attestation never made it to the gate.

  **What ships.** `buildCliSkillSelectorHook` (in `apps/cli`, the published `motebit` runtime's CLI surface) now takes a `getHardwareAttestationScore: () => number` callback and reads it per-turn. The runtime-factory wires the closure to `runtime.getLocalHardwareAttestationScore()` and after construction calls `runtime.setLocalHardwareAttestationClaim({ platform: "software" })` — the truthful sentinel for a Node process with no hardware-attestation channel. Score resolves to 0.1 — distinguishes "agent honestly declared no-hardware" from "agent made no claim at all", per `docs/doctrine/hardware-attestation.md`. Skills declaring `minimum_score: 0.1` (a software-OK gate) now load on `motebit`; skills declaring `0.5+` still skip — correct behavior for a Node-process binary with no hardware-attestation channel.

  `apps/cli` tests pass through unchanged (the new score is read from the runtime each turn). Runtime engine API ships in the sibling `@motebit/runtime` changeset (`local-hardware-attestation-score-ignored.md`).

- 3f04703: Privacy doctrine — `/sensitivity [<level>]` slash command on the published `motebit` runtime (CLI surface). Closes the "code without UX" gap left by sensitivity-routing v1+v2: the runtime engine API exists (`setSessionSensitivity` / `getSessionSensitivity`), the gates fire correctly (`SovereignTierRequiredError` on AI calls + outbound tool dispatch), but until this ship no surface let users actually elevate the tier. Session sensitivity stayed pinned at `"none"` everywhere — gates were unreachable from any user action.

  **Surface symmetry:** all four surfaces (cli / desktop / mobile / web) ship the same affordance with surface-native semantics:
  - `/sensitivity` — show current tier
  - `/sensitivity status` — same
  - `/sensitivity none|personal|medical|financial|secret` — set tier
  - Invalid tier → usage hint with current tier inline

  **Calm-software-doctrine compliant.** Silent on default (no toast on status); single system-message line on elevation explaining the consequence ("Session elevated to medical — outbound tools and external AI will fail-close until you switch to a sovereign provider"). No popups, no nagging, no double-confirmation — the user typed the command, the gate is in effect.

  `apps/cli` implementation: added entry to `args.ts` `COMMANDS` list and dispatch case in `slash-commands.ts`. Reads/writes through `runtime.getSessionSensitivity` / `setSessionSensitivity` directly. Desktop/mobile/web halves ship in the sibling `sensitivity-affordance-slash-command-ignored.md` changeset.

  The full sensitivity-routing arc is now end-to-end: doctrine claim → runtime engine API → gate enforcement (AI + outbound tools) → drift defense → user surface. No surface forks the dispatch; every surface routes through the same canonical setter.

- 4ed47f4: Privacy doctrine — sensitivity-aware AI routing v1, published-runtime consumer half. Closes the documented-but-not-enforced invariant where CLAUDE.md asserts "Medical/financial/secret never reach external AI" while no code path actually gated provider calls on session sensitivity.

  `apps/cli` (the published `motebit` runtime's CLI surface) calls `runtime.setProviderMode(cliConfigToUnified(config).mode)` at boot. The unified config already classifies the user's `--provider` choice; surfacing it on the runtime engine is just plumbing. Users running `--provider local-server` can now elevate session sensitivity to medical/financial/secret and have the gate pass. Users running `--provider anthropic|openai|google` at elevated sensitivity get a fail-closed `SovereignTierRequiredError` with a clear "switch to on-device" message before any bytes leave.

  `scripts/check-sensitivity-routing.ts` — drift gate (#65) enforcing every method in `motebit-runtime.ts` that calls `runTurn` / `runTurnStreaming` MUST call `this.assertSensitivityPermitsAiCall()` first. Catches the doctrine drift class — adding a new external-AI entry point that skips the gate is a CI failure, not a silent privacy leak.

  **Auto-classification deliberately deferred.** v1 is explicit-elevation only: surfaces escalate via `setSessionSensitivity` when the user toggles a "medical mode" UI affordance, types `/sensitivity medical`, or otherwise marks the session. LLM-driven detection of medical/financial/secret signals in user text is a UX decision that deserves its own deliberation — explicit elevation is honest about what the runtime knows now.

  Runtime engine API ships in the sibling `sensitivity-routing-v1-ignored.md` changeset.

- 34c73ca: Replace inline `require("node:os")` with a top-of-file `import * as os from "node:os"` in `runtime-factory.ts`. Pre-push lint surfaced four errors (`no-require-imports` + `no-unsafe-*`) on the CommonJS-style require — ESM imports keep the type info and pass the published-package-source eslint preset.
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

- 3dd5c54: Update phase 2 ai-core prompt-test fixtures to include the new `score` and `signature` fields on `SkillInjection` (added in phase 3). No behavior change — the prompt builder still ignores both fields, the renderings asserted by the tests are unchanged.
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

- a1077e9: Drop the redundant default `name` field in the `makeSummary` test helper for the new SkillsController test suite. The helper signature already requires `overrides.name`, so the inline default `name: "placeholder"` was unreachable and tripped TS2783 ("'name' is specified more than once, so this usage will be overwritten") under tsc — runtime semantics unchanged, tsc-strict was the only rejector.
- 4d6dd80: Skills v1 phase 4.1: surface-agnostic `SkillsController` in `@motebit/panels`. State + actions for the cross-surface skills panel (browse / install / enable-disable / trust-untrust / verify / remove / search / detail-view) — the foundation for desktop / mobile / web renderers in subsequent slices (4.2 / 4.3 / 4.4).

  The controller follows the established `@motebit/panels` pattern: one adapter the host implements, one state shape, one controller exposing `subscribe + actions + getState + dispose`. Zero internal deps preserved — wire-format types (`SkillSensitivity`, `SkillPlatform`, `SkillProvenanceStatus`) are inlined to avoid layer promotion against `@motebit/protocol`. The host wires its `SkillRegistry` instance into the adapter; the controller is registry-unaware.

  ```text
  SkillsPanelAdapter      listSkills | readSkillDetail | installFromSource |
                          enableSkill | disableSkill | trustSkill | untrustSkill |
                          removeSkill | verifySkill
  SkillsController        refresh | install | enable-disable | trust-untrust |
                          removeSkill | verifySkill | selectSkill | setSearch |
                          filteredSkills | dispose
  SkillSummary            list-row payload (frontmatter + state, no body bytes)
  SkillDetail             detail-view payload (summary + body + author/category/tags)
  ```

  Optimistic state mutations:
  - `enable / disable` flip `enabled` locally without a full refresh (cheap, immediate UX feedback).
  - `trust / untrust / remove` trigger a full refresh — provenance status recompute lives on the registry side, not the panel.
  - `verifySkill` mutates only the affected row's `provenance_status` (no full refresh).
  - Removing the currently-selected skill clears `selectedSkill` automatically.

  Errors surface in `state.error` and leave previous-good state intact; the renderer decides toast vs system-message per surface doctrine. 21 new tests cover refresh / install / enable-disable / trust-untrust / remove / verify / selectSkill / setSearch / dispose / error paths. 132/132 panels tests green.

  Phase 4 remaining: 4.2 (desktop renderer), 4.3 (mobile renderer + ExpoFsSkillStorageAdapter), 4.4 (web renderer + IndexedDBSkillStorageAdapter or relay-mediated browse), 4.5 (`motebit/awesome-skills` curated registry).

- 2ae06ab: Add `motebit skills publish <directory>` — sign a skill with the user's CLI identity key, write back the signed `SKILL.md` + `skill-envelope.json` byte-stable, and POST the bundle to the relay-hosted registry's `/api/v1/skills/submit` endpoint. Closes the author-side loop opened by phase 4.5a (`spec/skills-registry-v1.md`).

  The publish flow is fail-closed in two places before going to the network:
  1. **Local re-verify after sign.** A tampered private key or a dependency drift in the signing chain surfaces as `Local re-verify failed after signing` rather than at the relay's 400.
  2. **Idempotent re-publish.** Re-running `publish` on the same directory with the same identity key produces byte-identical envelope + body, so the relay returns 200 (idempotent) instead of 409 `version_immutable`. Authors can re-run the command without bumping SemVer.

  Usage:

  ```text
  motebit skills publish skills/git-commit-motebit-style
  ```

  Output names the resolved address so the author can immediately install elsewhere:

  ```text
    published
    git-commit-motebit-style v1.0.0
    address:    did:key:z6Mk…/git-commit-motebit-style@1.0.0
    submitter:  did:key:z6Mk…
    content:    7f313f44…

    Install elsewhere with: motebit skills install did:key:z6Mk…/git-commit-motebit-style@1.0.0
  ```

  Also seeds a second motebit-canonical skill, `motebit-spec-writer`, at `skills/motebit-spec-writer/`. Procedural knowledge for drafting `motebit/<name>@<version>` specifications: header conventions, foundation-law markers, wire-format triple-sync (protocol type → zod schema → JSON Schema), drift-gate discipline. Build via `pnpm --filter @motebit/skills build-spec-writer-skill`.

  The reference corpus now ships two signed skills (`git-commit-motebit-style`, `motebit-spec-writer`) — operators can `motebit skills publish skills/<name>` against any deployed relay to seed the curated index.

  Drift gate `check-skill-cli-coverage` learns about network-side verbs: `publish` is intentionally not backed by a `SkillRegistry` method (it's a relay-client operation, not a local-disk one). Future network-side verbs add a one-line waiver in the gate's `INTENTIONAL_NON_REGISTRY_VERBS` set.

- 8bab218: Skills v1 phase 4.5a — CLI install via the relay-hosted registry.

  `motebit skills install` now accepts a relay address shape:

  ```text
  motebit skills install did:key:z6Mk…/example-skill@1.0.0
  ```

  The CLI fetches the bundle from the relay's `GET /api/v1/skills/:submitter/:name/:version` endpoint, re-verifies the envelope signature locally, asserts the relay-returned submitter matches the requested DID, then installs via the existing in-memory source path. Existing directory installs (`motebit skills install /path/to/skill`) are unchanged.

  The local re-verify is the trust boundary — the relay is a convenience surface, never a trust root. A tampering relay returns bytes that fail verification on the consumer.

  Spec: `spec/skills-registry-v1.md`.

- 556468d: Replace inner `switch (provenance_status)` with an if/else chain in `slash-commands.ts`. The provenance-status branches were being misclassified as fake slash commands by `command-registry.test.ts`, whose regex scans every `^\s+case "X":` pattern in the handler source. No behavior change — identical badges returned for the same statuses.

## 1.1.1

### Patch Changes

- 1502cfc: Internal: workspace-private `@motebit/api` package and `services/api/` directory renamed to `@motebit/relay` and `services/relay/` for naming coherence with the rest of the codebase (CLI command `motebit relay up`, doctrine docs, README, and the published container at `ghcr.io/motebit/relay`).

  Per `docs/doctrine/release-versioning.md`: "Patch = repaired promise. Same public contract, better implementation." The motebit CLI's commands, flags, exit codes, `~/.motebit/` layout, MCP server tool list, and federation handshake protocol are all unchanged. Only bundle-internal source organization moved — the inlined workspace package the tsup `noExternal: [/.*/]` config bundles into `motebit/dist/index.js` is now sourced from `services/relay/` instead of `services/api/`.

  Operators upgrading from `motebit@1.1.0` see no behavioural difference. No env vars, no flags, no commands, no DB layout, no protocol surface changed.

  The companion container release ships as `ghcr.io/motebit/relay:1.0.1` (cut as a `relay-v1.0.1` git tag in the same change). The relay's contract — HTTP endpoints, env vars, volume layout, federation handshake, wire formats — is byte-identical to `relay-v1.0.0` (which published only to the now-deprecated `ghcr.io/motebit/api` namespace). Only the registry pull URL and the OCI `image.title` label differ. Per the same release-versioning doctrine, "the dev contract moved is at most additive" — the registry path is not a contract break, and a major bump here would be a "phantom major" the doctrine explicitly warns against.

  Explicitly unchanged for separate operational migrations: Fly.io app names (`motebit-sync`, `motebit-sync-stg`, `motebit-sync-stg-b` — DNS+federation-peer cutover required), Prometheus metric prefix (`motebit_api_*` — would orphan historical time-series), all CHANGELOG entries (historical record), `docs/drift-defenses.md` (incident history).

## 1.1.0

### Minor Changes

- 454f329: Scaffolded agents are now self-contained, and `--direct` mode produces a minimal tool surface.

  A cold-walk of the published `create-motebit@1.1.2` against the README's "What you see:" block surfaced two architectural drifts that this changeset closes.

  **`create-motebit` — agent identity is local, not global.** The `--agent` scaffold path now writes the encrypted private key to `<agent>/.motebit/config.json` instead of the operator's global `~/.motebit/`. The scaffolded entrypoint pins `MOTEBIT_CONFIG_DIR=<agent>/.motebit` on the spawned `motebit serve` so the runtime reads THIS agent's identity, not whatever sits at the operator's path. The agent directory becomes portable: copy it to another machine, set `MOTEBIT_PASSPHRASE`, run. The identity-clobber gate moves from "global ~/.motebit has an identity" to "this agent dir already has its own .motebit/config.json" — same safety property, scoped correctly. `.gitignore` template now excludes `.motebit/` since it carries the encrypted key.

  **`motebit` — `CONFIG_DIR` honours `MOTEBIT_CONFIG_DIR`.** The runtime previously hardcoded `~/.motebit/`; it now reads `process.env["MOTEBIT_CONFIG_DIR"]` first and falls back to `~/.motebit/` when unset. Operator usage (`motebit relay up`, `motebit run`, etc.) doesn't set the env var, so behavior is unchanged for them. The scaffolded-agent flow above sets it explicitly.

  **`motebit` — `--direct` skips runtime-injected builtin tools.** `buildToolRegistry` previously registered ~12 builtins (memory, fs, web search, time, ...) regardless of mode. With `--direct`, the user has declared "no AI loop, run only my tools" — injecting builtins on top of that breaks the principle of least surprise and means a freshly scaffolded agent advertises a 12-tool MCP surface where the README claims 2. The factory now returns an empty registry when `config.direct` is true; the daemon's `--tools <path>` loader is the only thing that adds entries. Operator console doesn't pass `--direct`, so it keeps all builtins.

  **`create-motebit` — onboarding chain actually loads `.env` at runtime.** The scaffolded `package.json`'s `dev`/`start`/`self-test` scripts now use `node --env-file=.env` (Node ≥ 20.6 native, no dependency added). Without this flag, the `.env` file the user creates from `.env.example` was wallpaper — Node never read it, so `MOTEBIT_PASSPHRASE` set there never reached the runtime, decrypt failed, `motebit_task` stayed disabled. The `.env.example` template's `MOTEBIT_PASSPHRASE` field now leads with a `REQUIRED` comment naming the failure mode. Scaffold success message and the per-agent README's "First run" snippet both call out the passphrase step explicitly. Engines floor moved to `>=20.6.0` so npm warns at install time when Node is too old.

  **Existing 1.1.2-scaffolded agents continue to work** — their identity sits in `~/.motebit` and the runtime's fallback resolves there when the env var is unset. New scaffolds use the local pattern. The two coexist; no migration required for in-the-wild agents. (1.1.2-scaffolded agents that lacked the `--env-file=.env` flag will continue to expect `MOTEBIT_PASSPHRASE` in the shell rather than `.env` — same as before; this fix improves only newly-scaffolded agents.)

  **Migration note (motebit @ minor bump).** `--direct` mode previously exposed a runtime tool registry of ~12 builtins (memory, fs, web search, time, ...). That surface was an accident of `buildToolRegistry` running unconditionally — never documented in the README, never appeared in `--help`, never specified. `--direct` now returns an empty registry; the only tools an agent in direct mode sees are those it loaded explicitly via `--tools <path>`. If you were unwittingly relying on the old 12-tool surface, drop `--direct` to run with the full AI-loop runtime (which keeps all builtins, including write/exec tools when `--operator` is also set).

  **Verified end-to-end** with a _user-following-README_ cold-walk (no shell env exports beyond `MOTEBIT_PASSPHRASE` at scaffold creation; `cp .env.example .env`, edit passphrase value in `.env`, `npm run dev`): scaffold succeeds, `.motebit/` lands in the agent dir, global `~/.motebit/config.json` mtime untouched, `npm run dev` produces output that matches the README's "What you see:" block exactly:

  ```
  Identity: 019d...
  Tool loaded: fetch_url
  Tool loaded: echo
  Agent task handler enabled (direct mode — no LLM)
  Tools loaded: fetch_url, echo
  MCP server running on http://localhost:3100 (StreamableHTTP). 2 tools exposed.
  Policy: ambient mode.
  ```

  **`motebit` — self-sovereign agent registration finally works.** The relay's `/api/v1/agents/*` middleware always accepted two auth shapes: an operator master token, OR a self-signed device token verified against the agent's own registered public key (`audience: "admin:query"`). The `.env.example` claim "Anonymous agents can register and serve for free" was always architecturally correct — the implementation gap was that `daemon.ts` only sent `Bearer ${masterToken}` when a master token existed, never minting the self-signed alternative even though `createSignedToken` was already imported and used elsewhere in the same file (self-test, WebSocket auth). The fix is two coordinated steps the relay already supports: call `/api/v1/agents/bootstrap` first (unauthenticated, idempotent — registers the agent's `(motebit_id, device_id, public_key)` so the relay knows which key to verify against), then mint a 24h `admin:query` signed token and use it as Bearer for `/register` and the heartbeat setInterval. Operator master token, when present, still wins. Result: `Registered with relay: https://relay.motebit.com` lands on first run for every cold-walked scaffolded agent, no `MOTEBIT_API_TOKEN` required. The 24h expiry is wider than the per-call 5-min default to cover the heartbeat window; agents running longer than 24h need restart (or a follow-up to mint per-heartbeat tokens).

  **Three of three architectural claims now hold under the user-following-README cold-walk** — tools count, decrypt-success, relay-registration. The path from `npm create motebit my-agent --agent` → `cd my-agent && npm install` → `cp .env.example .env` → set `MOTEBIT_PASSPHRASE` → `npm run dev` produces output that matches the README's "What you see:" block exactly, with no relay 401, no decrypt-failed warning, no surplus runtime tools. Self-containment, self-sovereign auth, and minimal tool surface are all real properties of the v1 scaffold instead of partially-true ones.

## 1.0.1

### Patch Changes

- bda4de1: First-run UX repair: canonical signing-key resolver + actionable doctor probes.

  ## Why

  A live walkthrough of the golden path (`fund → delegate → settle`) on a real install surfaced that the CLI fails silently on every common first-run gap:
  - `~/.motebit/config.json` with no `cli_encrypted_key` (clobber, partial setup, fresh install) → `motebit balance` errors with "no relay URL", `motebit wallet` errors with "No private key found", `motebit fund` never gets that far. None of these messages tell the user what to do.
  - Identity not registered with the relay (`/agent/{id}/capabilities` → 404) → discovery, peer-trust pulls, and capability advertisement silently miss the user. Doctor reports all-ok.
  - `sync_url` missing from config → every economic flow short-circuits before its first network call. Doctor reports all-ok.
  - The same `if (config.cli_encrypted_key) { try / catch passphrase decrypt }` block was inlined across **five** call sites (register, daemon × 2, \_helpers, wallet) with subtly different error handling and prompt labels. Future contributors had no guard against adding a sixth.

  None of this was hypothetical — it's exactly what a live `motebit doctor; motebit fund 1.00` run produced on a real installed identity that had been through the 2026-04-25 config-clobber-refusal flow (`85fb31f0`).

  ## What ships

  ### `loadActiveSigningKey(config, options?)` — canonical signing-key resolver

  `apps/cli/src/identity.ts`. Single read site for `cli_encrypted_key` and the deprecated `cli_private_key`. Replaces five inline blocks; wires register, daemon (× 2), `getRelayAuthHeaders`, and `motebit wallet` through one helper.

  Resolution order:

  ```text
  1. cli_encrypted_key — passphrase from MOTEBIT_PASSPHRASE env or interactive prompt
  2. cli_private_key — legacy plaintext (deprecated since 1.0.0, removed at 2.0.0); warns on use
  ```

  **Defense the inline copies didn't have:** the helper re-derives the public key from the private bytes and verifies it byte-equals `config.device_public_key`. Fail-closed on mismatch. Inline copies would silently sign under the wrong identity — a downstream verifier rejecting the signature is an obvious failure, but signing as someone else is a silent one. The mismatch case is the load-bearing test.

  Sources NOT supported (deliberate):
  - **`~/.motebit/dev-keyring.json`.** Written by the desktop Tauri app's Keychain-failure fallback (`apps/desktop/src/identity-manager.ts:124`). Cross-surface keystore unification is a real architectural pass; a silent fallback chain is the wrong shape for it. The right shape is an explicit `IdentityKeyAdapter` per surface, same family as the storage adapter pattern. That's a separate commit.
  - **Raw private-key bytes from environment variables.** Sovereign identity is not an env-friendly secret — env leaks through shell history, CI logs, process inspection, debug dumps. The passphrase env IS supported because the on-disk ciphertext is the actual secret; the passphrase is a scrypt-stretching factor, not the secret itself.

  `IdentityKeyError` is a structured failure type carrying `kind` (`missing` / `decrypt-failed` / `malformed-private-key` / `public-key-mismatch`) and `remedy` (a one-line actionable next-step). Each call site catches the error and surfaces the remedy — `register` and `daemon` downgrade to unsigned / disabled with a warning that names the kind; `wallet` exits with the remedy printed; `_helpers.getRelayAuthHeaders` proceeds unauthenticated for read-only flows.

  ### `motebit doctor` — first-run actionable probes

  Pre-1.0 doctor checked structural readiness only (Node, sqlite, identity-id-present). All-green doctor + every economic flow failing was the wrong signal. The expanded doctor adds three probes that run unconditionally and three that run when `sync_url` is set:

  ```text
  Identity key         present + shape (cli_encrypted_key | cli_private_key | missing)
  Public key           device_public_key present + 32-byte hex
  Sync URL             configured in config or MOTEBIT_SYNC_URL env
  Relay reachable      GET /health/ready returns 2xx (5s timeout)
  Identity registered  GET /agent/:id/capabilities returns 200 (5s timeout)
  ```

  Each failure carries a concrete remedy: `restore from ~/.motebit/config.json.clobbered-{date}` (when a clobbered backup is detected on disk), `run motebit init`, `run motebit register`, etc. Probes are best-effort with timeouts so doctor stays unattended-friendly — a misconfigured URL or network failure doesn't hang the command.

  ### Promoted `getPublicKeyBySuite` to `@motebit/encryption`

  The helper needed to derive a public key from a private seed to verify the device-public match. Per `check-app-primitives` doctrine, apps consume product vocabulary (`@motebit/encryption`), not Layer-0 protocol primitives (`@motebit/crypto`). `getPublicKeyBySuite` was already exported from `@motebit/crypto`'s `signing.ts` re-exports; this commit re-exports it from `@motebit/encryption`'s barrel as the product-vocabulary pair to `generateKeypair` for "I have a private seed, give me the public."

  ## What's deliberately NOT in this commit
  - **Cross-surface keystore unification.** `IdentityKeyAdapter` interface across CLI / desktop / mobile / web. The dev-keyring fallback question feeds into this; the right answer is per-surface adapters with explicit type, not a fallback chain at any single read site. Separate architectural pass.
  - **Restoring Daniel's specific environment.** This commit fixes the code so that future first-run users hit `doctor` and see what to do. Daniel's existing `~/.motebit/config.json` still needs `cli_encrypted_key` restored from the clobbered backup (or a fresh `motebit init`); doctor now points at that exact remedy.
  - **Running real `motebit fund` / `delegate` / `settle`.** Those require Daniel's Stripe interaction and decrypted signing key; doctor's job is to surface gaps, not move money.

  ## Verification
  - 9 new unit tests in `identity-load-active-signing-key.test.ts` — happy path, env passphrase, legacy plaintext (with deprecation warn), missing key, wrong passphrase, public-key mismatch (fail-closed), skipped-mismatch escape hatch, malformed bytes, missing-public-key edge.
  - 3 boundary tests in `relay-auth-passphrase.test.ts` (rewritten to match new helper boundary): resolver invoked when no master token, master token shortcuts resolver entirely, resolver throw downgrades to unauthenticated.
  - All 199 CLI tests pass; all 42 drift defenses pass.
  - Live run on a real broken config produced two clear `FAIL` lines with correct remedies pointing at a clobbered backup that exists on disk and at `motebit register`.

  Operator-facing surface unchanged: subcommands, flags, exit codes, `~/.motebit/` layout, relay HTTP routes all preserve their 1.0.0 contract.

- 8c2426a: Add `motebit migrate-keyring` — recovery path that re-encrypts a plaintext `~/.motebit/dev-keyring.json` private key under a passphrase and writes it as `cli_encrypted_key` in `~/.motebit/config.json`.

  ## Why

  A live golden-path walkthrough turned up a class of users with a valid private key on disk under `~/.motebit/dev-keyring.json` (written by the desktop Tauri app's Keychain-failure fallback in `apps/desktop/src/identity-manager.ts:124`, or by older scaffold flows) but no `cli_encrypted_key` in `config.json`. The CLI's only response in this state was "no private key found" — the path of least resistance was to run the interactive setup again, which silently created a brand new identity and abandoned everything signed under the old `motebit_id`. That's the wrong escape valve for a sovereign-identity product whose moat is accumulated trust.

  A check on one real install surfaced **three motebit identities** in `~/.motebit/`, accumulated over a month — each one created because there was no recovery doctrine for "I have the key, I just don't have it where the CLI looks." The CLI was treating identity creation as cheap and recovery as undocumented. Inverted priorities.

  ## What ships

  `motebit migrate-keyring [--force]` does exactly one thing: takes the existing private key on disk, encrypts it under a passphrase you choose, and writes it as `cli_encrypted_key`. The current `motebit_id` is preserved. Nothing else changes.

  The load-bearing defense is **fail-closed on key/public mismatch**. Before encrypting, the subcommand re-derives the public key from the private bytes and verifies it byte-equals `config.device_public_key`. If they don't match, the dev-keyring belongs to a different identity than your config — silently binding it would produce signed artifacts under one motebit_id but with a private key for another (the silent-corruption case `loadActiveSigningKey` already defends against at the read path). The error explains the orphaned-key situation and points at three concrete next moves: remove the orphaned keyring, restore from a `~/.motebit/config.json.clobbered-*` backup, or run a fresh `motebit init`.

  Honors `MOTEBIT_PASSPHRASE` env for unattended / scripted use, matching the convention in `_helpers.getRelayAuthHeaders`, `register`, and `daemon`. Refuses to overwrite an existing `cli_encrypted_key` without `--force` (rotating the passphrase has a separate intent shape).

  After successful migration, the plaintext `dev-keyring.json` is overwritten with zeros and unlinked — leaving plaintext keys on disk after the encrypted version exists is a security regression.

  6 unit tests pin: happy path (migrate + remove plaintext), fail-closed on key/public mismatch (the load-bearing case — refuses to bind an orphaned key), refuses overwrite without --force, requires identity in config, refuses on passphrase mismatch, plus a sanity round-trip on `getPublicKeyBySuite` to catch suite-dispatch regressions that would silently break the match check.

  ## What this leaves on the table

  The deeper architectural smell behind the multi-identity drift — `motebit` (no args) silently creating a new identity when config is partial-but-not-empty, scaffold tools and operator tools sharing `~/.motebit/`, no doctor probe for "you have N orphaned identities" — is named in the original audit but not addressed here. That's a sibling pass.

- edced5e: Fix two production bugs surfaced by a live golden-path run.

  ## 1. CLI signed money-path requests with the wrong audience

  `apps/cli/src/subcommands/market.ts` — `handleBalance`, `handleFund`, `handleWithdraw` all called `getRelayAuthHeaders(config)` which defaults the signed-token audience to `"admin:query"`. The relay's `dualAuth` middleware (`services/api/src/middleware.ts:631-645`) requires per-route audiences:

  ```text
  GET  /api/v1/agents/:id/balance     → account:balance
  POST /api/v1/agents/:id/checkout    → account:checkout
  POST /api/v1/agents/:id/withdraw    → account:withdraw
  ```

  Result: **every `motebit balance / fund / withdraw` since 1.0.0 has failed with `401 AUTH_INVALID_TOKEN` against any relay running the dual-auth middleware**. The bug was invisible to `motebit doctor` (which doesn't call these routes) and to the published-package CI (which has no live-relay smoke). Caught only when running the full economic flow against a real relay.

  Fix: each call site pins its own aud. `handleFund` mints two tokens (one for `/checkout`, one for the balance-poll loop on `/balance`) since a signed token can only carry one aud.

  ## 2. Relay `/checkout` returned opaque 500 on Stripe errors

  `services/api/src/budget.ts:662` had zero error handling around the Stripe SDK call. Any thrown `StripeError` became `{"error":"Internal server error","status":500}` from Hono's default uncaught-exception handler — the actual Stripe message ("Your account cannot currently make live charges", "Your card was declined", etc.) only existed in fly.io logs. Operators of every motebit relay had to dig logs to debug their own users' fund flows.

  Fix: new `mapStripeError(c, ...)` helper (in `budget.ts`, top of file) catches Stripe SDK exceptions and returns a structured 502:

  ```json
  {
    "error": "STRIPE_ACCOUNT_NOT_ACTIVATED",
    "message": "Your account cannot currently make live charges.",
    "stripe_type": "StripeInvalidRequestError",
    "stripe_code": null,
    "status": 502
  }
  ```

  The motebit-shaped `error` code is mapped from common Stripe error patterns:

  ```text
  "cannot currently make live charges" → STRIPE_ACCOUNT_NOT_ACTIVATED
  StripeAuthenticationError             → STRIPE_API_KEY_INVALID
  StripeRateLimitError                  → STRIPE_RATE_LIMITED
  StripeConnectionError                 → STRIPE_CONNECTION_FAILED
  (everything else)                     → STRIPE_<TYPE>
  ```

  Per `services/api/CLAUDE.md` rule 14 — external medium plumbing speaks motebit vocabulary. Provider-shaped errors (Stripe's deep nested raw object) collapse here into a closed motebit shape. Server-side logs still capture the full Stripe response (request ID, headers) for operator debugging; the client never sees raw Stripe internals.

  The CLI side (`market.ts handleFund`) parses the new structured shape and prints both the motebit code and Stripe's human message. For `STRIPE_ACCOUNT_NOT_ACTIVATED` specifically, it adds a one-line pointer at the Stripe onboarding URL — the most common path to recovery.

  ## What this leaves on the table

  A drift defense that catches the audience-mismatch class of bug at lint time would be valuable — `check-aud-binding` could grep middleware aud strings, grep CLI aud strings, and require any motebit-signed POST to a route in the middleware list to use the matching aud. Filed as a follow-up; not in this commit because it requires walking Hono middleware definitions, which is non-trivial.

- 16e450b: `motebit` CLI now honors `MOTEBIT_PASSPHRASE` for relay-auth token minting.

  **Bump level**: patch. This is a repaired promise, not an expanded one — `MOTEBIT_PASSPHRASE` is a generic-sounding env var the user reasonably expects to work everywhere a passphrase is needed. The previous behavior (env var works for `--yes` and rotate/export/attest, silently ignored by relay-auth) was internal inconsistency, not a deliberate restriction. Fixing it brings behavior in line with the env var's documented role.

  Gap #6 from the 2026-04-25 first-time-user walkthrough. `getRelayAuthHeaders()` (the function that mints a signed device token when no `MOTEBIT_API_TOKEN` master token is present) called `promptPassphrase()` unconditionally — it didn't read `MOTEBIT_PASSPHRASE` the way every other unlock prompt in the CLI does. Result: any scripted use of `motebit credentials`, `motebit export`, `motebit attest`, etc. silently hung waiting on a hidden TTY prompt. The exact reproduction was running `MOTEBIT_PASSPHRASE=x npx motebit credentials` and watching it block on `Passphrase (for relay auth):` despite the env var being set.

  What changed:
  - `apps/cli/src/subcommands/_helpers.ts::getRelayAuthHeaders()` now reads `process.env["MOTEBIT_PASSPHRASE"]` before falling back to the interactive prompt. Same pattern as `apps/cli/src/index.ts:401`, `subcommands/rotate.ts:104`, `subcommands/export.ts:44`, `subcommands/attest.ts:97` — those already honored the env var; only `getRelayAuthHeaders` didn't.
  - The prompt label drops the `(for relay auth)` parenthetical and is now just `Passphrase: ` to match every other unlock prompt. The previous label implied a separate passphrase concept that doesn't exist — the relay-auth token is signed by the same Ed25519 private key encrypted under `cli_encrypted_key`, unlocked by the same passphrase the user set during `create-motebit`.
  - New `apps/cli/src/__tests__/relay-auth-passphrase.test.ts` regression test asserts: env var skips the prompt, no env var falls back to prompting with the new `Passphrase: ` label, and `MOTEBIT_API_TOKEN` master token shortcuts the passphrase path entirely (existing behavior preserved).

  Migration: scripts that piped a passphrase via stdin to `motebit` commands as a workaround for the silent prompt no longer need the workaround — set `MOTEBIT_PASSPHRASE` in the environment instead. Interactive use is unchanged except for the simpler prompt text.

  Architectural note for future readers: the auth strategy in `getRelayAuthHeaders` is a 2-tier fallback — `MOTEBIT_API_TOKEN`/`MOTEBIT_SYNC_TOKEN` master token first, signed device token second. The signed device token is JWT-shaped (5-minute expiry, audience-scoped) and minted from the local key. There is no third "relay auth secret" concept; that misimpression was created by the prompt label.

- 6c2f8f5: Add `@hono/node-ws` to runtime dependencies. The `motebit relay up` path imports `@motebit/api` (bundled via `tsup noExternal: [/^@motebit\//]`), which uses `@hono/node-ws` for WebSocket upgrades. The CLI's `tsup.config.ts` correctly marks it `external` (CJS-era init code that doesn't survive ESM bundling), but it was never declared as a runtime dependency of the `motebit` package itself.

  In a workspace dev environment, pnpm's hoisting resolved the transitive dependency through `services/api`'s declaration. On a fresh `npm install motebit`, the package tries to load `@hono/node-ws` and exits with `ERR_MODULE_NOT_FOUND` on first boot.

  Caught by `check-dist-smoke` (drift defense #12) on first push of the relay-up commit (`0e924976`) — exactly the regression class the gate was built for: a build that compiles clean but the dist binary crashes on startup. Same shape as the prior `@noble/hashes × @solana/web3.js` bundling break (2026-04-13).

  Fix: declare `@hono/node-ws@^1.3.0` in `apps/cli/package.json` dependencies, matching the version pin already used by `services/api`.

- 21875ed: Tighten the published-package README so the runtime/CLI distinction is precise, and align spec/package counts with reality.

  ## Why

  The `motebit` package is the bundled reference runtime — relay, policy engine, sync engine, MCP server, and wallet adapters inlined into a single binary. The CLI is its primary operator-facing surface, not the artifact itself. The prior README opener ("the motebit CLI is published as a binary") was an elegant one-sentence framing that read accurately to someone scanning, but understated what the package actually contains and slipped against the package's own description field ("Reference runtime and operator console").

  A reviewer pulling on the framing surfaced the imprecision in two rounds. Fixing it locally without auditing siblings would have left the published-artifact prose drifting from the npm metadata it ships beside, so the cleanup also re-checked counts and package-table coverage at the same time.

  ## What shipped
  - `apps/cli/README.md` — new "How it ships" section opens with `motebit` as the bundled reference runtime and reframes the CLI as one of its surfaces. Restates the public-promise sentence: subcommands, flags, exit codes, `~/.motebit/` layout, relay HTTP routes, and MCP server tool list — not the internal workspace package graph.
  - Root `README.md` — package table expanded from 7 rows to 11 so all four hardware-attestation Apache-2.0 leaves (`crypto-appattest`, `crypto-play-integrity`, `crypto-tpm`, `crypto-webauthn`) are visible alongside the rest of the published surface in one place. New "Versioning" section adjacent to "Licensing" makes the published-vs-private split explicit.
  - Spec count: `12` → `19` across root README (×4), `CLAUDE.md`, and `apps/docs/content/docs/operator/architecture.mdx`. The seven specs missing from earlier enumerations (`agent-settlement-anchor`, `consolidation-receipt`, `device-self-registration`, `goal-lifecycle`, `memory-delta`, `plan-lifecycle`, `computer-use`) are real specs with reference implementations; the prose just hadn't been updated.
  - Package count: `36` / `40` / `37` → `46` across the same three surfaces. `pnpm check-docs-tree` validates the new numbers.
  - Five empty `auto-generated patch bump` changeset stubs deleted so they don't pollute the next CHANGELOG entry with content-free lines.

  ## Impact

  Zero runtime change. Zero API change. The `motebit` patch bump exists because `apps/cli/README.md` is in the package's `files` array — the README that ships to npm changes, so the published version should reflect it. Smoke test (`npm install motebit@1.0.0 && motebit doctor` from a clean tmp directory) passes all six checks including Secure Enclave detection on Apple Silicon hosts; the cleanup is purely textual.

  Three follow-ups are tracked separately: a `check-cli-surface` drift gate to bring CLI-surface rigor up to the protocol-floor `check-api-surface` standard, sentinel versioning on the 35 private workspace packages so their `0.x` numbers stop carrying unintended semver social meaning, and a CI gate that rejects empty changeset bodies at the source.

- 53a2783: License metadata correction: `package.json` `license` field flipped from
  `BSL-1.1` to `BUSL-1.1` — the SPDX-canonical identifier for Business Source
  License 1.1.

  `BSL-1.1` is not on the SPDX license list and silently collides with `BSL-1.0`
  (Boost Software License 1.0) in some scanners; npm warns on non-SPDX values.
  The legal terms are unchanged. This is a metadata-only correction; the
  published package's license text and obligations are identical.

  Prose continues to use "BSL" / "BSL-1.1" everywhere humans read (the BSL FAQ,
  HashiCorp, CockroachDB, Sentry all use "BSL"); `BUSL-1.1` appears only in
  `package.json` `license` fields where tooling parses a token.

- 6e5b1f2: Internal-only: silence `@typescript-eslint/no-require-imports` on three
  `require()` calls inside `vi.hoisted()` in
  `src/__tests__/migrate-keyring.test.ts`. The pattern is idiomatic vitest
  (vi.hoisted runs before ES module imports resolve, so `require()` is the
  only way to reach Node built-ins from inside the hoisted block). Targeted
  `eslint-disable-next-line` comments with an explanation; rule remains in
  force on the rest of the file. No runtime behavior change; tests
  unaffected.
- 5e7a192: Wire the hardware-attestation peer flow in the CLI runtime.

  The runtime hook in `packages/runtime/src/agent-trust.ts:258` (Phase 1 + Phase 2, shipped earlier) was dormant in production: `bumpTrustFromReceipt` gates on `if (getRemoteHardwareAttestations && updated.public_key)`, and no surface had ever called `setHardwareAttestationFetcher` or `setHardwareAttestationVerifiers`. The peer-attestation issuance loop existed only in the relay-side E2E tests; in the actual CLI runtime, hardware claims published by workers were never pulled, never verified, never folded into peer trust credentials, and never visible to routing.

  ## What shipped
  1. **`createRelayCapabilitiesFetcher`** — new export on `@motebit/runtime`. Production fetcher that hits `GET /agent/:motebitId/capabilities`, parses the `hardware_attestations` array, and returns it shaped for the runtime's `HardwareAttestationFetcher` slot. Best-effort: every error surface (network throw, non-2xx, malformed JSON, missing fields, wrong types) returns `[]` so the existing reputation-credential path proceeds unchanged. 8 unit tests pin each error surface plus the success path.
  2. **CLI wiring** at both runtime construction sites — `apps/cli/src/runtime-factory.ts` (REPL, `motebit delegate`, `motebit serve` paths) and `apps/cli/src/daemon.ts` site 1 (long-running daemon mode where `motebit run --price` workers + delegators accumulate trust). After `runtime.connectSync(...)`:

     ```ts
     runtime.setHardwareAttestationFetcher(createRelayCapabilitiesFetcher({ baseUrl: syncUrl }));
     runtime.setHardwareAttestationVerifiers(buildHardwareVerifiers());
     ```

     Adds `@motebit/verify` (Apache-2.0) as a CLI dep — which is what bundles the four canonical platform adapters (App Attest, Android Hardware-Backed Keystore Attestation, TPM 2.0, WebAuthn) plus the deprecated Play Integrity adapter into the CLI binary. Per `motebit-runtime.ts:2462`, `@motebit/verify` is intentionally NOT a runtime dep — surfaces own that choice.

  ## Why a patch and not a minor

  Operator-facing surface (subcommands, flags, exit codes, `~/.motebit/` layout, relay HTTP routes, MCP server tool list) is unchanged. The change is internal: peer trust credentials now carry a hardware-attestation block at delegation time when the worker has published a verifiable claim, which the routing aggregator scores at `HW_ATTESTATION_HARDWARE` (1.0) instead of the software sentinel's `HW_ATTESTATION_SOFTWARE` (0.1). Per `apps/cli/README.md`'s public-promise paragraph, that's not a breaking change.

  ## What's still deferred

  The other four surfaces — `@motebit/desktop`, `@motebit/mobile`, `@motebit/web`, `@motebit/spatial` — construct `MotebitRuntime` and may benefit from the same wiring. Mechanical follow-on (one-pass-delivery candidate); separated from this commit because each surface has its own sync-URL resolution pattern and adding `@motebit/verify` to four more workspaces is best reviewed in its own diff. The runtime hook stays dormant on those surfaces until the same two setters are called there.

- cdfaf18: Same-pass surface wiring for the hardware-attestation peer flow.

  The CLI landed with `5e7a1922` (runtime-hardware-attestation-fetcher-cli-wiring). This commit closes one-pass delivery across the four other surfaces — `@motebit/desktop`, `@motebit/mobile`, `@motebit/web`, `@motebit/spatial` — so peer hardware claims fold into routing trust regardless of which surface the user delegates from.

  ## Why a lazy resolver

  The CLI's sync URL was a constant the moment we constructed `MotebitRuntime`. The other four surfaces resolve it through cached fields that get repopulated on config changes:
  - **Desktop** — `_proxySyncUrlCache` (cached at bootstrap from Tauri config)
  - **Mobile** — `_proxySyncUrlCache` (cached at bootstrap from AsyncStorage)
  - **Web** — `loadSyncUrl()` reads `localStorage` on each call
  - **Spatial** — same `localStorage` accessor as the ProxySessionAdapter

  Threading the URL into the runtime at construction would have meant runtime reconstruction every time the user changed relay settings. So `createRelayCapabilitiesFetcher` now accepts either a static string OR a synchronous resolver:

  ```text
  baseUrl: string | (() => string | undefined | null)
  ```

  If the resolver returns `undefined` / `null` / `""`, the fetcher returns `[]` without touching the network — matches the no-claim-observed semantics the runtime hook already handles. Three new unit tests pin the lazy branch (resolver yields, resolver returns undefined, resolver returns empty string); the static-string path is unchanged.

  ## Surface choice — why spatial gets the wiring

  `apps/spatial/CLAUDE.md` rejects the panel metaphor, but the hardware-attestation peer flow isn't a panel — it's a runtime hook that fires on the same `MotebitRuntime.bumpTrustFromReceipt` path every other surface uses. The creature in spatial dispatches receipts through the same delegation engine; if a worker is running a hardware-backed identity, that should score at `HW_ATTESTATION_HARDWARE` (1.0) regardless of which surface the user delegated from. Skipping spatial would have introduced a routing asymmetry — same workers, same claims, different scores depending on the delegator's surface.

  ## What's now load-bearing

  Each surface's runtime, on every successful delegation, pulls `GET /agent/:remote_motebit_id/capabilities`, parses the worker's self-published `hardware_attestation` credential, runs the embedded claim through the bundled platform adapter (App Attest / Android Hardware-Backed Keystore Attestation / TPM 2.0 / WebAuthn / + the deprecated Play Integrity), and on `valid: true` issues a peer `AgentTrustCredential` carrying the verified claim. The routing aggregator scores the result at `HW_ATTESTATION_HARDWARE` (1.0) — 10× the software sentinel's 0.1 — visible across every routing decision the user's motebit makes from now on.

  ## Why patch

  Operator-facing surface (subcommands, flags, `~/.motebit/` layout, relay HTTP routes, MCP server tool list, web/desktop/mobile/spatial UI) is unchanged. The behavior change is visible only inside the routing semiring's edge weights.

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

### Minor Changes

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

- 4aad6eb: Add `motebit lsp` — a Language Server for `motebit.yaml`. Ships three
  features derived from the live zod schema in `apps/cli/src/yaml-config.ts`:
  diagnostics (every `parseMotebitYaml` error mapped to an LSP Diagnostic),
  hover (`.describe()` text for the field under the cursor), and completion
  (field names + enum values). Because it speaks LSP, Cursor, Vim/Neovim,
  and JetBrains IDEs pick it up without a per-editor plugin; a thin VS Code
  extension (`apps/vscode`) spawns `motebit lsp` over stdio for VS Code /
  Cursor users.

  New drift defense #20 (`yaml-config.test.ts`) enumerates every schema
  field and asserts each has a non-empty `.describe()` — a new field shipped
  without hover documentation fails CI.

- a51147d: Add `motebit verify <kind> <path>` — a CLI subcommand that validates a
  wire-format artifact against the published `@motebit/wire-schemas`
  contract AND verifies its Ed25519 signature using the embedded
  public key. Three kinds today: `receipt`, `token`, `listing`.

  This is the proof point that closes the wire-schemas loop. A non-motebit
  developer building a Python or Go worker can now check protocol
  compliance with one command:

  ```sh
  motebit verify receipt my-emitted-receipt.json
  ```

  Output is structured per-check — schema, suite, signature (and time
  window for tokens) each report independently, so a failure tells you
  exactly what's wrong:

  ```
  ✓ OK  receipt  /path/to/receipt.json
    ✓ json       parsed 636 bytes
    ✓ schema     ExecutionReceipt v1
    ✓ suite      recognized: motebit-jcs-ed25519-b64-v1
    ✓ signature  Ed25519 over JCS body — verified with embedded public_key
  ```

  `--json` flag emits a structured report for programmatic consumers.

  Backward-compatible with existing `motebit verify <path>` for identity
  files. Two-arg form (`verify <kind> <path>`) discriminates on the
  kind keyword; one-arg form (or explicit `verify identity <path>`) goes
  to the existing identity-file verifier.

  Self-attesting in action: the verifier doesn't require trust in the
  motebit runtime, just in the published schema and Ed25519 math.

- 96bc311: Publish `motebit-yaml-v1.json` — the JSON Schema for `motebit.yaml` is now
  a committed protocol artifact at `apps/cli/schema/motebit-yaml-v1.json`,
  generated from the same zod source the CLI parser and LSP consume.

  Third-party validators (VS Code's Red Hat YAML extension, CI actions,
  the dashboard) can reference it via its stable `$id` — no `motebit`
  install required. Users who want an inline yaml-language-server pragma:

  ```yaml
  # yaml-language-server: $schema=https://raw.githubusercontent.com/motebit/motebit/main/apps/cli/schema/motebit-yaml-v1.json
  version: 1
  # ...
  ```

  New subcommand `motebit schema` emits the same schema to stdout for
  vendoring into air-gapped workspaces. Drift defense #21 regenerates the
  schema in-process on every test run and fails CI if the committed file
  has drifted from the zod source.

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

- bce38b7: Complete the four-field-contract classification pass on every remaining
  `@deprecated` annotation in motebit's source: 14 markers across
  `@motebit/ai-core`, `@motebit/market`, `@motebit/mcp-client`,
  `services/api`, `apps/web`, and `apps/cli` now name `since`,
  `removed in`, replacement, and reason — matching the contract codified
  in `docs/doctrine/deprecation-lifecycle.md`.

  Two small takes-own-medicine fixes landed with the pass:
  `apps/desktop` dropped its re-export of the deprecated
  `OllamaDetectionResult` alias, and `services/api`'s federation-e2e
  tests migrated from the deprecated `PeerRateLimiter` alias to
  `FixedWindowLimiter` directly. The `authToken` field on
  `McpClientConfig` keeps its internal callers intentionally — the
  `StaticCredentialSource` wrapper is the documented deprecation-window
  bridge, matching the doctrine's "wrap + warn + strip at named sunset"
  pattern.

  No runtime behavior change. The post-1.0 `check-deprecation-discipline`
  drift gate (named in the doctrine) will scan a uniform shape across
  the entire codebase with no grandfathered exceptions.

- 9dc5421: Internal hygiene: migrate motebit's own callers off the `verifyIdentityFile`
  legacy shim (`@motebit/crypto`). Every `create-motebit` and `motebit` call
  site now uses the unified `verify()` dispatcher, so the fixed-group 1.0
  publish no longer ships code that consumes its own `@deprecated` API.

  The `verifyIdentityFile` and `LegacyVerifyResult` exports remain published
  from `@motebit/crypto` for external pre-0.4.0 consumers through the
  deprecation window, with their `@deprecated` annotations rewritten to the
  four-field contract (`since 1.0.0, removed in 2.0.0, Use verify(content)
instead, …reason`) required by `docs/doctrine/deprecation-lifecycle.md`.

- 1690469: Wire `BalanceWaiver` producer + verifier (spec/migration-v1.md §7.2). `@motebit/crypto` adds `signBalanceWaiver` / `verifyBalanceWaiver` / `BALANCE_WAIVER_SUITE` alongside the existing artifact signers; `@motebit/encryption` re-exports them so apps stay on the product-vocabulary surface. `@motebit/virtual-accounts` gains a `"waiver"` `TransactionType` so the debit carries a dedicated audit-trail category. The relay's `/migrate/depart` route now accepts an optional `balance_waiver` body — balance > 0 requires either a confirmed withdrawal (prior behavior) or a valid signed waiver for at least the current balance; the persisted waiver JSON is stored verbatim on the migration row for auditor reverification. The `motebit migrate` CLI gains a `--waive` flag that signs the waiver with the identity key and attaches it to the depart call, with a destructive-action confirmation prompt. Closes the one-pass-delivery gap left over from commit `7afce18c` (wire artifact without consumers).
- 3e8e7ec: Close H3 from the `cd70d3d8..HEAD` security audit — add a
  `transaction<T>(fn): T` primitive to `DatabaseDriver` and migrate the
  two raw-`BEGIN`/`ROLLBACK` call sites off hand-rolled strings.

  The prior pattern in `SqliteAccountStore.debitAndEnqueuePending` and
  in `buildCreditOnDepositCallback` issued `db.exec("BEGIN")` /
  `db.exec("COMMIT")` / `db.exec("ROLLBACK")` directly. That's brittle
  under nesting (a second BEGIN throws), under ROLLBACK-after-BEGIN-fail
  (masks the original error), and under driver swap (sql.js has no
  native helper; better-sqlite3 does).

  The new primitive lives at the persistence boundary — one layer below
  `@motebit/virtual-accounts`'s `AccountStore`, where the rule
  "no `withTransaction(fn)` on the ledger interface" still stands.
  Services that need multi-statement atomicity no longer reinvent
  BEGIN/COMMIT.

  Driver implementations:
  - **BetterSqliteDriver** delegates to native `inner.transaction(fn)()`,
    which handles savepoint-based nesting automatically.
  - **SqlJsDriver** runs `BEGIN`/`COMMIT`/`ROLLBACK` on the outer call
    and `SAVEPOINT`/`RELEASE`/`ROLLBACK TO` for nested calls, matching
    the better-sqlite3 shape exactly.

  Call-site migration:
  - `SqliteAccountStore.debitAndEnqueuePending`: wraps the three-statement
    debit + ledger + pending insert in `db.transaction`. The
    insufficient-funds path now returns `null` from the fn (empty
    transaction commits harmlessly); any other throw rolls back.
  - `buildCreditOnDepositCallback` in `services/api/src/deposit-detector.ts`:
    same shape — the credit + dedup-insert pair runs inside `db.transaction`.

  Tests: 10 new in `packages/persistence/src/__tests__/transaction.test.ts`
  covering commit-on-return, rollback-on-throw, null-return semantics,
  nesting (inner throw vs outer throw), and sequential top-level
  independence. Exercised against **both** driver implementations. All
  862 services/api tests and 165 persistence tests still pass. 15 drift
  gates green.

- c3a3e7d: Narrow the fail-open surface in `SqliteAccountStore.getUnwithdrawableHold`
  and `getSweepConfig` (H2 from the `cd70d3d8..HEAD` security audit).

  Before this change, both methods wrapped the real query in a bare
  `try/catch` that returned `0` (no hold) or the null sweep pair on ANY
  SQL error — schema drift, DB locked, malformed state, anything — not
  only the "table absent in minimal test setups" case the comment
  claimed. That opens a withdrawal path the dispute window is supposed
  to gate. Silent money-path fallbacks violate the root `CLAUDE.md`
  fail-closed doctrine ("Deny on error").

  The new shape probes `sqlite_master` explicitly for the expected
  tables before running the real query:
  - **Tables missing** (test setups that skip those migrations) →
    degraded mode preserved (0 / null-pair).
  - **Tables present** → the real query runs unhedged; any error
    propagates to the caller, which is what the withdrawal path needs
    to refuse loudly.

  `scripts/check-deps.ts` gains an `isAutoGenerated(file)` helper that
  skips committed `AUTO-GENERATED` files for both the license-in-source
  check (existing) and the undeclared-deps check (new) — the
  `@motebit/self-knowledge` corpus embeds README code fences containing
  verbatim `import` strings that the regex-based scanner would
  otherwise flag.

  10 new regression tests in
  `services/api/src/__tests__/account-store-fail-closed.test.ts` pin the
  three branches via a mock `DatabaseDriver`: missing-tables degraded
  mode, happy-path real-query execution, and error propagation. The
  existing 7 `withdrawal-hold.test.ts` assertions are unchanged and
  still pass.

- 28c46dd: `getPublicKeyBySuite(privateKey, suite)` — new permissive-floor (Apache-2.0) primitive for suite-dispatched public-key derivation. Closes a real protocol-primitive-blindness violation in the CLI and plugs the regex hole that let it slip past `check-suite-dispatch`.

  A surface-parity audit on 2026-04-18 found that `apps/cli/src/subcommands/delegate.ts` was calling `ed.getPublicKeyAsync(privateKey)` directly via dynamic import — protocol-primitive-blindness as defined in `feedback_protocol_primitive_blindness.md` and the `@motebit/crypto/CLAUDE.md` Rule 1 ("`src/suite-dispatch.ts` is the ONLY file permitted to call `@noble/ed25519` primitives directly"). The violation slipped past `check-suite-dispatch` because its FORBIDDEN_PATTERNS regex `/\bed\.getPublicKey\b/` does not match `ed.getPublicKeyAsync` — `\b` requires a word/non-word transition, and `K` followed by `A` (both word chars) is not a boundary.

  This pass:
  - **`getPublicKeyBySuite(privateKey: Uint8Array, suite: SuiteId): Promise<Uint8Array>`** added to `packages/crypto/src/suite-dispatch.ts`. Sibling to `verifyBySuite` / `signBySuite` / `generateEd25519Keypair` — same exhaustive switch on the `SuiteId` literal union so the TypeScript compiler refuses to compile when ML-DSA / SLH-DSA suites land without an explicit arm. Re-exported through `signing.ts` so it surfaces from `@motebit/crypto`.
  - **Permissive export allowlist updated.** `getPublicKeyBySuite` added to `PERMISSIVE_ALLOWED_FUNCTIONS["@motebit/crypto"]` in `scripts/check-deps.ts`.
  - **CLI delegate path routed through the dispatcher.** `apps/cli/src/subcommands/delegate.ts` now imports `getPublicKeyBySuite` from `@motebit/crypto` instead of dynamically importing `@noble/ed25519`. PQ-ready by construction — when ML-DSA suites land, only the dispatcher arm changes. `apps/cli/package.json` declares `@motebit/crypto` directly (was previously consumed only transitively through `@motebit/runtime`).
  - **Regex hole patched.** `scripts/check-suite-dispatch.ts` adds `\bed\.getPublicKeyAsync\b` to FORBIDDEN_PATTERNS and tightens the existing `\bed\.getPublicKey\b` to `\b...\b(?!Async)` matching the established convention used by `verify` / `sign` (every primitive name has both a sync rule and an explicit Async rule). The next time anyone tries to call `ed.getPublicKeyAsync` outside the dispatcher, CI fails immediately.

  The Ring 1 doctrine ("capability, not form") is unchanged — surfaces correctly continue to consume crypto through `@motebit/encryption` (which re-exports from `@motebit/crypto`) where appropriate. Adding `check-surface-primitives` to mandate dep declarations was considered and rejected: the existing `check-suite-dispatch` already covers the real failure mode (direct `@noble` calls); the dep-declaration question is style, not architecture.

- a792355: Close the idempotency contract on `debitAndEnqueuePending`.

  The `AccountStore.debitAndEnqueuePending` interface documented an
  idempotency key for "external replay protection" that neither
  implementation honored — a second call with the same `(motebitId,
idempotencyKey)` would silently debit the account a second time and
  insert a duplicate `relay_pending_withdrawals` row. The parameter was
  live wiring (plumbed through `enqueuePendingWithdrawal` and the sweep
  loop) waiting for a consumer to discover the gap.

  Fix mirrors the sibling `requestWithdrawal` + `insertWithdrawal`
  pattern that already exists for user-initiated withdrawals: a replay
  pre-check inside the compound primitive, plus a schema-level partial
  UNIQUE INDEX as belt-and-suspenders.
  - `packages/virtual-accounts`: both `InMemoryAccountStore` and the
    interface contract doc describe the replay semantics — on
    `idempotencyKey !== null` match, return the existing `pendingId` and
    current balance without debiting or inserting again. `null` keys are
    never deduplicated.
  - `services/api`: `SqliteAccountStore.debitAndEnqueuePending` gains the
    same pre-check. Migration v12 adds
    `idx_pending_withdrawals_idempotency` — a partial UNIQUE INDEX on
    `(motebit_id, idempotency_key) WHERE idempotency_key IS NOT NULL` —
    so a direct INSERT that skips the primitive still hits the guard.
    Mirrors `idx_relay_withdrawals_idempotency` byte-for-byte.

- c757777: Rename `createGoalsController` / `GoalsController` / `GoalsControllerDeps` in
  `@motebit/runtime` to `createGoalsEmitter` / `GoalsEmitter` / `GoalsEmitterDeps`.

  The runtime's goals primitive is a goal-lifecycle event emitter — it authors
  `goal_*` events against the event log. The previous name collided with the
  completely different `createGoalsController` in `@motebit/panels`, which is a
  subscribable UI state machine for rendering a goals panel. Two functions with
  the same name, same return-type name, different signatures, different
  semantics, different layers.

  The panels pattern (`createSovereignController`, `createAgentsController`,
  `createMemoryController`, `createGoalsController`) is a consistent 4-family
  UI-state-controller convention and should keep its name. The runtime primitive
  is the outlier; renamed to reflect its actual role (an emitter, which is also
  how it is already described in the `runtime.goals` doc comment and in
  `spec/goal-lifecycle-v1.md §9`).

  ### Migration

  ```ts
  // before
  import { createGoalsController, type GoalsController } from "@motebit/runtime";
  // after
  import { createGoalsEmitter, type GoalsEmitter } from "@motebit/runtime";
  ```

  `runtime.goals` retains the same type shape (only the name changed).
  No wire-format or event-log impact; this is a type-surface rename only.
  `@motebit/panels` exports are unchanged.

- be2dba3: Add Tavily as an agent-tuned primary search provider in `@motebit/tools`
  and slot it at the head of the `services/web-search` fallback chain.

  Motivation: generic open-web indexes (Brave, DuckDuckGo) rank by
  backlink density and ad-supported signals. For niche or new domains —
  like first-party content on motebit.com today — recall is
  disproportionately poor. The three-tier answer engine already biases
  self-queries via `BiasedSearchProvider`, but the underlying index
  matters once the query escapes first-party domains. Tavily is tuned
  for agent RAG: structured JSON response, no HTML to parse, ranking
  designed around what an agent actually reads.

  Provider chain after this change, in `services/web-search`:

  BiasedSearchProvider
  └─ FallbackSearchProvider
  ├─ Tavily (if TAVILY_API_KEY set — primary)
  ├─ Brave (if BRAVE_SEARCH_API_KEY set — fallback)
  └─ DuckDuckGo (always — last resort)

  Each tier is opt-in via env var; a deploy with neither paid key runs
  on DuckDuckGo alone. No interface change on `SearchProvider`, so the
  relay's browser-side `ProxySearchProvider` sees the upgrade transparently.

  Package surface:
  - `TavilySearchProvider` + `TavilySearchProviderOptions` exported from
    `@motebit/tools` root and `@motebit/tools/web-safe`.
  - Constructor accepts an injected `fetch` for tests; defaults to
    `globalThis.fetch`.
  - Constructor accepts `searchDepth: "basic" | "advanced"` (default
    "basic"). `include_answer` is forced off — synthesis happens in
    `services/research`, not in the provider.

  Tests: 9 in `packages/tools/src/providers/__tests__/tavily-search.test.ts`
  covering wire shape (POST + body fields), searchDepth override,
  content→snippet mapping, defensive filtering of incomplete results,
  empty responses, HTTP error propagation (401 / 429 / large-body
  truncation), and fetch-level network errors. Service wiring in
  `services/web-search/src/index.ts` reorders the chain Tavily →
  Brave → DuckDuckGo, `.env.example` documents the new var.

  All 151 @motebit/tools tests + 15 drift gates pass.

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

All notable changes to the `motebit` CLI are documented here. For full project history, see the [root changelog](../../CHANGELOG.md).

## [0.3.0] - 2026-03-13

### Added

- `motebit id` subcommand — display identity card (motebit_id, did:key, public key, device)
- `motebit credentials` subcommand — list and inspect W3C Verifiable Credentials
- `motebit ledger <goalId>` subcommand — view execution ledger for a goal
- `/graph` command — memory graph health summary
- `/curious` command — show fading memories the agent has noticed
- `/agents` enhanced — trust levels, Beta-binomial reputation, task history
- Intelligence gradient display in `/state`
- Curiosity-driven memory maintenance during conversations
- `motebit export` expanded — writes full bundle directory (identity + credentials + presentation + budget + gradient)
- `motebit verify <dir>` expanded — validates identity files, VC proofs, VP integrity, and bundle cross-references

## [0.2.0] - 2026-03-10

### Added

- Published to npm as `motebit`
- REPL chat, daemon mode, operator console, MCP server mode
- Subcommands: `id`, `export`, `verify`, `run`, `goal`, `approvals`
- Slash commands: `/model`, `/memories`, `/graph`, `/curious`, `/state`, `/forget`, `/export`, `/sync`, `/clear`, `/tools`, `/mcp`, `/agents`, `/operator`, `/help`, `/summarize`, `/conversations`, `/conversation`, `/goals`, `/goal`, `/approvals`, `/reflect`, `/discover`
- MCP server mode (`motebit --serve`) with stdio and HTTP transport
