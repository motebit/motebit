/**
 * @motebit/identity-file — Generate, parse, verify, and update motebit.md
 *
 * A motebit.md is a human-readable, cryptographically signed agent identity file.
 * The YAML frontmatter contains the identity spec; the Ed25519 signature covers
 * the exact frontmatter bytes for tamper detection.
 *
 * Parsing and verification are delegated to @motebit/crypto (the standalone,
 * zero-monorepo-dep public verifier). This package adds generation, update,
 * YAML serialization, and risk-level bridging on top.
 */

import { sign as ed25519Sign, bytesToHex, canonicalJson } from "@motebit/encryption";
export { publicKeyToDidKey, hexPublicKeyToDidKey } from "@motebit/encryption";
import { RiskLevel } from "@motebit/sdk";
import { parse, verify } from "@motebit/crypto";
import type { MotebitIdentityFile, MotebitIdentityType } from "./schema.js";

// Re-export parse/verify from @motebit/crypto
export { parse, verify };
export type { VerifyResult } from "@motebit/crypto";
export type { MotebitIdentityFile, MotebitIdentityType } from "./schema.js";

// --- YAML Serialization (hand-rolled for the flat/predictable schema) ---

function indent(level: number): string {
  return "  ".repeat(level);
}

function serializeValue(value: unknown, level: number): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const lines: string[] = [];
    for (const item of value) {
      if (typeof item === "object" && item !== null) {
        const entries = Object.entries(item as Record<string, unknown>);
        const first = entries[0];
        const rest = entries.slice(1);
        if (first) {
          lines.push(`${indent(level)}- ${first[0]}: ${serializeValue(first[1], level + 2)}`);
          for (const [k, v] of rest) {
            lines.push(`${indent(level)}  ${k}: ${serializeValue(v, level + 2)}`);
          }
        }
      } else {
        lines.push(`${indent(level)}- ${serializeValue(item, level + 1)}`);
      }
    }
    return "\n" + lines.join("\n");
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const lines: string[] = [];
    for (const [k, v] of entries) {
      const serialized = serializeValue(v, level + 1);
      if (
        typeof v === "object" &&
        v !== null &&
        !Array.isArray(v) &&
        Object.keys(v as Record<string, unknown>).length > 0
      ) {
        lines.push(`${indent(level)}${k}:`);
        lines.push(serialized.replace(/^\n/, ""));
      } else if (Array.isArray(v) && v.length > 0) {
        lines.push(`${indent(level)}${k}:${serialized}`);
      } else {
        lines.push(`${indent(level)}${k}: ${serialized}`);
      }
    }
    return "\n" + lines.join("\n");
  }

  return String(value as string | number | boolean | bigint | symbol);
}

function serializeYaml(data: MotebitIdentityFile): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(data)) {
    const serialized = serializeValue(value, 1);
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value as Record<string, unknown>).length > 0
    ) {
      lines.push(`${key}:`);
      lines.push(serialized.replace(/^\n/, ""));
    } else if (Array.isArray(value) && value.length > 0) {
      lines.push(`${key}:${serialized}`);
    } else {
      lines.push(`${key}: ${serialized}`);
    }
  }

  return lines.join("\n");
}

// --- Signature Format (cryptosuite-agility) ---
//
// Identity-file signatures declare the cryptosuite in the comment
// prefix: `<!-- motebit:sig:{suite_id}:{hex_signature} -->`. Today
// every identity file is signed under `motebit-jcs-ed25519-hex-v1`
// (hex-encoded signature over JCS-canonicalized frontmatter bytes).
// Legacy `motebit:sig:Ed25519:` comments are rejected fail-closed by
// `@motebit/crypto`.

const IDENTITY_FILE_SUITE = "motebit-jcs-ed25519-hex-v1" as const;
const SIG_PREFIX = `<!-- motebit:sig:${IDENTITY_FILE_SUITE}:`;
const SIG_SUFFIX = " -->";

// --- Public API ---

export interface ServiceIdentityOptions {
  type?: MotebitIdentityType;
  service_name?: string;
  service_description?: string;
  service_url?: string;
  capabilities?: string[];
  terms_url?: string;
}

export interface GenerateOptions {
  motebitId: string;
  createdAt?: string;
  ownerId: string;
  publicKeyHex: string;
  governance?: Partial<MotebitIdentityFile["governance"]>;
  privacy?: Partial<MotebitIdentityFile["privacy"]>;
  memory?: Partial<MotebitIdentityFile["memory"]>;
  devices?: MotebitIdentityFile["devices"];
  service?: ServiceIdentityOptions;
  guardian?: MotebitIdentityFile["guardian"];
  /** Guardian's Ed25519 private key — used to sign attestation, NOT stored. */
  guardianPrivateKey?: Uint8Array;
}

export async function generate(opts: GenerateOptions, privateKey: Uint8Array): Promise<string> {
  // Build service fields conditionally
  const serviceFields: Partial<
    Pick<
      MotebitIdentityFile,
      "type" | "service_name" | "service_description" | "service_url" | "capabilities" | "terms_url"
    >
  > = {};
  if (opts.service) {
    if (opts.service.type) serviceFields.type = opts.service.type;
    if (opts.service.service_name) serviceFields.service_name = opts.service.service_name;
    if (opts.service.service_description)
      serviceFields.service_description = opts.service.service_description;
    if (opts.service.service_url) serviceFields.service_url = opts.service.service_url;
    if (opts.service.capabilities && opts.service.capabilities.length > 0)
      serviceFields.capabilities = opts.service.capabilities;
    if (opts.service.terms_url) serviceFields.terms_url = opts.service.terms_url;
  }

  const data: MotebitIdentityFile = {
    spec: "motebit/identity@1.0",
    motebit_id: opts.motebitId,
    created_at: opts.createdAt ?? new Date().toISOString(),
    owner_id: opts.ownerId,
    ...serviceFields,
    identity: {
      algorithm: "Ed25519",
      public_key: opts.publicKeyHex,
    },
    governance: {
      trust_mode: opts.governance?.trust_mode ?? "guarded",
      max_risk_auto: opts.governance?.max_risk_auto ?? "R1_DRAFT",
      require_approval_above: opts.governance?.require_approval_above ?? "R1_DRAFT",
      deny_above: opts.governance?.deny_above ?? "R4_MONEY",
      operator_mode: opts.governance?.operator_mode ?? false,
    },
    privacy: {
      default_sensitivity: opts.privacy?.default_sensitivity ?? "personal",
      retention_days: opts.privacy?.retention_days ?? {
        none: 365,
        personal: 90,
        medical: 30,
        financial: 30,
        secret: 7,
      },
      fail_closed: opts.privacy?.fail_closed ?? true,
    },
    memory: {
      half_life_days: opts.memory?.half_life_days ?? 7,
      confidence_threshold: opts.memory?.confidence_threshold ?? 0.3,
      per_turn_limit: opts.memory?.per_turn_limit ?? 5,
    },
    devices: opts.devices ?? [],
  };

  if (opts.guardian) {
    // §3.3: Guardian key MUST NOT equal identity key
    if (opts.guardian.public_key === opts.publicKeyHex) {
      throw new Error("Guardian public key must not equal identity public key");
    }
    const guardianField = { ...opts.guardian };
    // Sign guardian attestation if private key provided
    if (opts.guardianPrivateKey) {
      const attestPayload = canonicalJson({
        action: "guardian_attestation",
        guardian_public_key: opts.guardian.public_key,
        motebit_id: opts.motebitId,
      });
      const attestSig = await ed25519Sign(
        new TextEncoder().encode(attestPayload),
        opts.guardianPrivateKey,
      );
      guardianField.attestation = bytesToHex(attestSig);
    }
    data.guardian = guardianField;
  }

  const yaml = serializeYaml(data);
  const frontmatter = `---\n${yaml}\n---`;
  const frontmatterBytes = new TextEncoder().encode(yaml);
  const signature = await ed25519Sign(frontmatterBytes, privateKey);
  const sigHex = bytesToHex(signature);

  return `${frontmatter}\n${SIG_PREFIX}${sigHex}${SIG_SUFFIX}\n`;
}

export type ParseResult = ReturnType<typeof parse>;

// --- Import (parse + verify + flat metadata reshape) ---
//
// `importIdentityFile` is the canonical primitive for the restore-from-
// motebit.md flow on every surface. Three things in one call:
//
//   1. Parse the YAML frontmatter via `parse()`. Surfaces a structural-
//      malformation reason on failure.
//   2. Verify the Ed25519 signature chain via `verify()`. Surfaces a
//      cryptographic-failure reason on invalid signature, missing
//      cryptosuite, succession-chain break, etc.
//   3. Reshape the validated `MotebitIdentityFile` into a flat
//      `ImportedIdentityMetadata` that maps cleanly onto what a Restore
//      flow actually consumes: `bornAt` (the original creation date
//      `created_at` for the IdentityCreated event re-issuance),
//      `publicKey` (the guard rail — the user's pasted recovery seed
//      must derive the same public key), `devices` (so device-list
//      state survives the restore), `governance` + `memory` (so policy
//      bounds restore from the file's declared values, not surface
//      defaults).
//
// Note: motebit.md is structurally a *public* artifact — it contains
// only the public key, never the private key. The Restore UI requires
// a separate recovery-seed paste to materialize the keypair; this
// importer does NOT and CAN NOT recover a private key from the file
// alone.

export interface ImportedIdentityMetadata {
  motebitId: string;
  publicKey: string;
  ownerId: string;
  bornAt: string;
  devices: MotebitIdentityFile["devices"];
  governance: MotebitIdentityFile["governance"];
  memory: MotebitIdentityFile["memory"];
}

export type ImportIdentityResult =
  | { valid: true; metadata: ImportedIdentityMetadata }
  | { valid: false; reason: string };

// --- Restore (the side-effecting flow that materializes an imported
//     identity onto a device) ---
//
// `restoreIdentity` is the per-surface side-effecting counterpart to
// `importIdentityFile` (pure read). The two compose:
//
//   1. UI gathers the file content + recovery seed paste.
//   2. `importIdentityFile(content)` validates the .md and returns
//      `metadata`.
//   3. UI derives the keypair from the seed, checks the derived public
//      key matches `metadata.publicKey` (the guard rail).
//   4. UI calls `WebApp.restoreIdentity` / `DesktopApp.restoreIdentity` /
//      `MobileApp.restoreIdentity` with `{ privateKeyHex, metadata,
//      preserveMemories }`.
//   5. On `{ ok: true, needsReload }` the UI reloads the surface so
//      bootstrap picks up the restored identity from the new keystore +
//      config state.
//
// The type lives in this package alongside `ImportIdentityResult` so
// every surface consumes one contract. The implementation is per-surface
// because each surface owns its own keystore (web IDB, desktop OS keyring
// via Tauri IPC, mobile Expo SecureStore) and its own identity-config
// store (web localStorage, desktop Tauri config file, mobile SecureStore).

export interface RestoreIdentityRequest {
  /** The 64-hex-char Ed25519 private key the recovery seed pasted into. */
  privateKeyHex: string;
  /**
   * Identity metadata to restore. For motebit.md restore, this is the
   * `metadata` field from a successful `importIdentityFile(content)`
   * call. For seed-only restore (commit 4), the caller synthesizes a
   * minimal metadata with the derived public key + a generated
   * motebit_id (the seed alone cannot recover the original motebit_id;
   * the relay-side mapping does, but that's a relay-mediated path).
   */
  metadata: ImportedIdentityMetadata;
  /**
   * Original signed motebit.md content, verbatim. When provided
   * (motebit.md-restore path), the surface writes this to its
   * `_identity_file`-equivalent slot so the next bootstrap reads the
   * original governance fields with their cryptographic anchor intact.
   * Omit for seed-only restore (commit 4) — the caller has no original
   * .md and bootstrap regenerates one from the in-memory metadata on
   * next launch.
   */
  originalContent?: string;
  /**
   * Per the design call captured in [[identity_restore_arc]] §"Design
   * decisions": default is clear (no preserve). Setting `true` is
   * surfaced in the UI as opt-in with the explicit "Severs cryptographic
   * chain to original signing identity" trade-off label. The preserve
   * path re-keys existing conversation / memory / plan / agent-trust
   * rows from the old motebit_id to the new one — shipped 2026-05-15
   * via per-surface migrations (`migrateMotebitId` in
   * `@motebit/browser-persistence` for web IDB; `migrateMotebitIdSql`
   * in `apps/desktop/src/tauri-storage.ts` for desktop SQLite;
   * `migrateMotebitIdExpo` in `apps/mobile/src/adapters/expo-sqlite.ts`
   * for mobile expo-sqlite). The `preserve_not_implemented` typed
   * reason stays in the union as defense-in-depth for surfaces (CLI,
   * future) that haven't shipped a migration; each surface handles
   * the flag locally rather than gating at this package level.
   */
  preserveMemories: boolean;
}

export type RestoreIdentityResult =
  | { ok: true; motebitId: string; needsReload: true }
  | { ok: false; reason: RestoreIdentityFailureReason };

export type RestoreIdentityFailureReason =
  | "invalid_private_key_length"
  | "invalid_private_key_hex"
  | "key_mismatch"
  | "preserve_not_implemented"
  | "memory_migration_failed"
  | "keystore_write_failed"
  | "config_write_failed";

/**
 * Validate the request shape and the cryptographic guard (does the
 * caller's private key derive the public key the metadata declares?).
 * Surface-level `restoreIdentity` methods call this before any
 * side-effecting write, so the failure modes are uniform across web /
 * desktop / mobile.
 *
 * Returns `null` on success or a typed reason on failure. Callers that
 * fail still need to ensure no partial state was written (this helper
 * does not mutate anything).
 */
export async function validateRestoreRequest(
  request: RestoreIdentityRequest,
): Promise<RestoreIdentityFailureReason | null> {
  if (request.privateKeyHex.length !== 64) return "invalid_private_key_length";
  if (!/^[0-9a-fA-F]+$/.test(request.privateKeyHex)) return "invalid_private_key_hex";

  // Derive the public key from the private key under the identity-file
  // cryptosuite (Ed25519). Suite-dispatch is the only call site
  // permitted to reach @noble/ed25519 directly (@motebit/crypto rule 1).
  const { hexToBytes, bytesToHex, getPublicKeyBySuite } = await import("@motebit/encryption");
  const privBytes = hexToBytes(request.privateKeyHex);
  const pubBytes = await getPublicKeyBySuite(privBytes, IDENTITY_FILE_SUITE);
  const derivedPubHex = bytesToHex(pubBytes);

  if (derivedPubHex.toLowerCase() !== request.metadata.publicKey.toLowerCase()) {
    return "key_mismatch";
  }
  // `preserve_not_implemented` was previously returned here as a
  // package-level gate so all three surfaces refused
  // `preserveMemories=true` until the migration shipped. The gate
  // is no longer global: each surface that has implemented the
  // re-key migration (web: `migrateMotebitId` in
  // `@motebit/browser-persistence`; desktop: SQLite UPDATEs via
  // Tauri; mobile: expo-sqlite UPDATEs) handles the flag locally.
  // Surfaces that have NOT implemented it still need to return
  // `preserve_not_implemented` from their own `restoreIdentity`
  // body as defense in depth; the typed-reason stays in the union
  // because some future consumer (e.g. CLI) might still need it.
  return null;
}

export async function importIdentityFile(content: string): Promise<ImportIdentityResult> {
  try {
    parse(content);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    return { valid: false, reason: `parse failed: ${reason}` };
  }
  const result = await verify(content, { expectedType: "identity" });
  if (result.type !== "identity" || !result.valid || result.identity === null) {
    const reason =
      result.errors?.[0]?.message ??
      ("error" in result && typeof result.error === "string"
        ? result.error
        : "signature verification failed");
    return { valid: false, reason };
  }
  const fm = result.identity;
  return {
    valid: true,
    metadata: {
      motebitId: fm.motebit_id,
      publicKey: fm.identity.public_key,
      ownerId: fm.owner_id,
      bornAt: fm.created_at,
      devices: fm.devices,
      governance: fm.governance,
      memory: fm.memory,
    },
  };
}

export async function update(
  existingContent: string,
  updates: Partial<Omit<MotebitIdentityFile, "spec" | "identity">>,
  privateKey: Uint8Array,
): Promise<string> {
  const parsed = parse(existingContent);
  const data = { ...parsed.frontmatter, ...updates };

  // Preserve identity and spec
  data.spec = parsed.frontmatter.spec;
  data.identity = parsed.frontmatter.identity;

  const yaml = serializeYaml(data as MotebitIdentityFile);
  const frontmatter = `---\n${yaml}\n---`;
  const frontmatterBytes = new TextEncoder().encode(yaml);
  const signature = await ed25519Sign(frontmatterBytes, privateKey);
  const sigHex = bytesToHex(signature);

  return `${frontmatter}\n${SIG_PREFIX}${sigHex}${SIG_SUFFIX}\n`;
}

export interface RotateOptions {
  existingContent: string;
  newPublicKey: Uint8Array;
  newPrivateKey: Uint8Array;
  successionRecord: {
    old_public_key: string;
    new_public_key: string;
    timestamp: number;
    reason?: string;
    /**
     * Cryptosuite discriminator. Optional to maintain backward
     * compatibility on the input surface — the rotator stamps the
     * identity-file suite (`motebit-jcs-ed25519-hex-v1`) when omitted.
     */
    suite?: "motebit-jcs-ed25519-hex-v1";
    old_key_signature?: string;
    new_key_signature: string;
    recovery?: boolean;
    guardian_signature?: string;
  };
}

/**
 * Rotate the key in an identity file: update the public key, append the
 * succession record, and re-sign with the new private key.
 */
export async function rotate(opts: RotateOptions): Promise<string> {
  const parsed = parse(opts.existingContent);
  const data = { ...parsed.frontmatter } as MotebitIdentityFile;

  // Update the public key to the new one
  data.identity = {
    algorithm: "Ed25519",
    public_key: bytesToHex(opts.newPublicKey),
  };

  // Append succession record to existing chain (or create new chain).
  // Stamp the identity-file cryptosuite if the caller didn't already.
  const stampedRecord = {
    ...opts.successionRecord,
    suite: opts.successionRecord.suite ?? IDENTITY_FILE_SUITE,
  };
  const existingChain = data.succession ?? [];
  data.succession = [...existingChain, stampedRecord];

  const yaml = serializeYaml(data);
  const frontmatter = `---\n${yaml}\n---`;
  const frontmatterBytes = new TextEncoder().encode(yaml);
  const signature = await ed25519Sign(frontmatterBytes, opts.newPrivateKey);
  const sigHex = bytesToHex(signature);

  return `${frontmatter}\n${SIG_PREFIX}${sigHex}${SIG_SUFFIX}\n`;
}

// --- Helpers ---

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --- Risk Level Bridge ---

const RISK_MAP: Record<string, RiskLevel> = {
  R0_READ: RiskLevel.R0_READ,
  R1_DRAFT: RiskLevel.R1_DRAFT,
  R2_WRITE: RiskLevel.R2_WRITE,
  R3_EXECUTE: RiskLevel.R3_EXECUTE,
  R4_MONEY: RiskLevel.R4_MONEY,
};

export function parseRiskLevel(name: string): RiskLevel {
  const level = RISK_MAP[name];
  if (level === undefined) {
    const valid = Object.keys(RISK_MAP).join(", ");
    throw new Error(`Unknown risk level "${name}". Valid values: ${valid}`);
  }
  return level;
}

export interface GovernancePolicyConfig {
  operatorMode: boolean;
  maxRiskAuto: RiskLevel;
  requireApprovalAbove: RiskLevel;
  denyAbove: RiskLevel;
  approvalQuorum?: {
    threshold: number;
    approvers: string[];
    risk_floor?: string;
  };
}

export function governanceToPolicyConfig(
  gov: MotebitIdentityFile["governance"],
): GovernancePolicyConfig {
  return {
    operatorMode: gov.operator_mode,
    maxRiskAuto: parseRiskLevel(gov.max_risk_auto),
    requireApprovalAbove: parseRiskLevel(gov.require_approval_above),
    denyAbove: parseRiskLevel(gov.deny_above),
    ...(gov.approval_quorum ? { approvalQuorum: gov.approval_quorum } : {}),
  };
}
