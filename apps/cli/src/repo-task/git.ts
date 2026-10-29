/**
 * The one way the repo-task adapters run git: an isolated environment (no
 * system or global config, no replace objects, literal pathspecs, no
 * prompt), argv only (never a shell), and any path bytes passed on stdin,
 * never as an argument — so no path is shell-, glob- or option-interpreted.
 */
import { spawn } from "node:child_process";

/** Hard ceiling on what one git call may return (a blob, a tree listing). */
export const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024 + 1024;

/** A full lowercase object id (sha1 or sha256). */
export const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The environment every git call runs under: nothing outside the repository steers it. */
export function isolatedGitEnv(
  gitDir: string,
  extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    GIT_DIR: gitDir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...extra,
  };
}

/** Run `git <args>` with optional stdin; resolve stdout, reject on a non-zero exit. */
export function runGit(
  gitDir: string,
  args: readonly string[],
  opts: { readonly input?: Uint8Array; readonly env?: Readonly<Record<string, string>> } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      env: isolatedGitEnv(gitDir, opts.env),
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size > MAX_GIT_OUTPUT_BYTES) child.kill();
      else out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && size <= MAX_GIT_OUTPUT_BYTES) resolve(Buffer.concat(out));
      else {
        reject(
          new Error(
            `git ${args[0] ?? ""} failed (${code ?? "killed"}): ${Buffer.concat(err).toString("utf8").trim()}`,
          ),
        );
      }
    });
    child.stdin.end(opts.input ?? new Uint8Array());
  });
}
