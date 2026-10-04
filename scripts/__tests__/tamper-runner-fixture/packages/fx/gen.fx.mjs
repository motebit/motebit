// Reads only the BUILT outputs (dist/ and out/), never the source.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("the built outputs hold sum(2, 3)", () => {
  for (const dir of ["dist", "out"]) {
    expect(readFileSync(new URL(`./${dir}/gen.txt`, import.meta.url), "utf8")).toBe("5\n");
  }
});
