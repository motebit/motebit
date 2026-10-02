import { expect, it } from "vitest";

import { sum } from "../fx/sum.mjs";

it("sums before the bail", () => {
  expect(sum(2, 3)).toBe(5);
});

it("runs after it", async () => {
  await new Promise((r) => setTimeout(r, 300));
  expect(1).toBe(1);
});
