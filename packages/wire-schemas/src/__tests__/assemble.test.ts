/**
 * Unit tests for the shared JSON Schema assembly helper. Covers happy
 * path + both invariant-violation error paths — the helper is generic
 * across every wire format in this package, so these tests guard the
 * shared behavior for all of them.
 */
import { describe, expect, it } from "vitest";

import { assembleJsonSchemaFor } from "../assemble.js";

const META = {
  $id: "https://example.com/test.json",
  title: "Test",
  description: "Test schema",
};

describe("assembleJsonSchemaFor", () => {
  it("assembles the happy-path schema from a definitions envelope", () => {
    const raw = {
      $ref: "#/definitions/Widget",
      definitions: { Widget: { type: "object", properties: { a: { type: "string" } } } },
    };
    const out = assembleJsonSchemaFor("Widget", raw, META);
    expect(out.$id).toBe(META.$id);
    expect(out.title).toBe(META.title);
    expect(out.type).toBe("object");
    expect(out.definitions).toEqual(raw.definitions);
  });

  it("throws if the raw schema has no definitions bag (upstream library changed)", () => {
    expect(() => assembleJsonSchemaFor("Widget", { type: "object" }, META)).toThrow(
      /definitions bag/,
    );
  });

  it("throws if definitions is present but has no matching root key", () => {
    expect(() =>
      assembleJsonSchemaFor("Widget", { definitions: { Other: { type: "object" } } }, META),
    ).toThrow(/definitions\.Widget/);
  });

  it("uses the caller-supplied name in the error message (not a hardcoded label)", () => {
    expect(() => assembleJsonSchemaFor("Zephyr", {}, META)).toThrow(/Zephyr/);
  });
});
