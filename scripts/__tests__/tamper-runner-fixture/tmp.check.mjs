// Fails (red marker, exit 1) only when this tamper's token is in sum.mjs AND
// the temp dir is private to it: it writes its token to $TMPDIR, waits, and
// reads it back. A temp dir shared with a concurrent tamper reads the other's.
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [mine] = process.argv.slice(2);
if (!readFileSync(new URL("./packages/fx/sum.mjs", import.meta.url), "utf8").includes(mine)) {
  process.exit(0);
}
const probe = join(tmpdir(), "fx-tmp-probe");
writeFileSync(probe, mine);
await new Promise((r) => setTimeout(r, 1500));
if (readFileSync(probe, "utf8") === mine) {
  console.error(`PRIVATE TMP ${mine}`);
  process.exit(1);
}
