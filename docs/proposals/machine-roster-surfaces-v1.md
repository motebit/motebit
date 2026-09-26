# Machine roster, C-2: the phone, desktop and web read, keep, retire and enrol

Status: design note, **before code**. v2 takes every change from design review round 1 ("sound with required changes"; the record is in §4). **§1A and §1B are normative and take precedence over §1** (§1B over §1A where they differ). Round 2 (final) found one BLOCKING item, which escalated to the founder; the founder chose the custody-flag rung (§1B, B1). The note is approved for build with §1B applied. **B1 was REVERSED in review of the C-2a build (#797):** the custody flag is unsound, and the founder dropped it (see §1B).

Parent design: `docs/proposals/machine-roster-clients-v1.md` (C-2 in C7; C4's phone retire and enrol; C5's replica on every key-holding surface; C6's Settings placement; N6). C-1 (#792) shipped the surface-kit `MachineRoster` controller and the CLI adapter. C-2 adopts the same controller on mobile, desktop and web.

The review rule is C-1's **amended** rule. A build is withdrawn only for one of these:

- a false count or membership status of a roster line;
- a machine the sovereign retired becoming active again with no explicit act;
- a leak of the master token or the key;
- a durability violation;
- a regression.

Wording is fixed as found.

## 0. Facts this rests on (read from the code, 2026-09-26)

- **Key custody.** Every surface keeps one `device_private_key` slot: SecureStore (mobile), `~/.motebit/dev-keyring.json` via Tauri (desktop), or an IndexedDB-wrapped key (web). The slot holds the **identity key** on a first device or after a Link Device with key transfer, and a **device-only key** when the transfer was skipped. Mobile skips it when the wallet holds funds or the transfer fails; desktop and web have equivalent paths.
- **Tokens.** Each surface already mints `device:auth` through `createSyncToken`. Desktop's Sovereign adapter uses the operator **master token**, which the roster routes refuse with 403.
- **No surface but the CLI announces `unattended_runtime`.** Desktop can be the machine's runtime coordinator, but it deliberately announces `Background`, not `unattended_runtime` (protocol `index.ts` ~1450). So C-2 surfaces are never hosts.
- **Desktop and a CLI daemon on one machine share `~/.motebit/config.json`, and therefore one `device_id`.** `~/.motebit/machine-roster.json` and its `.lock` / `.mint.lock` are CLI-only in the shared-names table.
- **Storage and locks.**
  - Mobile is one JS process, with AsyncStorage and expo-sqlite available.
  - Desktop has Rust durable-file primitives (`write_file_atomic_owner_only`, `preserve_aside`, `read_strict`), but no generic durable-file Tauri command.
  - Web has IndexedDB and localStorage, and **no cross-tab lock anywhere yet**.
- **Rotation.** Each surface has a `rotateOrThrow` adapter (ceiling 130 lines). The kit passes `record` to every `commit`; web's adapter just ignores it.
- **Settings.** No surface has a devices list. The identity panes are mobile `components/settings/IdentityTab.tsx`, desktop `ui/settings.ts`, web `ui/settings.ts`.

## 1. Decisions

### S1: only the identity key can read the roster (N6, made structural)

The kit anchors the chain on whatever key the surface holds (C1). A device-only key would anchor a one-key chain of its own. Every real entry would then be refused as `untrusted_key` and the view would read "no machine … this device can verify", which is true but useless and easy to misread.

Each surface's `signer()` port therefore returns **null** unless the held key is the identity key. That is the key the surface's own verified identity file names (`motebit.md` / `_identity_file` / the stored identity), or, when no identity file is held, a key the relay's `/succession` names as `current_public_key` **and** that verifies as the head of the resolved chain.

A null signer gives the kit's existing `no-key` outcome. The Settings section then says "this device was linked without the identity key; the roster needs a device that holds it". It never shows a roster.

### S2: the C-2 surfaces never enrol themselves

These surfaces are not hosts, so they never mint a line for their **own** `device_id`:

- **no enrol on announce**;
- **no rotation hook**: nothing is captured before a rotation and nothing is re-enrolled after it;
- `enroll(ownDeviceId)` is **refused**: "this device is not a host".

`enroll` of another machine's id stays available. That is C4's undo, an explicit act. It never adds to `own_minted`, because `own_minted` records a device's own mints only.

This removes the rotation surface that took C-1 five builds, and there is nothing to take its place. The C-1 rule that a rotation re-enrols only a line this device minted itself holds vacuously here, because these surfaces never mint for themselves. The kit keeps its rotation code, and these adapters simply do not wire it.

### S3: each surface keeps its own replica

- **Mobile:** AsyncStorage key `@motebit/machine_roster`. JSON without key material, as the table already records. `exclusive` is an in-process promise chain.
- **Web:** IndexedDB store `motebit-roster`. `exclusive` uses the **Web Locks API** (`navigator.locks.request`), which gives cross-tab exclusion. If `navigator.locks` is absent, the **write** actions (retire, enroll, save-after-merge) refuse ("this browser can't lock the roster across tabs") and reading still works.
- **Desktop:** a **desktop-owned** file, `~/.motebit/machine-roster.desktop.json`, never the CLI's `machine-roster.json`.
  - Writes go through two new narrow Tauri commands, `roster_replica_read` and `roster_replica_write`, built on `read_strict`, `write_file_atomic_owner_only` and `preserve_aside`.
  - `exclusive` is the in-process lock that the desktop's single process (the runtime-host election) already serializes on.
  - It uses a separate file rather than the CLI's because the CLI's lock is a JS content-token protocol; re-implementing it in Rust would make one protocol live in two languages.
  - The desktop never mints for its own id (S2), so the machine's `own_minted` lives only in the CLI's file. Two replicas on one machine are two replicas, which the design already assumes: every key-holding surface keeps one.
  - A row for the new file is added to the shared-names table: desktop is the sole writer; "a reader may infer only that the desktop holds these verified entries".

Every replica is merged the kit's way: a union, frozen values kept first-write-wins, and verify-before-hold.

### S4: presentation

Each surface presents its replica (the minimal support set) **whenever it connects** (doctrine: "presents all of it whenever it connects"), and after every retire or explicit enroll.

The authorization is always `device:auth`, minted by the surface's `createSyncToken` under the identity key. It is **never** the Sovereign adapter's master token, which desktop uses today.

### S5: rendering and placement

- A "Machines" section under **Settings** (identity), beside the device id. It never goes in Sovereign. "What I am" versus "what I have": the roster is the machines this motebit runs on.
- It renders `buildRosterView` exactly as the CLI's formatter does: the count only when not suppressed, then the lines, the empty state and the notes.
- Each machine line gets a **Retire** action. Per C4 there is no confirmation: the change is visible and can be undone with **Enroll**.
- Superseded or retired lines, and devices the relay has seen that aren't enrolled, get **Enroll**, with `--force` semantics behind an explicit second tap only where the kit returns `needs-force`.
- It follows calm software: no toast; errors are shown in place.
- `knownDeviceKeys` comes from the local devices store, where one exists (desktop `tauri-storage.listDevices`, web `identity-storage.listDevices`); mobile has none, as on the CLI.

### S6: one shared state holder

Surface-kit already holds the logic. The **state holder** (`subscribe` / `getState` / `refresh` / `retire` / `enroll`) is the same on every surface, so it lives once. Two ways to do it:

- a `MachineRosterPanel` in `packages/panels` (layer 5), named outside the `sovereign` family;
- a small `createMachineRosterSection(roster)` in surface-kit.

**Proposed:** surface-kit, next to the controller, so that the panels package gains no roster dependency.

Each surface adds a thin adapter (ports) plus its render. `check-surface-controller-adoption` gains an entry per surface.

## 1A. Round-1 amendments (normative; these take precedence over §1)

- **S1 is replaced (F2): whether this surface holds the identity key is decided _after_ resolution, by a pure kit function, never in the `signer()` port.**
  - An identity file proves possession of a key, not that the key is the identity key. The relay's hint is never an input (C1.7).
  - A new kit function, `classifyHeldKey(acq)`, sorts the surface into three states.
  - **identity:** any one of these holds.
    1. The chain resolved over (replica ∪ identity files **of this motebit_id** ∪ served) is `ok` and `rooted`. This works offline and cannot be forged for sovereign ids.
    2. Resolution refused with `held_key_superseded`, `duplicate_key` or `fork_at_held`, which means the held key is on the chain. The kit's refusal is rendered as it is.
    3. For a **legacy** id only, the relay's hint equals the head. The rung is disclosed: "identity key per the relay".
  - **device-key**, only on positive evidence: the relay names a key other than the held one as current, no verified record touches the held key, and the held key does not bind to a sovereign id. Only then does the surface say "this device was linked without the identity key".
  - **unconfirmed:** everything else. Counts are suppressed with a new reason, `held_key_unconfirmed`. It is never shown as "linked without the identity key".
  - Every surface runs the same function.
- **knownDeviceKeys excludes the chain's keys (F1).**
  - The kit computes `known \ acq.chain.chain` before relabelling. At first launch the bootstrap registers the local device under the genesis key, so `listDevices` returns the identity key itself.
  - Desktop and web may still pass `listDevices`. Mobile omits the port.
- **Replica save and lock, per surface (F3).** The kit's contract is that `save` merges under its **own** lock, and `acquire` always saves, so even reading writes. On each surface:
  - **Mobile:** `save` is serialized on its own in-process promise chain, separate from `exclusive`.
  - **Web:** `save` is **one IndexedDB readwrite transaction**: get → `mergeReplicas` → put. It is atomic across tabs because the merge is synchronous. Web Locks are needed only for `exclusive`, and without them writes are refused as S3 says. The roster gets its own database.
  - **Desktop:** the runtime-host election does **not** make the desktop a single process (a second one can run as a frontend).
    - `roster_replica_write` is a **compare-and-swap** on the expected digest, under a Rust file lock.
    - TypeScript retries read → merge → CAS.
    - A Rust in-process mutex sits in front of the file lock, and `exclusive` is an OS file lock.
- **Replicas are keyed by motebit_id (F4).** Every surface stores a per-motebit map, as the CLI does. `mergeReplicas` refuses to merge two motebits, so a single slot would throw, or overwrite the previous identity's roster, after a pairing or restore.
- **The desktop shares its device_id with the CLI host (F5).**
  - **(a)** The desktop wires `storedPublicKeyHex` from **its own** keyring (`dev-keyring.json`), or omits it. It wires `rotationInFlight` from its own `pending_rotation`, never from the CLI's `config.json` or `pending-rotation.json`.
  - **(b)** A new kit option, `selfIsHost: false`, makes `enroll(own)` go through the R17 refusals (never the R24 exemption) and write **nothing** to `own_minted` or `own_device_ids`. The desktop allows `enroll(its own id)` through it: its machine may be a CLI host. Mobile and web keep refusing `enroll(own)` as "this device is not a host".
- **Enroll is offered only on liveness `rows` of devices without a line (F6)**, never on `live_unenrolled`. Those are non-host sockets by construction (phones, tabs, desktops), and the phone must never be a machine.
- **Rotation link append (F7).** On `commit`, each surface appends the rotation `record` to its replica's succession records: no capture and no mint. Otherwise web, which has no identity file, loses its own link if the relay loses its database.
- **Presentation cadence (F8).**
  - Present only when the replica has changed since the last presentation the relay fully took, or at most every N minutes.
  - On web, only the tab holding the lock presents.
  - A 429 counts as `notTaken`, and `Retry-After` is honoured. Roster requests share the relay's per-IP write limiter with a CLI daemon on the same host or NAT.
- **Undo wording (F9).** After a retire, the enroll hint states the cost: "enrolled from this surface; the machine's own next rotation won't carry it". This is the #786 stated cost.

## 1B. Round-2 amendments (normative; B1 reversed by #797)

- **B1 — REVERSED (#797, founder decision): there is no custody flag.**
  - **What round 2 decided.** For a legacy id whose relay holds no proven key (29 of 50 production identities, 2026-09-26), `classifyHeldKey` never reaches `identity`. The founder first chose a local custody flag, set at identity mint and at key-transfer completion, as a fourth route to `identity`.
  - **Why it is unsound (#797, round 1).** A key transfer hands over whatever key the approver's slot holds, which may be a device-only key. `identity_pubkey_check` proves only that the seed matches the claimed public key, and the relay's key update accepts any canonical key. So a browser paired from a device-only approver would set `{M, D, key-transfer}`, route 4 would call `D` the identity key, and the section would show a false count ("0 machines…" while the identity has 2) and let Enroll sign with `D`. The sound alternative, an approver attestation, has no root for existing legacy identities: a first launch mints a sovereign id, and installs from before the flag cannot attest.
  - **The decision.** The custody-flag rung is dropped entirely: no flag, no route 4, no writers. `classifyHeldKey` keeps routes 1–3.
  - **Stated cost.** A legacy identity whose relay names no key shows its lines but **no count** on the phone, desktop and web, and every act is refused there (R1). The Settings section says why: "no proven key for this legacy identity — counts need the CLI or a sovereign identity; nothing can be retired or enrolled from here". The CLI is unchanged (R5).
- **R1: the kit refuses actions unless the class is `identity`.** `retire`, `enroll` and `present` are refused when the class is not `identity`, and the Settings section hides those actions. A device-only key must never sign roster entries.
- **R2: `acquire` repairs omissions only on the presenting surface.** Omission repair inside `acquire` counts as a presentation. On web only the lock-holding tab performs it. There is a kit option, `repairOmissions: false`, for other tabs and throttled refreshes.
  - The web leader lock is a held `navigator.locks.request("motebit-roster-present", {mode: "exclusive"})`, released when the tab dies.
  - `Retry-After` reaches the cadence logic through the adapter's `presentRoster` port, which returns it beside the response.
- **R3: a corrupt stored value is kept aside before any write.** Web copies it to a set-aside key inside the same IDB transaction. Mobile copies the whole map to `@motebit/machine_roster.corrupt-<t>`. Mobile keeps **one AsyncStorage key per motebit**, so one corrupt value cannot take every replica with it. This is the same R1/R2 rule the CLI follows.
- **R4: the desktop `exclusive` lock is a lease.** Each critical section runs inside **one Rust command** where possible. Otherwise the lock has an owner token and a timeout, so a webview reload or a crash can't leave it held. Windows uses `std::fs::File::lock`, given a new enough toolchain (checked at build), and Unix uses `flock`.
- **R5: `classifyHeldKey` applies to C-2 surfaces only.** The CLI keeps C-1's behaviour. The CLI is a host with its own evidence, and gating it would regress counts it shows today.
- **R6: a guardian recovery without a pinned guardian stays `unconfirmed` on these surfaces.** This is a stated cost (rare, enterprise custody). The remedy is to pin the guardian, done by restoring the identity file.
- **N1–N3:**
  - A pairing with key transfer also sends the replica's succession records, so a new device learns the chain even after a relay DB loss.
  - A device-only key rotated through the relay's device rung renders the kit's refusal (only the class name is off).
  - The Rotate action on a C-2 surface states the C-1 cost: "your machines will need `enroll` under the new key".

**A refusal is never evidence of identity (#797 decisive review).** §1A's second route, where resolution refused `held_key_superseded`, `duplicate_key` or `fork_at_held`, is **removed**. A device-only key that signs its own successor, or a cycle, is refused in the same way. A verified record naming the held key proves the key is on _some_ chain, not that it is on the identity's chain. Since a refused acquisition carries no verdict, this reachable state never produced a count, but `classifyHeldKey` is exported and C-2b/C-2c must not read `identity` as authority from it. A refusal now classes `unconfirmed` (`refused`) and renders itself. The identity routes are rooted, and a legacy relay hint equal to the held key.

## 2. Increments

- **C-2a:** the shared section/state holder, plus the web adapter and render (Web Locks, IndexedDB). Web first, because it has the fewest platform constraints to prove the section on.
- **C-2b:** mobile (AsyncStorage, the Settings tab).
- **C-2c:** desktop (the new Tauri commands for the desktop-owned replica, the Settings pane, a `device:auth` signer and never the master token).

Each increment is one PR with its own two review rounds under the amended rule.

### C-2a build notes

These record where the build departs from, or adds to, the text above.

- **The gate is a constructor.** `MachineRoster.gated(ports, options)` classifies the held key on every acquisition (before anything is presented) and refuses `retire`, `enroll`, `ensureEnrolled` (`held-key-not-identity`), `present` (a report marked `refused`), omission repair, and the rotation hook (`no-verdict`, frozen `absent`). The roster class carries the refusal in a type parameter that is `never` on an ungated roster, so the CLI's outcome types and behaviour are unchanged (R5).
- **`classifyHeldKey(acq)`, routes 1–3 only.** `classifyResolved` is the shared core. `unconfirmed` carries why: `legacy-unproven` (a legacy id whose relay names no key) or `unrooted` (a sovereign id whose chain this device cannot root), each with its own words. The "record touches the held key" test for `device-key` reads only the resolved links and branch records. Every record source, the replica included, reaches the resolver, so a verified record naming the held key becomes a link, a branch or a refusal. A test pins a touch that is held only in the replica.
- **`unconfirmed` means no acts.** R1 stays fail-closed: the section offers no Retire or Enroll, the kit refuses them, and the words say so.
- **`selfIsHost: false` is the kit's half of F5b; the own-id refusal is the section's.** With `selfIsHost: false`, `enroll(own)` takes the R17 refusals and records no own mint (the desktop's shape). The browser additionally refuses `enroll(own)` outright ("This device is not a host.") through the section's `refuseOwnEnroll`, which defaults to true.
- **A device-only key hides the roster.** The section sets `rosterHidden` for `device-key`, and the browser then renders only the reason. `unconfirmed` shows the lines with no count (§1B's stated cost).
- **The bearer is minted over the signer's own bytes.** The adapter calls `mintAudienceToken` with audience `device:auth` over the same private key the signer holds (the primitive `createSyncToken` wraps), rather than `createSyncToken`, which re-reads the keystore. So the bearer and the entry signatures are one key even if another tab rotates in between (C2 R7). Never the master token.
- **Retry-After holds back every presentation.** A repair is a presentation (R2), so the web tab repairs only while it holds the presentation lock AND no Retry-After is pending, and the section records a repair's report as it records any other. An act's own presentation waits too (kit option `presentationHeld`): a retirement or enrolment signed while the relay has asked to wait is saved, reported "not yet taken; presented again", and goes out with the next presentation. When a 429 carries `Retry-After`, the kit sends no further chunk; without the header (the CLI's port never passes one), every chunk is still sent.
- **Cadence.** N is 10 minutes (`PRESENT_EVERY_MS`). The digest is SHA-256 over the replica's sorted canonical entries. A presentation counts as fully taken when nothing is left to retry (`roster_full` ids are permanent and count as taken).
- **Storage.** The database is `motebit-roster`. It has three stores: `replicas` and `presentation`, both keyed by motebit_id, plus `aside`. A load that finds an unreadable value moves it aside in the same transaction and frees the name, as the CLI does. `openRosterDb` never hangs: a `blocked` open rejects at once, and one that does not settle within 5 s times out. Every caller then proceeds without the roster; the rotation commit's step is best-effort. No shared-names row is added, because the table lists `~/.motebit` files and the browser's storage is origin-scoped.
- **The rotation commit takes `record`.** `rotateWebKey`'s new `afterCommit` runs after the key is stored and appends the link to the replica (F7), best-effort. Nothing else about custody is recorded anywhere (§1B B1, reversed).
- **Placement.** The Machines card is built by `ui/settings.ts` inside the Identity pane, after the identity card, rather than in `index.html`. The Rotate confirmation now states N3's cost.
- **Presentation on connect.** The section is created, and takes the leader lock, on the first sync `connected` or the first Settings → Identity open, whichever comes first.

## 3. Open questions for design review round 2

1. Is `classifyHeldKey` sound on every surface, and is `unconfirmed` reached in any routine state where the surface does hold the identity key, so that counts stay suppressed for good?
2. Is the desktop's CAS-under-file-lock sufficient when a CLI process is also running? The CLI never writes the desktop file, but it is the same machine.

## 3-old. Round-1 questions (answered in §4)

1. **S1:** is "the identity file names this key" a sound identity-key check on every surface? Can a device-only-key surface hold an identity file that names its own device key, for example after a partial pairing?
2. **S2:** does refusing a self-enrol on these surfaces strand any legitimate flow? Could a user want their desktop listed as a machine?
3. **S3 desktop:** could a separate desktop replica on the same machine and `device_id` ever make the roster _wrong_ (as opposed to redundant)? For example, the desktop retiring its own machine's line while the CLI daemon is running.
4. **S3 web:** is refusing writes without Web Locks acceptable, or is an unlocked write safe because merge is a union?

## 4. Design review record

**Round 1 (2026-09-26): "sound with required changes".** Every change below is taken into §1A.

| Finding | Severity                             | Change                                                                                                                                                                                  |
| ------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1      | Required (false status)              | knownDeviceKeys included the identity key, so an unenrolled host was relabelled "a linked device"; the chain's keys are now excluded                                                    |
| F2      | Required (false count)               | S1 was not an identity-key check: identity files are self-certifying, and the relay fallback let a relay make a device-only phone count. Replaced by `classifyHeldKey` after resolution |
| F3      | Required (re-activation, durability) | An unlocked save lost a held retirement (probed 2–4/10). Per-surface atomic merge-save; desktop CAS under a file lock; the desktop is not a single process                              |
| F4      | Required (routine strand)            | A single-slot replica threw or overwrote after pairing or restore; now keyed by motebit_id                                                                                              |
| F5      | Required                             | A shared device_id with the CLI host: desktop key and write-ahead sources are its own; `selfIsHost: false` for desktop self-enrol                                                       |
| F6      | Required                             | Enroll was offered on non-host sockets; now only on liveness rows                                                                                                                       |
| F7      | Non-blocking                         | The rotation link is appended to the replica on commit                                                                                                                                  |
| F8      | Non-blocking                         | Presentation cadence and 429 handling                                                                                                                                                   |
| F9      | Non-blocking                         | The undo wording states the rotation cost                                                                                                                                               |

**Round 2 (final, 2026-09-26): one BLOCKING item, escalated.** B1: legacy identities with no proven relay key were permanently `unconfirmed` (29 of 50 production identities). **The founder chose the custody-flag rung.** R1–R6 and N1–N3 are taken into §1B. With §1B applied, the note is **approved for build**.

**C-2a build review, round 1 (#797, 2026-09-26): one withdraw-class finding, one precision.**

| Finding | Severity               | Change                                                                                                                                                                                                                                                                         |
| ------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| W1      | Withdraw (false count) | The key-transfer custody flag was unsound: an approver transfers whatever its slot holds (possibly a device-only key), so a browser paired from it would count and sign under that key. **Founder decision: B1 reversed, the custody flag removed**; the cost is stated in §1B |
| P1      | Precision              | The `device-key` touch test read the replica's records separately; removed (every source reaches the resolver), and a replica-only touch is pinned by a test                                                                                                                   |
| —       | Plausible, taken       | `openRosterDb` handles `blocked` and times out; an act's own presentation respects a pending Retry-After                                                                                                                                                                       |
