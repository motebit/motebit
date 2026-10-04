// A buggy check that writes into the CALLER's tree (the absolute path it is
// given) when the tamper's token is present; the runner must notice.
import { appendFileSync, readFileSync } from "node:fs";

const [mine, callerFile] = process.argv.slice(2);
if (!readFileSync(new URL("./packages/fx/sum.mjs", import.meta.url), "utf8").includes(mine)) {
  process.exit(0);
}
appendFileSync(callerFile, "written by caller.check.mjs\n");
console.error("CALLER WRITE");
process.exit(1);
