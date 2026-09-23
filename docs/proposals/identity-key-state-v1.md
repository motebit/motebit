# PROPOSAL — identity key state outlives the discovery row (DRAFT, not built)

**Status:** DRAFT for design review, 2026-09-23. Nothing here is built.
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
  - _discoverability_ — `discovery.ts` resolve, `task-routing.ts` list queries (with the week-long `FRESHNESS_DELISTED_MS` shelf filter), `health-summary.ts` counts, `federation.ts` counts, `a2a-bridge.ts`, the `GET /api/v1/agents/:id` row read;
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
- **Backfill** (in the migration): registry rows; chain heads; device rows _only where every keyed device row of an identity agrees_ (then that key is unambiguous). An identity whose device rows disagree and that has no registry row and no chain is **left unfilled** — never guessed — and is filled on its next `bootstrap` or `register`, both of which carry the identity key explicitly. The number of such identities is read from production **before** this increment is built (the roster lesson: read the data's shape, not the code's).
- **Readers migrate in one pass** through the resolver (F3, second family). A drift gate, `check-identity-key-resolver`, forbids `SELECT … public_key … FROM agent_registry` and `… FROM devices` for key resolution outside the resolver module — the same shape as #724's writers gate, on the read side.
- `agent_registry.public_key` stays as a discovery-time copy (the register route still writes it) until the reader migration is complete; dropping the column is a later, separate increment with its own state-holder analysis.

## 6. Decisions

- **D1 — delist, do not delete.** Deleting and moving keys to a new table in one step would touch ~35 read sites before anything is safer; delisting fixes the row-holding identities with a column and a filter, and is reversible.
- **D2 — silence never retires key state; only `/revoke` does** (which already keeps the row with `revoked = 1`). The janitor's 90 days is a _discoverability_ lease.
- **D3 — delisted identities stay in the identity log.** Identity ≠ discovery; a verifier walking a receipt chain needs the binding whether or not the agent is currently for hire.
- **D4 — one resolver, three call sites, one test that pits the holders against each other.** The #702 rounds found this class twice; this is the third instance in the same tables, and the fix is the same.
- **D5 — backfill is unambiguous-only, then lazy.** A wrong key in `identity_keys` is a planted binding served from a foundation-law route. Not knowing is honest; guessing is not.
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

## 10. Open for the founder

- **Q1** — Should `/revoke` also delist (an agent revoked for abuse should not stay on the shelf)? The note assumes yes.
- **Q2** — `total_registered` narrowing to "serving" is visible on the health dashboard; acceptable, or keep the old number under the old name and add `total_serving`?
- **Q3** — Does Increment 2 wait for the production ambiguity count, or ship with lazy fill regardless and report the count as an operator metric?
