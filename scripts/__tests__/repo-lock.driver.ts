/**
 * Child-process driver for `repo-lock.harness.ts` — NOT a vitest file.
 *
 *   node --import tsx scripts/__tests__/repo-lock.driver.ts <mode> [args…]
 *
 * One process = one lock client, so the harness can race real processes on
 * the real cross-process lock, SIGKILL one mid-hold, and fake a reused pid.
 * Every critical section is SYNCHRONOUS (a blocking sleep), and every call is
 * `await`ed: that runs unchanged against the synchronous `withRepoLock` of
 * 48f1547 (awaiting a non-promise is a no-op) and the async API after it, so
 * one harness measures both commits.
 *
 * Modes:
 *   hold <dir> <ms>        touch `<dir>/ready-<pid>`, spin until `<dir>/go`
 *                          (a start barrier, so all clients hit the stale lock
 *                          in the same millisecond), acquire, claim
 *                          `<dir>/inside` with O_EXCL (EEXIST = two holders at
 *                          once), sleep, log enter/exit
 *   hold-forever <ready>   acquire, touch `<ready>`, block until killed
 *   perturb-forever <ready> perturb TARGET (truncated), touch `<ready>`,
 *                          block until killed — the kill -9 probe
 *   perturb-noop           the "next run": perturb TARGET with its own bytes
 *   acquire                acquire and release
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withRepoFileReplaced, withRepoLock } from "./repo-file-mutation.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TARGET = resolve(ROOT, "services", "relay", "src", "identity-transparency.ts");

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const now = (): number => performance.timeOrigin + performance.now();

async function main(): Promise<void> {
  const [mode, a, b] = process.argv.slice(2);
  switch (mode) {
    case "hold": {
      const dir = a!;
      const holdMs = Number(b ?? "100");
      const log = join(dir, "log");
      writeFileSync(join(dir, `ready-${process.pid}`), "");
      while (!existsSync(join(dir, "go"))) sleepSync(1);
      await withRepoLock(() => {
        const t0 = now();
        let exclusive = true;
        try {
          closeSync(openSync(join(dir, "inside"), "wx"));
        } catch {
          exclusive = false;
        }
        appendFileSync(log, `enter ${process.pid} ${t0} ${exclusive ? "ok" : "OVERLAP"}\n`);
        sleepSync(holdMs);
        appendFileSync(log, `exit ${process.pid} ${now()}\n`);
        if (exclusive) unlinkSync(join(dir, "inside"));
      });
      return;
    }
    case "hold-forever":
      await withRepoLock(() => {
        writeFileSync(a!, String(process.pid));
        sleepSync(10 * 60_000);
      });
      return;
    case "perturb-forever":
      await withRepoFileReplaced(
        TARGET,
        (original) => original.split("\n").slice(0, 40).join("\n"),
        () => {
          writeFileSync(a!, String(process.pid));
          sleepSync(10 * 60_000);
        },
      );
      return;
    case "perturb-noop":
      await withRepoFileReplaced(
        TARGET,
        (original) => original,
        () => undefined,
      );
      return;
    case "acquire":
      await withRepoLock(() => undefined);
      return;
    default:
      throw new Error(`repo-lock.driver: unknown mode ${String(mode)}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
