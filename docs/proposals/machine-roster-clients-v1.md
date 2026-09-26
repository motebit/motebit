# Machine roster, part C: the clients mint, keep and reduce

Status: design note, **before code**. v3 takes every change from design review rounds 1 and 2 (records in §4). Round 3 (final) **approved it for build**. Its required changes are §2A, which is normative and takes precedence over §2 wherever they differ.

- Law (merged): `spec/machine-roster-v1.md`; `verifyHostRoster` and the signers in `@motebit/crypto` (#697).
- Relay (merged, live v974): `docs/proposals/machine-roster-relay-v1.md` (#768, #770).
- Doctrine: `docs/doctrine/machine-roster.md`.

## 0. Where we are

Part B is live and **inert**: the relay can store entries and observe hosts, but no client mints an enrolment, so every roster is empty. That is the dormant-enforcement state `composition-preserves-enforcement.md` names. Part C is what makes the roster exist.

The relay never reduces (part B, D1–D7). So every claim about "the machines of this motebit" is computed on a client, which makes the client's **key chain** the load-bearing input. Part B's review (F3) established that no client holds one today:

- key transfer carries only the seed;
- only the rotating surface's `motebit.md` gains a `succession` record;
- `config.json` has no key history.

Part C therefore has two halves, and the first is the one that can go wrong:

1. **Chain acquisition**: which key chain a client reduces under, and why it may trust it.
2. **Minting, keeping, presenting and reading**: enrolments from hosts, retirements from any key holder, the local replica, and the renderings.

## 1. Facts this design rests on (from the code, 2026-09-25)

**The law's API** (`@motebit/crypto`, `host-roster.ts`):

- `signHostEnrollment({motebit_id, device_id, public_key, enrolled_at}, priv)` builds its fields one by one and asserts that `public_key` is derived from `priv`.
- `signHostRetirement({motebit_id, enrollment_id, public_key, retired_at}, priv)`.
- `hostEnrollmentId` / `hostRetirementId`.
- `verifyHostRoster({motebitId, keyChain /* oldest→newest */, enrollments, retirements})` returns either `{ok:false, reason: malformed_input|empty_chain|malformed_key|duplicate_key}` or a verdict:
  - `chain_head`
  - `active` / `retired` / `superseded` machines, each carrying `authenticated` (true iff its epoch equals the head's)
  - pending `tombstones`
  - `rejected`, with reasons malformed / wrong_motebit / untrusted_key / bad_signature.

**Succession primitives:**

- `verifySuccessionChain(chain, guardian?)` returns `{valid, genesis_public_key, current_public_key, length, error?}`. It checks signatures, continuity, and strictly increasing timestamps.
- `verifySovereignBinding(motebitId, genesisKey)`.
- The public `GET /api/v1/agents/:id/succession` returns `{chain, current_public_key, held_public_key}`. Today only the panels Sovereign controller reads it, and it displays the chain without verifying it.

**Hosts.** Only CLI `run` and `serve` announce `unattended_runtime` (`apps/cli/src/daemon.ts`). Mobile, desktop, web and spatial never do, and the doctrine says the phone must never be one. Both host commands hold the decrypted identity key at start, call `registerWithRelay`, and connect the sync socket.

**Auth.** `signedRelayHeaders(identity, audience)` (`apps/cli/src/relay-registration.ts`) mints a device-key token. The subcommand helper `getRelayAuthHeaders` prefers the **master token** when one is configured, and the roster routes refuse the master token with 403. Mobile mints with `createSyncToken(aud)`.

**Rotation.** Surface-kit's `performKeyRotation` owns the procedure. The CLI's `commit` port sees the new private key, and the phone has an `onCommitted` callback. Rotation rewrites the relay's device rows to the new key (`succession-apply.ts`), so a host still on the old key gets 401 on the roster routes. The only way a CLI host gets the new key is restore, which gives it a fresh `device_id`.

**Chain facts the review surfaced:**

- `readSuccessionChain` orders rows by timestamp, and `verifySuccessionChain` requires timestamps to increase strictly. Two genuine rotations recorded out of order (#706) therefore fail in either order.
- A recovery link fails without a guardian key, and `/succession` serves none.
- `/rotate-key` accepts a rotation back to an earlier key, giving `[A,B,A]` (#775).
- `run` reads `./motebit.md` only, `rotate` searches the working directory, its parents and `~/.motebit/identity.md`, and ambient `serve` reads none.
- The installer (#685) is **not built**. Copying `~/.motebit` to a VPS copies `device_id`, so today an ambiguous machine is the default setup.

**Files.** New `~/.motebit` files go through `durable-file.ts` (`writeFileAtomic` 0600, `withFileLock`, the three-way read). `check-cli-surface` locks subcommands, flags and `~/.motebit` paths against a baseline.

## 2. Decisions

### C1: the key chain, by linkage, from what the client holds

**The principle (design review round 2, B3; spec §6 property 7, suffix invariance).** For any chain suffix that contains the head, `active` and `chain_head` are the same. Retirements under keys that were dropped cannot end enrolments at the head epoch (Rule A). So **ancestry never changes the quantified set.** It changes only advisory lines: superseded and old-epoch retired ones. It follows that ancestry problems are **disclosures that stop the walk**, never refusals. A refusal here would buy nothing and could strand a motebit for good.

**A new primitive in `@motebit/crypto`** (protocol primitives belong in packages): `resolveRosterKeyChain({ motebitId, held, records, cached, guardianKey? })`, where `records` is the union of every succession record the client can see (C1.4). It returns one of two results:

- a chain (oldest to newest) together with `ancestry: rooted | unrooted | forked_below(K) | recovery_limited(K) | branch_seen(K)`, the links the relay is missing, and whether universal claims are suppressed;
- or one of **three refusals**, and nothing else.

1. **Walk backward from `held` by linkage.** For the key `K` at the current position, collect the records whose `new_public_key` is `K`, and verify each one: `verifyKeySuccession` for a normal link, the pinned guardian for a recovery link. Verified records are deduplicated by `(old, new)`. **Timestamps are never used**: spec §6 uses only the relative order of epochs, and linkage gives that order, so #706 is harmless.
   - **Exactly one verified predecessor:** prepend it and continue.
   - **None:** stop. This is the earliest key this client can prove. If `motebitId` has the sovereign shape (a UUID v8 or `did:key`, decidable from the id alone) and that key binds to it (`verifySovereignBinding`), the ancestry is `rooted`; otherwise it is `unrooted`.
   - **Several verified predecessors at an ancestor key `K ≠ held`:** stop at `K` and disclose `forked_below(K)`. The disclosure says: "two histories lead to K; the holder of K signed both, so K was compromised." A second predecessor needs `K`'s own new-key signature, so only the holder of `K` can make one (round 2, R11).
   - **Optional, for sovereign ids:** at a fork, the branch that roots to the id may be chosen. Stopping is enough.
   - **A recovery predecessor that cannot be checked** (no pinned guardian), alone or next to a verified normal predecessor: stop at `K` and disclose `recovery_limited(K)`.
2. **The three refusals** (`ok: false`, no roster):
   - **`duplicate_key`:** a cycle through `held` (#775): `held` is its own verified ancestor. It needs a record with `old == held`, so only the holder of `held` or the guardian can cause it. This refusal is checked first. A repeat met strictly below `held` is ancestry, which old-key holders alone can mint, and is disclosed as `cycle_below(K)`, never refused.
   - **`fork_at_held`:** two verified predecessors of `held` itself, which only the holder of `held` can create.
   - **`held_key_superseded`:** a verified successor of `held` **on the resolved path**, meaning a record with `old == held` whose new key reaches the served or held head. This client's key was rotated away. A normal record of this kind carries `held`'s signature; a recovery record carries the guardian's (R11). The remedy text depends on the state (R15):
     - if a rotation write-ahead exists (a crash after the relay recorded the link, before the local commit): "finish the rotation: `motebit rotate` resumes it";
     - otherwise: "this machine's key was rotated away; restore on it to rejoin".
3. **The cache is an input, never a gate** (round 1, B1). Its links are among the `records`, so a relay that lost its database, or a new relay serving `[]`, costs nothing; the result reports "the relay is missing k links this device holds". **Sibling branches** (the cache holds `…A→B` and a verified `A→C` exists; round 2, R12):
   - **This device holds C:** accept C. B is rendered as an abandoned branch.
   - **This device holds B, and the sibling `A→C` is guardian-verified:** that is a legitimate recovery this device is not on. Universal claims are suppressed: "the chain has a branch this device is not on".
   - **The sibling is signed normally:** that proves A was compromised. Disclose `branch_seen(A)` and do not suppress. Suppressing here would hand an old-key thief a permanent denial of service.
4. **Record sources** (round 1 R8, round 2 R16):
   - the cached chain;
   - the served `/succession` chain;
   - every findable `motebit.md` whose `motebit_id` matches and whose signature verifies;
   - the config `_identity_file` written by restore, and desktop's `_identity_file`;
   - the rotation hook, which appends the new link to the cache directly (C3).
5. **The guardian comes from a pinned local source only:** `motebit.md` `guardian`, or config. Never from the relay.
6. **Untrusted entries are disclosed for every id, not only legacy ones.** An enrolment refused as `untrusted_key` under a key that is not a known device key (a key this client cannot place in its chain) is counted in "not covered" (spec §7). Truncation therefore never drops a machine from the caveat, whatever the ancestry.
7. **The relay's `current_public_key` is a hint only.** If it names a key outside the resolved chain, universal claims are suppressed: "the relay reports a newer key; this device has not seen that rotation". It is never an input to the chain.
8. **Rooting never gates anything**: not minting, not rendering, not retiring. It only labels ancestry.

**The residual, stated plainly.** Only three parties can make a client refuse a roster: the holder of `held` (a fork at it), a rotation of `held` itself, and a repeated key. A hostile relay can only withhold, and withholding is disclosed. The holder of an old key can only disclose itself, through a fork or a branch below its own key.

### C2: one controller, many surfaces

- **Where it lives.** The four-question test (`surface-controller-extraction.md`) passes, so C1's consumer logic and C3–C6 live in `@motebit/surface-kit` as `MachineRoster`. Surface-kit consumes the new primitive through `@motebit/encryption`, which is already its layer-1 dependency (the primitive is re-exported there), rather than adding a direct `@motebit/crypto` edge. Adopters are registered in `check-surface-controller-adoption` with ceilings.
- **Ports:**
  - `motebitId`
  - `deviceId`
  - **`signer()`**, which returns `{ publicKeyHex, sign(body) }` with `publicKeyHex` **derived from the private key**, and is resolved **on every call** (review R7). The chain anchor `held` is that derived key. This one port removes the drift the review found: the daemon keeps a key in memory across `motebit rotate`, and `serve` takes its public key from `motebit.md` and its private key from config. The rotation hook passes an explicit signer built from the new `privateKeyHex` that `commit` receives.
  - `fetchSuccession`, `fetchRoster` and `presentRoster`, all authenticated with a device-key token. The CLI mints them with `signedRelayHeaders`, **never** with `getRelayAuthHeaders`, which prefers the master token that the roster routes refuse.
  - `localSuccession()`
  - `pinnedGuardian()`
  - `cache {load /* three-way: absent | value | corrupt */, save}`
  - `now`

### C3: minting enrolments, decided by status (review B2)

Minting is tied to **announcing `unattended_runtime`**, not to a command name (review N8). Whatever surface announces it must pass through this step first, so a future host surface cannot announce without enrolling.

The decision is taken on the **current** verdict over **the cache ∪ a successful fresh GET**:

| This device's status                                                  | Action                                                                                                                                                                                   |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| verdict **refused** (any `ok:false`)                                  | Mint nothing, and print the refusal's remedy (C1.2).                                                                                                                                     |
| **active** at the head                                                | Re-present the stored bytes. Mint nothing.                                                                                                                                               |
| **retired** at **any** epoch                                          | Mint nothing. Print "retired from the roster but running; `motebit machines enroll` to rejoin, or rotate if the retirement was not yours". The line renders as _retired, but connected_. |
| **superseded**, with a frozen verdict of **active**                   | Mint under the head key.                                                                                                                                                                 |
| **superseded**, with a frozen verdict of **not-active** or **absent** | Mint nothing. Print the `enroll` remedy. The line shows as superseded, "not covered".                                                                                                    |
| **no line**                                                           | Mint the first enrolment.                                                                                                                                                                |

- **The frozen pre-rotation verdict** (spec §6, "its own last-verified view"; round 2, R13):
  - It is this device's own status in the verdict taken at the moment its chain first extended past that epoch. That verdict is taken over **the cache ∪ a successful GET**: before the local commit under the old key, or after it under the new key.
  - If that GET fails, the frozen value is `absent`.
  - It is persisted as three states (`absent | active | not-active`), keyed by `(motebit_id, device_id)`. A restore to another identity or a new `device_id` does not inherit it.
- **Why "frozen" and "current" point in different directions** (round 2, R14). The table reads the **current** status, so a late retirement signed under an old key moves this device to the retired row and blocks it from rejoining automatically. That is the safe direction. The frozen value protects in the other direction only: an old-key holder cannot re-enrol a machine the sovereign retired, because only a frozen `active` mints. **This holds only under R21 option (a)** (§2A): a frozen value derived after the link recorded — option (b) — is itself writable by the old-key holder, and the sentence above is then false (#785).
- **When nothing is minted:** a failed GET, or a cache read that returns `corrupt`. Re-presenting bytes already held is always fine. A corrupt cache is set aside with `preserveAside` and never overwritten.
- **The rotation hook.** If the rotating surface is a host whose frozen verdict is `active`, it signs its new-key enrolment with the explicit new-key signer. It also appends the new link to the cached chain.
- **A superseded host is locked out of the relay** (round 1, N1). Rotation rewrote its device row, so its roster calls get 401. `motebit machines` renders that as "this machine's key was rotated away" and offers to retire the old line from a current-key surface.
- **Seed-only restore after a rotation** re-derives the id from the current key, so it yields a **different motebit** with no roster continuity (round 1, N2). Stated, not fixed here.

### C4: retiring, and undoing a retirement

- `motebit machines retire <device_id>` acquires the chain (C1) and reduces. It signs one `HostRetirement` per standing entry of that machine under the signer, caches the retirements, and presents them.
- The id must match an `active` or `superseded` line. If it matches only a connected-but-unenrolled device, the command says so and refuses, because there is nothing to retire.
- Retiring a **superseded** line is advisory (`authenticated: false`; an old-key holder can undo it), and the output says so (round 1, N9).
- **Undo** (round 1, R9): `motebit machines enroll <device_id>` lets the sovereign re-enrol **another** machine's id. This is an explicit act by the key holder. `device_id` honesty is only a software-rung convention, and the doctrine already says the relay never adjudicates between holders of one key. So a mis-tap on the phone is undone from any surface. It cannot reopen #698: signing needs the identity key, and an old key mints only advisory lines.
- **`enroll` refuses, or asks for `--force`,** when the result would be an active line that can never answer (round 2, R17):
  - the id has no existing line and is not this device's own, so a typo would become a permanently unreached active line;
  - every line of the device is superseded, so it cannot hold the head key and its socket is always bound under an old key;
  - liveness shows the id bound under a known device key: a device linked without the identity key.
- The phone asks for **no confirmation**, which is calm software: the change is visible and can be undone.
- **A thief with the current key** can retire a real machine. At the software rung that is the sovereign's power (review N4). The line renders as "retired under the current key", and the start message names **rotation** as the remedy as well as `enroll`.

### C5: the replica, presentation, and set-pinning

- **What the replica holds:** every key-holding surface keeps the entries it verified against its accepted chain (verify-before-hold), plus the accepted chain and the frozen pre-rotation verdict. On the CLI that is `~/.motebit/machine-roster.json`, written with `writeFileAtomic` 0600 under `withFileLock`. It joins the key-file shared-names table, with the CLI as its only writer. Mobile and desktop keep it in their app stores.
- **Presentation:**
  - Presented after every successful registration, mint and retire, in chunks of 64 or fewer.
  - A 422 or 413 means **not taken**: it is logged with the refused ids and retried at the next presentation.
  - Exception: `roster_full` is permanent, so it is reported once and never retried (round 1, N7). Ids refused this way are excluded from the set difference below (round 2, R20).
- **Which foreign entries to present** (round 2, Q3). The relay's shared foreign bucket is 256 entries (part B D2), so a replica presents a **minimal support set**: for each non-active machine, its enrolments at its highest epoch H and the retirements naming them. It never presents history below H (irrelevant under Rule B), and never the old-epoch entries of machines that are active at the head. Standing superseded lines go first. Exhausting the foreign bucket can cost only advisory lines, never active ones.
- **Set-pinning is a set difference** (round 1, R6). The relay never prunes (part B, D3), so **any** remembered id missing from the served set is an omission, whatever the counts: `(cache_ids \ roster_full_ids) \ served_ids ≠ ∅` gives "the relay is missing these N entries this device holds", and the client re-presents them.

### C6: rendering

`motebit machines` (with `--json`) and the phone's view follow part B's D6, with the precedence fixed (review R5):

1. Active machines, joined with liveness on `(device_id, bound_under == enrolment key)`. "Socket open" is worded as the relay's belief, since there is no heartbeat (#691).
2. **Rows whose `bound_under` is in the chain but is not the head** are rendered as "socket open under a superseded key: this machine's daemon before it restarted, or any holder of that key". This rule comes **before** the theft rule, because after every rotation the rotating machine's own still-running daemon matches it (#767).
3. **Rows bound under a known device key** (a device linked without the identity key, part B D6(c)) are rendered as "a linked device without the identity key", never as theft. The consumer knows these keys from the roster's `untrusted_key` refusals under device keys, and from its own devices list.
4. **Rows for a machine's `device_id` under a key this device cannot place in its chain** are the possible theft signal: "connected under a key this device cannot place in this motebit's chain". Never "not this motebit's": with truncated ancestry that key may be one of this motebit's own old keys (round 2, R18).
5. "Connected, not in the roster".
6. Superseded lines are advisory and shown as "not covered".
7. "Not observed in the last 90 days" is kept distinct from "never seen".
8. **A possibly ambiguous machine** (round 1 R10, round 2 R19): `sockets_open > 1` on one `(device_id, key)` on **two successive reads** gives a hint worded as "may": "two machines may share this id (copied `~/.motebit`)". `sockets_open` counts any bound socket, including an interactive session beside the daemon and a half-open socket next to its reconnect. So it is a hint, never a verdict, and `run` and `serve` do not print it at start until there is a heartbeat (#691).
9. The chain head is cited, along with the ancestry (C1) and the relay's missing links and entries.
10. **No count or quantifier** is rendered unless it is computed over `active` in an `ok:true` verdict, and never when C1.3 or C1.7 has suppressed universal claims.

**Placement on flat surfaces:** Settings, beside devices and keys. It is a record in a panel, with no toast and no badge.

**Devices linked without key transfer** (review N6) do not hold the identity key, so they cannot anchor by possession, and they have **no roster** in C-1. C-2 decides whether a pinned, read-only rung is worth adding for the phone.

### C7: scope and increments

- **C-0:** `resolveRosterKeyChain` in `@motebit/crypto` (re-exported by `@motebit/encryption`), with property tests:
  - the three refusals, and only those three;
  - an ancestor fork, an unverifiable recovery link, and truncation, each **disclosed, never refused**;
  - out-of-order timestamps (#706);
  - the cache as an input after relay loss;
  - sibling branches (C1.3);
  - **suffix invariance:** `active` is identical under every resolvable suffix (property 7, pinned against the law).
- **C-1:** the surface-kit `MachineRoster` controller (C1 consumer logic plus C3–C6), and the CLI. The CLI part covers:
  - mint on announce in `run` and `serve`;
  - `machines`, `machines retire`, `machines enroll`;
  - the rotation hook;
  - the cache and the shared-names row;
  - the `check-cli-surface` baseline and the CLI docs.
- **C-2:** mobile, desktop and web: the replicas, the Settings rendering, and the phone's retire and enroll.
- **Also needed:** spec §6 is amended so that "prefix-extension" is replaced by C1's linkage rules. It spells out the sibling-branch cases and states the suffix-invariance principle behind "disclose, don't refuse".

## 2A. Round-3 amendments (normative; these take precedence over §2)

- **Head citation (§0).** `chain_head.epoch` is an index into the view it was computed in, so it changes under truncation. Only `chain_head.public_key` is invariant. C1 and C6 cite the head by **key fingerprint**, never by epoch number. Wherever §2 says "`active` and `chain_head` are the same", read "`active` and the head's public key".
- **R21: when the frozen verdict is taken.** Once the relay records the link, device rows move to the new key, and an old-key GET gets 401.
  - **Option (a) is REQUIRED:** the status is captured **before the rotation POST**, under the old key, over the replica ∪ a successful roster GET ∪ a successful `/succession` read (any failed read captures `absent`), and persisted in the replica (`rotation_captures`, keyed by `(device_id, from_key)`). The hook, after the local commit and under the new key, reads **only that capture**, keyed by the rotation record's old key. It never re-reduces the inputs as they stand after the link.
  - **Option (b) is REFUSED** (#785, withdrawn at its decisive round). Reducing the current inputs over the pre-rotation chain after the commit is poisonable: between the relay recording the link and the hook (a held rotation resumed later, an interrupted commit finished later, or the ordinary second between them), a holder of the old key can present a fresh old-key enrolment for this device, and the re-reduction reads it as "active before the rotation". The hook then mints under the new key: a machine the sovereign retired becomes active and authenticated, with no explicit act.
  - **Resume paths** (`held` then a later rotate, `interrupted-commit-finished`, `already-held`) use the capture the **original** attempt took: a surface never captures while a rotation write-ahead exists. No capture (an older client, a crash before it) is `absent`: no automatic mint, the `enroll` remedy.
  - **A capture of `active` names the enrolments that made it so.** The hook mints only while one of those enrolments still stands at the old epoch, and only through the locked C3 table (a retirement in the current verdict wins). Otherwise a retirement the sovereign signed after the capture, followed by an old-key holder re-lighting the line with a fresh enrolment, would be read as the line the capture saw (found by the seeded property test, seed 117).
  - **Only a line this device minted for itself counts** (#786). The replica records the ids of the enrolments this surface minted for its own device (`own_minted`); a capture reads `active` only through one of those, and the hook's `authorizes()` re-checks it under the mint lock. Otherwise the holder of the key being rotated away — still current until the rotation — could, after the sovereign retired this machine, present a fresh enrolment for it, and the rotation would carry that line into the new epoch, authenticated.
    - **Stated cost (fail-closed):** a machine whose line was enrolled only by an explicit `enroll` from ANOTHER surface is not re-enrolled by its own rotation; after rotating it needs `motebit machines enroll <device_id>` again. So does a machine whose replica was lost (its `own_minted` record went with it). The CLI's superseded start line says so.
  - The frozen `active` is persisted only in the mint's own save (F2). The hook reports what is actually persisted, and `already-active` (nothing frozen) when the line was already active under the new key.
  - A CLI capture is skipped only for a **resumable** write-ahead (this identity, naming the held key on either side); a stale one, which the kit sets aside before a fresh rotation, does not block a fresh capture. The capture's roster GET runs in parallel with its succession read.
- **R22: key the frozen value by epoch.** It is keyed `(motebit_id, device_id, pre-rotation head key)`. A value is read only when its key equals the key of the machine's current `H`. A value left over from an earlier transition is never read.
- **R23: `held_key_superseded`.**
  - **Definition:** any verified record with `old == held`, either normal (signed by `held`) or a guardian-verified recovery.
  - **Remedies, checked in this order:**
    1. A rotation write-ahead exists: "finish the rotation: `motebit rotate` resumes it".
    2. The on-disk config key is `held`'s verified successor (a running daemon that loaded its key before a local rotate, #767): "this process holds a key the local config has rotated past; restart it".
    3. Otherwise: "this machine's key was rotated away; restore with the **current** key's seed or `motebit.md` to rejoin".
- **R24: C3 and C4 agree.** This device's **own** id is exempt from C4's "every line superseded" refusal of `enroll`, because its signer holds the head key by construction.
- **R25: the "not covered" disclosure.**
  - Count only `kind: enrollment` refusals. Take each `device_id` from the raw input (a rejection carries no `device_id`), dedupe by device, and exclude devices already in any bucket.
  - Device-key status only **relabels** an entry; it never removes it from "not covered".
  - The source of known device keys is named explicitly: the client's own devices list. The relay's devices route is labelled relay-attested.
  - The wording is "keys this device cannot place in its chain (older or newer)", never "superseded keys".
- **R26: evidence of a rotation survives relay loss.** Every verified succession record a client has ever seen is persisted as a C1.4 record source, **including those seen on refusal paths**. So `held_key_superseded` stays in force across a relay's database loss or a relay switch.
- **R27: set-pinning and the support set.**
  - The set difference is computed over the ids this replica **presents**: its support set plus its own-bucket entries.
  - The support set includes **pending tombstones** (retirements whose enrolment is absent).
  - While the difference is non-empty (the relay is omitting something), universal claims are suppressed, and that GET counts as failed for C3 and for the frozen verdict, until a re-read shows the difference empty.
- **R28: buildability.** C-0 adds `verifyHostRoster`, `signHostEnrollment`, `signHostRetirement`, `hostEnrollmentId`, `hostRetirementId` and `resolveRosterKeyChain` to the re-exports in `@motebit/encryption`.
- **N10: the genesis key ends the walk.** For a sovereign-shaped id, a key that binds to the id ends the walk. Any predecessor of it is disclosed, never walked.
- **N11: fork wording.** The disclosure says "the holder of A signed two successors", not "A was compromised"; two offline rotations on two surfaces produce the same thing honestly. C1.7 still suppresses when a normal sibling is the relay's head.
- **N12: two C6 wording fixes.**
  - C6.2 says "socket open" only when `sockets_open > 0`, and otherwise "last seen under a superseded key".
  - After a restore that gives a fresh `device_id`, offer to retire the prior line.
- **N13: ordering with #775.** C-0 lands after #775, or its tests pin the behaviour against it.
- **C-0 build notes.** These record where the primitive (`resolveRosterKeyChain`) departs from this text:
  - **No `cached` key-list input.** The cache is passed as **signed records** among `records`. A key list carries no signatures, so the primitive could only trust it (storage acting as authority) or ignore it, which would silently give `[held]` after a relay loss. R26's persisted records are the cache.
  - **`duplicate_key` is a cycle through `held`, and only that.** A rotation back to a non-genesis key (K0→K1→K2→K1, with K1 held) gives `held` two predecessors, and would otherwise read as `fork_at_held`. A reachability check over verified links runs first, and N10 does not stop it. A cycle strictly below `held` (an old-key self-loop, or a 2-cycle minted below the head, with or without the linking record withheld) stops the walk before the repeat and is disclosed as a fifth ancestry kind, `cycle_below(K)`: by property 7 it cannot change the active set. Self-loops are never reported as a branch or as a genesis predecessor; they cannot be real rotations, and the relay refuses them.
  - **`malformed_input`** is refused for a malformed _call_ (empty id, non-canonical `held` or guardian, `records` not an array). No record content can produce it.
  - **A recovery record with no pinned guardian** is checked for its new key's signature only. It can count as a predecessor (giving `recovery_limited`), but never as a successor or a branch, because anyone can mint one to their own key.
- **C-1 build notes.**
  - **`knownDeviceKeys` is absent on the CLI**: it keeps no devices list, so C6.3's "linked device" relabel, R17c's `enroll` refusal and R25's relabel never fire there. They are implemented and tested in the kit; the phone and desktop supply the port in C-2.

## 3. Open questions (none remaining)

Round 3 answered all three: no remaining refusal strands a routine state; C3's directions are exhaustive, with the residual being spec §9's undetectable omission, narrowed by R27; and the false wordings are fixed in §2A.

## 3-old. Open questions put to round 3

1. Does any remaining refusal (C1.2) strand a motebit in a routine state?
2. Are the frozen and current directions in C3 exhaustive: is there any sequence where a machine the sovereign retired mints again with no explicit act?
3. Is any C6 wording still false in some state?

## 4. Design review record

**Round 1 (2026-09-25): "sound with required changes".** Everything below was taken into §2.

| Finding | Severity     | Change                                                                                                                                               | Where        |
| ------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| B1      | BLOCKING     | Extension-only against the served chain stranded every client after relay DB loss; the cache is now an input, and the only refusal is a conflict     | C1.3         |
| B2      | BLOCKING     | The start rule un-retired machines through routine rotation; replaced by a status table over cache ∪ a fresh GET, with a frozen pre-rotation verdict | C3           |
| R1      | Required     | #706: timestamp ordering made genuine chains unverifiable; a linkage walk in a crypto primitive                                                      | C1.1, C7 C-0 |
| R2      | Required     | Guardian source undefined; now a pinned local guardian, and an uncheckable recovery link is disclosed rather than refused                            | C1.5         |
| R3      | Required     | Threat model was backwards (truncation, not invention); `chain_not_rooted` for sovereign ids, and legacy truncation disclosed                        | C1.4         |
| R4      | Required     | One junk record could deny a roster; unrelated records are now ignored, and `held_key_superseded` is its own refusal                                 | C1.1–C1.2    |
| R5      | Required     | The rotating machine's own daemon was shown as the theft signal; precedence fixed                                                                    | C6           |
| R6      | Required     | Set-pinning was a count; now a set difference                                                                                                        | C5           |
| R7      | Required     | A key port and a sign port could drift; one per-call `signer()`                                                                                      | C2           |
| R8      | Required     | "The local `motebit.md`" named no single file; sources enumerated, and the rotation hook appends to the cache                                        | C1.6         |
| R9      | Required     | A phone retire could not be undone; `machines enroll <device_id>`                                                                                    | C4           |
| R10     | Required     | The installer (#685) is not built; copying `~/.motebit` gives an ambiguous machine by default; a hint added                                          | §1, C6       |
| N1–N9   | Non-blocking | Taken. N3 is filed as #775                                                                                                                           | §1, C1–C6    |

**Round 2 (2026-09-25): one BLOCKING.** Everything below was taken into §2.

| Finding | Severity | Change                                                                                                                                                                                                                                                       | Where     |
| ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| B3      | BLOCKING | `chain_not_rooted` stranded a rotated sovereign motebit on any cacheless surface after relay DB loss or a guardian recovery, and protected nothing (property 7). Rooting, ancestor forks and recovery limits are now disclosures; only three refusals remain | C1        |
| R11     | Required | Fork and signature claims corrected; an unverifiable recovery link next to a normal one stops and discloses                                                                                                                                                  | C1.1–C1.2 |
| R12     | Required | Sibling branches: accept when held; suppress on a guardian-verified branch; disclose on a normal one                                                                                                                                                         | C1.3      |
| R13     | Required | The frozen verdict is taken over cache ∪ GET, persisted as three states, and keyed by device                                                                                                                                                                 | C3        |
| R14     | Required | Current vs frozen directions stated; refused and no-frozen rows added                                                                                                                                                                                        | C3        |
| R15     | Required | Remedy for `held_key_superseded` when a write-ahead exists; `duplicate_key` checked first                                                                                                                                                                    | C1.2      |
| R16     | Required | `_identity_file` added as a record source                                                                                                                                                                                                                    | C1.4      |
| R17     | Required | `enroll` refuses a line that could never answer                                                                                                                                                                                                              | C4        |
| R18     | Required | Known device keys are not theft; "cannot place" wording                                                                                                                                                                                                      | C6        |
| R19     | Required | The ambiguity hint needs two reads, says "may", and is not printed at start until #691                                                                                                                                                                       | C6        |
| R20     | Required | `roster_full` ids are excluded from set-pinning                                                                                                                                                                                                              | C5        |
| Q3      | —        | Minimal support set for foreign entries                                                                                                                                                                                                                      | C5        |

**Round 3 (final, 2026-09-25): APPROVED FOR BUILD.** It checked the load-bearing claim (spec §6 property 7) against `host-roster.ts` and the P7 and P12 property tests: the claim holds, and P12 shows that a machine whose `H` falls off the chain is absent, never moved to another bucket. Its required changes R21–R28, and N10–N13, are §2A.
