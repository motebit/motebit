/**
 * Runtime-parse tests for HardwareAttestationClaim — the optional
 * hardware-custody claim embedded as the `hardware_attestation` field
 * on `TrustCredentialSubject`. See spec/credential-v1.md §3.4.
 */
import { describe, expect, it } from "vitest";

import { HardwareAttestationClaimSchema } from "../hardware-attestation-claim.js";

describe("HardwareAttestationClaimSchema", () => {
  const SECURE_ENCLAVE: Record<string, unknown> = {
    platform: "secure_enclave",
    key_exported: false,
  };

  it("parses a minimal claim (platform only)", () => {
    const c = HardwareAttestationClaimSchema.parse({ platform: "secure_enclave" });
    expect(c.platform).toBe("secure_enclave");
    expect(c.key_exported).toBeUndefined();
    expect(c.attestation_receipt).toBeUndefined();
  });

  it("parses a full claim with receipt", () => {
    const c = HardwareAttestationClaimSchema.parse({
      platform: "device_check",
      key_exported: false,
      attestation_receipt: "AAAA...base64url...",
    });
    expect(c.platform).toBe("device_check");
    expect(c.key_exported).toBe(false);
    expect(c.attestation_receipt).toBe("AAAA...base64url...");
  });

  it("accepts every documented platform", () => {
    for (const p of [
      "secure_enclave",
      "tpm",
      "play_integrity",
      "device_check",
      "software",
    ] as const) {
      const c = HardwareAttestationClaimSchema.parse({ platform: p });
      expect(c.platform).toBe(p);
    }
  });

  it("rejects unknown platform values", () => {
    expect(() => HardwareAttestationClaimSchema.parse({ platform: "custom" })).toThrow();
    expect(() => HardwareAttestationClaimSchema.parse({ platform: "hsm" })).toThrow();
    expect(() => HardwareAttestationClaimSchema.parse({ platform: "" })).toThrow();
  });

  it("rejects missing platform (every other field optional)", () => {
    expect(() => HardwareAttestationClaimSchema.parse({ key_exported: false })).toThrow();
    expect(() => HardwareAttestationClaimSchema.parse({})).toThrow();
  });

  it("accepts key_exported=true (weaker claim, still valid wire)", () => {
    const c = HardwareAttestationClaimSchema.parse({
      platform: "secure_enclave",
      key_exported: true,
    });
    expect(c.key_exported).toBe(true);
  });

  it("rejects non-boolean key_exported", () => {
    expect(() =>
      HardwareAttestationClaimSchema.parse({ platform: "secure_enclave", key_exported: "yes" }),
    ).toThrow();
    expect(() =>
      HardwareAttestationClaimSchema.parse({ platform: "secure_enclave", key_exported: 1 }),
    ).toThrow();
  });

  it("rejects non-string attestation_receipt", () => {
    expect(() =>
      HardwareAttestationClaimSchema.parse({
        platform: "device_check",
        attestation_receipt: 42,
      }),
    ).toThrow();
  });

  it("rejects extra top-level keys (strict mode)", () => {
    expect(() => HardwareAttestationClaimSchema.parse({ ...SECURE_ENCLAVE, sneak: "x" })).toThrow();
  });

  it("roundtrips through parse (no data loss on valid input)", () => {
    const input = {
      platform: "tpm" as const,
      key_exported: false,
      attestation_receipt: "deadbeef",
    };
    const parsed = HardwareAttestationClaimSchema.parse(input);
    expect(parsed).toEqual(input);
  });
});
