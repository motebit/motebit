// The fixture package's build: writes sum(2, 3) to a `dist` output and to a
// non-`dist` ignored output (`out/`), both of which gen.fx.mjs reads.
import { mkdirSync, writeFileSync } from "node:fs";

import { sum } from "./sum.mjs";

for (const dir of ["dist", "out"]) {
  mkdirSync(new URL(`./${dir}/`, import.meta.url), { recursive: true });
  writeFileSync(new URL(`./${dir}/gen.txt`, import.meta.url), `${sum(2, 3)}\n`);
}
