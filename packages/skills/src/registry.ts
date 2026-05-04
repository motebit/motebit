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
  verifySkillManifest,
} from "@motebit/crypto";
import type { SkillEnvelope, SkillManifest, SkillSensitivity } from "@motebit/protocol";

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

    const provenance = await deriveProvenance(envelope, manifest, body);
    if (provenance === "unverified") {
      throw new SkillInstallError(
        `Signature verification failed for skill \`${manifest.name}\`. Either the envelope signature failed verification (distribution integrity), or the manifest's \`motebit.signature\` block is present but its verification failed (authorial provenance). This is a hard reject per spec §10. An unsigned skill (manifest \`motebit.signature\` absent) installs permissively as \`unsigned\`; a tampered signed skill does not.`,
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
        provenance_status: await derivedStatusForEntry(
          stored.envelope,
          stored.manifest,
          stored.body,
          stored.index,
        ),
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
      provenance_status: await derivedStatusForEntry(
        stored.envelope,
        stored.manifest,
        stored.body,
        stored.index,
      ),
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

  /**
   * Re-verify both signatures (envelope + manifest) and cross-reference
   * the trust flag, returning the canonical four-state provenance status
   * per spec §7.1. `"not_installed"` is the no-such-skill discriminator.
   */
  async verify(name: string): Promise<SkillProvenanceStatus | "not_installed"> {
    const stored = await this.adapter.read(name);
    if (!stored) return "not_installed";
    return derivedStatusForEntry(stored.envelope, stored.manifest, stored.body, stored.index);
  }
}

// ---------------------------------------------------------------------------
// Provenance derivation
// ---------------------------------------------------------------------------

/**
 * Derive the provenance status of a freshly-installed skill. Two signatures
 * cooperate per `spec/skills-v1.md` §7.1; the registry checks both.
 *
 * **Envelope signature** — distribution integrity. Always required (the
 * envelope schema mandates `signature`). MUST verify against its embedded
 * public key; a tampered envelope claiming a real signer is rejected
 * here, which the install pipeline turns into a hard `verification_failed`
 * reject. The envelope answers "did the relay get the bytes the publisher
 * sent?" — it does NOT establish authorial provenance, only chain-of-
 * custody integrity.
 *
 * **Manifest signature** — authorial provenance. Optional per
 * `manifest.motebit.signature`. The four-way state surfaced to the
 * selector and to UIs:
 *   - `"verified"` — manifest sig present AND verifies. Auto-loadable.
 *   - `"unsigned"` — manifest sig absent. NEVER auto-loaded by the
 *     selector; an operator MAY promote via `registry.trust(name)`,
 *     which flips `index.trusted` and `derivedStatusForEntry` reports
 *     `"trusted_unsigned"` thereafter.
 *   - `"unverified"` — manifest sig present but verify failed. Hard-
 *     reject at install (the install pipeline throws); never reaches
 *     stored state, but the union arm is preserved for retroactive
 *     queries against potentially-corrupted historical entries.
 *
 * Pre-fix this function checked only the envelope signature, so every
 * successful install collapsed to `"verified"` regardless of authorial
 * provenance — the `"unsigned"` and `"trusted_unsigned"` arms were dead
 * code. Closing that gap is load-bearing for federation (peer-to-peer
 * skill exchange must distinguish "this came from a trusted relay" from
 * "the named author signed this"); for the marketplace (third-party
 * authors with their own reputation); and for the consent gate's audit
 * trail (recording approval against a misleading "verified" signal
 * would be operator-transparency-violating).
 */
async function deriveProvenance(
  envelope: SkillEnvelope,
  manifest: SkillManifest,
  body: Uint8Array,
): Promise<SkillProvenanceStatus> {
  // Envelope sig must verify (distribution integrity precondition).
  // Caller wraps any failure as `verification_failed` install error.
  const envelopeKey = decodeSkillSignaturePublicKey(envelope.signature);
  if (!(await verifySkillEnvelope(envelope, envelopeKey))) {
    return "unverified";
  }
  // Manifest sig determines authorial provenance.
  const manifestSig = manifest.motebit.signature;
  if (manifestSig === undefined) return "unsigned";
  const manifestKey = decodeSkillSignaturePublicKey(manifestSig);
  return (await verifySkillManifest(manifest, body, manifestKey)) ? "verified" : "unverified";
}

/**
 * Status surfaced for a stored skill. Cross-references the registry's
 * `index.trusted` flag (operator-attested promotion via `registry.trust()`)
 * with the envelope+manifest verify pair.
 *
 * The four reachable terminal states (now that `deriveProvenance` honors
 * both signatures):
 *   - `"verified"` — manifest sig present + verifies. Auto-loadable.
 *   - `"unverified"` — manifest sig present + fails. Should not appear
 *     for installed skills (install rejects), but possible for
 *     historical entries if the manifest mutated post-install.
 *   - `"unsigned"` — manifest sig absent, operator hasn't promoted.
 *     Selector blocks auto-load; trust button shown in panel UIs.
 *   - `"trusted_unsigned"` — manifest sig absent BUT operator manually
 *     attested via `registry.trust()`. Auto-loadable; surfaces always
 *     display the `[unverified]` qualifier per spec §7.1 (trust grants
 *     are audit events, not cryptographic provenance).
 */
async function derivedStatusForEntry(
  envelope: SkillEnvelope,
  manifest: SkillManifest,
  body: Uint8Array,
  index: InstalledSkillIndexEntry,
): Promise<SkillProvenanceStatus> {
  const baseline = await deriveProvenance(envelope, manifest, body);
  if (baseline === "verified") return "verified";
  if (baseline === "unverified") return "unverified";
  // baseline === "unsigned" — operator may have promoted via trust()
  return index.trusted ? "trusted_unsigned" : "unsigned";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Re-export so consumers don't need a second import for the helper.
export { hexToBytes };
