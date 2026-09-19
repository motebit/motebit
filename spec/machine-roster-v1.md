# motebit/machine-roster@1.0

A motebit's **machine roster** — the set of machines that host its unattended
work, signed by the motebit and only ever transported by a relay. This spec
defines the two wire artifacts, `HostEnrollment` and `HostRetirement`, and the
reduction that turns a set of them into a roster.

**"Every machine" is a statement about a set.** A relay can see which of a
motebit's sockets are open; it cannot see which machines exist. An
implementation that answers "all machines reported", "nothing is halted", or
"refused: N machines" by counting live connections reports against a set it
guessed, and an offline machine silently leaves the answer. The roster is the
set such statements MUST be computed over (§7).

**The roster is about completeness, not security between machines.** Every
machine of a motebit that can act for it holds the same identity key; a
`device_id` is a label under that key, not a principal. "Is this connection
really that machine?" has no cryptographic answer at this layer and needs none —
a holder of the key is the sovereign. What the roster defends against is
_absence_ (an offline machine), _ambiguity_ (two machines under one label), and
_omission_ (a store that returns fewer entries than exist) — §9.

Doctrine: [`docs/doctrine/machine-roster.md`](../docs/doctrine/machine-roster.md),
[`docs/doctrine/identity-binding-verification.md`](../docs/doctrine/identity-binding-verification.md),
[`docs/doctrine/hardware-attestation.md`](../docs/doctrine/hardware-attestation.md).

## 1. Scope

### What it is

A **set** of self-verifying, sovereign-signed entries. Unordered. Each entry is
identified by the hash of its own bytes (§4). The roster is every enrolment no
retirement names (§6). Merging two copies of a roster is set union.

### What it is not

- **Not an admission gate.** An unenrolled machine still runs, still honours a
  local halt, still answers a command addressed to it. Enrolment makes a machine
  _countable_; it never makes it _permitted_.
- **Not a store-authored fact.** A relay (or any other store) MUST NOT mint,
  edit, reorder, expire, or infer an entry. It stores and serves bytes.
- **Not a device list.** A phone or a browser tab is a device and is not on the
  roster. The roster is the machines where work happens while nobody is
  watching.
- **Not a lease.** Membership MUST NOT lapse by timeout. A machine silent for a
  year is still a member until its sovereign retires it, because silently
  dropping a machine is how "every machine" becomes false. Liveness is reported
  _beside_ membership (§8), never folded into it.

## 2. Why a set, and not a chain

Every enrolling machine holds the same key and nothing coordinates them, so two
machines enrolling at once is the normal case. A linear history would need
either a sequencer — which makes the roster store-authored — or merge nodes that
a single back-pointer cannot express. A set needs neither: there are no forks to
resolve because there is no order to disagree about.

Consequently no field in either artifact orders entries, and the self-asserted
timestamps (`enrolled_at`, `retired_at`) MUST NOT be used to order entries or
break a tie.

## 3. Wire types

### 3.1 — HostEnrollment

#### Wire format (foundation law)

A motebit's statement that one machine hosts its unattended work. Field names,
types, and the canonical-JSON signing order (JCS) are binding. The body carries
only what stays true for the life of the membership: it MUST NOT carry what the
machine runs (that changes; it is announced per connection) nor a display name
(it would be served verbatim for as long as the entry exists). Conformant
validators reject unknown fields.

```
HostEnrollment {
  motebit_id:   string   // MotebitId whose unattended work this machine hosts
  device_id:    string   // the machine — a label under the motebit's key; MUST be minted fresh per machine
  public_key:   string   // 64 lowercase hex chars — the Ed25519 identity key that signs this entry
  enrolled_at:  number   // unix ms, self-asserted; informational, never ordered by
  suite:        string   // "motebit-jcs-ed25519-b64-v1"
  signature:    string   // Ed25519 over canonical JSON of all fields except signature
}
```

### 3.2 — HostRetirement

#### Wire format (foundation law)

The end of one enrolment, named by hash. It MAY be signed by **any** holder of
the motebit's identity key, not only the machine leaving — a lost machine cannot
sign its own exit. Conformant validators reject unknown fields.

```
HostRetirement {
  motebit_id:     string   // MotebitId the retired enrolment belongs to
  enrollment_id:  string   // 64 lowercase hex chars — the entry id (§4) of the HostEnrollment being ended
  public_key:     string   // 64 lowercase hex chars — the Ed25519 identity key that signs this retirement
  retired_at:     number   // unix ms, self-asserted; informational, never ordered by
  suite:          string   // "motebit-jcs-ed25519-b64-v1"
  signature:      string   // Ed25519 over canonical JSON of all fields except signature
}
```

## 4. Entry identity

An enrolment's **entry id** is the lowercase hex SHA-256 of the canonical JSON
(JCS) of the **complete** `HostEnrollment`, `signature` included.

Ed25519 signatures are deterministic, so the same body under the same key is the
same bytes and the same id. An implementation that enrols automatically when a
runtime starts MUST re-present the artifact it already holds rather than mint a
new one per start; otherwise the set grows with every restart. (Re-minting an
identical body is harmless — it yields the same id — but a body with a fresh
`enrolled_at` is a new entry.)

Hex is lowercase everywhere in this spec. An entry id is a hash of exact bytes,
so there is one spelling of a key.

## 5. Suite, signing, and integrity

Both artifacts use suite `motebit-jcs-ed25519-b64-v1`: JCS canonicalization,
Ed25519, base64url signature. The signed message is the UTF-8 encoding of the
canonical JSON of every field except `signature`. A verifier MUST reject a
missing or unknown `suite` fail-closed — including when every byte is otherwise
authentic, because the declared suite is what decides how to verify.

Reference implementations: `signHostEnrollment(...)`, `verifyHostEnrollment(...)`,
`signHostRetirement(...)`, `verifyHostRetirement(...)`, and `hostEnrollmentId(...)`
in `@motebit/crypto`.

**Integrity is not membership.** `verifyHostEnrollment(...)` establishes only that
the entry was signed by the key it names. An entry that is perfectly
self-consistent under a stranger's key is exactly what a hostile store would
serve. Whether `public_key` speaks for `motebit_id` is decided in §6, by the
consumer, from keys the consumer already trusts.

## 6. The roster reduction (foundation law)

Given a `motebit_id`, a set of enrolments, a set of retirements, the consumer's
**trusted keys** for that motebit, and optionally its **superseded keys**, a
conformant implementation computes the roster as follows. The result MUST NOT
depend on the order or multiplicity of the inputs.

**Trusted keys** are the identity keys the _consumer_ accepts for `motebit_id` —
its own key, or keys time-valid in the motebit's succession chain
(`docs/doctrine/identity-binding-verification.md`). They MUST NOT be taken from
the entries, and MUST NOT be taken on a store's say-so. With no trusted key,
nothing is trusted and the roster is empty.

**Superseded keys** are keys that were the motebit's before a rotation.

1. **Retirements first.** A retirement is _valid_ iff it is well-formed, its
   `motebit_id` matches, its `public_key` is a **trusted** key, and its signature
   verifies. Collect the `enrollment_id` of every valid retirement as a
   **tombstone**. A superseded key MUST NOT retire: after a rotation the old key
   may be held by whoever took the machine, and must not be able to strike the
   sovereign's other machines out of the set.
2. **Enrolments.** An enrolment is _admissible_ iff it is well-formed, its
   `motebit_id` matches, its `public_key` is a trusted **or** superseded key, and
   its signature verifies. Compute its entry id (§4). Duplicates collapse.
3. **Active** — admissible under a trusted key, and not tombstoned.
4. **Retired** — admissible, and tombstoned. **Remove wins and is terminal for
   that entry**: a replayed copy of a retired enrolment has the same id and stays
   retired.
5. **Superseded** — admissible under a superseded key, not tombstoned, and with
   no **active** entry for the same `device_id`. After a rotation this is exactly
   the machine that did not receive the new key. It MUST be reported, not
   dropped: rotating a key does not stop the old machine running.
6. **Tombstones are kept even when their enrolment has not been seen.** A
   retirement may arrive before the enrolment it names — union has no order — and
   must still take effect when the enrolment appears.
7. Everything refused in steps 1–2 MUST be surfaced with its reason
   (`malformed`, `wrong_motebit`, `untrusted_key`, `bad_signature`), never silently
   discarded.

Reference implementation: `verifyHostRoster(...)` in `@motebit/crypto`.

### Rejoining

A machine that finds its enrolment retired MUST NOT silently re-enrol, or
retiring would not be durable. It is reported as its own condition — _retired,
but connected_ — and rejoins only by an explicit act that mints a new entry.

### Rotation

Because every machine holds one key, **key rotation is the remedy for a lost or
stolen machine**, and it is a membership epoch: machines that receive the new key
enrol again under it, which supersedes their own old-key line (step 5). The
machine that never does is the one that was cut off.

## 7. Quantified statements (interop law)

A statement quantified over a motebit's machines — that all of them answered,
that none is halted, that there are N of them — MUST be computed over the
**active** roster (§6) and MAY be annotated with liveness (§8). It MUST NOT be
computed over liveness alone.

A connection that announces it hosts unattended work but has no active enrolment
is neither added to the set nor able to veto it. It is reported beside the set,
as a connection the roster does not know.

A surface MUST NOT present a partial answer as a complete one: an active member
that did not answer is named, as unreached or as silent.

## 8. Liveness

Liveness is what a store observes about a member — whether a connection bound to
it is open, and when one last was. It is a transport fact and is never evidence
about membership.

- A connection is **bound** to a roster line only when its authenticated
  credential names that `device_id` and was verified under the enrolment's
  `public_key`. A `device_id` typed into a URL binds nothing.
- An implementation SHOULD NOT report a member as _connected_ unless it can
  bound how stale that claim is (a heartbeat with a deadline). Without one, the
  honest word is that a connection is _open_.
- A store that persists last-seen time MUST keep a single overwritten value per
  member — never a history — and MUST declare it and its retention window to its
  users.
- Liveness MUST be served visibly apart from the signed entries, so that no
  consumer can mistake a store's observation for the sovereign's statement.

## 9. Security considerations

**Replication, and the offline machine.** Entries do not live only on the
machine they describe. Every surface that holds the motebit's identity key
SHOULD keep the full set it last verified and present all of it — retirements
included — whenever it connects to a store. A store's ingest is an **idempotent
union**. Otherwise a store that loses its data re-forms the roster from whoever
reconnects, and the offline machine — the case this spec exists for — vanishes.

**No freshness window.** Unlike a registration request, these are durable
artifacts, not requests: a store MUST accept a validly signed entry of any age. A
replayed enrolment is a no-op (same id); a replayed enrolment of a retired
machine stays retired (§6.4).

**Omission.** A consumer that trusts a store to return every entry can be shown
fewer. A consumer that remembers the entry ids it has verified detects a store
serving fewer, unless the store also presents the retirements that account for
the difference: _served ⊇ remembered, modulo presented retirements._ This cannot
detect omission of an entry the consumer never saw; that is a freshness problem
and needs a commitment shared across consumers (a transparency log), which this
version does not define.

**Ambiguity.** Two machines that share a `device_id` are one roster line, and
nothing at this layer can tell them apart — they hold the same key. It is
prevented, not detected: an installer MUST mint a fresh `device_id` per machine
and MUST NOT copy one from another machine's configuration. Only a
hardware-attested, non-exportable per-machine key distinguishes two hosts
(`docs/doctrine/hardware-attestation.md`); that strengthens a roster line and is
never required to have one.

**A store's own key record is not the trust root.** A store's notion of a
motebit's key is mutable state, and a device registry records whichever key a
registration carried (`spec/device-self-registration-v1.md`). A store MAY verify
entries at ingest as defence in depth; a consumer MUST verify against its own
trusted keys regardless.

**Self-asserted time.** `enrolled_at` and `retired_at` are claims by the signer.
A store that records when it received an entry MUST label that value as its own
observation.

## 10. Versioning

Additive changes — a new optional field, a stronger verification rung — bump the
minor version and MUST keep §4's entry id computable for existing entries.
Changing the reduction in §6, the entry-id construction, or the meaning of an
existing field is a major version.
