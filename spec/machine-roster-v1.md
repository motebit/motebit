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
identified by the hash of its **signed body** (§4) — never the whole artifact. The roster is
every machine that has, **at its highest epoch, an enrolment no retirement ends**
(§6) — _ends_, not _names_: a retirement signed under an older key names an
enrolment without ending it. Merging two copies of a roster is set union.

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
  type:         string   // "motebit/host-enrollment@1" — domain tag, signed
  motebit_id:   string   // MotebitId whose unattended work this machine hosts
  device_id:    string   // the machine — a label under the motebit's key; MUST be minted fresh per machine
  public_key:   string   // 64 lowercase hex chars — the Ed25519 identity key that signs this entry
  enrolled_at:  number   // unix ms — an integer in [0, 2^53 − 1], never -0; self-asserted, informational, never ordered by
  suite:        string   // "motebit-jcs-ed25519-b64-v1"
  signature:    string   // canonical unpadded base64url, 86 chars ending in A, Q, g or w — Ed25519 over canonical JSON of all fields except signature
}
```

`device_id` is non-empty and compared byte-for-byte, with no normalization. It is
the same identifier the machine registers under
(`spec/device-self-registration-v1.md`).

### 3.2 — HostRetirement

#### Wire format (foundation law)

The end of one enrolment, named by id. A lost machine cannot sign its own exit,
so it MAY be signed by **any holder of a key at an epoch no older than the
enrolment's** (§6, Rule A) — the phone retires the VPS. Conformant validators
reject unknown fields.

```
HostRetirement {
  type:           string   // "motebit/host-retirement@1" — domain tag, signed
  motebit_id:     string   // MotebitId the retired enrolment belongs to
  enrollment_id:  string   // 64 lowercase hex chars — the entry id (§4) of the HostEnrollment being ended
  public_key:     string   // 64 lowercase hex chars — the Ed25519 identity key that signs this retirement
  retired_at:     number   // unix ms — an integer in [0, 2^53 − 1], never -0; self-asserted, informational, never ordered by
  suite:          string   // "motebit-jcs-ed25519-b64-v1"
  signature:      string   // canonical unpadded base64url, 86 chars ending in A, Q, g or w — Ed25519 over canonical JSON of all fields except signature
}
```

### 3.3 — Why the domain tag

Both bodies carry `type` **inside what is signed**. Without it, a `HostEnrollment`
and a device self-registration (`spec/device-self-registration-v1.md`) are the
same suite over `{motebit_id, device_id, public_key, <one time field>, suite}` —
separated by a single field name. And a future major version would have no
expression in what is signed: a major-2 artifact with the same fields would have
the same id and a valid signature under both laws. The field is named `type`
rather than `artifact_type`, which belongs to the content-artifact registry.

## 4. Entry identity

An enrolment's **entry id** is the lowercase hex SHA-256 of the canonical JSON
(JCS) of its **signed body** — every field of the `HostEnrollment` **except**
`signature`.

The signature is deliberately outside the hash. Its _spelling_ is the one part
of an artifact that nothing signs, and base64 has many spellings of the same
bytes — padding, the standard alphabet, the unused low bits of the final
character. An id computed over the whole artifact lets anyone holding a copy,
with no key, re-spell a **retired** enrolment into a new id that still verifies,
and the machine returns to the set. The signed body admits no such freedom:
every byte of it is covered by the signature. It also means the id does not
depend on the signer being deterministic.

A retirement has an id by the same construction. Nothing in §6 depends on it; it
exists so that a store can key what it holds and make ingest an idempotent union
(§9). Reference: `hostEnrollmentId(...)` and `hostRetirementId(...)` in
`@motebit/crypto`.

An implementation that enrols automatically when a runtime starts MUST re-present
the artifact it already holds rather than mint a new one per start: a body with
a fresh `enrolled_at` is a new entry for the same machine (§6 counts the machine
once, but retiring it then means retiring every such entry).

Hex is lowercase. Timestamps are integers in **[0, 2^53 − 1]** — the range every
JSON implementation represents exactly; a bignum implementation that admitted a
larger one would disagree with one that cannot, about membership and about the id
— and never negative zero, which canonicalizes to `0` (the same id and signature)
while being a different value. A signature is the **canonical** unpadded base64url
of its 64 bytes: 86 characters, of which the last carries two signature bits and
four that MUST be zero, so it is `A`, `Q`, `g` or `w`. The fifteen other spellings
decode to the same bytes and would verify; they are refused, so that an entry has
one spelling. These hold everywhere in this spec, and a conformant verifier rejects
anything else **even when it is authentically signed**. A verifier laxer than
the wire schema admits a machine that a schema-validating store refuses, and two
consumers of one set then disagree about what "every machine" is.

## 5. Suite, signing, and integrity

Both artifacts use suite `motebit-jcs-ed25519-b64-v1`: JCS canonicalization,
Ed25519, base64url signature. The signed message is the UTF-8 encoding of the
canonical JSON of every field except `signature`. A verifier MUST reject a
missing or unknown `suite` fail-closed — including when every byte is otherwise
authentic, because the declared suite is what decides how to verify.

**A producer MUST NOT emit an artifact a conformant verifier would refuse.** It
builds the body from exactly the fields of §3 — never by copying another artifact,
whose `signature` would then sit inside the body being signed — checks that the
body is well-formed, and checks that `public_key` is the key it is signing with.
A producer caches and re-presents what it minted (§4), so an artifact that signs
and verifies nowhere is a machine that is never in "every machine", silently and
for good.

Reference implementations: `signHostEnrollment(...)`, `verifyHostEnrollment(...)`,
`signHostRetirement(...)`, `verifyHostRetirement(...)`, and `hostEnrollmentId(...)`
in `@motebit/crypto`.

**Integrity is not membership.** `verifyHostEnrollment(...)` establishes only that
the entry was signed by the key it names. An entry that is perfectly
self-consistent under a stranger's key is exactly what a hostile store would
serve. Whether `public_key` speaks for `motebit_id` is decided in §6, by the
consumer, from keys the consumer already trusts.

## 6. The roster reduction (foundation law)

Structurally: a 2P-set per entry (add, then tombstone by id), an observed-remove
set per machine, and a forward-only epoch guard on removes.

**Inputs.** A `motebit_id`; a **key chain** — the motebit's identity keys ordered
OLDEST → NEWEST, from a succession chain (`spec/identity-v1.md` §3.8) **the
consumer verified itself**; a set of enrolments; a set of retirements. The key
chain MUST NOT be taken from the entries or on a store's say-so. The consumer
MUST take it from its strongest available binding rung
(`docs/doctrine/identity-binding-verification.md`) and MUST enforce
**extension-only** against the chain it last accepted: a chain that is not a
prefix-extension of that one is a fork, to be refused and surfaced. Resolving a
forked succession belongs to identity binding, not to the roster.

The entire result — every list in it, including what was refused — MUST NOT depend
on the order or multiplicity of the inputs, and equality of results is over ids
and signed bodies, never signatures.

**Step 0 — is the question usable?** If the `motebit_id` is not a non-empty
string, or the key chain, the enrolments or the retirements are not lists, the
result is a refusal (`malformed_input`) — never a thrown error, which a caller
catches and defaults. If the key chain is empty, contains a key that
is not 64 lowercase hex characters, or contains **any key twice**, there is **no
roster**: the result is a refusal carrying the reason (`empty_chain`,
`malformed_key`, `duplicate_key`). It is NOT an empty roster. A statement
quantified over an empty set is vacuously true — "a halt reached every machine"
— and that is fail-open on the one quantifier the roster exists for; a statement
quantified over a refusal is **unknown**. A repeated key has no sound reading. First-index strands the current key in the
past, so it can enrol nothing that counts. Last-index promotes every artifact the
key ever signed to the present — and, because authority flows forward only
(Step 2), the retirements signed under the keys _between_ its two appearances stop
applying to its earlier enrolments: rotating back to a key would un-retire
machines. With no trusted clock there is nothing to tell an artifact signed in the
key's first tenure from one signed in its second, so the roster refuses. A
succession that returns to an earlier key is for the identity layer to forbid
(`spec/identity-v1.md` §3.8); until it does, such a motebit has no roster, which
is the fail-closed answer.

Otherwise a key's **epoch** is its index in the chain, the **current epoch** is
the last, and the result carries a **chain head** `{ epoch, public_key }` naming
the view it was computed under. Only the relative order of epochs is used.

**Step 1 — admit each distinct entry once.** Group inputs by id (§4); anything
that is a JSON object and can be canonicalized has one, well-formed or not. An id
is _admissible_ iff at least one of its copies is well-formed (§4's strictness
included), its `motebit_id` matches, its `public_key` is in the key chain, and at
least one well-formed copy verifies.

**Nothing a party with no key can add may change the outcome for an id.** A
consumer unions what several stores serve, and one of them may be hostile or
merely unverifying, so beside an authentic entry there may be any number of
copies of its body under garbage signatures, and copies that canonicalize to the
same id and signature while not being well-formed (canonical JSON skips an
`undefined` value). Therefore: a well-formed copy is never displaced by one that
is not; **every** distinct well-formed copy is tried — an implementation MUST NOT
cap the number, since a cap lets that many garbage copies which sort first
suppress an authentic retirement; and an admissible id yields **no** refusal,
whatever accompanies it. Bounding the cost of a flood is the job of whoever
supplies the input (§9), where it can be done without changing the answer.

Any other id yields exactly one refusal `{ kind, id, public_key | null, reason }`
with the reason the FIRST that applies of `malformed`, `wrong_motebit`,
`untrusted_key`, `bad_signature`; `public_key` is the key the entry claimed, when
it is a string. Inputs with no id — not a JSON object, or not canonicalizable —
cannot be told apart and are **one** refusal with `id` and `public_key` null.
Refusals are sorted, and never silently discarded.

**Step 2 — Rule A: authority flows forward only.** An admissible retirement `R`
ends an admissible enrolment `E` iff `R.enrollment_id = id(E)` **and**
`epoch(R.public_key) ≥ epoch(E.public_key)`. One rule with two consequences: a key
from an older epoch — which after a rotation may be held by whoever took the
machine — can never end an enrolment made under a newer key; and a retirement
signed before a rotation keeps ending what it ended, because the comparison does
not change when the chain grows.

A retirement naming an id for which the input holds **no admissible enrolment** is
retained and reported as a _pending tombstone_, with the highest epoch that named
it, so that it takes effect when the enrolment appears. (_Admissible_, not merely
present: an enrolment that is in the input but refused — under a key the
consumer's chain does not yet contain, say — has not been seen as far as the
roster is concerned, and its retirement is still pending.) A retirement naming an
admissible enrolment is not reported separately: its whole effect is in Step 3's three sets,
and a list that included one Rule A ignores would let a reader mistake a stolen
old key's attempt for a machine being retired.

**Step 3 — Rule B: a machine's status is a function of its highest-epoch
enrolments only.** The unit of the roster is the machine (`device_id`), not the
entry; a machine may hold several enrolments and is one member. For each machine
`M` with at least one admissible enrolment let `H` be the highest epoch among
them, and `S` the enrolments of `M` at epoch `H` that no retirement ends:

- `S ≠ ∅` and `H` is the current epoch ⇒ **active**, reported with `S` — to retire
  the machine, retire every entry in `S`.
- `S ≠ ∅` and `H` is older ⇒ **superseded**: it never received the new key. It
  MUST be reported, not dropped — rotating a key does not stop it running.
- `S = ∅` ⇒ **retired**.

Enrolments of `M` below `H` are history: the machine moved epochs, and they play
no part in its status. Every machine lands in exactly one of the three, and each
carries `H` and `authenticated = (H is the current epoch)`.

**Step 4 — what is authenticated.** Only a status at the current epoch is
authenticated. For `H` older than current, **both `superseded` and `retired` are
advisory**: any holder of a key at epoch ≥ `H` — including a superseded, stolen
key — can flip them in either direction, and can mint any number of such lines
for device ids that never existed. There is no trusted clock here, so the
reduction cannot tell a line minted before a rotation from one minted after it
by a thief, and it does not pretend to. What no holder of an old key can ever do
is add, remove, or alter an **active** line.

Reference implementation: `verifyHostRoster(...)` in `@motebit/crypto`.

### Properties a conformant implementation has

1. **Partition** — every machine with an admissible enrolment is in exactly one of
   active / retired / superseded.
2. **Order and multiplicity invariance** of the whole result.
3. **Monotone under rotation** — for a chain `C`, a key `k ∉ C`, and a set
   containing nothing signed by `k`: the result under `C·k` differs from the result
   under `C` in exactly three ways, all consequences of the head moving — the
   chain head names `k`; every `active` machine becomes `superseded`; and
   `authenticated` becomes false for **every** machine, those that remain
   `retired` included, since none has an enrolment at the new head. Which
   machines are retired, every machine's `H` and entries, the pending tombstones
   and the refusals are unchanged. (It is NOT true for sets that already hold
   artifacts signed by `k` — a store learns of them before a consumer learns `k`
   — whose effect is property 6's.)
4. **No backward authority** — nothing signed only by keys below epoch `t` changes
   the status of a machine whose `H ≥ t`.
5. **Re-spelling invariance** — another valid spelling of a signature changes
   nothing.
6. **Monotone under union** — for a fixed chain, more retirements never move a
   machine out of `retired`. The only way out is a new enrolment at epoch ≥ `H`
   that nothing ends — **which any holder of a key at epoch ≥ `H` can mint.**
   `retired` is therefore durable only at the current epoch.
7. **Suffix invariance of the active set** — truncating the chain to any suffix
   that contains the current key leaves `active` unchanged.
8. **Relative order only** — the result is invariant under any order-preserving
   re-indexing of epochs.
9. **An unusable chain never yields a roster** (Step 0).

### Rejoining

A machine that finds its enrolment retired MUST NOT silently re-enrol, or
retiring would not be durable. It is reported as its own condition — _retired,
but connected_ — and rejoins only by an explicit act that mints a new entry. This
binds honest software only: every machine holds the key, so a hostile retired
machine can re-enrol at will, and the remedy for that is rotation.

### Rotation

Because every machine holds one key, **key rotation is the remedy for a lost or
stolen machine**, and it is a membership epoch.

On receiving a new key, a machine enrols under it **iff it is `active` under the
pre-rotation chain in its own last-verified view**. A machine that sees itself
`retired` MUST NOT enrol on receiving a new key — it would un-retire itself, and
the reduction could not tell that from an explicit re-join. A machine holds at
most one enrolment per `(device_id, public_key)`, and re-presents it rather than
minting another. The machine that never enrols under the new key is the one that
was cut off, and it is reported as `superseded`.

## 7. Quantified statements (interop law)

A statement quantified over a motebit's machines — that all of them answered,
that none is halted, that there are N of them — MUST be computed over the
**active** roster (§6) and MAY be annotated with liveness (§8). It MUST NOT be
computed over liveness alone, and it MUST NOT be made over a refused chain
(§6 Step 0), where it is unknown.

It MUST **cite the chain head** it was computed under. A consumer whose key
chain lags the truth computes a confident, wrong roster — to it, the holder of
the key it believes current _is_ the sovereign — and no reduction can make that
fail-safe. The head is what makes it detectable and attributable; a surface
SHOULD refresh the chain before presenting a universal claim.

When `superseded` is non-empty the statement MUST say so: _every machine on the
current key; k lines on superseded keys not covered._ Never a bare "every
machine".

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
  observed `(device_id, key)` — never a history — and MUST declare it and its
  retention window to its users. The key is the one the connection's credential
  was **verified under, captured at verification**; a store MUST NOT re-derive it
  later from mutable state, because a key rotation rewrites a store's device
  records without closing connections authenticated under the old key. A store
  does not know membership (§1), so it keys by what it observed, never by roster
  line, and SHOULD persist only for connections that announce hosting unattended
  work. A consumer attaches an observation to a line only when its `device_id`
  and key equal the enrolment's (the binding rule above); an observation under
  another key is that machine's id connected under a key that is not its
  enrolment's, never "not in the roster".
- A store MUST say what its last-seen value means. The reference relay's
  `last_seen_at` is **the last time it held a connection bound as that
  `(device_id, key)` open** — refreshed at bind, at close and on a periodic
  flush while the connection is open. With no heartbeat (#691) a half-open
  connection reads as open, so an idle, silently dead connection keeps
  refreshing it until the store notices the close; `sockets_open` likewise
  counts connections the store **believes** open — **any** connection bound as
  that pair, whether or not it announces unattended work — and
  `host_sockets_open` counts the subset that announces unattended work, by the
  same rule that writes the last-seen value. None of them is proof the
  machine is alive. And it is a **lower bound**: a store that stops without its
  shutdown flush (a crash) loses up to one flush interval (five minutes at the
  reference relay), so a connection may have been open somewhat after the value
  served.
- A store only ever counts or records a connection that is OPEN when it is
  registered. A client that closes while its credential is still being verified
  is never registered at all.
- A store that expires last-seen values MUST serve its retention window and the
  time from which it has been observing, so that a consumer can say "not
  observed in the last N days" rather than "never seen", and MUST NOT expire a
  value while a connection bound as it that announces unattended work is open.
  (A connection that does not host — a desktop session sharing the machine's
  `device_id` — does not keep a host's value alive; once the value expires, that
  connection is served as `live_unenrolled`.)
- Liveness MUST be served visibly apart from the signed entries, so that no
  consumer can mistake a store's observation for the sovereign's statement.

## 9. Security considerations

**A store holds only what verifies.** A store keys entries by id (§4), and the id
excludes the signature — so a store that accepted an unverified copy would let
anyone who has seen a retirement send its body under a junk signature first,
occupy the slot, and turn the authentic one into a "no-op". A store MUST verify an
entry's signature under the key it names before holding it, and MUST NOT let a
copy that does not verify stand in for one that does. This is integrity only and
needs no trust decision. A store SHOULD also bound what one presentation and one
motebit may carry: that, and not a cap inside the reduction, is where a flood is
limited.

**Replication, and the offline machine.** Entries do not live only on the
machine they describe. Every surface that holds the motebit's identity key
SHOULD keep the full set it last verified and present all of it — retirements
included — whenever it connects to a store. A store's ingest is an **idempotent
union**. Otherwise a store that loses its data re-forms the roster from whoever
reconnects, and the offline machine — the case this spec exists for — vanishes.

**No freshness window.** Unlike a registration request, these are durable
artifacts, not requests: a store MUST accept a validly signed entry of any age. A
replayed enrolment is a no-op (same id); a replayed enrolment of a retired
machine stays retired (§6, Rule A names it by id), however its signature is re-spelled (§4).

**Omission.** A consumer that trusts a store to return every entry can be shown
fewer. A consumer that remembers the entry ids it has verified detects a store
serving fewer, unless the store also presents the retirements that account for
the difference: _served ⊇ remembered, modulo presented retirements._ This cannot
detect omission of an entry the consumer never saw; that is a freshness problem
and needs a commitment shared across consumers (a transparency log), which this
version does not define.

**A stale key chain is not fail-safe.** A consumer that has not learned of the
latest rotation treats the holder of the key it believes current as the
sovereign: that holder can retire every real machine and enrol its own, and the
owner's new-key retirements are refused as untrusted. There is no containment
between the stale roster and the true one in either direction, so staleness
cannot be treated as conservative. This is the stale-revocation-list problem and
no reduction solves it; §7's chain head makes it detectable. An implementation
MAY surface an entry whose signature verifies under a key outside the chain as a
hint to refresh the chain. It MUST NOT let such an entry alter a result — anyone
can mint one.

**Ghost lines.** A holder of a superseded key can mint enrolments for device ids
that never existed; they appear as `superseded`. They can never be `active`
(§6 property 7), quantified statements run over `active` (§7), and they are
marked unauthenticated (§6 Step 4) — a legibility cost, not a safety one. A
reducer MUST NOT refuse old-epoch enrolments it has not seen before: after a
store's data loss an honest offline machine's re-presented line is
indistinguishable from a ghost, and dropping it is the failure this spec exists
to prevent. A consumer MAY annotate, beside the result and never inside it, a
line it had not seen before it first accepted the newer key. The durable remedy
is a signed seal under the new key (§10), deferred until a consumer gates on
`superseded` or a ghost is observed.

**Ambiguity.** Two machines that share a `device_id` are one roster line, and
nothing at this layer can tell them apart — they hold the same key. It is
prevented, not detected: an installer MUST mint a fresh `device_id` per machine
and MUST NOT copy one from another machine's configuration. Only a
hardware-attested, non-exportable per-machine key distinguishes two hosts
(`docs/doctrine/hardware-attestation.md`); that strengthens a roster line and is
never required to have one.

**A store's own key record is not the trust root.** A store's notion of a
motebit's key is mutable state, and a device registry records whichever key a
registration carried (`spec/device-self-registration-v1.md`). A store MAY additionally refuse entries under keys it does not associate with the motebit, as defence in depth; a consumer MUST reduce against its own key chain regardless.

**Self-asserted time.** `enrolled_at` and `retired_at` are claims by the signer.
A store that records when it received an entry MUST label that value as its own
observation.

## 10. Versioning

**The signed body of both artifacts is frozen for the life of major version 1.**
No field may be added, optional or otherwise. An entry's id is a hash of its
body and every conformant validator rejects unknown fields, so a producer that
added one would have its machines refused by every existing consumer — silently
leaving their rosters, which is the failure this spec exists to prevent.

Evolution happens by:

- **a new artifact type that references an enrolment by id** — for instance a
  future hardware attestation of a roster line, or a signed seal under a new key
  listing which old-epoch enrolments it recognises (the remedy for §6 Step 4's
  advisory lines). Existing consumers ignore it safely: it is not in the sets
  they reduce.
- **a new major version**, expressed in the signed `type` tag (§3.3).

A minor version may change non-wire text and add new **outputs** to the
reduction, provided no output changes which machines are active, retired, or
superseded for a given key chain and set. Anything that changes those three sets
is a major version.

This is the content-addressed-record pattern — an id that is the hash of a fixed
serialization, a frozen shape, and evolution by new kinds that link to old ones
by id. "Must-understand extension" schemes do not apply: even an ignorable
unknown field changes the hash.

## 11. Presentation and retrieval

How roster entries reach a store, and how a consumer gets them back.

#### Routes (foundation law)

The two routes below are the binding cross-implementation contract. Renaming or
relocating either of them is a wire break.

- `POST /api/v1/agents/:motebitId/roster` — present entries. The body is
  `{ enrollments?: HostEnrollment[], retirements?: HostRetirement[] }`, at least
  one of them present. The store takes the **idempotent union** (§9).
- `GET /api/v1/agents/:motebitId/roster` — the set as held, and beside it the
  store's liveness observation (§8).

**Both are first-person, and the caller must be present.** A roster says where
someone's agent runs and when each machine was last seen. A store MUST serve and
accept it only under a credential that names that motebit — **present and
equal**: a credential that names no motebit (an operator's master credential)
is refused, not waved through. A store MUST NOT publish, rank, or aggregate
rosters, nor serve one to another identity. The reference relay accepts a signed
device token of audience `device:auth`, verified under a registered device's
key; security is still in the artifact, so the routes need no audience of their
own.

**Ingest is integrity only.** Each entry is validated against its wire schema,
its `motebit_id` must equal the path's, and its signature must verify under the
key it names (§5, §9); an entry already held is a no-op, and entries of any age
are accepted. A store has no trusted key chain for most identities and must hold
entries under keys the motebit has rotated away from — after a rotation those
lines are how a consumer sees the machine that was cut off — so it does **not**
refuse an entry for its key.

**Caps are partitioned by signer key.** An entry signed by the key the caller's
credential verified under counts against that key's **own** bucket, which only a
holder of that key can fill; every other entry counts against one shared
**foreign** bucket, which exists to replicate the lines of other epochs. The
bucket is decided when the entry is first held and is stored with it — never
recomputed against whoever presents next — so one key's full own bucket never
reads as a full foreign bucket to another caller. A holder
of an old key can therefore fill only that key's bucket, and a rotation moves the
sovereign to a new, empty one. The foreign bucket can be exhausted by anyone;
the worst that follows is that superseded lines stop replicating through that
store. An **active** line is signed by the current key and is never lost this
way. The reference relay's caps: 512 enrolments and 2048 retirements per own
bucket, 256 entries in the foreign bucket, 64 entries per request.

**A partial presentation is not a success.** The response reports, per entry,
`accepted` (`stored` or `already_held`, with the id) and `refused` (with its index
and a reason: `malformed`, `wrong_motebit`, `too_large`, `bad_signature`,
`roster_full`). If
anything was refused the status MUST NOT be 2xx: a surface re-presenting its
whole cached set checks one thing — was it taken — and a 2xx over a body it must
remember to read is how half a roster comes to be believed to be all of it. What
was accepted stays accepted; a refused entry does not veto its neighbours. A
field that is present and not a list is a malformed request (400), and a
presentation larger than the per-request limit is refused whole (413); a surface
sends its set in chunks and treats anything other than every chunk taken as not
taken.

**A store bounds what it holds.** The law bounds no string length, and its
signed bodies are frozen for major 1, so a store bounds each entry itself, and
never by changing what verifies. The reference relay refuses an entry whose
canonical JSON, signature included, exceeds **4096 bytes** as `too_large` (a
store's refusal, not a verdict on validity, decided before the signature is
checked), and refuses a request body over **266,240 bytes** (64 entries × 4096,
plus slack) whole with 413. A well-formed entry is about 400 bytes.

**The retrieval.** `GET` returns:

```
{ motebit_id, enrollments, retirements,
  liveness: { observed_by, retention_days, observing_since,
              rows: [{ device_id, bound_under, last_seen_at, sockets_open,
                       host_sockets_open }],
              live_unenrolled: [{ device_id, bound_under, sockets_open,
                                  host_sockets_open }] } }
```

`enrollments` and `retirements` are served as the motebit signed them.
`liveness` is the store's own observation, named by `observed_by`, keyed by
device **and** by the key each connection verified under (`bound_under`, §8).
`rows` are the persisted observations plus open bound connections that announce
unattended work; `live_unenrolled` are open bound connections with no row.
`last_seen_at` is the last time the store held a connection bound as that
`(device_id, bound_under)` open — a lower bound after a crash (§8) — and
`sockets_open` counts **every** connection bound as that pair the store believes
open, host or not — something is attached — and `host_sockets_open` counts the
subset that announces unattended work, the connections that are the host's
liveness; with no heartbeat, a half-open connection counts in both (§8). They
are two quantities and a consumer MUST NOT read one for the other: "the machine
is running" is `host_sockets_open > 0`; "something is still connected as this
machine" (the signal a retired machine's owner needs) is `sockets_open > 0`.
`host_sockets_open` was added after `sockets_open`; a consumer that finds it
absent (an older store) falls back to `sockets_open` for both. All are per
observed pair, never over machines.

**The store does not reduce.** It returns the set; the consumer reduces it (§6)
against a key chain the consumer verified, and joins liveness to it: an active
machine's observation is the row with its `device_id` and `bound_under` equal to
its enrolment's `public_key`. Rows left over are classified, never dropped and
never counted as members:

- that machine's `device_id` under a **different key** — "this machine's id,
  connected under a key that is not its enrolment's" (the theft signal);
- a row whose `bound_under` is **not the chain head** lights no line, not even a
  superseded one with the same `device_id` and key — "a socket open under a
  superseded key";
- a `device_id` with no line — "connected, not in the roster";
- an `untrusted_key` refusal whose key is a device key the consumer knows for
  this motebit (a device linked without key transfer, enrolling itself) —
  "enrolled under a key that is not this motebit's identity key"; only a refusal
  under a key the consumer does NOT know, whose `device_id` has liveness, reads
  "your chain may be stale — refresh".

A store MUST NOT evaluate the reduction, decide
membership, or compute any quantity over a motebit's machines — a store that
cannot compute a roster cannot compute a wrong one. If the consumer has no
usable chain, it shows **no roster**, never an empty one (§6 Step 0).
