/**
 * Skill Manifest — wire schema.
 *
 * The parsed YAML frontmatter from a SKILL.md file. agentskills.io-compatible
 * frontmatter with motebit-namespaced extensions for cryptographic provenance,
 * sensitivity-tiered loading, and hardware-attestation gating. See
 * spec/skills-v1.md §3.
 *
 * Canonicalization: JCS (RFC 8785) over the manifest object with
 * `motebit.signature.value` removed; signed bytes are
 * `canonical_manifest_json || 0x0A || lf_normalized_body`. Suite today is
 * pinned to `"eddsa-jcs-2022"` — the same suite used for credentials,
 * identity files, and presentations. Suite agility is preserved via the
 * closed `SuiteId` union; a future suite is a registry addition, not a
 * wire-format break.
 *
 * Third-party agentskills.io runtimes that have not adopted the upstream
 * `author_signature` extension ignore the entire `motebit.*` block — the
 * standard fields (`name`, `description`, `version`, `platforms`,
 * `metadata`) are a strict subset of agentskills.io interop.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { SkillManifest } from "@motebit/protocol";

import { assembleJsonSchemaFor } from "./assemble.js";

/** Stable `$id` for the skill-manifest v1 wire format. External tools pin to this. */
export const SKILL_MANIFEST_SCHEMA_ID =
  "https://raw.githubusercontent.com/motebit/motebit/main/spec/schemas/skill-manifest-v1.json";

// ---------------------------------------------------------------------------
// Leaf schemas
// ---------------------------------------------------------------------------

const SkillSensitivitySchema = z
  .enum(["none", "personal", "medical", "financial", "secret"])
  .describe(
    "Sensitivity tier of the data the skill's procedure causes the agent to touch. `medical | financial | secret` are NEVER auto-loaded by the SkillSelector regardless of session tier (spec/skills-v1.md §4). Sensitivity describes data, not provenance — provenance is a separate axis (§7.1).",
  );

const SkillPlatformSchema = z
  .enum(["macos", "linux", "windows", "ios", "android"])
  .describe("OS gate per agentskills.io `platforms` field. Empty/omitted array = all platforms.");

const SkillSignatureSuiteSchema = z
  .literal("motebit-jcs-ed25519-b64-v1")
  .describe(
    "Cryptosuite identifier. Pinned to `motebit-jcs-ed25519-b64-v1` for skills v1 — JCS canonicalization (RFC 8785), Ed25519 primitive, hex-encoded public key, base64url-encoded signature. Same suite used for execution receipts, tool invocation receipts, settlement anchors, and migration artifacts. Future suites (incl. PQ) widen the closed SuiteId union.",
  );

const SkillSignatureSchema = z
  .object({
    suite: SkillSignatureSuiteSchema,
    public_key: z
      .string()
      .regex(/^[0-9a-f]{64}$/, { message: "public_key must be 64 hex chars (Ed25519, lowercase)" })
      .describe("Hex-encoded Ed25519 public key (32 bytes → 64 lowercase hex chars)."),
    value: z
      .string()
      .min(1)
      .describe(
        "Base64url-encoded Ed25519 signature over the canonical bytes. See spec/skills-v1.md §5.1 for the byte form.",
      ),
  })
  .strict();

const SkillHardwareAttestationGateSchema = z
  .object({
    required: z
      .boolean()
      .optional()
      .describe("If `true`, the loading agent must present an HA credential. Default `false`."),
    minimum_score: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Minimum HA score in `[0, 1]` required for load. Default `0`."),
  })
  .strict();

const SkillManifestMetadataSchema = z
  .object({
    author: z
      .string()
      .optional()
      .describe(
        "Free-form display string per agentskills.io. NOT cryptographically verified. The cryptographic author is `motebit.signature.public_key`. SDKs SHOULD lint-warn (not reject) when a `did:key`-shaped value here disagrees with the signature key.",
      ),
    category: z
      .string()
      .optional()
      .describe("Free-form category for UI grouping. Never load-bearing."),
    tags: z.array(z.string()).optional().describe("Free-form tags. UI filtering only."),
    config: z
      .record(z.unknown())
      .optional()
      .describe(
        "Per-skill configuration values. Keys and shapes are skill-defined; the runtime injects them via `skills.config.<key>` per agentskills.io conventions.",
      ),
  })
  .strict();

const SkillManifestMotebitSchema = z
  .object({
    spec_version: z
      .literal("1.0")
      .describe('Spec version. v1: `"1.0"`. Gates compatibility for future bumps.'),
    sensitivity: SkillSensitivitySchema.optional(),
    hardware_attestation: SkillHardwareAttestationGateSchema.optional(),
    signature: SkillSignatureSchema.optional(),
  })
  .strict()
  .describe(
    "Motebit-namespaced extension block. Non-motebit agentskills.io runtimes ignore this object entirely.",
  );

// ---------------------------------------------------------------------------
// Manifest schema
// ---------------------------------------------------------------------------

export const SkillManifestSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9-]+$/, { message: "name must be slug form: [a-z0-9-]+" })
      .describe("Globally unique slug within an installation. Slug form: `[a-z0-9-]+`."),
    description: z
      .string()
      .min(1)
      .describe(
        "One-line description. Read by the loader to decide skill relevance for a given turn.",
      ),
    version: z.string().min(1).describe("SemVer string."),
    platforms: z
      .array(SkillPlatformSchema)
      .optional()
      .describe("OS gate. Empty/omitted = all platforms."),
    metadata: SkillManifestMetadataSchema.optional(),
    motebit: SkillManifestMotebitSchema,
  })
  .strict();

// ---------------------------------------------------------------------------
// Type parity — the static drift defense
// ---------------------------------------------------------------------------

type InferredSkillManifest = z.infer<typeof SkillManifestSchema>;

type _ForwardCheck = SkillManifest extends InferredSkillManifest ? true : never;
type _ReverseCheck = InferredSkillManifest extends SkillManifest ? true : never;

export const _SKILL_MANIFEST_TYPE_PARITY: {
  forward: _ForwardCheck;
  reverse: _ReverseCheck;
} = {
  forward: true as _ForwardCheck,
  reverse: true as _ReverseCheck,
};

// ---------------------------------------------------------------------------
// JSON Schema emitter
// ---------------------------------------------------------------------------

/** Build the JSON Schema (draft-07) object for SkillManifest. Pure. */
export function buildSkillManifestJsonSchema(): Record<string, unknown> {
  const raw = zodToJsonSchema(SkillManifestSchema, {
    name: "SkillManifest",
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
  return assembleJsonSchemaFor("SkillManifest", raw, {
    $id: SKILL_MANIFEST_SCHEMA_ID,
    title: "SkillManifest (v1)",
    description:
      "agentskills.io-compatible skill frontmatter with motebit-namespaced extensions for cryptographic provenance, sensitivity-tiered loading, and hardware-attestation gating. Spec: https://raw.githubusercontent.com/motebit/motebit/main/spec/skills-v1.md",
  });
}
