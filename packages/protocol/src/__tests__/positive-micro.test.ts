/**
 * `parsePositiveMicro` / `isPositiveMicro` — the one rule for a money amount
 * that must move value: a positive safe integer of micro-units. Validating the
 * DOLLAR value (`> 0`) before `toMicro` is not enough — 1e-7 USD is positive
 * and rounds to 0 micro (the incident that created $0 withdrawals).
 */
import { describe, it, expect } from "vitest";
import { MIN_POSITIVE_MICRO, isPositiveMicro, parsePositiveMicro } from "../money.js";

describe("isPositiveMicro", () => {
  it.each([1, 2, 1_000_000, Number.MAX_SAFE_INTEGER])("accepts %s", (n) => {
    expect(isPositiveMicro(n)).toBe(true);
  });
  it.each([
    0,
    -0,
    -1,
    1.5,
    0.9,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 2,
    "1",
    null,
    undefined,
  ])("rejects %s", (n) => {
    expect(isPositiveMicro(n)).toBe(false);
  });
});

describe("parsePositiveMicro", () => {
  it("names the floor", () => {
    expect(MIN_POSITIVE_MICRO).toBe(1);
  });
  it.each([
    [0.000001, 1],
    [0.0000005, 1], // Math.round(0.5) = 1: the converter's own rounding decides
    [1.5, 1_500_000],
    [0.5, 500_000],
    [1234.567891, 1_234_567_891],
  ])("converts %s USD to %s micro", (dollars, micro) => {
    expect(parsePositiveMicro(dollars)).toBe(micro);
  });
  it.each([
    ["1e-7 (rounds to 0)", 1e-7],
    ["4e-7 (rounds to 0)", 4e-7],
    ["0", 0],
    ["negative", -1],
    ["negative sub-micro", -1e-7],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["beyond safe integer range", 1e10],
    ["string", "1"],
    ["null", null],
    ["undefined", undefined],
    ["object", { amount: 1 }],
  ])("rejects %s", (_, dollars) => {
    expect(parsePositiveMicro(dollars)).toBeNull();
  });
});
