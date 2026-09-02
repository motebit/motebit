/**
 * Identity-binding transparency wire schema — `GET /api/v1/identity/:motebitId`.
 *
 * The response an external verifier reads to answer the *binding* question:
 * does this public key really belong to this `motebit_id`? Signature integrity
 * alone can never establish that
 * (`docs/doctrine/identity-binding-verification.md`).
 *
 * Unlike most schemas in this package, the bundle itself is **not signed** —
 * and that is the point. The relay is a CDN here, not a trust root. Every claim
 * inside carries its own proof: succession records are signed by the motebit's
 * own keys (the relay stores them and cannot forge them), and the inclusion
 * proof is checked against a Merkle root the verifier confirms on-chain for
 * itself at the relay's pinned anchor address. There is no relay signature to
 * validate because there is no relay assertion to trust.
 *
 * `anchored: null` is therefore an honest state, not an error: the motebit is
 * not yet in a confirmed anchor and the verifier stays at `pinned` /
 * integrity-only.
 *
 * See `spec/identity-v1.md` §7.6.
 */

import { z } from "zod";

import type { IdentityBindingBundle } from "@motebit/protocol";

import { assembleJsonSchemaFor, toDraft7 } from "./assemble.js";
import type { ParityForward, ParityReverse } from "./__parity/check.js";

// ---------------------------------------------------------------------------
// Stable $id URL
// ---------------------------------------------------------------------------

export const IDENTITY_BINDING_BUNDLE_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/identity-binding-bundle-v1.json";

// ---------------------------------------------------------------------------
// Leaf vocabularies
// ---------------------------------------------------------------------------

const HEX_KEY = /^[0-9a-f]{64}$/;

const KeySuccessionRecordSchema = z
  .object({
    old_public_key: z
      .string()
      .regex(HEX_KEY, "old_public_key MUST be 64 lowercase hex characters")
      .describe("The key being replaced (hex-encoded Ed25519 public key)."),
    new_public_key: z
      .string()
      .regex(HEX_KEY, "new_public_key MUST be 64 lowercase hex characters")
      .describe("The key taking over (hex-encoded Ed25519 public key)."),
    timestamp: z.number().describe("Epoch milliseconds when the rotation took effect."),
    reason: z.string().optional().describe("Optional free-text rotation reason."),
    suite: z
      .literal("motebit-jcs-ed25519-hex-v1")
      .describe("Cryptosuite — JCS canonicalization, Ed25519, hex encoding."),
    old_key_signature: z
      .string()
      .optional()
      .describe(
        "Old key's signature over the canonical payload. Present in a normal rotation, ABSENT in a guardian recovery.",
      ),
    new_key_signature: z
      .string()
      .describe("New key's signature over the canonical payload. Always present."),
    recovery: z
      .boolean()
      .optional()
      .describe("True when the rotation was authorized by the guardian, not the old key (§3.8.3)."),
    guardian_signature: z
      .string()
      .optional()
      .describe("Guardian's signature — present only when `recovery` is true."),
  })
  .strict();

const IdentityLogProofSchema = z
  .object({
    index: z.number().describe("Leaf index of this motebit's binding in the identity log."),
    siblings: z.array(z.string()).describe("Merkle path siblings (hex), leaf-to-root."),
    layerSizes: z
      .array(z.number())
      .describe("Node count per tree layer — lets a verifier reconstruct an unbalanced tree."),
    anchoredRoot: z
      .string()
      .describe("The log's Merkle root (hex) — the value the relay posted on-chain."),
    // Same closed vocabulary as every other Merkle-bearing schema — a plain
    // `z.string()` here would drift from `MerkleTreeVersion` and break type
    // parity in the reverse direction.
    tree_hash_version: z
      .enum(["merkle-sha256-plain-v1", "merkle-sha256-rfc6962-v2"])
      .optional()
      .describe(
        "RFC 6962 §2.1 tree-hash recipe (`MerkleTreeVersion`). **Absent ⇒ `merkle-sha256-plain-v1`**, so proofs minted before this axis existed stay byte-identical. A verifier resolves an unknown value fail-closed — never a silent downgrade. See docs/doctrine/merkle-tree-hash-versioning.md.",
      ),
  })
  .strict();

const AnchoredInclusionSchema = z
  .object({
    proof: IdentityLogProofSchema.describe(
      "Inclusion proof whose `anchoredRoot` the verifier MUST confirm on-chain independently.",
    ),
    tx_hash: z.string().describe("The chain transaction that posted `anchoredRoot`."),
    network: z.string().describe("CAIP-2 network identifier of the anchor transaction."),
  })
  .strict();

// ---------------------------------------------------------------------------
// IdentityBindingBundle
// ---------------------------------------------------------------------------

export const IdentityBindingBundleSchema = z
  .object({
    motebit_id: z.string().min(1).describe("The motebit whose binding this describes."),
    created_at: z
      .string()
      .describe("ISO-8601 timestamp the genesis key became active (registration time)."),
    current_public_key: z
      .string()
      .regex(HEX_KEY, "current_public_key MUST be 64 lowercase hex characters")
      .describe("The motebit's CURRENT identity public key (hex) — the head of its chain."),
    guardian_public_key: z
      .string()
      .optional()
      .describe(
        "The guardian public key (hex), when one is registered. REQUIRED to verify a guardian-recovery link — without it a third party cannot check that link and the whole chain fails to verify.",
      ),
    succession: z
      .array(KeySuccessionRecordSchema)
      .describe("The self-signed rotation chain, genesis → current. Empty if never rotated."),
    anchored: AnchoredInclusionSchema.nullable().describe(
      "Inclusion proof against the latest CONFIRMED on-chain root, or `null` when this motebit is not yet in a confirmed anchor — an honest state, not an error.",
    ),
  })
  .strict();

type _InferredBundle = z.infer<typeof IdentityBindingBundleSchema>;
type _BundleForward = ParityForward<IdentityBindingBundle, _InferredBundle>;
type _BundleReverse = ParityReverse<IdentityBindingBundle, _InferredBundle>;

export const _IDENTITY_BINDING_BUNDLE_TYPE_PARITY: {
  forward: _BundleForward;
  reverse: _BundleReverse;
} = {
  forward: true,
  reverse: true,
};

export function buildIdentityBindingBundleJsonSchema(): Record<string, unknown> {
  const raw = toDraft7(IdentityBindingBundleSchema);
  return assembleJsonSchemaFor(raw, {
    $id: IDENTITY_BINDING_BUNDLE_SCHEMA_ID,
    title: "IdentityBindingBundle (v1)",
    description:
      "The `GET /api/v1/identity/:motebitId` response: a motebit's current key, its self-signed succession chain, and — once anchored — a Merkle inclusion proof against an on-chain root. The bundle carries no relay signature by design: the relay is a CDN, not a trust root, and every claim inside is independently verifiable. See spec/identity-v1.md §7.6.",
  });
}
