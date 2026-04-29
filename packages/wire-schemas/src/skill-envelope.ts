/**
 * Skill Envelope — wire schema.
 *
 * The signed `skill-envelope.json` wrapper that ships alongside SKILL.md
 * for skill distribution and install. Content-addressed: the envelope
 * pins `body_hash` (LF-normalized SKILL.md body) and per-file hashes,
 * then signs the JCS-canonicalized envelope with `signature.value`
 * removed. Installers verify the signature, then re-derive every hash
 * from the unpacked tree and assert equality. Any mismatch aborts
 * install with no partial state. See spec/skills-v1.md §6.
 *
 * The embedded `manifest` object is the same `SkillManifest` parsed from
 * the SKILL.md frontmatter — duplicated here so the envelope is a
 * self-contained wire artifact (third-party verifiers and registries
 * need only the envelope to validate name, version, sensitivity, and
 * provenance without reading SKILL.md).
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { SkillEnvelope } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";
import { SkillManifestSchema } from "./skill-manifest.js";

/** Stable `$id` for the skill-envelope v1 wire format. External tools pin to this. */
export const SKILL_ENVELOPE_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/skill-envelope-v1.json";

// ---------------------------------------------------------------------------
// Leaf schemas
// ---------------------------------------------------------------------------

const HexSha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, { message: "must be 64 hex chars (lowercase, no 0x prefix)" })
  .describe("Hex-encoded SHA-256 digest. Lowercase, no `0x` prefix.");

const SkillEnvelopeFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        'Path relative to the skill directory (e.g., `"scripts/run.sh"`). Forward slashes only.',
      ),
    hash: HexSha256Schema.describe("Hex-encoded SHA-256 hash of the file bytes."),
  })
  .strict();

const SkillEnvelopeSkillRefSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .describe("Skill name. Matches `manifest.name`."),
    version: z.string().min(1).describe("Skill version. Matches `manifest.version`."),
    content_hash: HexSha256Schema.describe(
      "Hex-encoded SHA-256 over `JCS(manifest) || 0x0A || lf_body`. Content-addressed identifier for this version.",
    ),
  })
  .strict();

const SkillSignatureSchema = z
  .object({
    suite: z
      .literal("motebit-jcs-ed25519-b64-v1")
      .describe(
        "Cryptosuite identifier. Pinned to `motebit-jcs-ed25519-b64-v1` — same suite as the manifest signature.",
      ),
    public_key: z
      .string()
      .regex(/^[0-9a-f]{64}$/, { message: "public_key must be 64 hex chars" })
      .describe("Hex-encoded Ed25519 public key."),
    value: z
      .string()
      .min(1)
      .describe(
        "Base64url-encoded Ed25519 signature over `JCS(envelope_without_signature_value)`.",
      ),
  })
  .strict();

// ---------------------------------------------------------------------------
// Envelope schema
// ---------------------------------------------------------------------------

export const SkillEnvelopeSchema = z
  .object({
    spec_version: z.literal("1.0").describe('Spec version. v1: `"1.0"`.'),
    skill: SkillEnvelopeSkillRefSchema.describe(
      "Compact addressing tuple: name, version, and content_hash. Used for indexing and addressing without parsing the full manifest.",
    ),
    manifest: SkillManifestSchema.describe(
      "The parsed SKILL.md frontmatter (`SkillManifest`). Embedded so the envelope is self-contained — third-party verifiers and registries validate name, version, sensitivity, and provenance without reading SKILL.md.",
    ),
    body_hash: HexSha256Schema.describe(
      "Hex-encoded SHA-256 of the LF-normalized SKILL.md body bytes (everything after the closing `---`).",
    ),
    files: z
      .array(SkillEnvelopeFileSchema)
      .describe(
        "Pinned hashes of every file in the skill directory beyond SKILL.md and skill-envelope.json.",
      ),
    signature: SkillSignatureSchema.describe(
      "Ed25519 signature over the JCS-canonicalized envelope with `signature.value` removed. Suite is pinned to `motebit-jcs-ed25519-b64-v1`. Verification: re-canonicalize, verify against `signature.public_key`.",
    ),
  })
  .strict();

// ---------------------------------------------------------------------------
// Type parity — drift defense
// ---------------------------------------------------------------------------

type InferredSkillEnvelope = z.infer<typeof SkillEnvelopeSchema>;

type _ForwardCheck = SkillEnvelope extends InferredSkillEnvelope ? true : never;
type _ReverseCheck = InferredSkillEnvelope extends SkillEnvelope ? true : never;

export const _SKILL_ENVELOPE_TYPE_PARITY: {
  forward: _ForwardCheck;
  reverse: _ReverseCheck;
} = {
  forward: true as _ForwardCheck,
  reverse: true as _ReverseCheck,
};

// ---------------------------------------------------------------------------
// JSON Schema emitter
// ---------------------------------------------------------------------------

export function buildSkillEnvelopeJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(SkillEnvelopeSchema, {
    name: "SkillEnvelope",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("SkillEnvelope", raw, {
    $id: SKILL_ENVELOPE_SCHEMA_ID,
    title: "SkillEnvelope (v1)",
    description:
      "Content-addressed signed wrapper for skill distribution and install. Pins manifest, LF-normalized body bytes, and per-file SHA-256 hashes; signature is over JCS-canonicalized envelope with signature.value removed. Spec: https://raw.githubusercontent.com/motebit/motebit/main/spec/skills-v1.md",
  });
}
