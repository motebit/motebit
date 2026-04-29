/**
 * Skill manifest + envelope types — motebit/skills@1.0.
 *
 * Permissive floor (Apache-2.0): these types define the interoperable wire
 * format for a motebit skill — agentskills.io-compatible frontmatter with
 * motebit-namespaced extensions for cryptographic provenance, sensitivity-
 * tiered loading, and hardware-attestation gating. See spec/skills-v1.md.
 *
 * The parsed frontmatter object (`SkillManifest`) is the wire artifact; the
 * YAML in `SKILL.md` is the on-disk encoding only. JSON-over-wire and the
 * `skill-envelope.json` wrapper both serialize to the types declared here.
 *
 * Audience-distinct from credentials (peer-issued reputation/trust attestations,
 * spec/credential-v1.md) and execution receipts (per-invocation audit,
 * spec/execution-ledger-v1.md). Phase 3 of skills-v1 will emit
 * `SkillLoadReceipt` entries into the execution ledger; that schema lives in
 * the ledger module, not here.
 *
 * Layer purity (per packages/protocol/CLAUDE.md): types only. Canonicalization
 * and signature verification live in @motebit/crypto. Frontmatter parsing,
 * registry, selector, and trust gate live in the BSL @motebit/skills package.
 */

import type { SuiteId } from "./crypto-suite.js";

// === Sensitivity Tiers ===

/**
 * Sensitivity tier of the data a skill's procedure causes the agent to touch.
 *
 * Sensitivity describes data, not provenance — see spec/skills-v1.md §4.
 * `medical`, `financial`, and `secret` skills are NEVER auto-loaded by the
 * `SkillSelector` regardless of session tier; they require explicit per-turn
 * opt-in or operator-mode session promotion.
 */
export type SkillSensitivity = "none" | "personal" | "medical" | "financial" | "secret";

/** Frozen list of sensitivity tiers in increasing-restriction order. */
export const SKILL_SENSITIVITY_TIERS: readonly SkillSensitivity[] = Object.freeze([
  "none",
  "personal",
  "medical",
  "financial",
  "secret",
]);

/** Tiers that are auto-loadable when session tier permits. */
export const SKILL_AUTO_LOADABLE_TIERS: readonly SkillSensitivity[] = Object.freeze([
  "none",
  "personal",
]);

// === Platform Gating ===

/** OS gate per agentskills.io `platforms` field. Empty/omitted = all platforms. */
export type SkillPlatform = "macos" | "linux" | "windows" | "ios" | "android";

/** Frozen list of recognized platform identifiers. */
export const SKILL_PLATFORMS: readonly SkillPlatform[] = Object.freeze([
  "macos",
  "linux",
  "windows",
  "ios",
  "android",
]);

// === Hardware Attestation Gating ===

/**
 * Hardware-attestation gate for skill loading.
 *
 * Additive scoring per docs/doctrine/hardware-attestation.md — never a hard
 * wall on the agent's own identity, but a skill MAY require its loading
 * runtime to present a minimum HA score. Sibling pattern to the
 * HardwareAttestationSemiring used in routing.
 */
export interface SkillHardwareAttestationGate {
  /** If `true`, loading agent must present an HA credential. Default `false`. */
  required?: boolean;
  /** Minimum score in `[0, 1]` required for load. Default `0`. */
  minimum_score?: number;
}

// === Signature ===

/**
 * Cryptographic provenance for a skill — sibling shape to other motebit
 * signed artifacts (settlement anchor, migration, execution receipts, etc.).
 *
 * The signature value is over the canonical form defined in
 * spec/skills-v1.md §5.1: `JCS(manifest_without_value) || 0x0A || lf_body`.
 * v1 uses `motebit-jcs-ed25519-b64-v1` — same suite as execution receipts and
 * other motebit-internal signed artifacts. Skills are NOT W3C `eddsa-jcs-2022`
 * DataIntegrityProof artifacts; that suite is reserved for credentials,
 * identity files, and presentations that need third-party W3C interop. Skills
 * install and verify locally on motebit runtimes, so they use the simpler
 * concat-bytes recipe consistent with the rest of the internal artifact
 * surface. Future suites (incl. PQ) are registry additions per
 * `architecture_cryptosuite_agility`.
 */
export interface SkillSignature {
  /** Cryptosuite discriminator. Verifiers reject unknown values fail-closed. */
  suite: SuiteId;
  /** Hex-encoded Ed25519 public key (32 bytes → 64 lowercase hex chars). */
  public_key: string;
  /** Base64url-encoded Ed25519 signature over the canonical bytes. */
  value: string;
}

// === Manifest ===

/**
 * Free-form display metadata per agentskills.io.
 *
 * `author` is a presentation field — NOT cryptographically verified. The
 * cryptographic author lives at `motebit.signature.public_key`. SDKs SHOULD
 * lint-warn (not reject) when a `did:key`-shaped value here disagrees with
 * the signature key. See spec/skills-v1.md §3.1.
 */
export interface SkillManifestMetadata {
  /** Free-form display string. Examples: `"Jane Doe"`, `"@janedoe"`, `"did:key:z6Mk..."`. */
  author?: string;
  /** Free-form category for UI grouping. Never load-bearing. */
  category?: string;
  /** Free-form tags for UI filtering. */
  tags?: string[];
  /**
   * Per-skill configuration values. Keys and shapes are skill-defined; the
   * runtime injects them via `skills.config.<key>` per agentskills.io
   * conventions.
   */
  config?: Record<string, unknown>;
}

/**
 * The motebit-namespaced extension block.
 *
 * Non-motebit agentskills.io runtimes ignore this entire object. Only
 * `spec_version` is required — the rest defaults per spec/skills-v1.md §3.1
 * (sensitivity → `"none"`, hardware_attestation → `{ required: false,
 * minimum_score: 0 }`, signature absent → unsigned skill).
 */
export interface SkillManifestMotebit {
  /** Spec version. v1: `"1.0"`. Gates compatibility for future bumps. */
  spec_version: "1.0";
  /** Sensitivity tier. Defaults to `"none"` if undeclared. */
  sensitivity?: SkillSensitivity;
  /** Hardware-attestation gate. Defaults to `{ required: false, minimum_score: 0 }`. */
  hardware_attestation?: SkillHardwareAttestationGate;
  /** Cryptographic signature. Absent = unsigned skill (NEVER auto-loaded by selector). */
  signature?: SkillSignature;
}

/**
 * The full parsed SKILL.md frontmatter.
 *
 * Wire format for skills exchanged over network or registry boundaries.
 * Defaults for optional fields are applied by the parser (BSL
 * @motebit/skills); the protocol type matches the literal JSON shape with
 * optionals where the spec marks them optional.
 */
export interface SkillManifest {
  /** Globally unique slug within an installation: `[a-z0-9-]+`. */
  name: string;
  /** One-line description. Read by the loader to decide skill relevance. */
  description: string;
  /** SemVer string. */
  version: string;
  /** OS gate. Empty/omitted = all platforms. */
  platforms?: SkillPlatform[];
  /** Free-form display metadata. */
  metadata?: SkillManifestMetadata;
  /** Motebit extension block. `spec_version` required; all other fields default. */
  motebit: SkillManifestMotebit;
}

// === Envelope ===

/**
 * One file in the skill envelope's `files` list.
 *
 * Each entry pins a relative path to its hex-encoded SHA-256 hash. Install
 * verifies envelope signature first, then re-derives every file hash from the
 * unpacked tree and asserts equality. Any mismatch aborts install with no
 * partial state (spec/skills-v1.md §6).
 */
export interface SkillEnvelopeFile {
  /** Path relative to the skill directory (e.g., `"scripts/run.sh"`). */
  path: string;
  /** Hex-encoded SHA-256 hash of the file bytes (lowercase, no `0x` prefix). */
  hash: string;
}

/**
 * Compact identity reference embedded in the envelope for indexing.
 */
export interface SkillEnvelopeSkillRef {
  /** Skill name (matches `SkillManifest.name`). */
  name: string;
  /** Skill version (matches `SkillManifest.version`). */
  version: string;
  /**
   * Hex-encoded SHA-256 over `JCS(manifest) || 0x0A || lf_body`. Sibling to
   * the `body_hash` field but covers the manifest as well — installers use
   * this as the content-addressed identifier for the skill version.
   */
  content_hash: string;
}

/**
 * Content-addressed signed wrapper for skill distribution and install.
 *
 * The envelope's `signature.value` is computed over JCS-canonicalized
 * envelope bytes with `signature.value` removed (sibling to the manifest
 * scheme in §5.1). Installers verify the envelope signature, then re-derive
 * `body_hash` and every `files[].hash` from the unpacked tree.
 */
export interface SkillEnvelope {
  /** Spec version. v1: `"1.0"`. */
  spec_version: "1.0";
  /** Compact skill reference for indexing. */
  skill: SkillEnvelopeSkillRef;
  /** Full parsed manifest (the same object that is the source of truth in SKILL.md). */
  manifest: SkillManifest;
  /** Hex-encoded SHA-256 of the LF-normalized body bytes. */
  body_hash: string;
  /** Pinned hashes of every file in the skill directory beyond SKILL.md and skill-envelope.json. */
  files: SkillEnvelopeFile[];
  /** Envelope signature — same suite as the manifest signature. */
  signature: SkillSignature;
}

// === Skill Load Receipt (event-log payload) ===

/**
 * Per-skill audit payload emitted by the runtime when the `SkillSelector`
 * pulls a skill body into the agent's system context. One event per
 * selected skill per turn, written to the agent's execution ledger as
 * `EventType.SkillLoaded` (spec/skills-v1.md §7.4).
 *
 * The audit trail lets a user prove later: "the obsidian skill ran on
 * date X with this exact signature value at session sensitivity Y." The
 * `skill_signature` field is the envelope's `signature.value` — a
 * content-addressed pointer to the exact bytes injected, recoverable by
 * looking up the installed skill at `~/.motebit/skills/<name>/`.
 *
 * Wire-level event-envelope (timestamp, event_id, motebit_id) lives at
 * `EventLogEntry`; the per-skill detail is here.
 */
export interface SkillLoadPayload {
  /** Composite identifier `"name@version"` — convenient for log queries. */
  skill_id: string;
  /** Skill slug (matches `SkillManifest.name`). */
  skill_name: string;
  /** Skill SemVer (matches `SkillManifest.version`). */
  skill_version: string;
  /**
   * Base64url-encoded envelope signature value. Pins the audit entry to
   * the exact bytes that were on disk at load time — re-signing the skill
   * (e.g., via `pnpm --filter @motebit/skills build-reference-skill`)
   * produces a different value, so a stale ledger entry whose signature
   * doesn't resolve in the current registry is itself a useful audit
   * signal. Empty string when the manifest is `trusted_unsigned` (operator-
   * attested but no cryptographic signature exists to record).
   */
  skill_signature: string;
  /** Provenance status at load time. Display-grade copy of `SkillProvenanceStatus`. */
  provenance: "verified" | "trusted_unsigned";
  /** BM25 relevance score against the user's turn. Higher = more relevant. */
  score: number;
  /**
   * Run identifier the load is keyed to. Matches the `runId` passed to
   * `runtime.sendMessage` / `sendMessageStreaming` — pairs every skill
   * load with the turn that triggered it. Optional because the runtime
   * may emit loads outside an explicit run context (e.g., proactive
   * cycles, future).
   */
  run_id?: string;
  /** Session sensitivity tier in effect when the skill loaded. */
  session_sensitivity: SkillSensitivity;
}

// === Registry (skills-registry-v1.md) ===

/**
 * One row in the relay-hosted skills registry. Returned in `discover`
 * listings; one entry per submitted skill version.
 *
 * The display fields (`description`, `sensitivity`, `platforms`,
 * `category`, `tags`, `author`) are denormalized from the embedded
 * manifest so the discover query does not need to round-trip the full
 * bundle for each row.
 *
 * `submitter_motebit_id` is canonical: derived from `envelope.signature.public_key`
 * by the relay, never user-provided. Submitter spoofing is impossible.
 */
export interface SkillRegistryEntry {
  /** `did:key` derived from `envelope.signature.public_key`. */
  submitter_motebit_id: string;
  /** Slug. Matches `manifest.name`. */
  name: string;
  /** SemVer. Matches `manifest.version`. */
  version: string;
  /** 64 hex chars; SHA-256 over `JCS(manifest) || 0x0A || lf_body`. */
  content_hash: string;
  description: string;
  sensitivity: SkillSensitivity;
  platforms?: SkillPlatform[];
  category?: string;
  tags?: string[];
  author?: string;
  /** 64 hex chars; mirrors `envelope.signature.public_key`. */
  signature_public_key: string;
  /** True iff the submitter is in the relay's featured-submitters allowlist. */
  featured: boolean;
  /** Unix ms. */
  submitted_at: number;
}

/**
 * Body of `POST /api/v1/skills/submit`. Carries the full signed
 * envelope plus body and aux files as base64 strings. The relay
 * re-derives `body_hash` and per-file hashes and asserts they match
 * the envelope before persisting.
 *
 * The submitter is NOT named in this payload — the relay computes it
 * canonically from `envelope.signature.public_key`.
 */
export interface SkillRegistrySubmitRequest {
  envelope: SkillEnvelope;
  /** Base64-encoded LF-normalized SKILL.md body bytes. */
  body: string;
  /** Base64-encoded auxiliary file bytes. Keys are the same paths as `envelope.files[].path`. */
  files?: Record<string, string>;
}

/**
 * Response body of `POST /api/v1/skills/submit` on success. Returns
 * the canonical addressing tuple plus the relay-computed
 * `submitter_motebit_id` so the caller can confirm the relay derived
 * the same `did:key` it expected.
 */
export interface SkillRegistrySubmitResponse {
  /** `<submitter_motebit_id>/<name>@<version>`. */
  skill_id: string;
  submitter_motebit_id: string;
  name: string;
  version: string;
  content_hash: string;
  submitted_at: number;
}

/**
 * Response body of `GET /api/v1/skills/discover`. A paginated page of
 * `SkillRegistryEntry` rows plus pagination metadata.
 */
export interface SkillRegistryListing {
  entries: SkillRegistryEntry[];
  /** Total rows matching the filter — not just this page. */
  total: number;
  /** Page size used (default 50, max 200). */
  limit: number;
  /** Page offset used (default 0). */
  offset: number;
}

/**
 * Response body of `GET /api/v1/skills/:submitter/:name/:version`.
 * Carries the full signed envelope, body, and any auxiliary files as
 * base64 strings. Same shape as `SkillRegistrySubmitRequest` plus a
 * `submitter_motebit_id` echo so consumers can confirm the resolved
 * address before re-verifying.
 */
export interface SkillRegistryBundle {
  /** Echoed from the route param; equals `publicKeyToDidKey(envelope.signature.public_key)`. */
  submitter_motebit_id: string;
  envelope: SkillEnvelope;
  /** Base64-encoded LF-normalized SKILL.md body bytes. */
  body: string;
  /** Base64-encoded auxiliary file bytes. */
  files?: Record<string, string>;
  submitted_at: number;
  featured: boolean;
}
