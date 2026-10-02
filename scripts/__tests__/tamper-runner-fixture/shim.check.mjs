// Runs node_modules/.bin/fxlib, a pnpm-style shim that bakes the tree's
// ABSOLUTE path in (see the harness). Red marker when the shim read THIS
// copy's edited packages/lib/value.txt, not the caller's.
import { execFileSync } from "node:child_process";

const out = execFileSync(new URL("./node_modules/.bin/fxlib", import.meta.url).pathname, {
  encoding: "utf8",
});
if (out.trim() === "bad") {
  console.error("SHIM READ THIS COPY");
  process.exit(1);
}
