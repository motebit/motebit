import { describe, it, expect } from "vitest";
import { hexToBytes, fromBase64Url, bytesToHex, verifyEd25519, verify } from "../verify.js";

// Real Ed25519 keypair + signed identity for integration tests
const TEST_PUB_HEX = "4fe75250b985dd41e0db40a06190b0d8f6d1596bfe76b3c9ddec1f3e15390abf";
const TEST_SIG_B64URL =
  "3AODzRS8_QiZ5ohdLb9kW9NYkhjHHAycie134OVe93RRFOy8d6AyhH93O0CuA3ijCzU7P6NfUQGIqwXXlm6WCw";

const SIGNED_IDENTITY = `---
spec: motebit/identity@1.0
motebit_id: 019abc12-3456-7890-abcd-ef0123456789
created_at: 2026-01-15T10:00:00Z
owner_id: owner-abc-123
identity:
  algorithm: Ed25519
  public_key: ${TEST_PUB_HEX}
governance:
  trust_mode: guarded
  max_risk_auto: R1_DRAFT
  require_approval_above: R2_WRITE
  deny_above: R4_MONEY
  operator_mode: true
privacy:
  default_sensitivity: personal
  retention_days:
    none: 365
    personal: 180
    medical: 90
  fail_closed: true
memory:
  half_life_days: 7
  confidence_threshold: 0.3
  per_turn_limit: 3
devices:
  - device_id: dev-001
    name: laptop
    public_key: 1122334455
    registered_at: 2026-01-15T10:00:00Z
---

# My Agent

<!-- motebit:sig:Ed25519:${TEST_SIG_B64URL} -->
`;

describe("hexToBytes", () => {
  it("converts hex to bytes", () => {
    expect(hexToBytes("deadbeef")).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it("handles empty string", () => {
    expect(hexToBytes("")).toEqual(new Uint8Array([]));
  });

  it("handles lowercase hex", () => {
    expect(hexToBytes("ff00")).toEqual(new Uint8Array([255, 0]));
  });
});

describe("bytesToHex", () => {
  it("converts bytes to hex", () => {
    expect(bytesToHex(new Uint8Array([0xde, 0xad]))).toBe("dead");
  });

  it("pads single-digit hex values", () => {
    expect(bytesToHex(new Uint8Array([0, 1, 15]))).toBe("00010f");
  });

  it("roundtrips with hexToBytes", () => {
    const hex = "aabbccdd00112233";
    expect(bytesToHex(hexToBytes(hex))).toBe(hex);
  });
});

describe("fromBase64Url", () => {
  it("decodes base64url without padding", () => {
    // "hello" in base64 is "aGVsbG8=", base64url is "aGVsbG8"
    const result = fromBase64Url("aGVsbG8");
    expect(new TextDecoder().decode(result)).toBe("hello");
  });

  it("decodes base64url with URL-safe characters", () => {
    // Standard base64 uses + and /, base64url uses - and _
    // "test?>" → base64 "dGVzdD8+" → base64url "dGVzdD8-"
    const result = fromBase64Url("dGVzdD8-");
    expect(new TextDecoder().decode(result)).toBe("test?>");
  });

  it("handles already-padded base64url", () => {
    const result = fromBase64Url("aGVsbG8=");
    expect(new TextDecoder().decode(result)).toBe("hello");
  });

  it("decodes empty string", () => {
    const result = fromBase64Url("");
    expect(result.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verifyEd25519
// ---------------------------------------------------------------------------

describe("verifyEd25519", () => {
  it("returns true for valid signature", async () => {
    const message = new TextEncoder().encode("test message");
    // Generate a keypair, sign, then verify
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, message),
    );
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));

    const valid = await verifyEd25519(sig, message, pub);
    expect(valid).toBe(true);
  });

  it("returns false for tampered message", async () => {
    const message = new TextEncoder().encode("original");
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, message),
    );
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));

    const valid = await verifyEd25519(sig, new TextEncoder().encode("tampered"), pub);
    expect(valid).toBe(false);
  });

  it("returns false for wrong public key", async () => {
    const message = new TextEncoder().encode("test");
    const kp1 = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const kp2 = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, kp1.privateKey, message),
    );
    const wrongPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp2.publicKey));

    const valid = await verifyEd25519(sig, message, wrongPub);
    expect(valid).toBe(false);
  });

  it("returns false for malformed key (wrong length)", async () => {
    const valid = await verifyEd25519(
      new Uint8Array(64),
      new TextEncoder().encode("x"),
      new Uint8Array(16),
    );
    expect(valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verify (full identity file)
// ---------------------------------------------------------------------------

describe("verify", () => {
  it("verifies a correctly signed identity", async () => {
    const result = await verify(SIGNED_IDENTITY);
    expect(result.valid).toBe(true);
    expect(result.identity).not.toBeNull();
    expect(result.identity!.motebit_id).toBe("019abc12-3456-7890-abcd-ef0123456789");
    expect(result.error).toBeUndefined();
  });

  it("rejects tampered frontmatter", async () => {
    const tampered = SIGNED_IDENTITY.replace("guarded", "full");
    const result = await verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.identity).toBeNull();
    expect(result.error).toBe("Signature verification failed");
  });

  it("rejects invalid signature encoding", async () => {
    const bad = SIGNED_IDENTITY.replace(TEST_SIG_B64URL, "!!!invalid!!!");
    const result = await verify(bad);
    expect(result.valid).toBe(false);
  });

  it("rejects wrong-length public key", async () => {
    const shortKey = SIGNED_IDENTITY.replace(TEST_PUB_HEX, "aabb");
    const result = await verify(shortKey);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Public key must be 32 bytes");
  });

  it("rejects unparseable content", async () => {
    const result = await verify("not a valid motebit.md file");
    expect(result.valid).toBe(false);
    expect(result.identity).toBeNull();
    expect(result.error).toBeDefined();
  });
});
