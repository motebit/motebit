/**
 * The one way the governed-repo-change code runs git — `motebit-verify
 * repo-change` here, and `motebit repo-task run` (its reader, stager and
 * self-check), which imports this module rather than keeping a copy — and the
 * allowlist shape of it: git never reads the repository's own config at all.
 *
 * Apache-2.0 (moved from the BUSL-1.1 CLI on 2026-11-02, a founder decision:
 * the verifier's git reader belongs on the permissive floor with the
 * verifier). Node built-ins only.
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
 *   - argv only (never a shell). The stager passes every path on stdin;
 *     the reader passes one path in argv, always after `--` and with literal
 *     pathspecs, so no path is shell-, glob- or option-interpreted.
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
    // No input ⇒ no stdin pipe (git reads /dev/null): a git that exits
    // before an empty write lands would otherwise raise EPIPE on a success.
    const argv = [...PINNED, ...args];
    const child =
      input == null
        ? spawn("git", argv, { env, cwd, stdio: ["ignore", "pipe", "pipe"], shell: false })
        : spawn("git", argv, { env, cwd, stdio: ["pipe", "pipe", "pipe"], shell: false });
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
    const stdin = child.stdin;
    if (input == null || stdin == null) return;
    // A git that dies (or is killed) before reading all of its input makes
    // the write fail with EPIPE: reject, never let it crash the process.
    stdin.on("error", (e) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new Error(`git ${args[0] ?? ""} stopped reading its input: ${e.message}`));
    });
    stdin.end(input);
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
  /**
   * A long-lived `git cat-file --batch` over the session, with the
   * commit-graph off and grafts and replace objects ignored: raw object
   * bytes only, for a caller that re-hashes every object against its id
   * (`objects.ts`).
   */
  objectStream(opts?: { readonly timeoutMs?: number }): ObjectStream;
  /** Remove the private session directory. A call that times out or breaks its input closes the session too. */
  close(): void;
}

/** One raw object as the store returned it: unverified until its bytes are re-hashed. */
export interface StoredObject {
  /** The type the store named (`commit`, `tree`, `blob`, `tag`). */
  readonly type: string;
  readonly content: Buffer;
}

/** Raw object reads, one at a time, through one `git cat-file --batch` process. */
export interface ObjectStream {
  /** The object's type and bytes as the store returned them, or `null` when it does not hold it. */
  read(oid: string): Promise<StoredObject | null>;
  /** Stop the process. Idempotent. */
  close(): void;
}

/**
 * A `git cat-file --batch` process that stays up for many reads. Requests
 * are serialized; each read has a deadline (kill, fail closed, and the
 * session closes). The store can still lie (a forged pack index, a loose
 * object at another object's path), so the caller MUST re-hash every object
 * it receives. Replace objects and grafts are off and the commit-graph is
 * never read.
 */
function openObjectStream(
  env: NodeJS.ProcessEnv,
  cwd: string,
  onFatal: () => void,
  timeoutMs: number,
): ObjectStream {
  const argv = [...PINNED, "-c", "core.commitGraph=false", "cat-file", "--batch"];
  const child = spawn("git", argv, {
    env: { ...env, GIT_GRAFT_FILE: "/dev/null", GIT_NO_REPLACE_OBJECTS: "1" },
    cwd,
    stdio: ["pipe", "pipe", "ignore"],
    shell: false,
  });
  let buf: Buffer = Buffer.alloc(0);
  let dead: Error | null = null;
  let waiter: (() => void) | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const wake = (): void => {
    const w = waiter;
    waiter = null;
    w?.();
  };
  const kill = (why: Error): Error => {
    if (dead === null) dead = why;
    child.kill("SIGKILL");
    wake();
    return dead;
  };
  child.stdout.on("data", (d: Buffer) => {
    buf = buf.length === 0 ? d : Buffer.concat([buf, d]);
    if (buf.length > MAX_GIT_OUTPUT_BYTES + 256)
      kill(new Error("git cat-file: an object is too large"));
    wake();
  });
  // A spawn failure or a broken stdin (git died) ends the stream: fail closed.
  child.on("error", kill);
  child.stdin.on("error", kill);
  child.on("close", () => kill(new Error("git cat-file --batch exited")));

  /** Wait until `have()` holds, the process dies, or the deadline passes. */
  const until = async (have: () => boolean, deadline: number): Promise<void> => {
    while (!have()) {
      if (dead !== null) throw dead;
      const left = deadline - Date.now();
      if (left <= 0) {
        const err = kill(new Error(`git cat-file timed out after ${timeoutMs} ms`));
        onFatal();
        throw err;
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        waiter = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
  };

  const readOne = async (oid: string): Promise<StoredObject | null> => {
    if (!OID.test(oid)) {
      throw new Error(`git cat-file: ${JSON.stringify(oid)} is not a full object id`);
    }
    if (dead !== null) throw dead;
    const deadline = Date.now() + timeoutMs;
    child.stdin.write(`${oid}\n`);
    await until(() => buf.indexOf(0x0a) >= 0, deadline);
    const nl = buf.indexOf(0x0a);
    const header = buf.subarray(0, nl).toString("latin1");
    if (header === `${oid} missing`) {
      buf = buf.subarray(nl + 1);
      return null;
    }
    const m = /^([0-9a-f]+) (commit|tree|blob|tag) (0|[1-9][0-9]{0,9})$/.exec(header);
    if (!m || m[1] !== oid) {
      throw kill(
        new Error(`git cat-file: an unexpected reply ${JSON.stringify(header.slice(0, 120))}`),
      );
    }
    const size = Number(m[3]);
    if (size > MAX_GIT_OUTPUT_BYTES) throw kill(new Error("git cat-file: an object is too large"));
    await until(() => buf.length >= nl + 1 + size + 1, deadline);
    if (buf[nl + 1 + size] !== 0x0a) {
      throw kill(new Error("git cat-file: a reply is not newline-terminated"));
    }
    const content = Buffer.from(buf.subarray(nl + 1, nl + 1 + size));
    buf = buf.subarray(nl + 1 + size + 1);
    return { type: m[2]!, content };
  };

  return {
    read: (oid) => {
      const next = chain.then(() => readOne(oid));
      chain = next.catch(() => undefined);
      return next;
    },
    close: () => {
      if (dead === null) dead = new Error("git cat-file: the stream is closed");
      child.stdin.end();
      child.kill("SIGKILL");
    },
  };
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

/** A repository's git directories, resolved without git (`resolveGitDirectories`). */
export interface GitDirectories {
  /** This worktree's git directory (`HEAD` lives here). */
  readonly gitDir: string;
  /** The common git directory (`refs/`, `packed-refs`, `objects/`, `shallow` live here). */
  readonly commonDir: string;
}

/**
 * The real repository's object directory, resolved WITHOUT running git
 * (`resolveGitDirectories`, then `<common gitdir>/objects`, itself a real
 * directory, not a symlink).
 */
export function resolveObjectDirectory(gitEntry: string): string {
  const { commonDir } = resolveGitDirectories(gitEntry);
  return realDirectory(path.join(commonDir, "objects"), "the object directory");
}

/**
 * A repository's git directories, resolved WITHOUT running git: `gitEntry`
 * is the worktree's `.git` — a directory, or a file holding `gitdir: <path>`
 * (a linked worktree); a `commondir` file in that git directory points at the
 * common one. Each step must be a real directory (no symlink); anything
 * unexpected throws.
 */
export function resolveGitDirectories(gitEntry: string): GitDirectories {
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
  return { gitDir, commonDir: common };
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
  let closed = false;
  const close = (): void => {
    closed = true;
    fs.rmSync(sessionDir, { recursive: true, force: true });
  };
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
    run: async (args, o = {}) => {
      if (closed) throw new Error("isolated git: the session is closed");
      try {
        return await spawnGit(args, env(o.env), sessionDir, o.input, o.timeoutMs);
      } catch (err) {
        // A killed or broken call can leave state in the private repository
        // (a lock, a half-written file): the session ends, fail closed, and
        // its directory goes with it.
        const msg = err instanceof Error ? err.message : String(err);
        if (/timed out|stopped reading its input/.test(msg)) close();
        throw err;
      }
    },
    objectStream: (o = {}) => {
      if (closed) throw new Error("isolated git: the session is closed");
      return openObjectStream(env(), sessionDir, close, o.timeoutMs ?? GIT_CALL_TIMEOUT_MS);
    },
    close,
  };
}
