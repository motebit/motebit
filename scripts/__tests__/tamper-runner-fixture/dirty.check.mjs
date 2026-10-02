// A buggy check that leaves its OWN copy dirty when the tamper's token is
// present: it appends to a tracked file no edit touched (mode "tracked"),
// creates an untracked one ("untracked"), or appends to a file the caller has
// uncommitted changes in ("overlay": git status alone cannot see that). The
// runner must not reuse that copy.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const [mine, mode] = process.argv.slice(2);
if (!readFileSync(new URL("./packages/fx/sum.mjs", import.meta.url), "utf8").includes(mine)) {
  process.exit(0);
}
if (mode === "tracked" || mode === "overlay") {
  appendFileSync(new URL("./packages/lib/value.txt", import.meta.url), "x\n");
} else writeFileSync(new URL("./stray.txt", import.meta.url), "left behind\n");
console.error("DIRTY SLOT");
process.exit(1);
