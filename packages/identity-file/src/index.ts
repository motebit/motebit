/**
 * @motebit/identity-file — Generate, parse, verify, and update motebit.md
 *
 * A motebit.md is a human-readable, cryptographically signed agent identity file.
 * The YAML frontmatter contains the identity spec; the Ed25519 signature covers
 * the exact frontmatter bytes for tamper detection.
 */

import {
  sign as ed25519Sign,
  verify as ed25519Verify,
  toBase64Url,
  fromBase64Url,
} from "@motebit/crypto";
import { RiskLevel } from "@motebit/sdk";
import type { MotebitIdentityFile } from "./schema.js";

export type { MotebitIdentityFile } from "./schema.js";

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
      if (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v as Record<string, unknown>).length > 0) {
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

  return String(value);
}

function serializeYaml(data: MotebitIdentityFile): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(data)) {
    const serialized = serializeValue(value, 1);
    if (typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length > 0) {
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

// --- YAML Parsing (minimal, handles the identity file schema) ---

function parseYamlValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "[]") return [];
  if (trimmed === "{}") return ({});

  // Quoted string
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return JSON.parse(trimmed);
  }

  // Number
  const num = Number(trimmed);
  if (trimmed !== "" && !isNaN(num) && isFinite(num)) return num;

  // Unquoted string
  return trimmed;
}

function parseYaml(text: string): MotebitIdentityFile {
  const lines = text.split("\n");
  const root: Record<string, unknown> = {};
  const stack: Array<{ obj: Record<string, unknown>; indent: number }> = [{ obj: root, indent: -1 }];
  let currentArray: unknown[] | null = null;
  let currentArrayIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;

    const lineIndent = line.length - line.trimStart().length;
    const trimmed = line.trimStart();

    // Array item
    if (trimmed.startsWith("- ")) {
      const itemContent = trimmed.slice(2);
      const colonIdx = itemContent.indexOf(": ");

      if (colonIdx !== -1) {
        // Object item in array
        const obj: Record<string, unknown> = {};
        const key = itemContent.slice(0, colonIdx);
        const val = itemContent.slice(colonIdx + 2);
        obj[key] = parseYamlValue(val);

        // Peek ahead for continuation fields of this array object
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j]!;
          if (nextLine.trim() === "") continue;
          const nextIndent = nextLine.length - nextLine.trimStart().length;
          const nextTrimmed = nextLine.trimStart();

          // Same-level fields that are not array items
          if (nextIndent > lineIndent && !nextTrimmed.startsWith("- ")) {
            const nextColonIdx = nextTrimmed.indexOf(": ");
            if (nextColonIdx !== -1) {
              const nk = nextTrimmed.slice(0, nextColonIdx);
              const nv = nextTrimmed.slice(nextColonIdx + 2);
              obj[nk] = parseYamlValue(nv);
              i = j;
            }
          } else {
            break;
          }
        }

        if (currentArray) {
          currentArray.push(obj);
        }
      } else {
        if (currentArray) {
          currentArray.push(parseYamlValue(itemContent));
        }
      }
      continue;
    }

    // Key-value or map key
    const colonIdx = trimmed.indexOf(": ");
    const endsWithColon = trimmed.endsWith(":") && colonIdx === -1;

    if (endsWithColon) {
      // Map key — peek ahead to determine if it's an array or nested object
      const key = trimmed.slice(0, -1);

      // Close current array if we've de-indented
      if (currentArray && lineIndent <= currentArrayIndent) {
        currentArray = null;

        currentArrayIndent = -1;
      }

      // Pop stack to correct level
      while (stack.length > 1 && stack[stack.length - 1]!.indent >= lineIndent) {
        stack.pop();
      }

      const parent = stack[stack.length - 1]!.obj;

      // Peek at next non-empty line
      let nextIdx = i + 1;
      while (nextIdx < lines.length && lines[nextIdx]!.trim() === "") nextIdx++;

      if (nextIdx < lines.length && lines[nextIdx]!.trimStart().startsWith("- ")) {
        // Array
        const arr: unknown[] = [];
        parent[key] = arr;
        currentArray = arr;

        currentArrayIndent = lineIndent;
      } else {
        // Nested object
        const nested: Record<string, unknown> = {};
        parent[key] = nested;
        stack.push({ obj: nested, indent: lineIndent });
      }
      continue;
    }

    if (colonIdx !== -1) {
      // Close current array if we've de-indented
      if (currentArray && lineIndent <= currentArrayIndent) {
        currentArray = null;

        currentArrayIndent = -1;
      }

      // Pop stack to correct level
      while (stack.length > 1 && stack[stack.length - 1]!.indent >= lineIndent) {
        stack.pop();
      }

      const key = trimmed.slice(0, colonIdx);
      const val = trimmed.slice(colonIdx + 2);
      const parent = stack[stack.length - 1]!.obj;
      parent[key] = parseYamlValue(val);
    }
  }

  return root as unknown as MotebitIdentityFile;
}

// --- Signature Format ---

const SIG_PREFIX = "<!-- motebit:sig:Ed25519:";
const SIG_SUFFIX = " -->";

// --- Public API ---

export interface GenerateOptions {
  motebitId: string;
  createdAt?: string;
  ownerId: string;
  publicKeyHex: string;
  governance?: Partial<MotebitIdentityFile["governance"]>;
  privacy?: Partial<MotebitIdentityFile["privacy"]>;
  memory?: Partial<MotebitIdentityFile["memory"]>;
  devices?: MotebitIdentityFile["devices"];
}

export async function generate(
  opts: GenerateOptions,
  privateKey: Uint8Array,
): Promise<string> {
  const data: MotebitIdentityFile = {
    spec: "motebit/identity@1.0",
    motebit_id: opts.motebitId,
    created_at: opts.createdAt ?? new Date().toISOString(),
    owner_id: opts.ownerId,
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

  const yaml = serializeYaml(data);
  const frontmatter = `---\n${yaml}\n---`;
  const frontmatterBytes = new TextEncoder().encode(yaml);
  const signature = await ed25519Sign(frontmatterBytes, privateKey);
  const sigB64 = toBase64Url(signature);

  return `${frontmatter}\n${SIG_PREFIX}${sigB64}${SIG_SUFFIX}\n`;
}

export interface ParseResult {
  frontmatter: MotebitIdentityFile;
  signature: string;
  rawFrontmatter: string;
}

export function parse(content: string): ParseResult {
  // Extract frontmatter between first --- and second ---
  const firstDash = content.indexOf("---\n");
  if (firstDash === -1) throw new Error("Missing frontmatter opening ---");

  const bodyStart = firstDash + 4;
  const secondDash = content.indexOf("\n---", bodyStart);
  if (secondDash === -1) throw new Error("Missing frontmatter closing ---");

  const rawFrontmatter = content.slice(bodyStart, secondDash);
  const frontmatter = parseYaml(rawFrontmatter);

  // Extract signature
  const sigStart = content.indexOf(SIG_PREFIX);
  if (sigStart === -1) throw new Error("Missing signature");

  const sigValueStart = sigStart + SIG_PREFIX.length;
  const sigEnd = content.indexOf(SIG_SUFFIX, sigValueStart);
  if (sigEnd === -1) throw new Error("Malformed signature");

  const signature = content.slice(sigValueStart, sigEnd);

  return { frontmatter, signature, rawFrontmatter };
}

export interface VerifyResult {
  valid: boolean;
  identity: MotebitIdentityFile | null;
  error?: string;
}

export async function verify(content: string): Promise<VerifyResult> {
  let parsed: ParseResult;
  try {
    parsed = parse(content);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, identity: null, error: msg };
  }

  const pubKeyHex = parsed.frontmatter.identity?.public_key;
  if (!pubKeyHex) {
    return { valid: false, identity: null, error: "No public key in frontmatter" };
  }

  let pubKey: Uint8Array;
  try {
    pubKey = hexToBytes(pubKeyHex);
  } catch {
    return { valid: false, identity: null, error: "Invalid public key hex" };
  }
  if (pubKey.length !== 32) {
    return { valid: false, identity: null, error: "Public key must be 32 bytes" };
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(parsed.signature);
  } catch {
    return { valid: false, identity: null, error: "Invalid signature encoding" };
  }
  if (sigBytes.length !== 64) {
    return { valid: false, identity: null, error: "Signature must be 64 bytes" };
  }

  const frontmatterBytes = new TextEncoder().encode(parsed.rawFrontmatter);
  const valid = await ed25519Verify(sigBytes, frontmatterBytes, pubKey);

  return {
    valid,
    identity: valid ? parsed.frontmatter : null,
    error: valid ? undefined : "Signature verification failed",
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

  const yaml = serializeYaml(data);
  const frontmatter = `---\n${yaml}\n---`;
  const frontmatterBytes = new TextEncoder().encode(yaml);
  const signature = await ed25519Sign(frontmatterBytes, privateKey);
  const sigB64 = toBase64Url(signature);

  return `${frontmatter}\n${SIG_PREFIX}${sigB64}${SIG_SUFFIX}\n`;
}

// --- Helpers ---

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
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
}

export function governanceToPolicyConfig(gov: MotebitIdentityFile["governance"]): GovernancePolicyConfig {
  return {
    operatorMode: gov.operator_mode,
    maxRiskAuto: parseRiskLevel(gov.max_risk_auto),
    requireApprovalAbove: parseRiskLevel(gov.require_approval_above),
    denyAbove: parseRiskLevel(gov.deny_above),
  };
}
