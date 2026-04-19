/**
 * Credential subject wire schemas — three VC body types.
 *
 * Verifiable Credentials (W3C VC 2.0) carry a `credentialSubject`
 * field describing what's being attested. motebit issues three kinds:
 *
 *   - `ReputationCredentialSubject` — observable performance signals
 *     (success rate, avg latency, task count, trust score, availability,
 *     sample size). Issued by relays after enough interactions to be
 *     statistically meaningful.
 *
 *   - `TrustCredentialSubject` — peer trust assertions (trust level,
 *     interaction count, win/loss task counts, first/last seen).
 *     Issued by federation peers attesting to direct experience with
 *     the subject agent.
 *
 *   - `GradientCredentialSubject` — interior cognitive state (gradient,
 *     knowledge density, knowledge quality, graph connectivity, temporal
 *     stability, retrieval quality, interaction/tool efficiency,
 *     curiosity pressure). Self-attested measurement of the agent's
 *     own learning trajectory — the "what am I becoming?" signal.
 *
 * Why publish them: motebit's trust accumulation is the moat (per
 * doctrine), but a third party can only audit accumulated reputation
 * if the credential bodies are machine-readable. These schemas make
 * "this credential claims X" verifiable by anyone fetching the published
 * JSON Schema — without bundling motebit's runtime, an external system
 * can validate that an issued credential conforms to the protocol shape
 * before extending trust based on it.
 *
 * The subjects do NOT carry their own signatures — they're embedded as
 * `credentialSubject` in a VerifiableCredential, and the issuer signs
 * the outer VC envelope per the W3C VC 2.0 + eddsa-jcs-2022 cryptosuite.
 *
 * See spec/credential-v1.md §3.1, §3.2, §3.3.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type {
  GradientCredentialSubject,
  ReputationCredentialSubject,
  TrustCredentialSubject,
} from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";
import { HardwareAttestationClaimSchema } from "./hardware-attestation-claim.js";

// ---------------------------------------------------------------------------
// Stable $id URLs
// ---------------------------------------------------------------------------

export const REPUTATION_CREDENTIAL_SUBJECT_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/reputation-credential-subject-v1.json";

export const TRUST_CREDENTIAL_SUBJECT_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/trust-credential-subject-v1.json";

export const GRADIENT_CREDENTIAL_SUBJECT_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/gradient-credential-subject-v1.json";

// ---------------------------------------------------------------------------
// Shared leaf factory — `id` is the W3C VC subject identifier (typically
// `did:key:...` or a relay-issued URN). Same field across all three; same
// description avoids duplication.
// ---------------------------------------------------------------------------

const subjectIdField = () =>
  z
    .string()
    .min(1)
    .describe(
      "Subject identifier — typically the agent's `did:key:...` or a relay-issued URN. The W3C VC 2.0 `credentialSubject.id` field; binds the credential body to the agent it describes.",
    );

// ---------------------------------------------------------------------------
// ReputationCredentialSubject — observable performance signals
// ---------------------------------------------------------------------------

export const ReputationCredentialSubjectSchema = z
  .object({
    id: subjectIdField(),
    success_rate: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "Fraction of completed-vs-attempted tasks in [0, 1]. Computed across the credential's `sample_size` window.",
      ),
    avg_latency_ms: z
      .number()
      .nonnegative()
      .describe(
        "Average task wall-clock latency in milliseconds across the sample. Lower is better; a relay may issue a credential refusing to attest if latency exceeds the SLA the agent declared.",
      ),
    task_count: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Total task count contributing to this credential. Combined with `success_rate` lets verifiers compute absolute success/failure counts.",
      ),
    trust_score: z
      .number()
      .describe(
        "Composite trust signal computed by the issuer. Range and weighting are issuer-policy; conventionally [0, 1] with higher = more trusted, but unbounded numbers are accepted on the wire.",
      ),
    availability: z
      .number()
      .min(0)
      .max(1)
      .describe(
        "Observed availability fraction in [0, 1] across the sample. `1.0` = the agent responded to every health check; `0.0` = never responded.",
      ),
    sample_size: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Number of observations the credential's signals are computed from. Lets verifiers gate on statistical significance — a credential over `sample_size: 3` is weaker evidence than one over `sample_size: 300`.",
      ),
    measured_at: z
      .number()
      .describe(
        "Unix timestamp in milliseconds when the issuer computed the signals. Lets verifiers detect stale credentials (the issuer's `validFrom` envelopes this; this field is the underlying measurement timestamp).",
      ),
  })
  .strict();

type _ReputationForward =
  ReputationCredentialSubject extends z.infer<typeof ReputationCredentialSubjectSchema>
    ? true
    : never;
type _ReputationReverse =
  z.infer<typeof ReputationCredentialSubjectSchema> extends ReputationCredentialSubject
    ? true
    : never;

export const _REPUTATION_CREDENTIAL_SUBJECT_TYPE_PARITY: {
  forward: _ReputationForward;
  reverse: _ReputationReverse;
} = {
  forward: true as _ReputationForward,
  reverse: true as _ReputationReverse,
};

export function buildReputationCredentialSubjectJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(ReputationCredentialSubjectSchema, {
    name: "ReputationCredentialSubject",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("ReputationCredentialSubject", raw, {
    $id: REPUTATION_CREDENTIAL_SUBJECT_SCHEMA_ID,
    title: "ReputationCredentialSubject (v1)",
    description:
      "W3C VC 2.0 `credentialSubject` body for AgentReputationCredential. Carries observable performance signals (success rate, latency, task count, trust score, availability, sample size). Issued by relays after enough interactions to be statistically meaningful. See spec/credential-v1.md §3.1.",
  });
}

// ---------------------------------------------------------------------------
// TrustCredentialSubject — peer trust assertions
// ---------------------------------------------------------------------------

export const TrustCredentialSubjectSchema = z
  .object({
    id: subjectIdField(),
    trust_level: z
      .string()
      .min(1)
      .describe(
        "Trust level as a free-form string — issuer-policy controls the value set. Conventional values: `untrusted`, `verified`, `trusted`, `revoked`. Verifiers map to their own trust ladder.",
      ),
    interaction_count: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Total interactions the issuer had with the subject (≥ 0). Combined with success/failure counts gives the basis for the trust assertion.",
      ),
    successful_tasks: z
      .number()
      .int()
      .nonnegative()
      .describe("Tasks the subject completed successfully for the issuer (≥ 0)."),
    failed_tasks: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Tasks the subject failed for the issuer (≥ 0). Sums with successful_tasks ≤ interaction_count.",
      ),
    first_seen_at: z
      .number()
      .describe(
        "Unix timestamp in milliseconds when the issuer first interacted with the subject. Lets verifiers weight by relationship age.",
      ),
    last_seen_at: z
      .number()
      .describe(
        "Unix timestamp in milliseconds of the most recent interaction. Lets verifiers detect dormant relationships (`last_seen_at` far in the past = weaker present-tense trust signal).",
      ),
    hardware_attestation: HardwareAttestationClaimSchema.optional().describe(
      "Optional hardware-custody claim about the subject agent's identity key. Declares whether the key lives in a hardware keystore (Secure Enclave, TPM, Android StrongBox, Apple DeviceCheck) or software. Absence asserts nothing (equivalent to 'unknown' for ranking). See spec/credential-v1.md §3.4 and HardwareAttestationClaim.",
    ),
  })
  .strict();

type _TrustForward =
  TrustCredentialSubject extends z.infer<typeof TrustCredentialSubjectSchema> ? true : never;
type _TrustReverse =
  z.infer<typeof TrustCredentialSubjectSchema> extends TrustCredentialSubject ? true : never;

export const _TRUST_CREDENTIAL_SUBJECT_TYPE_PARITY: {
  forward: _TrustForward;
  reverse: _TrustReverse;
} = {
  forward: true as _TrustForward,
  reverse: true as _TrustReverse,
};

export function buildTrustCredentialSubjectJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(TrustCredentialSubjectSchema, {
    name: "TrustCredentialSubject",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("TrustCredentialSubject", raw, {
    $id: TRUST_CREDENTIAL_SUBJECT_SCHEMA_ID,
    title: "TrustCredentialSubject (v1)",
    description:
      "W3C VC 2.0 `credentialSubject` body for AgentTrustCredential. Carries peer-issued trust assertions (trust level, interaction counts, first/last seen). Issued by federation peers attesting to direct experience. See spec/credential-v1.md §3.2.",
  });
}

// ---------------------------------------------------------------------------
// GradientCredentialSubject — interior cognitive-state self-attestation
// ---------------------------------------------------------------------------

export const GradientCredentialSubjectSchema = z
  .object({
    id: subjectIdField(),
    gradient: z
      .number()
      .describe(
        "Composite cognitive-state gradient — a scalar summary of the agent's interior trajectory. Higher = the agent is converging on stable, useful capability; lower = drift / regression. Issuer-policy weighting; range conventionally roughly [-1, 1] but unbounded on the wire.",
      ),
    knowledge_density: z
      .number()
      .describe(
        "Density of useful knowledge in the memory graph — facts per unit graph weight. Higher = more knowledge per stored bit.",
      ),
    knowledge_quality: z
      .number()
      .describe(
        "Quality of stored knowledge — typically a function of source reliability + verification rate. Higher = more trustworthy memories.",
      ),
    graph_connectivity: z
      .number()
      .describe(
        "Memory graph connectivity — average edges per node, normalized. Higher = better cross-referenced knowledge (associations strengthen retrieval).",
      ),
    temporal_stability: z
      .number()
      .describe(
        "Stability of behaviors and beliefs over time — the inverse of churn. Higher = more consistent agent identity across sessions.",
      ),
    retrieval_quality: z
      .number()
      .describe(
        "Quality of memory retrieval — how often the right memory surfaces for the right context. Higher = better-tuned attention.",
      ),
    interaction_efficiency: z
      .number()
      .describe(
        "Tokens-to-outcome ratio for user interactions. Higher = more useful work per token (approaching the floor of irreducible communication).",
      ),
    tool_efficiency: z
      .number()
      .describe(
        "Tool invocations per completed task. Higher = the agent is choosing the right tool first time more often.",
      ),
    curiosity_pressure: z
      .number()
      .describe(
        "How strongly the agent is driven to explore vs exploit. Issuer-policy scale; some non-zero curiosity is healthy (avoiding stagnation), too much is dilettante.",
      ),
    measured_at: z
      .number()
      .describe(
        "Unix timestamp in milliseconds when the agent computed these signals. Self-attested — the credential is signed by the agent, not by an external issuer.",
      ),
  })
  .strict();

type _GradientForward =
  GradientCredentialSubject extends z.infer<typeof GradientCredentialSubjectSchema> ? true : never;
type _GradientReverse =
  z.infer<typeof GradientCredentialSubjectSchema> extends GradientCredentialSubject ? true : never;

export const _GRADIENT_CREDENTIAL_SUBJECT_TYPE_PARITY: {
  forward: _GradientForward;
  reverse: _GradientReverse;
} = {
  forward: true as _GradientForward,
  reverse: true as _GradientReverse,
};

export function buildGradientCredentialSubjectJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(GradientCredentialSubjectSchema, {
    name: "GradientCredentialSubject",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("GradientCredentialSubject", raw, {
    $id: GRADIENT_CREDENTIAL_SUBJECT_SCHEMA_ID,
    title: "GradientCredentialSubject (v1)",
    description:
      "W3C VC 2.0 `credentialSubject` body for AgentGradientCredential. Carries the agent's self-attested interior cognitive-state signals (gradient, knowledge density/quality, graph connectivity, temporal stability, retrieval quality, interaction/tool efficiency, curiosity pressure). The 'what am I becoming?' measurement. See spec/credential-v1.md §3.3.",
  });
}
