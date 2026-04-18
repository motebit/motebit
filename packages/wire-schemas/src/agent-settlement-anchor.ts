/**
 * Per-agent settlement anchor wire schemas — chain-anchored worker audit.
 *
 * Two artifacts in this cluster:
 *
 *   1. `AgentSettlementAnchorBatch` — a relay's signed Merkle root over
 *      a batch of signed `SettlementRecord`s. Optionally references the
 *      onchain transaction that anchored the root.
 *
 *   2. `AgentSettlementAnchorProof` — a self-verifiable Merkle inclusion
 *      proof for one settlement within an anchored batch. Carries
 *      everything needed to verify without trusting the relay: the batch
 *      signature + relay public key, the Merkle path, and (optionally)
 *      the chain reference.
 *
 * The cryptosuite here is `motebit-jcs-ed25519-hex-v1` — HEX signature
 * encoding (matches the credential-anchor cluster, distinct from the
 * base64url used by receipts/tokens). Anchor proofs interact with chain
 * submissions where hex is the convention.
 *
 * Why publish these: the per-agent settlement anchor is the "ceiling"
 * alongside the SettlementRecord signing "floor" (settlement-v1.md §3,
 * delegation-v1.md §6.4). A worker who holds (a) a signed
 * SettlementRecord, (b) this proof, and (c) the relay's public key can
 * prove they were paid the correct amount — and an external auditor can
 * resolve the chain transaction without contacting the relay. With
 * machine-readable JSON Schemas, that verification is mechanical for
 * any language that can do JSON Schema validation + Ed25519 + SHA-256.
 *
 * The nested `AgentSettlementChainAnchor` (chain/network/tx_hash/
 * anchored_at) is structurally covered as a nested-only schema in both
 * top-level objects — it has no independent wire identity, only meaning
 * when carried inside a Batch or a Proof.
 *
 * See spec/agent-settlement-anchor-v1.md.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { AgentSettlementAnchorBatch, AgentSettlementAnchorProof } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";

// ---------------------------------------------------------------------------
// Stable $id URLs
// ---------------------------------------------------------------------------

export const AGENT_SETTLEMENT_ANCHOR_BATCH_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/agent-settlement-anchor-batch-v1.json";

export const AGENT_SETTLEMENT_ANCHOR_PROOF_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/agent-settlement-anchor-proof-v1.json";

// ---------------------------------------------------------------------------
// Shared leaf factories
//
// Same "factories not constants" lesson as the credential-anchor cluster:
// each emitted JSON Schema property is its own object so descriptions
// survive zod-to-json-schema's $ref collapse.
// ---------------------------------------------------------------------------

const suiteField = () =>
  z
    .literal("motebit-jcs-ed25519-hex-v1")
    .describe(
      "Cryptosuite identifier. Always `motebit-jcs-ed25519-hex-v1` for per-agent settlement anchors: JCS canonicalization (RFC 8785), Ed25519 primitive, HEX signature encoding (matches the credential-anchor cluster — anchor proofs interact with onchain submissions where hex is conventional), hex public-key encoding. Verifiers reject missing or unknown values fail-closed.",
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
          "Chain identifier (e.g. `eip155`, `solana`). Coarse selector for verifier dispatch; the precise network is in `network`.",
        ),
      network: z
        .string()
        .min(1)
        .describe(
          "CAIP-2 network identifier (e.g. `eip155:8453` for Base mainnet). Lets verifiers query the right chain RPC for the transaction.",
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
          "Unix timestamp in milliseconds when the chain anchor was confirmed (block-finalized). Lets verifiers reject anchors that confirmed after the settlements they purport to anchor.",
        ),
    })
    .strict()
    .nullable()
    .describe(
      `Onchain anchor metadata, or \`null\` if the ${location} was signed but not yet submitted to a chain. Self-verifiable inclusion still works without an onchain anchor (Ed25519 over the Merkle root is sufficient); the chain anchor adds external timestamping that the relay cannot retroactively rewrite.`,
    );

// ---------------------------------------------------------------------------
// AgentSettlementAnchorBatch — relay's signed batch envelope
// ---------------------------------------------------------------------------

export const AgentSettlementAnchorBatchSchema = z
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
        "Hex-encoded SHA-256 Merkle root over the sorted settlement-leaf hashes in the batch. The committed value — both the relay's signature and the onchain anchor reference this same root.",
      ),
    leaf_count: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Number of settlements in this batch (≥ 0). Required for signature verification — the canonical signed payload includes this field, so a verifier reconstructing the canonical bytes must use the right count.",
      ),
    first_settled_at: z
      .number()
      .describe(
        "Unix timestamp in milliseconds of the earliest settlement in the batch. Lets verifiers detect batches that span impossibly long time windows (likely a relay manipulation signal).",
      ),
    last_settled_at: z
      .number()
      .describe(
        "Unix timestamp in milliseconds of the latest settlement in the batch. Combined with `first_settled_at` defines the batch's temporal scope.",
      ),
    suite: suiteField(),
    signature: hexSignatureField("Signed by the relay over the canonical batch payload."),
    anchor: chainAnchorField("batch"),
  })
  .strict();

type _BatchForward =
  AgentSettlementAnchorBatch extends z.infer<typeof AgentSettlementAnchorBatchSchema>
    ? true
    : never;
type _BatchReverse =
  z.infer<typeof AgentSettlementAnchorBatchSchema> extends AgentSettlementAnchorBatch
    ? true
    : never;

export const _AGENT_SETTLEMENT_ANCHOR_BATCH_TYPE_PARITY: {
  forward: _BatchForward;
  reverse: _BatchReverse;
} = {
  forward: true as _BatchForward,
  reverse: true as _BatchReverse,
};

export function buildAgentSettlementAnchorBatchJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(AgentSettlementAnchorBatchSchema, {
    name: "AgentSettlementAnchorBatch",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("AgentSettlementAnchorBatch", raw, {
    $id: AGENT_SETTLEMENT_ANCHOR_BATCH_SCHEMA_ID,
    title: "AgentSettlementAnchorBatch (v1)",
    description:
      "Relay-signed Merkle root over a batch of signed SettlementRecords. Optionally references the onchain transaction that anchored the root. The signed payload binds (batch_id, relay_id, merkle_root, leaf_count, first/last_settled_at, suite); `anchor` is metadata added after submission and is NOT part of the signed body. See spec/agent-settlement-anchor-v1.md.",
  });
}

// ---------------------------------------------------------------------------
// AgentSettlementAnchorProof — self-verifiable Merkle inclusion proof
// ---------------------------------------------------------------------------

export const AgentSettlementAnchorProofSchema = z
  .object({
    settlement_id: z
      .string()
      .min(1)
      .describe("Identifier of the settlement whose inclusion this proof attests."),
    settlement_hash: z
      .string()
      .min(1)
      .describe(
        "Hex-encoded SHA-256 hash of the canonical SettlementRecord (signature included — the leaf commits the WHOLE signed artifact, so reconstruction at verification time uses the bytes the worker already holds). The leaf value at `leaf_index` of the Merkle tree.",
      ),
    batch_id: z
      .string()
      .min(1)
      .describe("Identifier of the AgentSettlementAnchorBatch containing this settlement."),
    merkle_root: z
      .string()
      .min(1)
      .describe(
        "Hex-encoded Merkle root of the batch. MUST match the batch's `merkle_root` and the value committed onchain (when `anchor` is non-null). Verifiers compute the root from `settlement_hash` + `siblings` + `layer_sizes` and compare.",
      ),
    leaf_count: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Number of settlements in the batch. Required for batch-signature verification — the canonical signed payload includes this.",
      ),
    first_settled_at: z
      .number()
      .describe(
        "Earliest settlement timestamp in the batch. Required for batch-signature verification (the canonical payload includes it).",
      ),
    last_settled_at: z
      .number()
      .describe(
        "Latest settlement timestamp in the batch. Required for batch-signature verification.",
      ),
    leaf_index: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Position of this settlement's leaf in the sorted leaf array (0-indexed). Determines the left/right walk through the Merkle tree.",
      ),
    siblings: z
      .array(z.string().min(1))
      .describe(
        "Hex-encoded sibling hashes along the Merkle path from leaf to root. Length is roughly log₂(leaf_count). Verifiers fold these with `settlement_hash` per the path determined by `leaf_index`.",
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
  })
  // Unsigned envelope — the proof itself isn't signed; it carries the
  // batch's signature for verification. Forward-compat per "unknown fields
  // MUST be ignored" — a v2 proof with extra debug fields shouldn't break
  // v1 verifiers. The nested `anchor` and the inner Merkle-path fields stay
  // strict — those are tight.
  .passthrough();

type _ProofForward =
  AgentSettlementAnchorProof extends z.infer<typeof AgentSettlementAnchorProofSchema>
    ? true
    : never;
type _ProofReverse =
  z.infer<typeof AgentSettlementAnchorProofSchema> extends AgentSettlementAnchorProof
    ? true
    : never;

export const _AGENT_SETTLEMENT_ANCHOR_PROOF_TYPE_PARITY: {
  forward: _ProofForward;
  reverse: _ProofReverse;
} = {
  forward: true as _ProofForward,
  reverse: true as _ProofReverse,
};

export function buildAgentSettlementAnchorProofJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(AgentSettlementAnchorProofSchema, {
    name: "AgentSettlementAnchorProof",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("AgentSettlementAnchorProof", raw, {
    $id: AGENT_SETTLEMENT_ANCHOR_PROOF_SCHEMA_ID,
    title: "AgentSettlementAnchorProof (v1)",
    description:
      "Self-verifiable Merkle inclusion proof for one per-agent settlement within an anchored batch. Carries everything needed to verify without trusting the relay: batch signature + relay public key, Merkle path (siblings + layer sizes + leaf index), and optional chain anchor. A worker (or external auditor) can prove the settlement was attested by the relay, batched, signed, and (when anchored) committed onchain — using only this proof + the signed SettlementRecord + an Ed25519/SHA-256 implementation. See spec/agent-settlement-anchor-v1.md.",
  });
}
