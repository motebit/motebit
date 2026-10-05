/**
 * vitest `setupFiles` entry for every vitest run from the repo root (the gate
 * self-tests), registered by the root `vitest.config.mts` beside
 * ./vitest-scrub-git-env.ts.
 *
 * Points `TMPDIR` at a SYMLINK to the real temp directory before any test file
 * loads, so every gate self-test runs where `os.tmpdir()` is not its own
 * realpath — the shape of macOS, where it is /var/folders/… and /var links to
 * /private/var. Git (`rev-parse --absolute-git-dir`, `worktree list`) and
 * `realpathSync` report the resolved path; a fixture root left unresolved then
 * differs from every path git hands back. That broke the pre-push hook's
 * self-tests on macOS only (pre-push-hook.test.ts linked-worktree case,
 * tamper-runner.lifecycle.test.ts startup sweep, 2026-10-04) while Linux CI
 * stayed green. With this file CI runs the macOS shape on every `test:gates`,
 * at no extra cost; scripts/__tests__/symlinked-tmpdir.test.ts goes red if it
 * stops applying. The repair is at the fixture root:
 * `realpathSync(mkdtempSync(join(tmpdir(), …)))`, never a weakened assertion.
 *
 * The link lives inside the real temp directory under a fixed name and points
 * at that directory itself, so a path built through it names the same file as
 * one built from the real directory: a lock under `tmpdir()` still excludes a
 * process that took it without this file. Creation is race-tolerant (parallel
 * workers, concurrent runs); the link is never removed.
 */
import { lstatSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const real = realpathSync(tmpdir());
const link = join(real, "motebit-symlinked-tmpdir");
try {
  symlinkSync(real, link, "dir");
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
}
if (!lstatSync(link).isSymbolicLink() || realpathSync(link) !== real)
  throw new Error(`${link} exists but is not a symlink to ${real}; remove it`);
process.env.TMPDIR = link;
