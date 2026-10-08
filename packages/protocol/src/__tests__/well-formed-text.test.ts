import { describe, expect, it } from "vitest";

import { toWellFormedText, truncateWellFormed } from "../index.js";

const UNPAIRED = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const SAMPLE = "a😀b👍🏽cé🇺🇸d";

describe("toWellFormedText", () => {
  it("is the identity on well-formed text", () => {
    for (const s of ["", "plain", SAMPLE, "😀"]) expect(toWellFormedText(s)).toBe(s);
  });

  it("replaces each unpaired surrogate with U+FFFD and keeps valid pairs", () => {
    expect(toWellFormedText("x \ud800")).toBe("x �");
    expect(toWellFormedText("\udc00y")).toBe("�y");
    expect(toWellFormedText("\udc00\ud800")).toBe("��");
    expect(toWellFormedText("😀\ud83d")).toBe("😀�");
  });

  it("yields the bytes TextEncoder yields (so a result_hash taken before it is unchanged)", () => {
    const enc = new TextEncoder();
    for (const s of ["x \ud800", "\udc00", "ok 😀 \ude00", SAMPLE]) {
      expect(enc.encode(toWellFormedText(s))).toEqual(enc.encode(s));
    }
  });
});

describe("truncateWellFormed", () => {
  it("never ends inside a surrogate pair, at every index", () => {
    for (let i = 0; i <= SAMPLE.length + 1; i++) {
      const t = truncateWellFormed(SAMPLE, i);
      expect(UNPAIRED.test(t)).toBe(false);
      expect(SAMPLE.startsWith(t)).toBe(true);
      expect(t.length).toBeLessThanOrEqual(i);
      expect(t.length).toBeGreaterThanOrEqual(Math.min(i, SAMPLE.length) - 1);
    }
  });

  it("is a no-op when the text already fits", () => {
    expect(truncateWellFormed(SAMPLE, SAMPLE.length)).toBe(SAMPLE);
    expect(truncateWellFormed("", 0)).toBe("");
  });

  it("repairs an unpaired surrogate already in the input", () => {
    expect(truncateWellFormed("\udc00abc", 2)).toBe("�a");
  });

  it("treats a negative or fractional limit as its floor at zero", () => {
    expect(truncateWellFormed("abc", -1)).toBe("");
    expect(truncateWellFormed("abc", 1.7)).toBe("a");
  });
});
