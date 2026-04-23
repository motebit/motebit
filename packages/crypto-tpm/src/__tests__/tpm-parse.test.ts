/**
 * `TPMS_ATTEST` parse / compose roundtrip tests.
 *
 * The verifier feeds everything it sees through `parseTpmsAttest`; the
 * outer verify path relies on the parser's shape contract. These
 * tests pin the contract without needing a real TPM — a hand-composed
 * buffer matching the TCG marshaling rules is enough.
 */

import { describe, expect, it } from "vitest";

import {
  composeTpmsAttestForTest,
  parseTpmsAttest,
  TPM_GENERATED_VALUE,
  TPM_ST_ATTEST_QUOTE,
} from "../tpm-parse.js";

function toU8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe("parseTpmsAttest", () => {
  it("roundtrips a minimal well-formed attest", () => {
    const qualifiedSigner = toU8("signer-name");
    const extraData = toU8("some-extra-data-bytes-32-wide-go");
    const bytes = composeTpmsAttestForTest({ qualifiedSigner, extraData });
    const parsed = parseTpmsAttest(bytes);
    expect(parsed.magic).toBe(TPM_GENERATED_VALUE);
    expect(parsed.type).toBe(TPM_ST_ATTEST_QUOTE);
    expect(parsed.qualifiedSigner).toEqual(qualifiedSigner);
    expect(parsed.extraData).toEqual(extraData);
    expect(parsed.trailer.length).toBe(17 + 8 + 4); // default filler
  });

  it("preserves a custom trailer for signature-scope verification", () => {
    const qualifiedSigner = new Uint8Array([0x01, 0x02]);
    const extraData = new Uint8Array([0xaa]);
    const trailer = new Uint8Array([1, 2, 3, 4, 5]);
    const bytes = composeTpmsAttestForTest({ qualifiedSigner, extraData, trailer });
    const parsed = parseTpmsAttest(bytes);
    expect(parsed.trailer).toEqual(trailer);
  });

  it("returns detached copies — mutating the input does not mutate the parsed view", () => {
    const qualifiedSigner = new Uint8Array([0x01, 0x02]);
    const extraData = new Uint8Array([0xaa, 0xbb]);
    const bytes = composeTpmsAttestForTest({ qualifiedSigner, extraData });
    const parsed = parseTpmsAttest(bytes);
    // Flip a byte inside the source buffer
    bytes[8] = 0xff;
    // Parser result should have captured its own copy
    expect(parsed.qualifiedSigner).toEqual(new Uint8Array([0x01, 0x02]));
  });

  it("surfaces a non-TPM magic value so the outer verifier can reject", () => {
    // A non-TPM magic still parses structurally (the parser is
    // syntactic), but the returned `magic` field is what the verifier
    // asserts against — so a tampered magic surfaces through the
    // result, not through a throw.
    const bytes = composeTpmsAttestForTest({
      magic: 0xdeadbeef,
      qualifiedSigner: new Uint8Array(),
      extraData: new Uint8Array(),
    });
    const parsed = parseTpmsAttest(bytes);
    expect(parsed.magic).toBe(0xdeadbeef);
    expect(parsed.magic).not.toBe(TPM_GENERATED_VALUE);
  });

  it("surfaces a non-quote structure tag for the outer verifier to reject", () => {
    const bytes = composeTpmsAttestForTest({
      type: 0x8014, // TPM_ST_ATTEST_NV — a different attest type
      qualifiedSigner: new Uint8Array(),
      extraData: new Uint8Array(),
    });
    const parsed = parseTpmsAttest(bytes);
    expect(parsed.type).not.toBe(TPM_ST_ATTEST_QUOTE);
  });

  it("throws when the header is shorter than the minimum-10-byte prefix", () => {
    const truncated = new Uint8Array([0xff, 0x54, 0x43]); // only 3 bytes
    expect(() => parseTpmsAttest(truncated)).toThrow(/TPMS_ATTEST too short/);
  });

  it("throws when the qualifiedSigner length overruns the buffer", () => {
    // Manually emit: magic(4) + type(2) + declared-length=200 + only 5 bytes of payload
    const buf = new Uint8Array(4 + 2 + 2 + 5);
    // magic
    buf[0] = 0xff;
    buf[1] = 0x54;
    buf[2] = 0x43;
    buf[3] = 0x47;
    // type
    buf[4] = 0x80;
    buf[5] = 0x18;
    // qualifiedSigner length = 200 (0x00C8)
    buf[6] = 0x00;
    buf[7] = 0xc8;
    // only 5 actual bytes follow — parser should refuse
    expect(() => parseTpmsAttest(buf)).toThrow(/TPM2B length 200/);
  });

  it("round-trips a larger extraData via TPM2B length-prefix marshaling", () => {
    const extra = new Uint8Array(512).fill(0x42);
    const bytes = composeTpmsAttestForTest({
      qualifiedSigner: new Uint8Array([0x01]),
      extraData: extra,
    });
    const parsed = parseTpmsAttest(bytes);
    expect(parsed.extraData.length).toBe(512);
    expect(parsed.extraData[0]).toBe(0x42);
    expect(parsed.extraData[511]).toBe(0x42);
  });

  it("round-trips high-bit uint32 magic values via unsigned-right-shift normalization", () => {
    // TPM_GENERATED_VALUE itself sets the high bit (0xff544347); a
    // signed-shift bug would parse it as negative. Assert the parsed
    // value matches the exact constant.
    const bytes = composeTpmsAttestForTest({
      qualifiedSigner: new Uint8Array(),
      extraData: new Uint8Array(),
    });
    const parsed = parseTpmsAttest(bytes);
    expect(parsed.magic).toBe(TPM_GENERATED_VALUE);
    expect(parsed.magic > 0).toBe(true); // high-bit safe
  });
});
