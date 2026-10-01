// The fixture package's build: writes sum(2, 3) to a `dist` output and to a
// non-`dist` ignored output (`out/`), both of which gen.fx.mjs reads, and
// emits the module itself as `dist/sum.mjs` (what dual.fx.mjs imports).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { sum } from "./sum.mjs";

for (const dir of ["dist", "out"]) {
  mkdirSync(new URL(`./${dir}/`, import.meta.url), { recursive: true });
  writeFileSync(new URL(`./${dir}/gen.txt`, import.meta.url), `${sum(2, 3)}\n`);
}

writeFileSync(
  new URL("./dist/sum.mjs", import.meta.url),
  readFileSync(new URL("./sum.mjs", import.meta.url)),
);
