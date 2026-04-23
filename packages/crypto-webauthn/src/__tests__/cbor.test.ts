import { describe, it, expect } from "vitest";
import { encode as cborEncode } from "cbor2";
import { parseWebAuthnAttestationObjectCbor } from "../cbor";

// ---------------------------------------------------------------------------
// Direct unit tests for parseWebAuthnAttestationObjectCbor — targeted at the
// malformed-input branches the end-to-end verify tests don't reach.
// ---------------------------------------------------------------------------

function encodeAttestationObject(input: {
  fmt: string;
  attStmt: Record<string, unknown>;
  authData: Uint8Array;
}): Uint8Array {
  return new Uint8Array(cborEncode(input));
}

describe("parseWebAuthnAttestationObjectCbor — malformed attStmt shapes", () => {
  it("rejects `attStmt.sig` that is not bytes", () => {
    const bytes = encodeAttestationObject({
      fmt: "packed",
      attStmt: {
        alg: -7,
        sig: "not bytes",
      },
      authData: new Uint8Array([1, 2, 3]),
    });
    expect(() => parseWebAuthnAttestationObjectCbor(bytes)).toThrowError(
      /attStmt\.sig.*not bytes/i,
    );
  });

  it("rejects `attStmt.x5c` that is not an array", () => {
    const bytes = encodeAttestationObject({
      fmt: "packed",
      attStmt: {
        alg: -7,
        sig: new Uint8Array([0x30, 0x44]),
        x5c: "not an array",
      },
      authData: new Uint8Array([1, 2, 3]),
    });
    expect(() => parseWebAuthnAttestationObjectCbor(bytes)).toThrowError(
      /attStmt\.x5c.*not an array/i,
    );
  });

  it("rejects `attStmt.x5c` entry that is not bytes", () => {
    const bytes = encodeAttestationObject({
      fmt: "packed",
      attStmt: {
        alg: -7,
        sig: new Uint8Array([0x30, 0x44]),
        x5c: ["not a cert"],
      },
      authData: new Uint8Array([1, 2, 3]),
    });
    expect(() => parseWebAuthnAttestationObjectCbor(bytes)).toThrowError(
      /attStmt\.x5c.*not bytes/i,
    );
  });

  it("rejects `attStmt.alg` that is present but not a number", () => {
    const bytes = encodeAttestationObject({
      fmt: "packed",
      attStmt: {
        alg: "ES256",
        sig: new Uint8Array([0x30]),
      },
      authData: new Uint8Array([1, 2, 3]),
    });
    expect(() => parseWebAuthnAttestationObjectCbor(bytes)).toThrowError(
      /attStmt\.alg.*not a number/i,
    );
  });

  it("accepts `attStmt` without `sig` / `alg` / `x5c` (surfaces nulls / empty)", () => {
    const bytes = encodeAttestationObject({
      fmt: "none",
      attStmt: {},
      authData: new Uint8Array([1, 2, 3, 4]),
    });
    const parsed = parseWebAuthnAttestationObjectCbor(bytes);
    expect(parsed.fmt).toBe("none");
    expect(parsed.alg).toBeNull();
    expect(parsed.sig).toBeNull();
    expect(parsed.x5c).toEqual([]);
    expect(parsed.authData).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});
