import { describe, it, expect } from "vitest";
import { parseInterval } from "../intervals.js";

describe("parseInterval", () => {
  it("parses minutes", () => {
    expect(parseInterval("30m")).toBe(1_800_000);
    expect(parseInterval("5m")).toBe(300_000);
    expect(parseInterval("1m")).toBe(60_000);
  });

  it("parses hours", () => {
    expect(parseInterval("1h")).toBe(3_600_000);
    expect(parseInterval("6h")).toBe(21_600_000);
    expect(parseInterval("12h")).toBe(43_200_000);
  });

  it("parses days", () => {
    expect(parseInterval("1d")).toBe(86_400_000);
    expect(parseInterval("7d")).toBe(604_800_000);
  });

  it("throws on invalid input", () => {
    expect(() => parseInterval("")).toThrow();
    expect(() => parseInterval("abc")).toThrow();
    expect(() => parseInterval("30")).toThrow();
    expect(() => parseInterval("30s")).toThrow();
    expect(() => parseInterval("m")).toThrow();
    expect(() => parseInterval("0m")).toThrow();
  });
});
