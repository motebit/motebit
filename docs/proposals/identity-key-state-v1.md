# PROPOSAL — identity key state outlives the discovery row (DRAFT, not built)

**Status:** DRAFT for design review, 2026-09-23; §10 DECIDED 2026-09-24 (founder delegated the three questions to PE judgement). **Increment 1 (§4) BUILT 2026-09-24** — `registry-delist.ts`, migration v41, gate #162 (#744). **Increment 2 (§5) PART A: first build #747 WITHDRAWN 2026-09-24 under §8 (two in-kind review rounds); amendments in §5a; branch kept; rebuild design in §5b (2026-09-24).** Was: — `identity_keys` (migration v42, backfill; production count 50/50 unambiguous, 0 unfilled), `recordIdentityKey` at every door that proves a key, `identityKeyFor` the one resolver, the three named resolvers (auth's service fallback, verify-receipt, `keyOnFile`/`departureFrom`) and the identity log + §7.6 bundle on it. PART B not built: the remaining second-family readers (tasks.ts ×5, disputes.ts ×3, command-route, bond-store, device-registration-guard, federation-callbacks, index.ts, migration.ts ×3, key-rotation.ts recovery, trust-graph) and `check-identity-key-resolver`.
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
