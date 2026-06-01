/**
 * Credential anchor wire schemas — chain-anchored credential transparency.
 *
 * Two artifacts in this cluster:
 *
 *   1. `CredentialAnchorBatch` — a relay's signed Merkle root over
 *      a batch of issued credentials. Optionally references the
 *      onchain transaction that anchored the root.
 *
 *   2. `CredentialAnchorProof` — a self-verifiable Merkle inclusion
 *      proof for one credential within an anchored batch. Carries
 *      everything needed to verify the credential without trusting
 *      the relay: the batch signature + public key, the Merkle path,
 *      and (optionally) the chain reference.
 *
 * The cryptosuite here is `motebit-jcs-ed25519-hex-v1` — HEX signature
 * encoding (not base64url like execution receipts and delegation
 * tokens). That's deliberate: anchor proofs interact with chain
 * submissions where hex is the convention, and the suite registry
 * tracks the encoding-per-artifact mapping.
 *
 * Why publish these: chain anchoring is the primary mechanism by
 * which motebit's accumulated reputation becomes externally
 * verifiable without trusting any relay. A third-party auditor with
 * a credential, a proof, and chain access can prove the credential
 * was issued at the claimed time, was part of a batch the relay
 * signed, and that batch's Merkle root was committed onchain — no
 * relay contact required for any step. With these schemas, that
 * verification is mechanical for any language that can do JSON
 * Schema validation + Ed25519 + SHA-256.
 *
 * The nested `CredentialChainAnchor` (chain/network/tx_hash/
 * anchored_at) is structurally covered as a nested-only schema in
 * both top-level objects — it's not exported separately because it
 * has no independent wire identity, only meaning when carried inside
 * a Batch or a Proof.
 *
 * See spec/credential-anchor-v1.md.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { CredentialAnchorBatch, CredentialAnchorProof } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";
import type { ParityForward, ParityReverse } from "./__parity/check.js";

// ---------------------------------------------------------------------------
// Stable $id URLs
// ---------------------------------------------------------------------------

export const CREDENTIAL_ANCHOR_BATCH_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/credential-anchor-batch-v1.json";

export const CREDENTIAL_ANCHOR_PROOF_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/credential-anchor-proof-v1.json";

// ---------------------------------------------------------------------------
// Shared leaf factories
//
// `suite` and `signature`/`batch_signature` repeat across both artifacts.
// Factories (not shared constants) keep each emitted JSON Schema
// property its own object so descriptions survive zod-to-json-schema's
// $ref collapse — same architectural lesson as the migration cluster.
// ---------------------------------------------------------------------------

const suiteField = () =>
  z
    .literal("motebit-jcs-ed25519-hex-v1")
    .describe(
      "Cryptosuite identifier. Always `motebit-jcs-ed25519-hex-v1` for credential anchors: JCS canonicalization (RFC 8785), Ed25519 primitive, HEX signature encoding (not base64url — distinct from receipts/tokens because anchor proofs interact with onchain submissions where hex is conventional), hex public-key encoding. Verifiers reject missing or unknown values fail-closed.",
    );

const hexSignatureField = (signerNote: string) =>
  z
    .string()
    .min(1)
    .describe(`Hex-encoded Ed25519 signature over \`canonicalJson(payload)\`. ${signerNote}`);

const chainAnchorField = (location: string) =>
  z
    .object({
      chain: z
        .string()
        .min(1)
        .describe(
          "Chain identifier (e.g. `solana`, `eip155`). Coarse selector for verifier dispatch; the precise network is in `network`.",
        ),
      network: z
        .string()
        .min(1)
        .describe(
          "CAIP-2 network identifier (e.g. `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` for Solana mainnet). Lets verifiers query the right chain RPC for the transaction.",
        ),
      tx_hash: z
        .string()
        .min(1)
        .describe(
          "Transaction hash on the target chain. Verifiers fetch this transaction and confirm its payload contains the batch's Merkle root.",
        ),
      anchored_at: z
        .number()
        .describe(
          "Unix timestamp in milliseconds when the chain anchor was confirmed (block-finalized). Lets verifiers reject anchors that confirmed after the credentials they purport to anchor.",
        ),
    })
    .strict()
    .nullable()
    .describe(
      `Onchain anchor metadata, or \`null\` if the ${location} was signed but not yet submitted to a chain. Self-verifiable inclusion still works without an onchain anchor (Ed25519 over the Merkle root is sufficient); the chain anchor adds external timestamping that the relay cannot retroactively rewrite.`,
    );

/**
 * Optional `tree_hash_version` — the tree-hash recipe (RFC 6962 §2.1 leaf/node
 * domain-separation tags + hash). Closed `MerkleTreeVersion` enum; the
 * `z.infer extends MerkleTreeVersion` parity check locks this literal set to the
 * protocol union, so a registry addition that misses this file fails type-parity.
 */
const treeHashVersionField = () =>
  z
    .enum(["merkle-sha256-plain-v1", "merkle-sha256-rfc6962-v2"])
    .optional()
    .describe(
      "Tree-hash recipe for the Merkle path: which RFC 6962 §2.1 leaf-domain / node-domain tags and hash function built the root. **Absent ⇒ `merkle-sha256-plain-v1`** — no domain tags, the original behavior; every proof minted before this axis existed still verifies. `merkle-sha256-rfc6962-v2` applies the `0x00` leaf / `0x01` node tags. Separate axis from `suite` (which names the batch-SIGNATURE recipe, not the tree-hash). Verifiers resolve absent to the default and REJECT an unknown value fail-closed — never silently downgrade. See docs/doctrine/merkle-tree-hash-versioning.md.",
    );

// ---------------------------------------------------------------------------
// CredentialAnchorBatch — relay's signed batch envelope
// ---------------------------------------------------------------------------

export const CredentialAnchorBatchSchema = z
  .object({
    batch_id: z
      .string()
      .min(1)
      .describe("UUIDv4 batch identifier. Stable through anchor submission and verification."),
    relay_id: z
      .string()
      .min(1)
      .describe("Motebit identity of the relay that created the batch. The signer."),
    merkle_root: z
      .string()
      .min(1)
      .describe(
        "Hex-encoded SHA-256 Merkle root over the sorted credential hashes in the batch. The committed value — both the relay's signature and the onchain anchor reference this same root.",
      ),
    leaf_count: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Number of credentials in this batch (≥ 0). Required for signature verification — the canonical signed payload includes this field, so a verifier reconstructing the canonical bytes must use the right count.",
      ),
    first_issued_at: z
      .number()
      .describe(
        "Unix timestamp in milliseconds of the earliest credential in the batch. Lets verifiers detect batches that span impossibly long time windows (likely a relay manipulation signal).",
      ),
    last_issued_at: z
      .number()
      .describe(
        "Unix timestamp in milliseconds of the latest credential in the batch. Combined with `first_issued_at` defines the batch's temporal scope.",
      ),
    suite: suiteField(),
    signature: hexSignatureField("Signed by the relay over the canonical batch payload."),
    anchor: chainAnchorField("batch"),
  })
  .strict();

type _BatchForward = ParityForward<
  CredentialAnchorBatch,
  z.infer<typeof CredentialAnchorBatchSchema>
>;
type _BatchReverse = ParityReverse<
  CredentialAnchorBatch,
  z.infer<typeof CredentialAnchorBatchSchema>
>;

export const _CREDENTIAL_ANCHOR_BATCH_TYPE_PARITY: {
  forward: _BatchForward;
  reverse: _BatchReverse;
} = {
  forward: true,
  reverse: true,
};

export function buildCredentialAnchorBatchJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(CredentialAnchorBatchSchema, {
    name: "CredentialAnchorBatch",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("CredentialAnchorBatch", raw, {
    $id: CREDENTIAL_ANCHOR_BATCH_SCHEMA_ID,
    title: "CredentialAnchorBatch (v1)",
    description:
      "Relay-signed Merkle root over a batch of issued credentials. Optionally references the onchain transaction that anchored the root. The signed payload binds (batch_id, relay_id, merkle_root, leaf_count, first/last_issued_at, suite); `anchor` is metadata added after submission and is NOT part of the signed body. See spec/credential-anchor-v1.md.",
  });
}

// ---------------------------------------------------------------------------
// CredentialAnchorProof — self-verifiable Merkle inclusion proof
// ---------------------------------------------------------------------------

export const CredentialAnchorProofSchema = z
  .object({
    credential_id: z
      .string()
      .min(1)
      .describe("Identifier of the credential whose inclusion this proof attests."),
    credential_hash: z
      .string()
      .min(1)
      .describe(
        "Hex-encoded SHA-256 hash of the full credential (including the credential's own proof envelope). The leaf value at `leaf_index` of the Merkle tree.",
      ),
    batch_id: z
      .string()
      .min(1)
      .describe("Identifier of the CredentialAnchorBatch containing this credential."),
    merkle_root: z
      .string()
      .min(1)
      .describe(
        "Hex-encoded Merkle root of the batch. MUST match the batch's `merkle_root` and the value committed onchain (when `anchor` is non-null). Verifiers compute the root from `credential_hash` + `siblings` + `layer_sizes` and compare.",
      ),
    leaf_count: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Number of credentials in the batch. Required for batch-signature verification — the canonical signed payload includes this.",
      ),
    first_issued_at: z
      .number()
      .describe(
        "Earliest credential timestamp in the batch. Required for batch-signature verification (the canonical payload includes it).",
      ),
    last_issued_at: z
      .number()
      .describe(
        "Latest credential timestamp in the batch. Required for batch-signature verification.",
      ),
    leaf_index: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Position of this credential's leaf in the sorted leaf array (0-indexed). Determines the left/right walk through the Merkle tree.",
      ),
    siblings: z
      .array(z.string().min(1))
      .describe(
        "Hex-encoded sibling hashes along the Merkle path from leaf to root. Length is roughly log₂(leaf_count). Verifiers fold these with `credential_hash` per the path determined by `leaf_index`.",
      ),
    layer_sizes: z
      .array(z.number().int().nonnegative())
      .describe(
        "Number of nodes at each Merkle layer (leaf layer first). Lets verifiers detect odd-leaf promotion (when an odd-sized layer hoists a node unchanged into the next layer) — without this, the Merkle path could be ambiguous at odd boundaries.",
      ),
    relay_id: z.string().min(1).describe("Motebit identity of the relay that created the batch."),
    relay_public_key: z
      .string()
      .min(1)
      .describe(
        "Hex-encoded Ed25519 public key of the relay. Used to verify `batch_signature` against the canonical batch payload. Embedded in the proof so verification works without a relay-registry lookup.",
      ),
    suite: suiteField(),
    batch_signature: hexSignatureField(
      "Signed by the relay over the canonical batch payload (NOT this proof — this proof is self-verifiable but unsigned). Carried here so a verifier can confirm the batch is the relay's claimed batch.",
    ),
    anchor: chainAnchorField("proof's underlying batch"),
    tree_hash_version: treeHashVersionField(),
  })
  // Unsigned envelope — the proof itself isn't signed; it carries the
  // batch's signature for verification. Forward-compat per "unknown fields
  // MUST be ignored" — a v2 proof with extra debug fields (e.g. anchor
  // confirmations count) shouldn't break v1 verifiers. The nested `anchor`
  // and the inner Merkle-path fields stay strict — those are tight.
  .passthrough();

type _ProofForward = ParityForward<
  CredentialAnchorProof,
  z.infer<typeof CredentialAnchorProofSchema>
>;
type _ProofReverse = ParityReverse<
  CredentialAnchorProof,
  z.infer<typeof CredentialAnchorProofSchema>
>;

export const _CREDENTIAL_ANCHOR_PROOF_TYPE_PARITY: {
  forward: _ProofForward;
  reverse: _ProofReverse;
} = {
  forward: true,
  reverse: true,
};

export function buildCredentialAnchorProofJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(CredentialAnchorProofSchema, {
    name: "CredentialAnchorProof",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("CredentialAnchorProof", raw, {
    $id: CREDENTIAL_ANCHOR_PROOF_SCHEMA_ID,
    title: "CredentialAnchorProof (v1)",
    description:
      "Self-verifiable Merkle inclusion proof for one credential within an anchored batch. Carries everything needed to verify without trusting the relay: batch signature + relay public key, Merkle path (siblings + layer sizes + leaf index), and optional chain anchor. A third-party auditor can prove the credential was issued, batched, signed by the relay, and (when anchored) committed onchain — using only this proof + an Ed25519/SHA-256 implementation. See spec/credential-anchor-v1.md.",
  });
}
