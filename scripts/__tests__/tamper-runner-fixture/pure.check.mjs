// A non-vitest check that also refuses to run on a module carrying anything
// but the edit: a tamper-runner load sentinel in sum.mjs exits 3 with no red
// marker (so an edited run that carried one cannot read RED).
import { readFileSync } from "node:fs";

import { sum } from "./packages/fx/sum.mjs";

if (
  readFileSync(new URL("./packages/fx/sum.mjs", import.meta.url), "utf8").includes("load sentinel")
) {
  console.error("sum.mjs carries a load sentinel");
  process.exit(3);
}
if (sum(2, 3) !== 5) {
  console.error(`PURE CHECK FAILED: sum(2, 3) = ${sum(2, 3)}`);
  process.exit(1);
}
