/**
 * Regression lock for the entry-point guard (the bug that shipped in 1.7.7).
 *
 * `motebit-verify` was inert for every INSTALLED invocation — `npx`, a global
 * install on `$PATH`, npm's `.bin/motebit-verify` — because the guard compared
 * `import.meta.url` (the realpath) against `file://${process.argv[1]}` (the
 * SYMLINK path npm hands the bin). They never matched, so `main()` never ran and
 * the CLI silently no-op'd with exit 0. It only worked when `node`-ing the real
 * `dist/cli.js` directly, which no user and no prior test did — the bug lived
 * exactly in the gap between how the package is tested and how it's invoked.
 *
 * Two layers:
 *  - unit: `isMainModule` resolves symlinks on both sides (the fix), so a link
 *    pointing at the module counts as "is main";
 *  - e2e: spawn the BUILT binary through a symlink and assert it actually
 *    produces output — the silent-exit-0 failure is invisible to an exit-code
 *    check, so we assert on stdout. This is the invocation users perform.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainModule } from "../cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "..", "dist", "cli.js");

describe("isMainModule (symlink-robust entry-point guard)", () => {
  it("returns true when argv[1] is a SYMLINK pointing at the module (the bin case)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mv-guard-"));
    try {
      const real = join(dir, "real-module.js");
      writeFileSync(real, "// module\n");
      const link = join(dir, "bin-link"); // mimics .bin/motebit-verify → dist/cli.js
      symlinkSync(real, link);
      // import.meta.url is the realpath; argv[1] is the symlink — the exact
      // mismatch the old string compare failed on.
      expect(isMainModule(pathToFileURL(real).href, link)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false for an unrelated argv[1] (imported as a library, not run)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mv-guard-"));
    try {
      const real = join(dir, "real-module.js");
      const other = join(dir, "something-else.js");
      writeFileSync(real, "// module\n");
      writeFileSync(other, "// other\n");
      expect(isMainModule(pathToFileURL(real).href, other)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when there is no argv[1]", () => {
    expect(isMainModule(import.meta.url, undefined)).toBe(false);
  });
});

describe("motebit-verify built binary, invoked through a symlink (e2e)", () => {
  it.skipIf(!existsSync(CLI))(
    "produces real output via a symlinked bin — not a silent exit-0 no-op",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "mv-bin-"));
      try {
        const link = join(dir, "motebit-verify"); // the shape npm installs
        symlinkSync(CLI, link);
        // `example` verifies the bundled sample — no external artifact needed.
        const r = spawnSync("node", [link, "example"], { encoding: "utf-8" });
        // The bug was silent success: status 0 with EMPTY stdout. Assert on
        // output, then on the verdict + exit code.
        expect(r.stdout).toContain("VALID (receipt)");
        expect(r.stdout).toContain("sovereign");
        expect(r.status).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
