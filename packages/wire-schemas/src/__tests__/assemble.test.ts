/**
 * Unit tests for the shared JSON Schema assembly helper. Covers the happy
 * path + the defs-bag guard — the helper is generic across every wire format
 * in this package, so these tests guard the shared behavior for all of them.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { assembleJsonSchemaFor, toDraft7 } from "../assemble.js";

const META = {
  $id: "https://example.com/test.json",
  title: "Test",
  description: "Test schema",
};

describe("assembleJsonSchemaFor", () => {
  it("wraps the native draft-7 body in the published envelope, replacing the renderer's $schema", () => {
    const raw = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    };
    const out = assembleJsonSchemaFor(raw, META);
    expect(out.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(out.$id).toBe(META.$id);
    expect(out.title).toBe(META.title);
    expect(out.description).toBe(META.description);
    expect(out.type).toBe("object");
    expect(out.properties).toEqual(raw.properties);
    expect(out.required).toEqual(["a"]);
    expect(out.additionalProperties).toBe(false);
    // The meta envelope leads; the body follows.
    expect(Object.keys(out).slice(0, 5)).toEqual([
      "$schema",
      "$id",
      "title",
      "description",
      "type",
    ]);
  });

  it("throws if the renderer emitted a $defs/definitions bag (a schema now produces refs)", () => {
    expect(() =>
      assembleJsonSchemaFor({ type: "object", $defs: { X: { type: "object" } } }, META),
    ).toThrow(/\$defs\/definitions bag/);
    expect(() =>
      assembleJsonSchemaFor({ type: "object", definitions: { X: { type: "object" } } }, META),
    ).toThrow(/\$defs\/definitions bag/);
  });

  it("toDraft7 renders a zod schema to a flat draft-7 object (no refs for this package's shapes)", () => {
    const raw = toDraft7(z.object({ a: z.string() }).strict());
    expect(raw.type).toBe("object");
    expect("$defs" in raw).toBe(false);
    expect("definitions" in raw).toBe(false);
  });
});
