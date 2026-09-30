// The fixture's main test file: two tests under one describe block, so a
// tamper can break one while its sibling stays green.
import { describe, expect, it } from "vitest";

import { sub, sum } from "./sum.mjs";

describe("sum", () => {
  it("adds two numbers", () => {
    expect(sum(2, 3)).toBe(5);
  });

  it("subtracts two numbers", () => {
    expect(sub(5, 3)).toBe(2);
  });
});
