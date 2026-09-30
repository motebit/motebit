// The fixture's main test file: two tests under one describe block, so a
// tamper can break one while its sibling stays green.
import { afterAll, describe, expect, it } from "vitest";

import { sub, sum } from "./sum.mjs";

// A file-level teardown that fails only when sum(0, 0) is wrong: a tamper
// that trips it produces a SUITE-level error next to a failing test.
afterAll(() => {
  if (sum(0, 0) !== 0) throw new Error(`teardown: sum(0, 0) = ${sum(0, 0)}`);
});

describe("sum", () => {
  it("adds two numbers", () => {
    expect(sum(2, 3)).toBe(5);
  });

  it("subtracts two numbers", () => {
    expect(sub(5, 3)).toBe(2);
  });
});
