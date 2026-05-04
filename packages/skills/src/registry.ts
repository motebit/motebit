/**
 * SkillRegistry — the install/list/enable/disable/remove/trust/untrust/verify
 * surface for skills. Wraps a `SkillStorageAdapter` with verification and
 * policy logic; emits an audit-event log for trust grants and removals.
 *
 * Install behavior is **permissive** per spec §10/§11 — install never
 * rejects an unsigned skill. Failed signature verification on a SIGNED
 * skill IS a hard reject (different from absent-signature). The provenance
 * gate lives in the selector, not in install.
 */

import {
  decodeSkillSignaturePublicKey,
  hexToBytes,
  verifySkillEnvelope,
  verifySkillEnvelopeDetailed,
} from "@motebit/crypto";
import type { SkillEnvelope, SkillSensitivity } from "@motebit/protocol";

import type {
  InstalledSkillIndexEntry,
  SkillInstallSource,
  SkillProvenanceStatus,
  SkillRecord,
} from "./types.js";
import type { SkillStorageAdapter, StoredSkill } from "./storage.js";

export class SkillInstallError extends Error {
  constructor(
    message: string,
    public readonly reason:
      | "duplicate_name"
      | "verification_failed"
      | "manifest_envelope_mismatch"
      | "size_limit_exceeded"
      | "malformed_source",
  ) {
    super(message);
    this.name = "SkillInstallError";
  }
}

/**
 * Operator-attested trust grant audit event. Emitted by `registry.trust()`,
 * `registry.untrust()`, and `registry.remove()`. Per spec §7.1, this is NOT
 * a cryptographic provenance act — it logs that the operator manually
 * attested to an unsigned skill at a point in time.
 */
export interface SkillTrustGrantEvent {
  type: "skill_trust_grant" | "skill_trust_revoke" | "skill_remove";
  skill_name: string;
  skill_version: string;
  content_hash: string;
  /** ISO 8601 timestamp. */
  at: string;
  /** Optional operator identity (motebit_id or did:key). The CLI passes its caller identity. */
  operator?: string;
}

/**
 * User-explicit consent acknowledgment for installing a sensitive-tier skill
 * on a weak-isolation surface (per `packages/skills/CLAUDE.md` rule 5). Per
 * spec §1, skills do not grant capability — this event records that the user
 * understood the install-time isolation trade-off, NOT that they granted the
 * skill any new permission. Auto-load against external AI providers stays
 * sensitivity-gated regardless (rule 2 + the runtime selector). The `surface`
 * tag distinguishes the install context (`web` vs `desktop-dev` vs future
 * `mobile`) so a downstream auditor can answer "did the user approve this on
 * a particular surface?" without conflating contexts.
 */
export interface SkillConsentGrantedEvent {
  type: "skill_consent_granted";
  skill_name: string;
  skill_version: string;
  content_hash: string;
  /** Sensitivity tier declared by the skill manifest. */
  sensitivity: SkillSensitivity;
  /** Surface identifier — `"web"`, `"desktop-dev"`, etc. */
  surface: string;
  /** ISO 8601 timestamp. */
  at: string;
  /** Optional operator identity. */
  operator?: string;
}

/**
 * Discriminated union of every audit event the registry emits. Existing
 * consumers (e.g. CLI) typed against `SkillTrustGrantEvent` continue to work
 * because their handler shape (`(event) => writeFileSync(... JSON.stringify(event))`)
 * accepts any union member structurally; new consumers should type against
 * `SkillAuditEvent` so a future event variant doesn't silently slip past.
 */
export type SkillAuditEvent = SkillTrustGrantEvent | SkillConsentGrantedEvent;

export type SkillAuditSink = (event: SkillAuditEvent) => void | Promise<void>;

export interface SkillRegistryOptions {
  /** Sink for audit events (`skill_trust_grant`, `skill_trust_revoke`, `skill_remove`). */
  audit?: SkillAuditSink;
  /** Maximum SKILL.md body size in bytes. Default 50 KB per spec §9. */
  maxBodyBytes?: number;
  /** Maximum total bytes across all auxiliary files. Default 11 MB (1 + 5 + 5) per spec §9. */
  maxAuxBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 50 * 1024;
const DEFAULT_MAX_AUX_BYTES = 11 * 1024 * 1024;

export class SkillRegistry {
  constructor(
    private readonly adapter: SkillStorageAdapter,
    private readonly options: SkillRegistryOptions = {},
  ) {}

  /**
   * Install a skill. Resolves the source to a {manifest, envelope, body, files}
   * tuple, verifies any signature, enforces size limits, then writes through
   * the storage adapter.
   *
   * @throws SkillInstallError on duplicate name, verification failure, or
   *   size/structural violations.
   */
  async install(
    source: SkillInstallSource,
    opts: { force?: boolean; source_label?: string } = {},
  ): Promise<{
    name: string;
    version: string;
    provenance_status: SkillProvenanceStatus;
  }> {
    if (source.kind !== "in_memory") {
      throw new SkillInstallError(
        `Install source kind \`${source.kind}\` is not implemented in BSL package; resolve via the fs adapter and pass an \`in_memory\` source.`,
        "malformed_source",
      );
    }

    const { manifest, envelope, body, files = {} } = source;

    if (manifest.name !== envelope.skill.name) {
      throw new SkillInstallError(
        `Manifest name \`${manifest.name}\` does not match envelope.skill.name \`${envelope.skill.name}\`.`,
        "manifest_envelope_mismatch",
      );
    }
    if (manifest.version !== envelope.skill.version) {
      throw new SkillInstallError(
        `Manifest version \`${manifest.version}\` does not match envelope.skill.version \`${envelope.skill.version}\`.`,
        "manifest_envelope_mismatch",
      );
    }

    const maxBody = this.options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    if (body.length > maxBody) {
      throw new SkillInstallError(
        `SKILL.md body is ${body.length} bytes; limit is ${maxBody}. Increase via skills.limits or trim the body.`,
        "size_limit_exceeded",
      );
    }

    const maxAux = this.options.maxAuxBytes ?? DEFAULT_MAX_AUX_BYTES;
    const auxTotal = Object.values(files).reduce((acc, b) => acc + b.length, 0);
    if (auxTotal > maxAux) {
      throw new SkillInstallError(
        `Auxiliary files total ${auxTotal} bytes; limit is ${maxAux}.`,
        "size_limit_exceeded",
      );
    }

    const existing = await this.adapter.read(manifest.name);
    if (existing && !opts.force) {
      throw new SkillInstallError(
        `Skill \`${manifest.name}\` is already installed at version ${existing.index.version}. Pass --force to overwrite.`,
        "duplicate_name",
      );
    }

    const provenance = await deriveProvenance(envelope);
    if (provenance === "unverified") {
      throw new SkillInstallError(
        `Signature verification failed for skill \`${manifest.name}\`. The signature block is present but verification failed; this is a hard reject (per spec §10). An unsigned skill (no signature block) installs permissively; a tampered signed skill does not.`,
        "verification_failed",
      );
    }

    const indexEntry: InstalledSkillIndexEntry = {
      name: manifest.name,
      version: manifest.version,
      enabled: true,
      trusted: false, // operator must explicitly trust unsigned skills
      installed_at: new Date().toISOString(),
      source: opts.source_label ?? "in_memory",
      content_hash: envelope.skill.content_hash,
    };

    const stored: StoredSkill = { index: indexEntry, manifest, envelope, body, files };
    await this.adapter.write(stored);

    return {
      name: manifest.name,
      version: manifest.version,
      provenance_status: provenance,
    };
  }

  /** List installed skills with current provenance status (re-derived from envelope). */
  async list(): Promise<SkillRecord[]> {
    const entries = await this.adapter.list();
    const records: SkillRecord[] = [];
    for (const entry of entries) {
      const stored = await this.adapter.read(entry.name);
      if (!stored) continue;
      records.push({
        index: stored.index,
        manifest: stored.manifest,
        envelope: stored.envelope,
        body: stored.body,
        files: stored.files,
        provenance_status: await derivedStatusForEntry(stored.envelope, stored.index),
      });
    }
    return records;
  }

  async get(name: string): Promise<SkillRecord | null> {
    const stored = await this.adapter.read(name);
    if (!stored) return null;
    return {
      index: stored.index,
      manifest: stored.manifest,
      envelope: stored.envelope,
      body: stored.body,
      files: stored.files,
      provenance_status: await derivedStatusForEntry(stored.envelope, stored.index),
    };
  }

  async enable(name: string): Promise<void> {
    await this.adapter.setEnabled(name, true);
  }

  async disable(name: string): Promise<void> {
    await this.adapter.setEnabled(name, false);
  }

  /** Operator-attested trust grant for an unsigned skill. Emits an audit event. */
  async trust(name: string, operator?: string): Promise<void> {
    const stored = await this.adapter.read(name);
    if (!stored) return;
    await this.adapter.setTrusted(name, true);
    await this.options.audit?.({
      type: "skill_trust_grant",
      skill_name: stored.index.name,
      skill_version: stored.index.version,
      content_hash: stored.index.content_hash,
      at: new Date().toISOString(),
      operator,
    });
  }

  async untrust(name: string, operator?: string): Promise<void> {
    const stored = await this.adapter.read(name);
    if (!stored) return;
    await this.adapter.setTrusted(name, false);
    await this.options.audit?.({
      type: "skill_trust_revoke",
      skill_name: stored.index.name,
      skill_version: stored.index.version,
      content_hash: stored.index.content_hash,
      at: new Date().toISOString(),
      operator,
    });
  }

  /** Remove a skill. Emits a `skill_remove` audit event (the deletion certificate per spec §1). */
  async remove(name: string, operator?: string): Promise<void> {
    const stored = await this.adapter.read(name);
    if (!stored) return;
    await this.adapter.remove(name);
    await this.options.audit?.({
      type: "skill_remove",
      skill_name: stored.index.name,
      skill_version: stored.index.version,
      content_hash: stored.index.content_hash,
      at: new Date().toISOString(),
      operator,
    });
  }

  /** Re-verify the envelope signature against its embedded public key. */
  async verify(name: string): Promise<SkillProvenanceStatus | "not_installed"> {
    const stored = await this.adapter.read(name);
    if (!stored) return "not_installed";
    return derivedStatusForEntry(stored.envelope, stored.index);
  }
}

// ---------------------------------------------------------------------------
// Provenance derivation
// ---------------------------------------------------------------------------

/**
 * Derive the provenance status of a freshly-installed envelope. The
 * envelope's signature MUST verify against the embedded `public_key`; a
 * tampered envelope claiming a real signer is rejected here. An envelope
 * with no `signature` block is structurally invalid (the SkillSignature
 * type requires it) — that case never reaches this function.
 */
async function deriveProvenance(envelope: SkillEnvelope): Promise<SkillProvenanceStatus> {
  // The envelope schema requires `signature`. If we got here, signature is
  // structurally present. Verify against its embedded public key.
  const publicKey = decodeSkillSignaturePublicKey(envelope.signature);
  const ok = await verifySkillEnvelope(envelope, publicKey);
  if (ok) return "verified";

  // Signature block present but verify failed. Caller treats this as
  // hard-reject at install time. We return `unverified` so the install
  // pipeline can throw with the right reason.
  const detail = await verifySkillEnvelopeDetailed(envelope, publicKey);
  if (detail.reason === "wrong_suite" || detail.reason === "ed25519_mismatch") {
    return "unverified";
  }
  return "unverified";
}

/**
 * Status surfaced for a stored skill. Cross-references the registry's
 * `trusted` flag (operator promotion) with re-verification of the envelope.
 */
async function derivedStatusForEntry(
  envelope: SkillEnvelope,
  index: InstalledSkillIndexEntry,
): Promise<SkillProvenanceStatus> {
  const baseline = await deriveProvenance(envelope);
  if (baseline === "verified") return "verified";
  if (baseline === "unverified") return "unverified";
  // baseline shouldn't be "unsigned" or "trusted_unsigned" here; deriveProvenance
  // never returns those. Defensive default.
  if (index.trusted) return "trusted_unsigned";
  return "unsigned";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Re-export so consumers don't need a second import for the helper.
export { hexToBytes };
