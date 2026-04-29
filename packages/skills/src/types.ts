/**
 * BSL-layer types for the skills runtime — installed-skill index entries,
 * selection contexts, and selector outputs. Wire types (SkillManifest,
 * SkillEnvelope, SkillSignature, etc.) live in @motebit/protocol; this
 * module is for the in-memory and on-disk types the registry/selector
 * operate on.
 */

import type {
  SkillEnvelope,
  SkillManifest,
  SkillPlatform,
  SkillSensitivity,
} from "@motebit/protocol";

/**
 * Provenance status of an installed skill, as observed by the registry.
 *
 * - `verified` — `motebit.signature` present AND `verifySkillEnvelope`
 *   succeeded at install time. Auto-loadable subject to other gates.
 * - `unverified` — signature was present but verification failed (tampered,
 *   wrong key, etc.). Skill is rejected at install; this status only
 *   surfaces transiently during install-time error reporting.
 * - `unsigned` — no `motebit.signature` block. Installs permissively;
 *   never auto-loaded until promoted.
 * - `trusted_unsigned` — operator-granted manual trust on an unsigned
 *   skill (see `registry.trust()`). Auto-loadable subject to other gates,
 *   but display surfaces MUST distinguish from `verified`.
 */
export type SkillProvenanceStatus = "verified" | "unverified" | "unsigned" | "trusted_unsigned";

/**
 * On-disk index entry for an installed skill. Maps to one row in
 * `~/.motebit/skills/installed.json` for the reference fs adapter.
 */
export interface InstalledSkillIndexEntry {
  name: string;
  version: string;
  enabled: boolean;
  /** `true` only after explicit `registry.trust(name)`. Promotes unsigned skills to auto-loadable. */
  trusted: boolean;
  /** ISO 8601 timestamp. */
  installed_at: string;
  /** Where the install came from. Free-form: `"git+https://..."`, `"file:///path"`, etc. */
  source: string;
  /** Hex SHA-256 from envelope.skill.content_hash. */
  content_hash: string;
}

/**
 * Full materialized skill record. Yielded by registry reads.
 */
export interface SkillRecord {
  index: InstalledSkillIndexEntry;
  manifest: SkillManifest;
  envelope: SkillEnvelope;
  /** LF-normalized SKILL.md body bytes (post-frontmatter). */
  body: Uint8Array;
  /** Map of relative path → bytes for any auxiliary files (scripts/, references/, templates/, assets/). */
  files: Record<string, Uint8Array>;
  /** Derived at install-time and refreshed on `registry.verify()`. */
  provenance_status: SkillProvenanceStatus;
}

/**
 * Inputs to the selector. Pure — no I/O happens inside the selector.
 */
export interface SkillSelectionContext {
  /** The user turn the selector is choosing skills for. Empty string is allowed (returns highest-IDF skills). */
  turn: string;
  /** Session sensitivity tier. Skills strictly above this never auto-load. */
  sessionSensitivity: SkillSensitivity;
  /** Hardware-attestation score in `[0, 1]`. Skills with `minimum_score > this` skip. */
  hardwareAttestationScore: number;
  /** Current OS. */
  platform: SkillPlatform;
  /** Top-K cap (default 3). */
  topK?: number;
}

/**
 * One selected skill, ready for context injection.
 */
export interface SkillSelection {
  name: string;
  version: string;
  /** Markdown body to inject. */
  body: string;
  /** Provenance status of the skill at selection time. Display callers use this for badging. */
  provenance_status: Extract<SkillProvenanceStatus, "verified" | "trusted_unsigned">;
  /** BM25 score against the turn. Higher is more relevant. */
  score: number;
}

/**
 * Reason a skill was filtered out of selection. Surfaced by `selector.explain()`
 * for `/skills` UI.
 */
export type SkillFilterReason =
  | "disabled"
  | "untrusted"
  | "platform_mismatch"
  | "sensitivity_above_session"
  | "hardware_attestation_gate"
  | "low_relevance";

/**
 * One filtered candidate with the reason it was excluded.
 */
export interface SkillFilteredCandidate {
  name: string;
  version: string;
  reason: SkillFilterReason;
}

/**
 * Sources a skill can be installed from. The fs adapter resolves all of
 * these to a directory tree; the registry consumes the resolved tree.
 */
export type SkillInstallSource =
  | { kind: "directory"; path: string }
  | { kind: "git"; url: string; ref?: string }
  | { kind: "url"; url: string }
  | {
      kind: "in_memory";
      manifest: SkillManifest;
      envelope: SkillEnvelope;
      body: Uint8Array;
      files?: Record<string, Uint8Array>;
    };
