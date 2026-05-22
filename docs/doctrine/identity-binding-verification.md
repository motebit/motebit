# Identity binding is verifiable — trust-minimized, never standalone

A signed receipt proves two separate things, and a verifier must never conflate them: **integrity** ("these bytes were signed by _some_ key and weren't tampered") and **binding** ("that key belongs to the claimed `motebit_id`"). Integrity is checkable offline from the receipt alone. Binding is not — and never can be from the receipt alone. This memo names how binding _is_ verified, why it is trust-minimized rather than trust-free, and the tiers and triggers for building the path from the honest integrity-only floor that ships today.

## Integrity is math; binding needs a root

A key cannot prove who it belongs to by itself — this is a property of cryptography, not a motebit shortfall. There are only two ways anything binds a key to an identity:

1. **Self-certifying** — make the identity _be_ the key (`did:key`, or `id = hash(key)`). Binding is then tautological and zero-trust, but the identity dies with the key: no rotation, no multi-device, no recovery.
2. **A trust-minimized anchor** — a published, signed, append-only, on-chain-anchored mapping from identity to key (plus rotations) that a third party checks. Not zero-trust, but the operator cannot equivocate without leaving on-chain-detectable evidence.

Motebit lands in case 2 _by deliberate design_. `motebit_id` is a persistent identifier, not `hash(public_key)`, precisely so identity survives key loss, rotation, and succession (the [`identity-restore.md`](identity-restore.md) split; the sovereign-receipt decoupling in [`self-attesting-system.md`](self-attesting-system.md)). The binding anchor is therefore not a hole — it is the necessary cost of recoverable sovereign identity. You cannot have self-certification and recoverability at once; motebit chose recoverability.

## The split: sovereign root, operator availability

This is Key Transparency (CONIKS / Certificate-Transparency lineage) cast in motebit terms. Binding has a root, and the root is the _sovereign_, not the operator:

- **Sovereign root (the trust anchor).** The motebit's own genesis key self-certifies its `motebit_id`, and a rotation chain — each link signed by its predecessor — carries provenance from genesis to the receipt's signing key. This chain is self-verifying against the motebit's own keys; the operator is not trusted for it. The artifacts already exist: the self-signed identity file (`@motebit/identity-file`) carries the genesis key, and `verifyIdentityFile` already validates a `succession` chain.
- **Operator role (availability, not trust).** The operator publishes the chain in an append-only log whose Merkle root is anchored on Solana (the existing `fetchTransparencyAnchor` declaration + anchoring path). Its only job is _non-equivocation_: it can serve the binding but cannot hide a rotation or show two verifiers different chains without on-chain-detectable evidence.

The verifier therefore roots binding in the sovereign's keys and uses the operator only to prove the operator cannot lie about _which_ chain is current.

## Binding is a ladder, not a boolean

Binding strength is an additive score, the same shape as [`hardware-attestation.md`](hardware-attestation.md) — never a gate. The verifier renders the rung it reached, honestly:

- **unverified** — no anchor; integrity-only (today's default in `verifyReceiptDocument`).
- **pinned** — the receipt's key matches a key the caller supplied or trust-on-first-used. The `trustedAnchor` argument to `verifyReceiptChain` (which already reports `keySource: "external"` vs `"embedded"`) is exactly this hook.
- **anchored** — operator-attested, against an append-only log with an on-chain Merkle root; the operator cannot equivocate.
- **sovereign** — rooted in the genesis key; the operator is pure CDN-plus-anchor.

Each rung is strictly more trust-minimized than the last. `receipt.computer` shows the rung, not a green/red binary.

## What ships now

The integrity-only floor is live and honest: `verifyReceiptDocument` in `@motebit/state-export-client` and the `apps/verify` surface separate integrity from binding and refuse to claim identity they cannot anchor. A valid offline check renders as `integrity-only`, never `bound`. The **pinned** rung composes `verifyKeyBindingAtTime` against a caller-supplied identity file (the key is time-valid in the motebit's own succession chain) — no new infrastructure.

The **anchored** rung is now built end-to-end. The relay runs an identity-transparency log of motebit→key bindings (`services/relay/src/identity-log.ts`), a periodic loop anchors its Merkle root on Solana whenever the binding set changes (`identity-log-anchoring.ts`, the generic `motebit:anchor:v1:` memo), and `GET /api/v1/identity/:motebitId` serves a binding plus a Merkle inclusion proof built against the latest **confirmed on-chain** root (with its `tx_hash`). The verifier closes the loop: `verifyIdentityBindingAnchored` (`@motebit/crypto`) checks inclusion under the proof's root, and `lookupIdentityLogAnchor` (`@motebit/state-export-client`) independently confirms that root is on-chain at the relay's **pinned** address before `verifyReceiptDocument` returns `binding: "anchored"`. It degrades honestly to `pinned` when the root isn't on-chain.

Remaining: surfacing `anchored` in `receipt.computer`'s UI (the data path is ready; the UI rung is a follow-up), and **revocation** (below). The rotated-after-anchor edge currently degrades to `pinned` (the anchored snapshot commits to the old key).

## Named triggers for the higher rungs

Build the **sovereign** rung when the binding must root in math rather than operator attestation: evolve `motebit_id` minting so the identifier commits to a genesis key derived deterministically from the recovery seed. That makes binding self-certifying _and_ recoverable — the single change that removes the operator from the binding trust root entirely. It touches `core-identity` and [`identity-restore.md`](identity-restore.md) and is the endgame.

## Failure modes the build must handle

- **Time-windowing.** An old receipt was signed by a since-rotated key. Binding must check the key was valid _at_ `completed_at` against the dated rotation chain — not merely "is this the current tip." Otherwise a rotated-away key still appears to bind.
- **Revocation.** A compromised, revoked key must fail binding for receipts dated after revocation.
- **Split-view.** _Handled._ The verifier checks inclusion against the proof's root AND confirms that exact root is posted on-chain at the operator's pinned address (`lookupIdentityLogAnchor`) — it does not trust the served root alone. Binding above `pinned` is therefore **not** zero-network (unlike integrity): it fetches the identity proof and reads a neutral chain. The pinned relay address is the out-of-band trust root and MUST NOT come from the bundle (circular trust).
- **Bootstrap.** The first pin of the operator's transparency key is trust-on-first-use; the on-chain anchor of the declaration mitigates a first-contact swap.

## Cross-cuts

- [`self-attesting-system.md`](self-attesting-system.md) — every claim user-verifiable; this memo is the binding half of that promise, and the sovereign-receipt decoupling is why binding needs an anchor.
- [`operator-transparency.md`](operator-transparency.md) — declared vs proven posture; the transparency log and on-chain anchor are what make the operator's binding claims non-equivocable.
- [`identity-restore.md`](identity-restore.md) — genesis key, rotation, and succession: the sovereign chain binding roots in, and the recovery seed the sovereign rung derives genesis from.
- [`hardware-attestation.md`](hardware-attestation.md) — the additive-scoring shape the binding ladder inherits; binding is a score, never a gate.
- [`receipts-unified.md`](receipts-unified.md) — the receipt family whose integrity is provable standalone and whose binding is not.
