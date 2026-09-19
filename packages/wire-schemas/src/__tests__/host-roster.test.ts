/**
 * The machine roster's wire schemas.
 *
 * Shape only, on hand-built fixtures: this package does not depend on
 * `@motebit/crypto`, and a dependency edge is not something to add for a
 * test. That the SIGNER's output parses is asserted where both are in
 * reach — the relay's ingest, which runs real artifacts through these.
 */
import { describe, it, expect } from "vitest";
import {
  HostEnrollmentSchema,
  HostRetirementSchema,
  buildHostEnrollmentJsonSchema,
  buildHostRetirementJsonSchema,
  HOST_ENROLLMENT_SCHEMA_ID,
  HOST_RETIREMENT_SCHEMA_ID,
} from "../host-roster.js";

function real() {
  const public_key = "ab".repeat(32);
  const enrollment = {
    motebit_id: "019d903f-13de-75a4-8341-58319e0a2f16",
    device_id: "01a04bb5-9c87-7d2c-bc6c-2f4cd3ce11d8",
    public_key,
    enrolled_at: 1_776_239_454_545,
    suite: "motebit-jcs-ed25519-b64-v1" as const,
    signature: "c2lnbmF0dXJl",
  };
  const retirement = {
    motebit_id: enrollment.motebit_id,
    enrollment_id: "cd".repeat(32),
    public_key,
    retired_at: 1_776_239_999_999,
    suite: "motebit-jcs-ed25519-b64-v1" as const,
    signature: "c2lnbmF0dXJl",
  };
  return { enrollment, retirement };
}

describe("HostEnrollmentSchema / HostRetirementSchema", () => {
  it("accepts a well-formed enrolment and retirement", () => {
    const { enrollment, retirement } = real();
    expect(HostEnrollmentSchema.safeParse(enrollment).success).toBe(true);
    expect(HostRetirementSchema.safeParse(retirement).success).toBe(true);
  });

  it("is STRICT — nothing mutable rides along in a membership record", () => {
    // The doctrine keeps capabilities and display names OUT of the signed
    // body: they change, and the body is served verbatim forever. A
    // permissive schema would let them back in one producer at a time.
    const { enrollment, retirement } = real();
    expect(HostEnrollmentSchema.safeParse({ ...enrollment, hosts: ["run"] }).success).toBe(false);
    expect(HostEnrollmentSchema.safeParse({ ...enrollment, device_name: "x" }).success).toBe(false);
    expect(HostEnrollmentSchema.safeParse({ ...enrollment, prev: "0".repeat(64) }).success).toBe(
      false,
    );
    expect(HostRetirementSchema.safeParse({ ...retirement, reason: "lost" }).success).toBe(false);
  });

  it("has one spelling of a key and of an entry id — lowercase hex", () => {
    const { enrollment, retirement } = real();
    expect(
      HostEnrollmentSchema.safeParse({
        ...enrollment,
        public_key: enrollment.public_key.toUpperCase(),
      }).success,
    ).toBe(false);
    expect(
      HostRetirementSchema.safeParse({
        ...retirement,
        enrollment_id: retirement.enrollment_id.toUpperCase(),
      }).success,
    ).toBe(false);
    expect(HostRetirementSchema.safeParse({ ...retirement, enrollment_id: "vps" }).success).toBe(
      false,
    );
  });

  it("refuses an unknown suite, an empty machine, and a missing signature", () => {
    const { enrollment } = real();
    expect(HostEnrollmentSchema.safeParse({ ...enrollment, suite: "other" }).success).toBe(false);
    expect(HostEnrollmentSchema.safeParse({ ...enrollment, device_id: "" }).success).toBe(false);
    const { signature: _s, ...unsigned } = enrollment;
    expect(HostEnrollmentSchema.safeParse(unsigned).success).toBe(false);
  });

  it("takes unix ms as a non-negative INTEGER, and a signature as unpadded base64url", () => {
    // A float is valid JSON and a cross-language id hazard: two
    // implementations that print it differently derive two ids.
    const { enrollment, retirement } = real();
    for (const t of [1000.5, -1]) {
      expect(HostEnrollmentSchema.safeParse({ ...enrollment, enrolled_at: t }).success).toBe(false);
      expect(HostRetirementSchema.safeParse({ ...retirement, retired_at: t }).success).toBe(false);
    }
    for (const sig of ["c2ln==", "ab+/", "with space "]) {
      expect(HostEnrollmentSchema.safeParse({ ...enrollment, signature: sig }).success).toBe(false);
    }
  });

  it("does not confuse the two artifacts", () => {
    const { enrollment, retirement } = real();
    expect(HostEnrollmentSchema.safeParse(retirement).success).toBe(false);
    expect(HostRetirementSchema.safeParse(enrollment).success).toBe(false);
  });

  it("emits JSON Schemas under their stable ids, closed to extra fields", () => {
    const e = buildHostEnrollmentJsonSchema();
    const r = buildHostRetirementJsonSchema();
    expect(e.$id).toBe(HOST_ENROLLMENT_SCHEMA_ID);
    expect(r.$id).toBe(HOST_RETIREMENT_SCHEMA_ID);
    expect(e.additionalProperties).toBe(false);
    expect(r.additionalProperties).toBe(false);
    expect(e.required).toEqual(
      expect.arrayContaining(["motebit_id", "device_id", "public_key", "suite", "signature"]),
    );
    expect(r.required).toEqual(expect.arrayContaining(["enrollment_id", "public_key"]));
  });
});
