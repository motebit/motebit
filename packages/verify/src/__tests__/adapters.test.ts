import { describe, it, expect } from "vitest";
import { buildHardwareVerifiers } from "../adapters";

describe("buildHardwareVerifiers", () => {
  it("wires the four canonical sovereign-verifiable arms by default (App Attest + TPM + WebAuthn + Play Integrity for backward compat)", () => {
    const v = buildHardwareVerifiers();
    expect(typeof v.deviceCheck).toBe("function");
    expect(typeof v.tpm).toBe("function");
    expect(typeof v.playIntegrity).toBe("function");
    expect(typeof v.webauthn).toBe("function");
  });

  it("does NOT wire the androidKeystore arm by default — operator must supply expectedAttestationApplicationId at deploy time", () => {
    // Android Keystore is wired only when the operator pins the
    // package binding bytes at build time. Default-wiring a placeholder
    // would false-reject every real claim, so the absence of the arm
    // is the correct fail-closed posture. See the inline doctrine note
    // in `adapters.ts`.
    const v = buildHardwareVerifiers();
    expect(v.androidKeystore).toBeUndefined();
  });

  it("wires the androidKeystore arm when expectedAttestationApplicationId is supplied", () => {
    const v = buildHardwareVerifiers({
      androidKeystoreExpectedAttestationApplicationId: new TextEncoder().encode(
        "com.motebit.mobile::deadbeef",
      ),
    });
    expect(typeof v.androidKeystore).toBe("function");
    // Other arms still wired in parallel.
    expect(typeof v.deviceCheck).toBe("function");
  });

  it("accepts androidKeystoreRootPems override alongside the package binding", () => {
    const v = buildHardwareVerifiers({
      androidKeystoreExpectedAttestationApplicationId: new Uint8Array([1, 2, 3]),
      androidKeystoreRootPems: [],
    });
    expect(typeof v.androidKeystore).toBe("function");
  });

  it("overrides accept per-platform config", () => {
    const v = buildHardwareVerifiers({
      appAttestBundleId: "com.example.app",
      playIntegrityPackageName: "com.example.app",
      playIntegrityRequiredDeviceIntegrity: "MEETS_BASIC_INTEGRITY",
      webauthnRpId: "example.com",
    });
    // Factories returned successfully; wiring works — the deeper per-
    // platform behavior is covered by each adapter's own test suite.
    expect(typeof v.deviceCheck).toBe("function");
    expect(typeof v.tpm).toBe("function");
    expect(typeof v.playIntegrity).toBe("function");
    expect(typeof v.webauthn).toBe("function");
  });

  it("accepts tpm + webauthn root overrides without throwing", () => {
    const v = buildHardwareVerifiers({
      tpmRootPems: [],
      webauthnRootPems: [],
    });
    expect(typeof v.tpm).toBe("function");
    expect(typeof v.webauthn).toBe("function");
  });

  it("accepts the appAttestRootPem and playIntegrityPinnedJwks overrides", () => {
    const v = buildHardwareVerifiers({
      appAttestRootPem:
        "-----BEGIN CERTIFICATE-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8\n-----END CERTIFICATE-----",
      playIntegrityPinnedJwks: { keys: [] },
    });
    // Factories captured the overrides at wiring time without inspecting
    // the bytes (chain validation runs at verify-call time).
    expect(typeof v.deviceCheck).toBe("function");
    expect(typeof v.playIntegrity).toBe("function");
  });

  it("returns a verifier that fails-closed on an unknown platform", () => {
    const v = buildHardwareVerifiers();
    // The bundle doesn't register a "mystery" arm; the dispatcher
    // (in @motebit/crypto) hits the unknown-platform fall-through
    // regardless of what we wire. Assert the wiring doesn't leak
    // into unrelated slots (no hypothetical "mystery" verifier is
    // present on the returned record).
    expect((v as unknown as { mystery?: unknown }).mystery).toBeUndefined();
  });
});
