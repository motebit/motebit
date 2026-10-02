// tmpleak.fx.mjs's twin for $HOME and $XDG_CACHE_HOME.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { sum } from "./sum.mjs";

it("finds no leftover in HOME", () => {
  const cache = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  const marks = [join(homedir(), ".fx-leak"), join(cache, "fx-leak")];
  const left = marks.filter((m) => existsSync(m));
  if (sum(2, 3) !== 5) {
    mkdirSync(cache, { recursive: true });
    for (const m of marks) writeFileSync(m, "left by a failing run\n");
  }
  expect(left).toEqual([]);
  expect(sum(2, 3)).toBe(5);
});
