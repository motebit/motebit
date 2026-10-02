// vitest's file filter is a substring: `vitest run inner.fx.mjs` also runs
// winner.fx.mjs. Only this file's results are the target's.
import { expect, it } from "vitest";

it("inner stays green", () => {
  expect(1).toBe(1);
});
