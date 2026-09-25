# PROPOSAL — identity key state outlives the discovery row (DRAFT, not built)

**Status:** DRAFT for design review, 2026-09-23; §10 DECIDED 2026-09-24 (founder delegated the three questions to PE judgement). **Increment 1 (§4) BUILT 2026-09-24** — `registry-delist.ts`, migration v41, gate #162 (#744). **Increment 2 (§5) PART A: first build #747 WITHDRAWN 2026-09-24 under §8 (two in-kind review rounds); amendments in §5a; branch kept; rebuild design in §5b (2026-09-24). **Rebuild #750 WITHDRAWN 2026-09-24 under §8:** round 1 (§5c) fixed four findings, and round 2 (§5d) found two §8 wrong answers, both regressions. Branch `relay/identity-key-state-inc2-rebuild` kept. §5e passed three design-review rounds narrowing to G1; founder decided option 2 (§5f: the holder is the ONLY authority). Build 3 BUILT 2026-09-25 (§5g) and WITHDRAWN under §8 (#753, §5i: C1/C2, departure regressions). Build 4 DECIDED and BUILT 2026-09-25 (§5i, §5j): serving evidence-only; departure = holder else main's exact rule, fed main's exact registry value.** Was: — `identity_keys` (migration v42, backfill; production count 50/50 unambiguous, 0 unfilled), `recordIdentityKey` at every door that proves a key, `identityKeyFor` the one resolver, the three named resolvers (auth's service fallback, verify-receipt, `keyOnFile`/`departureFrom`) and the identity log + §7.6 bundle on it. PART B not built: the remaining second-family readers (tasks.ts ×5, disputes.ts ×3, command-route, bond-store, device-registration-guard, federation-callbacks, index.ts, migration.ts ×3, key-rotation.ts recovery, trust-graph) and `check-identity-key-resolver`.
**Author:** motebit PE
**Closes when built:** #703 (a daemon shutdown discards the identity's guardian and key state)
**Prerequisite for:** roster part B (the successor to withdrawn #698), then #691 / #687 / #681 — the roster's key model was found inert against production data because of exactly this conflation.
**Relationship:** #736 (relay half of #702) added `departureFrom`, the one precedence rule for "may a rotation depart from this key"; this note makes the holder that rule reads durable. #709 and the client half are unaffected.

## 1. What this is

`agent_registry` holds two facts with different lifetimes in one row. **Discoverability** — endpoint, capabilities, heartbeat, the 90-day lease — rightly leaves when the agent departs or falls silent. **Identity key state** — the current public key and the guardian key — must leave only by revocation, never by silence. Today the shorter lifetime wins: `DELETE /api/v1/agents/deregister` and the janitor both `DELETE` the whole row, and the CLI daemon deregisters on every shutdown.

Production (read 2026-09-19, [roster memory]): **51 identities, 120 device rows, 9 registry rows, 0 successions.** So for 42 of 51 identities the relay's only knowledge of the key is a device row, and for the 9 that do have a row it evaporates at the next shutdown — which is the case the roster exists to cover, since absence is its adversary.

## 2. Facts the design rests on (each read from source)

- **F1 — the two deletes.** `services/relay/src/agents.ts` `DELETE /api/v1/agents/deregister` runs `DELETE FROM agent_registry WHERE motebit_id = ?`; the janitor in `services/relay/src/index.ts` runs `DELETE FROM agent_registry WHERE expires_at < ?` (90-day lease set on register/heartbeat). The CLI calls deregister from `apps/cli/src/daemon.ts` on both daemon and serve shutdown.
- **F2 — the migration route drops fields.** `services/relay/src/migration.ts` accept-migration does `INSERT OR REPLACE INTO agent_registry` naming only eight columns, so `guardian_public_key`, `settlement_address`, `settlement_modes`, `metadata` and `sweep_threshold` are dropped for a migrating identity. The register route's upsert, by contrast, `COALESCE`s each of them (`agents.ts` ON CONFLICT clause).
- **F3 — the readers.** Not seven: **~35 sites in 18 files** read `public_key` or `guardian_public_key` from `agent_registry`. Two families:
  - _discoverability_ — `discovery.ts` resolve, `task-routing.ts` list queries (with the week-long `FRESHNESS_DELISTED_MS` shelf filter), `health-summary.ts` counts, `federation.ts` counts, `a2a-bridge.ts`, the `GET /api/v1/agents/:id` row read — _corrected while building Inc 1: that route is a KEY reader (mcp-server's last-resort caller-key lookup, "must survive a sleeping agent"), so it carries no shelf predicate_;
  - _identity key_ — signature verification in `tasks.ts` (×5), `disputes.ts` (×3), `command-route.ts`, `bond-store.ts`, `device-registration-guard.ts`, `federation-callbacks.ts`, `index.ts`, `migration.ts` (×3); guardian reads in `key-rotation.ts` (recovery), `trust-graph.ts` and `tasks.ts` (same-guardian routing boost); the identity log and bundle in `identity-transparency.ts`; and `keyOnFile` in `succession-apply.ts`.
    The second family breaks when the row is deleted. The first family is _supposed_ to.
- **F4 — three hand-rolled resolvers of "the identity's key", with two precedences.** `auth.ts` verifies a bearer device-row-first, registry second. `agents.ts` (verify-receipt) resolves registry-first, device second. `succession-apply.ts` `departureFrom` (#736) resolves registry, then chain head, then device row. Same class of defect the #702 review rounds found twice: a predicate with an authority, re-derived elsewhere.
- **F5 — the foundation law that 404s.** `buildIdentityBindingBundle` (`GET /api/v1/identity/:id`, `spec/identity-v1.md` §7.6) returns null without a registry row, and `readIdentityBindings` builds the anchored identity log from the registry alone. 42 of 51 identities are invisible to both; the 9 are visible only while their daemon is up.
- **F6 — the precedent for state that must not be reaped.** `relay_motebit_intake` (migration v32) is append-only and never reaped, and its header says why: "deliberately NOT `agent_registry`, which records serving agents and is garbage-collected after 90 days of silence." The repo already distinguishes these lifetimes; it has not yet applied the distinction to keys.
- **F7 — what the spec promises.** `spec/discovery-v1.md`: `DELETE /api/v1/agents/deregister` is "voluntary departure from the registry." It says nothing about keys. `spec/identity-v1.md` §7.6 promises binding material for a `motebit_id` the relay knows.
- **F8 — retained state is declared.** Relay rule 11: any change that adds a retained field or a retention window updates `DECLARATION_CONTENT` (→ `PRIVACY.md`, `/.well-known/motebit-transparency.json`) in the same PR.
- **F9 — the writers are a closed registry.** `check-identity-authority-writers` (#724) lists every write into `agent_registry` / `devices` / `relay_key_successions`, each naming its principal. A new key-state holder joins that registry, and every door that proves a key is already enumerated there.
- **F10 — `devices` is the de facto key holder.** `register-self` and `bootstrap` write the CLI's identity key onto a device row (`identityManager.registerDevice`); a device linked without key transfer holds an independent key. Nothing today records which rows carry the _identity_ key and which carry a device's own.

## 3. The model

Two facts, two lifetimes:

| Fact                                                                              | Holder today                                                                     | Leaves when                              | Should leave when                                                            |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| Discoverability (endpoint, capabilities, heartbeat, lease, federation visibility) | `agent_registry`                                                                 | deregister; janitor after 90 days silent | the same                                                                     |
| Identity key state (current key, guardian, chain)                                 | `agent_registry` (9 rows), `devices` (the rest), `relay_key_successions` (chain) | deregister; janitor; migration replace   | **only by revocation** — never by silence, never by departure from discovery |

The fix is not a tidier delete. It is giving the second fact a holder with the second lifetime, and one resolver over it.

## 4. Increment 1 — stop the loss (small, ships first)

Registry rows stop being deleted for silence or departure; they are **delisted**.

- Add `delisted_at INTEGER NULL` to `agent_registry` (migration v41).
- `deregister` sets `delisted_at = now`, clears `endpoint_url` and `capabilities`, and leaves every key and settlement column in place. The janitor does the same for `expires_at < now` instead of deleting.
- Re-registration clears `delisted_at` (the register upsert already resets the discovery columns).
- The _discoverability_ readers (F3, first family) gain `AND delisted_at IS NULL`. The _identity-key_ readers change nothing — their rows now survive.
- `health-summary`: `total_registered` becomes a count of non-delisted rows (it is documented as "serving agents"); a new `total_known` counts all rows. Named as a dashboard-visible change.
- `migration.ts` accept-migration upserts with `COALESCE` like the register route, so a migrating identity keeps its guardian, settlement address, modes, metadata and sweep threshold.
- Declaration (F8): key state and settlement configuration are retained after departure from discovery until revocation; discovery fields are cleared at departure. `spec/discovery-v1.md`: deregister is departure from _discovery_; identity key state is retained.

What this closes, for identities that have a registry row: guardian recovery survives a shutdown; `GET /api/v1/identity/:id` answers; the anchored identity log keeps them; the "relay holds no key" state (#701's precondition) is no longer produced by a routine shutdown.

What it does not close: the 42 identities with no row at all. That is Increment 2.

## 5. Increment 2 — one holder, one resolver

- **`identity_keys`** (migration v42): `motebit_id PRIMARY KEY, public_key TEXT NOT NULL, guardian_public_key TEXT NULL, source TEXT NOT NULL, first_seen INTEGER, updated_at INTEGER`. `source` names the door that last wrote it (`register-self`, `bootstrap`, `register`, `succession`, `migration`, `federation`).
- **Written by every door that proves a key** — exactly the writers `check-identity-authority-writers` already enumerates, plus the device doors for the identity key: `register-self` / `bootstrap` (F10: the key they carry _is_ the identity key for a CLI), `/agents/register`, `applySuccession` (both rotation doors), accept-migration, federation `key_rotated`, and guardian attestation. Each write names its principal in the gate registry.
- **`identityKeyFor(db, motebitId)`** — the ONE resolver, replacing the three in F4. Order: `identity_keys`, else registry key, else recorded chain head, else the identity key on a device row. `auth.ts`, verify-receipt, and `departureFrom` all call it; a test sets the holders against each other and checks that all three doors agree.
- **The identity log and bundle read `identity_keys`.** §7.6 then serves all 51, not 9-while-awake.
- **Backfill** (in the migration): registry rows; chain heads; device rows _only where every keyed device row of an identity agrees_ (then that key is unambiguous). An identity whose device rows disagree and that has no registry row and no chain is **left unfilled** — never guessed — and is filled on its next `bootstrap` or `register`, both of which carry the identity key explicitly. The number of such identities is read from production **before** this increment is built (the roster lesson: read the data's shape, not the code's). _Built 2026-09-24 as the first commit of Inc 2: `identityKeyPopulation` in `health-summary.ts` serves `identity_keys_total / unambiguous / ambiguous / keyless` on `/api/v1/admin/health` (operator panel: "Key-ambiguous identities"), and `scripts/measure-identity-key-ambiguity.ts` reads it from a live relay — production does not allow a direct database read, so the relay computes the number itself, every time._
- **Readers migrate in one pass** through the resolver (F3, second family). A drift gate, `check-identity-key-resolver`, forbids `SELECT … public_key … FROM agent_registry` and `… FROM devices` for key resolution outside the resolver module — the same shape as #724's writers gate, on the read side.
- `agent_registry.public_key` stays as a discovery-time copy (the register route still writes it) until the reader migration is complete; dropping the column is a later, separate increment with its own state-holder analysis.

## 5a. Amendments from the withdrawn first build (#747, 2026-09-24)

Two review rounds, eight in-kind findings, all the same shape: **a reader that trusts the holder while a sibling door or guard still reasons from the old holders.** The rebuild takes these as design, not as fixes:

- **A1 — the guard reads the holder.** `refusePublicDeviceRegistration` builds "keys this identity holds" from devices + registry. Once auth verifies against `identity_keys`, the guard must include the holder's key in that set, or a stranger's key passes it for an identity whose registry key was blanked while its holder still answers.
- **A2 — "new identity" means `identityKeyFor === null`, never "no identities row".** Service-mode identities registered through `/agents/register` have no identities row and DO have a holder (backfill). Bootstrap and register-self may record a first key only when the resolver answers nothing.
- **A3 — one guardian truth.** The guardian lives in the holder; every door that proves a guardian (register's attestation, recovery successions) writes it there, and `key-rotation.ts` recovery, the §7.6 bundle and the trust-graph boost read it from the resolver. Until the readers move, the bundle must not read a guardian the registry can contradict.
- **A4 — the devices rung is a READER fallback, never a departure or registration gate.** A lone paired device's own key must not make `/agents/register` demand a succession from a key the identity never held. `keyOnFileForRegister` and `departureFrom` stop at holder → registry → chain; the devices rung stays only for readers that would otherwise answer nothing.
- **A5 — `''` is not a key on file.** A legacy registry row with an empty key must read as "no key", so the first-key record fires; normalize to `undefined` before the comparison.
- **A6 — `GET /succession` serves `current_public_key` from the resolver**, not a direct registry read, or drops the field. It is a foundation-law read and belongs in Part A, not Part B.
- **Kept as built:** the holder table and its one writer, the v42 backfill and D5, the resolver's precedence, the succession write scoped to the key it retires, exact key spelling, the auth fallback gated on keyed device rows, the receipt's own device row before the holder, the writers-gate entry. The 50/50 production count stands.

## 5b. Rebuild design — the guard-and-resolver interplay (2026-09-24, before code)

Written before the rebuild, as the note the amendments asked for. Eight in-kind findings had one cause: the relay asks **three different questions** about an identity's key, and each round moved one door's answer to the holder while a sibling kept answering a different question from the old tables. The rebuild names the questions, gives each ONE function, and states the laws between them as tests.

**The three questions.**

- **Q-current** — _what is THE identity's key?_ A single key. Asked when serving (§7.6 bundle, identity log, `GET /succession`) and when verifying a caller with no device row.
- **Q-held** — _which keys does this identity answer to?_ A SET. Asked by the public-door guard: a device linked without key transfer holds its own key, and that device may legitimately register again from a second machine. The guard is not asking Q-current, which is why the round-2 guard finding was not fixable by "call the resolver".
- **Q-device** — _does THIS device's key verify this token?_ Asked by `auth.ts` per `did`. Stays where it is; the holder is its fallback only for an identity with no keyed device row (kept from the first build).

**The functions** (`services/relay/src/identity-keys.ts` — the only module that reads any of the four tables for a key; Part B's `check-identity-key-resolver` locks that):

| Function                      | Answers   | Rungs                                                                                                                                                                                                                                                                                            | Callers                                                                                                                                                                                                                       |
| ----------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provenIdentityKey(db, id)`   | authority | `identity_keys` → registry (`''` ⇒ none, A5) → chain head. **Never devices** (A4)                                                                                                                                                                                                                | `departureFrom` (its exact-row device rung stays as a last resort when nothing is proven — see L3), the register door's key-on-file (replaces the raw registry read; no device rung, A4/A5), `applySuccession`'s holder scope |
| `identityKeyFor(db, id)`      | Q-current | `provenIdentityKey`, else the one key every keyed device row agrees on                                                                                                                                                                                                                           | bundle, identity log, auth's service-mode fallback, verify-receipt, `GET /succession` `current_public_key` (A6 — the field stays: web, desktop and inspector panels read it)                                                  |
| `keysHeldBy(db, id)`          | Q-held    | holder ∪ registry ∪ chain head ∪ every keyed device row, compared case-insensitively as the guard does (the chain head joined the set when L1's test failed without it: a deregistered daemon that had rotated would admit a stranger's device while auth verified its tokens against that head) | `refusePublicDeviceRegistration` (A1), `recordFirstIdentityKey`                                                                                                                                                               |
| `identityGuardianFor(db, id)` | guardian  | holder's guardian, else the registry's                                                                                                                                                                                                                                                           | the five guardian readers, ALL moved in Part A (A3): `/rotate-key` recovery, register's succession-on-register, trust-graph boost, tasks routing boost, bundle                                                                |

Two precedence lists in one module was the branch's own smell (`keyOnFile` filtered the resolver's answer by `source` and re-read the registry and chain itself). Now the reader IS the authority plus one rung, so A4 holds by construction, not by each caller filtering.

**The writers** (each an entry in `check-identity-authority-writers`, each proving before it writes):

- `recordFirstIdentityKey(db, {id, key, source})` — writes only when `provenIdentityKey === null` AND `keysHeldBy ⊆ {key}`. Both public doors call it unconditionally after the guard; the "identities row exists" test is gone (A2). A brand-new identity records its first key; a second machine after key transfer is a no-op; an identity whose device rows disagree stays unfilled (D5).
- `recordIdentityKey(db, …)` — the unconditional upsert, kept: `applySuccession` (scoped to the key it retires, kept), accept-migration after the binding check, and `/agents/register` after its bearer and succession checks. The register door drops the first build's device-agreement predicate: the same door writes `agent_registry.public_key` unconditionally and the resolver's registry rung would serve that key anyway, so the predicate protected nothing and only made the holder disagree with the registry.
- The register door's guardian attestation reaches the holder on EVERY path: with a key, through `recordIdentityKey`'s guardian (same key, first key, and succession — the round-2 "two guardian truths" was the succession path recording the key without the guardian); **without a key, through `recordIdentityGuardian`** — this bullet named that function before it existed, and the rebuild's first review found the gap (§5c R1).

**The laws, each a test that plants `identity_keys`, `agent_registry`, `relay_key_successions` and `devices` against each other:**

- **L1 — guard superset.** `keysHeldBy(id) ⊇ {identityKeyFor(id).publicKey}` in every planted state. Whatever auth will verify against, the guard already counts as held; the round-2 guard finding is this law's failure.
- **L2 — a stranger's key never lands.** For each state (holder only; registry only; chain only; devices agree; devices disagree; registry `''` beside a holder) and each public door, a key ∉ `keysHeldBy` is refused and the holder is byte-identical afterwards. §8's first clause, enumerated.
- **L3 — departure is proven.** `departureFrom(id, k).admissible ⇔ k === provenIdentityKey(id)`, with #736's exact-row device rung kept ONLY when nothing is proven. The first draft of this section removed that rung outright; writing L6 showed it trips §8's second clause: an identity with a guardian on a blank-key registry row and disagreeing device rows (ambiguous, left unfilled by D5) could recover through its guardian before and could not after. Zero such identities in production (50/50), but the rule is about the class. So the register door stops at the proven key (A4's actual finding — a lone paired device's key must not force a succession at registration), and `departureFrom` keeps the last rung for the identity that has proven nothing.
- **L4 — serve what you admit.** Bundle `current_public_key` = `GET /succession` `current_public_key` = `identityKeyFor`; `held_public_key` = `provenIdentityKey`. The two may differ only by the device rung, and the response says which.
- **L5 — one guardian.** After register-with-succession carrying a new attestation, recovery, the bundle and the trust-graph boost all read the new guardian.
- **L6 — §8's second clause, enumerated.** For each backfill source (registry, chain), for identities whose device rows agree (unfilled since §5c R4) and for the ambiguous identity the backfill leaves unfilled, guardian recovery succeeds after v42 exactly when it did before.

**Corrections to §5 read while designing.** Federation `key_rotated` is not a key writer — `federation-callbacks.ts` only reads, and the writers gate lists no federation door — so it is struck from the writer list. "Guardian attestation" is the register door's attestation, not a door of its own.

**Scope of the one PR.** Part A as kept, plus A1–A6, the guard, and the five guardian readers. Part B stays the signature-verifying readers (`tasks.ts` ×5, `disputes.ts` ×3, `command-route.ts`, `bond-store.ts`, `federation-callbacks.ts`, the remaining `index.ts` read, `migration.ts` ×3) and the read-side gate: after Part A the registry key still tracks the holder on every door (`applySuccession` moves both in one transaction), so Part B is a legibility pass, not a safety pass. **That premise was false** (§5c R2): the receipt fallback in `tasks.ts` moved the registry key to a paired device's own key, so it moved into Part A. The §8 stopping rule applies unchanged.

## 5c. The rebuild's first review round (#750, 2026-09-24)

An independent adversarial review of #750 confirmed four findings. Under §8 this is the rebuild's **one round of fixes**; a second round that finds one in kind means withdraw and return to this note.

- **R1 — a replaced guardian could still recover (§8 clause 2, the reverse direction; in kind with A3).** A registration carrying a new guardian attestation and no key updated the registry's guardian but not the holder's, and `identityGuardianFor` reads the holder first. Fixed: `recordIdentityGuardian` updates the holder's guardian whenever an attestation verifies without a key.
- **R2 — a Part B door wrote the old table.** `handleReceiptIngestion`'s fallback set `agent_registry.public_key` to a key embedded in a receipt whenever that key was one of the identity's device rows — including a paired device's own key. After the owner's next succession (scoped to the key it retires) the registry stayed on the paired key. Fixed: the fallback verifies only and never writes; its writers-gate entry is removed.
- **R3 — `/agents/register` recorded a key it did not prove.** With no key in the body, the door took the first-listed device row's key and recorded it as the holder. The CLI daemon's registration sends no key, so this was the common path. Fixed: the holder is recorded only from a key the body presented; a keyless registration publishes the key the relay already serves (`identityKeyFor`) to the registry, else `''` — never the first-listed of disagreeing rows. (The first cut of this fix wrote only the proven key and published `''` for every keyless daemon registration; the pre-push suite's discovery tests caught it.) **Residual, pre-existing and not worsened:** for an identity whose only evidence is agreeing device rows, that served key reaches the registry, and the registry is an authority rung — as on main. Closing it means the registry column stops being an authority rung, which is Part B's reader work.
- **R4 — the backfill's device rung reversed A4.** Filling the holder from agreeing device rows made a lone paired device's own key the authority, which A4 forbids at the door. Fixed: the backfill reads the authority's rungs only (registry, chain head). Device-only identities record their first key at their next bootstrap or register-self; until then `identityKeyFor` still SERVES the key their rows agree on, and `departureFrom`'s last rung still lets them rotate. **D5 is amended accordingly.**

Every fix has a test that fails when the fix is removed (three were checked by removing them; R4 by the backfill's exact row set).

## 5d. The rebuild's second review round — withdrawal (#750, 2026-09-24)

A fresh reviewer with no briefing reviewed the round-1 fixes. It confirmed two §8 wrong answers, both regressions against main (each probed on the branch and on main), and one pre-existing finding of the same kind. Under §8 this is the round that decides, so #750 is withdrawn.

- **W1 — unsigned bootstrap writes the holder (§8 clause 1).** `POST /api/v1/agents/bootstrap` takes `{motebit_id, public_key}` and no signature. The rebuild let it call `recordFirstIdentityKey`, and the comment claimed "the key is proven by this request". Anyone can plant any key for an id this relay has not seen, including a sovereign id derived from someone else's genesis key. The §7.6 bundle and `/succession` then serve that key, and the identity log anchors it. On main the bundle returned 404. The suite asserted this as correct: the bootstrap first-key test recorded an arbitrary key as `source: "bootstrap"`.
- **W2 — case-spelling lockout (§8 clause 2).** `recordFirstIdentityKey` lowercases the key for its `keysHeldBy` check but stores the spelling it was given, while `departureFrom` and `provenIdentityKey` compare exactly. Bootstrapping an identity's own public key in UPPERCASE records a holder that the owner's rotation from its lowercase key does not match (400; main 200), and neither does its guardian recovery (400; main 200). The owner's register-self cannot repair it, because the first-key write is a no-op once filled. R4 made every device-only identity lazy, and the reviewer counts 42 of 51 in production, so R4 widened the attack surface W1 and W2 use.
- **W3 — keyed `/agents/register` records a body key nothing binds (in kind, pre-existing).** On a device-only identity, a paired device's own-key token can register any `public_key`. There is no proven key, so no succession is demanded, and the holder takes it. Main put the same key on the registry, so the served answer is unchanged. But R3's claim that the holder records only proven keys is false.
- Plausible, not probed: `keysHeldBy`'s chain head can be a retired key after a returning migration, which is wider than main's guard; the auth fallback's keyed-device tightening may 401 a service-mode identity that paired a device; the public verify-receipt route still falls back to the first-listed keyed device.

**Root cause.** Every round has asked "which door writes the holder". The unasked question is "what EVIDENCE did the door see". The rebuild treated three kinds of evidence as one:

1. **Possession proven.** A signature by the key over a door-specific payload: register-self's signed registration, a verified succession link, a migration's sovereign binding.
2. **Asserted by an authenticated principal.** The bearer's token verified against _some_ key the identity answers to, while the body names a key the bearer need not hold: `/agents/register`.
3. **Asserted by nobody.** Bootstrap.

"Passed the guard" was read as (1) when it is at most (2), and for bootstrap it is (3).

**What a third build must settle, in the design, before code:**

- **E1 — the holder records only possession-proven keys (evidence 1).** Bootstrap never writes it. `/agents/register` records its body key only when the body key equals the verified bearer's own device key, or when it carries a signature by that key. Otherwise it writes the registry, as main does, and not the holder.
- **E2 — one spelling.** The single writer stores the lowercase key, and every comparison against the holder is case-insensitive. Alternatively, the doors refuse non-lowercase keys. The design picks one and names the gate that holds it.
- **E3 — the lazy path is the attack surface.** Unfilled identities are filled only through E1's evidence. Their laws (L1–L6) are re-enumerated with an adversary who holds only public keys, not just with the identity's own devices.
- **E4 — the test for every writer is adversarial.** For each writer there is a probe by a principal who holds no private key. It must leave the holder byte-identical and leave served answers unchanged from main.

The kept branches (`relay/identity-key-state-inc2`, `relay/identity-key-state-inc2-rebuild`) stay as parts bins. The holder table, the four readers, R1, R2 and R4 all held under review; the writers did not.

## 5e. Build 3 design — the holder is written by evidence, not by doors (2026-09-24, before code)

§5d's root cause, answered structurally. Three builds asked _which door_ writes the holder. This one asks _what evidence_ makes a key THE identity's key, and only that evidence writes. The evidence already exists in the protocol: a sovereign `motebit_id` IS a commitment to its genesis key (`verifySovereignBinding`, `docs/doctrine/identity-binding-verification.md`), so for a sovereign identity the relay can know the identity's key by arithmetic, without trusting whoever sent the request.

**Evidence kinds.** Every holder write names one of these; no other kind writes.

| Kind              | What was seen                                                                                                   | Who can produce it                                                            | Writes the holder?                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **E-sov**         | `verifySovereignBinding(id, K)` true                                                                            | anyone who knows `K` — and that is fine: the binding is true whoever posts it | yes, as a FIRST key only (nothing proven yet)                                                    |
| **E-link**        | a succession link verified by the currently HELD key (or a guardian recovery verified by `identityGuardianFor`) | the holder of the current key, or of the guardian key                         | yes, moving held → new (`applySuccession`)                                                       |
| **E-mig**         | a migration arrival's sovereign binding, verified in step (i)                                                   | the migrating identity                                                        | yes                                                                                              |
| **E-main**        | the registry key / chain head as they stand on main when v42 runs                                               | whatever door wrote them on main                                              | yes, ONCE, by the v42 backfill — a transplant of main's existing authority, not an upgrade of it |
| E-device          | a register-self signature, or a bearer token, by a device key `K`                                               | any device of the identity, including one paired without key transfer         | **no** — proves possession of a device key, not that `K` is the identity's                       |
| E-operator / none | master token; unsigned bootstrap                                                                                | the operator; anyone                                                          | **no**                                                                                           |

So: **bootstrap** writes the holder only when `K` is sovereign-bound (W1 closed — an attacker can "plant" only the true genesis key). **register-self** likewise; a legacy (non-sovereign) id never fills through it. **`/agents/register`** records a body key only as E-sov (first key) or E-link (a succession from the held key); anything else writes the registry exactly as main does and leaves the holder alone (W3 closed). **Device-only legacy identities stay unfilled** and behave exactly as on main.

**One spelling (E2).** The single writer stores `K.toLowerCase()`. Every comparison against a holder, registry, chain or device key lowercases both sides. The signed payload keeps its own spelling (it is signed bytes); hex case carries no key material, so comparing keys case-insensitively cannot admit a different key. W2 cannot be expressed: the write normalizes and the compare normalizes.

**Readers collapse to two.**

- `identityKey(db, id)` — the authority AND what is served: holder → registry (`''` ⇒ none) → chain head. **No device rung.** An identity that proved nothing is served nothing: the §7.6 bundle 404s, as on main. The separate "served" reader (`identityKeyFor`'s device rung) was the only way a device key reached a foundation-law route, and every probe of it hit §8(a)'s edge. Its one consumer that needed it — discovery for a keyless daemon registration — is served by the registry write main already does.
- `keysHeldBy(db, id)` — the guard's set: `{identityKey}` ∪ registry ∪ every keyed device row, lowercased. L1 holds by construction (the one answer is in the set). The raw chain head is no longer a member: after a returning migration it can be a retired key (§5d plausible #1); it enters only when it IS `identityKey`'s answer.
- `identityGuardianFor` — unchanged (R1's `recordIdentityGuardian` kept).

**Backfill.** v42 SQL as amended in §5c (registry, else chain head; never devices) = E-main. Then an async post-migration pass (the resolvers are synchronous; the hash is not) fills unfilled identities by **E-sov only**: a keyed device row `K` with `verifySovereignBinding(id, K)` and no recorded chain. A sovereign id whose registry key disagrees with its derivation is left as E-main put it — the registry is main's authority, and a legacy rotation may predate recorded chains; overriding it by arithmetic would refuse the owner's current key (§8 clause 2).

**Kept from the rebuild (held under both reviews):** the holder table, `identityGuardianFor` + R1, R2 (the receipt fallback writes nothing), R3's keyless-register fallback to the served key, R4, `applySuccession`'s scoped transactional write, the L-series tests.

**E4 — the adversarial proof contract.** For every writer, a probe by a principal holding NO private key, only public keys — in both spellings — against each planted state, must leave the holder byte-identical unless the key it names is sovereign-bound to the id. For every §8(b) state on main (registry, chain, device-only, blank registry + guardian), rotation and guardian recovery succeed on the branch exactly when they do on main — run against BOTH the branch and an `origin/main` checkout, as the round-2 reviewer did.

**First commit: the measurement.** Extend `identityKeyPopulation` (health-summary) with `identity_keys_sovereign` (identities with at least one key that is sovereign-bound to the id) and `identity_keys_legacy_device_only` (unfilled under this design). That number states what this build fills; it is not a gate (§10 Q3 precedent).

**Stopping rule.** §8 unchanged, plus: this section is design-reviewed adversarially BEFORE code; a design-review finding of §8 kind is fixed here, in prose, not in code.

### 5e amendments — design review round 1 (2026-09-24, before code)

An adversarial design review (read-only, one probe against built `@motebit/crypto`) confirmed seven flaws in §5e as first written and raised seven open questions. Every one is decided here, in prose, before code. Where an amendment contradicts the text above, **the amendment governs.**

- **DA1 — E2 flipped: canonical form is refused-at-the-door, never normalized-at-compare (F1, F2).** `hexToBytes` is lenient (`parseInt` per byte pair: `"a!"` reads as `0x0a`), so many keys have alternate spellings that verify as the same bytes. Lowercasing is not canonicalization. So: **every door that accepts a key refuses anything not matching `/^[0-9a-f]{64}$/` (lowercase, no `i` flag)**. That covers register-self, bootstrap, `/agents/register`, accept-migration, and the NEW key inside every succession and recovery record before `applySuccession`. **A departing (`old_public_key`) key is not format-checked: it must equal the STORED spelling exactly**, whatever that spelling is. Otherwise an identity whose stored key is non-canonical could never rotate away from it, which is a §8(b) lockout. Canonicality is enforced on keys entering the system, and continuity on keys leaving it. Every comparison stays EXACT, as main's are (`UPDATE devices … WHERE public_key = ?`, `verifySuccessionChain` linkage, pairing's check). §5e's "compare case-insensitively" is struck. Stored keys are NOT rewritten: anchored log leaves and signed chains carry their spelling, and a non-canonical row keeps working exactly as on main. This also closes the pre-existing `UPPER(K1)` extra-device path, because bootstrap's `/i` goes.
- **DA2 — one first-key writer, one predicate, one transaction (F3, F4).** E-sov writes only through `recordFirstIdentityKey`. The binding is computed first, since it is async. Then, in ONE synchronous SQLite transaction, the writer re-reads and writes: `INSERT … WHERE NOT EXISTS (holder) AND NOT EXISTS (chain row) AND (no registry row OR registry key = '') AND keysHeldBy(id) ⊆ {K}`. It is never the upsert. A rotation landing during the hash therefore makes the insert a no-op, and a leftover genesis row beside a paired device's own key (K2) leaves the identity unfilled, so it behaves exactly as on main. The async pass calls the same function per identity, which makes it idempotent and restart-safe by the same condition. Cost: identities with a paired device stay lazy. The first commit counts them.
- **DA3 — E-sov requires the exact canonical id (Q4).** `id === deriveSovereignMotebitId(K)` byte-for-byte, or a `did:key` id whose decode equals `K`. `verifySovereignBinding`'s case-insensitive id compare is not enough, because otherwise `bootstrap(UPPER(id), K)` would mint a served, anchored alias.
- **DA4 — `departureFrom` keeps #736's exact-row device rung when `identityKey` is null (F6).** That is L3 as the rebuild had it. "Readers collapse to two" applies to what is SERVED, not to what a rotation may depart from.
- **DA5 — the keyless `/agents/register` write (F5).** It writes `identityKey`, else the one key every keyed device row agrees on, else `''`: the rebuild's R3. That is main's behaviour narrowed, since main took the first-listed row. It never writes the holder. **Stated cost:** for a legacy device-only id, an agreeing device key reaches the registry and therefore the registry rung, exactly as on main. It is not new and not widened. Removing it means the registry stops being an authority rung, which is Part B.
- **DA6 — every verified guardian attestation calls `recordIdentityGuardian`, whatever the key evidence (F7).** That includes a same-key registration.
- **DA7 — auth fallback (Q1).** Main's gate semantics are kept exactly. The fallback applies whenever main's does, with `identityKey` in place of the raw registry read. `identityKey` answers the registry's value whenever no proven transition has moved the holder, so the only widening is to keys the identity proved. The rebuild's "no keyed device rows" gate is dropped: it 401'd surface-kit's `did:key` rotation client where main returns 200.
- **DA8 — verify-receipt (Q2).** The receipt's own device row, then `identityKey`, then **main's first keyed device row, kept as-is** for device-only receipts. This public verification route is a Part B reader, and changing its verdicts is out of this build's scope. It is named for Part B.
- **DA9 — the bundle for a registry-`''` or registry-less identity (Q3).** The bundle is served whenever a registry row OR a holder exists, as main serves registry rows: `current_public_key` is `identityKey`'s answer or null, the guardian always comes from `identityGuardianFor`, and `created_at` is the registry's `registered_at`, else the holder's `first_seen`. It 404s only when neither exists, as on main.
- **DA10 — E-main copies spelling as-is; measure first (Q5).** The first commit also counts non-canonical keys in the registry, devices and chain. If any exist, the backfill copies them verbatim, so exact compares against their own chains keep working. No existing log leaf changes.
- **DA11 — an unauthenticated E-sov leaf in the anchored log is accepted (Q6).** The leaf asserts a true arithmetic fact, the genesis binding, and the door is rate-limited. With DA2 it cannot displace any key the relay has evidence of. What remains is a genesis key served for an identity the relay has seen nothing else of. The owner moves it with the signed link they already hold, which is ordinary succession.
- **DA12 — the `/agents/register` succession check compares against `identityKey` (Q7),** the authority, never the raw registry. The holder and registry may diverge only through DA5's keyless write, and never on a key-bearing path.

### 5e amendments — design review round 2 (2026-09-24, before code)

A second, fresh design review confirmed one §8(a) flaw, in the premise under E-sov itself, plus wire, scope and claim fixes. Decided here; these amendments govern over §5e and DA1–DA12.

- **DB1 — E-sov needs CURRENT possession, not just arithmetic (F-A, §8(a)).** A sovereign binding proves `K` was the key at genesis, not that `K` is the key now. Relay B, which holds only S's old device row, would serve and anchor a retired and possibly compromised K0 where main 404s. Anyone can also plant K0 through unsigned bootstrap. DA11's remedy fails: `/rotate-key` refuses a non-head link older than 15 minutes, and the owner's K1 token has no row on B. So **E-sov writes only when the request also proves CURRENT possession of `K`**: register-self's signature by `K`, or an `/agents/register` bearer token whose verifying key IS `K`. **Bootstrap is not an E-sov door, and the async pass is DELETED** (device rows carry no provenance, so it would promote unsigned-bootstrap plants). What remains is someone holding K0's private key today presenting it, which is exactly main's case: main's register writes K0 to the registry. DA11 is struck.
- **DB2 — the bundle and log keep main's wire shape (F-B).** When `identityKey` is null and a registry row exists, `current_public_key` is `''`, as on main. That is a pre-existing schema violation, named for the §7.6 spec, and never `null`, which would be a wire break (`IdentityBindingBundle.current_public_key: string`, `.strict()` schema). Identity-log leaves likewise emit what main emits. DA10's "no existing log leaf changes" is corrected: for a registry-`''` identity with a chain, E-main moves the leaf from `''` to the chain head. That is benign (it is the key main already treated as on file), and it is now stated.
- **DB3 — verify-receipt keeps main's ORDER (F-C).** `identityKey` (which equals main's registry answer unless a proven transition moved the holder), else the receipt's own `device_id` row, else main's first keyed row. DA8's own-row-first is struck: it widened a public verdict (a paired device's own-key receipt would become valid).
- **DB4 — DA1's door list, completed; "absent" defined; the guard's comparison chosen (F-D, F-E).**
  - **Doors refusing non-canonical NEW keys:** register-self, bootstrap, `/agents/register` (both `public_key` and `guardian_public_key` — the guardian is format-checked BEFORE any write, which also closes the pre-existing alternate-spelling bypass of "guardian ≠ identity key"), accept-migration, pairing claim, pairing approve's `identity_pubkey_check`, `/device/register`, and the new key of every succession or recovery record.
  - **Absent = missing or `""`**, which takes DA5's keyless path. A non-empty malformed key is a 400: main silently fell back, and an explicit refusal is the honest shape.
  - **Continuity extends to admission:** a presented key that EXACTLY equals a key already stored for the identity (holder, registry, chain or device) is admitted in its stored spelling. So a legacy UPPER(K) identity whose client sends UPPER(K) keeps working, and F-E's conditional availability loss does not arise, whatever DA10's count turns out to be.
  - **The guard admits EXACTLY** (a lowercase K no longer joins an UPPER(K) identity by case-folding). Device and pairing **retire statements match case-insensitively** (`lower(public_key) = lower(old)`), so retiring wider is fail-safe against any row that slipped in before this build.
  - **Spec and clients:** `spec/identity-v1.md` gains "`public_key` is lowercase hex". `daemon --identity` and web restore lowercase the key when they load a `motebit.md`, since the file format predates the rule. No shipped encoder emits uppercase: every client hex encoder was checked.
- **DB5 — a departure admitted by the device rung moves the device row only (OQ1).** It does not fill the registry's `''` slot and does not write the holder: per E-link, only a link verified by the HELD key may. Cost: after such a rotation a legacy device-only identity's served key stays `''`, where main's `applySuccession` would have filled it. The rotation itself succeeds, so this is not §8(b), and a key reached only through device-key evidence is never served (§8(a)).
- **DB6 — named for Part B (OQ2):** `verifyMigratingKeyBinding` accepts the never-rotated genesis key regardless of this relay's recorded chain. Main does the same to the registry. It is in kind with DB1 and pre-existing, so it is not this build.

**Convergence rule (set now, before round 3).** The findings narrowed from design flaws (round 1) to one premise plus claim fixes (round 2), and every amendment in round 2 _removed_ a mechanism (bootstrap as E-sov, the async pass, own-row-first). A third design review is the **last**: if it finds anything of §8 kind, the design goes to the founder rather than to a round 4, because an unbounded review loop is its own failure mode. If it finds nothing of §8 kind, build from §5e + DA + DB, with E4's adversarial probes run against the branch and `origin/main` as the proof contract.

### 5e design review round 3 — ESCALATED to the founder (2026-09-24)

The final round (per the convergence rule) confirmed one §8-kind flaw, several contradictions and prose gaps. It also confirmed that DB1 closes F-A without a new hole: a paired device cannot produce E-sov evidence, a fallback-verified bearer cannot trigger a write, did:key ids are exact, and unsigned bootstrap no longer writes the holder.

- **G1 — "no key on file" is ownerless (§8(a)+(b), in a state main reaches).** State: no registry row, device rows = the owner's K0 plus a device paired without key transfer, holding K2. A keyless registration writes `''` (DA5, because the devices disagree), so `identityKey` is null. Then either:
  - K2's bearer registers `public_key: X`. With no key on file, DA12 demands no succession, and X is served and anchored.
  - K2 rotates K2→K3 through the device rung. `applySuccession` appends the link, the chain rung serves K3, and the owner's rotation from K0 is refused.

  **Main's protection in the same state is row order.** `listDevices` has no `ORDER BY`. If K0 is listed first, main writes K0 to the registry and refuses K2. If K2 is listed first, main writes K2, which is already a §8 failure on main. So the design turns main's coin-flip into "unprotected until a key-bearing act".

- **The root, named:** every build so far has kept _registry_ and _chain head_ as authority rungs. Any door that writes them without proven evidence therefore mints authority: a keyed register with no key on file, a device-rung departure's chain append, and main's keyless first-listed write. The holder alone was made evidence-typed, while its fallbacks were not.
- **Prose fixes owed whatever is decided:** strike §5e's "`keysHeldBy` lowercased" (DA1/DB4 say exact); DB5 must say what happens to the chain row; DB3's premise fails for chain-only identities (a public verdict change, class-only because production has 0 successions); DB4's lowercase-on-load contradicts its continuity promise for a stored UPPER(K); DA2's ordering on `/agents/register` (holder check before the registry upsert); DB4's "chain" means the chain head.

**Founder decision required** (the options are in the escalation note): (1) accept main-parity, treating a coin-flip as no protection so not worsened, apply the prose fixes, and build; (2) make the holder the ONLY authority and demote registry/chain to the one-time E-main transplant, so an unproven write can never mint authority; this folds Part B's key readers into build 3; (3) a narrow rule instead: a key admitted without proven evidence (a body key with no key on file, a device-rung departure) never reaches the registry or chain rungs, which live reads keep.

### 5f. Founder decision on G1 — the holder is the ONLY authority (2026-09-24); the build spec

**Decided (founder): option 2.** The evidence-typed holder is the only authority. The registry key and chain head are read as authority exactly ONCE, by the v42 E-main transplant; after that no live read treats them as the identity's key. G1's root was authority rungs written without evidence, and this removes the rungs instead of guarding each writer. This section governs over §5e, DA and DB wherever they differ, and it is the spec the build is written from.

**Two kinds of question, two functions.**

- **Authority** — `identityKey(db, id)` = the holder, else null. Asked by:
  - the §7.6 bundle `current_public_key` (null ⇒ `''`, DB2), the identity log, and `GET /succession` `current_public_key` / `held_public_key`;
  - `departureFrom`: the holder; when there is NO holder, #736's exact-row device rung (DA4). A device-rung departure moves that device row and appends the chain link, but it never writes the holder or the registry (DB5, clarified): the chain is a record, not an authority;
  - the `/agents/register` succession check (DA12): a body key differing from the HOLDER needs a link from the holder. With no holder, no succession is demanded and no authority moves; the registry takes the key exactly as main does, for discovery.
  - recovery: from the holder, else the device rung.
- **Verification** — `verificationKeyFor(db, id)` = the holder, else EXACTLY what that reader reads on main today. Asked by the auth fallback (DA7's gate, main's semantics), verify-receipt (DB3's order: holder, else main's registry → own device row → first keyed row), and the Part B signature readers (tasks.ts, disputes.ts, command-route, bond-store, federation-callbacks, index.ts, migration.ts). Once filled, they verify against the proven key. Unfilled, they are byte-identical to main. This is the fold-in of Part B: one function, with each reader's main-read kept as its named fallback until a holder exists.
- `keysHeldBy` (the guard) = holder ∪ registry ∪ keyed device rows, compared EXACTLY (§5e's "lowercased" struck, per DA1/DB4). L1 holds because every key `verificationKeyFor` or auth can answer is in the set.

**What this makes of G1.** With no holder: K2's `public_key: X` changes the registry (discovery) but serves nothing (`''`) and demands nothing of the owner. K2's K2→K3 rotation moves only K2's row, and the owner still departs from K0 through the device rung. Neither path can mint authority, because no live read treats the registry or chain as the identity's key.

**Writers** (unchanged from DA/DB): E-sov+possession through `recordFirstIdentityKey` in one sync transaction (DA2 predicate, checked BEFORE `/agents/register`'s registry upsert; DA3 exact id); E-link through `applySuccession` only when admitted by the HOLDER (a device-rung admission never writes the holder); E-mig; E-main once; `recordIdentityGuardian` on every verified attestation (DA6).

**Round-3 prose fixes, resolved:** DB4's continuity promise is kept by dropping lowercase-on-load. Clients load keys as written, and new keys are refused only if non-canonical AND not exactly equal to a stored current key (holder, registry, chain head, devices). DB3 applies only while unfilled, and is otherwise the holder. "Chain" in DB4 means the chain head.

**Stated costs.** A legacy (non-sovereign) identity first seen after v42, which never presents E-sov or E-link, serves `''` in the bundle where main would serve its registry key. New identities are sovereign by default, and every identity with a registry row at migration time is transplanted. A sovereign identity fills on its first register-self or keyed register by its own key.

**Proof contract (E4, the build's gate):** for every writer and every authority reader, probes by a principal holding NO private key, in canonical and alternate spellings, over the planted states of §5b, §5d and G1, run against the branch AND `origin/main`. The branch must never serve or depart from a key main would not, except where this section states a cost. Then one code-review round under §8.

### 5g. Build 3 — what building §5f found, and the differential (2026-09-25)

Four findings surfaced while building. Each is resolved with evidence the protocol already has, and none adds trust:

- **E-op — an operator-registered service identity.** It has no device row, so no door can present E-sov, and under holder-only authority it could neither rotate nor recover through its guardian, where main allows both (§8(b)). Main trusts the operator's registry key for exactly this identity. So an operator registration fills the holder only when the identity has no holder, no device row and no chain (`recordOperatorServiceKey`, one transaction). It cannot recreate G1, which needs device rows.
- **E-sov through a KEYLESS registration.** The CLI daemon bootstraps (unsigned), then registers without a key. As first built, no CLI identity would ever fill, and every new daemon's bundle would serve `''`. A keyless `/agents/register` under a device bearer proves current possession of that device's key: the token was verified by that row, with no fallback. With the exact sovereign id that is E-sov, the same evidence as DB1.
- **DA2's registry clause.** A registry key EQUAL to the candidate does not block the first-key write. Under §5f the registry is discovery's copy, and a keyless registration publishes the same key before the holder fills. A differing registry key still blocks.
- **DB5, clarified.** A device-rung departure moves its device row and the registry (discovery's copy, main's behaviour) and appends the chain. It never writes the holder. The registry restriction in DB5 existed only because the registry was authority.

**The E4 differential.** One HTTP-only scenario file, run against the branch and against an `origin/main` copy of the relay:

| Scenario                                                               | main                                | build 3                                               |
| ---------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------- |
| W1 — a stranger bootstraps an unseen id's genesis key                  | 404                                 | 404                                                   |
| W2 — a stranger plants UPPER(K), then the owner registers and rotates  | plant 201; nothing served           | plant **400**; owner rotates; the proven K2 is served |
| G1a — a paired device names X after a keyless register                 | X refused (row order); OWNER served | X reaches discovery; `''` served; the owner rotates   |
| G1b — a paired device rotates its own key                              | **owner's rotation refused (400)**  | owner rotates (200)                                   |
| L3 — a guardian recovery on a blank-key row with devices that disagree | recovers; NEXT served               | recovers; `''` served                                 |
| SVC — an operator service identity with a guardian                     | recovers; served                    | same                                                  |
| CLI — sovereign daemon: bootstrap, keyless register, rotate            | served K, then NEXT                 | same                                                  |
| LEGACY — legacy-id daemon                                              | served K                            | `''`                                                  |
| STRANGER — a stranger's key onto an existing identity                  | 409 / 409                           | same                                                  |

**Results:**

- No rotation or recovery fails on the branch where it succeeds on main, and G1b now succeeds where main refused.
- The branch serves a key main does not only in W2, and that key is evidence-proven.
- **Stated cost:** G1a, L3 and LEGACY, all legacy (non-sovereign) ids, serve `''` where main served its registry key. New identities are sovereign by default, and every identity with a registry row at migration is transplanted by E-main.
- **Named residual:** in G1a, for an unfilled legacy identity, a paired device's own key can reach the registry, and verification readers fall back to the registry. Main does the same in the other row order. Closing it means verification readers stop falling back to the registry, which is out of this build's scope.

### 5h. Build 3 code review round 1 (#753) — the one fix round under §8

An independent code review, which probed each candidate on the branch and on an `origin/main` copy, returned _fix-then-merge_ with two in-kind findings. Both are fixed; each has a test that goes red when the fix is removed:

- **H1 (§8(a) kind) — E-main no longer reads the chain head.** A paired device's device-rung rotation (K2→K3) appends a link, so a chain head can be a key the identity never proved. The v42 transplant would have made K3 the holder and served and anchored it, where main 404s. E-main now transplants **main's registry key only**. Main never served the chain head, so nothing main served is lost. This supersedes §5f's "registry key, else chain head" and DB2's "benign" note.
- **H2 (DB3's kind) — a keyless registration never blanks a registry key.** With rows that disagree, `discoveryKeyFor` answers `''`, and the upsert replaced the owner's registry key with it. The paired device's next keyed registration then needed no succession, and every unfilled verification reader moved to its key, where main refuses in every row order. Keyless now falls back to the existing registry key before `''`. §5g's residual is corrected to the state main shares exactly: a registry that is ALREADY `''`.
- **Stated cost, widened (review item 3):** a sovereign identity whose FIRST rotation happens through the device rung before it is filled never fills. Any chain row blocks E-sov, and E-link needs a holder. Main serves its current key; build 3 serves `''`. Letting E-sov accept a chain whose root departs from the genesis key is the named follow-up.
- **Prose corrected (review item 4):** the `/api/v1/agents/*` middleware DOES fall back (holder, else registry) when no row exists for the token's `did`. The register door's possession key is taken only from a device row, and E-sov's soundness also rests on DA2's predicate, which the reviewer confirmed closes the fallback path.

This was the one fix round. Under §8, a further in-kind finding means withdraw.

### 5i. Build 3 WITHDRAWN under §8 (#753, 2026-09-25) — and what three builds taught

The decisive code review, run after round 1's fixes, confirmed two §8(b) regressions against main. Each was probed on the branch and on an `origin/main` copy:

- **C1 — chain-only identities are stranded.** Holder-only departure drops main's chain rung. An identity with a blank or absent registry key and a recorded chain can no longer rotate or be recovered through its guardian (main 200, build 3 400). Main's own routes reach that state. H1 (§5h) removed the only transplant that covered it.
- **C2 — an operator identity with any device row is stranded.** E-op excludes any identity with a device row (even a keyless one), and nothing else fills its holder. Rotation and guardian recovery: main 200, build 3 400.
- C3, not §8 kind but unstated: a paired device's device-rung rotation leaves the served chain with broken linkage, and the owner's served key at `''` for good.

Neither C1 nor C2 is reachable from the shipped self-sovereign clients. The rule counts kind, not reachability, so build 3 is withdrawn. Branch `relay/identity-key-state-build3` is kept: its serving half, its tests, its differential probe and every round's findings are the parts bin for build 4.

**The pattern, read across all three builds and six review rounds.** Every §8(a) finding (a key served that the identity never proved) was fixed and **stayed** fixed once SERVING read the holder only. Every §8(b) regression in the last three rounds (E-op's origin, C1, C2) had one shape: departure authority had been removed from a rung main relies on (registry, chain head), and a state main supports was stranded. Building a new evidence path for each stranded state (E-op, the keyless E-sov, the registry-equal clause) is the same failure as #747's: re-deriving an answer door by door, one review round at a time.

**Recommendation for build 4** (a founder decision, because it narrows §5f's option 2):

- **Serving stays evidence-only.** `identityKey` is the holder, else `''` or 404, for the §7.6 bundle, the identity log and `/succession`. This half held under every review, and it closes G1's actual harm: an unproven key served and anchored.
- **Departure, recovery and the registration check** become the holder, else **exactly main's rule** (registry → chain head → exact device row). That is `verificationKeyFor`'s pattern applied to departure. For an identity with no holder, departure is main's by construction, so §8(b) cannot regress. For a filled identity it is the proven key.
- **Cost, stated:** G1b's improvement (an owner whose paired device rotated first can still rotate) is dropped. That lockout is main's pre-existing behaviour, so it is not a regression. It becomes a named follow-up that can be closed by evidence (E-sov accepting a chain rooted at the genesis key) without touching the departure rule.
- **Deleted, not built:** E-op and the registry-equal clause, which existed only to rescue departure. The keyless E-sov stays, because it serves the CLI daemon's key, a serving concern.
- **Proof contract unchanged:** E4, the differential against main, now run with `scripts/differential-vs-main.ts`. It adds the review rounds' own probes: the C1/C2 states, the W/G scenarios, and the round-1 H1/H2 states.

**DECIDED (founder, 2026-09-25): build 4 as recommended, with one correction made while scoping it.** E-op and the registry-equal clause are **kept**, not deleted. The text above called them rescue paths for departure, but each also fills the holder for an identity main serves (operator service identities; CLI daemons that register without a key). Once departure uses main's rule for an unfilled identity, neither is load-bearing for departure, so keeping them costs no §8(b) exposure and avoids a serving loss. The one mechanism that changes from build 3 is `departureFrom`: the holder, else main's registry → chain head → exact device row.

### 5j. Build 4 — what building it found, and the differential (2026-09-25)

Built from §5i as decided. Building it found one thing: build 4's premise is "departure is main's rule for an unfilled identity", so the rule's **inputs** must be main's too. DA5 made a keyless registration write `''` when device rows disagree, where main writes the first-listed keyed row. The differential caught it: in G1a, the owner's rotation got **400 on build 4 and 200 on main**. DA5 existed only because the registry used to be served. The registry now never is, since serving reads the holder, so the keyless write reverts to exactly main's: the holder when there is one, else main's first-listed keyed row, else `''`. `discoveryKeyFor` is deleted.

**The differential** (`scripts/differential-vs-main.ts`, 12 scenarios including the #753 decisive round's C1/C2/C3). **Every rotation, recovery and admission result equals main's in all 12.** The only differences are in serving:

| Scenario                    | Difference from main                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| W2                          | a stranger's non-canonical plant is refused; the owner's evidence-proven key is served where main 404s |
| G1a, L3, LEGACY, C1, C2, C3 | an identity with no holder serves `''` where main serves its registry key                              |

**Stated cost, restated precisely.** An identity whose key no evidence has proven serves `''` in the §7.6 bundle, the identity log and `/succession` `current_public_key`. After v42 that means:

- every identity with a registry key at migration time is transplanted (E-main), so it is served;
- a sovereign identity fills on its first register-self, or its first keyed or keyless registration by its own device. The exception is when another device row holds a different key first (C3, DA2's predicate), and then it stays unfilled until the E-sov-over-a-genesis-rooted-chain follow-up;
- an operator service identity fills via E-op unless it already has a device row (C2);
- a legacy id never fills.

None of this refuses a rotation or recovery main allows, and none serves a key the identity did not prove. Consumers that fall back from the bundle to discovery (for example mcp-server's caller lookup) still find the registry key there.

## 6. Decisions

- **D1 — delist, do not delete.** Deleting and moving keys to a new table in one step would touch ~35 read sites before anything is safer; delisting fixes the row-holding identities with a column and a filter, and is reversible.
- **D2 — silence never retires key state; only `/revoke` does** (which already keeps the row with `revoked = 1`). The janitor's 90 days is a _discoverability_ lease.
- **D3 — delisted identities stay in the identity log.** Identity ≠ discovery; a verifier walking a receipt chain needs the binding whether or not the agent is currently for hire.
- **D4 — one resolver, three call sites, one test that pits the holders against each other.** The #702 rounds found this class twice; this is the third instance in the same tables, and the fix is the same.
- **D5 — backfill is unambiguous-only, then lazy** (amended §5c R4: and from the authority's rungs only — never device rows). A wrong key in `identity_keys` is a planted binding served from a foundation-law route. Not knowing is honest; guessing is not.
- **D6 — `health-summary` splits serving from known.** Changing `total_registered`'s meaning silently would be a dashboard lie; adding `total_known` and documenting the split is not.
- **D7 — Increment 1 ships alone first.** It is small, reversible, closes #703's four named consequences for every identity with a row, and does not wait on the backfill question.

Rejected: (a) a separate table without delisting (leaves the janitor deleting the discovery row's copy while the identity table drifts from it); (b) making deregister a no-op for the CLI (the spec promises voluntary departure from discovery, and offline agents must leave the shelf); (c) keeping three resolvers and "being careful" (that is the state that produced #701, #713, #719 and the #702 review findings).

## 7. Tests and activation

Increment 1: daemon shutdown (real `deregister` through the CLI's `registerWithRelay` handle against an in-process relay) → guardian recovery still lands; §7.6 bundle answers after deregister; identity log includes the delisted identity; discovery and task-routing exclude it; the janitor delists rather than deletes; re-register clears `delisted_at`; accept-migration preserves the guardian. Each severed and seen red.

Increment 2: the three resolver call sites agree when registry, chain and device rows are set against each other; backfill fills the unambiguous and leaves the ambiguous; `check-identity-key-resolver` goes red on a re-introduced raw read; §7.6 serves an identity that only ever did `register-self`.

Before Increment 2: one read-only production query reporting how many identities are ambiguous under D5.

## 8. Stopping rule (set before review)

Withdraw on a **wrong answer**: an identity key served from a foundation-law route that the identity never proved, or an identity that could recover through its guardian before and cannot after. One round of fixes; a second round with one in kind means withdraw and return to this note.

## 9. Out of scope, named

Dropping `agent_registry.public_key`; the `devices` table's own lifecycle; the per-device kill-switch; the roster itself (this is its prerequisite, not its first increment).

## 10. Open for the founder — DECIDED 2026-09-24

Decided by PE under founder delegation ("do this for me, I trust your judgement"), each with the reason, so a later reader can re-open the reason and not just the answer.

- **Q1 — yes, `/revoke` delists.** A revoked identity cannot act, so it must not be for hire; `task-routing` already excludes `revoked = 1` rows from the shelf, so this makes one predicate of what is today two. Shape: revocation SETS `delisted_at` (and clears the discovery fields) rather than the shelf readers growing a second clause — "on the shelf" is then exactly `delisted_at IS NULL`, and a future reader cannot forget the revoked half. D3 is unchanged: the revoked identity stays in the identity log, with its revocation, because a verifier walking an old receipt chain needs the binding and its end. Re-registration after revocation is refused, as today; delisting never un-revokes.
- **Q2 — keep `total_registered`, keep its documented meaning ("serving"), add `total_known`.** The alternative (keep the old NUMBER under the old name, add `total_serving`) is the one that changes a meaning silently: after delisting, "all rows" includes departed agents, which the field's own doc-comment says it does not count. At cutover the number is continuous — every row that exists today is serving, or the janitor would have deleted it — so the dashboard sees no step. Siblings in the same PR: `services/relay/src/health-summary.ts` doc-comment, `apps/operator/src/api.ts` type, `HealthPanel.tsx` renders `total_known` beside it, and the docs page for the health summary if one names the field.
- **Q3 — Increment 2 does not WAIT on the count; the count is its first commit.** The count changes nothing about what is built (D5 is unambiguous-only then lazy regardless of the number); it changes what the PR promises. So it is not a gate, it is sequencing: a read-only, re-runnable script (`scripts/measure-identity-key-ambiguity.ts` — the number moves as identities bootstrap) runs against production before the backfill is written, its output is pasted into the PR, and the same number ships as an operator metric (`identity_keys_unfilled` in health-summary) so it keeps being read after the PR. If the count says most of the 42 are ambiguous, the design still holds — §7.6 keeps 404ing for them until their next bootstrap, honestly — but the PR says so in its first line instead of implying the backfill closed the gap.

Next: Increment 1 PR (§4), built as written.

- **Q1** — Should `/revoke` also delist (an agent revoked for abuse should not stay on the shelf)? The note assumes yes.
- **Q2** — `total_registered` narrowing to "serving" is visible on the health dashboard; acceptable, or keep the old number under the old name and add `total_serving`?
- **Q3** — Does Increment 2 wait for the production ambiguity count, or ship with lazy fill regardless and report the count as an operator metric?
