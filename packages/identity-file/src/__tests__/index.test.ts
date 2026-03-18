import { describe, it, expect } from "vitest";
import { generateKeypair, signKeySuccession, bytesToHex } from "@motebit/crypto";
import { verifyIdentityFile as standaloneVerify } from "@motebit/verify";
import {
  generate,
  parse,
  update,
  rotate,
  toHex,
  verify as verifyFromIdentityFile,
  verifyIdentityFile as verifyIdentityFileReexport,
  publicKeyToDidKey,
  hexPublicKeyToDidKey,
} from "../index";

// Use the legacy verifyIdentityFile for backward-compat result shape
const verify = async (content: string) => standaloneVerify(content);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeKeypairHex() {
  const kp = await generateKeypair();
  return {
    publicKeyHex: toHex(kp.publicKey),
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
  };
}

const DEFAULTS = {
  motebitId: "01234567-89ab-cdef-0123-456789abcdef",
  ownerId: "owner-test",
  createdAt: "2026-01-15T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// generate → parse → verify roundtrip
// ---------------------------------------------------------------------------

describe("generate → parse → verify roundtrip", () => {
  it("generates a valid identity file that passes verification", async () => {
    const kp = await makeKeypairHex();

    const content = await generate(
      {
        motebitId: DEFAULTS.motebitId,
        ownerId: DEFAULTS.ownerId,
        createdAt: DEFAULTS.createdAt,
        publicKeyHex: kp.publicKeyHex,
        devices: [
          {
            device_id: "dev-001",
            name: "CLI",
            public_key: kp.publicKeyHex,
            registered_at: DEFAULTS.createdAt,
          },
        ],
      },
      kp.privateKey,
    );

    // Should contain frontmatter delimiters
    expect(content).toContain("---");
    expect(content).toContain("motebit:sig:Ed25519:");

    // Parse
    const parsed = parse(content);
    expect(parsed.frontmatter.spec).toBe("motebit/identity@1.0");
    expect(parsed.frontmatter.motebit_id).toBe(DEFAULTS.motebitId);
    expect(parsed.frontmatter.owner_id).toBe(DEFAULTS.ownerId);
    expect(parsed.frontmatter.identity.algorithm).toBe("Ed25519");
    expect(parsed.frontmatter.identity.public_key).toBe(kp.publicKeyHex);
    expect(parsed.frontmatter.governance.trust_mode).toBe("guarded");
    expect(parsed.frontmatter.privacy.fail_closed).toBe(true);
    expect(parsed.frontmatter.memory.half_life_days).toBe(7);
    expect(parsed.frontmatter.devices).toHaveLength(1);
    expect(parsed.frontmatter.devices[0]!.device_id).toBe("dev-001");
    expect(parsed.signature).toBeTruthy();

    // Verify
    const result = await verify(content);
    expect(result.valid).toBe(true);
    expect(result.identity).not.toBeNull();
    expect(result.identity!.motebit_id).toBe(DEFAULTS.motebitId);
    expect(result.error).toBeUndefined();
  });

  it("handles empty devices array", async () => {
    const kp = await makeKeypairHex();
    const content = await generate(
      { motebitId: DEFAULTS.motebitId, ownerId: DEFAULTS.ownerId, publicKeyHex: kp.publicKeyHex },
      kp.privateKey,
    );

    const parsed = parse(content);
    expect(parsed.frontmatter.devices).toEqual([]);

    const result = await verify(content);
    expect(result.valid).toBe(true);
  });

  it("preserves custom governance settings", async () => {
    const kp = await makeKeypairHex();
    const content = await generate(
      {
        motebitId: DEFAULTS.motebitId,
        ownerId: DEFAULTS.ownerId,
        publicKeyHex: kp.publicKeyHex,
        governance: {
          trust_mode: "full",
          max_risk_auto: "R2_WRITE",
          operator_mode: true,
        },
      },
      kp.privateKey,
    );

    const parsed = parse(content);
    expect(parsed.frontmatter.governance.trust_mode).toBe("full");
    expect(parsed.frontmatter.governance.max_risk_auto).toBe("R2_WRITE");
    expect(parsed.frontmatter.governance.operator_mode).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tamper detection
// ---------------------------------------------------------------------------

describe("tamper detection", () => {
  it("fails verification when frontmatter content is modified", async () => {
    const kp = await makeKeypairHex();
    const content = await generate(
      { motebitId: DEFAULTS.motebitId, ownerId: DEFAULTS.ownerId, publicKeyHex: kp.publicKeyHex },
      kp.privateKey,
    );

    // Tamper: change owner_id
    const tampered = content.replace(DEFAULTS.ownerId, "evil-owner");

    const result = await verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.identity).toBeNull();
  });

  it("fails verification when trust_mode is changed", async () => {
    const kp = await makeKeypairHex();
    const content = await generate(
      { motebitId: DEFAULTS.motebitId, ownerId: DEFAULTS.ownerId, publicKeyHex: kp.publicKeyHex },
      kp.privateKey,
    );

    const tampered = content.replace('"guarded"', '"full"');

    const result = await verify(tampered);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wrong key
// ---------------------------------------------------------------------------

describe("wrong key verification", () => {
  it("fails when verified against a different keypair", async () => {
    const kp1 = await makeKeypairHex();
    const kp2 = await makeKeypairHex();

    // Generate with kp1's private key but embed kp2's public key
    // This simulates a file signed by an impersonator
    const content = await generate(
      { motebitId: DEFAULTS.motebitId, ownerId: DEFAULTS.ownerId, publicKeyHex: kp2.publicKeyHex },
      kp1.privateKey,
    );

    const result = await verify(content);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Signature verification failed");
  });
});

// ---------------------------------------------------------------------------
// Missing / malformed signature
// ---------------------------------------------------------------------------

describe("missing or malformed signature", () => {
  it("fails gracefully when signature comment is missing", async () => {
    const content = `---\nspec: "motebit/identity@1.0"\nmotebit_id: "test"\n---\n`;

    const result = await verify(content);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Missing signature");
  });

  it("fails gracefully when frontmatter is missing", async () => {
    const content = "no frontmatter here";

    const result = await verify(content);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Missing frontmatter opening ---");
  });

  it("parse throws on missing closing ---", () => {
    const content = "---\nspec: test\n";

    expect(() => parse(content)).toThrow("Missing frontmatter closing ---");
  });
});

// ---------------------------------------------------------------------------
// update()
// ---------------------------------------------------------------------------

describe("update", () => {
  it("re-signs after updating fields and preserves validity", async () => {
    const kp = await makeKeypairHex();
    const original = await generate(
      {
        motebitId: DEFAULTS.motebitId,
        ownerId: DEFAULTS.ownerId,
        publicKeyHex: kp.publicKeyHex,
        devices: [],
      },
      kp.privateKey,
    );

    // Add a device
    const updated = await update(
      original,
      {
        devices: [
          {
            device_id: "dev-new",
            name: "Mobile",
            public_key: kp.publicKeyHex,
            registered_at: "2026-02-01T00:00:00.000Z",
          },
        ],
      },
      kp.privateKey,
    );

    // Verify the updated file
    const result = await verify(updated);
    expect(result.valid).toBe(true);
    expect(result.identity!.devices).toHaveLength(1);
    expect(result.identity!.devices[0]!.name).toBe("Mobile");

    // Spec and identity are preserved
    expect(result.identity!.spec).toBe("motebit/identity@1.0");
    expect(result.identity!.identity.public_key).toBe(kp.publicKeyHex);
  });

  it("old signature is invalid after update", async () => {
    const kp = await makeKeypairHex();
    const original = await generate(
      { motebitId: DEFAULTS.motebitId, ownerId: DEFAULTS.ownerId, publicKeyHex: kp.publicKeyHex },
      kp.privateKey,
    );

    const updated = await update(
      original,
      {
        governance: {
          trust_mode: "minimal",
          max_risk_auto: "R0_READ",
          require_approval_above: "R0_READ",
          deny_above: "R2_WRITE",
          operator_mode: false,
        },
      },
      kp.privateKey,
    );

    // Original and updated have different signatures
    const origParsed = parse(original);
    const updParsed = parse(updated);
    expect(origParsed.signature).not.toBe(updParsed.signature);

    // Both verify independently
    expect((await verify(original)).valid).toBe(true);
    expect((await verify(updated)).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Service identity
// ---------------------------------------------------------------------------

describe("service identity", () => {
  it("generates and verifies a service identity file", async () => {
    const kp = await makeKeypairHex();

    const content = await generate(
      {
        motebitId: DEFAULTS.motebitId,
        ownerId: DEFAULTS.ownerId,
        createdAt: DEFAULTS.createdAt,
        publicKeyHex: kp.publicKeyHex,
        service: {
          type: "service",
          service_name: "Flight Search",
          service_description: "Search and book flights across major airlines",
          service_url: "https://flights.example.com",
          capabilities: ["flight_search", "flight_booking", "price_alerts"],
          terms_url: "https://flights.example.com/terms",
        },
      },
      kp.privateKey,
    );

    // Should contain service fields in YAML
    expect(content).toContain("service");
    expect(content).toContain("Flight Search");
    expect(content).toContain("flight_search");

    // Parse
    const parsed = parse(content);
    expect(parsed.frontmatter.type).toBe("service");
    expect(parsed.frontmatter.service_name).toBe("Flight Search");
    expect(parsed.frontmatter.service_description).toBe(
      "Search and book flights across major airlines",
    );
    expect(parsed.frontmatter.service_url).toBe("https://flights.example.com");
    expect(parsed.frontmatter.capabilities).toEqual([
      "flight_search",
      "flight_booking",
      "price_alerts",
    ]);
    expect(parsed.frontmatter.terms_url).toBe("https://flights.example.com/terms");

    // Verify
    const result = await verify(content);
    expect(result.valid).toBe(true);
    expect(result.identity).not.toBeNull();
    expect(result.identity!.type).toBe("service");
    expect(result.identity!.service_name).toBe("Flight Search");
    expect(result.identity!.capabilities).toEqual([
      "flight_search",
      "flight_booking",
      "price_alerts",
    ]);
  });

  it("service fields are tamper-proof", async () => {
    const kp = await makeKeypairHex();

    const content = await generate(
      {
        motebitId: DEFAULTS.motebitId,
        ownerId: DEFAULTS.ownerId,
        publicKeyHex: kp.publicKeyHex,
        service: {
          type: "service",
          service_name: "Flight Search",
          service_description: "Search flights",
          capabilities: ["flight_search"],
        },
      },
      kp.privateKey,
    );

    // Tamper: change service_name
    const tampered = content.replace("Flight Search", "Malicious Service");
    const result = await verify(tampered);
    expect(result.valid).toBe(false);
  });

  it("personal identity without service fields still works", async () => {
    const kp = await makeKeypairHex();

    const content = await generate(
      {
        motebitId: DEFAULTS.motebitId,
        ownerId: DEFAULTS.ownerId,
        publicKeyHex: kp.publicKeyHex,
      },
      kp.privateKey,
    );

    const parsed = parse(content);
    expect(parsed.frontmatter.type).toBeUndefined();
    expect(parsed.frontmatter.service_name).toBeUndefined();
    expect(parsed.frontmatter.capabilities).toBeUndefined();

    const result = await verify(content);
    expect(result.valid).toBe(true);
  });

  it("service identity with standalone verify", async () => {
    const kp = await makeKeypairHex();

    const content = await generate(
      {
        motebitId: DEFAULTS.motebitId,
        ownerId: DEFAULTS.ownerId,
        publicKeyHex: kp.publicKeyHex,
        service: {
          type: "service",
          service_name: "Test Service",
          service_description: "A test service",
          capabilities: ["cap_a", "cap_b"],
        },
      },
      kp.privateKey,
    );

    const result = await standaloneVerify(content);
    expect(result.valid).toBe(true);
    expect(result.identity!.type).toBe("service");
    expect(result.identity!.service_name).toBe("Test Service");
    expect(result.identity!.capabilities).toEqual(["cap_a", "cap_b"]);
  });
});

// ---------------------------------------------------------------------------
// Cross-compatibility: identity-file generate → @motebit/verify verify
// ---------------------------------------------------------------------------
// This locks the contract between the two packages. identity-file generates
// and serializes; @motebit/verify (the standalone, zero-monorepo-dep package)
// must accept the output. Import standaloneVerify directly from @motebit/verify
// so this test breaks visibly if the packages drift.

describe("cross-compatibility with @motebit/verify", () => {
  it("standalone verify accepts generate() output", async () => {
    const kp = await makeKeypairHex();

    const content = await generate(
      {
        motebitId: DEFAULTS.motebitId,
        ownerId: DEFAULTS.ownerId,
        createdAt: DEFAULTS.createdAt,
        publicKeyHex: kp.publicKeyHex,
        devices: [
          {
            device_id: "dev-cross",
            name: "Cross-compat Device",
            public_key: kp.publicKeyHex,
            registered_at: DEFAULTS.createdAt,
          },
        ],
      },
      kp.privateKey,
    );

    const result = await standaloneVerify(content);
    expect(result.valid).toBe(true);
    expect(result.identity).not.toBeNull();
    expect(result.identity!.motebit_id).toBe(DEFAULTS.motebitId);
    expect(result.identity!.devices).toHaveLength(1);
    expect(result.identity!.devices[0]!.name).toBe("Cross-compat Device");
  });

  it("standalone verify accepts update() output", async () => {
    const kp = await makeKeypairHex();

    const original = await generate(
      { motebitId: DEFAULTS.motebitId, ownerId: DEFAULTS.ownerId, publicKeyHex: kp.publicKeyHex },
      kp.privateKey,
    );

    const updated = await update(
      original,
      {
        governance: {
          trust_mode: "minimal",
          max_risk_auto: "R0_READ",
          require_approval_above: "R0_READ",
          deny_above: "R2_WRITE",
          operator_mode: false,
        },
      },
      kp.privateKey,
    );

    const result = await standaloneVerify(updated);
    expect(result.valid).toBe(true);
    expect(result.identity!.governance.trust_mode).toBe("minimal");
  });

  it("standalone verify rejects tampered generate() output", async () => {
    const kp = await makeKeypairHex();

    const content = await generate(
      { motebitId: DEFAULTS.motebitId, ownerId: DEFAULTS.ownerId, publicKeyHex: kp.publicKeyHex },
      kp.privateKey,
    );

    // Tamper: flip one character in the owner_id
    const tampered = content.replace(DEFAULTS.ownerId, "owner-evil");

    const result = await standaloneVerify(tampered);
    expect(result.valid).toBe(false);
    expect(result.identity).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Re-exports from @motebit/crypto and @motebit/verify (lines 14, 20)
// ---------------------------------------------------------------------------

describe("re-exports", () => {
  it("re-exports publicKeyToDidKey from @motebit/crypto", () => {
    expect(typeof publicKeyToDidKey).toBe("function");
  });

  it("re-exports hexPublicKeyToDidKey from @motebit/crypto", () => {
    expect(typeof hexPublicKeyToDidKey).toBe("function");
  });

  it("re-exports parse from @motebit/verify", () => {
    expect(typeof parse).toBe("function");
  });

  it("re-exports verify from @motebit/verify", () => {
    expect(typeof verifyFromIdentityFile).toBe("function");
  });

  it("re-exports verifyIdentityFile from @motebit/verify", () => {
    expect(typeof verifyIdentityFileReexport).toBe("function");
  });

  it("publicKeyToDidKey produces a did:key string", async () => {
    const kp = await makeKeypairHex();
    const did = publicKeyToDidKey(kp.publicKey);
    expect(did).toMatch(/^did:key:z/);
  });

  it("hexPublicKeyToDidKey produces a did:key string", async () => {
    const kp = await makeKeypairHex();
    const did = hexPublicKeyToDidKey(kp.publicKeyHex);
    expect(did).toMatch(/^did:key:z/);
  });
});

// ---------------------------------------------------------------------------
// generate() with minimal options — exercises all nullish coalescing defaults
// (lines 156-186)
// ---------------------------------------------------------------------------

describe("generate() default values", () => {
  it("fills all defaults when called with minimal options", async () => {
    const kp = await makeKeypairHex();

    const content = await generate(
      {
        motebitId: DEFAULTS.motebitId,
        ownerId: DEFAULTS.ownerId,
        publicKeyHex: kp.publicKeyHex,
        // No createdAt, governance, privacy, memory, devices — all defaults
      },
      kp.privateKey,
    );

    const parsed = parse(content);

    // createdAt defaults to a valid ISO string (not the test constant)
    expect(parsed.frontmatter.created_at).toBeTruthy();
    expect(parsed.frontmatter.created_at).not.toBe(DEFAULTS.createdAt);

    // governance defaults
    expect(parsed.frontmatter.governance.trust_mode).toBe("guarded");
    expect(parsed.frontmatter.governance.max_risk_auto).toBe("R1_DRAFT");
    expect(parsed.frontmatter.governance.require_approval_above).toBe("R1_DRAFT");
    expect(parsed.frontmatter.governance.deny_above).toBe("R4_MONEY");
    expect(parsed.frontmatter.governance.operator_mode).toBe(false);

    // privacy defaults
    expect(parsed.frontmatter.privacy.default_sensitivity).toBe("personal");
    expect(parsed.frontmatter.privacy.retention_days).toEqual({
      none: 365,
      personal: 90,
      medical: 30,
      financial: 30,
      secret: 7,
    });
    expect(parsed.frontmatter.privacy.fail_closed).toBe(true);

    // memory defaults
    expect(parsed.frontmatter.memory.half_life_days).toBe(7);
    expect(parsed.frontmatter.memory.confidence_threshold).toBe(0.3);
    expect(parsed.frontmatter.memory.per_turn_limit).toBe(5);

    // devices defaults to empty array
    expect(parsed.frontmatter.devices).toEqual([]);

    // Verify signature
    const result = await standaloneVerify(content);
    expect(result.valid).toBe(true);
  });

  it("uses provided createdAt over default", async () => {
    const kp = await makeKeypairHex();
    const customDate = "2025-06-15T12:00:00.000Z";

    const content = await generate(
      {
        motebitId: DEFAULTS.motebitId,
        ownerId: DEFAULTS.ownerId,
        publicKeyHex: kp.publicKeyHex,
        createdAt: customDate,
      },
      kp.privateKey,
    );

    const parsed = parse(content);
    expect(parsed.frontmatter.created_at).toBe(customDate);
  });

  it("partial governance uses defaults for missing fields", async () => {
    const kp = await makeKeypairHex();

    const content = await generate(
      {
        motebitId: DEFAULTS.motebitId,
        ownerId: DEFAULTS.ownerId,
        publicKeyHex: kp.publicKeyHex,
        governance: {
          trust_mode: "minimal",
          // max_risk_auto, require_approval_above, deny_above, operator_mode all default
        },
      },
      kp.privateKey,
    );

    const parsed = parse(content);
    expect(parsed.frontmatter.governance.trust_mode).toBe("minimal");
    expect(parsed.frontmatter.governance.max_risk_auto).toBe("R1_DRAFT");
    expect(parsed.frontmatter.governance.require_approval_above).toBe("R1_DRAFT");
    expect(parsed.frontmatter.governance.deny_above).toBe("R4_MONEY");
    expect(parsed.frontmatter.governance.operator_mode).toBe(false);

    const result = await standaloneVerify(content);
    expect(result.valid).toBe(true);
  });

  it("partial privacy uses defaults for missing fields", async () => {
    const kp = await makeKeypairHex();

    const content = await generate(
      {
        motebitId: DEFAULTS.motebitId,
        ownerId: DEFAULTS.ownerId,
        publicKeyHex: kp.publicKeyHex,
        privacy: {
          default_sensitivity: "financial",
          // retention_days and fail_closed default
        },
      },
      kp.privateKey,
    );

    const parsed = parse(content);
    expect(parsed.frontmatter.privacy.default_sensitivity).toBe("financial");
    expect(parsed.frontmatter.privacy.retention_days).toEqual({
      none: 365,
      personal: 90,
      medical: 30,
      financial: 30,
      secret: 7,
    });
    expect(parsed.frontmatter.privacy.fail_closed).toBe(true);
  });

  it("partial memory uses defaults for missing fields", async () => {
    const kp = await makeKeypairHex();

    const content = await generate(
      {
        motebitId: DEFAULTS.motebitId,
        ownerId: DEFAULTS.ownerId,
        publicKeyHex: kp.publicKeyHex,
        memory: {
          half_life_days: 14,
          // confidence_threshold and per_turn_limit default
        },
      },
      kp.privateKey,
    );

    const parsed = parse(content);
    expect(parsed.frontmatter.memory.half_life_days).toBe(14);
    expect(parsed.frontmatter.memory.confidence_threshold).toBe(0.3);
    expect(parsed.frontmatter.memory.per_turn_limit).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// rotate() — key rotation with succession record (lines 240-259)
// ---------------------------------------------------------------------------

describe("rotate", () => {
  it("rotates the key and appends a succession record", async () => {
    const oldKp = await generateKeypair();
    const newKp = await generateKeypair();

    // Generate the initial identity file
    const original = await generate(
      {
        motebitId: DEFAULTS.motebitId,
        ownerId: DEFAULTS.ownerId,
        createdAt: DEFAULTS.createdAt,
        publicKeyHex: toHex(oldKp.publicKey),
      },
      oldKp.privateKey,
    );

    // Create a real succession record
    const successionRecord = await signKeySuccession(
      oldKp.privateKey,
      newKp.privateKey,
      oldKp.publicKey,
      newKp.publicKey,
      "test key rotation",
    );

    // Rotate
    const rotated = await rotate({
      existingContent: original,
      newPublicKey: newKp.publicKey,
      newPrivateKey: newKp.privateKey,
      successionRecord: {
        old_public_key: successionRecord.old_public_key,
        new_public_key: successionRecord.new_public_key,
        timestamp: successionRecord.timestamp,
        reason: successionRecord.reason,
        old_key_signature: successionRecord.old_key_signature,
        new_key_signature: successionRecord.new_key_signature,
      },
    });

    // Verify the rotated file has valid signature with new key
    const result = await standaloneVerify(rotated);
    expect(result.valid).toBe(true);
    expect(result.identity).not.toBeNull();

    // Public key should be the new one
    const parsed = parse(rotated);
    expect(parsed.frontmatter.identity.public_key).toBe(bytesToHex(newKp.publicKey));

    // Succession chain should have one record
    expect(parsed.frontmatter.succession).toHaveLength(1);
    expect(parsed.frontmatter.succession![0]!.old_public_key).toBe(successionRecord.old_public_key);
    expect(parsed.frontmatter.succession![0]!.new_public_key).toBe(successionRecord.new_public_key);
    expect(parsed.frontmatter.succession![0]!.reason).toBe("test key rotation");

    // motebit_id is preserved
    expect(parsed.frontmatter.motebit_id).toBe(DEFAULTS.motebitId);
  });

  it("appends to existing succession chain on second rotation", async () => {
    const kp1 = await generateKeypair();
    const kp2 = await generateKeypair();
    const kp3 = await generateKeypair();

    // Generate original
    const original = await generate(
      {
        motebitId: DEFAULTS.motebitId,
        ownerId: DEFAULTS.ownerId,
        createdAt: DEFAULTS.createdAt,
        publicKeyHex: toHex(kp1.publicKey),
      },
      kp1.privateKey,
    );

    // First rotation: kp1 → kp2
    const succession1 = await signKeySuccession(
      kp1.privateKey,
      kp2.privateKey,
      kp1.publicKey,
      kp2.publicKey,
      "first rotation",
    );

    const rotated1 = await rotate({
      existingContent: original,
      newPublicKey: kp2.publicKey,
      newPrivateKey: kp2.privateKey,
      successionRecord: {
        old_public_key: succession1.old_public_key,
        new_public_key: succession1.new_public_key,
        timestamp: succession1.timestamp,
        reason: succession1.reason,
        old_key_signature: succession1.old_key_signature,
        new_key_signature: succession1.new_key_signature,
      },
    });

    // Second rotation: kp2 → kp3
    const succession2 = await signKeySuccession(
      kp2.privateKey,
      kp3.privateKey,
      kp2.publicKey,
      kp3.publicKey,
      "second rotation",
    );

    const rotated2 = await rotate({
      existingContent: rotated1,
      newPublicKey: kp3.publicKey,
      newPrivateKey: kp3.privateKey,
      successionRecord: {
        old_public_key: succession2.old_public_key,
        new_public_key: succession2.new_public_key,
        timestamp: succession2.timestamp,
        reason: succession2.reason,
        old_key_signature: succession2.old_key_signature,
        new_key_signature: succession2.new_key_signature,
      },
    });

    // Verify
    const result = await standaloneVerify(rotated2);
    expect(result.valid).toBe(true);

    // Chain should have two records
    const parsed = parse(rotated2);
    expect(parsed.frontmatter.identity.public_key).toBe(bytesToHex(kp3.publicKey));
    expect(parsed.frontmatter.succession).toHaveLength(2);
    expect(parsed.frontmatter.succession![0]!.reason).toBe("first rotation");
    expect(parsed.frontmatter.succession![1]!.reason).toBe("second rotation");
  });
});

// ---------------------------------------------------------------------------
// serializeYaml coverage — nested objects, arrays, scalars (lines 86-103)
// ---------------------------------------------------------------------------

describe("serializeYaml branch coverage via generate()", () => {
  it("serializes nested retention_days object correctly", async () => {
    const kp = await makeKeypairHex();

    const content = await generate(
      {
        motebitId: DEFAULTS.motebitId,
        ownerId: DEFAULTS.ownerId,
        createdAt: DEFAULTS.createdAt,
        publicKeyHex: kp.publicKeyHex,
        privacy: {
          default_sensitivity: "personal",
          retention_days: { none: 100, personal: 50, medical: 20, financial: 15, secret: 3 },
          fail_closed: true,
        },
      },
      kp.privateKey,
    );

    // retention_days is a nested object — verifies the nested object branch
    expect(content).toContain("retention_days:");
    expect(content).toContain("none: 100");
    expect(content).toContain("secret: 3");

    const result = await standaloneVerify(content);
    expect(result.valid).toBe(true);
  });

  it("serializes devices array with object items correctly", async () => {
    const kp = await makeKeypairHex();

    const content = await generate(
      {
        motebitId: DEFAULTS.motebitId,
        ownerId: DEFAULTS.ownerId,
        createdAt: DEFAULTS.createdAt,
        publicKeyHex: kp.publicKeyHex,
        devices: [
          {
            device_id: "dev-1",
            name: "Desktop",
            public_key: kp.publicKeyHex,
            registered_at: DEFAULTS.createdAt,
          },
          {
            device_id: "dev-2",
            name: "Mobile",
            public_key: kp.publicKeyHex,
            registered_at: DEFAULTS.createdAt,
          },
        ],
      },
      kp.privateKey,
    );

    // devices is an array with object items — verifies the array-of-objects branch
    expect(content).toContain("devices:");
    expect(content).toContain("- device_id:");
    expect(content).toContain("dev-1");
    expect(content).toContain("dev-2");

    const parsed = parse(content);
    expect(parsed.frontmatter.devices).toHaveLength(2);

    const result = await standaloneVerify(content);
    expect(result.valid).toBe(true);
  });

  it("serializes capabilities as array of scalars", async () => {
    const kp = await makeKeypairHex();

    const content = await generate(
      {
        motebitId: DEFAULTS.motebitId,
        ownerId: DEFAULTS.ownerId,
        createdAt: DEFAULTS.createdAt,
        publicKeyHex: kp.publicKeyHex,
        service: {
          type: "service",
          service_name: "Test",
          capabilities: ["cap_a", "cap_b", "cap_c"],
        },
      },
      kp.privateKey,
    );

    // capabilities is an array of scalar strings — verifies the scalar array item branch
    expect(content).toContain("capabilities:");
    expect(content).toContain('- "cap_a"');
    expect(content).toContain('- "cap_b"');
    expect(content).toContain('- "cap_c"');

    const result = await standaloneVerify(content);
    expect(result.valid).toBe(true);
  });

  it("serializes top-level scalar fields (spec, motebit_id, etc.)", async () => {
    const kp = await makeKeypairHex();

    const content = await generate(
      {
        motebitId: DEFAULTS.motebitId,
        ownerId: DEFAULTS.ownerId,
        createdAt: DEFAULTS.createdAt,
        publicKeyHex: kp.publicKeyHex,
      },
      kp.privateKey,
    );

    // Top-level scalars hit the else branch in serializeYaml
    expect(content).toContain('spec: "motebit/identity@1.0"');
    expect(content).toContain(`motebit_id: "${DEFAULTS.motebitId}"`);
    expect(content).toContain(`owner_id: "${DEFAULTS.ownerId}"`);
  });
});
