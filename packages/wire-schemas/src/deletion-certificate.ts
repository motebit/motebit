/**
 * Deletion certificate wire schema — single discriminated union with
 * three arms, one verifier (`@motebit/crypto :: verifyDeletionCertificate`),
 * one set of canonical signing rules.
 *
 * Three arms:
 *   - `mutable_pruning` — multi-signature (subject / operator / delegate
 *     / guardian, at-least-one-required by reason × signer × mode table).
 *   - `append_only_horizon` — single-issuer + co-witness signatures.
 *   - `consolidation_flush` — multi-signature, same shape as
 *     mutable_pruning plus a `flushed_to` discriminator.
 *
 * Suite: `motebit-jcs-ed25519-b64-v1`. JCS canonicalization, Ed25519
 * primitive, base64url signatures, hex public keys.
 *
 * See docs/doctrine/retention-policy.md §"Decision 1" for the canonical
 * shape and §"Decision 5" for the canonical signing payload (each
 * `*_signature` field is over `canonicalJson(cert minus all *_signature
 * fields)` — multi-signers sign identical bytes, mirroring identity-v1
 * §3.8.1).
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { DeletionCertificate } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";

// ---------------------------------------------------------------------------
// Stable $id URL
// ---------------------------------------------------------------------------

export const DELETION_CERTIFICATE_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/deletion-certificate-v1.json";

// ---------------------------------------------------------------------------
// Shared leaf factories
// ---------------------------------------------------------------------------

const suiteField = () =>
  z
    .literal("motebit-jcs-ed25519-b64-v1")
    .describe(
      "Cryptosuite identifier. Always `motebit-jcs-ed25519-b64-v1` for deletion certificates: JCS canonicalization (RFC 8785), Ed25519 primitive, base64url signature encoding, hex public-key encoding. Verifiers reject missing or unknown values fail-closed.",
    );

const sensitivityField = () =>
  z
    .enum(["none", "personal", "medical", "financial", "secret"])
    .describe(
      "Sensitivity level of the deleted record at deletion time. Same closed union as `SensitivityLevel` in @motebit/protocol. Drives the retention-floor check the runtime applied before issuing the cert.",
    );

const reasonField = () =>
  z
    .enum([
      "user_request",
      "retention_enforcement",
      "retention_enforcement_post_classification",
      "operator_request",
      "delegated_request",
      "self_enforcement",
      "guardian_request",
    ])
    .describe(
      "Action class — constrains the permitted signer set per the reason × signer × mode table (decision 5). Verifiers admit a cert iff the present signature(s) match the row for this reason and the operator's declared deployment mode.",
    );

const subjectSignatureField = () =>
  z
    .object({
      motebit_id: z
        .string()
        .min(1)
        .describe("The motebit whose identity key produced this signature."),
      suite: suiteField(),
      signature: z
        .string()
        .min(1)
        .describe(
          "Base64url-encoded Ed25519 signature over `canonicalJson(cert_body)` where `cert_body` is the cert with every `*_signature` field removed. All present signers sign identical bytes — mirrors identity-v1 §3.8.1 dual-signature succession.",
        ),
    })
    .strict();

const operatorSignatureField = () =>
  z
    .object({
      operator_id: z
        .string()
        .min(1)
        .describe(
          "Stable identifier for the operator key in the operator's transparency manifest.",
        ),
      suite: suiteField(),
      signature: z
        .string()
        .min(1)
        .describe(
          "Base64url-encoded Ed25519 signature, same canonical bytes as `subject_signature.signature`.",
        ),
    })
    .strict();

const delegateSignatureField = () =>
  z
    .object({
      motebit_id: z
        .string()
        .min(1)
        .describe(
          "The delegate's motebit identity (a third party authorized via delegation-v1.md §5.5).",
        ),
      delegation_receipt_id: z
        .string()
        .min(1)
        .describe(
          "Reference to the delegation receipt that authorized this scope. Verifiers MAY cross-check the receipt to confirm retention-scope authorization is in force.",
        ),
      suite: suiteField(),
      signature: z
        .string()
        .min(1)
        .describe("Base64url-encoded Ed25519 signature, same canonical bytes."),
    })
    .strict();

const guardianSignatureField = () =>
  z
    .object({
      guardian_public_key: z
        .string()
        .min(1)
        .describe(
          "Hex-encoded guardian Ed25519 public key. Verifiers MUST cross-check this against the subject motebit's `motebit.md` §3.3 `guardian.public_key` field — drift means the guardian binding is forged.",
        ),
      suite: suiteField(),
      signature: z
        .string()
        .min(1)
        .describe(
          "Base64url-encoded Ed25519 signature by the guardian over the same canonical bytes.",
        ),
    })
    .strict();

const merkleInclusionProofField = () =>
  z
    .object({
      siblings: z
        .array(z.string().min(1))
        .describe(
          "Hex-encoded sibling hashes ordered leaf-to-root. Same shape as credential-anchor-v1 §6.",
        ),
      leaf_index: z
        .number()
        .int()
        .nonnegative()
        .describe("0-based index of the witness's pubkey in the sorted peer set."),
      layer_sizes: z
        .array(z.number().int().nonnegative())
        .describe(
          "Per-layer node counts, used to detect odd-leaf promotion when reconstructing the root.",
        ),
    })
    .strict();

// ---------------------------------------------------------------------------
// mutable_pruning arm
// ---------------------------------------------------------------------------

const MutablePruningCertSchema = z
  .object({
    kind: z
      .literal("mutable_pruning")
      .describe(
        "Discriminator. Interop law per protocol-model.md §'Naming: interop law vs reference default' — verifiers dispatch on this exact string; alternative implementations cannot rename.",
      ),
    target_id: z
      .string()
      .min(1)
      .describe("The deleted record's identifier in the originating store (a NodeId for memory)."),
    sensitivity: sensitivityField(),
    reason: reasonField(),
    deleted_at: z.number().describe("Unix milliseconds when the runtime erased the record."),
    subject_signature: subjectSignatureField().optional(),
    operator_signature: operatorSignatureField().optional(),
    delegate_signature: delegateSignatureField().optional(),
    guardian_signature: guardianSignatureField().optional(),
  })
  .strict()
  .describe(
    "Mutable pruning cert — interior-structure deletion (memory). Attests bytes-unrecoverable, not tombstone (decision 7). Verifiers check at-least-one-signature-required AND every present signature against canonical bytes.",
  );

// ---------------------------------------------------------------------------
// append_only_horizon arm
// ---------------------------------------------------------------------------

const HorizonSubjectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("motebit"),
      motebit_id: z.string().min(1),
    })
    .strict()
    .describe("Per-motebit horizon — signed by the motebit's identity key."),
  z
    .object({
      kind: z.literal("operator"),
      operator_id: z.string().min(1),
    })
    .strict()
    .describe("Operator-wide horizon — signed by the operator key."),
]);

const HorizonWitnessSchema = z
  .object({
    motebit_id: z
      .string()
      .min(1)
      .describe(
        "Witnessing motebit's identity. The pubkey resolves through the same `resolveMotebitPublicKey` path as subject signatures.",
      ),
    signature: z
      .string()
      .min(1)
      .describe(
        "Base64url-encoded Ed25519 signature over `canonicalJson(cert minus signature)` — the SAME bytes the issuer signed. Witnesses sign the body INCLUDING themselves, so the array layout at issuer-signing time is fixed.",
      ),
    inclusion_proof: merkleInclusionProofField()
      .optional()
      .describe(
        "Optional Merkle inclusion proof for the witness's pubkey against `federation_graph_anchor.merkle_root`. Phase 4 quorum mechanisms either require this or accept signature-only witnesses; reserved here so phase 4 lands without a wire break.",
      ),
  })
  .strict();

const FederationGraphAnchorSchema = z
  .object({
    algo: z
      .literal("merkle-sha256-v1")
      .describe(
        "Closed registry of Merkle algorithm identifiers. `merkle-sha256-v1` body: SHA-256 leaves, binary tree with odd-leaf promotion (no duplication) per credential-anchor-v1 §3-5 + relay-federation-v1 §7.6, composed with this doctrine's peer-set canonicalization (operator's federation-peer Ed25519 public keys, hex-encoded lowercase, sorted ascending, at horizon_ts).",
      ),
    merkle_root: z
      .string()
      .min(1)
      .describe("Hex-encoded SHA-256 root over the canonical peer-set leaves."),
    leaf_count: z
      .number()
      .int()
      .nonnegative()
      .describe("Number of peer pubkeys in the anchored set."),
  })
  .strict();

const AppendOnlyHorizonCertSchema = z
  .object({
    kind: z.literal("append_only_horizon"),
    subject: HorizonSubjectSchema,
    store_id: z
      .string()
      .min(1)
      .describe("Stable identifier for the audit log within the operator's deployment."),
    horizon_ts: z
      .number()
      .describe(
        "Unix milliseconds. Entries with `timestamp < horizon_ts` are unrecoverable from this point on. Witnesses attest they accept the horizon at this value.",
      ),
    witnessed_by: z
      .array(HorizonWitnessSchema)
      .describe(
        "Federation peers co-witnessing the horizon advance. Empty array is permitted only when `witness_required` was false at issuance time (decision 9 — derived from federation graph state).",
      ),
    federation_graph_anchor: FederationGraphAnchorSchema.optional(),
    issued_at: z.number().describe("Unix milliseconds when the issuer signed."),
    suite: suiteField(),
    signature: z
      .string()
      .min(1)
      .describe(
        "Base64url-encoded Ed25519 signature over `canonicalJson(cert minus signature)`. Same bytes every witness signed.",
      ),
  })
  .strict()
  .describe(
    "Append-only horizon cert — whole-prefix truncation of an audit ledger. Subject discriminator names the issuer (per-motebit or operator-wide); both can coexist with `max` precedence (decision 8).",
  );

// ---------------------------------------------------------------------------
// consolidation_flush arm
// ---------------------------------------------------------------------------

const ConsolidationFlushCertSchema = z
  .object({
    kind: z.literal("consolidation_flush"),
    target_id: z
      .string()
      .min(1)
      .describe(
        "The flushed record's identifier in the originating store (a turn id, audit row id, etc.).",
      ),
    sensitivity: sensitivityField(),
    reason: reasonField(),
    flushed_to: z
      .enum(["memory_node", "expire"])
      .describe(
        "Disposition: `memory_node` if the flush produced a memory node (the node's `mutable_pruning` policy applies thereafter), `expire` if no derived structure was retained.",
      ),
    memory_node_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Present iff `flushed_to: memory_node`. References the consolidated node so audit trails reconstruct the derivation.",
      ),
    flushed_at: z.number().describe("Unix milliseconds."),
    subject_signature: subjectSignatureField().optional(),
    operator_signature: operatorSignatureField().optional(),
    delegate_signature: delegateSignatureField().optional(),
    guardian_signature: guardianSignatureField().optional(),
  })
  .strict()
  .describe(
    "Consolidation flush cert — surface-flow record disposition (conversation turn, tool-audit row). Multi-signature shape mirrors mutable_pruning; flushed_to discriminator names the disposition.",
  );

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export const DeletionCertificateSchema = z
  .discriminatedUnion("kind", [
    MutablePruningCertSchema,
    AppendOnlyHorizonCertSchema,
    ConsolidationFlushCertSchema,
  ])
  .describe(
    "Signed retention deletion certificate. Single discriminated union by `kind`. Adding a new shape ships as an additive arm here plus a new dispatch arm in `verifyDeletionCertificate` — never a rename of an existing one.",
  );

// Type-parity check — fails compile if zod shape drifts from protocol type.
type _Forward =
  DeletionCertificate extends z.infer<typeof DeletionCertificateSchema> ? true : never;
type _Reverse =
  z.infer<typeof DeletionCertificateSchema> extends DeletionCertificate ? true : never;
export const _DELETION_CERTIFICATE_TYPE_PARITY: { forward: _Forward; reverse: _Reverse } = {
  forward: true as _Forward,
  reverse: true as _Reverse,
};

export function buildDeletionCertificateJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(DeletionCertificateSchema, {
    name: "DeletionCertificate",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("DeletionCertificate", raw, {
    $id: DELETION_CERTIFICATE_SCHEMA_ID,
    title: "DeletionCertificate (v1)",
    description:
      "Signed retention deletion certificate — three arms (mutable_pruning, append_only_horizon, consolidation_flush) under one `kind` discriminator, one verifier in @motebit/crypto, one canonical signing rule per arm. See docs/doctrine/retention-policy.md.",
  });
}
