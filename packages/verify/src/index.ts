/**
 * @motebit/verify — Standalone verifier for motebit.md agent identity files.
 *
 * Implements the verification algorithm from the motebit/identity@1.0 spec.
 * Zero monorepo dependencies — only @noble/ed25519 for cryptography.
 *
 * Usage:
 *   import { verify } from "@motebit/verify";
 *   const result = await verify(fs.readFileSync("motebit.md", "utf-8"));
 *   if (result.valid) console.log(result.identity.motebit_id);
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

// @noble/ed25519 v3 requires explicit SHA-512 binding
if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
}

// ---------------------------------------------------------------------------
// Types — matches motebit/identity@1.0 schema
// ---------------------------------------------------------------------------

export interface MotebitIdentityFile {
  spec: string;
  motebit_id: string;
  created_at: string;
  owner_id: string;

  identity: {
    algorithm: "Ed25519";
    public_key: string;
  };

  governance: {
    trust_mode: "full" | "guarded" | "minimal";
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

export interface VerifyResult {
  valid: boolean;
  identity: MotebitIdentityFile | null;
  error?: string;
}

// ---------------------------------------------------------------------------
// Minimal YAML parser — handles only the motebit identity schema
// ---------------------------------------------------------------------------

function parseYamlValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "[]") return [];
  if (trimmed === "{}") return ({});

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return JSON.parse(trimmed);
  }

  const num = Number(trimmed);
  if (trimmed !== "" && !isNaN(num) && isFinite(num)) return num;

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

    if (trimmed.startsWith("- ")) {
      const itemContent = trimmed.slice(2);
      const colonIdx = itemContent.indexOf(": ");

      if (colonIdx !== -1) {
        const obj: Record<string, unknown> = {};
        const key = itemContent.slice(0, colonIdx);
        const val = itemContent.slice(colonIdx + 2);
        obj[key] = parseYamlValue(val);

        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j]!;
          if (nextLine.trim() === "") continue;
          const nextIndent = nextLine.length - nextLine.trimStart().length;
          const nextTrimmed = nextLine.trimStart();

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

        if (currentArray) currentArray.push(obj);
      } else {
        if (currentArray) currentArray.push(parseYamlValue(itemContent));
      }
      continue;
    }

    const colonIdx = trimmed.indexOf(": ");
    const endsWithColon = trimmed.endsWith(":") && colonIdx === -1;

    if (endsWithColon) {
      const key = trimmed.slice(0, -1);

      if (currentArray && lineIndent <= currentArrayIndent) {
        currentArray = null;
        currentArrayIndent = -1;
      }

      while (stack.length > 1 && stack[stack.length - 1]!.indent >= lineIndent) {
        stack.pop();
      }

      const parent = stack[stack.length - 1]!.obj;

      let nextIdx = i + 1;
      while (nextIdx < lines.length && lines[nextIdx]!.trim() === "") nextIdx++;

      if (nextIdx < lines.length && lines[nextIdx]!.trimStart().startsWith("- ")) {
        const arr: unknown[] = [];
        parent[key] = arr;
        currentArray = arr;
        currentArrayIndent = lineIndent;
      } else {
        const nested: Record<string, unknown> = {};
        parent[key] = nested;
        stack.push({ obj: nested, indent: lineIndent });
      }
      continue;
    }

    if (colonIdx !== -1) {
      if (currentArray && lineIndent <= currentArrayIndent) {
        currentArray = null;
        currentArrayIndent = -1;
      }

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

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function fromBase64Url(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SIG_PREFIX = "<!-- motebit:sig:Ed25519:";
const SIG_SUFFIX = " -->";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a motebit.md file into its components.
 * Does not verify the signature — use `verify()` for that.
 */
export function parse(content: string): {
  frontmatter: MotebitIdentityFile;
  signature: string;
  rawFrontmatter: string;
} {
  const firstDash = content.indexOf("---\n");
  if (firstDash === -1) throw new Error("Missing frontmatter opening ---");

  const bodyStart = firstDash + 4;
  const secondDash = content.indexOf("\n---", bodyStart);
  if (secondDash === -1) throw new Error("Missing frontmatter closing ---");

  const rawFrontmatter = content.slice(bodyStart, secondDash);
  const frontmatter = parseYaml(rawFrontmatter);

  const sigStart = content.indexOf(SIG_PREFIX);
  if (sigStart === -1) throw new Error("Missing signature");

  const sigValueStart = sigStart + SIG_PREFIX.length;
  const sigEnd = content.indexOf(SIG_SUFFIX, sigValueStart);
  if (sigEnd === -1) throw new Error("Malformed signature");

  const signature = content.slice(sigValueStart, sigEnd);

  return { frontmatter, signature, rawFrontmatter };
}

/**
 * Verify a motebit.md file's Ed25519 signature.
 *
 * Returns `{ valid: true, identity }` if the signature is valid,
 * or `{ valid: false, identity: null, error }` if verification fails.
 *
 * Implements the motebit/identity@1.0 verification algorithm (spec §4.3).
 */
export async function verify(content: string): Promise<VerifyResult> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(content);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { valid: false, identity: null, error: msg };
  }

  // Step 6: Extract and validate public key
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

  // Step 5: Extract and validate signature
  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(parsed.signature);
  } catch {
    return { valid: false, identity: null, error: "Invalid signature encoding" };
  }
  if (sigBytes.length !== 64) {
    return { valid: false, identity: null, error: "Signature must be 64 bytes" };
  }

  // Steps 7-8: Verify Ed25519 signature over frontmatter bytes
  const frontmatterBytes = new TextEncoder().encode(parsed.rawFrontmatter);

  let valid: boolean;
  try {
    valid = await ed.verifyAsync(sigBytes, frontmatterBytes, pubKey);
  } catch {
    valid = false;
  }

  return {
    valid,
    identity: valid ? parsed.frontmatter : null,
    error: valid ? undefined : "Signature verification failed",
  };
}
