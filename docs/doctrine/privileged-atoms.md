# Privileged atoms — the credential-holding atom, deferred

A "privileged atom" — an atom that holds a real credential behind the membrane and exposes only typed verbs to the molecule that composes it — is a tempting primitive with, today, exactly one would-be consumer: relay trust-root disaster recovery, where the operator acts on their own infrastructure. This memo names the open question and records the trigger for crystallizing the primitive when a **second, independent** consumer arrives — so a contributor doesn't mint a typed class on N=1. It also fixes the emphasis: the novel, defensible half is **not** credential isolation; it is the signed, delegation-chained, causal-closure receipt that proves a bounded action ran under named authority.

## The shape, and what is actually new

The atom/molecule vocabulary already ships. Per [`THE_ACTOR_PRINCIPLE.md`](../../THE_ACTOR_PRINCIPLE.md), a molecule is a motebit that composes simpler atoms through a supervised graph of delegations, and the molecule's receipt is the causal closure of its atoms' receipts. Today's atoms — `web-search`, `read-url`, `summarize`, `embed` — are **stateless, public** capability providers.

A privileged atom is the tempting subclass: `backup-relay-key`, `rotate-key`, `verify-backup` — an atom that holds a credential (a key, a cloud token) the composing intelligence is never allowed to see, and exposes only narrow typed verbs.

What is **not** new here: a service that holds a credential and exposes typed verbs is 1995 backend architecture. Credential isolation is HashiCorp territory — a commodity, and the cloud vendors will give it away. Selling that half loses.

What **is** new is Motebit-shaped and nobody else ships it: the privileged atom emits an offline-verifiable, delegation-chained, causal-closure receipt signed against a sovereign identity and pinnable from the operator's transparency anchor (per [`self-attesting-system.md`](self-attesting-system.md) and [`operator-transparency.md`](operator-transparency.md)). The value is **proof of bounded action under named authority** — any third party can audit exactly what authority flowed where, without trusting the service. That is the wedge.

## Isolation is commodity, not skippable

The receipt is the differentiator; it is not a substitute for getting isolation right. A signed receipt over an `exec(arbitrary)` atom is a cryptographically-verifiable record of a remote code execution. The atom's capability surface **is** the security boundary: verbs must be narrow and typed (`backup-relay-key`, not `exec(cmd)`; `rotate-key`, not `vault-write`). A generic exec or write atom reintroduces the all-or-nothing credential problem one layer down — the intelligence simply constructs the dangerous command as an argument. Typed narrow verbs are the precondition for the receipt to mean anything. Both, not either. See [`security-boundaries.md`](security-boundaries.md).

## What it is not

- **Not a standalone product.** Strip out sovereign identity, the delegation chain, and the signed receipt and what remains is a secrets manager + an OPA policy + a CI approval bot — useful and easy to copy. The defensibility is the Motebit stack underneath; unbundled, it commoditizes. This is the boundary layer of Motebit aimed at a sharper buyer, not a separate company.
- **Not enterprise-first.** The privileged-atom + ops-molecule shape must work identically for a non-subscriber (the protocol-first audit, [`protocol-primacy.md`](protocol-primacy.md)). The primitive is protocol-level; the managed/hosted broker is the commercial surface. Leading with an "enterprise surface" inverts the consumer-primary sequencing the product holds elsewhere.

## The deferral

N=1 today. The only would-be consumer is relay trust-root DR, and there the operator acts on themselves — the weakest possible generalization signal. Per [`registry-pattern-canonical.md`](registry-pattern-canonical.md) (don't mint a typed vocabulary's eight-artifact set without real consumers) and the no-abstraction-on-N=1 discipline, we name the doctrine and the trigger; the code follows when a second consumer grounds it. Same doctrine-first / code-second shape as [`evals-as-attestations.md`](evals-as-attestations.md).

The spine question — framed, deliberately not answered:

> Does the credential move from an **operator-run CLI** to a **relay-held atom**, and is the per-invocation causal-closure receipt worth that custody shift?

The custody shift is the whole decision. Moving the secret into a relay-held atom makes the atom's host a new trust root for that credential — its compromise is the credential's compromise. That recursion (you now protect the atom host the way you protect the relay key) is part of what a second consumer must justify. It is not obviously worth it for a one-off the operator can run themselves.

### Named trigger for crystallization

Crystallize a `PrivilegedAtom` typed class (with the eight-artifact closed registry per [`registry-pattern-canonical.md`](registry-pattern-canonical.md)) when a **second, independent credential-holding consumer arrives — of any kind**. Broad aperture is deliberate: a same-domain repeat (a second relay-key operation) would look alike trivially and false-positive the shape. The informative signal comes from a different credential entirely — an AWS access key, an SSH key, an OAuth refresh token, an MCP server credential, a third-party API key.

**Interpretation rule (strict shape-match).** A second secret-holder appearing is the trigger to _evaluate_, not to crystallize. The decision — one primitive, or a family — turns on whether consumer #2 wants the **same** delegation / receipt / revocation shape as relay-key DR, not on the mere fact that both hold a secret. A sovereign, irreplaceable trust root and a rotatable, third-party-issued cloud key may want different shapes; if #2 diverges, that is the signal that "privileged atom" is two families wearing one word. Resist the urge to pre-bake the comparison axes here — naming the likely-distinguishing dimensions in advance is the same premature-crystallization reflex one floor up. Consumer #2 grounds the axes.

## What ships now

The relay trust-root DR tooling — the `relay-key` operator CLI (`export` / `verify` / `import`, with an identity-match guard on restore) and [`services/relay/RUNBOOK-key-recovery.md`](../../services/relay/RUNBOOK-key-recovery.md). It is **not** a privileged atom: the operator holds the credential and runs the verb locally; there is no relay-held secret and no per-invocation delegation receipt. It is a one-off ops script, and that is the correct shape for N=1 — it closes the relay's single-copy trust-root risk without committing to the primitive.

The composition machinery — `@motebit/molecule-runner`, the delegation tree, the causal-closure receipt — already exists for the day the trigger fires. The first privileged-atom consumer composes into it; the deferral sequences the work, it does not strand it.

## Cross-cuts

- [`THE_ACTOR_PRINCIPLE.md`](../../THE_ACTOR_PRINCIPLE.md) — the atom/molecule vocabulary this builds on; molecule receipt = causal closure of atoms' receipts.
- [`delegation.md`](delegation.md) — the scope + TTL + chain primitive that is the bond, and the revocation surface a privileged atom would inherit.
- [`receipts-unified.md`](receipts-unified.md) — the receipt family the molecule's causal-closure receipt belongs to; the wedge is this, signed, pinnable.
- [`self-attesting-system.md`](self-attesting-system.md), [`operator-transparency.md`](operator-transparency.md) — why the receipt is auditable offline against a pinned identity.
- [`security-boundaries.md`](security-boundaries.md) — typed narrow verbs as the capability boundary; why `exec(arbitrary)` is the anti-pattern.
- [`protocol-primacy.md`](protocol-primacy.md) — the non-subscriber audit that keeps this protocol-level, not an enterprise tier.
- [`registry-pattern-canonical.md`](registry-pattern-canonical.md) — the eight-artifact promotion pattern `PrivilegedAtom` would follow when the trigger fires.
- [`evals-as-attestations.md`](evals-as-attestations.md) — the deferral template: name the doctrine first, ship the primitive when a real consumer arrives.
