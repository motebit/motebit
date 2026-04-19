/**
 * Migration wire schemas — the four-step identity-rotation handshake.
 *
 * Migration is how an agent moves from one relay to another while
 * preserving identity, accumulated trust, and credentials. The protocol
 * sequence:
 *
 *   1. Agent emits a `MigrationRequest` to the source relay.
 *   2. Source relay issues a `MigrationToken` (signed authorization).
 *   3. Source relay produces a `DepartureAttestation` (signed history).
 *   4. Agent assembles a `MigrationPresentation` (token + attestation
 *      + credential bundle + identity file) and submits it to the
 *      destination relay.
 *
 * All four artifacts are signed with `motebit-jcs-ed25519-b64-v1`. The
 * presentation nests the other three plus a CredentialBundle, so its
 * verification pipeline is: (a) verify presentation signature, (b)
 * verify each nested artifact's own signature, (c) check the chain
 * makes sense (token's motebit_id matches attestation's matches
 * bundle's matches identity_file's).
 *
 * Why publish these as one cluster: a non-motebit destination relay
 * (or a forensic auditor) needs all four to make sense of any
 * migration. Shipping them piecemeal would mean partial verifiability;
 * shipping them together means the migration loop is testable
 * end-to-end against published JSON Schemas alone.
 *
 * See spec/migration-v1.md §3.1 (Request), §4.1 (Token), §5.1
 * (Attestation), §8.1 (Presentation).
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type {
  BalanceWaiver,
  DepartureAttestation,
  MigrationPresentation,
  MigrationRequest,
  MigrationToken,
} from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";
import { CredentialBundleSchema } from "./credential-bundle.js";

// ---------------------------------------------------------------------------
// Stable $id URLs
// ---------------------------------------------------------------------------

export const MIGRATION_REQUEST_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/migration-request-v1.json";

export const MIGRATION_TOKEN_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/migration-token-v1.json";

export const DEPARTURE_ATTESTATION_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/departure-attestation-v1.json";

export const MIGRATION_PRESENTATION_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/migration-presentation-v1.json";

export const BALANCE_WAIVER_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/packages/wire-schemas/schema/balance-waiver-v1.json";

// ---------------------------------------------------------------------------
// Shared leaf factories
//
// `suite` and `signature` repeat across all four migration artifacts.
// Calling these factories — instead of sharing a single zod constant —
// keeps each emitted JSON Schema property its own object (not a `$ref`),
// so descriptions survive the zod-to-json-schema collapse pass and the
// drift-test "every top-level property carries a description" check
// passes for every artifact, including the nested-presentation case.
// ---------------------------------------------------------------------------

const suiteField = () =>
  z
    .literal("motebit-jcs-ed25519-b64-v1")
    .describe(
      "Cryptosuite identifier. Always `motebit-jcs-ed25519-b64-v1` for migration artifacts: JCS canonicalization (RFC 8785), Ed25519 primitive, base64url signature, hex public key. Verifiers reject missing or unknown values fail-closed.",
    );

const signatureField = (signerNote: string) =>
  z
    .string()
    .min(1)
    .describe(
      `Base64url-encoded Ed25519 signature over \`canonicalJson(body)\` where \`body\` = the artifact minus \`signature\`. ${signerNote}`,
    );

// ---------------------------------------------------------------------------
// MigrationRequest — agent-signed declaration of intent to migrate
// ---------------------------------------------------------------------------

export const MigrationRequestSchema = z
  .object({
    motebit_id: z
      .string()
      .min(1)
      .describe("Agent's motebit identity (UUIDv7). The signer of this request."),
    destination_relay: z
      .string()
      .optional()
      .describe(
        "Optional URL or relay_id of the intended destination. Source relay MUST NOT condition token issuance on this value (foundation law §4.3) — it's informational only.",
      ),
    reason: z
      .string()
      .optional()
      .describe(
        "Optional human-readable reason for migration. Source relay MUST NOT condition token issuance on this value — informational only.",
      ),
    requested_at: z
      .number()
      .describe("Unix timestamp in milliseconds when the agent issued the request."),
    suite: suiteField(),
    signature: signatureField("Signed by the agent."),
  })
  .strict();

type _MigrationRequestForward =
  MigrationRequest extends z.infer<typeof MigrationRequestSchema> ? true : never;
type _MigrationRequestReverse =
  z.infer<typeof MigrationRequestSchema> extends MigrationRequest ? true : never;

export const _MIGRATION_REQUEST_TYPE_PARITY: {
  forward: _MigrationRequestForward;
  reverse: _MigrationRequestReverse;
} = {
  forward: true as _MigrationRequestForward,
  reverse: true as _MigrationRequestReverse,
};

export function buildMigrationRequestJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(MigrationRequestSchema, {
    name: "MigrationRequest",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("MigrationRequest", raw, {
    $id: MIGRATION_REQUEST_SCHEMA_ID,
    title: "MigrationRequest (v1)",
    description:
      "Agent-signed declaration of intent to migrate from the source relay. The relay MUST issue a MigrationToken for any valid request from a registered agent — destination, reason, and other factors MUST NOT gate issuance. See spec/migration-v1.md §3.1.",
  });
}

// ---------------------------------------------------------------------------
// MigrationToken — relay-signed authorization
// ---------------------------------------------------------------------------

export const MigrationTokenSchema = z
  .object({
    token_id: z
      .string()
      .min(1)
      .describe("UUIDv7 identifier for this specific authorization. Stable through expiry."),
    motebit_id: z
      .string()
      .min(1)
      .describe("Agent's motebit identity (UUIDv7) authorized to migrate."),
    source_relay_id: z.string().min(1).describe("Issuing relay's identity. The signer."),
    source_relay_url: z
      .string()
      .url()
      .describe(
        "Issuing relay's canonical URL. Lets destination relays reach back to verify chain-of-custody if needed.",
      ),
    issued_at: z
      .number()
      .describe("Unix timestamp in milliseconds when the source relay signed the token."),
    expires_at: z
      .number()
      .describe(
        "Unix timestamp in milliseconds when the token becomes invalid. Default per spec: 72 hours from issuance. Source relay MUST NOT revoke before expiry except on agent-initiated cancellation (foundation law §4.3).",
      ),
    suite: suiteField(),
    signature: signatureField("Signed by the source relay (NOT the agent)."),
  })
  .strict();

type _MigrationTokenForward =
  MigrationToken extends z.infer<typeof MigrationTokenSchema> ? true : never;
type _MigrationTokenReverse =
  z.infer<typeof MigrationTokenSchema> extends MigrationToken ? true : never;

export const _MIGRATION_TOKEN_TYPE_PARITY: {
  forward: _MigrationTokenForward;
  reverse: _MigrationTokenReverse;
} = {
  forward: true as _MigrationTokenForward,
  reverse: true as _MigrationTokenReverse,
};

export function buildMigrationTokenJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(MigrationTokenSchema, {
    name: "MigrationToken",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("MigrationToken", raw, {
    $id: MIGRATION_TOKEN_SCHEMA_ID,
    title: "MigrationToken (v1)",
    description:
      "Relay-signed authorization for an agent's migration. Issued by the source relay; consumed by the destination relay as proof the agent has authorization to leave. See spec/migration-v1.md §4.1.",
  });
}

// ---------------------------------------------------------------------------
// DepartureAttestation — relay-signed history snapshot
// ---------------------------------------------------------------------------

export const DepartureAttestationSchema = z
  .object({
    attestation_id: z.string().min(1).describe("UUIDv7 identifier for this attestation."),
    motebit_id: z.string().min(1).describe("Agent's motebit identity being attested for."),
    source_relay_id: z.string().min(1).describe("Attesting relay's identity. The signer."),
    source_relay_url: z.string().url().describe("Attesting relay's canonical URL."),
    first_seen: z
      .number()
      .describe("Unix timestamp in milliseconds when the agent first registered at this relay."),
    last_active: z
      .number()
      .describe("Unix timestamp in milliseconds of the agent's last task or interaction."),
    trust_level: z
      .string()
      .min(1)
      .describe(
        "Agent's trust level at departure. Free-form string per spec; conventional values include `untrusted`, `verified`, `trusted`, `revoked` — the destination relay applies its own trust mapping.",
      ),
    successful_tasks: z
      .number()
      .int()
      .nonnegative()
      .describe("Total completed tasks the agent executed as worker (≥ 0)."),
    failed_tasks: z
      .number()
      .int()
      .nonnegative()
      .describe("Total failed tasks the agent executed as worker (≥ 0)."),
    credentials_issued: z
      .number()
      .int()
      .nonnegative()
      .describe("Total credentials this relay issued to the agent (≥ 0)."),
    balance_at_departure: z
      .number()
      .describe(
        "Virtual account balance in micro-units (1 USD = 1,000,000) at attestation time. Lets destination relays understand the economic state the agent is bringing across.",
      ),
    attested_at: z
      .number()
      .describe("Unix timestamp in milliseconds when this attestation was signed."),
    suite: suiteField(),
    signature: signatureField(
      "Signed by the source relay. Foundation law (§5.3): the relay MUST NOT fabricate or inflate attestation data.",
    ),
  })
  .strict();

type _DepartureAttestationForward =
  DepartureAttestation extends z.infer<typeof DepartureAttestationSchema> ? true : never;
type _DepartureAttestationReverse =
  z.infer<typeof DepartureAttestationSchema> extends DepartureAttestation ? true : never;

export const _DEPARTURE_ATTESTATION_TYPE_PARITY: {
  forward: _DepartureAttestationForward;
  reverse: _DepartureAttestationReverse;
} = {
  forward: true as _DepartureAttestationForward,
  reverse: true as _DepartureAttestationReverse,
};

export function buildDepartureAttestationJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(DepartureAttestationSchema, {
    name: "DepartureAttestation",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("DepartureAttestation", raw, {
    $id: DEPARTURE_ATTESTATION_SCHEMA_ID,
    title: "DepartureAttestation (v1)",
    description:
      "Source-relay-signed snapshot of an agent's history at the relay being departed. Lets destination relays understand the agent's trust level, task counts, and economic state without trusting the agent's self-report. See spec/migration-v1.md §5.1.",
  });
}

// ---------------------------------------------------------------------------
// BalanceWaiver — agent-signed waiver of remaining virtual-account balance
//
// Sibling to the standard withdrawal flow, not nested in MigrationPresentation.
// Per spec §7.3 the relay advances migration to `departed` only after
// withdrawal is confirmed OR the agent signs a BalanceWaiver — the two
// paths are alternatives, not a sequence.
// ---------------------------------------------------------------------------

export const BalanceWaiverSchema = z
  .object({
    motebit_id: z
      .string()
      .min(1)
      .describe("Agent's motebit identity (UUIDv7). The signer of this waiver."),
    waived_amount: z
      .number()
      .describe(
        "Amount waived in micro-units (1 USD = 1,000,000). Per spec §7.3 the relay MUST process the waiver — migration is not grounds for withholding funds, and the waiver is the agent's explicit decision to forgo recovery.",
      ),
    waived_at: z
      .number()
      .describe("Unix timestamp in milliseconds when the agent signed the waiver."),
    suite: suiteField(),
    signature: signatureField("Signed by the agent."),
  })
  .strict();

type _BalanceWaiverForward =
  BalanceWaiver extends z.infer<typeof BalanceWaiverSchema> ? true : never;
type _BalanceWaiverReverse =
  z.infer<typeof BalanceWaiverSchema> extends BalanceWaiver ? true : never;

export const _BALANCE_WAIVER_TYPE_PARITY: {
  forward: _BalanceWaiverForward;
  reverse: _BalanceWaiverReverse;
} = {
  forward: true as _BalanceWaiverForward,
  reverse: true as _BalanceWaiverReverse,
};

export function buildBalanceWaiverJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(BalanceWaiverSchema, {
    name: "BalanceWaiver",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("BalanceWaiver", raw, {
    $id: BALANCE_WAIVER_SCHEMA_ID,
    title: "BalanceWaiver (v1)",
    description:
      "Agent-signed waiver of remaining virtual-account balance — an alternative to the standard withdrawal flow for advancing migration to `departed`. Per spec §7.3 the relay MUST process the waiver and MUST NOT withhold funds on migration grounds; the waiver is the agent's explicit decision to forgo recovery, not the relay's right to keep them. Shipped alongside the migration cluster (request/token/attestation/presentation) so the migration loop is end-to-end verifiable from published JSON Schemas alone. See spec/migration-v1.md §7.2.",
  });
}

// ---------------------------------------------------------------------------
// MigrationPresentation — agent-signed envelope of all four artifacts
// ---------------------------------------------------------------------------

export const MigrationPresentationSchema = z
  .object({
    migration_token: MigrationTokenSchema.describe(
      "Source-relay-signed authorization to migrate. Verifier checks the source relay's signature on this token first — without authorization, the rest is irrelevant.",
    ),
    departure_attestation: DepartureAttestationSchema.describe(
      "Source-relay-signed history snapshot. Verifier checks the source relay's signature; the trust level + task counts inform the destination's admission decision.",
    ),
    credential_bundle: CredentialBundleSchema.describe(
      "Agent-signed export of portable reputation. Verifier checks the agent's signature; per-entry credentials + anchor proofs validate against their dedicated schemas.",
    ),
    identity_file: z
      .string()
      .describe(
        "Full motebit.md content as a string — the agent's identity@1.0 document. Lets the destination relay verify the agent's current public key chains back to the originally-anchored identity.",
      ),
    presented_at: z
      .number()
      .describe(
        "Unix timestamp in milliseconds when the agent assembled and signed the presentation.",
      ),
    suite: suiteField(),
    signature: signatureField(
      "Signed by the agent. Binds the four nested artifacts together — tampering with any nested artifact breaks this outer signature.",
    ),
  })
  .strict();

type _MigrationPresentationForward =
  MigrationPresentation extends z.infer<typeof MigrationPresentationSchema> ? true : never;
type _MigrationPresentationReverse =
  z.infer<typeof MigrationPresentationSchema> extends MigrationPresentation ? true : never;

export const _MIGRATION_PRESENTATION_TYPE_PARITY: {
  forward: _MigrationPresentationForward;
  reverse: _MigrationPresentationReverse;
} = {
  forward: true as _MigrationPresentationForward,
  reverse: true as _MigrationPresentationReverse,
};

export function buildMigrationPresentationJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(MigrationPresentationSchema, {
    name: "MigrationPresentation",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("MigrationPresentation", raw, {
    $id: MIGRATION_PRESENTATION_SCHEMA_ID,
    title: "MigrationPresentation (v1)",
    description:
      "Agent-signed envelope for migration. Bundles MigrationToken + DepartureAttestation + CredentialBundle + identity file. Destination relays validate per spec §8.2; if accepted, the agent's motebit_id is preserved across the relay change. Foundation law §8.4: acceptance is a local admission decision; relays MAY decline. See spec/migration-v1.md §8.1.",
  });
}
