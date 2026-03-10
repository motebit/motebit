import { describe, it, expect } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { parse, verify } from "../index";

// @noble/ed25519 v3 requires explicit SHA-512 binding
if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
}

// ---------------------------------------------------------------------------
// Helpers — zero monorepo dependencies, only @noble/ed25519
// ---------------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makeKeypair() {
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKey, publicKeyHex: toHex(publicKey) };
}

function buildIdentityFile(yaml: string, signature: string): string {
  return `---\n${yaml}\n---\n<!-- motebit:sig:Ed25519:${signature} -->\n`;
}

async function generateValidFile(kp?: Awaited<ReturnType<typeof makeKeypair>>) {
  const { privateKey, publicKeyHex } = kp ?? (await makeKeypair());

  const yaml = [
    `spec: "motebit/identity@1.0"`,
    `motebit_id: "01234567-89ab-cdef-0123-456789abcdef"`,
    `created_at: "2026-01-15T00:00:00.000Z"`,
    `owner_id: "owner-test"`,
    `identity:`,
    `  algorithm: "Ed25519"`,
    `  public_key: "${publicKeyHex}"`,
    `governance:`,
    `  trust_mode: "guarded"`,
    `  max_risk_auto: "R1_DRAFT"`,
    `  require_approval_above: "R1_DRAFT"`,
    `  deny_above: "R4_MONEY"`,
    `  operator_mode: false`,
    `privacy:`,
    `  default_sensitivity: "personal"`,
    `  retention_days:`,
    `    none: 365`,
    `    personal: 90`,
    `    medical: 30`,
    `    financial: 30`,
    `    secret: 7`,
    `  fail_closed: true`,
    `memory:`,
    `  half_life_days: 7`,
    `  confidence_threshold: 0.3`,
    `  per_turn_limit: 5`,
    `devices: []`,
  ].join("\n");

  const frontmatterBytes = new TextEncoder().encode(yaml);
  const signature = await ed.signAsync(frontmatterBytes, privateKey);
  const sigB64 = toBase64Url(signature);

  return { content: buildIdentityFile(yaml, sigB64), yaml, publicKeyHex };
}

// ---------------------------------------------------------------------------
// parse()
// ---------------------------------------------------------------------------

describe("parse", () => {
  it("extracts frontmatter and signature", async () => {
    const { content, publicKeyHex } = await generateValidFile();
    const parsed = parse(content);

    expect(parsed.frontmatter.spec).toBe("motebit/identity@1.0");
    expect(parsed.frontmatter.motebit_id).toBe("01234567-89ab-cdef-0123-456789abcdef");
    expect(parsed.frontmatter.owner_id).toBe("owner-test");
    expect(parsed.frontmatter.identity.algorithm).toBe("Ed25519");
    expect(parsed.frontmatter.identity.public_key).toBe(publicKeyHex);
    expect(parsed.frontmatter.governance.trust_mode).toBe("guarded");
    expect(parsed.frontmatter.governance.operator_mode).toBe(false);
    expect(parsed.frontmatter.privacy.fail_closed).toBe(true);
    expect(parsed.frontmatter.privacy.retention_days).toEqual({
      none: 365,
      personal: 90,
      medical: 30,
      financial: 30,
      secret: 7,
    });
    expect(parsed.frontmatter.memory.half_life_days).toBe(7);
    expect(parsed.frontmatter.memory.confidence_threshold).toBe(0.3);
    expect(parsed.frontmatter.devices).toEqual([]);
    expect(parsed.signature).toBeTruthy();
  });

  it("throws on missing frontmatter opening ---", () => {
    expect(() => parse("no frontmatter here")).toThrow("Missing frontmatter opening ---");
  });

  it("throws on missing frontmatter closing ---", () => {
    expect(() => parse("---\nspec: test\n")).toThrow("Missing frontmatter closing ---");
  });

  it("throws on missing signature", () => {
    expect(() => parse("---\nspec: test\n---\n")).toThrow("Missing signature");
  });
});

// ---------------------------------------------------------------------------
// verify() — valid files
// ---------------------------------------------------------------------------

describe("verify — valid signatures", () => {
  it("verifies a correctly signed identity file", async () => {
    const { content } = await generateValidFile();
    const result = await verify(content);

    expect(result.valid).toBe(true);
    expect(result.identity).not.toBeNull();
    expect(result.identity!.motebit_id).toBe("01234567-89ab-cdef-0123-456789abcdef");
    expect(result.identity!.spec).toBe("motebit/identity@1.0");
    expect(result.error).toBeUndefined();
  });

  it("returns full identity on success", async () => {
    const { content, publicKeyHex } = await generateValidFile();
    const result = await verify(content);

    expect(result.valid).toBe(true);
    expect(result.identity!.identity.public_key).toBe(publicKeyHex);
    expect(result.identity!.governance.trust_mode).toBe("guarded");
    expect(result.identity!.privacy.fail_closed).toBe(true);
    expect(result.identity!.memory.half_life_days).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// verify() — tamper detection
// ---------------------------------------------------------------------------

describe("verify — tamper detection", () => {
  it("fails when frontmatter content is modified", async () => {
    const { content } = await generateValidFile();
    const tampered = content.replace("owner-test", "evil-owner");

    const result = await verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.identity).toBeNull();
    expect(result.error).toBe("Signature verification failed");
  });

  it("fails when trust_mode is changed", async () => {
    const { content } = await generateValidFile();
    const tampered = content.replace('"guarded"', '"full"');

    const result = await verify(tampered);
    expect(result.valid).toBe(false);
  });

  it("fails when motebit_id is changed", async () => {
    const { content } = await generateValidFile();
    const tampered = content.replace(
      "01234567-89ab-cdef-0123-456789abcdef",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
    );

    const result = await verify(tampered);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verify() — wrong key
// ---------------------------------------------------------------------------

describe("verify — wrong key", () => {
  it("fails when signed with a different private key", async () => {
    const kp1 = await makeKeypair();
    const kp2 = await makeKeypair();

    // Build YAML with kp2's public key, but sign with kp1's private key
    const yaml = [
      `spec: "motebit/identity@1.0"`,
      `motebit_id: "test"`,
      `created_at: "2026-01-01T00:00:00.000Z"`,
      `owner_id: "owner"`,
      `identity:`,
      `  algorithm: "Ed25519"`,
      `  public_key: "${kp2.publicKeyHex}"`,
      `governance:`,
      `  trust_mode: "guarded"`,
      `  max_risk_auto: "R1_DRAFT"`,
      `  require_approval_above: "R1_DRAFT"`,
      `  deny_above: "R4_MONEY"`,
      `  operator_mode: false`,
      `privacy:`,
      `  default_sensitivity: "personal"`,
      `  retention_days:`,
      `    none: 365`,
      `  fail_closed: true`,
      `memory:`,
      `  half_life_days: 7`,
      `  confidence_threshold: 0.3`,
      `  per_turn_limit: 5`,
      `devices: []`,
    ].join("\n");

    const frontmatterBytes = new TextEncoder().encode(yaml);
    const signature = await ed.signAsync(frontmatterBytes, kp1.privateKey);
    const content = buildIdentityFile(yaml, toBase64Url(signature));

    const result = await verify(content);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Signature verification failed");
  });
});

// ---------------------------------------------------------------------------
// verify() — malformed inputs
// ---------------------------------------------------------------------------

describe("verify — malformed inputs", () => {
  it("returns error for missing frontmatter", async () => {
    const result = await verify("no frontmatter");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Missing frontmatter opening ---");
  });

  it("returns error for missing signature", async () => {
    const result = await verify("---\nspec: test\n---\n");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Missing signature");
  });

  it("returns error for missing public key", async () => {
    const yaml = `spec: "motebit/identity@1.0"\nmotebit_id: "test"`;
    const content = buildIdentityFile(yaml, "AAAA");

    const result = await verify(content);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("No public key in frontmatter");
  });

  it("returns error for invalid public key hex (wrong length)", async () => {
    const yaml = [
      `spec: "motebit/identity@1.0"`,
      `identity:`,
      `  algorithm: "Ed25519"`,
      `  public_key: "abcd"`,
    ].join("\n");
    const content = buildIdentityFile(yaml, "AAAA");

    const result = await verify(content);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Public key must be 32 bytes");
  });

  it("returns error for invalid signature encoding", async () => {
    const kp = await makeKeypair();
    const yaml = [
      `spec: "motebit/identity@1.0"`,
      `identity:`,
      `  algorithm: "Ed25519"`,
      `  public_key: "${kp.publicKeyHex}"`,
    ].join("\n");
    // Invalid base64url — contains characters that break atob
    const content = buildIdentityFile(yaml, "!!!invalid!!!");

    const result = await verify(content);
    expect(result.valid).toBe(false);
    // Could be encoding error or length error
    expect(result.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// verify() — files with devices
// ---------------------------------------------------------------------------

describe("verify — files with devices", () => {
  it("verifies a file with device entries", async () => {
    const kp = await makeKeypair();

    const yaml = [
      `spec: "motebit/identity@1.0"`,
      `motebit_id: "test-with-devices"`,
      `created_at: "2026-01-15T00:00:00.000Z"`,
      `owner_id: "owner-test"`,
      `identity:`,
      `  algorithm: "Ed25519"`,
      `  public_key: "${kp.publicKeyHex}"`,
      `governance:`,
      `  trust_mode: "guarded"`,
      `  max_risk_auto: "R1_DRAFT"`,
      `  require_approval_above: "R1_DRAFT"`,
      `  deny_above: "R4_MONEY"`,
      `  operator_mode: false`,
      `privacy:`,
      `  default_sensitivity: "personal"`,
      `  retention_days:`,
      `    none: 365`,
      `  fail_closed: true`,
      `memory:`,
      `  half_life_days: 7`,
      `  confidence_threshold: 0.3`,
      `  per_turn_limit: 5`,
      `devices:`,
      `  - device_id: "dev-001"`,
      `    name: "Desktop"`,
      `    public_key: "${kp.publicKeyHex}"`,
      `    registered_at: "2026-01-15T00:00:00.000Z"`,
    ].join("\n");

    const frontmatterBytes = new TextEncoder().encode(yaml);
    const signature = await ed.signAsync(frontmatterBytes, kp.privateKey);
    const content = buildIdentityFile(yaml, toBase64Url(signature));

    const result = await verify(content);
    expect(result.valid).toBe(true);
    expect(result.identity!.devices).toHaveLength(1);
    expect(result.identity!.devices[0]!.device_id).toBe("dev-001");
    expect(result.identity!.devices[0]!.name).toBe("Desktop");
  });
});

// ---------------------------------------------------------------------------
// verify() — service identity files
// ---------------------------------------------------------------------------

describe("verify — service identity", () => {
  it("verifies a service identity file with all service fields", async () => {
    const kp = await makeKeypair();

    const yaml = [
      `spec: "motebit/identity@1.0"`,
      `motebit_id: "test-service"`,
      `created_at: "2026-01-15T00:00:00.000Z"`,
      `owner_id: "owner-test"`,
      `type: "service"`,
      `service_name: "Flight Search"`,
      `service_description: "Search and book flights"`,
      `service_url: "https://flights.example.com"`,
      `capabilities:`,
      `  - flight_search`,
      `  - flight_booking`,
      `  - price_alerts`,
      `terms_url: "https://flights.example.com/terms"`,
      `identity:`,
      `  algorithm: "Ed25519"`,
      `  public_key: "${kp.publicKeyHex}"`,
      `governance:`,
      `  trust_mode: "guarded"`,
      `  max_risk_auto: "R2_WRITE"`,
      `  require_approval_above: "R2_WRITE"`,
      `  deny_above: "R4_MONEY"`,
      `  operator_mode: false`,
      `privacy:`,
      `  default_sensitivity: "personal"`,
      `  retention_days:`,
      `    none: 365`,
      `    personal: 90`,
      `  fail_closed: true`,
      `memory:`,
      `  half_life_days: 7`,
      `  confidence_threshold: 0.3`,
      `  per_turn_limit: 5`,
      `devices: []`,
    ].join("\n");

    const frontmatterBytes = new TextEncoder().encode(yaml);
    const signature = await ed.signAsync(frontmatterBytes, kp.privateKey);
    const content = buildIdentityFile(yaml, toBase64Url(signature));

    const result = await verify(content);
    expect(result.valid).toBe(true);
    expect(result.identity!.type).toBe("service");
    expect(result.identity!.service_name).toBe("Flight Search");
    expect(result.identity!.service_description).toBe("Search and book flights");
    expect(result.identity!.service_url).toBe("https://flights.example.com");
    expect(result.identity!.capabilities).toEqual([
      "flight_search",
      "flight_booking",
      "price_alerts",
    ]);
    expect(result.identity!.terms_url).toBe("https://flights.example.com/terms");
  });

  it("verifies a personal identity file without service fields", async () => {
    const { content } = await generateValidFile();
    const result = await verify(content);
    expect(result.valid).toBe(true);
    expect(result.identity!.type).toBeUndefined();
    expect(result.identity!.service_name).toBeUndefined();
    expect(result.identity!.capabilities).toBeUndefined();
  });

  it("detects tampering of service fields", async () => {
    const kp = await makeKeypair();

    const yaml = [
      `spec: "motebit/identity@1.0"`,
      `motebit_id: "test-service"`,
      `created_at: "2026-01-15T00:00:00.000Z"`,
      `owner_id: "owner-test"`,
      `type: "service"`,
      `service_name: "Flight Search"`,
      `identity:`,
      `  algorithm: "Ed25519"`,
      `  public_key: "${kp.publicKeyHex}"`,
      `governance:`,
      `  trust_mode: "guarded"`,
      `  max_risk_auto: "R1_DRAFT"`,
      `  require_approval_above: "R1_DRAFT"`,
      `  deny_above: "R4_MONEY"`,
      `  operator_mode: false`,
      `privacy:`,
      `  default_sensitivity: "personal"`,
      `  retention_days:`,
      `    none: 365`,
      `  fail_closed: true`,
      `memory:`,
      `  half_life_days: 7`,
      `  confidence_threshold: 0.3`,
      `  per_turn_limit: 5`,
      `devices: []`,
    ].join("\n");

    const frontmatterBytes = new TextEncoder().encode(yaml);
    const signature = await ed.signAsync(frontmatterBytes, kp.privateKey);
    const content = buildIdentityFile(yaml, toBase64Url(signature));

    // Tamper: change service_name
    const tampered = content.replace("Flight Search", "Evil Service");
    const result = await verify(tampered);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-compatibility with @motebit/identity-file
// ---------------------------------------------------------------------------
// NOTE: Cross-compat is now tested in @motebit/identity-file's test suite,
// since identity-file delegates parse/verify to this package. The roundtrip
// tests (generate → parse → verify) inherently verify cross-compatibility.
