#!/usr/bin/env tsx
/**
 * check-skill-corpus — drift defense for committed reference skills.
 *
 * Every directory under `skills/` at the repo root is a committed
 * agentskills.io-compatible artifact (spec/skills-v1.md). The probe walks
 * each one and asserts:
 *
 *   1. SKILL.md and skill-envelope.json both exist and parse.
 *   2. body_hash matches SHA-256 of the LF-normalized SKILL.md body bytes.
 *   3. content_hash matches SHA-256(JCS(envelope.manifest) || 0x0A || body).
 *   4. The envelope signature verifies against its embedded public_key.
 *
 * Catches drift if a contributor edits SKILL.md without re-running
 * `pnpm --filter @motebit/skills build-reference-skill`. Without this gate,
 * a stale signature would only surface at install time on a user's machine
 * — too late.
 *
 * Standalone: no `@motebit/*` imports, no YAML lib. Uses Node's built-in
 * `crypto.subtle.verify('Ed25519', ...)` for signature verification and
 * an inline JCS canonicalizer matching `@motebit/crypto::canonicalJson`.
 *
 * Drift class: "shipped reference skill ↔ its committed signature."
 *
 * Usage:
 *   tsx scripts/check-skill-corpus.ts        # exit 1 on drift
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, webcrypto } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SKILLS_DIR = join(ROOT, "skills");

interface Finding {
  loc: string;
  message: string;
}

const findings: Finding[] = [];

function fail(loc: string, message: string): void {
  findings.push({ loc, message });
}

// ---------------------------------------------------------------------------
// JCS canonical JSON (RFC 8785) — must match @motebit/crypto::canonicalJson
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const entries: string[] = [];
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      entries.push(JSON.stringify(k) + ":" + canonicalJson(v));
    }
    return "{" + entries.join(",") + "}";
  }
  return "null";
}

// ---------------------------------------------------------------------------
// Hashing + body extraction
// ---------------------------------------------------------------------------

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Extract the LF-normalized body bytes from a SKILL.md text. Mirrors the
 * parser in `@motebit/skills::parseSkillFile`: BOM stripped, CRLF→LF,
 * everything after the closing `---\n` delimiter.
 */
function extractBody(rawText: string): Uint8Array {
  let text = rawText.startsWith("﻿") ? rawText.slice(1) : rawText;
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!text.startsWith("---\n")) {
    throw new Error("SKILL.md must start with a `---\\n` frontmatter delimiter");
  }
  const afterOpen = text.slice(4);
  const closeIdx = afterOpen.indexOf("\n---\n");
  if (closeIdx < 0) {
    if (afterOpen.endsWith("\n---")) {
      return new Uint8Array(0);
    }
    throw new Error("SKILL.md frontmatter has no closing `---\\n` delimiter");
  }
  const bodyText = afterOpen.slice(closeIdx + 5); // skip "\n---\n"
  return new TextEncoder().encode(bodyText);
}

// ---------------------------------------------------------------------------
// Ed25519 signature verification (Node 20+ built-in)
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex string has odd length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function fromBase64Url(b64url: string): Uint8Array {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

async function verifyEd25519(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array,
): Promise<boolean> {
  const key = await webcrypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, [
    "verify",
  ]);
  return webcrypto.subtle.verify("Ed25519", key, signature, message);
}

// ---------------------------------------------------------------------------
// Per-skill check
// ---------------------------------------------------------------------------

interface SkillEnvelope {
  spec_version: string;
  skill: { name: string; version: string; content_hash: string };
  manifest: unknown;
  body_hash: string;
  files: Array<{ path: string; hash: string }>;
  signature: { suite: string; public_key: string; value: string };
}

async function checkOne(dir: string): Promise<void> {
  const rel = relative(ROOT, dir);
  const skillMdPath = join(dir, "SKILL.md");
  const envelopePath = join(dir, "skill-envelope.json");

  if (!existsSync(skillMdPath)) {
    fail(rel, "missing SKILL.md");
    return;
  }
  if (!existsSync(envelopePath)) {
    fail(rel, "missing skill-envelope.json");
    return;
  }

  let body: Uint8Array;
  try {
    body = extractBody(readFileSync(skillMdPath, "utf-8"));
  } catch (err: unknown) {
    fail(rel, `SKILL.md body extract failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  let envelope: SkillEnvelope;
  try {
    envelope = JSON.parse(readFileSync(envelopePath, "utf-8")) as SkillEnvelope;
  } catch (err: unknown) {
    fail(
      rel,
      `skill-envelope.json parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  // body_hash check
  const bodyHash = sha256Hex(body);
  if (envelope.body_hash !== bodyHash) {
    fail(rel, `body_hash mismatch — envelope says ${envelope.body_hash}, computed ${bodyHash}`);
  }

  // content_hash = SHA-256(JCS(envelope.manifest) || 0x0A || body)
  const manifestBytes = new TextEncoder().encode(canonicalJson(envelope.manifest));
  const concat = new Uint8Array(manifestBytes.length + 1 + body.length);
  concat.set(manifestBytes, 0);
  concat[manifestBytes.length] = 0x0a;
  concat.set(body, manifestBytes.length + 1);
  const contentHash = sha256Hex(concat);
  if (envelope.skill.content_hash !== contentHash) {
    fail(
      rel,
      `content_hash mismatch — envelope says ${envelope.skill.content_hash}, computed ${contentHash}`,
    );
  }

  // Envelope signature must verify
  if (envelope.signature.suite !== "motebit-jcs-ed25519-b64-v1") {
    fail(
      rel,
      `envelope signature.suite must be "motebit-jcs-ed25519-b64-v1"; got "${envelope.signature.suite}"`,
    );
    return;
  }

  let publicKeyBytes: Uint8Array;
  try {
    publicKeyBytes = hexToBytes(envelope.signature.public_key);
  } catch {
    fail(rel, `envelope.signature.public_key is not valid hex`);
    return;
  }
  if (publicKeyBytes.length !== 32) {
    fail(
      rel,
      `envelope.signature.public_key must be 32 bytes (Ed25519); got ${publicKeyBytes.length}`,
    );
    return;
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = fromBase64Url(envelope.signature.value);
  } catch {
    fail(rel, `envelope.signature.value is not valid base64url`);
    return;
  }

  // Reconstruct canonical envelope bytes (with signature.value removed)
  const envelopeForCanonical = {
    ...envelope,
    signature: { suite: envelope.signature.suite, public_key: envelope.signature.public_key },
  };
  const message = new TextEncoder().encode(canonicalJson(envelopeForCanonical));

  let valid: boolean;
  try {
    valid = await verifyEd25519(sigBytes, message, publicKeyBytes);
  } catch (err: unknown) {
    fail(
      rel,
      `envelope signature verify threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (!valid) {
    fail(rel, `envelope signature verification failed — re-run build-reference-skill`);
  }
}

async function main(): Promise<void> {
  if (!existsSync(SKILLS_DIR)) {
    console.log("check-skill-corpus: no skills/ directory at repo root — nothing to check.");
    return;
  }

  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => join(SKILLS_DIR, e.name));

  if (dirs.length === 0) {
    console.log("check-skill-corpus: skills/ exists but contains no subdirectories.");
    return;
  }

  for (const dir of dirs) {
    if (!statSync(dir).isDirectory()) continue;
    await checkOne(dir);
  }

  if (findings.length === 0) {
    console.log(
      `✓ check-skill-corpus: ${dirs.length} reference skill(s) all signed and consistent.`,
    );
    return;
  }

  console.error(`✗ check-skill-corpus: ${findings.length} drift(s) detected.`);
  console.error("");
  for (const f of findings) {
    console.error(`  ${f.loc}`);
    console.error(`    ${f.message}`);
  }
  console.error("");
  console.error("  To re-sign reference skills:");
  console.error("    pnpm --filter @motebit/skills build-reference-skill");
  console.error("");
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
