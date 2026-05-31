import { describe, it, expect } from "vitest";
import { canonicalJson } from "../canonical";

// `canonicalJson` is the deterministic serializer every signed-payload helper
// depends on — two structurally-equal payloads MUST produce identical bytes, or
// Ed25519 signatures stop verifying. Tested directly here (it was previously
// only exercised transitively through the federation settlement leaf, which the
// §9.1 convergence removed).
describe("canonicalJson", () => {
  it("serializes primitives like JSON.stringify", () => {
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson("hi")).toBe('"hi"');
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson(0)).toBe("0");
  });

  it("serializes null, and returns undefined for undefined (matches JSON.stringify)", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(undefined)).toBe(undefined as unknown as string);
  });

  it("sorts object keys so insertion order does not change the bytes", () => {
    const a = canonicalJson({ b: 1, a: 2, c: 3 });
    const b = canonicalJson({ c: 3, a: 2, b: 1 });
    expect(a).toBe('{"a":2,"b":1,"c":3}');
    expect(a).toBe(b);
  });

  it("recurses into arrays in order (order IS significant for arrays)", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it("omits keys whose value is undefined (matches JSON.stringify)", () => {
    expect(canonicalJson({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it("recurses into nested objects, sorting keys at every level", () => {
    const out = canonicalJson({ z: { y: 1, x: 2 }, a: [{ n: 1, m: 2 }] });
    expect(out).toBe('{"a":[{"m":2,"n":1}],"z":{"x":2,"y":1}}');
  });

  it("is deterministic for deeply-equal nested payloads built in different orders", () => {
    const p1 = { outer: { b: [1, 2], a: "x" }, id: "k" };
    const p2 = { id: "k", outer: { a: "x", b: [1, 2] } };
    expect(canonicalJson(p1)).toBe(canonicalJson(p2));
  });

  it("serializes an empty object and empty array", () => {
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson([])).toBe("[]");
  });
});
