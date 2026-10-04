// Imports sum.mjs INSIDE the test: a syntax error in it fails the test, not
// the file's collection.
import { expect, it } from "vitest";

it("adds via a dynamic import", async () => {
  const { sum } = await import("./sum.mjs");
  expect(sum(2, 3)).toBe(5);
});
