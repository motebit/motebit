/**
 * Dispute wire schemas — the five-artifact exception-handling subsystem.
 *
 * When a delegation goes wrong (quality, non-payment, invalid receipt,
 * unauthorized work, or "other"), motebit's dispute protocol provides
 * a verifiable resolution path. The five artifacts:
 *
 *   1. `DisputeRequest`     — filing party opens a dispute on a task
 *   2. `DisputeEvidence`    — either party submits cryptographically-
 *                             verifiable evidence
 *   3. `AdjudicatorVote`    — federation peer votes on the outcome
 *                             (federation adjudication only)
 *   4. `DisputeResolution`  — adjudicator's signed verdict + fund action
 *   5. `DisputeAppeal`      — losing party appeals (one shot — final
 *                             after appeal is terminal)
 *
 * All five are signed with `motebit-jcs-ed25519-b64-v1`. Why publishing
 * them as machine-readable contracts matters: a dispute resolution
 * MUST be auditable by external observers, otherwise "the relay
 * decided" becomes "the relay self-justified." With these schemas, an
 * external auditor (or a future you) can fetch the artifacts, verify
 * every signature, and check the resolution's structural soundness
 * against the protocol — without trusting the adjudicator's word.
 *
 * Foundation Law §6.5: federation resolutions MUST include individual
 * AdjudicatorVote entries; aggregated-only verdicts are rejected.
 * That's enforced here at the type layer (the resolution carries
 * `adjudicator_votes: AdjudicatorVote[]`); the schema makes it
 * mechanically checkable from outside motebit's runtime.
 *
 * See spec/dispute-v1.md.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type {
  AdjudicatorVote,
  DisputeAppeal,
  DisputeEvidence,
  DisputeRequest,
  DisputeResolution,
} from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";

// ---------------------------------------------------------------------------
// Stable $id URLs
// ---------------------------------------------------------------------------

export const DISPUTE_REQUEST_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/dispute-request-v1.json";

export const DISPUTE_EVIDENCE_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/dispute-evidence-v1.json";

export const ADJUDICATOR_VOTE_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/adjudicator-vote-v1.json";

export const DISPUTE_RESOLUTION_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/dispute-resolution-v1.json";

export const DISPUTE_APPEAL_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/dispute-appeal-v1.json";

// ---------------------------------------------------------------------------
// Shared leaf factories
//
// As with the migration cluster: factories (not shared constants) keep
// each emitted JSON Schema property its own object instead of a $ref,
// so descriptions survive zod-to-json-schema's collapse pass.
// ---------------------------------------------------------------------------

const suiteField = () =>
  z
    .literal("motebit-jcs-ed25519-b64-v1")
    .describe(
      "Cryptosuite identifier. Always `motebit-jcs-ed25519-b64-v1` for dispute artifacts: JCS canonicalization (RFC 8785), Ed25519 primitive, base64url signature, hex public key. Verifiers reject missing or unknown values fail-closed.",
    );

const signatureField = (signerNote: string) =>
  z
    .string()
    .min(1)
    .describe(
      `Base64url-encoded Ed25519 signature over \`canonicalJson(body)\` where \`body\` = the artifact minus \`signature\`. ${signerNote}`,
    );

// ---------------------------------------------------------------------------
// Closed enum schemas — protocol-defined value sets
// ---------------------------------------------------------------------------

const DisputeCategorySchema = z
  .enum(["quality", "non_payment", "receipt_invalid", "unauthorized", "other"])
  .describe(
    "Dispute category (§4.2). `quality` = work was unsatisfactory; `non_payment` = settlement didn't happen; `receipt_invalid` = receipt fails verification; `unauthorized` = work outside the scoped delegation; `other` = catch-all (description should explain).",
  );

const DisputeOutcomeSchema = z
  .enum(["upheld", "overturned", "split"])
  .describe(
    "Dispute outcome. `upheld` = filer wins, fund_action follows. `overturned` = respondent wins, original settlement stands. `split` = partial fault, split_ratio applies.",
  );

const DisputeFundActionSchema = z
  .enum(["release_to_worker", "refund_to_delegator", "split"])
  .describe(
    "Fund action resulting from dispute resolution (§7.2). `release_to_worker` = full settlement to executor. `refund_to_delegator` = full refund. `split` = use `split_ratio` to divide.",
  );

const DisputeEvidenceTypeSchema = z
  .enum([
    "execution_receipt",
    "credential",
    "anchor_proof",
    "settlement_proof",
    "execution_ledger",
    "attestation",
  ])
  .describe(
    "Evidence type (§5.1). Each value names a category of cryptographically-verifiable artifact the adjudicator can validate against its own dedicated schema.",
  );

// ---------------------------------------------------------------------------
// DisputeRequest — opens a dispute on a completed task
// ---------------------------------------------------------------------------

export const DisputeRequestSchema = z
  .object({
    dispute_id: z
      .string()
      .min(1)
      .describe(
        "UUIDv7 generated by the filing party. Stable through the entire dispute lifecycle.",
      ),
    task_id: z
      .string()
      .min(1)
      .describe(
        "References the disputed task. Foundation law §4.4: no economic binding (no `task_id` + `allocation_id`), no dispute.",
      ),
    allocation_id: z
      .string()
      .min(1)
      .describe(
        "References the task's BudgetAllocation. The dispute mechanism operates on the locked funds; without an allocation there's nothing to release/refund.",
      ),
    filed_by: z
      .string()
      .min(1)
      .describe(
        "Motebit identity of the filing party. MUST be a direct party to the referenced task (delegator OR executor) — third parties cannot file.",
      ),
    respondent: z
      .string()
      .min(1)
      .describe(
        "Motebit identity of the other task party. Receives notification + evidence window.",
      ),
    category: DisputeCategorySchema,
    description: z
      .string()
      .describe(
        "Human-readable explanation. Empty string is permitted (the evidence speaks for itself), but conventional usage includes a short factual narrative.",
      ),
    evidence_refs: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "References to signed artifacts supporting the dispute. At least one is required at filing time (foundation law §4.4) — disputes without evidence are noise.",
      ),
    filed_at: z
      .number()
      .describe("Unix timestamp in milliseconds when the filing party signed the request."),
    suite: suiteField(),
    signature: signatureField("Signed by the filing party."),
  })
  .strict();

type _DisputeRequestForward =
  DisputeRequest extends z.infer<typeof DisputeRequestSchema> ? true : never;
type _DisputeRequestReverse =
  z.infer<typeof DisputeRequestSchema> extends DisputeRequest ? true : never;

export const _DISPUTE_REQUEST_TYPE_PARITY: {
  forward: _DisputeRequestForward;
  reverse: _DisputeRequestReverse;
} = {
  forward: true as _DisputeRequestForward,
  reverse: true as _DisputeRequestReverse,
};

export function buildDisputeRequestJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(DisputeRequestSchema, {
    name: "DisputeRequest",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("DisputeRequest", raw, {
    $id: DISPUTE_REQUEST_SCHEMA_ID,
    title: "DisputeRequest (v1)",
    description:
      "Filing party's signed request to open a dispute on a completed task. Requires task_id + allocation_id + ≥1 evidence reference. Relays MUST NOT reject eligible disputes (§4.4). See spec/dispute-v1.md.",
  });
}

// ---------------------------------------------------------------------------
// DisputeEvidence — submitted by either party during the evidence window
// ---------------------------------------------------------------------------

export const DisputeEvidenceSchema = z
  .object({
    dispute_id: z
      .string()
      .min(1)
      .describe(
        "References an open dispute. Evidence submitted to a non-existent or non-open dispute is rejected.",
      ),
    submitted_by: z
      .string()
      .min(1)
      .describe(
        "Motebit identity of the submitting party. MUST be one of the dispute's parties; third-party evidence routes through one of them.",
      ),
    evidence_type: DisputeEvidenceTypeSchema,
    evidence_data: z
      .record(z.string(), z.unknown())
      .describe(
        "The signed artifact itself, as a JSON object. Inner shape validates against the dedicated wire schema for `evidence_type` (e.g. ExecutionReceiptSchema for `execution_receipt`). Per-entry validation deferred to those schemas.",
      ),
    description: z
      .string()
      .describe(
        "Human-readable explanation of what this evidence demonstrates. Lets adjudicators quickly orient on the submitter's claim.",
      ),
    submitted_at: z
      .number()
      .describe("Unix timestamp in milliseconds when the evidence was signed."),
    suite: suiteField(),
    signature: signatureField("Signed by the submitting party."),
  })
  .strict();

type _DisputeEvidenceForward =
  DisputeEvidence extends z.infer<typeof DisputeEvidenceSchema> ? true : never;
type _DisputeEvidenceReverse =
  z.infer<typeof DisputeEvidenceSchema> extends DisputeEvidence ? true : never;

export const _DISPUTE_EVIDENCE_TYPE_PARITY: {
  forward: _DisputeEvidenceForward;
  reverse: _DisputeEvidenceReverse;
} = {
  forward: true as _DisputeEvidenceForward,
  reverse: true as _DisputeEvidenceReverse,
};

export function buildDisputeEvidenceJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(DisputeEvidenceSchema, {
    name: "DisputeEvidence",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("DisputeEvidence", raw, {
    $id: DISPUTE_EVIDENCE_SCHEMA_ID,
    title: "DisputeEvidence (v1)",
    description:
      "Cryptographically-verifiable evidence submitted in a dispute. Foundation law §5.4: both parties must have equal access; relay must not tamper or withhold. See spec/dispute-v1.md.",
  });
}

// ---------------------------------------------------------------------------
// AdjudicatorVote — single federation peer's vote
// ---------------------------------------------------------------------------

export const AdjudicatorVoteSchema = z
  .object({
    dispute_id: z
      .string()
      .min(1)
      .describe(
        "Dispute this vote applies to. Signature-bound: the canonical body includes this field, so a vote signed for dispute A cannot be replayed into dispute B (foundation law §6.5). A malicious adjudicator collecting old votes from other disputes cannot stuff them into a new resolution because the dispute_id binding breaks the per-vote signature.",
      ),
    peer_id: z
      .string()
      .min(1)
      .describe("Federation peer's motebit identity. The signer of this vote."),
    vote: DisputeOutcomeSchema,
    rationale: z
      .string()
      .describe(
        "Per-peer explanation of the vote. Optional in practice (empty string permitted) but encouraged so the resolution's auditability is meaningful.",
      ),
    suite: suiteField(),
    signature: signatureField(
      "Signed by the voting peer over canonical JSON of all fields except signature. The signature covers `dispute_id` (foundation law §6.5: votes are not portable across disputes).",
    ),
  })
  .strict();

type _AdjudicatorVoteForward =
  AdjudicatorVote extends z.infer<typeof AdjudicatorVoteSchema> ? true : never;
type _AdjudicatorVoteReverse =
  z.infer<typeof AdjudicatorVoteSchema> extends AdjudicatorVote ? true : never;

export const _ADJUDICATOR_VOTE_TYPE_PARITY: {
  forward: _AdjudicatorVoteForward;
  reverse: _AdjudicatorVoteReverse;
} = {
  forward: true as _AdjudicatorVoteForward,
  reverse: true as _AdjudicatorVoteReverse,
};

export function buildAdjudicatorVoteJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(AdjudicatorVoteSchema, {
    name: "AdjudicatorVote",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("AdjudicatorVote", raw, {
    $id: ADJUDICATOR_VOTE_SCHEMA_ID,
    title: "AdjudicatorVote (v1)",
    description:
      "Single federation peer's signed vote in federation adjudication (§6.2). Foundation law §6.5: federation resolutions MUST include individual votes — aggregated-only verdicts are rejected.",
  });
}

// ---------------------------------------------------------------------------
// DisputeResolution — adjudicator's signed verdict
// ---------------------------------------------------------------------------

export const DisputeResolutionSchema = z
  .object({
    dispute_id: z.string().min(1).describe("References the dispute being resolved."),
    resolution: DisputeOutcomeSchema,
    rationale: z
      .string()
      .describe(
        "Signed explanation of the decision. Foundation law §6.5: resolution MUST include a signed rationale — opaque verdicts are rejected.",
      ),
    fund_action: DisputeFundActionSchema,
    split_ratio: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "Worker's portion of the disputed funds, in [0, 1]. `1.0` = all to worker (release_to_worker outcome). `0.0` = all to delegator (refund_to_delegator). Fractional values apply to `split` outcomes.",
      ),
    adjudicator: z
      .string()
      .min(1)
      .describe(
        "Motebit identity (or relay identity) of the adjudicating entity. Foundation law: a relay MUST NOT self-adjudicate when it is the defendant.",
      ),
    adjudicator_votes: z
      .array(AdjudicatorVoteSchema)
      .describe(
        "Individual federation peer votes (§6.2). Empty array for single-relay adjudication; non-empty for federation. Foundation law §6.5: aggregated-only verdicts are rejected — every contributing vote must be present.",
      ),
    resolved_at: z
      .number()
      .describe("Unix timestamp in milliseconds when the adjudicator signed the resolution."),
    suite: suiteField(),
    signature: signatureField("Signed by the adjudicator."),
  })
  .strict();

type _DisputeResolutionForward =
  DisputeResolution extends z.infer<typeof DisputeResolutionSchema> ? true : never;
type _DisputeResolutionReverse =
  z.infer<typeof DisputeResolutionSchema> extends DisputeResolution ? true : never;

export const _DISPUTE_RESOLUTION_TYPE_PARITY: {
  forward: _DisputeResolutionForward;
  reverse: _DisputeResolutionReverse;
} = {
  forward: true as _DisputeResolutionForward,
  reverse: true as _DisputeResolutionReverse,
};

export function buildDisputeResolutionJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(DisputeResolutionSchema, {
    name: "DisputeResolution",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("DisputeResolution", raw, {
    $id: DISPUTE_RESOLUTION_SCHEMA_ID,
    title: "DisputeResolution (v1)",
    description:
      "Adjudicator's signed verdict on a dispute. Carries the outcome, fund action, split ratio, and (for federation) the individual peer votes that produced the decision. See spec/dispute-v1.md.",
  });
}

// ---------------------------------------------------------------------------
// DisputeAppeal — losing party's one-shot appeal
// ---------------------------------------------------------------------------

export const DisputeAppealSchema = z
  .object({
    dispute_id: z
      .string()
      .min(1)
      .describe(
        "References a resolved dispute. Foundation law §8.4: one appeal per dispute — final state after appeal is terminal.",
      ),
    appealed_by: z.string().min(1).describe("Motebit identity of the appealing party. The signer."),
    reason: z
      .string()
      .describe(
        "Human-readable explanation of why the resolution is incorrect. Adjudicators in the appeal phase weight this against the additional evidence (if any).",
      ),
    additional_evidence: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Optional new evidence references introduced with the appeal. Per §8.4 new evidence is permitted — appeals aren't limited to re-arguing the original record.",
      ),
    appealed_at: z
      .number()
      .describe("Unix timestamp in milliseconds when the appealing party signed the appeal."),
    suite: suiteField(),
    signature: signatureField("Signed by the appealing party."),
  })
  .strict();

type _DisputeAppealForward =
  DisputeAppeal extends z.infer<typeof DisputeAppealSchema> ? true : never;
type _DisputeAppealReverse =
  z.infer<typeof DisputeAppealSchema> extends DisputeAppeal ? true : never;

export const _DISPUTE_APPEAL_TYPE_PARITY: {
  forward: _DisputeAppealForward;
  reverse: _DisputeAppealReverse;
} = {
  forward: true as _DisputeAppealForward,
  reverse: true as _DisputeAppealReverse,
};

export function buildDisputeAppealJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(DisputeAppealSchema, {
    name: "DisputeAppeal",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("DisputeAppeal", raw, {
    $id: DISPUTE_APPEAL_SCHEMA_ID,
    title: "DisputeAppeal (v1)",
    description:
      "Losing party's one-shot appeal of a dispute resolution. Optional `additional_evidence` lets the appealing party introduce new artifacts; the post-appeal state is terminal (§8.4).",
  });
}
