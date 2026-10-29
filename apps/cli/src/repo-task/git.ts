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
 * NO git process ever runs on the real git directory. Its object directory
 * is resolved without git (`resolveObjectDirectory`): the `.git` entry (a
 * directory, or a `gitdir:` file for a linked worktree), then `commondir`
 * when present, each parsed strictly, each required to be a real directory
 * and not a symlink; the object directory is `<common gitdir>/objects`.
 * `GIT_OBJECT_DIRECTORY` comes only from that resolution, never from the
 * caller's environment. The object format is the verified scope's
 * `object_format`; a mismatch fails closed at the first object lookup. Every
 * call has a timeout (kill, fail closed) as defence in depth.
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

/** Default per-call ceiling: a git call that takes longer is killed and fails. */
export const GIT_CALL_TIMEOUT_MS = 20_000;

function spawnGit(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  input?: Uint8Array,
  timeoutMs: number = GIT_CALL_TIMEOUT_MS,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...PINNED, ...args], {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size > MAX_GIT_OUTPUT_BYTES) child.kill();
      else out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`git ${args[0] ?? ""} timed out after ${timeoutMs} ms`));
      else if (code === 0 && size <= MAX_GIT_OUTPUT_BYTES) resolve(Buffer.concat(out));
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

/** A git session in which no git process ever runs on the real git directory. */
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
    opts?: {
      readonly input?: Uint8Array;
      readonly env?: Readonly<Record<string, string>>;
      /** Per-call ceiling; default `GIT_CALL_TIMEOUT_MS`. */
      readonly timeoutMs?: number;
    },
  ): Promise<Buffer>;
  /** Remove the private session directory. */
  close(): void;
}

/** `p` exists as a real directory, not a symlink (lstat). */
function realDirectory(p: string, what: string): string {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    throw new Error(`isolated git: ${what} does not exist`);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`isolated git: ${what} is not a real directory`);
  }
  return p;
}

/** A one-line pointer file (`gitdir: <path>` or a bare path), parsed strictly. */
function readPointer(file: string, prefix: string, what: string): string {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.size > 4096)
    throw new Error(`isolated git: ${what} is not a small regular file`);
  const text = fs.readFileSync(file, "utf8");
  const m = /^([^\n\r\0]+)\n?$/.exec(text);
  if (!m || !m[1]!.startsWith(prefix)) throw new Error(`isolated git: ${what} is malformed`);
  const target = m[1]!.slice(prefix.length);
  if (target.length === 0 || target !== target.trim()) {
    throw new Error(`isolated git: ${what} is malformed`);
  }
  return path.resolve(path.dirname(file), target);
}

/**
 * The real repository's object directory, resolved WITHOUT running git:
 * `gitEntry` is the worktree's `.git` — a directory, or a file holding
 * `gitdir: <path>` (a linked worktree); a `commondir` file in that git
 * directory points at the common one. Each step must be a real directory
 * (no symlink); anything unexpected throws.
 */
export function resolveObjectDirectory(gitEntry: string): string {
  const entry = path.resolve(gitEntry);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(entry);
  } catch {
    throw new Error("isolated git: the .git entry does not exist");
  }
  let gitDir: string;
  if (st.isDirectory() && !st.isSymbolicLink()) gitDir = entry;
  else if (st.isFile())
    gitDir = realDirectory(readPointer(entry, "gitdir: ", "the .git file"), "the gitdir");
  else throw new Error("isolated git: the .git entry is neither a directory nor a gitdir file");
  let common = gitDir;
  const commondir = path.join(gitDir, "commondir");
  let commondirPresent = true;
  try {
    fs.lstatSync(commondir);
  } catch {
    commondirPresent = false;
  }
  if (commondirPresent) {
    common = realDirectory(readPointer(commondir, "", "commondir"), "the common git directory");
  }
  return realDirectory(path.join(common, "objects"), "the object directory");
}

/**
 * Open a session on the repository whose `.git` entry is `gitEntry`, for a
 * repository of the verified scope's `objectFormat`: resolve its object
 * directory (no git), create the private bare repository, write its config.
 */
export async function openIsolatedGit(opts: {
  readonly gitEntry: string;
  readonly objectFormat: "sha1" | "sha256";
}): Promise<IsolatedGit> {
  const { objectFormat } = opts;
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new Error(`isolated git: unsupported object format ${JSON.stringify(objectFormat)}`);
  }
  const objectDirectory = resolveObjectDirectory(opts.gitEntry);
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
    run: (args, o = {}) => spawnGit(args, env(o.env), sessionDir, o.input, o.timeoutMs),
    close: () => fs.rmSync(sessionDir, { recursive: true, force: true }),
  };
}
