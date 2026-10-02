import { describe, it, expect } from "vitest";
import { decodeFragment, encodeFragment, MAX_FRAGMENT_CHARS } from "../fragment.js";
import { SAMPLE_JSON } from "../sample.js";

describe("shareable #r= fragment", () => {
  it("round-trips the sample (minified on the wire, pretty on load)", () => {
    const enc = encodeFragment(SAMPLE_JSON);
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;
    expect(enc.hash.startsWith("#r=")).toBe(true);
    expect(enc.hash).toMatch(/^#r=[A-Za-z0-9_-]+$/); // base64url, no padding
    const dec = decodeFragment(enc.hash);
    expect(dec).toEqual({ ok: true, json: SAMPLE_JSON });
  });

  it("round-trips non-ASCII text", () => {
    const json = JSON.stringify({ result: "café — 収益 ✓" });
    const enc = encodeFragment(json);
    if (!enc.ok) throw new Error("encode failed");
    const dec = decodeFragment(enc.hash);
    expect(dec?.ok && JSON.parse(dec.json)).toEqual({ result: "café — 収益 ✓" });
  });

  it("caps the size with a typed reason", () => {
    const big = JSON.stringify({ result: "x".repeat(MAX_FRAGMENT_CHARS) });
    const enc = encodeFragment(big);
    expect(enc.ok).toBe(false);
    if (!enc.ok) {
      expect(enc.reason).toBe("too_large");
      expect(enc.size).toBeGreaterThan(MAX_FRAGMENT_CHARS);
    }
    expect(decodeFragment(`#r=${"A".repeat(MAX_FRAGMENT_CHARS + 1)}`)).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("no r= → null; garbage → malformed; non-JSON input refuses to encode", () => {
    expect(decodeFragment("")).toBeNull();
    expect(decodeFragment("#other=1")).toBeNull();
    expect(decodeFragment("#r=!!!")).toEqual({ ok: false, reason: "malformed" });
    expect(decodeFragment("#r=bm90IGpzb24")).toEqual({ ok: false, reason: "malformed" }); // "not json"
    expect(encodeFragment("{nope")).toEqual({ ok: false, reason: "malformed_json" });
  });
});
