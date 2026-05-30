# Merkle tree-hash versioning — RFC 6962 domain separation as a registry append

**Status:** in progress. PR1 part 1 (the `MerkleTreeVersion` registry) landed at commit `9cf876a8`; PR1 part 2 (Merkle-primitive plumbing + wire field + dispatch gate + registration closure) is next, autonomous and zero-behavior-change; PR2 (first real v2 producer — agent-settlement) returns for review.

## The problem is live drift, not a deferral

`spec/agent-settlement-anchor-v1.md` (§ "Leaf content") invokes "the SCITT / RFC 6962 invariant" for the per-agent settlement anchor. RFC 6962 §2.1 defines that invariant with **leaf/node domain separation**: a leaf hash is `SHA-256(0x00 ‖ entry)` and an interior node is `SHA-256(0x01 ‖ left ‖ right)`. The motebit Merkle primitive implements RFC-6962-**minus**-§2.1 — `packages/crypto/src/merkle.ts` (the offline verifier) and `packages/encryption/src/merkle.ts` (the producer) both hash interior nodes as `SHA-256(left ‖ right)` with no `0x01` tag, and leaves are `SHA-256(canonicalJson(x))` with no `0x00` tag.

Without the tags, an attacker can present an interior node's value as if it were a leaf (the second-preimage / leaf-vs-node confusion §2.1 exists to prevent). The spec claims the property; the code does not provide it. That is spec-vs-code drift on the money path — the meta-principle violation ("never let spec and code diverge"), made worse by being silent. The earlier framing of "deferred breaking change" understated it: the migration vehicle below makes it a **registry append, not a wire break**, so the deferral was never load-bearing.

## The fix is agility, not a break

A signed Merkle proof gains an optional `tree_hash_version` wire field. **Absent ⇒ `merkle-sha256-plain-v1`** (today's behavior) — so every proof minted to date still verifies offline. New producers emit `merkle-sha256-rfc6962-v2`. This is the cryptosuite-agility move from [`docs/doctrine/agility-as-role.md`](agility-as-role.md) applied to a new axis: name the role in code/types/gates, migrate by appending a registry entry, never break the wire.

## 1. The registry (a new agility axis)

A code-canonical closed registry `MerkleTreeVersion` in Apache-2.0 `@motebit/protocol`, modeled on the eight-artifact shape of [`packages/protocol/src/crypto-suite.ts`](../../packages/protocol/src/crypto-suite.ts) (`SuiteId` / `SUITE_REGISTRY` / `ALL_SUITE_IDS` / `isSuiteId` / `getSuiteEntry`), and locked by a closed-registry-canonical gate per [`docs/doctrine/registry-pattern-canonical.md`](registry-pattern-canonical.md):

- `merkle-sha256-plain-v1` — `status: legacy` (verifiers accept; producers MUST NOT emit). The current behavior, named so it can be verified, never re-emitted.
- `merkle-sha256-rfc6962-v2` — `status: preferred`. `0x00` leaf tag, `0x01` node tag, SHA-256.

This is a **separate axis from `SuiteId`**. The anchor proofs' existing `suite` field is the **signature** suite (`motebit-jcs-ed25519-hex-v1` over the batch payload); `tree_hash_version` is the **tree-hashing** suite. Keeping them distinct registries prevents the exact confusion the names would otherwise invite.

**Registry scope note (must live in the registry doc-comment):** a `MerkleTreeVersion` governs exactly `(leaf tag, node tag, hash function)`. It does **not** cover payload canonicalization — `canonicalJson` / JCS is the entry-bytes contract and versions independently. The next reviewer will assume it covers canonicalization unless the doc-comment excludes it explicitly.

## 2. Blast radius — two hash primitives, the leaf builders, the producers

Wider than "three consumers." There are **two** tree-hashing primitives kept in deliberate sync, and both change:

- **Producer / build:** `buildMerkleTree` + `getMerkleProof` + `verifyMerkleProof` in [`packages/encryption/src/merkle.ts`](../../packages/encryption/src/merkle.ts).
- **Offline verifier:** `verifyMerkleInclusion` in [`packages/crypto/src/merkle.ts`](../../packages/crypto/src/merkle.ts) — the zero-dep browser-side primitive, byte-identical algorithm by design (see [`packages/crypto/CLAUDE.md`](../../packages/crypto/CLAUDE.md) rule 6).

The `0x01` node tag lives in the combine step of **both**. The `0x00` leaf tag lives in the leaf builders, which both the producer and the offline verifier call to reconstruct the holder's leaf:

- `computeAgentSettlementLeaf` ([`packages/crypto/src/agent-settlement-anchor.ts`](../../packages/crypto/src/agent-settlement-anchor.ts))
- `computeCredentialLeaf` ([`packages/crypto/src/credential-anchor.ts`](../../packages/crypto/src/credential-anchor.ts))
- the identity-log leaf builder ([`services/relay/src/identity-log.ts`](../../services/relay/src/identity-log.ts))
- the consolidation-anchor leaf ([`packages/encryption/src/consolidation-anchor.ts`](../../packages/encryption/src/consolidation-anchor.ts))
- the federation-settlement leaf (deferred — folds into the item-4 convergence)

Inclusion-proof consumers that verify against a root: [`packages/crypto/src/witness-omission-dispute.ts`](../../packages/crypto/src/witness-omission-dispute.ts) (horizon-cert `federation_graph_anchor.merkle_root`), plus the per-artifact verifiers above.

## 3. Verifier dispatch surface

`verifyMerkleInclusion` and `buildMerkleTree`/`verifyMerkleProof` take a `treeHashVersion` parameter; the leaf builders take the same. Each anchor Proof wire type gains `tree_hash_version?`. Dispatch:

- **absent ⇒ `merkle-sha256-plain-v1`** (never silently upgraded);
- present ⇒ the named version, fail-closed on an unknown string (mirrors the `verifyBySuite` contract).

The high-level verifiers (`verifyAgentSettlementAnchor`, `verifyCredentialAnchor`, …) read `proof.tree_hash_version` and thread it down. External verifier surfaces verify **transitively** through these high-level functions, so they inherit v2 support without per-surface edits once the high-level verifiers dispatch (see §5).

## 4. Threat model — the downgrade attack (this is the point of §2.1)

`absent ⇒ v1` is the correct default and also exactly where a downgrade attack lives during migration. Explicit dispatch rules, not footnotes:

- **(a)** `tree_hash_version` absent → verify as v1, **never** silently upgraded to v2.
- **(b)** proof declares v2 but the verifier doesn't support v2 → **reject**, never fall back to v1.
- **(c)** a v2 producer MUST emit `tree_hash_version` from the first proof it mints — no "v2 behavior, absent field."
- **(d)** **deploy-verifier-first:** every verifier surface (§5) must accept v2 _before_ any producer emits v2. Same ordering cryptosuite migration follows. A producer that ships v2 ahead of a lagging verifier strands proofs that fail to verify — the classic agility-rollout footgun.

The window where second-preimage matters is the migration window; these rules close it.

## 5. External verifier surface enumeration

The verifier surface is wider than the internal callers and **all of it gets the version dispatch in PR1, before any producer flips:**

- `@motebit/verify` (the Apache-2.0 `motebit-verify` CLI) — verifies anchors offline via the high-level crypto verifiers.
- `@motebit/state-export-client` (browser) — verifies content manifests / inclusion proofs.
- any transparency-log / anchor-proof HTTP endpoint that re-verifies.

These call the high-level verifiers rather than `verifyMerkleInclusion` directly, so threading `tree_hash_version` through the high-level verifiers (PR1) gives them v2 support transitively. PR1 must confirm — by test — that each surface routes through a dispatching verifier, so none is the lagging verifier of rule (d).

## 6. The drift gate — and how the RFC-6962 claim is enforced structurally

A closed-registry canonical gate (sibling of `check-suite-dispatch` and the closed-registry-canonical meta-gate) asserts:

1. **Load-bearing assertion (sketch it before writing the gate):** every leaf-builder and every combine path either (a) routes through the version-dispatched primitive, or (b) appears on a documented exclusion list with a reason. This is the `check-suite-dispatch` shape — anything weaker ("registry exists, dispatch arms enumerated, all v1 IDs present") is the cosmetic registry-self-consistency shape that passes **vacuously** while the actual invariant (no inline `concat`-then-`sha256` outside the primitive) goes unchecked. Do not drift toward self-consistency.
2. `MerkleTreeVersion` union ↔ registry ↔ dispatch arms stay in sync (closed-registry shape) — the secondary check, not the load-bearing one.
3. The spec's RFC-6962 claim resolves to a producer that mints v2.

**Assertion (3) needs a structural mechanism, not doc-text matching — decide before writing the gate (a fail-open trap otherwise):**

- **Option A — machine-readable spec frontmatter:** the anchor spec declares its registered `tree_hash_version` and the producer symbol it governs in frontmatter; the gate reads the frontmatter and checks the named producer emits that version. Deterministic; adds a frontmatter convention.
- **Option B — wire-format-section parse:** the gate parses the spec's "Wire format" block for the `tree_hash_version` field value and checks the producer. Reuses the existing wire-format-section convention the spec-coverage gates already parse; more brittle to prose formatting.

**Recommendation: Option A** — explicit machine-readable declaration beats parsing prose; it is the same "make the claim a typed field, not a sentence" move the rest of the codebase prefers.

Each PR carries its own gate-effectiveness probe (inject the violation, assert the gate fires).

## 7. Known-answer vectors

Pin the `0x00`/`0x01` byte layout against a **named existing RFC-6962 test vector**, not a hand-rolled one (a self-rolled vector that matches our own implementation is a tautology, not a check). Source: Trillian's `merkle/rfc6962/rfc6962_test.go` (the canonical vectors verbatim from the RFC) or Sigstore rekor's `pkg/util/` fixtures (the production-credibility variant). Cite repo + commit hash + file + line in the test. **Include a multi-leaf asymmetric tree (e.g. 3 leaves, so the left subtree is taller)** — a single-leaf tree never exercises the node-tag path, which is the entire point of §2.1.

## 8. Staged rollout — three+ PRs, not one

Bundling hides whether the plumbing is correct independently of the first real consumer.

- **PR1 — agility infrastructure (autonomous, zero behavior change).** Split into two landable slices:
  - **Part 1 (LANDED, commit `9cf876a8`):** the `MerkleTreeVersion` registry in `@motebit/protocol` + tests + minor changeset. Lands green on its own as a dormant dispatch-axis closed union — the registered-registry meta-gate does NOT force promotion while it has no consumers.
  - **Part 2 (next):** `treeHashVersion` param on both Merkle primitives and all leaf builders, **v1 default everywhere**; `tree_hash_version?` on the Proof wire types; the verifier-surface threading of §5. All existing tests stay green because v1 is byte-identical to today. Three eyeballs from review: **(eyeball 1)** the gate's load-bearing assertion is §6's route-through-or-documented-exclusion, not self-consistency; **(eyeball 2)** wire-schemas round-trips absent→v1 AND two NEGATIVE fixtures — a v2-tagged proof presented to v1-only verifier code must **reject** (not silent-downgrade), and a v2 proof with the field stripped, verified against a known v2 anchor, must **fail on hash-chain mismatch** (confirm that is the actual failure mode, not silent acceptance of a different root); **(eyeball 3)** no per-hash allocation — module-level `LEAF_TAG_V2 = Uint8Array([0x00])` / `NODE_TAG_V2 = Uint8Array([0x01])` resolved once into a local before the combine loop; a `concat(tag, l, r)` per node is fine, allocating the tag per node is not.
  - **Registration closure ships WITH part 2, not a part 3.** The moment the wire field lands + dispatch goes live + multiple consumers route through it, all four registered-registry criteria (interop law, multi-consumer, wire-format presence, anticipated drift) flip true — so the `REGISTERED_REGISTRIES` append + drift-defenses row + the per-registry coverage gate (§6) must land alongside the plumbing, or the closed-registry meta-gate goes red the moment the plumbing does.
- **PR2 — agent-settlement migrates to v2 (returns for review):** the RFC-6962-citing spec's producer emits v2; producer/verifier symmetry and the deploy-verifier-first ordering get focused review; KAT vectors land here.
- **PR3+ — one consumer per PR:** credential-anchor, identity-log, consolidation-anchor, then federation-settlement (with the item-4 convergence).

## 9. Spec form — code-canonical registry, anchor specs reference it

Q1 was answered "sibling spec," reasoning from "cryptosuite is its own spec." Correction from the bytes: there is **no standalone cryptosuite spec file** — `SuiteId` is code-canonical in `crypto-suite.ts`, referenced by consumers. The faithful precedent is therefore a **code-canonical `MerkleTreeVersion` registry in `@motebit/protocol`**, with each anchor spec gaining a short "Tree-hash version" subsection that _references_ the registry by name rather than restating the hash contract. That still achieves the reviewer's actual goal — one home for the axis, so the next migration touches one registry, not N anchor specs — without inventing a spec-file convention cryptosuite itself doesn't use. (If a standalone spec file is wanted for third-party-verifier interop — a thin merkle-tree-hash spec under `spec/`, named per the `<thing>-v1` convention — it can be cut to point at the same registry; flag at PR2 when the first spec subsection lands.)

## 10. Open items

- PR1 part 1 landed (registry, `9cf876a8`). Next: PR1 part 2 (plumbing + registration closure, per §8) — picked up fresh.
- Confirm the gate-enforcement mechanism (§6 Option A vs B) at PR1 part 2.
- Federation-settlement (§2, PR3+) is the natural merge point for the deferred item-4 convergence (`agent-settlement-anchor-v1.md` §9.1) — the federated leaf becomes a verbatim-artifact hash under v2 in the same pass.
