# Motebit: The Actor Principle

---

## Abstract

THE_SOVEREIGN_INTERIOR.md derived the identity — the Ed25519 keypair that binds the droplet to itself. THE_METABOLIC_PRINCIPLE.md derived what the interior builds versus what it absorbs. THE_SELF_SIGNING_BODY.md derived the signed trace of the interior's private work.

All three describe a single droplet. None describes what happens when droplets _speak to each other_.

This document derives that. It names a pattern the codebase has already implemented and never named: every motebit is an actor, the relay is its broker, the receipt chain is its causal log, and the adjudicator is its supervisor. The pattern is not imported. It crystallized out of the other principles — sovereign identity, metabolic boundary, self-signing body — the moment two motebits exchanged their first task. The name exists so the next feature can be evaluated against it.

---

## I. Premise

A motebit is alone only until it delegates.

A single motebit is a droplet in a medium. Its interior is cohesive, its boundary holds, its work signs itself. Everything THE_SOVEREIGN_INTERIOR.md and THE_SELF_SIGNING_BODY.md describe can be stated without reference to a second motebit.

The moment a motebit asks another motebit to do work, the physics changes. There are now two interiors, each sovereign, each accumulating, each signing. The work one performs on behalf of the other must be attributable to _both_ — to the delegator as cause, to the worker as executor. The message that initiated the work must be distinct from the state it changed. The result must be verifiable without either interior opening itself to the other.

The shape of this interaction — messages between isolated interiors, each with a persistent identity, each producing signed evidence of its own work, supervised by a third party when disputes arise — is the actor pattern. The motebit has been building toward it from the beginning. This document names it.

---

## II. What the Actor Is in This System

Four mappings. Each is already shipped.

### 2.1 — Identity is the address

In the conventional actor pattern, every actor has an address — an opaque handle that other actors use to send it messages. The address outlives any particular message. The actor behind the address may be migrated, restarted, or relocated; the address is the continuity.

A motebit's Ed25519 public key is the address. Not a label, not a routing hint — the cryptographic fact that any message signed against this key was sent to or from _this_ interior and no other. Curve coincidence extends the same key into the Solana address space (THE_SELF_SIGNING_BODY.md §2.3), so a message and its onchain anchor resolve to the same actor without an intermediate directory.

The keypair never crosses the boundary. The public key that the world uses to reach the motebit is derived from the private key that the motebit uses to sign. The correspondence is what makes the address real. A platform-assigned handle is a rental; an address derived from internal cohesion is an actor.

### 2.2 — The relay is the broker

Messages do not travel motebit-to-motebit directly. They pass through the relay, which resolves addresses, meters rate, enforces custody boundaries, and records that the handoff occurred. This is the broker role in a distributed actor system: it does not execute the work, it does not own the state, it routes and it observes.

`services/api` speaks this role explicitly. `motebit_task` is the message envelope. `task-routing.ts` resolves candidate workers by reputation, price, and freshness. The federation layer extends the broker across relay operators when the addressee lives on a peer. The relay's rate limits, circuit breakers, and allocation reservations are exactly the backpressure mechanisms a broker applies to keep the system from collapsing under bursty delegation.

A broker is not a trust root. The relay does not vouch for the work — it delivered the message, nothing more. The sovereignty of each interior holds across the broker, by the rule in `services/api/CLAUDE.md` §6: every truth the relay asserts is independently verifiable without the relay's cooperation.

### 2.3 — Receipts are the causal log

Actor systems that take causality seriously record, for every message handled, which earlier message caused it. The result is a partial order over events — a log from which any participant can reconstruct "this happened because that happened." Without it, debugging a distributed system means guessing.

The motebit's execution receipt is this log. Every `ExecutionReceipt` signed by a motebit carries a `delegation_receipts` field — the nested, signed receipts from whatever workers this motebit delegated to in the course of producing its own output. `services/research` produces a receipt whose `delegation_receipts` contain web-search's receipt and read-url's receipt; each of _those_ receipts may contain further nested receipts in turn. The chain is a tree, signed at every node, replaying exactly which actor asked which other actor for what, in what order, and what each of them signed off on.

This is not a convention added on top of the actor model. It is what the actor model's causal log looks like when each actor is sovereign: each link in the chain is signed by its own keypair, so the chain is not merely ordered but _individually attributable_. A verifier with the full chain reconstructs not only "what happened" but "who said it happened" — and can verify each signature against the actor's public key without contacting any runtime.

### 2.4 — Adjudication is supervision

An actor that misbehaves must be answerable to something. In supervised actor systems, a supervisor observes failures, applies a policy (restart, escalate, stop), and the system as a whole recovers without the failed actor having to self-report. Supervision is what prevents one broken actor from corrupting the causal log.

The dispute and adjudication primitives (`spec/dispute-v1.md`, `AdjudicatorVote`, `DisputeResolution` in `@motebit/protocol`) are this layer. When a delegator claims inadequate work or a worker claims nonpayment, the dispute escalates to a set of adjudicators — single-relay in the simple case, peer-consensus across federation when the relay itself is a defendant. Each adjudicator signs a vote; the resolution aggregates the votes into a signed outcome; the outcome modifies the record without requiring either party to cooperate.

Supervision here is explicitly _not_ coercion of the interior. The adjudicator cannot reach into either motebit and change its memory or its trust temperature. It issues a signed resolution, and the affected interiors metabolize that resolution the same way they metabolize any other external signal — through the boundary, into structure, in accordance with local policy. The supervisor restores invariants at the system level without violating sovereignty at the interior level.

---

## III. What This Changes

The pattern was already present in code. Naming it changes how new features get evaluated.

### 3.1 — The design questions

When a new capability is proposed — a new service, a new protocol extension, a new coordination primitive — three questions filter it before the implementation debate begins:

1. **Does it compose as actor messaging?** Is the interaction structured as a signed message from one addressable motebit to another, via a broker that does not execute the work? Or is it a side channel that bypasses the address, the broker, or the signature?
2. **Does it produce a causal receipt?** When the work completes, does the actor emit a signed artifact linked to the messages that caused it? Or does the evidence live only in a log the operator controls?
3. **Does it pass through supervision when it fails?** If this capability can be disputed — inadequate work, missing payment, bad data — is there a signed adjudication path, or does resolution require trust in the operator?

A capability that answers _yes, yes, yes_ composes with everything that already exists. One that answers _no_ anywhere is asking the system to treat it as a privileged special case. Either the special case is justified (and named in doctrine) or the capability needs to be reshaped to fit.

### 3.2 — How molecules should be designed

A "molecule" in this codebase is any multi-step capability composed of simpler motebit atoms — research composing web-search and read-url, code-review composing lint and summarize, any future agent that calls other agents. The actor principle says: each atom is an actor, the molecule is a supervised graph of delegations, and the molecule's receipt is the causal closure of its atoms' receipts.

This rules out molecules that hide their internal structure. A service that "uses" web-search by reimplementing the call inline, or by treating the dependency as a library rather than a delegation, loses the causal link — its receipt cannot name web-search as a participant, and a verifier of the molecule's output cannot trace the evidence back to the atom that actually produced it. The architectural rule from root CLAUDE.md ("Protocol primitives belong in packages, never inline in services") has a deeper reason than code hygiene: an inline call is not an actor message, and a capability that is not an actor message does not compose under this doctrine.

Every molecule is a delegation tree. Every delegation tree produces a receipt tree. Every receipt tree is independently verifiable. That is what "a motebit that delegates" means.

### 3.3 — How federation reads

Federation is what happens when the broker is plural. When a motebit on relay A delegates to a motebit on relay B, the actor model does not notice — the address is the same kind of thing, the receipt is the same kind of thing, the adjudication is the same kind of thing. The relay-federation spec (`spec/relay-federation-v1.md`) is the plumbing that keeps the broker role coherent across operators; it does not change the shape of the actor system, only its topology.

This is why federation-time design decisions — handshake, heartbeat, cross-relay dispute — can be made without reopening the question of what a motebit is. The actor pattern is invariant under the number of brokers. Plural brokers are an operational detail; singular sovereignty is the law.

### 3.4 — How multi-hop delegation reads

A multi-hop chain — `A delegates to B delegates to C` — is not a special case. It is the default. Every motebit can be a delegator or a worker in the next turn; the role is per-message, not per-actor. The nested `delegation_receipts` field makes the chain depth-agnostic: three hops look like one hop with one more layer of nesting. The verifier walks the tree. No chain-specific code is required because the causal log _is_ the chain.

The practical consequence: a three-agent composition (research → web-search → read-url) and a thirty-agent composition have the same verification path, the same failure modes, and the same supervision surface. The cost grows linearly with chain depth. The asymmetry is structural.

---

## IV. What This Does Not Change

Naming a pattern does not authorize rewrites.

**It is not a license to import a framework.** No external actor library, no new runtime, no message bus. The pattern is built out of primitives that already exist: signed receipts, the relay's routing, the MCP transport, the dispute spec. Importing an actor framework to "formalize" what the code already does would add a dependency whose invariants cross-cut the ones the motebit already enforces, and would bind the interior to a provider in violation of THE_METABOLIC_PRINCIPLE. The actor is not a framework. It is the shape these primitives take when arranged in the order the codebase already arranges them.

**It is not a reason to add a mailbox abstraction.** The relay's task queue, the per-motebit virtual account, the rate limiter, the federation dispatch — these are already the mailboxes, collectively. A unified `Mailbox<Message>` type would abstract away the very properties that make each of these load-bearing (the account is economic, the queue is backpressured, the federation dispatch is operator-scoped). Mailboxes in the abstract sense are a teaching device, not a primitive; the codebase does not need them.

**It is not a rewrite.** Nothing in this doctrine asks for a single line to change. Every service already handles `motebit_task`. Every service already signs its receipts. Every service already nests its delegation receipts. The dispute primitives are shipped. The federation primitives are shipped. What was missing was the name — and without the name, the next feature had no frame against which to be judged. With the name, the frame is the first four questions in §III.1.

**It is not a claim about liveness or concurrency.** This doctrine does not specify an execution model — how many messages may be in flight, what the progress guarantees are, how failure detectors work. Those are decisions that belong to the runtime and the relay, and they are documented where they live. The actor pattern as stated here is about _identity_, _causality_, and _supervision_. The runtime policies that animate it are not doctrine; they are tuning.

---

## V. Where This Lives in the System

The actor principle is the lens; the primitives are elsewhere.

Identity as address — the Ed25519 keypair in `@motebit/core-identity`, the motebit.md self-publication in `@motebit/identity-file`, derived by THE_SOVEREIGN_INTERIOR.md.

Messages — the `motebit_task` envelope, `McpClientAdapter` in `@motebit/mcp-client`, `startServiceServer` in `@motebit/mcp-server`, brokered through `services/api`'s `task-routing.ts`.

Receipts as causal log — the `ExecutionReceipt` type in `@motebit/sdk`, signed via `@motebit/crypto`, persisted byte-identical in `relay_receipts.receipt_json`, walked by any verifier.

Supervision — `spec/dispute-v1.md`, the `AdjudicatorVote` and `DisputeResolution` primitives in `@motebit/protocol`, adjudicated in `services/api/src/disputes`, extended across relays by `spec/relay-federation-v1.md`.

Self-signing of the actor's _interior_ work (as opposed to its delegated work) — the consolidation cycle of THE_SELF_SIGNING_BODY.md. The two chains compose: an execution receipt produced while a motebit is responsive, a consolidation receipt produced while the motebit is tending, both signed by the same identity key, both verifiable by the same `@motebit/crypto` primitives.

---

## VI. Relation to the Other Principles

**THE_SOVEREIGN_INTERIOR.md.** Every actor owns its interior. Supervision is at the boundary, never inside it. Adjudication modifies the signed record between actors; it does not reach into either actor's memory, trust, or state. Sovereignty is per-interior; supervision is per-interaction.

**THE_METABOLIC_PRINCIPLE.md.** The actor pattern is what the metabolic interior does with its outputs. Nutrient enters the boundary; the interior metabolizes it; the resulting action, when directed at another motebit, becomes a message. Interiority builds the actor's state; the actor pattern is how those states exchange work without dissolving into each other.

**THE_SELF_SIGNING_BODY.md.** The consolidation receipt signs the interior's work during tending. The execution receipt signs the interior's work during responsive. The chain of causality connecting them — "this memory was consolidated after this delegation completed" — is what makes the motebit a continuous actor rather than a sequence of unconnected performances. The two receipt types are the two axes of the same self-signed history.

**docs/doctrine/records-vs-acts.md.** A message is an act; a receipt is a record. The creature surface renders the delegation arc while a task is in flight; the panel renders the signed receipt after it lands. The actor principle is what makes the distinction causally precise: the act is the message, the record is the evidence the message left behind, and the receipt is the bridge between them.

---

## VII. Sufficiency

A motebit alone is a droplet. Two motebits exchanging work are actors.

The address is the public key — not a session token, not a platform handle, but the cryptographic fact that this interior is this interior and no other.

The broker is the relay — it routes, meters, observes, and keeps no custody of the work.

The causal log is the chain of signed receipts — every delegation is a link, every link is independently verifiable, and the chain depth is unbounded because each node is signed by its own interior.

The supervisor is the adjudicator — it resolves disputes between actors without violating either actor's interior, issuing a signed outcome that either interior may metabolize according to its own governance.

Every molecule is a delegation tree. Every delegation tree is a receipt tree. Every receipt tree is independently verifiable. Federation is a plural broker. Multi-hop is the default.

The pattern is already here. This document is the name.

That is sufficient.

---

_Motebit, 2026._
