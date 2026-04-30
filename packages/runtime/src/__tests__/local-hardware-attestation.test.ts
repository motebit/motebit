/**
 * Tests for the local-motebit hardware-attestation API:
 *   runtime.setLocalHardwareAttestationClaim(claim)
 *   runtime.getLocalHardwareAttestationScore()
 *
 * Sibling to the peer-claim setters (`setHardwareAttestationFetcher`,
 * `setHardwareAttestationVerifiers`). Where those resolve OTHER
 * motebits' attestations, this resolves the LOCAL motebit's own
 * platform binding — the score that gates skill loading on the local
 * device per `spec/skills-v1.md` §7.2 and the canonical mapping in
 * `packages/semiring/src/hardware-attestation.ts::scoreAttestation`.
 */
import { describe, expect, it } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";

function makeRuntime(): MotebitRuntime {
  return new MotebitRuntime(
    { motebitId: "test-mote", tickRateHz: 0 },
    { storage: createInMemoryStorage(), renderer: new NullRenderer() },
  );
}

describe("MotebitRuntime — local hardware-attestation API", () => {
  it("returns 0 (semiring zero) by default — no claim set", () => {
    const runtime = makeRuntime();
    expect(runtime.getLocalHardwareAttestationScore()).toBe(0);
  });

  it("returns 0.1 (software sentinel) when the local claim is platform=software", () => {
    const runtime = makeRuntime();
    runtime.setLocalHardwareAttestationClaim({ platform: "software" });
    expect(runtime.getLocalHardwareAttestationScore()).toBeCloseTo(0.1);
  });

  it("returns 1.0 when the local claim is hardware-backed without key export", () => {
    const runtime = makeRuntime();
    runtime.setLocalHardwareAttestationClaim({ platform: "secure_enclave" });
    expect(runtime.getLocalHardwareAttestationScore()).toBe(1);
  });

  it("returns 0.5 when the local claim is hardware-backed but key was exported", () => {
    const runtime = makeRuntime();
    runtime.setLocalHardwareAttestationClaim({
      platform: "tpm",
      key_exported: true,
    });
    expect(runtime.getLocalHardwareAttestationScore()).toBe(0.5);
  });

  it("clears the claim back to zero when null is passed", () => {
    const runtime = makeRuntime();
    runtime.setLocalHardwareAttestationClaim({ platform: "secure_enclave" });
    expect(runtime.getLocalHardwareAttestationScore()).toBe(1);
    runtime.setLocalHardwareAttestationClaim(null);
    expect(runtime.getLocalHardwareAttestationScore()).toBe(0);
  });

  it("scores every supported hardware platform at 1.0 (non-exported default)", () => {
    const runtime = makeRuntime();
    const platforms = [
      "secure_enclave",
      "tpm",
      "device_check",
      "play_integrity",
      "android_keystore",
      "webauthn",
    ] as const;
    for (const platform of platforms) {
      runtime.setLocalHardwareAttestationClaim({ platform });
      expect(runtime.getLocalHardwareAttestationScore()).toBe(1);
    }
  });
});
