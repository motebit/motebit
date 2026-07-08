/**
 * EvalAttestation — wire schema.
 *
 * The signed third-party-measurement artifact (subject ≠ signer;
 * docs/doctrine/evals-as-attestations.md, promoted 2026-07-08 with the
 * Auditor archetype as consumer #1). Each measurement embeds a whole
 * per-axis VerificationVerdict — never a flattened boolean — so the
 * verdict family's no-silent-true discipline carries into the attestation.
 *
 * Canonicalization: JCS (RFC 8785) via `canonicalJson` — keys sorted,
 * `undefined` omitted. Signing: Ed25519 over the canonicalized body
 * (excluding `signature`); suite pinned to `"motebit-jcs-ed25519-b64-v1"`
 * (Rule 6 — the literal, never the SuiteId union). Verification law:
 * `verifyEvalAttestation` in `@motebit/crypto` — envelope only, never
 * measurement truth.
 *
 * Third-party implementers fetch the published JSON Schema via its stable
 * `$id` and validate attestations without bundling `@motebit/protocol` —
 * a third-party scorer can emit conforming evals from any language.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { ALL_EVAL_KINDS } from "@motebit/protocol";
import type {
  EvalAttestation,
  EvalKind,
  EvalResult,
  VerificationVerdict,
  RepairInstruction,
  RevocationVerdict,
} from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";
import { EvidenceProvenanceSchema } from "./evidence-provenance.js";
import type { ParityForward, ParityReverse } from "./__parity/check.js";

/** Stable `$id` for the eval-attestation v1 wire format. External tools pin to this. */
export const EVAL_ATTESTATION_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/eval-attestation-v1.json";

// ---------------------------------------------------------------------------
// Verdict leaf schemas (the graduated verification-verdict vocabulary)
// ---------------------------------------------------------------------------

export const RepairInstructionSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .describe('Stable, machine-readable reason code (e.g. "revocation.unchecked").'),
    axis: z
      .enum(["integrity", "identityBinding", "authority", "revocation"])
      .describe("Which axis failed."),
    summary: z.string().min(1).describe("One-line human summary of what's wrong."),
    canonical: z
      .string()
      .optional()
      .describe("The canonical source of truth to consult or fix, when applicable."),
    fix: z.string().min(1).describe("The concrete next step to establish the axis."),
  })
  .strict()
  .describe(
    "Machine-readable repair instruction for a failing axis — the gate-repair contract applied to verification.",
  );

export const RevocationVerdictSchema = z
  .object({
    status: z
      .enum(["fresh", "stale", "unchecked", "revoked"])
      .describe('Revocation status. `unchecked` NEVER reads as "not revoked".'),
    freshness: z
      .object({
        basis: z
          .enum(["asserted", "stapled", "ledger"])
          .describe(
            "Evidence-grade ladder, weakest to strongest. The verdict carries the basis; the consumer holds the tolerance.",
          ),
        asOf: z
          .object({
            timestamp_ms: z
              .number()
              .int()
              .optional()
              .describe("Wall-clock ms the revocation set was current as of, when known."),
            anchor: z
              .object({
                chain: z.string().min(1),
                slot: z.number().int().optional(),
                height: z.number().int().optional(),
              })
              .strict()
              .optional()
              .describe("Deterministic chain anchor the set was current as of, when known."),
          })
          .strict(),
      })
      .strict()
      .optional()
      .describe("Present when `status` derives from a freshness basis."),
  })
  .strict()
  .describe("The revocation axis: status plus how that status was established.");

const EvidenceRefSchema = z
  .object({
    kind: z.string().min(1).describe("Free-form snake_case evidence category (issuer convention)."),
    ref: z
      .string()
      .min(1)
      .describe("Pointer to the evidence (a digest, a key id, a revocation root)."),
    provenance: EvidenceProvenanceSchema.optional().describe(
      "Optional re-verifiable provenance — digest over raw bytes + verbatim span (evidence-provenance-v1).",
    ),
  })
  .strict()
  .describe("A reference to the evidence an axis or attestation was established from.");

export const VerificationVerdictSchema = z
  .object({
    type: z
      .enum([
        "identity",
        "receipt",
        "tool-invocation",
        "credential",
        "presentation",
        "skill",
        "unknown",
        "delegation_token",
        "succession",
        "revocation",
        "bond_commitment",
        "solvency_proof",
      ])
      .describe("What the verdict is about (the closed VerdictSubject union)."),
    integrity: z
      .enum(["verified", "invalid"])
      .describe("Did the signature verify over canonical bytes?"),
    identityBinding: z
      .enum(["sovereign", "anchored", "pinned", "unverified", "invalid"])
      .describe("The identity-binding rung — how strongly the key is bound to the motebit_id."),
    authority: z
      .enum(["valid", "expired", "not_yet_valid", "insufficient", "unknown"])
      .describe("Whether the authority covering the action holds. `unknown` is never a pass."),
    revocation: RevocationVerdictSchema,
    temporalBasis: z
      .enum(["clockless", "local_clock", "ledger_anchored"])
      .describe("The temporal basis time-dependent axes were evaluated against."),
    evidenceBasis: z
      .array(EvidenceRefSchema)
      .describe("The evidence each axis was established from."),
    repair: RepairInstructionSchema.optional().describe(
      "Present whenever any axis is not passing; absent only on a clean pass.",
    ),
  })
  .strict()
  .describe(
    "The structured per-axis verification verdict — DELIBERATELY no top-level `valid` boolean; a consumer branches on the axis it depends on.",
  );

// ---------------------------------------------------------------------------
// EvalResult + EvalAttestation
// ---------------------------------------------------------------------------

export const EvalResultSchema = z
  .object({
    check: z
      .string()
      .min(1)
      .describe(
        "Measurement identifier — free-form snake_case BY CONVENTION (issuer-owned check catalog); the embedded verdict carries the interop-law values.",
      ),
    verdict: VerificationVerdictSchema,
  })
  .strict()
  .describe("One named measurement inside an attestation.");

export const EvalAttestationSchema = z
  .object({
    attestation_id: z.string().min(1).describe("UUIDv7, issuer-generated."),
    eval_kind: z
      // Cast preserves the literal EvalKind union in z.infer; runtime validation
      // checks the same ALL_EVAL_KINDS values (closed registry, fail-closed intake).
      .enum(ALL_EVAL_KINDS as unknown as [EvalKind, ...EvalKind[]])
      .describe(
        "Measurement family — closed EvalKind registry; a consumer that cannot interpret the family fails closed.",
      ),
    subject: z
      .object({
        motebit_id: z
          .string()
          .min(1)
          .describe("The measured party. MAY equal the issuer's (self-issued floor)."),
        artifact_digests: z
          .array(
            z
              .object({
                algorithm: z.enum(["sha-256"]),
                value: z.string().regex(/^[0-9a-f]+$/, "digest value MUST be lowercase hex"),
              })
              .strict(),
          )
          .optional()
          .describe("Content addresses of the subject artifacts the measurement consumed."),
      })
      .strict()
      .describe(
        "The measured party (subject ≠ signer is the category law; subject MAY equal issuer as the self-issued floor).",
      ),
    issuer: z
      .object({
        motebit_id: z.string().min(1).describe("The measuring party — the SIGNER."),
        public_key: z
          .string()
          .regex(/^[0-9a-f]{64}$/i, "issuer public key MUST be 32-byte hex Ed25519")
          .describe("Issuer's Ed25519 public key, lowercase hex — self-describing."),
      })
      .strict()
      .describe("The measuring party — the SIGNER; its key is embedded self-describingly."),
    issued_at: z.number().int().describe("Unix ms — when the measurement was signed."),
    expires_at: z
      .number()
      .int()
      .optional()
      .describe(
        "Optional issuer-declared staleness bound. Carried, consumer-policied; the verify law does NOT enforce it.",
      ),
    as_of: z
      .object({
        timestamp_ms: z
          .number()
          .int()
          .describe("Wall-clock ms the public evidence reads were performed."),
        anchor: z
          .object({
            chain: z.string().min(1),
            slot: z.number().int().optional(),
            height: z.number().int().optional(),
          })
          .strict()
          .optional()
          .describe("Deterministic chain anchor consulted during the reads, when any."),
      })
      .strict()
      .describe(
        "The evidence-read basis — an attestation says what was true AS-OF, never timelessly.",
      ),
    results: z
      .array(EvalResultSchema)
      .min(1)
      .describe("The measurements. Non-empty — an attestation that measured nothing is rejected."),
    evidence: z
      .array(EvidenceRefSchema)
      .optional()
      .describe(
        "Attestation-level evidence — unsigned observations that informed the audit but are not measurements.",
      ),
    invocation: z
      .object({
        task_id: z.string().min(1).optional(),
        relay_task_id: z.string().min(1).optional(),
      })
      .strict()
      .optional()
      .describe("Cross-reference into the issuer's execution ledger."),
    suite: z
      .literal("motebit-jcs-ed25519-b64-v1")
      .describe("Pinned signature suite (JCS + Ed25519 + base64url)."),
    signature: z
      .string()
      .min(1)
      .describe("Ed25519 over canonicalJson({...attestation minus signature}), base64url."),
  })
  .strict()
  .describe(
    "The signed third-party-measurement artifact. Envelope law: verifyEvalAttestation in @motebit/crypto — establishes 'this issuer said this about this subject', never measurement truth.",
  );

// ---------------------------------------------------------------------------
// Type parity — zod inference must match the @motebit/protocol declaration
// ---------------------------------------------------------------------------

type InferredAttestation = z.infer<typeof EvalAttestationSchema>;
type InferredResult = z.infer<typeof EvalResultSchema>;
type InferredVerdict = z.infer<typeof VerificationVerdictSchema>;
type InferredRepair = z.infer<typeof RepairInstructionSchema>;
type InferredRevocation = z.infer<typeof RevocationVerdictSchema>;

type _ForwardCheck = ParityForward<EvalAttestation, InferredAttestation>;
type _ReverseCheck = ParityReverse<EvalAttestation, InferredAttestation>;
type _ResultForward = ParityForward<EvalResult, InferredResult>;
type _VerdictForward = ParityForward<VerificationVerdict, InferredVerdict>;
type _RepairForward = ParityForward<RepairInstruction, InferredRepair>;
type _RevocationForward = ParityForward<RevocationVerdict, InferredRevocation>;

// Used to surface the type-assertion result: if the zod schema diverges
// from the TypeScript declaration, these aliases resolve to `never` and
// `tsc --noEmit` fails with a concrete error at this line.
export const _EVAL_ATTESTATION_TYPE_PARITY: {
  forward: _ForwardCheck;
  reverse: _ReverseCheck;
  result: _ResultForward;
  verdict: _VerdictForward;
  repair: _RepairForward;
  revocation: _RevocationForward;
} = {
  forward: true,
  reverse: true,
  result: true,
  verdict: true,
  repair: true,
  revocation: true,
};

// ---------------------------------------------------------------------------
// JSON Schema emitter
// ---------------------------------------------------------------------------

/**
 * Build the JSON Schema (draft-07) object for EvalAttestation. Pure —
 * called from the build-schemas script and from the drift test.
 */
export function buildEvalAttestationJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(EvalAttestationSchema, {
    name: "EvalAttestation",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("EvalAttestation", raw, {
    $id: EVAL_ATTESTATION_SCHEMA_ID,
    title: "EvalAttestation (v1)",
    description:
      "Signed third-party-measurement artifact (subject ≠ signer). Each result embeds a whole per-axis VerificationVerdict; eval_kind is a closed registry (fail-closed intake); envelope verified by verifyEvalAttestation in @motebit/crypto — measurement truth is deliberately out of scope. Spec: spec/eval-attestation-v1.md.",
  });
}
