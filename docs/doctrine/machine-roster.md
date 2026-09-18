# The machine roster — a motebit knows its machines; a relay only knows who is connected

**"Every machine" is a statement about a set. The sovereign signs the set's membership; the relay observes only its liveness; and no surface may say "every", "all" or "nothing" about a motebit's machines from liveness alone.**

This is [`settlement-authority-binding.md`](settlement-authority-binding.md)'s move applied to topology. There, a relay transports where an agent is paid and never creates that authority. Here, a relay transports which machines a motebit runs on and never creates that fact by noticing who happens to be connected.

## The hole (verified from the bytes, twice)

Two attempts to make a verb reach "every machine" were built and withdrawn: the halt broadcast (#681, five review rounds) and the composed `halt-status` (#687 → PR #690, two). The second was built read-first against two real runtimes, its machinery went green in one pass, and 22 production lines were tamper-checked red. It was withdrawn anyway, because the defect was upstream of all of it:

- `connections: Map<motebitId, ConnectedDevice[]>` (`services/relay/src/websocket.ts`) holds **live sockets only**, and `onClose` removes them. A motebit whose VPS daemon is down has, as far as the relay can see, one machine — so "asked every machine" returned HTTP 200 "Running — nothing is halted" with the VPS never mentioned. The `unreached` outcome existed only in the instant between a socket dying and being reaped.
- Membership was a **query string**. `?device_id=` and `?capabilities=` are typed into a URL; any socket could add itself to the set, and any unverified one could veto composition for the rest.
- The many-machine refusals `#686` shipped (`REFUSE_ON_MANY_MACHINES`, `PER_MACHINE_DATABASE_COMMANDS` in `services/relay/src/command-route.ts`) count the same live sockets. They are correct only while every machine is online.

Thirty-odd review findings across the two attempts reduce to one sentence: **the relay inferred the set it was reporting against.** Patching the edges of a set with no owner does not converge.

## A machine is not a principal

The realisation that fixes the shape. Since Link Device shipped, every device linked with key transfer holds the **same** Ed25519 identity key (one motebit = one wallet = one address) — and a device linked without it holds a key that can sign neither a remote command nor anything below, so it is not part of this question. Among the machines that matter, a `device_id` is a label under one key, not a key of its own.

So "is this socket _really_ the VPS?" has no cryptographic answer at the software rung, and does not need one. A token whose `did` names the VPS proves that _a holder of this motebit's key says so_ — and a holder of that key is the sovereign, who could sign `resume all` regardless. The relay never adjudicates between holders of one sovereign key ([`atom-loop-occupant.md`](atom-loop-occupant.md): attribution terminates at the signer; there is no one behind the signer to appeal to).

That relocates the problem. The roster's job was never security _between_ machines. It is **completeness** — the denominator — and completeness has three adversaries, none of them an impostor:

- **Absence.** A machine that is offline must still be a line in the answer.
- **Ambiguity.** Two hosts that share a `device_id` (a copied `~/.motebit/config.json`) are one machine to everyone downstream.
- **Omission.** A relay — buggy, stale, or hostile — that returns fewer machines than exist.

The one place a machine _is_ a principal is hardware: a Secure Enclave / TPM key is per-machine and non-exportable, and `DeviceRegistration.hardware_attestation_credential` already carries it. That is the rung that defeats ambiguity outright. Per [`hardware-attestation.md`](hardware-attestation.md) it is additive — it strengthens a roster line, it is never required to have one.

## The shape: membership is signed, liveness is observed, and they never mix

Two categories, held apart the way [`records-vs-acts.md`](records-vs-acts.md) and [`operator-transparency.md`](operator-transparency.md) (declared vs proven) hold theirs:

**Membership — sovereign-signed, relay-transported.** A machine that hosts unattended work says so with a **`HostEnrollment`**: `{ motebit_id, device_id, device_name?, hosts: [...], enrolled_at, prev, suite, signature }`, signed by the motebit's identity key. Leaving is the same artifact with `retired_at` — a **signed act**, never a timeout: a machine silent for a year is still a line ("not seen since …") until its sovereign says otherwise, because silently dropping a machine is how "every" becomes false again. Subject = signer, so this is receipt-family, not an attestation ([`evals-as-attestations.md`](evals-as-attestations.md)). The relay stores each artifact and serves it **verbatim**; it never mints, edits or infers one. The substrate half-exists: `spec/device-self-registration-v1.md` already gives the relay a durable, self-signed `devices` row per device. What it lacks is the role (_hosts unattended work_), the exit, and the lineage.

**Liveness — relay-observed, labelled as such.** `connected`, `last_seen_at`. This is what a relay legitimately knows, and it is a transport fact — never evidence about membership. A socket announcing `unattended_runtime` that is **not enrolled** is not added to the set and cannot veto it; it is reported beside the set as what it is: _a connection the roster does not know._

The law that joins them: **a quantified statement about a motebit's machines ("all reported", "nothing is halted", "refused: N machines") is computed over MEMBERSHIP and annotated with LIVENESS — never computed over liveness.** Every defect in the hole above is a violation of this one sentence.

Enrolling is automatic and silent. `motebit run` and `motebit serve` _are_ hosting unattended work when they start, so they enrol idempotently with the key they already hold — no affordance, no toast. Retiring is explicit (`motebit machines retire <id>`, and the phone's equivalent), because it changes what "every" means.

## The ladder: how much of "complete" a consumer can check for itself

Additive, like the identity-binding ladder. Each rung is a registry append, not a wire break ([`agility-as-role.md`](agility-as-role.md)) — which is why `prev` is in the artifact from the first increment.

- **relay-listed** — the consumer verifies each enrolment's signature, and trusts the relay to have returned all of them. Defeats absence. Does **not** defeat omission, and says so.
- **head-pinned** — enrolments form a per-motebit hash chain (`prev` commits to the previous artifact). A consumer remembers the head it last saw; a relay serving a shorter or forked chain is detected offline. This is [`identity-as-lineage.md`](identity-as-lineage.md)'s _linked ∧ non-equivocating ∧ fork-aware_, applied to topology. Every enrolling machine holds the same key, so two machines may extend the same head concurrently: the fork is **declared and merged** by the next writer, never silently resolved.
- **anchored** — the roster head joins the motebit's leaf in the identity-transparency log (`services/relay/src/identity-log.ts`), inheriting its on-chain anchor. Non-equivocation across consumers.
- **hardware-attested line** — orthogonal to the three above: a line whose machine proved a non-exportable key. The only rung that defeats ambiguity.

At the software rung ambiguity is **prevented, not detected**: a new machine MUST mint a fresh `device_id` (an installer requirement, #685), and `motebit doctor` names two live connections that claim one id from different network origins as a thing to look at — a hint, never a verdict.

## What the roster is NOT

- **Not an admission gate.** An unenrolled machine still runs, still halts locally, still answers a command addressed to it. Enrolment makes a machine _countable_; it never makes it _permitted_. Same posture as hardware attestation and the commitment bond: additive, never a gate.
- **Not a relay-authored fact.** If the relay's copy is lost, every machine re-presents its own signed enrolment on reconnect and the roster re-forms. Relay rule 7 holds: nothing here is a relay-only assertion.
- **Not a device list.** The phone and the web app are devices and are not on it. The roster is the machines where work happens _while nobody is watching_ — the set a halt must reach ([`surface-authority-model.md`](surface-authority-model.md): mobile is the consent root, never an execution surface).
- **Not a global registry.** It is first-person: a motebit's own machines, signed by its own key, readable by its own surfaces. The relay does not publish, rank or aggregate rosters.

## Increments

0. **This doctrine.**
1. **The artifact.** `HostEnrollment` in `@motebit/protocol`; sign/verify in `@motebit/crypto` (suite-dispatch); zod + committed JSON Schema in `@motebit/wire-schemas`; a new open spec for the roster (the thirty-fifth). Relay stores and serves verbatim; `DECLARATION_CONTENT` + `PRIVACY.md` name the new retained record in the same PR (relay rule 11). `run` / `serve` enrol at start. One read on every surface: `motebit machines`, `doctor`'s hosting report, the phone's `/machines` — membership annotated with liveness.
2. **The exit.** Signed retirement, terminal and phone together.
3. **`halt-status` over the roster (#687).** The withdrawn branch's machinery, re-aimed: one line per _enrolled_ machine; an offline one is named; an unenrolled peer is reported beside the set, never inside it; a line binds to the socket the frame was sent on.
4. **`halt` / `resume` over the roster (#681).** And the refusals `#686` shipped move from live-socket counts to membership.
5. **head-pinned** on every consuming surface. **anchored** and **hardware-attested line** are deferred-with-trigger: the first third party that must verify a motebit's topology, and the first sovereign with two machines that both hold hardware keys.

A drift gate over roster quantifiers lands with increment 3 (unbuilt, so unnamed here — a citation is a promise): in the relay's command route, no branch may derive a machine count from `connections` alone. The defect this whole document describes is a one-line mistake that reads as obviously correct, which is the definition of something a gate should hold.

## Cross-cuts

[`daemon-desktop-unification.md`](daemon-desktop-unification.md) (one coordinator per machine — a roster line is a _machine_, so `run` + `serve` on a host are one line, two executors) · [`always-on host decision` (#685)](https://github.com/motebit/motebit/issues/685) ("uptime is the union of your machines' uptimes" — the roster is that union's index, and the awake record `#688` ships is each line's history) · [`felt-interior.md`](felt-interior.md) (the owner can _see_ where their motebit lives: a calm record, never a dashboard) · [`composition-preserves-enforcement.md`](composition-preserves-enforcement.md) (a guarantee quantified over the wrong set is `silent`-class: every component correct, the composed claim false).
