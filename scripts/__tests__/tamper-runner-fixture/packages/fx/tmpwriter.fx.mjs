// A test that keeps a cache in $TMPDIR on EVERY run (as real tools do).
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { sum } from "./sum.mjs";

it("writes a cache and checks sum", () => {
  writeFileSync(join(tmpdir(), "fx-cache"), "cache\n");
  expect(sum(2, 3)).toBe(5);
});
