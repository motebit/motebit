// Two tests with ONE full name ("dup same"): a red: naming it is ambiguous.
import { describe, expect, it } from "vitest";

import { sum } from "./sum.mjs";

describe("dup", () => {
  it("same", () => {
    expect(sum(2, 3)).toBe(5);
  });
  it("same", () => {
    expect(1).toBe(1);
  });
});
