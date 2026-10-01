# Naming by layer

Vocabulary is layered the way the code is. A word that is the right word in a positioning sentence can be the wrong word in a wire field, because the two layers make different promises: doctrine explains, the wire binds. This doc states the naming laws. The terms themselves are admitted and defined in [`spec/terminology-v1.md`](../../spec/terminology-v1.md); how they group into domains is [`primitive-vocabulary.md`](primitive-vocabulary.md).

## The principle: vocabulary by layer

Metaphor is legitimate where the reader needs a picture and nothing is bound by the words. It is forbidden where a word is a contract a third party implements against.

| Layer          | What it is                                                                 | Metaphor   |
| -------------- | -------------------------------------------------------------------------- | ---------- |
| Doctrine       | `DOCTRINE.md`, `docs/doctrine/*.md`, the derivation chain                  | Permitted  |
| Product        | marketing, README hero, surface copy, the rendered creature                | Permitted  |
| Protocol       | normative spec sentences (any MUST / SHOULD / MAY sentence), spec headings | Forbidden  |
| Wire           | field names, registry/enum values, error codes, JSON-Schema descriptions   | Forbidden  |
| Implementation | exported identifiers, CLI names and flags, log event names                 | Forbidden¹ |

¹ Non-exported, file-local identifiers are not governed by this doc, but the same words are preferred.

A spec MAY carry explanatory prose that uses doctrine vocabulary, provided it is plainly non-normative and no normative sentence depends on it. "Droplet", "surface tension", "membrane", "creature", "interior", "enzyme" belong to doctrine and product. "Sovereign" belongs to doctrine (below).

## One term, one meaning, per layer

Within a layer, a term has exactly one meaning, and that meaning is its entry in `spec/terminology-v1.md`. The following words are **reserved**; using one for anything other than its defined meaning is a naming defect:

- **admission** — the relay-signed `task:dispatch` token that authorizes a worker to execute one priced task. Nothing else is an admission.
- **attestation** — a signed statement about a subject other than the signer. The closed exceptions (hardware attestation, `CostAttestation`) are listed in the terminology spec, and the list does not grow by precedent.
- **anchor** — an on-chain commitment of a Merkle root. A key pinned out of band is a **trust root**, never an anchor.
- **grant** — a `StandingDelegation`. A single-act `DelegationToken` is not a grant; a policy allowlist is not a grant.
- **receipt** — a signed record whose signer is its subject (the agent signs what it did).

**`sovereign` is retired from the literal layers.** It remains the right doctrine word for an owner holding their own identity and keys. In protocol, wire and implementation it is replaced by the literal property meant: `self_certifying` (an id that commits to its key), `agent_custody` (funds the agent controls), `owner_signed`. Existing occurrences — e.g. the `IdentityBindingVerdict` value `"sovereign"`, `deriveSovereignMotebitId`, `verifySovereignBinding` — are frozen until migrated (§ Migration).

## Standards: conform or declare

Where a standard covers the concept, a term either conforms to it or its terminology entry declares the deviation. A standard's reserved claim or field name is never reused with another meaning: `aud`, `sub`, `iss`, `exp`, `nbf`, `jti` mean what RFC 7519 says; "endorsement" and "evidence" mean what RFC 9334 says when used of hardware attestation; `alg` is JOSE's. A motebit concept that resembles a standard's but differs gets its own name.

## Signed-artifact suffixes

The suffix of a signed artifact's type name states the signer's relationship to the content:

| Suffix        | Signer relationship                                                                |
| ------------- | ---------------------------------------------------------------------------------- |
| `Receipt`     | signer = subject; a record of an act the signer performed                          |
| `Attestation` | signer ≠ subject; a statement about another party or key                           |
| `Token`       | issuer authorizes a bearer/holder for a bounded purpose and time (short-lived)     |
| `Delegation`  | delegator transfers authority to a delegate (long-lived or standing)               |
| `Record`      | signer records a state change of its own identity or set (e.g. succession)         |
| `Manifest`    | producer binds a content hash to itself                                            |
| `Certificate` | signer certifies a terminal fact (deletion); not revocable                         |
| `Commitment`  | signer binds itself to a value that is checked against external state later        |
| `Transcript`  | signer records the inputs and outputs of a decision so a verifier can recompute it |

A new signed artifact MUST take one of these suffixes. An artifact whose relationship fits none is a missing suffix, admitted by amending this table and the terminology spec, not by improvising.

## Verbs

- `sign*` — produce a signature. `verify*` — check one and return a result. `derive*` — compute a value deterministically from key material. `compute*` — compute a value from data. `is*` / `has*` — pure predicate returning a boolean.
- `mint` is used **only** for issuing bearer tokens. Ids, receipts and keys are not minted.

## Verifier results

A verifier that returns a single success bit names it `valid`. A verifier whose result has several independent axes (integrity, identity binding, authority, revocation) returns them as separate fields and never collapses them into one bit — the `VerificationVerdict` shape, which deliberately has no top-level `valid`. A consumer that needs one bit derives it from the axes it depends on, at the call site.

## Wire fields

- Field names are `snake_case`.
- A party is named by role: `<role>_motebit_id`, `<role>_public_key` (e.g. `delegator_motebit_id`, `issuer_public_key`).
- A versioned artifact carries `spec: "motebit/<artifact>@<major>.<minor>"`.
- **Time:** `*_at`, integer milliseconds since the Unix epoch. **Expiry is exclusive for new artifacts:** an artifact is valid iff `now < expires_at`. (The existing `DelegationToken` verifier is inclusive; it is frozen and recorded in the terminology spec.)
- **Money:** integer micro-units in fields suffixed `_micro`. Any other unit is a declared deviation with its own suffix (e.g. `CostAttestation`'s nano-USD).
- **Hash algorithm** is a field value (`algorithm: "sha-256"`), never baked into a field name.

## Registries, audiences, events, errors

- Closed-registry values are `snake_case`.
- `TokenAudience` values for new entries are `<resource>:<action>`. Existing values (`rotate-key`, `browser-sandbox-grant`, `proposal`, …) are frozen.
- Event types are `<noun>_<past_participle>` (`memory_formed`, `goal_completed`).
- Error codes are upper-case snake case (e.g. `TASK_P2P_PROOF_REQUIRED`), drawn from a closed registry per surface; a new code is a registry addition, not an inline string.

## CLI

Commands are `motebit <noun> <verb>`. Flags name their effect (`--dry-run`, `--no-sync`), not their implementation.

## Admission of new terms

A new public term — exported identifier in a permissive-floor package, new wire field meaning, new registry, new reserved word — is admitted only by an entry in [`spec/terminology-v1.md`](../../spec/terminology-v1.md) in the same change that introduces it.

## Migration

The vocabulary in the repo today contains violations of these laws. They are not fixed by renaming in place. Each is migrated after the vocabulary freeze through alias-first deprecation per [`deprecation-lifecycle.md`](deprecation-lifecycle.md): the new name ships alongside the old, the old is marked `@deprecated` with the four-field contract, and the old is removed only after its minimum window at a major version. Wire values follow the same path: verifiers accept both values for the window; producers switch to the new value; the old value is retired at a major. A silent rename is forbidden at every layer.

## Cross-cuts

- [`spec/terminology-v1.md`](../../spec/terminology-v1.md) — the term entries.
- [`primitive-vocabulary.md`](primitive-vocabulary.md) — the concept map.
- [`registry-pattern-canonical.md`](registry-pattern-canonical.md) — how closed registries are built and gated.
- [`deprecation-lifecycle.md`](deprecation-lifecycle.md) — how existing names change.
- [`receipts-unified.md`](receipts-unified.md), [`evals-as-attestations.md`](evals-as-attestations.md) — the receipt/attestation split this doc generalizes into suffixes.
