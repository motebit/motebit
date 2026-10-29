/**
 * The one way the repo-task adapters run git — and the allowlist shape of
 * it: git never reads the repository's own config at all.
 *
 * A repository's `.git/config` (and anything it includes) can steer git:
 * `core.fsmonitor` runs a program and can leave a daemon behind,
 * `core.splitIndex` leaves files next to the index, `i18n.commitEncoding`
 * changes the bytes of a commit, `core.hooksPath` points hooks anywhere. A
 * denylist of such keys is never complete. So every reader and stager call
 * runs against a PRIVATE, EMPTY bare repository created per session in an
 * owner-only temporary directory, whose config is written here and holds
 * nothing else; `GIT_OBJECT_DIRECTORY` points at the real repository's
 * object store (resolved once), so the tip's objects are readable and new
 * blobs and commits land where the real repository will see them.
 *
 *   - System and global config are off (`GIT_CONFIG_NOSYSTEM`,
 *     `GIT_CONFIG_GLOBAL=/dev/null`); replace objects are ignored; pathspecs
 *     are literal; there is no prompt; the locale is C.
 *   - Defence in depth, on every call: `-c core.fsmonitor=false
 *     -c core.splitIndex=false -c i18n.commitEncoding=UTF-8
 *     -c core.hooksPath=/dev/null`.
 *   - cwd is the private directory, never the caller's.
 *   - argv only (never a shell); path bytes travel on stdin, never as an
 *     argument, so no path is shell-, glob- or option-interpreted.
 *
 * Alternates: the real object store's `info/alternates` IS honoured — git
 * reads it from the object directory it is given, and a repository cloned
 * with `--shared` / `--reference` keeps the tip's objects there. Alternates
 * are only ever read; every new object is written to the real primary
 * object directory.
 *
 * The one read of the real repository: resolving its object directory and
 * object format (`git rev-parse`), which consults no index and runs no hook.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Hard ceiling on what one git call may return (a blob, a tree listing). */
export const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024 + 1024;

/** A full lowercase object id (sha1 or sha256). */
export const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Pinned on every call, whatever any config says. */
const PINNED = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.splitIndex=false",
  "-c",
  "i18n.commitEncoding=UTF-8",
  "-c",
  "core.hooksPath=/dev/null",
] as const;

const BASE_ENV = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_LITERAL_PATHSPECS: "1",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
});

/** The private repository's whole config: written here, nothing else. */
function privateConfig(objectFormat: string): string {
  return [
    "[core]",
    `\trepositoryformatversion = ${objectFormat === "sha1" ? 0 : 1}`,
    "\tbare = true",
    "\tfsmonitor = false",
    "\tsplitIndex = false",
    "\thooksPath = /dev/null",
    "[i18n]",
    "\tcommitEncoding = UTF-8",
    ...(objectFormat === "sha1" ? [] : ["[extensions]", `\tobjectFormat = ${objectFormat}`]),
    "",
  ].join("\n");
}

function spawnGit(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  input?: Uint8Array,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...PINNED, ...args], {
      env,
      cwd,
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
    child.stdin.end(input ?? new Uint8Array());
  });
}

/** A git session that never reads the real repository's config. */
export interface IsolatedGit {
  /** The real repository's object directory every call reads and writes. */
  readonly objectDirectory: string;
  /** The repository's object format (`sha1` or `sha256`). */
  readonly objectFormat: string;
  /** The private, owner-only session directory (cwd of every call). */
  readonly sessionDir: string;
  /** Run `git <args>` in the session; optional stdin and extra environment. */
  run(
    args: readonly string[],
    opts?: { readonly input?: Uint8Array; readonly env?: Readonly<Record<string, string>> },
  ): Promise<Buffer>;
  /** Remove the private session directory. */
  close(): void;
}

/**
 * Open a session on the repository whose git directory is `realGitDir`:
 * resolve its object directory and format once, create the private bare
 * repository, write its config.
 */
export async function openIsolatedGit(realGitDir: string): Promise<IsolatedGit> {
  const real = path.resolve(realGitDir);
  const probeEnv = { ...BASE_ENV(), GIT_DIR: real };
  const objectDirectory = (
    await spawnGit(["rev-parse", "--path-format=absolute", "--git-path", "objects"], probeEnv, real)
  )
    .toString("utf8")
    .trim();
  const objectFormat = (await spawnGit(["rev-parse", "--show-object-format"], probeEnv, real))
    .toString("utf8")
    .trim();
  if (!path.isAbsolute(objectDirectory) || !fs.statSync(objectDirectory).isDirectory()) {
    throw new Error("isolated git: the repository's object directory could not be resolved");
  }
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new Error(`isolated git: unsupported object format ${JSON.stringify(objectFormat)}`);
  }
  // mkdtemp creates the directory 0700: owner-only.
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-git-"));
  const privateRepo = path.join(sessionDir, "private.git");
  try {
    await spawnGit(
      ["init", "--bare", "--quiet", "--template=", `--object-format=${objectFormat}`, privateRepo],
      BASE_ENV(),
      sessionDir,
    );
    fs.writeFileSync(path.join(privateRepo, "config"), privateConfig(objectFormat), {
      mode: 0o600,
    });
  } catch (err) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    throw err;
  }
  const env = (extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv => ({
    ...BASE_ENV(),
    GIT_DIR: privateRepo,
    GIT_OBJECT_DIRECTORY: objectDirectory,
    ...extra,
  });
  return {
    objectDirectory,
    objectFormat,
    sessionDir,
    run: (args, opts = {}) => spawnGit(args, env(opts.env), sessionDir, opts.input),
    close: () => fs.rmSync(sessionDir, { recursive: true, force: true }),
  };
}
