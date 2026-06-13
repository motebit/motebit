# motebit/consolidation-mutation-manifest@1.0

**Status:** Stable  
**Authors:** Daniel Hakim  
**Created:** 2026-06-13

## 1. Purpose

A motebit is a droplet of intelligence under surface tension. The interior is active: during idle windows it runs a consolidation cycle that reshapes its memory graph. `motebit/consolidation-receipt@1.0` makes the _fact and shape_ of that work verifiable — but only as structural counts, because its privacy boundary is the type (a receipt MUST never require a verifier to handle memory text).

The **ConsolidationMutationManifest** is the owner-facing adjunct that closes the remaining gap: it commits, cryptographically, to the _exact_ durable mutations a cycle formed, so an owner-facing surface can prove the sentences it displays are precisely the signed cycle's mutations — without the portable receipt ever carrying content.

Two artifacts, two privacy boundaries, one cryptographically joined account of becoming (`docs/doctrine/felt-interior.md`):

- **ConsolidationReceipt** (`consolidation-receipt-v1`) — portable, counts-only. A third party verifies that work happened.
- **ConsolidationMutationManifest** (this spec) — local, per-mutation digests. The owner verifies _what_ changed.

The two are joined by `receipt_id` + `receipt_digest`: the manifest references the exact signed receipt it supplements, so a regenerated or substituted receipt breaks the link.

## 2. Design Principles

**Counts-only receipt is preserved.** This manifest exists precisely so the receipt does NOT have to evolve. `ConsolidationReceipt` v1 is unchanged; a richer attestation lives in a separate artifact, not a receipt v2.

**Digests, never content.** The manifest commits to `content_sha256` — a one-way digest of each formed sentence — never the sentence itself. A verifier with the manifest and the local memory recomputes the digest to confirm a displayed sentence matches what was signed; a holder of the manifest alone learns nothing.

**Local today; the keyed-commitment + sync privacy model is export-triggered.** A raw `content_sha256` is dictionary-attackable only once the manifest travels _without_ its content (selective disclosure, cross-device sync). This increment keeps the manifest owner-local: it is stored beside the receipt in the local event log, and **stripped at the relay sync boundary** (ingress redaction, alongside sensitive `memory_formed` content) so it never persists at or forwards through the relay to a peer device. A raw digest therefore has no persisted remote dictionary surface. A keyed/salted commitment scheme — closing the residual client→relay transit window and enabling deliberate selective disclosure — is the follow-up forced by export/share.

**Domain-separated, no new suite.** The manifest is signed with the same `motebit-jcs-ed25519-b64-v1` recipe as the receipt family. Domain separation is by the `manifest_type` discriminator inside the signed body, so a receipt signature can never verify as a manifest and vice versa — no fresh `SuiteId` is minted.

**Retirements are not committed here.** A retired memory is displayed as a count, never content (it is being deleted; surfacing it would contradict the deletion), and the count is already covered by the receipt's signed `summary`. The manifest covers exactly what a surface displays as _detail_: the formed/refined lines.

## 3. ConsolidationMutationManifest

#### Wire format (foundation law)

Every implementation MUST emit and accept this exact shape when producing a signed manifest.

```
ConsolidationMutationManifest {
  manifest_type:   "consolidation_mutation_manifest"   // domain separation, inside the signed body
  schema_version:  "1"
  manifest_id:     string                  // UUIDv4 — manifest's own identity
  motebit_id:      string                  // signer's MotebitId
  cycle_id:        string                  // matches the receipt + consolidation_cycle_run event
  receipt_id:      string                  // the exact ConsolidationReceipt this supplements
  receipt_digest:  string                  // canonical SHA-256 (hex) of the signed receipt body
  mutations:       ConsolidationMutationCommitment[]   // ordered by node_id
  created_at:      number                  // ms since Unix epoch
  public_key?:     string                  // hex Ed25519 public key, for portable verification
  suite:           "motebit-jcs-ed25519-b64-v1"
  signature:       string                  // base64url Ed25519 signature
}
```

The TypeScript type `ConsolidationMutationManifest` in `@motebit/protocol` is the binding machine-readable form. Verifiers reject missing or unknown `suite` / `manifest_type` values fail-closed.

#### Storage (reference convention — non-binding)

The reference runtime persists the manifest beside its receipt, in the same `consolidation_receipt_signed` event, as `event.payload.mutation_manifest`. It is owner-local: the reference relay strips `mutation_manifest` from this event on sync ingress (`services/relay/src/redaction.ts`), so the manifest never persists at or forwards through the relay — only the counts-only receipt does.

## 4. ConsolidationMutationCommitment

#### Wire format (foundation law)

```
ConsolidationMutationCommitment {
  node_id:         string                  // the formed/refined memory node
  kind:            "formed" | "refined"    // creation vs modification — committed
  content_sha256:  string                  // SHA-256 (hex) of the node's content at formation
  provenance:      MemorySource            // taught/inferred/... — committed
  sensitivity:     SensitivityLevel        // tier that gates disclosure — committed
}
```

## 5. Signing

```
body      = manifest without `signature` (with `suite`, `manifest_type`, optional `public_key` set)
canonical = canonicalJson(body)   // JCS / RFC 8785
message   = UTF-8 bytes of canonical
signature = base64url(Ed25519.sign(message, motebit_private_key))
```

`mutations` MUST be sorted by `node_id` (lexicographic) before signing, so the canonical form is deterministic across implementations.

Reference producer: the motebit runtime signs the manifest immediately after signing the receipt, from the formed/refined nodes the consolidation cycle holds.

## 6. Verification

A surface claiming that displayed mutations are signature-covered MUST validate ALL of:

1. `manifest.suite === "motebit-jcs-ed25519-b64-v1"` and `manifest.manifest_type === "consolidation_mutation_manifest"` (fail-closed on mismatch).
2. `ok = Ed25519.verify(UTF-8 bytes of canonicalJson(body-without-signature), fromBase64url(manifest.signature), publicKey)`.
3. **Receipt linkage:** `manifest.receipt_id === receipt.receipt_id` AND `manifest.receipt_digest === canonicalSha256(signed receipt body)`.
4. **Per-mutation commitment:** for every displayed mutation, the local memory node's content hashes (SHA-256 hex) to the matching commitment's `content_sha256`, and the commitment's `provenance` + `sensitivity` match the node's — and the displayed mutation set equals the committed set (no extra, no missing).

If any check fails, the surface MUST NOT imply signature coverage of the details; the receipt's own counts remain independently valid.
