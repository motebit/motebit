import { describe, it, expect } from "vitest";
import { highlightJson } from "../highlight.js";
import { SAMPLE_JSON } from "../sample.js";

const roleOf = (text: string, needle: string) =>
  highlightJson(text).find((s) => s.text.includes(needle))?.role;

describe("highlightJson", () => {
  it("is lossless — segments concatenate back to the input", () => {
    for (const t of [SAMPLE_JSON, '{"a":1', '{"x":"\\"q\\""}', "not json", ""]) {
      expect(
        highlightJson(t)
          .map((s) => s.text)
          .join(""),
      ).toBe(t);
    }
  });

  it("colors the top-level signature / public_key / suite; everything else is signed body", () => {
    const parsed = JSON.parse(SAMPLE_JSON) as Record<string, string>;
    expect(roleOf(SAMPLE_JSON, parsed["signature"]!)).toBe("signature");
    expect(roleOf(SAMPLE_JSON, parsed["public_key"]!)).toBe("key");
    // The nested receipt's suite comes first (signed body); the top-level one is "suite".
    const suites = highlightJson(SAMPLE_JSON).filter((s) =>
      s.text.includes('"motebit-jcs-ed25519-b64-v1"'),
    );
    expect(suites.map((s) => s.role)).toEqual(["body", "suite"]);
    expect(roleOf(SAMPLE_JSON, parsed["result"]!)).toBe("body");
  });

  it("a nested receipt's signature is part of the parent's signed body", () => {
    const nestedSig = (JSON.parse(SAMPLE_JSON) as { delegation_receipts: { signature: string }[] })
      .delegation_receipts[0]!.signature;
    expect(roleOf(SAMPLE_JSON, nestedSig)).toBe("body");
  });

  it("works on minified JSON too", () => {
    const min = JSON.stringify({ result: "r", signature: "SIG", suite: "S" });
    expect(roleOf(min, '"SIG"')).toBe("signature");
    expect(roleOf(min, '"r"')).toBe("body");
  });
});
