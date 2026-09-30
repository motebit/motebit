// Fails by RUN COUNT, never by the edit: run n of this file (0 = the
// baseline; counted in FX_STATE-counted when the module loads) fails test
// "first" when n is in FX_FAIL_FIRST, skips it when n is in FX_SKIP_FIRST,
// and fails test "second" when n is in FX_FAIL_SECOND (comma lists).
// FX_THROW_TYPE lists the runs where "first" throws a TypeError instead of
// failing an assertion. A schedule of failures the edit did not cause.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";

import { sum } from "./sum.mjs";

const list = (v) => (v ?? "").split(",").filter(Boolean).map(Number);
const f = `${process.env.FX_STATE}-counted`;
const n = existsSync(f) ? Number(readFileSync(f, "utf8")) : 0;
writeFileSync(f, String(n + 1));

it.skipIf(list(process.env.FX_SKIP_FIRST).includes(n))("first", () => {
  if (list(process.env.FX_THROW_TYPE).includes(n)) throw new TypeError(`run ${n}`);
  expect(list(process.env.FX_FAIL_FIRST).includes(n) ? -1 : sum(2, 3)).toBe(5);
});

it("second", () => {
  expect(list(process.env.FX_FAIL_SECOND).includes(n) ? -1 : sum(2, 3)).toBe(5);
});
