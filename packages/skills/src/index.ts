/**
 * @motebit/skills — runtime layer for user-installable procedural-knowledge
 * (agentskills.io-compatible) with motebit's sovereign extensions.
 *
 * Spec: spec/skills-v1.md.
 *
 * Public surface:
 *
 *   parseSkillFile(text) -> { manifest, body }
 *     Frontmatter parsing + zod validation + LF normalization.
 *
 *   serializeSkillFile(manifest, body) -> string
 *     Inverse of parse. Note: NOT what signatures are computed over —
 *     use canonicalizeSkillManifestBytes from @motebit/crypto for that.
 *
 *   class SkillRegistry(adapter, options?)
 *     Install/list/enable/disable/remove/trust/untrust/verify.
 *     Install is permissive for unsigned skills; tampered signed skills
 *     are hard-rejected. Audit events for trust grants and removals.
 *
 *   class SkillSelector
 *     Pure ranking. Filters by enabled/trusted/platform/sensitivity/HA,
 *     ranks remaining skills by BM25 over description, returns top-K.
 *
 *   interface SkillStorageAdapter
 *     The abstraction the registry binds to. InMemorySkillStorageAdapter
 *     ships here for tests; the runtime fs adapter lives in apps/cli.
 */

export { parseSkillFile, serializeSkillFile, SkillParseError } from "./parse.js";
export {
  SkillRegistry,
  SkillInstallError,
  type SkillRegistryOptions,
  type SkillTrustGrantEvent,
  type SkillAuditSink,
} from "./registry.js";
export { SkillSelector, type SkillSelectorResult } from "./selector.js";
export {
  type SkillStorageAdapter,
  type StoredSkill,
  InMemorySkillStorageAdapter,
} from "./storage.js";
export {
  NodeFsSkillStorageAdapter,
  resolveDirectorySkillSource,
  type NodeFsSkillStorageAdapterOptions,
} from "./fs-adapter.js";
export type {
  InstalledSkillIndexEntry,
  SkillRecord,
  SkillProvenanceStatus,
  SkillSelectionContext,
  SkillSelection,
  SkillFilterReason,
  SkillFilteredCandidate,
  SkillInstallSource,
} from "./types.js";
