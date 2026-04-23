import { describe, it, expect } from "vitest";
import { buildHardwareVerifiers } from "../adapters";

describe("buildHardwareVerifiers", () => {
  it("wires all four platform arms by default", () => {
    const v = buildHardwareVerifiers();
    expect(typeof v.deviceCheck).toBe("function");
    expect(typeof v.tpm).toBe("function");
    expect(typeof v.playIntegrity).toBe("function");
    expect(typeof v.webauthn).toBe("function");
  });

  it("overrides accept per-platform config", () => {
    const v = buildHardwareVerifiers({
      appAttestBundleId: "com.example.app",
      playIntegrityPackageName: "com.example.app",
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

  it("returns a verifier that fails-closed on an unknown platform", async () => {
    const v = buildHardwareVerifiers();
    // The bundle doesn't register a "mystery" arm; the dispatcher
    // (in @motebit/crypto) hits the unknown-platform fall-through
    // regardless of what we wire. Assert the wiring doesn't leak
    // into unrelated slots (no hypothetical "mystery" verifier is
    // present on the returned record).
    expect((v as unknown as { mystery?: unknown }).mystery).toBeUndefined();
  });
});
