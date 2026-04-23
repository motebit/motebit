/**
 * CBOR decoder round-trip tests.
 *
 * The verifier feeds everything it sees through `parseAppAttestCbor`;
 * the outer verify path relies on the decoder's shape contract. These
 * tests pin the contract without needing a real Apple attestation
 * object — a hand-encoded CBOR map matching Apple's shape is enough.
 */

import { describe, expect, it } from "vitest";
import { encode as cborEncode } from "cbor2";

import { parseAppAttestCbor } from "../cbor.js";

function toU8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("parseAppAttestCbor", () => {
  it("decodes a well-formed attestation object with leaf + intermediate", () => {
    const leaf = toU8("leaf-der-bytes");
    const intermediate = toU8("intermediate-der-bytes");
    const receipt = toU8("apple-receipt-bytes");
    const authData = toU8("auth-data-bytes-padded-to-at-least-32-bytes-here-yes-ok");

    const obj = {
      fmt: "apple-appattest",
      attStmt: { x5c: [leaf, intermediate], receipt },
      authData,
    };
    const encoded = cborEncode(obj);
    const parsed = parseAppAttestCbor(new Uint8Array(encoded));

    expect(parsed.fmt).toBe("apple-appattest");
    expect(parsed.x5c).toHaveLength(2);
    expect(parsed.x5c[0]).toEqual(leaf);
    expect(parsed.x5c[1]).toEqual(intermediate);
    expect(parsed.receipt).toEqual(receipt);
    expect(parsed.authData).toEqual(authData);
  });

  it("tolerates missing `receipt` — treated as null", () => {
    const obj = {
      fmt: "apple-appattest",
      attStmt: { x5c: [toU8("leaf"), toU8("intermediate")] },
      authData: toU8("auth"),
    };
    const encoded = cborEncode(obj);
    const parsed = parseAppAttestCbor(new Uint8Array(encoded));
    expect(parsed.receipt).toBeNull();
  });

  it("throws on non-map root", () => {
    const encoded = cborEncode([1, 2, 3]);
    expect(() => parseAppAttestCbor(new Uint8Array(encoded))).toThrow();
  });

  it("throws on missing fmt", () => {
    const encoded = cborEncode({ attStmt: { x5c: [toU8("x")] }, authData: toU8("a") });
    expect(() => parseAppAttestCbor(new Uint8Array(encoded))).toThrow(/fmt/);
  });

  it("throws on missing attStmt", () => {
    const encoded = cborEncode({ fmt: "apple-appattest", authData: toU8("a") });
    expect(() => parseAppAttestCbor(new Uint8Array(encoded))).toThrow(/attStmt/);
  });

  it("throws on empty x5c", () => {
    const encoded = cborEncode({
      fmt: "apple-appattest",
      attStmt: { x5c: [] },
      authData: toU8("a"),
    });
    expect(() => parseAppAttestCbor(new Uint8Array(encoded))).toThrow(/x5c/);
  });

  it("throws on non-bytes x5c entry", () => {
    const encoded = cborEncode({
      fmt: "apple-appattest",
      attStmt: { x5c: ["not-bytes"] },
      authData: toU8("a"),
    });
    expect(() => parseAppAttestCbor(new Uint8Array(encoded))).toThrow(/x5c/);
  });

  it("throws on non-bytes authData", () => {
    const encoded = cborEncode({
      fmt: "apple-appattest",
      attStmt: { x5c: [toU8("x")] },
      authData: "string-not-bytes",
    });
    expect(() => parseAppAttestCbor(new Uint8Array(encoded))).toThrow(/authData/);
  });
});
