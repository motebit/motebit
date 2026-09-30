// When the tamper's token is present: records its pid in the sentinel file it
// is given, then runs for a minute — long enough for the self-test to signal
// the runner mid-tamper.
import { readFileSync, writeFileSync } from "node:fs";

const [mine, sentinel] = process.argv.slice(2);
if (!readFileSync(new URL("./packages/fx/sum.mjs", import.meta.url), "utf8").includes(mine)) {
  process.exit(0);
}
writeFileSync(sentinel, String(process.pid));
await new Promise((r) => setTimeout(r, 60_000));
