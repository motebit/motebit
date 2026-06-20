/**
 * The published tarball must contain everything the binary needs at runtime.
 *
 * The symlink e2e (`cli-bin-invocation.test.ts`) proves the installed bin
 * *executes*. This proves the other half: the tarball *ships* what it executes
 * against. Both `dist/cli.js` (the `bin` target) and `examples/sample-receipt.json`
 * (resolved at runtime by `motebit-verify example`, relative to dist/) live or
 * die by `files[]`. Drop either from `files[]` and the package installs but the
 * front door silently breaks — the install-path failure class that let the 1.7.7
 * entry-guard bug reach npm undetected. `npm pack --dry-run --json` reports
 * exactly what would publish, deterministically and offline.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..", "..");

function packedFiles(): string[] {
  const r = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: PKG_ROOT,
    encoding: "utf-8",
  });
  expect(r.status, r.stderr).toBe(0);
  const report = JSON.parse(r.stdout) as Array<{ files: Array<{ path: string }> }>;
  return report[0]!.files.map((f) => f.path);
}

describe("@motebit/verify published tarball contents", () => {
  it("ships every declared bin target (the entry point must be in the package)", () => {
    const pkg = JSON.parse(readFileSync(resolve(PKG_ROOT, "package.json"), "utf-8")) as {
      bin?: Record<string, string>;
    };
    const binTargets = Object.values(pkg.bin ?? {}).map((p) => p.replace(/^\.\//, ""));
    expect(binTargets.length).toBeGreaterThan(0);
    const files = packedFiles();
    for (const target of binTargets) {
      expect(files, `bin target ${target} missing from the published tarball`).toContain(target);
    }
  });

  it("ships the bundled sample receipt `motebit-verify example` resolves at runtime", () => {
    // examples/ is a sibling of dist/ in both repo and tarball; the CLI resolves
    // ../examples/sample-receipt.json from dist/cli.js. If files[] drops it,
    // `motebit-verify example` throws on a missing file post-install.
    expect(packedFiles()).toContain("examples/sample-receipt.json");
  });
});
