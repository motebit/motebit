/**
 * One strict parser for money-denominated env (ceilings, floors, budgets).
 *
 * `parseInt` accepts a numeric PREFIX ("12abc" → 12, "1.5" → 1, "1e9" → 1) and
 * turns "" into NaN; `Number("")` is 0 and `BigInt("")` is 0n. Each of those has
 * flowed into a money value: an empty `MOTEBIT_CLERK_CEILING_MICRO` became a NaN
 * lifetime limit inside the clerk's own signed grant (NaN canonicalizes to
 * null, so the grant still verifies). `parseMicroEnv` is the only reading: unset
 * keeps the documented default; anything set must be a plain non-negative
 * decimal integer within 2^53−1, or the boot is refused with a repair message.
 */
import { describe, it, expect } from "vitest";
import { parseMicroEnv } from "../money-env.js";

const NAME = "MOTEBIT_TEST_CEILING_MICRO";

describe("parseMicroEnv — refuses every malformed money value", () => {
  const REFUSED = [
    "NaN",
    "Infinity",
    "-Infinity",
    "-1",
    "1.5",
    "",
    "   ",
    "abc",
    "12abc",
    "1e6",
    "0x10",
    "+5",
    String(2 ** 53),
    "99999999999999999999",
  ];
  for (const raw of REFUSED) {
    it(`${JSON.stringify(raw)} ⇒ throws naming the variable`, () => {
      expect(() => parseMicroEnv(NAME, raw, 1_000_000)).toThrow(NAME);
    });
  }
});

describe("parseMicroEnv — accepts plain non-negative integers", () => {
  it("unset ⇒ the documented default", () => {
    expect(parseMicroEnv(NAME, undefined, 1_000_000)).toBe(1_000_000);
  });
  it.each([
    ["0", 0],
    ["250000", 250_000],
    [" 42 ", 42],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ])("%j ⇒ %d", (raw, want) => {
    expect(parseMicroEnv(NAME, raw, 1)).toBe(want);
  });
});
