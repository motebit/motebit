/**
 * Identity generation for create-motebit.
 *
 * Inlines the minimum necessary code from @motebit/crypto and
 * @motebit/identity-file to keep create-motebit self-contained
 * as a standalone public npm package.
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

// @noble/ed25519 v3 requires explicit SHA-512 binding
if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TrustMode = "minimal" | "guarded" | "full";

export interface EncryptedKey {
  ciphertext: string; // hex
  nonce: string; // hex
  tag: string; // hex
  salt: string; // hex
}

export interface GenerateIdentityResult {
  motebitId: string;
  deviceId: string;
  publicKeyHex: string;
  identityFileContent: string;
  encryptedKey: EncryptedKey;
}

// ---------------------------------------------------------------------------
// Encoding helpers (inlined from @motebit/crypto)
// ---------------------------------------------------------------------------

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function toBase64Url(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---------------------------------------------------------------------------
// UUID v7 (RFC 9562) — inlined to avoid monorepo dependency on core-identity
// ---------------------------------------------------------------------------

function generateUUIDv7(): string {
  const now = Date.now();
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);

  // Bytes 0-5: 48-bit Unix timestamp in milliseconds (big-endian)
  // Byte 6: version (0111) + 4 bits random
  // Byte 7: 8 bits random
  // Byte 8: variant (10) + 6 bits random
  // Bytes 9-15: 48 bits random
  const bytes = new Uint8Array(16);
  bytes[0] = (now / 2 ** 40) & 0xff;
  bytes[1] = (now / 2 ** 32) & 0xff;
  bytes[2] = (now / 2 ** 24) & 0xff;
  bytes[3] = (now / 2 ** 16) & 0xff;
  bytes[4] = (now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = 0x70 | (rand[0]! & 0x0f); // version 7
  bytes[7] = rand[1]!;
  bytes[8] = 0x80 | (rand[2]! & 0x3f); // variant 10
  bytes[9] = rand[3]!;
  bytes[10] = rand[4]!;
  bytes[11] = rand[5]!;
  bytes[12] = rand[6]!;
  bytes[13] = rand[7]!;
  bytes[14] = rand[8]!;
  bytes[15] = rand[9]!;

  const h = toHex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// Crypto (inlined from @motebit/crypto)
// ---------------------------------------------------------------------------

function generateNonce(): Uint8Array {
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  return nonce;
}

function generateSalt(): Uint8Array {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return salt;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number = 600_000,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

async function encrypt(
  plaintext: Uint8Array,
  key: Uint8Array,
): Promise<{ ciphertext: Uint8Array; nonce: Uint8Array; tag: Uint8Array }> {
  const nonce = generateNonce();
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const result = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cryptoKey, plaintext);
  const resultArray = new Uint8Array(result);
  // AES-GCM appends a 16-byte tag
  const ciphertext = resultArray.slice(0, resultArray.length - 16);
  const tag = resultArray.slice(resultArray.length - 16);
  return { ciphertext, nonce, tag };
}

/**
 * Decrypt an encrypted payload. Exported for test round-trip verification.
 */
export async function decrypt(
  payload: { ciphertext: Uint8Array; nonce: Uint8Array; tag: Uint8Array },
  key: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  const combined = new Uint8Array(payload.ciphertext.length + payload.tag.length);
  combined.set(payload.ciphertext);
  combined.set(payload.tag, payload.ciphertext.length);
  const result = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: payload.nonce },
    cryptoKey,
    combined,
  );
  return new Uint8Array(result);
}

// ---------------------------------------------------------------------------
// YAML serialization (inlined from @motebit/identity-file)
// ---------------------------------------------------------------------------

export interface ServiceIdentityOptions {
  type?: "personal" | "service" | "collaborative";
  service_name?: string;
  service_description?: string;
  service_url?: string;
  capabilities?: string[];
  terms_url?: string;
}

interface IdentityFileData {
  spec: string;
  motebit_id: string;
  created_at: string;
  owner_id: string;
  type?: string;
  service_name?: string;
  service_description?: string;
  service_url?: string;
  capabilities?: string[];
  terms_url?: string;
  identity: { algorithm: string; public_key: string };
  governance: {
    trust_mode: string;
    max_risk_auto: string;
    require_approval_above: string;
    deny_above: string;
    operator_mode: boolean;
  };
  privacy: {
    default_sensitivity: string;
    retention_days: Record<string, number>;
    fail_closed: boolean;
  };
  memory: {
    half_life_days: number;
    confidence_threshold: number;
    per_turn_limit: number;
  };
  devices: Array<{
    device_id: string;
    name: string;
    public_key: string;
    registered_at: string;
  }>;
}

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

  return typeof value === "symbol" ? value.toString() : `${value as string}`;
}

function serializeYaml(data: IdentityFileData): string {
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

// ---------------------------------------------------------------------------
// Governance presets
// ---------------------------------------------------------------------------

const GOVERNANCE_PRESETS: Record<
  TrustMode,
  { max_risk_auto: string; require_approval_above: string; deny_above: string }
> = {
  minimal: {
    max_risk_auto: "R0_READ",
    require_approval_above: "R0_READ",
    deny_above: "R2_WRITE",
  },
  guarded: {
    max_risk_auto: "R1_DRAFT",
    require_approval_above: "R1_DRAFT",
    deny_above: "R4_MONEY",
  },
  full: {
    max_risk_auto: "R3_EXECUTE",
    require_approval_above: "R3_EXECUTE",
    deny_above: "R4_MONEY",
  },
};

/** Service-appropriate governance: higher max_risk_auto since services execute tools */
const SERVICE_GOVERNANCE: Record<
  TrustMode,
  { max_risk_auto: string; require_approval_above: string; deny_above: string }
> = {
  minimal: {
    max_risk_auto: "R1_DRAFT",
    require_approval_above: "R1_DRAFT",
    deny_above: "R3_EXECUTE",
  },
  guarded: {
    max_risk_auto: "R2_WRITE",
    require_approval_above: "R2_WRITE",
    deny_above: "R4_MONEY",
  },
  full: {
    max_risk_auto: "R3_EXECUTE",
    require_approval_above: "R3_EXECUTE",
    deny_above: "R4_MONEY",
  },
};

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

const SIG_PREFIX = "<!-- motebit:sig:Ed25519:";
const SIG_SUFFIX = " -->";

// ---------------------------------------------------------------------------
// Key encryption (compatible with CLI's encryptPrivateKey)
// ---------------------------------------------------------------------------

async function encryptPrivateKey(privKeyHex: string, passphrase: string): Promise<EncryptedKey> {
  const salt = generateSalt(); // 16 bytes (NIST SP 800-132)
  const key = await deriveKey(passphrase, salt);
  const payload = await encrypt(new TextEncoder().encode(privKeyHex), key);
  return {
    ciphertext: toHex(payload.ciphertext),
    nonce: toHex(payload.nonce),
    tag: toHex(payload.tag),
    salt: toHex(salt),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export { GOVERNANCE_PRESETS, SERVICE_GOVERNANCE };

export async function generateIdentity(opts: {
  name: string;
  trustMode: TrustMode;
  passphrase: string;
  service?: ServiceIdentityOptions;
}): Promise<GenerateIdentityResult> {
  // Generate Ed25519 keypair
  const { secretKey, publicKey } = await ed.keygenAsync();
  const publicKeyHex = toHex(publicKey);
  const privateKeyHex = toHex(secretKey);

  // Generate IDs
  const motebitId = generateUUIDv7();
  const deviceId = generateUUIDv7();

  // Build identity file data — use service governance presets for service motebits
  const isService = opts.service?.type === "service";
  const gov = isService ? SERVICE_GOVERNANCE[opts.trustMode] : GOVERNANCE_PRESETS[opts.trustMode];

  // Build service fields conditionally
  const serviceFields: Partial<
    Pick<
      IdentityFileData,
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

  const data: IdentityFileData = {
    spec: "motebit/identity@1.0",
    motebit_id: motebitId,
    created_at: new Date().toISOString(),
    owner_id: motebitId,
    ...serviceFields,
    identity: {
      algorithm: "Ed25519",
      public_key: publicKeyHex,
    },
    governance: {
      trust_mode: opts.trustMode,
      max_risk_auto: gov.max_risk_auto,
      require_approval_above: gov.require_approval_above,
      deny_above: gov.deny_above,
      operator_mode: false,
    },
    privacy: {
      default_sensitivity: "personal",
      retention_days: {
        none: 365,
        personal: 90,
        medical: 30,
        financial: 30,
        secret: 7,
      },
      fail_closed: true,
    },
    memory: {
      half_life_days: 7,
      confidence_threshold: 0.3,
      per_turn_limit: 5,
    },
    devices: [
      {
        device_id: deviceId,
        name: opts.name,
        public_key: publicKeyHex,
        registered_at: new Date().toISOString(),
      },
    ],
  };

  // Serialize YAML and sign
  const yaml = serializeYaml(data);
  const frontmatter = `---\n${yaml}\n---`;
  const frontmatterBytes = new TextEncoder().encode(yaml);
  const signature = await ed.signAsync(frontmatterBytes, secretKey);
  const sigB64 = toBase64Url(signature);
  const identityFileContent = `${frontmatter}\n${SIG_PREFIX}${sigB64}${SIG_SUFFIX}\n`;

  // Encrypt private key (compatible with CLI's format)
  const encryptedKey = await encryptPrivateKey(privateKeyHex, opts.passphrase);

  return {
    motebitId,
    deviceId,
    publicKeyHex,
    identityFileContent,
    encryptedKey,
  };
}
