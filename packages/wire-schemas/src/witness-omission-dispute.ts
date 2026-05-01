/**
 * Witness-omission dispute + horizon witness solicitation wire schemas
 * — Path A quorum's soft-accountability layer for `append_only_horizon`
 * retention certs (phase 4b-3).
 *
 * Three artifacts under one module — all three operate on the same
 * solicitation/cert/dispute triangle:
 *
 *   1. `WitnessSolicitationRequest`  — issuer relay → peer:
 *      `POST /federation/v1/horizon/witness`. Carries the unsigned cert
 *      body (no `witnessed_by`, no top-level `signature`) plus the
 *      issuer's attestation signature over `canonicalJson(cert_body)`.
 *      Peer verifies the issuer signature, signs the same bytes, and
 *      returns a `WitnessSolicitationResponse`.
 *
 *   2. `WitnessSolicitationResponse` — peer → issuer:
 *      The peer's `HorizonWitness` envelope (`motebit_id`, `signature`,
 *      optional `inclusion_proof`). Structurally identical to the
 *      `cert.witnessed_by[]` entry — issuer copies verbatim into the
 *      assembled cert.
 *
 *   3. `WitnessOmissionDispute`      — peer → relay/adjudicator:
 *      `POST /federation/v1/horizon/dispute`. Filed within 24h of
 *      `cert.issued_at` by a peer claiming wrongful omission from
 *      `witnessed_by[]`. Two evidence shapes — `inclusion_proof`
 *      (membership in published anchor) or `alternative_peering`
 *      (peering attested outside the anchor, e.g. federation Heartbeat).
 *      Adjudicated through the existing `DisputeResolution` path.
 *
 * Suite: `motebit-jcs-ed25519-b64-v1` for all three. JCS canonicalization
 * (RFC 8785), Ed25519 primitive, base64url signature, hex public key.
 *
 * Foundation Law: certs remain TERMINAL (retention-policy.md decision 5);
 * a sustained witness-omission dispute is a reputation hit on the issuer,
 * not a cert invalidation.
 *
 * See:
 *   - docs/doctrine/retention-policy.md (decisions 5, 8, 9 + 4b-3 sub-notes)
 *   - packages/crypto/src/witness-omission-dispute.ts (verifier ladder)
 *   - packages/crypto/src/deletion-certificate.ts (canonicalizeHorizonCert{,ForWitness})
 *   - spec/relay-federation-v1.md §15 (commit 6 — endpoint contract)
 *   - spec/dispute-v1.md §7.5 (24h dispute window precedent)
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type {
  WitnessOmissionDispute,
  WitnessSolicitationRequest,
  WitnessSolicitationResponse,
} from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";

// ---------------------------------------------------------------------------
// Stable $id URLs
// ---------------------------------------------------------------------------

export const WITNESS_OMISSION_DISPUTE_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/witness-omission-dispute-v1.json";

export const WITNESS_SOLICITATION_REQUEST_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/witness-solicitation-request-v1.json";

export const WITNESS_SOLICITATION_RESPONSE_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/witness-solicitation-response-v1.json";

// ---------------------------------------------------------------------------
// Shared leaf factories
//
// As with deletion-certificate.ts and dispute.ts: factories (not shared
// constants) keep each emitted JSON Schema property its own object
// instead of a $ref, so descriptions survive zod-to-json-schema's
// collapse pass.
// ---------------------------------------------------------------------------

const suiteField = () =>
  z
    .literal("motebit-jcs-ed25519-b64-v1")
    .describe(
      "Cryptosuite identifier. Always `motebit-jcs-ed25519-b64-v1` for phase 4b-3 federation co-witness artifacts: JCS canonicalization (RFC 8785), Ed25519 primitive, base64url signature, hex public key. Verifiers reject missing or unknown values fail-closed.",
    );

const merkleInclusionProofField = () =>
  z
    .object({
      siblings: z
        .array(z.string().min(1))
        .describe(
          "Hex-encoded sibling hashes ordered leaf-to-root. Same shape as credential-anchor-v1 §6 and the `inclusion_proof` field on `cert.witnessed_by[i]`.",
        ),
      leaf_index: z
        .number()
        .int()
        .nonnegative()
        .describe("0-based index of the disputant's pubkey in the sorted peer set at horizon_ts."),
      layer_sizes: z
        .array(z.number().int().nonnegative())
        .describe(
          "Per-layer node counts, used to detect odd-leaf promotion when reconstructing the root.",
        ),
    })
    .strict();

const federationGraphAnchorField = () =>
  z
    .object({
      algo: z
        .literal("merkle-sha256-v1")
        .describe(
          "Closed registry of Merkle algorithm identifiers. `merkle-sha256-v1`: SHA-256 leaves, binary tree with odd-leaf promotion (no duplication). Mirrors the cert's `federation_graph_anchor.algo`.",
        ),
      merkle_root: z
        .string()
        .min(1)
        .describe(
          "Hex-encoded SHA-256 root over the canonical peer-set leaves. `EMPTY_FEDERATION_GRAPH_ANCHOR` signals self-witnessed (leaf_count=0).",
        ),
      leaf_count: z
        .number()
        .int()
        .nonnegative()
        .describe(
          "Number of peer pubkeys in the anchored set. `0` is the canonical self-witnessed encoding paired with the empty-tree merkle_root.",
        ),
    })
    .strict();

const horizonSubjectField = () =>
  z
    .discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("motebit"),
          motebit_id: z.string().min(1),
        })
        .strict()
        .describe("Per-motebit horizon — issuer is the motebit identity key."),
      z
        .object({
          kind: z.literal("operator"),
          operator_id: z.string().min(1),
        })
        .strict()
        .describe("Operator-wide horizon — issuer is the operator key."),
    ])
    .describe(
      "Subject discriminator on `append_only_horizon` certs. Per decision 8, both per-motebit and operator-wide horizons are first-class.",
    );

// ---------------------------------------------------------------------------
// HorizonWitnessRequestBody — the cert body witnesses canonicalize and sign.
//
// Mirrors the `append_only_horizon` arm of `DeletionCertificate` minus
// `witnessed_by[]` and minus top-level `signature`. Canonical-byte
// shape matches `canonicalizeHorizonCertForWitness` in
// `@motebit/crypto/deletion-certificate.ts`.
// ---------------------------------------------------------------------------

const HorizonWitnessRequestBodySchema = z
  .object({
    kind: z
      .literal("append_only_horizon")
      .describe(
        "Discriminator pinning this body to the `append_only_horizon` cert arm. Witnesses for other deletion-cert kinds aren't part of phase 4b-3 — those arms use multi-signature semantics, not single-issuer + co-witnesses.",
      ),
    subject: horizonSubjectField(),
    store_id: z
      .string()
      .min(1)
      .describe("Stable identifier for the audit log within the operator's deployment."),
    horizon_ts: z
      .number()
      .describe(
        "Unix milliseconds. Entries with `timestamp < horizon_ts` will be unrecoverable once the cert is finalized. Witnesses attest they accept the horizon at this value.",
      ),
    issued_at: z
      .number()
      .describe(
        "Unix milliseconds when the issuer signed the solicitation request. Same value lands on the eventual cert's `issued_at` field — load-bearing for the 24h `WitnessOmissionDispute` window clock.",
      ),
    federation_graph_anchor: federationGraphAnchorField()
      .optional()
      .describe(
        "Mandatory from phase 4b-3 onward when the issuer has any federation peers at `horizon_ts` — `EMPTY_FEDERATION_GRAPH_ANCHOR` (leaf_count=0) signals self-witnessed deployments. Optional in the schema for grandfathered pre-4b-3 callers; verifier policy enforces presence-when-peered.",
      ),
    suite: suiteField(),
  })
  .strict()
  .describe(
    "Cert body the witness canonicalizes and signs. Drops `witnessed_by[]` and top-level `signature` from the cert — peer signatures are portable across witness compositions of the same body, and the issuer's final cert.signature is what binds the assembled `witnessed_by[]`.",
  );

// ---------------------------------------------------------------------------
// WitnessSolicitationRequest
// ---------------------------------------------------------------------------

export const WitnessSolicitationRequestSchema = z
  .object({
    cert_body: HorizonWitnessRequestBodySchema,
    issuer_id: z
      .string()
      .min(1)
      .describe(
        "Issuer's identifier — MUST match the id projected from `cert_body.subject` (motebit_id for per-motebit horizons, operator_id for operator-wide horizons). Disagreement is fail-closed at the peer.",
      ),
    issuer_signature: z
      .string()
      .min(1)
      .describe(
        "Base64url-encoded Ed25519 signature by the issuer's federation key over `canonicalJson(cert_body)` under `cert_body.suite`. Same canonical bytes the witness will sign — the request authenticates itself by the issuer's pre-commitment to the body, not by any per-request envelope signature.",
      ),
  })
  .strict();

type _WitnessSolicitationRequestForward =
  WitnessSolicitationRequest extends z.infer<typeof WitnessSolicitationRequestSchema>
    ? true
    : never;
type _WitnessSolicitationRequestReverse =
  z.infer<typeof WitnessSolicitationRequestSchema> extends WitnessSolicitationRequest
    ? true
    : never;

export const _WITNESS_SOLICITATION_REQUEST_TYPE_PARITY: {
  forward: _WitnessSolicitationRequestForward;
  reverse: _WitnessSolicitationRequestReverse;
} = {
  forward: true as _WitnessSolicitationRequestForward,
  reverse: true as _WitnessSolicitationRequestReverse,
};

export function buildWitnessSolicitationRequestJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(WitnessSolicitationRequestSchema, {
    name: "WitnessSolicitationRequest",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("WitnessSolicitationRequest", raw, {
    $id: WITNESS_SOLICITATION_REQUEST_SCHEMA_ID,
    title: "WitnessSolicitationRequest (v1)",
    description:
      "Issuer relay's signed request to a federation peer asking it to co-witness a pending `append_only_horizon` retention cert. Peer verifies `issuer_signature` against `canonicalJson(cert_body)`, signs the same bytes, and returns a `WitnessSolicitationResponse`. See spec/relay-federation-v1.md §15.",
  });
}

// ---------------------------------------------------------------------------
// WitnessSolicitationResponse
// ---------------------------------------------------------------------------

export const WitnessSolicitationResponseSchema = z
  .object({
    motebit_id: z
      .string()
      .min(1)
      .describe(
        "The witnessing peer's motebit identity. The pubkey resolves through the same `resolveMotebitPublicKey` path the cert verifier uses for `cert.witnessed_by[i].motebit_id`.",
      ),
    signature: z
      .string()
      .min(1)
      .describe(
        "Base64url-encoded Ed25519 signature over the same canonical bytes the issuer signed in `WitnessSolicitationRequest.issuer_signature` (i.e. `canonicalJson(cert_body)` under `cert_body.suite`). The issuer copies this signature verbatim into `cert.witnessed_by[].signature`.",
      ),
    inclusion_proof: merkleInclusionProofField()
      .optional()
      .describe(
        "Optional Merkle inclusion proof for the peer's federation pubkey against `cert_body.federation_graph_anchor.merkle_root`. Phase 4b-3 verifier policy admits signature-only witnesses; future tightening to mandatory-inclusion-proof lands by changing verifier policy alone — the wire shape is forward-compatible.",
      ),
  })
  .strict();

type _WitnessSolicitationResponseForward =
  WitnessSolicitationResponse extends z.infer<typeof WitnessSolicitationResponseSchema>
    ? true
    : never;
type _WitnessSolicitationResponseReverse =
  z.infer<typeof WitnessSolicitationResponseSchema> extends WitnessSolicitationResponse
    ? true
    : never;

export const _WITNESS_SOLICITATION_RESPONSE_TYPE_PARITY: {
  forward: _WitnessSolicitationResponseForward;
  reverse: _WitnessSolicitationResponseReverse;
} = {
  forward: true as _WitnessSolicitationResponseForward,
  reverse: true as _WitnessSolicitationResponseReverse,
};

export function buildWitnessSolicitationResponseJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(WitnessSolicitationResponseSchema, {
    name: "WitnessSolicitationResponse",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("WitnessSolicitationResponse", raw, {
    $id: WITNESS_SOLICITATION_RESPONSE_SCHEMA_ID,
    title: "WitnessSolicitationResponse (v1)",
    description:
      "Peer's signed response to a witness solicitation. Structurally identical to a `cert.witnessed_by[]` entry; the issuer copies the response verbatim into the assembled cert before producing its final cert.signature. See spec/relay-federation-v1.md §15.",
  });
}

// ---------------------------------------------------------------------------
// WitnessOmissionDispute
//
// Discriminated evidence union — exactly one of `inclusion_proof`
// (membership in the cert's published anchor) or `alternative_peering`
// (peering attested outside the anchor; today: federation Heartbeat
// embedded as an opaque object whose verifier dispatches on its own
// self-described shape).
// ---------------------------------------------------------------------------

const WitnessOmissionInclusionProofEvidenceSchema = z
  .object({
    kind: z
      .literal("inclusion_proof")
      .describe(
        "Discriminator. Disputant proves their peer pubkey is committed in `cert.federation_graph_anchor.merkle_root` via the inclusion proof; `witnessed_by[]` then provably omits them.",
      ),
    leaf_hash: z
      .string()
      .min(1)
      .describe(
        "Hex-encoded SHA-256 leaf hash for the disputant's federation pubkey under the anchor's canonicalization (lowercase hex pubkey bytes — same recipe as relay-federation-v1.md §7.6 / credential-anchor-v1.md §3).",
      ),
    proof: merkleInclusionProofField().describe(
      "Inclusion proof against `cert.federation_graph_anchor.merkle_root`. The `@motebit/crypto :: verifyWitnessOmissionDispute` reconstructs the root and asserts equality with the anchor.",
    ),
  })
  .strict();

const WitnessOmissionAlternativePeeringEvidenceSchema = z
  .object({
    kind: z
      .literal("alternative_peering")
      .describe(
        "Discriminator. Disputant claims a peering relationship at `cert.horizon_ts` that the issuer's published anchor omitted — i.e., the anchor is incomplete or wrong.",
      ),
    peering_artifact: z
      .record(z.string(), z.unknown())
      .describe(
        "Signed peering artifact issued by the cert issuer, embedding its own signature. Today the canonical shape is a federation Heartbeat (`motebit-concat-ed25519-hex-v1`, payload `${relay_id}|${timestamp}|${suite}`) whose timestamp falls within ±5 min of `cert.horizon_ts` — mirrors `HEARTBEAT_REMOVE_THRESHOLD = 5` × `60s` in services/relay/src/federation.ts. Verifier dispatches on the artifact's self-described shape; future arms (e.g. PeeringConfirm) land as additive registry growth without a wire break.",
      ),
  })
  .strict();

const WitnessOmissionEvidenceSchema = z.discriminatedUnion("kind", [
  WitnessOmissionInclusionProofEvidenceSchema,
  WitnessOmissionAlternativePeeringEvidenceSchema,
]);

export const WitnessOmissionDisputeSchema = z
  .object({
    dispute_id: z
      .string()
      .min(1)
      .describe(
        "UUID v7 generated by the disputant. Stable through the existing dispute lifecycle (opened → evidence → arbitration → resolved → final).",
      ),
    cert_issuer: z
      .string()
      .min(1)
      .describe(
        "Motebit identity / operator id of the cert issuer — the relay that signed the disputed `append_only_horizon` cert. The relay reconciles against its local `relay_horizon_certs` table at validation time.",
      ),
    cert_signature: z
      .string()
      .min(1)
      .describe(
        "Hex-encoded signature of the disputed cert. Opaque pointer; the relay resolves the cert from its local `relay_horizon_certs` table by signature lookup.",
      ),
    disputant_motebit_id: z
      .string()
      .min(1)
      .describe(
        "Motebit identity of the disputant peer claiming wrongful omission from `cert.witnessed_by[]`.",
      ),
    evidence: WitnessOmissionEvidenceSchema.describe(
      "Exactly one of two evidence shapes — `inclusion_proof` proves membership in the published anchor, `alternative_peering` proves peering attested outside the anchor. The verifier dispatches by `kind`.",
    ),
    filed_at: z
      .number()
      .describe(
        "Unix milliseconds when the disputant signed the dispute. The verifier in `@motebit/crypto` enforces TWO clock gates: wall clock vs `cert.issued_at` (load-bearing) AND `filed_at ∈ [cert.issued_at, cert.issued_at + WITNESS_OMISSION_DISPUTE_WINDOW_MS]` (sanity). Disputant-attested timestamps cannot widen the 24h window.",
      ),
    suite: suiteField(),
    signature: z
      .string()
      .min(1)
      .describe(
        "Base64url-encoded Ed25519 signature by the disputant over `canonicalJson(dispute minus signature)`. Binds every other field — `cert_issuer`, `cert_signature`, `evidence`, `filed_at` — so a sustained dispute can't be re-pointed at a different cert post-hoc.",
      ),
  })
  .strict();

type _WitnessOmissionDisputeForward =
  WitnessOmissionDispute extends z.infer<typeof WitnessOmissionDisputeSchema> ? true : never;
type _WitnessOmissionDisputeReverse =
  z.infer<typeof WitnessOmissionDisputeSchema> extends WitnessOmissionDispute ? true : never;

export const _WITNESS_OMISSION_DISPUTE_TYPE_PARITY: {
  forward: _WitnessOmissionDisputeForward;
  reverse: _WitnessOmissionDisputeReverse;
} = {
  forward: true as _WitnessOmissionDisputeForward,
  reverse: true as _WitnessOmissionDisputeReverse,
};

export function buildWitnessOmissionDisputeJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(WitnessOmissionDisputeSchema, {
    name: "WitnessOmissionDispute",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("WitnessOmissionDispute", raw, {
    $id: WITNESS_OMISSION_DISPUTE_SCHEMA_ID,
    title: "WitnessOmissionDispute (v1)",
    description:
      "Soft-accountability dispute filed within 24h of `cert.issued_at` by a peer claiming wrongful omission from `cert.witnessed_by[]` on an `append_only_horizon` retention cert. Two evidence shapes (membership proof or alternative peering); adjudicated through the existing DisputeResolution path. Certs remain TERMINAL — a sustained dispute is a reputation hit on the issuer, not a cert invalidation. See docs/doctrine/retention-policy.md decision 5 + 4b-3 sub-notes.",
  });
}
