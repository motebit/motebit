/**
 * Skills Registry — wire schemas.
 *
 * Five wire formats from `spec/skills-registry-v1.md`:
 *   - SkillRegistryEntry         — one row in the registry index (returned by discover)
 *   - SkillRegistrySubmitRequest — POST /api/v1/skills/submit body
 *   - SkillRegistrySubmitResponse— POST /api/v1/skills/submit response
 *   - SkillRegistryListing       — GET /api/v1/skills/discover response (paginated)
 *   - SkillRegistryBundle        — GET /api/v1/skills/:submitter/:name/:version response
 *
 * The submitter component of every addressing tuple is canonical:
 * derived from `envelope.signature.public_key` by the relay, never
 * user-provided. The schemas accept it as a string but enforce the
 * `did:key:z…` shape so a misshapen value never enters the index.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type {
  SkillRegistryBundle,
  SkillRegistryEntry,
  SkillRegistryListing,
  SkillRegistrySubmitRequest,
  SkillRegistrySubmitResponse,
} from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";
import { SkillEnvelopeSchema } from "./skill-envelope.js";

// ---------------------------------------------------------------------------
// Stable schema $ids
// ---------------------------------------------------------------------------

export const SKILL_REGISTRY_ENTRY_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/skill-registry-entry-v1.json";
export const SKILL_REGISTRY_SUBMIT_REQUEST_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/skill-registry-submit-request-v1.json";
export const SKILL_REGISTRY_SUBMIT_RESPONSE_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/skill-registry-submit-response-v1.json";
export const SKILL_REGISTRY_LISTING_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/skill-registry-listing-v1.json";
export const SKILL_REGISTRY_BUNDLE_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/skill-registry-bundle-v1.json";

// ---------------------------------------------------------------------------
// Leaf schemas
// ---------------------------------------------------------------------------

const HexSha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { message: "must be 64 hex chars (lowercase, no 0x prefix)" });

const HexEd25519PublicKeySchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { message: "must be 64 hex chars (Ed25519 public key)" });

const DidKeySchema = z.string().regex(/^did:key:z[1-9A-HJ-NP-Za-km-z]{40,80}$/, {
  message: "must be did:key:z<base58btc> form",
});

const SkillSlugSchema = z.string().regex(/^[a-z0-9-]+$/);
const SemverSchema = z.string().min(1);
const SkillSensitivityEnumSchema = z.enum(["none", "personal", "medical", "financial", "secret"]);
const SkillPlatformEnumSchema = z.enum(["macos", "linux", "windows", "ios", "android"]);

// Base64-encoded bytes. We accept both standard and url-safe variants —
// the registry doesn't care which scheme submitters used, only that the
// decoded SHA-256 matches the envelope's pinned hash. The relay decodes
// before hashing; mismatched bytes are caught downstream.
const Base64StringSchema = z
  .string()
  .regex(/^[A-Za-z0-9_+/=-]*$/, { message: "must be base64 (standard or url-safe)" });

// ---------------------------------------------------------------------------
// SkillRegistryEntry
// ---------------------------------------------------------------------------

export const SkillRegistryEntrySchema = z
  .object({
    submitter_motebit_id: DidKeySchema.describe(
      "did:key derived from envelope.signature.public_key by the relay.",
    ),
    name: SkillSlugSchema.describe("Slug. Matches manifest.name."),
    version: SemverSchema.describe("SemVer. Matches manifest.version."),
    content_hash: HexSha256Schema.describe(
      "Hex-encoded SHA-256 over JCS(manifest) || 0x0A || lf_body. Matches envelope.skill.content_hash.",
    ),
    description: z.string().describe("Mirrors manifest.description."),
    sensitivity: SkillSensitivityEnumSchema.describe("Mirrors manifest.motebit.sensitivity."),
    platforms: z
      .array(SkillPlatformEnumSchema)
      .optional()
      .describe("Mirrors manifest.platforms. Empty/omitted = all platforms."),
    category: z
      .string()
      .optional()
      .describe("Mirrors manifest.metadata.category. UI grouping only."),
    tags: z
      .array(z.string())
      .optional()
      .describe("Mirrors manifest.metadata.tags. UI filtering only."),
    author: z
      .string()
      .optional()
      .describe(
        "Mirrors manifest.metadata.author. Display only — not cryptographically verified. The cryptographic author is `signature_public_key` (and the derived `submitter_motebit_id`).",
      ),
    signature_public_key: HexEd25519PublicKeySchema.describe(
      "Hex-encoded Ed25519 public key. Mirrors envelope.signature.public_key.",
    ),
    featured: z
      .boolean()
      .describe("True iff the submitter is in the relay's featured-submitters allowlist."),
    submitted_at: z.number().int().nonnegative().describe("Unix milliseconds."),
  })
  .strict();

// ---------------------------------------------------------------------------
// SkillRegistrySubmitRequest
// ---------------------------------------------------------------------------

export const SkillRegistrySubmitRequestSchema = z
  .object({
    envelope: SkillEnvelopeSchema.describe(
      "Full signed envelope from `skill-envelope.json` (spec/skills-v1.md §6). The relay re-derives body_hash + per-file hashes from the bundled body+files and asserts they match this envelope before persisting.",
    ),
    body: Base64StringSchema.describe("Base64-encoded LF-normalized SKILL.md body bytes."),
    files: z
      .record(z.string(), Base64StringSchema)
      .optional()
      .describe(
        "Map of relative path → base64-encoded file bytes. Keys MUST match envelope.files[].path.",
      ),
  })
  .strict();

// ---------------------------------------------------------------------------
// SkillRegistrySubmitResponse
// ---------------------------------------------------------------------------

export const SkillRegistrySubmitResponseSchema = z
  .object({
    skill_id: z
      .string()
      .describe("`<submitter_motebit_id>/<name>@<version>` — canonical addressing tuple."),
    submitter_motebit_id: DidKeySchema.describe(
      "did:key derived from envelope.signature.public_key by the relay. Returned so the caller can confirm the relay derived the same did:key it expected.",
    ),
    name: SkillSlugSchema.describe("Slug. Echoes manifest.name."),
    version: SemverSchema.describe("SemVer. Echoes manifest.version."),
    content_hash: HexSha256Schema.describe("Echoes envelope.skill.content_hash."),
    submitted_at: z.number().int().nonnegative().describe("Unix milliseconds."),
  })
  .strict();

// ---------------------------------------------------------------------------
// SkillRegistryListing
// ---------------------------------------------------------------------------

export const SkillRegistryListingSchema = z
  .object({
    entries: z
      .array(SkillRegistryEntrySchema)
      .describe("Page of registry entries. Sorted alphabetically by name, then version DESC."),
    total: z
      .number()
      .int()
      .nonnegative()
      .describe("Total rows matching the filter — not just this page."),
    limit: z.number().int().positive().describe("Page size used (default 50, max 200)."),
    offset: z.number().int().nonnegative().describe("Page offset used (default 0)."),
  })
  .strict();

// ---------------------------------------------------------------------------
// SkillRegistryBundle
// ---------------------------------------------------------------------------

export const SkillRegistryBundleSchema = z
  .object({
    submitter_motebit_id: DidKeySchema.describe(
      "did:key, echoed from the route param. Equals `publicKeyToDidKey(envelope.signature.public_key)`. Consumers re-derive and assert before installing.",
    ),
    envelope: SkillEnvelopeSchema.describe(
      "Full signed envelope, byte-identical to what was submitted. Consumers MUST re-verify against `envelope.signature.public_key` before installing — relay is a convenience surface, not a trust root.",
    ),
    body: Base64StringSchema.describe("Base64-encoded LF-normalized SKILL.md body bytes."),
    files: z
      .record(z.string(), Base64StringSchema)
      .optional()
      .describe(
        "Map of relative path → base64-encoded file bytes. Keys match envelope.files[].path.",
      ),
    submitted_at: z.number().int().nonnegative().describe("Unix milliseconds."),
    featured: z
      .boolean()
      .describe("True iff the submitter is in the relay's featured-submitters allowlist."),
  })
  .strict();

// ---------------------------------------------------------------------------
// Type parity — drift defense
// ---------------------------------------------------------------------------

type _EntryForward =
  SkillRegistryEntry extends z.infer<typeof SkillRegistryEntrySchema> ? true : never;
type _EntryReverse =
  z.infer<typeof SkillRegistryEntrySchema> extends SkillRegistryEntry ? true : never;
type _SubmitReqForward =
  SkillRegistrySubmitRequest extends z.infer<typeof SkillRegistrySubmitRequestSchema>
    ? true
    : never;
type _SubmitReqReverse =
  z.infer<typeof SkillRegistrySubmitRequestSchema> extends SkillRegistrySubmitRequest
    ? true
    : never;
type _SubmitRespForward =
  SkillRegistrySubmitResponse extends z.infer<typeof SkillRegistrySubmitResponseSchema>
    ? true
    : never;
type _SubmitRespReverse =
  z.infer<typeof SkillRegistrySubmitResponseSchema> extends SkillRegistrySubmitResponse
    ? true
    : never;
type _ListingForward =
  SkillRegistryListing extends z.infer<typeof SkillRegistryListingSchema> ? true : never;
type _ListingReverse =
  z.infer<typeof SkillRegistryListingSchema> extends SkillRegistryListing ? true : never;
type _BundleForward =
  SkillRegistryBundle extends z.infer<typeof SkillRegistryBundleSchema> ? true : never;
type _BundleReverse =
  z.infer<typeof SkillRegistryBundleSchema> extends SkillRegistryBundle ? true : never;

export const _SKILL_REGISTRY_TYPE_PARITY: {
  entry: { forward: _EntryForward; reverse: _EntryReverse };
  submitRequest: { forward: _SubmitReqForward; reverse: _SubmitReqReverse };
  submitResponse: { forward: _SubmitRespForward; reverse: _SubmitRespReverse };
  listing: { forward: _ListingForward; reverse: _ListingReverse };
  bundle: { forward: _BundleForward; reverse: _BundleReverse };
} = {
  entry: { forward: true as _EntryForward, reverse: true as _EntryReverse },
  submitRequest: {
    forward: true as _SubmitReqForward,
    reverse: true as _SubmitReqReverse,
  },
  submitResponse: {
    forward: true as _SubmitRespForward,
    reverse: true as _SubmitRespReverse,
  },
  listing: { forward: true as _ListingForward, reverse: true as _ListingReverse },
  bundle: { forward: true as _BundleForward, reverse: true as _BundleReverse },
};

// ---------------------------------------------------------------------------
// JSON Schema emitters
// ---------------------------------------------------------------------------

export function buildSkillRegistryEntryJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(SkillRegistryEntrySchema, {
    name: "SkillRegistryEntry",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("SkillRegistryEntry", raw, {
    $id: SKILL_REGISTRY_ENTRY_SCHEMA_ID,
    title: "SkillRegistryEntry (v1)",
    description:
      "One row in the relay-hosted skills registry. Spec: https://raw.githubusercontent.com/motebit/motebit/main/spec/skills-registry-v1.md",
  });
}

export function buildSkillRegistrySubmitRequestJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(SkillRegistrySubmitRequestSchema, {
    name: "SkillRegistrySubmitRequest",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("SkillRegistrySubmitRequest", raw, {
    $id: SKILL_REGISTRY_SUBMIT_REQUEST_SCHEMA_ID,
    title: "SkillRegistrySubmitRequest (v1)",
    description:
      "Body of POST /api/v1/skills/submit — signed envelope + base64-encoded body and aux files. Spec: https://raw.githubusercontent.com/motebit/motebit/main/spec/skills-registry-v1.md",
  });
}

export function buildSkillRegistrySubmitResponseJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(SkillRegistrySubmitResponseSchema, {
    name: "SkillRegistrySubmitResponse",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("SkillRegistrySubmitResponse", raw, {
    $id: SKILL_REGISTRY_SUBMIT_RESPONSE_SCHEMA_ID,
    title: "SkillRegistrySubmitResponse (v1)",
    description:
      "Response of POST /api/v1/skills/submit on success. Spec: https://raw.githubusercontent.com/motebit/motebit/main/spec/skills-registry-v1.md",
  });
}

export function buildSkillRegistryListingJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(SkillRegistryListingSchema, {
    name: "SkillRegistryListing",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("SkillRegistryListing", raw, {
    $id: SKILL_REGISTRY_LISTING_SCHEMA_ID,
    title: "SkillRegistryListing (v1)",
    description:
      "Paginated response of GET /api/v1/skills/discover. Spec: https://raw.githubusercontent.com/motebit/motebit/main/spec/skills-registry-v1.md",
  });
}

export function buildSkillRegistryBundleJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(SkillRegistryBundleSchema, {
    name: "SkillRegistryBundle",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("SkillRegistryBundle", raw, {
    $id: SKILL_REGISTRY_BUNDLE_SCHEMA_ID,
    title: "SkillRegistryBundle (v1)",
    description:
      "Response of GET /api/v1/skills/:submitter/:name/:version — signed envelope + base64-encoded body and aux files. Spec: https://raw.githubusercontent.com/motebit/motebit/main/spec/skills-registry-v1.md",
  });
}
