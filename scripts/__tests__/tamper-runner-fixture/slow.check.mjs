// When the tamper's token is present: starts a GRANDCHILD (same process
// group) that records its pid in the sentinel file it is given and runs for a
// minute, then waits on it — long enough for the self-test to signal (or
// SIGKILL) the runner mid-tamper. Killing only the direct child leaves the
// grandchild running.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const [mine, sentinel] = process.argv.slice(2);
if (!readFileSync(new URL("./packages/fx/sum.mjs", import.meta.url), "utf8").includes(mine)) {
  process.exit(0);
}
const code =
  'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 60000);';
const child = spawn(process.execPath, ["-e", code, sentinel], { stdio: "ignore" });
await new Promise((r) => child.on("exit", r));
