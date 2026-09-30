// Fails (red marker, exit 1) only when sum.mjs carries THIS tamper's token and
// no other's — so two tampers on the same file both go red only if each ran in
// its own copy. Sleeps first so concurrent tampers overlap in time.
import { readFileSync } from "node:fs";

const [mine, other] = process.argv.slice(2);
const text = () => readFileSync(new URL("./packages/fx/sum.mjs", import.meta.url), "utf8");
if (!text().includes(mine)) process.exit(0);
await new Promise((r) => setTimeout(r, 1500));
if (text().includes(mine) && !text().includes(other)) {
  console.error(`OWN COPY ${mine}`);
  process.exit(1);
}
