/**
 * Shape guards for the machine roster's two artifacts. Shape only — a
 * guard that passes says nothing about the signature, and nothing about
 * whether the signer speaks for the motebit.
 */
import { describe, it, expect } from "vitest";
import { HOST_ROSTER_SPEC_ID, isHostEnrollment, isHostRetirement } from "../index.js";

const KEY = "ab".repeat(32);
const enrollment = {
  motebit_id: "019d903f-13de-75a4-8341-58319e0a2f16",
  device_id: "01a04bb5-9c87-7d2c-bc6c-2f4cd3ce11d8",
  public_key: KEY,
  enrolled_at: 1_776_239_454_545,
  suite: "motebit-jcs-ed25519-b64-v1",
  signature: "sig",
};
const retirement = {
  motebit_id: enrollment.motebit_id,
  enrollment_id: "cd".repeat(32),
  public_key: KEY,
  retired_at: 1_776_239_999_999,
  suite: "motebit-jcs-ed25519-b64-v1",
  signature: "sig",
};

describe("machine roster guards", () => {
  it("names its spec", () => {
    expect(HOST_ROSTER_SPEC_ID).toBe("motebit/machine-roster@1.0");
  });

  it("accepts a well-formed enrolment and retirement", () => {
    expect(isHostEnrollment(enrollment)).toBe(true);
    expect(isHostRetirement(retirement)).toBe(true);
  });

  it("does not confuse the two", () => {
    expect(isHostEnrollment(retirement)).toBe(false);
    expect(isHostRetirement(enrollment)).toBe(false);
  });

  it.each([
    ["not an object", null],
    ["a string", "enrolment"],
    ["empty motebit_id", { ...enrollment, motebit_id: "" }],
    // Two hosts sharing an empty id would be one line to everyone downstream.
    ["empty device_id", { ...enrollment, device_id: "" }],
    ["a key that is not 32 bytes of hex", { ...enrollment, public_key: "abcd" }],
    ["a non-finite time", { ...enrollment, enrolled_at: Number.NaN }],
    ["a missing suite", { ...enrollment, suite: undefined }],
    ["a missing signature", { ...enrollment, signature: undefined }],
  ])("refuses an enrolment with %s", (_label, value) => {
    expect(isHostEnrollment(value)).toBe(false);
  });

  it.each([
    ["not an object", undefined],
    // The id IS a SHA-256: anything else cannot name an entry.
    ["an enrollment_id that is not a sha256", { ...retirement, enrollment_id: "vps" }],
    ["a key that is not 32 bytes of hex", { ...retirement, public_key: "" }],
    ["a non-finite time", { ...retirement, retired_at: Infinity }],
    ["empty motebit_id", { ...retirement, motebit_id: "" }],
    ["a missing signature", { ...retirement, signature: 7 }],
    ["a missing suite", { ...retirement, suite: null }],
  ])("refuses a retirement with %s", (_label, value) => {
    expect(isHostRetirement(value)).toBe(false);
  });
});
