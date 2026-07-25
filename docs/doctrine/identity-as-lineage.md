# Identity is a lineage of authorized transitions

Accountable identity is not a persistent object. It is not a model hash, a private key, a memory archive, a running process, an account, or a name — every one of those can be copied, rotated, rewritten, migrated, or forked, and none of them alone survives autonomous change. Accountable identity is a **verifiable lineage of authorized transitions**: the answer to _who was authorized, under which policy, linked to what prior state, with what evidence a third party can re-check without trusting the actor's own narrative._

This is the move ledger-native money made: a coin is defined by its valid transaction history, not by persistent substance. Applied to an agent, the actor is the valid passage from state to state, not the implementation carried between states.

## The pipeline is one object, not seven features

Motebit's seven stages are usually read as a sequence:

> identity → authorization → policy → action → receipt → settlement → trust

The lens says: read them as **one object** — a continuity relation over transitions. A transition has standing only when it is authority-sound, policy-safe at the commitment boundary, cryptographically linked to prior state, non-equivocating, fork-aware, and independently verifiable. Every stage is a conjunct of that single predicate, not a separate concern that happens to sit downstream of the last. The pipeline is where the relation is _evaluated_; it is not seven things wired together.

This is the companion to [identity-universal-boundary](identity-universal-boundary.md) ("the invariant is the full pipeline, not 'agent identity'") — that doc says the pipeline is the boundary; this one says the pipeline is a single continuity relation, and names what it relates.

## What the lens changes

- **Build:** a new capability isn't done when it _works_ — it's done when its transition carries standing (authorized, policy-checked, linked, receipted) and a third party can re-check it. The eye/hand law and the R4 authority gate are instances; [composition-preserves-enforcement](composition-preserves-enforcement.md) is the proof that the relation must remain _enforced across the deployed system_, not merely true per-component.
- **Sell:** the product is not "agent identity." It is standing — the ability to prove an action belonged to a lineage and stayed within delegated authority. That reframes the moat as the trusted, re-checkable history (see [clearing-house-not-thin-waist](clearing-house-not-thin-waist.md)).
- **Fork:** copying does not dissolve accountable identity — it creates a transition that must declare lineage-distinct descendants and explicitly partition, suspend, or revoke inherited authority. **A fork may copy state; it may not silently duplicate standing.** Identity survives substrate change exactly when the change is a validly authorized, witnessed, bounded transition (see [identity-binding-verification](identity-binding-verification.md), [identity-restore](identity-restore.md)).

## Boundary

This is a lens, not a theorem and not a metaphysics. It defines identity _for systems that exercise authority_ — it makes no claim about personal identity, consciousness, or the self. Names here are provisional; the invariant is canonical. The lens earns its keep by sharpening what we build and how we describe it, daily — not by becoming a program. If it starts wanting to be more than this page, that is the signal to stop, not to expand.
