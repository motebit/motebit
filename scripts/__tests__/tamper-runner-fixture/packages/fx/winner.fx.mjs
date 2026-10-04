// Matched by the `inner.fx.mjs` filter too (see inner.fx.mjs); checks sum.
import { expect, it } from "vitest";

import { sum } from "./sum.mjs";

it("winner sums", () => {
  expect(sum(2, 3)).toBe(5);
});
