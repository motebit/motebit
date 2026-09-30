#!/usr/bin/env node
/**
 * The single entry point for turbo runs that may include cached test tasks
 * (root `pnpm test` / `pnpm test:coverage`, .husky/pre-push, CI).
 *
 * It exports MOTEBIT_TEST_RUNTIME — the exact runtime (Node version, platform,
 * arch) the tests are about to run on — which `test` and `test:coverage` hash
 * (turbo.json `env`). A result cached under one runtime therefore can never be
 * replayed under another (C1: a Node-22-only test cached green must not replay
 * green on Node 20). The runtime input tracer asserts at setup that the value
 * matches the runtime actually running the tests, so bypassing this wrapper
 * (`pnpm turbo run test`) fails loudly instead of replaying stale results.
 *
 * Usage: node scripts/turbo-run.mjs run <tasks…> [turbo flags]
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  ...process.env,
  MOTEBIT_TEST_RUNTIME: `node-${process.version}-${process.platform}-${process.arch}`,
};
const bin = join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "turbo.cmd" : "turbo",
);
const r = spawnSync(bin, process.argv.slice(2), { stdio: "inherit", env, cwd: process.cwd() });
if (r.error) {
  console.error(`turbo-run: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
