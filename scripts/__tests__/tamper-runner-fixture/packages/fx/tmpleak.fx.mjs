// Fails when $TMPDIR holds anything a fixture test left there (fx-*), and
// leaves fx-leak behind itself when sum() is wrong: a slot TMPDIR that is not
// emptied between runs turns the NEXT entry red whatever its edit.
import { readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { sum } from "./sum.mjs";

it("finds no leftover in TMPDIR", () => {
  const left = readdirSync(tmpdir()).filter((n) => n.startsWith("fx-"));
  if (sum(2, 3) !== 5) writeFileSync(join(tmpdir(), "fx-leak"), "left by a failing run\n");
  expect(left).toEqual([]);
  expect(sum(2, 3)).toBe(5);
});
