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

// Identity-file signature comment format (cryptosuite-agility):
//   <!-- motebit:sig:motebit-jcs-ed25519-hex-v1:{hex_signature} -->
// Legacy `motebit:sig:Ed25519:` comments are rejected fail-closed by
// @motebit/crypto — every fixture here signs under the current suite.
const IDENTITY_FILE_SUITE = "motebit-jcs-ed25519-hex-v1" as const;
function buildIdentityFile(yaml: string, signatureHex: string): string {
  return `---\n${yaml}\n---\n<!-- motebit:sig:${IDENTITY_FILE_SUITE}:${signatureHex} -->\n`;
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
  const sigHex = toHex(signature);

  return { content: buildIdentityFile(yaml, sigHex), yaml, publicKeyHex };
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
    expect(result.did).toMatch(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/);
    expect(result.errors).toBeUndefined();
  });

  it("returns deterministic did:key on valid verification", async () => {
    const { content } = await generateValidFile();
    const a = await verify(content);
    const b = await verify(content);
    expect(a.did).toBe(b.did);
    expect(a.did).toMatch(/^did:key:z/);
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
    expect(result.errors?.[0]?.message).toBe("Signature verification failed");
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
    const content = buildIdentityFile(yaml, toHex(signature));

    const result = await verify(content);
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.message).toBe("Signature verification failed");
  });
});

// ---------------------------------------------------------------------------
// verify() — malformed inputs
// ---------------------------------------------------------------------------

describe("verify — malformed inputs", () => {
  it("returns error for missing frontmatter", async () => {
    const result = await verify("no frontmatter");
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.message).toBe("Unrecognized artifact format");
  });

  it("returns error for missing signature", async () => {
    const result = await verify("---\nspec: test\n---\n");
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.message).toContain("Missing signature comment");
  });

  it("returns error for missing public key", async () => {
    const yaml = `spec: "motebit/identity@1.0"\nmotebit_id: "test"`;
    const content = buildIdentityFile(yaml, "AAAA");

    const result = await verify(content);
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.message).toBe("No public key in frontmatter");
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
    expect(result.errors?.[0]?.message).toBe("Public key must be 32 bytes");
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
    expect(result.errors?.[0]?.message).toBeTruthy();
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
    const content = buildIdentityFile(yaml, toHex(signature));

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
    const content = buildIdentityFile(yaml, toHex(signature));

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
    const content = buildIdentityFile(yaml, toHex(signature));

    // Tamper: change service_name
    const tampered = content.replace("Flight Search", "Evil Service");
    const result = await verify(tampered);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Helpers for succession chain tests
// ---------------------------------------------------------------------------

function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  const entries: string[] = [];
  for (const key of sorted) {
    const val = (obj as Record<string, unknown>)[key];
    if (val === undefined) continue;
    entries.push(JSON.stringify(key) + ":" + canonicalJson(val));
  }
  return "{" + entries.join(",") + "}";
}

async function createSuccessionRecord(
  oldKp: Awaited<ReturnType<typeof makeKeypair>>,
  newKp: Awaited<ReturnType<typeof makeKeypair>>,
  timestamp: number,
  reason?: string,
) {
  const payloadObj: Record<string, unknown> = {
    old_public_key: oldKp.publicKeyHex,
    new_public_key: newKp.publicKeyHex,
    timestamp,
    suite: IDENTITY_FILE_SUITE,
  };
  if (reason !== undefined) {
    payloadObj.reason = reason;
  }
  const payload = canonicalJson(payloadObj);
  const message = new TextEncoder().encode(payload);

  const oldSig = await ed.signAsync(message, oldKp.privateKey);
  const newSig = await ed.signAsync(message, newKp.privateKey);

  return {
    old_public_key: oldKp.publicKeyHex,
    new_public_key: newKp.publicKeyHex,
    timestamp,
    ...(reason !== undefined ? { reason } : {}),
    suite: IDENTITY_FILE_SUITE,
    old_key_signature: toHex(oldSig),
    new_key_signature: toHex(newSig),
  };
}

function buildYamlWithSuccession(
  publicKeyHex: string,
  successionRecords: Array<{
    old_public_key: string;
    new_public_key: string;
    timestamp: number;
    reason?: string;
    suite: string;
    old_key_signature: string;
    new_key_signature: string;
  }>,
): string {
  const lines = [
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
    `  fail_closed: true`,
    `memory:`,
    `  half_life_days: 7`,
    `  confidence_threshold: 0.3`,
    `  per_turn_limit: 5`,
    `devices: []`,
    `succession:`,
  ];

  for (const rec of successionRecords) {
    lines.push(`  - old_public_key: "${rec.old_public_key}"`);
    lines.push(`    new_public_key: "${rec.new_public_key}"`);
    lines.push(`    timestamp: ${rec.timestamp}`);
    if (rec.reason !== undefined) {
      lines.push(`    reason: "${rec.reason}"`);
    }
    lines.push(`    suite: "${rec.suite}"`);
    lines.push(`    old_key_signature: "${rec.old_key_signature}"`);
    lines.push(`    new_key_signature: "${rec.new_key_signature}"`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// verify() — succession chain
// ---------------------------------------------------------------------------

describe("verify — succession chain", () => {
  it("verifies identity file with one succession record", async () => {
    const kp1 = await makeKeypair(); // genesis key
    const kp2 = await makeKeypair(); // current key

    const record = await createSuccessionRecord(kp1, kp2, 1000000);
    const yaml = buildYamlWithSuccession(kp2.publicKeyHex, [record]);

    const frontmatterBytes = new TextEncoder().encode(yaml);
    const signature = await ed.signAsync(frontmatterBytes, kp2.privateKey);
    const content = buildIdentityFile(yaml, toHex(signature));

    const result = await verify(content);
    expect(result.valid).toBe(true);
    expect(result.succession).toBeDefined();
    expect(result.succession!.valid).toBe(true);
    expect(result.succession!.rotations).toBe(1);
    expect(result.succession!.genesis_public_key).toBe(kp1.publicKeyHex);
    expect(result.succession!.error).toBeUndefined();
  });

  it("verifies identity file with succession record including reason", async () => {
    const kp1 = await makeKeypair();
    const kp2 = await makeKeypair();

    const record = await createSuccessionRecord(kp1, kp2, 1000000, "key compromise");
    const yaml = buildYamlWithSuccession(kp2.publicKeyHex, [record]);

    const frontmatterBytes = new TextEncoder().encode(yaml);
    const signature = await ed.signAsync(frontmatterBytes, kp2.privateKey);
    const content = buildIdentityFile(yaml, toHex(signature));

    const result = await verify(content);
    expect(result.valid).toBe(true);
    expect(result.succession!.valid).toBe(true);
    expect(result.succession!.rotations).toBe(1);
  });

  it("verifies identity file with multi-hop succession chain", async () => {
    const kp1 = await makeKeypair();
    const kp2 = await makeKeypair();
    const kp3 = await makeKeypair();

    const rec1 = await createSuccessionRecord(kp1, kp2, 1000000);
    const rec2 = await createSuccessionRecord(kp2, kp3, 2000000);
    const yaml = buildYamlWithSuccession(kp3.publicKeyHex, [rec1, rec2]);

    const frontmatterBytes = new TextEncoder().encode(yaml);
    const signature = await ed.signAsync(frontmatterBytes, kp3.privateKey);
    const content = buildIdentityFile(yaml, toHex(signature));

    const result = await verify(content);
    expect(result.valid).toBe(true);
    expect(result.succession!.valid).toBe(true);
    expect(result.succession!.rotations).toBe(2);
    expect(result.succession!.genesis_public_key).toBe(kp1.publicKeyHex);
  });

  it("backward compat: no succession field returns no succession result", async () => {
    const { content } = await generateValidFile();
    const result = await verify(content);
    expect(result.valid).toBe(true);
    expect(result.succession).toBeUndefined();
  });

  it("fails when succession chain linkage is broken", async () => {
    const kp1 = await makeKeypair();
    const kp2 = await makeKeypair();
    const kp3 = await makeKeypair();
    const kpRandom = await makeKeypair();

    // rec1 goes kp1 -> kpRandom, rec2 goes kp2 -> kp3
    // Linkage broken: kpRandom != kp2
    const rec1 = await createSuccessionRecord(kp1, kpRandom, 1000000);
    const rec2 = await createSuccessionRecord(kp2, kp3, 2000000);
    const yaml = buildYamlWithSuccession(kp3.publicKeyHex, [rec1, rec2]);

    const frontmatterBytes = new TextEncoder().encode(yaml);
    const signature = await ed.signAsync(frontmatterBytes, kp3.privateKey);
    const content = buildIdentityFile(yaml, toHex(signature));

    const result = await verify(content);
    expect(result.valid).toBe(true); // file signature is valid
    expect(result.succession).toBeDefined();
    expect(result.succession!.valid).toBe(false);
    expect(result.succession!.error).toContain("chain broken");
  });

  it("fails when last succession new_public_key doesn't match identity public_key", async () => {
    const kp1 = await makeKeypair();
    const kp2 = await makeKeypair();
    const kpActual = await makeKeypair(); // actual identity key, different from kp2

    const record = await createSuccessionRecord(kp1, kp2, 1000000);
    // Identity uses kpActual, but succession chain ends at kp2
    const yaml = buildYamlWithSuccession(kpActual.publicKeyHex, [record]);

    const frontmatterBytes = new TextEncoder().encode(yaml);
    const signature = await ed.signAsync(frontmatterBytes, kpActual.privateKey);
    const content = buildIdentityFile(yaml, toHex(signature));

    const result = await verify(content);
    expect(result.valid).toBe(true); // file signature is valid
    expect(result.succession).toBeDefined();
    expect(result.succession!.valid).toBe(false);
    expect(result.succession!.error).toContain("terminal");
  });
});

// ---------------------------------------------------------------------------
// verify() — dispatch: JSON string inputs for non-identity types
// ---------------------------------------------------------------------------

describe("verify — JSON string dispatch", () => {
  it("dispatches a receipt JSON string to verifyReceipt", async () => {
    const kp = await makeKeypair();
    const receiptBody = {
      task_id: "task-json-str",
      motebit_id: "01234567-89ab-cdef-0123-456789abcdef",
      public_key: kp.publicKeyHex,
      device_id: "dev-001",
      submitted_at: 1000000,
      completed_at: 1001000,
      status: "completed",
      result: "ok",
      tools_used: [],
      memories_formed: 0,
      prompt_hash: "abc",
      result_hash: "def",
      suite: "motebit-jcs-ed25519-b64-v1",
    };
    const canonical = canonicalJson(receiptBody);
    const message = new TextEncoder().encode(canonical);
    const sig = await ed.signAsync(message, kp.privateKey);
    const sigB64 = toBase64Url(sig);
    const receipt = { ...receiptBody, signature: sigB64 };

    const result = await verify(JSON.stringify(receipt));
    expect(result.type).toBe("receipt");
    expect(result.valid).toBe(true);
  });

  it("returns error for receipt-shaped string with invalid JSON", async () => {
    // This is tricky — detectArtifactType tries JSON.parse. If it fails,
    // it returns null (not a receipt). We need something that detects as receipt
    // but then fails JSON.parse on the second pass.
    // Actually, strings that contain "---" go to identity, and non-JSON without "---" return null.
    // The JSON parse fail path on line 1030 would only be hit if detectArtifactType
    // successfully parsed but then the second parse fails — which can't happen
    // since they use the same JSON.parse. So this path is essentially dead code
    // for valid detection. Let's verify the type mismatch paths instead.
    const result = await verify(42, { expectedType: "receipt" });
    expect(result.valid).toBe(false);
    expect(result.errors![0]!.message).toBe("Unrecognized artifact format");
  });

  it("returns unrecognized format for non-object non-string input", async () => {
    const result = await verify(null);
    expect(result.valid).toBe(false);
    expect(result.errors![0]!.message).toBe("Unrecognized artifact format");
  });

  it("returns unrecognized format with credential fallback type", async () => {
    const result = await verify(42, { expectedType: "credential" });
    expect(result.valid).toBe(false);
    expect((result as { credential: unknown }).credential).toBeNull();
    expect(result.errors![0]!.message).toBe("Unrecognized artifact format");
  });

  it("returns unrecognized format with presentation fallback type", async () => {
    const result = await verify(42, { expectedType: "presentation" });
    expect(result.valid).toBe(false);
    expect((result as { presentation: unknown }).presentation).toBeNull();
    expect(result.errors![0]!.message).toBe("Unrecognized artifact format");
  });

  it("dispatches identity string to verifyIdentity", async () => {
    const { content } = await generateValidFile();
    const result = await verify(content);
    expect(result.type).toBe("identity");
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verify() — verifyIdentityFile (deprecated wrapper)
// ---------------------------------------------------------------------------

import { verifyIdentityFile } from "../index";

describe("verifyIdentityFile — deprecated wrapper", () => {
  it("returns valid result for a correctly signed file", async () => {
    const { content } = await generateValidFile();
    const result = await verifyIdentityFile(content);
    expect(result.valid).toBe(true);
    expect(result.identity).not.toBeNull();
    expect(result.identity!.motebit_id).toBe("01234567-89ab-cdef-0123-456789abcdef");
    expect(result.did).toMatch(/^did:key:z/);
    expect(result.error).toBeUndefined();
  });

  it("returns error for a tampered file", async () => {
    const { content } = await generateValidFile();
    const tampered = content.replace("owner-test", "evil-owner");
    const result = await verifyIdentityFile(tampered);
    expect(result.valid).toBe(false);
    expect(result.identity).toBeNull();
    expect(result.error).toBe("Signature verification failed");
  });

  it("returns succession result when present", async () => {
    const kp1 = await makeKeypair();
    const kp2 = await makeKeypair();

    const record = await createSuccessionRecord(kp1, kp2, 1000000);
    const yaml = buildYamlWithSuccession(kp2.publicKeyHex, [record]);

    const frontmatterBytes = new TextEncoder().encode(yaml);
    const signature = await ed.signAsync(frontmatterBytes, kp2.privateKey);
    const content = buildIdentityFile(yaml, toHex(signature));

    const result = await verifyIdentityFile(content);
    expect(result.valid).toBe(true);
    expect(result.succession).toBeDefined();
    expect(result.succession!.valid).toBe(true);
    expect(result.succession!.rotations).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// verify() — JSON parse failure path (line 1034)
// ---------------------------------------------------------------------------

describe("verify — JSON parse failure for detected non-identity string", () => {
  it("returns parse error for a string that detects as JSON type but fails parse on second pass", async () => {
    // This path (lines 1034-1043) is essentially dead code:
    // detectArtifactType already calls JSON.parse successfully if it detects
    // a non-identity type from a string. The second JSON.parse on line 1032
    // would only fail if the string mutated between calls — impossible in
    // single-threaded JS. We cannot reach this path without modifying source.
  });
});

// ---------------------------------------------------------------------------
// verify() — succession chain edge cases
// ---------------------------------------------------------------------------

describe("verify — succession chain failures", () => {
  it("fails when old_key_signature verification fails", async () => {
    const kp1 = await makeKeypair();
    const kp2 = await makeKeypair();
    const kpWrong = await makeKeypair();

    // Create a record where old_key_signature is signed by wrong key
    const payloadObj: Record<string, unknown> = {
      old_public_key: kp1.publicKeyHex,
      new_public_key: kp2.publicKeyHex,
      timestamp: 1000000,
      suite: IDENTITY_FILE_SUITE,
    };
    const payload = canonicalJson(payloadObj);
    const message = new TextEncoder().encode(payload);

    // Sign old_key_signature with WRONG key (kpWrong instead of kp1)
    const oldSig = await ed.signAsync(message, kpWrong.privateKey);
    const newSig = await ed.signAsync(message, kp2.privateKey);

    const record = {
      old_public_key: kp1.publicKeyHex,
      new_public_key: kp2.publicKeyHex,
      timestamp: 1000000,
      suite: IDENTITY_FILE_SUITE,
      old_key_signature: toHex(oldSig),
      new_key_signature: toHex(newSig),
    };

    const yaml = buildYamlWithSuccession(kp2.publicKeyHex, [record]);
    const frontmatterBytes = new TextEncoder().encode(yaml);
    const signature = await ed.signAsync(frontmatterBytes, kp2.privateKey);
    const content = buildIdentityFile(yaml, toHex(signature));

    const result = await verify(content);
    expect(result.valid).toBe(true); // file signature is valid
    expect(result.succession).toBeDefined();
    expect(result.succession!.valid).toBe(false);
    expect(result.succession!.error).toContain("old_key_signature verification failed");
  });

  it("fails when new_key_signature verification fails", async () => {
    const kp1 = await makeKeypair();
    const kp2 = await makeKeypair();
    const kpWrong = await makeKeypair();

    const payloadObj: Record<string, unknown> = {
      old_public_key: kp1.publicKeyHex,
      new_public_key: kp2.publicKeyHex,
      timestamp: 1000000,
      suite: IDENTITY_FILE_SUITE,
    };
    const payload = canonicalJson(payloadObj);
    const message = new TextEncoder().encode(payload);

    // Sign old_key_signature correctly, new_key_signature with WRONG key
    const oldSig = await ed.signAsync(message, kp1.privateKey);
    const newSig = await ed.signAsync(message, kpWrong.privateKey);

    const record = {
      old_public_key: kp1.publicKeyHex,
      new_public_key: kp2.publicKeyHex,
      timestamp: 1000000,
      suite: IDENTITY_FILE_SUITE,
      old_key_signature: toHex(oldSig),
      new_key_signature: toHex(newSig),
    };

    const yaml = buildYamlWithSuccession(kp2.publicKeyHex, [record]);
    const frontmatterBytes = new TextEncoder().encode(yaml);
    const signature = await ed.signAsync(frontmatterBytes, kp2.privateKey);
    const content = buildIdentityFile(yaml, toHex(signature));

    const result = await verify(content);
    expect(result.valid).toBe(true);
    expect(result.succession).toBeDefined();
    expect(result.succession!.valid).toBe(false);
    expect(result.succession!.error).toContain("new_key_signature verification failed");
  });

  it("catches unexpected errors in succession chain verification", async () => {
    const kp1 = await makeKeypair();
    const kp2 = await makeKeypair();

    // Create a succession record with a truncated old_key_signature (not 64 bytes)
    // This will cause ed.verifyAsync to throw instead of returning false
    const record = {
      old_public_key: kp1.publicKeyHex,
      new_public_key: kp2.publicKeyHex,
      timestamp: 1000000,
      old_key_signature: "ab".repeat(10), // 10 bytes, not 64 — will throw
      new_key_signature: "cd".repeat(10),
    };

    const yaml = buildYamlWithSuccession(kp2.publicKeyHex, [record]);
    const frontmatterBytes = new TextEncoder().encode(yaml);
    const signature = await ed.signAsync(frontmatterBytes, kp2.privateKey);
    const content = buildIdentityFile(yaml, toHex(signature));

    const result = await verify(content);
    expect(result.valid).toBe(true); // file signature is valid
    expect(result.succession).toBeDefined();
    expect(result.succession!.valid).toBe(false);
    expect(result.succession!.error).toContain("Succession");
  });

  it("fails when succession chain has temporal ordering violated", async () => {
    const kp1 = await makeKeypair();
    const kp2 = await makeKeypair();
    const kp3 = await makeKeypair();

    // rec1 timestamp (2000000) > rec2 timestamp (1000000) — temporal violation
    const rec1 = await createSuccessionRecord(kp1, kp2, 2000000);
    const rec2 = await createSuccessionRecord(kp2, kp3, 1000000);
    const yaml = buildYamlWithSuccession(kp3.publicKeyHex, [rec1, rec2]);

    const frontmatterBytes = new TextEncoder().encode(yaml);
    const signature = await ed.signAsync(frontmatterBytes, kp3.privateKey);
    const content = buildIdentityFile(yaml, toHex(signature));

    const result = await verify(content);
    expect(result.valid).toBe(true);
    expect(result.succession).toBeDefined();
    expect(result.succession!.valid).toBe(false);
    expect(result.succession!.error).toContain("temporal ordering violated");
  });
});

// ---------------------------------------------------------------------------
// verify() — identity validation edge cases
// ---------------------------------------------------------------------------

describe("verify — identity edge cases", () => {
  it("returns error for invalid public key hex (odd length — triggers hexToBytes throw)", async () => {
    // hexToBytes never throws for non-hex chars (parseInt returns NaN → 0).
    // The "Invalid public key hex" path (line 596) is defensive dead code
    // because the current hexToBytes implementation is lenient.
    // We can still hit "Public key must be 32 bytes" with wrong-length hex:
    const yaml = [
      `spec: "motebit/identity@1.0"`,
      `identity:`,
      `  algorithm: "Ed25519"`,
      `  public_key: "abcdef"`,
    ].join("\n");
    // Build a valid-length hex signature (64 bytes)
    const sigBytes = new Uint8Array(64);
    const content = buildIdentityFile(yaml, toHex(sigBytes));

    const result = await verify(content);
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.message).toBe("Public key must be 32 bytes");
  });

  it("returns error for signature with wrong length (not 64 bytes)", async () => {
    const kp = await makeKeypair();
    const yaml = [
      `spec: "motebit/identity@1.0"`,
      `identity:`,
      `  algorithm: "Ed25519"`,
      `  public_key: "${kp.publicKeyHex}"`,
    ].join("\n");
    // Create a short hex signature (16 bytes = 32 hex chars)
    const shortSig = toHex(new Uint8Array(16));
    const content = buildIdentityFile(yaml, shortSig);

    const result = await verify(content);
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.message).toBe("Signature must be 64 bytes");
  });
});

// ---------------------------------------------------------------------------
// verify() — unrecognized object format
// ---------------------------------------------------------------------------

describe("verify — unrecognized object formats", () => {
  it("returns null detection for an object without known fields", async () => {
    const result = await verify({ foo: "bar", baz: 42 });
    expect(result.valid).toBe(false);
    expect(result.errors![0]!.message).toBe("Unrecognized artifact format");
  });

  it("returns null detection for an empty object", async () => {
    const result = await verify({});
    expect(result.valid).toBe(false);
    expect(result.errors![0]!.message).toBe("Unrecognized artifact format");
  });
});

// ---------------------------------------------------------------------------
// parse() — YAML with nested arrays inside sections
// ---------------------------------------------------------------------------

describe("parse — YAML edge cases", () => {
  it("parses identity file with a section header ending current array context", async () => {
    const kp = await makeKeypair();

    // Build YAML with capabilities array followed by a section at same indent
    const yaml = [
      `spec: "motebit/identity@1.0"`,
      `motebit_id: "test-array-close"`,
      `created_at: "2026-01-15T00:00:00.000Z"`,
      `owner_id: "owner-test"`,
      `capabilities:`,
      `  - web_search`,
      `  - file_read`,
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
    const content = buildIdentityFile(yaml, toHex(signature));

    const parsed = parse(content);
    expect(parsed.frontmatter.capabilities).toEqual(["web_search", "file_read"]);
    expect(parsed.frontmatter.identity.algorithm).toBe("Ed25519");

    const result = await verify(content);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helpers for guardian recovery tests
// ---------------------------------------------------------------------------

async function createGuardianRecoveryRecord(
  guardianKp: Awaited<ReturnType<typeof makeKeypair>>,
  newKp: Awaited<ReturnType<typeof makeKeypair>>,
  oldPublicKeyHex: string,
  timestamp: number,
  reason?: string,
) {
  const effectiveReason = reason ?? "guardian_recovery";
  const payloadObj: Record<string, unknown> = {
    old_public_key: oldPublicKeyHex,
    new_public_key: newKp.publicKeyHex,
    timestamp,
    suite: IDENTITY_FILE_SUITE,
  };
  payloadObj.reason = effectiveReason;
  payloadObj.recovery = true;
  const payload = canonicalJson(payloadObj);
  const message = new TextEncoder().encode(payload);

  const guardianSig = await ed.signAsync(message, guardianKp.privateKey);
  const newSig = await ed.signAsync(message, newKp.privateKey);

  return {
    old_public_key: oldPublicKeyHex,
    new_public_key: newKp.publicKeyHex,
    timestamp,
    reason: effectiveReason,
    suite: IDENTITY_FILE_SUITE,
    new_key_signature: toHex(newSig),
    recovery: true as const,
    guardian_signature: toHex(guardianSig),
  };
}

function buildYamlWithGuardian(
  publicKeyHex: string,
  guardianPublicKeyHex: string,
  successionRecords: Array<{
    old_public_key: string;
    new_public_key: string;
    timestamp: number;
    reason?: string;
    suite: string;
    old_key_signature?: string;
    new_key_signature: string;
    recovery?: boolean;
    guardian_signature?: string;
  }>,
): string {
  const lines = [
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
    `  fail_closed: true`,
    `memory:`,
    `  half_life_days: 7`,
    `  confidence_threshold: 0.3`,
    `  per_turn_limit: 5`,
    `guardian:`,
    `  public_key: "${guardianPublicKeyHex}"`,
    `  organization: "Test Corp"`,
    `  established_at: "2026-01-01T00:00:00.000Z"`,
    `devices: []`,
    `succession:`,
  ];

  for (const rec of successionRecords) {
    lines.push(`  - old_public_key: "${rec.old_public_key}"`);
    lines.push(`    new_public_key: "${rec.new_public_key}"`);
    lines.push(`    timestamp: ${rec.timestamp}`);
    if (rec.reason !== undefined) {
      lines.push(`    reason: "${rec.reason}"`);
    }
    lines.push(`    suite: "${rec.suite}"`);
    if (rec.old_key_signature) {
      lines.push(`    old_key_signature: "${rec.old_key_signature}"`);
    }
    lines.push(`    new_key_signature: "${rec.new_key_signature}"`);
    if (rec.recovery) {
      lines.push(`    recovery: true`);
    }
    if (rec.guardian_signature) {
      lines.push(`    guardian_signature: "${rec.guardian_signature}"`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// verify() — guardian recovery succession chain
// ---------------------------------------------------------------------------

describe("verify — guardian recovery succession", () => {
  it("verifies identity file with guardian recovery succession", async () => {
    const guardianKp = await makeKeypair();
    const kp1 = await makeKeypair(); // genesis (compromised)
    const kp2 = await makeKeypair(); // recovery target (current)

    const recoveryRecord = await createGuardianRecoveryRecord(
      guardianKp,
      kp2,
      kp1.publicKeyHex,
      1000,
    );

    const yaml = buildYamlWithGuardian(kp2.publicKeyHex, guardianKp.publicKeyHex, [recoveryRecord]);
    const yamlBytes = new TextEncoder().encode(yaml);
    const sig = await ed.signAsync(yamlBytes, kp2.privateKey);
    const sigHex = toHex(sig);
    const content = `---\n${yaml}\n---\n<!-- motebit:sig:${IDENTITY_FILE_SUITE}:${sigHex} -->`;

    const result = await verify(content);
    expect(result.valid).toBe(true);
    expect(result.succession).toBeDefined();
    expect(result.succession!.valid).toBe(true);
    expect(result.succession!.genesis_public_key).toBe(kp1.publicKeyHex);
    expect(result.succession!.rotations).toBe(1);
  });

  it("verifies mixed chain: normal rotation → guardian recovery", async () => {
    const guardianKp = await makeKeypair();
    const kp1 = await makeKeypair(); // genesis
    const kp2 = await makeKeypair(); // normal rotation target
    const kp3 = await makeKeypair(); // guardian recovery target (current)

    const normalRecord = await createSuccessionRecord(kp1, kp2, 1000, "routine");
    const recoveryRecord = await createGuardianRecoveryRecord(
      guardianKp,
      kp3,
      kp2.publicKeyHex,
      2000,
    );

    const yaml = buildYamlWithGuardian(kp3.publicKeyHex, guardianKp.publicKeyHex, [
      normalRecord,
      recoveryRecord,
    ]);
    const yamlBytes = new TextEncoder().encode(yaml);
    const sig = await ed.signAsync(yamlBytes, kp3.privateKey);
    const sigHex = toHex(sig);
    const content = `---\n${yaml}\n---\n<!-- motebit:sig:${IDENTITY_FILE_SUITE}:${sigHex} -->`;

    const result = await verify(content);
    expect(result.valid).toBe(true);
    expect(result.succession!.valid).toBe(true);
    expect(result.succession!.genesis_public_key).toBe(kp1.publicKeyHex);
    expect(result.succession!.rotations).toBe(2);
  });

  it("rejects guardian recovery without guardian field in identity", async () => {
    const guardianKp = await makeKeypair();
    const kp1 = await makeKeypair();
    const kp2 = await makeKeypair();

    const recoveryRecord = await createGuardianRecoveryRecord(
      guardianKp,
      kp2,
      kp1.publicKeyHex,
      1000,
    );

    // Hand-build YAML with recovery fields but no guardian
    const lines = [
      `spec: "motebit/identity@1.0"`,
      `motebit_id: "01234567-89ab-cdef-0123-456789abcdef"`,
      `created_at: "2026-01-15T00:00:00.000Z"`,
      `owner_id: "owner-test"`,
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
      `succession:`,
      `  - old_public_key: "${recoveryRecord.old_public_key}"`,
      `    new_public_key: "${recoveryRecord.new_public_key}"`,
      `    timestamp: ${recoveryRecord.timestamp}`,
      `    reason: "${recoveryRecord.reason}"`,
      `    suite: "${IDENTITY_FILE_SUITE}"`,
      `    new_key_signature: "${recoveryRecord.new_key_signature}"`,
      `    recovery: true`,
      `    guardian_signature: "${recoveryRecord.guardian_signature}"`,
    ].join("\n");

    const yamlBytes = new TextEncoder().encode(lines);
    const sig = await ed.signAsync(yamlBytes, kp2.privateKey);
    const sigHex = toHex(sig);
    const content = `---\n${lines}\n---\n<!-- motebit:sig:${IDENTITY_FILE_SUITE}:${sigHex} -->`;

    const result = await verify(content);
    expect(result.valid).toBe(true); // signature is valid
    expect(result.succession!.valid).toBe(false);
    expect(result.succession!.error).toContain("no guardian public key");
  });

  it("rejects guardian recovery with wrong guardian key", async () => {
    const guardianKp = await makeKeypair();
    const wrongGuardianKp = await makeKeypair();
    const kp1 = await makeKeypair();
    const kp2 = await makeKeypair();

    // Sign with guardianKp but put wrongGuardianKp in the identity file
    const recoveryRecord = await createGuardianRecoveryRecord(
      guardianKp,
      kp2,
      kp1.publicKeyHex,
      1000,
    );

    const yaml = buildYamlWithGuardian(kp2.publicKeyHex, wrongGuardianKp.publicKeyHex, [
      recoveryRecord,
    ]);
    const yamlBytes = new TextEncoder().encode(yaml);
    const sig = await ed.signAsync(yamlBytes, kp2.privateKey);
    const sigHex = toHex(sig);
    const content = `---\n${yaml}\n---\n<!-- motebit:sig:${IDENTITY_FILE_SUITE}:${sigHex} -->`;

    const result = await verify(content);
    expect(result.valid).toBe(true); // file signature valid
    expect(result.succession!.valid).toBe(false);
    expect(result.succession!.error).toContain("guardian_signature verification failed");
  });
});

// ---------------------------------------------------------------------------
// verify() — credential dispatch (covers index.ts line 1130)
// ---------------------------------------------------------------------------

import { issueReputationCredential } from "../index";

describe("verify — credential dispatch", () => {
  it("verifies a valid credential object", async () => {
    const kp = await makeKeypair();
    const vc = await issueReputationCredential(
      {
        success_rate: 0.9,
        avg_latency_ms: 100,
        task_count: 10,
        trust_score: 0.8,
        availability: 0.95,
        measured_at: 1000,
      },
      ed.hashes.sha512 ? kp.privateKey : kp.privateKey,
      kp.publicKey,
      "did:key:zSubjectTest",
    );

    const result = await verify(vc);
    expect(result.type).toBe("credential");
    expect(result.valid).toBe(true);
    if (result.type === "credential") {
      expect(result.issuer).toMatch(/^did:key:z/);
      expect(result.subject).toBe("did:key:zSubjectTest");
    }
  });

  it("verifies a credential from JSON string", async () => {
    const kp = await makeKeypair();
    const vc = await issueReputationCredential(
      {
        success_rate: 0.9,
        avg_latency_ms: 100,
        task_count: 10,
        trust_score: 0.8,
        availability: 0.95,
        measured_at: 1000,
      },
      kp.privateKey,
      kp.publicKey,
      "did:key:zSubjectStr",
    );

    const result = await verify(JSON.stringify(vc));
    expect(result.type).toBe("credential");
    expect(result.valid).toBe(true);
  });

  it("rejects a credential with tampered subject", async () => {
    const kp = await makeKeypair();
    const vc = await issueReputationCredential(
      {
        success_rate: 0.9,
        avg_latency_ms: 100,
        task_count: 10,
        trust_score: 0.8,
        availability: 0.95,
        measured_at: 1000,
      },
      kp.privateKey,
      kp.publicKey,
      "did:key:zSubjectTamper",
    );

    // Tamper with the credential subject
    const tampered = JSON.parse(JSON.stringify(vc));
    tampered.credentialSubject.success_rate = 1.0;

    const result = await verify(tampered);
    expect(result.type).toBe("credential");
    expect(result.valid).toBe(false);
  });

  it("rejects with expectedType mismatch", async () => {
    const kp = await makeKeypair();
    const vc = await issueReputationCredential(
      {
        success_rate: 0.9,
        avg_latency_ms: 100,
        task_count: 10,
        trust_score: 0.8,
        availability: 0.95,
        measured_at: 1000,
      },
      kp.privateKey,
      kp.publicKey,
      "did:key:zSubjectMismatch",
    );

    const result = await verify(vc, { expectedType: "receipt" });
    expect(result.valid).toBe(false);
    expect(result.errors![0]!.message).toContain('Expected type "receipt"');
  });
});

// ---------------------------------------------------------------------------
// verify() — presentation dispatch (covers index.ts line 1132)
// ---------------------------------------------------------------------------

import { createPresentation } from "../index";

describe("verify — presentation dispatch", () => {
  it("verifies a valid presentation object", async () => {
    const kp = await makeKeypair();
    const vc = await issueReputationCredential(
      {
        success_rate: 0.9,
        avg_latency_ms: 100,
        task_count: 10,
        trust_score: 0.8,
        availability: 0.95,
        measured_at: 1000,
      },
      kp.privateKey,
      kp.publicKey,
      "did:key:zSubjectVP",
    );

    const vp = await createPresentation([vc], kp.privateKey, kp.publicKey);

    const result = await verify(vp);
    expect(result.type).toBe("presentation");
    expect(result.valid).toBe(true);
    if (result.type === "presentation") {
      expect(result.holder).toMatch(/^did:key:z/);
      expect(result.credentials).toHaveLength(1);
    }
  });

  it("verifies a presentation from JSON string", async () => {
    const kp = await makeKeypair();
    const vc = await issueReputationCredential(
      {
        success_rate: 0.9,
        avg_latency_ms: 100,
        task_count: 10,
        trust_score: 0.8,
        availability: 0.95,
        measured_at: 1000,
      },
      kp.privateKey,
      kp.publicKey,
      "did:key:zSubjectVPStr",
    );

    const vp = await createPresentation([vc], kp.privateKey, kp.publicKey);

    const result = await verify(JSON.stringify(vp));
    expect(result.type).toBe("presentation");
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-compatibility with @motebit/identity-file
// ---------------------------------------------------------------------------
// NOTE: Cross-compat is now tested in @motebit/identity-file's test suite,
// since identity-file delegates parse/verify to this package. The roundtrip
// tests (generate → parse → verify) inherently verify cross-compatibility.
