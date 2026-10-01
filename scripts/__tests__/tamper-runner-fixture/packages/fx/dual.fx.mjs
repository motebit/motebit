// Two copies of one module, as a test that imports a package's src directly
// while the code under it uses the package's dist: the source (./sum.mjs) is
// loaded, but the assertion rests only on the BUILT copy (dist/).
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

import { sum as built } from "./dist/sum.mjs";
import { sum } from "./sum.mjs";

it("the built copy holds sum(2, 3)", () => {
  expect(typeof sum).toBe("function");
  expect(built(2, 3)).toBe(5);
  expect(readFileSync(new URL("./dist/gen.txt", import.meta.url), "utf8")).toBe("5\n");
});
