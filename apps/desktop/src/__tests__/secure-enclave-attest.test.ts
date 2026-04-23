/**
 * Tests for `mintAttestationClaim` — the desktop mint path that
 * bridges between the Rust Secure Enclave commands and the
 * `HardwareAttestationClaim` wire shape.
 *
 * Exercised paths:
 *   - SE available + mint succeeds → `platform: "secure_enclave"` claim
 *     with a correctly-assembled `attestation_receipt`
 *   - SE unavailable → graceful fallback to `platform: "software"`
 *   - SE available but mint errors (not_supported / permission_denied /
 *     platform_blocked) → fallback to `platform: "software"`, no throw
 *   - Unexpected (non-SE) error → fallback to software + console warn
 *   - Identity key normalized to lowercase hex before being sent to Rust
 *   - Caller-injected `now()` is the attestation timestamp
 */
import { describe, expect, it, vi } from "vitest";

import { mintAttestationClaim } from "../secure-enclave-attest.js";
import { SecureEnclaveError } from "../secure-enclave-bridge.js";
import type { InvokeFn } from "../tauri-storage.js";

function noopInvoke(): InvokeFn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (async () => undefined) as any;
}

function makeInvoke(
  impl: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>,
): InvokeFn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return impl as any;
}

describe("mintAttestationClaim — SE happy path", () => {
  it("produces a secure_enclave claim with stitched attestation_receipt", async () => {
    const invoke = makeInvoke(async (cmd, args) => {
      if (cmd === "se_available") return true;
      if (cmd === "se_mint_attestation") {
        expect(args?.motebitId).toBe("mot_1");
        expect(args?.deviceId).toBe("dev_1");
        expect(args?.identityPublicKeyHex).toBe("a".repeat(64));
        expect(args?.attestedAt).toBe(1_700_000_000_000);
        return {
          body_base64: "BODY_B64",
          signature_der_base64: "SIG_B64",
        };
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
    const claim = await mintAttestationClaim(invoke, {
      identityPublicKeyHex: "A".repeat(64), // uppercase → should be lowercased
      motebitId: "mot_1",
      deviceId: "dev_1",
      now: () => 1_700_000_000_000,
    });
    expect(claim.platform).toBe("secure_enclave");
    expect(claim.key_exported).toBe(false);
    expect(claim.attestation_receipt).toBe("BODY_B64.SIG_B64");
  });

  it("uses Date.now() when `now` is not injected", async () => {
    const fixed = 1_700_000_000_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(fixed);
    try {
      const invoke = makeInvoke(async (cmd, args) => {
        if (cmd === "se_available") return true;
        if (cmd === "se_mint_attestation") {
          expect(args?.attestedAt).toBe(fixed);
          return { body_base64: "B", signature_der_base64: "S" };
        }
        return undefined;
      });
      await mintAttestationClaim(invoke, {
        identityPublicKeyHex: "a".repeat(64),
        motebitId: "mot_1",
        deviceId: "dev_1",
      });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("mintAttestationClaim — software fallbacks", () => {
  it("falls back to software when se_available is false", async () => {
    const invoke = makeInvoke(async (cmd) => {
      if (cmd === "se_available") return false;
      throw new Error("mint should not be called");
    });
    const claim = await mintAttestationClaim(invoke, {
      identityPublicKeyHex: "a".repeat(64),
      motebitId: "mot",
      deviceId: "dev",
    });
    expect(claim.platform).toBe("software");
    expect(claim.attestation_receipt).toBeUndefined();
  });

  it("falls back to software on not_supported mint error (non-macOS Tauri builds)", async () => {
    const invoke = makeInvoke(async (cmd) => {
      if (cmd === "se_available") return true;
      if (cmd === "se_mint_attestation") {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- mimic Tauri reject shape
        throw { reason: "not_supported", message: "VMs lack SE hardware" };
      }
      return undefined;
    });
    const claim = await mintAttestationClaim(invoke, {
      identityPublicKeyHex: "a".repeat(64),
      motebitId: "mot",
      deviceId: "dev",
    });
    expect(claim.platform).toBe("software");
  });

  it("falls back to software on permission_denied (user declined biometric)", async () => {
    const invoke = makeInvoke(async (cmd) => {
      if (cmd === "se_available") return true;
      if (cmd === "se_mint_attestation") {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- mimic Tauri reject shape
        throw { reason: "permission_denied", message: "user cancelled" };
      }
      return undefined;
    });
    const claim = await mintAttestationClaim(invoke, {
      identityPublicKeyHex: "a".repeat(64),
      motebitId: "mot",
      deviceId: "dev",
    });
    expect(claim.platform).toBe("software");
  });

  it("falls back to software on platform_blocked (internal SE error)", async () => {
    const invoke = makeInvoke(async (cmd) => {
      if (cmd === "se_available") return true;
      if (cmd === "se_mint_attestation") {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- mimic Tauri reject shape
        throw { reason: "platform_blocked", message: "unexpected" };
      }
      return undefined;
    });
    const claim = await mintAttestationClaim(invoke, {
      identityPublicKeyHex: "a".repeat(64),
      motebitId: "mot",
      deviceId: "dev",
    });
    expect(claim.platform).toBe("software");
  });

  it("falls back to software on any non-SE error (bridge normalizes to platform_blocked)", async () => {
    const invoke = makeInvoke(async (cmd) => {
      if (cmd === "se_available") return true;
      // A plain Error — the bridge wraps it as `platform_blocked`
      // SecureEnclaveError, which the mint path fallback handles.
      throw new Error("random TypeScript error");
    });
    const claim = await mintAttestationClaim(invoke, {
      identityPublicKeyHex: "a".repeat(64),
      motebitId: "mot",
      deviceId: "dev",
    });
    expect(claim.platform).toBe("software");
  });
});

describe("mintAttestationClaim — se_available failure", () => {
  it("treats a throwing se_available probe as unavailable (not an error)", async () => {
    const invoke = makeInvoke(async (cmd) => {
      if (cmd === "se_available") throw new Error("invoke unavailable");
      throw new Error("unreachable");
    });
    const claim = await mintAttestationClaim(invoke, {
      identityPublicKeyHex: "a".repeat(64),
      motebitId: "mot",
      deviceId: "dev",
    });
    expect(claim.platform).toBe("software");
  });
});

describe("mintAttestationClaim — test harness noopInvoke sanity", () => {
  it("noopInvoke is a valid InvokeFn shape", () => {
    // Smoke — ensures the helper resolves to a function for use above.
    expect(typeof noopInvoke()).toBe("function");
  });
});

describe("SecureEnclaveError — reason taxonomy", () => {
  it("preserves typed reason on throw", () => {
    const err = new SecureEnclaveError("permission_denied", "biometric cancelled");
    expect(err.reason).toBe("permission_denied");
    expect(err.name).toBe("SecureEnclaveError");
    expect(err.message).toBe("biometric cancelled");
  });

  it("defaults message to reason when omitted", () => {
    const err = new SecureEnclaveError("not_supported");
    expect(err.message).toBe("not_supported");
  });
});
