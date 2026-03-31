/**
 * @motebit/identity-file — Generate, parse, verify, and update motebit.md
 *
 * A motebit.md is a human-readable, cryptographically signed agent identity file.
 * The YAML frontmatter contains the identity spec; the Ed25519 signature covers
 * the exact frontmatter bytes for tamper detection.
 *
 * Parsing and verification are delegated to @motebit/verify (the standalone,
 * zero-monorepo-dep public verifier). This package adds generation, update,
 * YAML serialization, and risk-level bridging on top.
 */

import { sign as ed25519Sign, toBase64Url, bytesToHex } from "@motebit/crypto";
export { publicKeyToDidKey, hexPublicKeyToDidKey } from "@motebit/crypto";
import { RiskLevel } from "@motebit/sdk";
import { parse, verify, verifyIdentityFile } from "@motebit/verify";
import type { MotebitIdentityFile, MotebitIdentityType } from "./schema.js";

// Re-export parse/verify from @motebit/verify
export { parse, verify, verifyIdentityFile };
export type { VerifyResult, LegacyVerifyResult } from "@motebit/verify";
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

// --- Signature Format ---

const SIG_PREFIX = "<!-- motebit:sig:Ed25519:";
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
    data.guardian = opts.guardian;
  }

  const yaml = serializeYaml(data);
  const frontmatter = `---\n${yaml}\n---`;
  const frontmatterBytes = new TextEncoder().encode(yaml);
  const signature = await ed25519Sign(frontmatterBytes, privateKey);
  const sigB64 = toBase64Url(signature);

  return `${frontmatter}\n${SIG_PREFIX}${sigB64}${SIG_SUFFIX}\n`;
}

export type ParseResult = ReturnType<typeof parse>;

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
  const sigB64 = toBase64Url(signature);

  return `${frontmatter}\n${SIG_PREFIX}${sigB64}${SIG_SUFFIX}\n`;
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

  // Append succession record to existing chain (or create new chain)
  const existingChain = data.succession ?? [];
  data.succession = [...existingChain, opts.successionRecord];

  const yaml = serializeYaml(data);
  const frontmatter = `---\n${yaml}\n---`;
  const frontmatterBytes = new TextEncoder().encode(yaml);
  const signature = await ed25519Sign(frontmatterBytes, opts.newPrivateKey);
  const sigB64 = toBase64Url(signature);

  return `${frontmatter}\n${SIG_PREFIX}${sigB64}${SIG_SUFFIX}\n`;
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
