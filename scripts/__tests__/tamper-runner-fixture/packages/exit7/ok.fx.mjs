import { expect, it } from "vitest";

import { sum } from "../fx/sum.mjs";

it("sums", () => {
  expect(sum(2, 3)).toBe(5);
});
