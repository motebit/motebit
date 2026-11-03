/**
 * The armor checksum against its published check value, in a file of its
 * own: `openpgp.test.ts` parses armored keys at load, so a broken CRC-24
 * there fails the whole file before any test runs.
 */
import { describe, expect, it } from "vitest";

import { crc24 } from "../openpgp.js";

describe("the armor checksum", () => {
  it("CRC-24 gives the RFC 4880 check value", () => {
    expect(crc24(Buffer.from("123456789"))).toBe(0x21cf02);
    expect(crc24(new Uint8Array())).toBe(0xb704ce);
  });
});
