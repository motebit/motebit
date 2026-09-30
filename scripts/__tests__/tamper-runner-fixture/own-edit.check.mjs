// Exits non-zero (RED) only when sum.mjs carries THIS tamper's token and no
// other's — so two tampers on the same file both go red only if each ran in
// its own copy. Sleeps first so concurrent tampers overlap in time.
import { readFileSync } from "node:fs";

const [mine, other] = process.argv.slice(2);
await new Promise((r) => setTimeout(r, 1500));
const text = readFileSync(new URL("./sum.mjs", import.meta.url), "utf8");
process.exit(text.includes(mine) && !text.includes(other) ? 1 : 0);
