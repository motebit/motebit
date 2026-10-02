// Leaks into a path OUTSIDE anything the runner can reset (FX_LEAK, set by the
// self-test): only the sandwich (green before, red with, green after) can
// tell that the next failure is not the tamper's.
import { existsSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";

import { sum } from "./sum.mjs";

it("finds no global leftover", () => {
  const leak = process.env.FX_LEAK;
  const left = leak != null && existsSync(leak);
  if (leak != null && sum(2, 3) !== 5) writeFileSync(leak, "left by a failing run\n");
  expect(left).toBe(false);
  expect(sum(2, 3)).toBe(5);
});
