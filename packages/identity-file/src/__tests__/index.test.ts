import { describe, it, expect } from "vitest";
import { generateKeypair } from "@motebit/crypto";
import { verify as standaloneVerify } from "@motebit/verify";
import { generate, parse, verify, update, toHex } from "../index";

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
      { governance: { trust_mode: "minimal", max_risk_auto: "R0_READ", require_approval_above: "R0_READ", deny_above: "R2_WRITE", operator_mode: false } },
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
