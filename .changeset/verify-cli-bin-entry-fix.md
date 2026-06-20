---
"@motebit/verify": minor
---

Fix the `motebit-verify` CLI being inert for every installed invocation, and add `motebit-verify example`.

**The bug (shipped in 1.7.7):** the entry-point guard compared `import.meta.url` (the module realpath) against `` `file://${process.argv[1]}` `` (the raw argv path). Every real way a user runs the binary — `npx @motebit/verify`, a global install on `$PATH`, npm's `.bin/motebit-verify` — passes the **symlink** as `argv[1]`, which never equals the realpath, so `main()` never ran and the CLI **silently no-op'd with exit 0** for `--help`, `--version`, and every artifact. It only worked when `node`-ing the real `dist/cli.js` directly, which no user does — a violation of the package's own Rule 5 (never silent acceptance). The bug lived exactly in the gap between how the package was tested (importing helpers, or `node dist/cli.js`) and how it is invoked (a symlinked bin).

**The fix:** `isMainModule` now resolves symlinks on both sides via `realpathSync` before comparing, so the bin works the way npm installs it. The exit-code contract is restored end-to-end: `0` valid / `1` invalid-but-detected / `2` usage-or-IO (`no args` → 2, bad path → 2, tampered receipt → 1, `--version` prints the version).

**Regression lock:** a new test spawns the **built binary through a symlink** (the exact user invocation) and asserts it produces real output — the silent-exit-0 failure is invisible to an exit-code check, so the assertion is on stdout. Verified to bite: reverting the guard to the old string compare fails the test with `expected '' to contain 'VALID (receipt)'`.

**New `motebit-verify example`:** verifies a bundled sample receipt shipped inside the package, so the tool proves itself the instant it's installed — closing the "the README says `motebit-verify cred.json` but a new user has no `cred.json`" gap.
