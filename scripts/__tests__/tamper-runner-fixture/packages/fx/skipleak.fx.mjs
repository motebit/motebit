// A test that SKIPS itself when a global leftover (FX_LEAK) exists, and leaves
// one when sum() is wrong: after a failing run the post-run is "green" (the
// sibling passes, nothing fails) only because the leaked state hid the test.
import { existsSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";

import { sum } from "./sum.mjs";

const leak = process.env.FX_LEAK ?? "";

it.skipIf(leak !== "" && existsSync(leak))("sums unless hidden", () => {
  if (leak !== "" && sum(2, 3) !== 5) writeFileSync(leak, "left by a failing run\n");
  expect(sum(2, 3)).toBe(5);
});

it("a sibling that always passes", () => {
  expect(1).toBe(1);
});
