// A flaky test: each run flips a coin (a seeded PRNG over a run counter kept
// in FX_STATE-flaky, so the self-test is reproducible) and fails on tails —
// a failure no edit causes. Run 0 (the baseline) is heads for the seed used.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";

import { sum } from "./sum.mjs";

/** mulberry32: a 32-bit PRNG, one draw per seed. */
function draw(seed) {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

it("flips a coin", () => {
  const f = `${process.env.FX_STATE}-flaky`;
  const n = existsSync(f) ? Number(readFileSync(f, "utf8")) : 0;
  writeFileSync(f, String(n + 1));
  expect(sum(2, 3)).toBe(5);
  expect(draw(Number(process.env.FX_SEED ?? 0) * 1000 + n) < 0.5).toBe(true);
});
