/**
 * The tip a governed repo change lands on (`parent_commit`), resolved WITHOUT
 * running git on the real git directory (docs/proposals/governed-repo-change-v1.md
 * § "The chain", steps 4–5).
 *
 * Git is never asked "what is HEAD": a repository's config, its hooks, its
 * `core.fsmonitor`, a replace ref or a reftable could all steer that answer.
 * The files are read and parsed strictly instead:
 *
 *   1. the worktree's `.git` entry → its git directory and the common one
 *      (`resolveGitDirectories`, the same strict resolution the isolated git
 *      session uses for the object directory);
 *   2. `<gitdir>/HEAD` must be exactly `ref: refs/heads/<base_ref>\n` — a
 *      detached HEAD, or HEAD on any other branch, is a refusal (the tip must
 *      be the branch the scope names);
 *   3. that ref: a loose `<commondir>/refs/heads/<base_ref>` holding exactly one
 *      full lowercase object id of the scope's format, else its line in
 *      `<commondir>/packed-refs`, parsed line by line (anything unexpected,
 *      or the ref named twice, is a refusal).
 *
 * A reftable repository is refused: its refs are not files this parser reads.
 *
 * Used by the producer (`motebit repo-task run`, which needs the tip it builds
 * on); `motebit-verify repo-change` takes its trusted tip as `--base` instead.
 * Apache-2.0 (moved from the BUSL-1.1 CLI on 2026-11-02). Node built-ins only.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveGitDirectories } from "./session.js";

/** The longest a ref file, HEAD or packed-refs may be before it is refused. */
const MAX_REF_FILE_BYTES = 64 * 1024 * 1024;
const BRANCH_NAME = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** The tip could not be resolved as the branch the scope names. */
export class RepoTipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoTipError";
  }
}

export interface RepoTip {
  /** The commit the change lands on: a full lowercase object id. */
  readonly tip: string;
  /** The worktree's `.git` entry. */
  readonly gitEntry: string;
  readonly gitDir: string;
  readonly commonDir: string;
}

function oidPattern(objectFormat: "sha1" | "sha256"): RegExp {
  return objectFormat === "sha1" ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
}

/** A small regular file (never a symlink), read as strict UTF-8; `null` when absent. */
function readSmallFile(file: string, what: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_REF_FILE_BYTES) {
    throw new RepoTipError(`${what} is not a regular file`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
  } catch {
    throw new RepoTipError(`${what} is not UTF-8`);
  }
}

/**
 * Resolve the tip of `baseRef` in the repository whose worktree is `repoDir`,
 * from the files alone, and require HEAD to be on that branch.
 */
export function resolveRepoTip(
  repoDir: string,
  baseRef: string,
  objectFormat: "sha1" | "sha256",
): RepoTip {
  if (!BRANCH_NAME.test(baseRef) || baseRef.split("/").some((s) => s === "." || s === "..")) {
    throw new RepoTipError(`the base ref ${JSON.stringify(baseRef)} is not a plain branch name`);
  }
  const gitEntry = path.join(repoDir, ".git");
  let dirs: { gitDir: string; commonDir: string };
  try {
    dirs = resolveGitDirectories(gitEntry);
  } catch (err) {
    throw new RepoTipError(
      `${repoDir} is not a git worktree: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const { gitDir, commonDir } = dirs;
  if (fs.existsSync(path.join(commonDir, "reftable"))) {
    throw new RepoTipError("a reftable repository is not supported: its refs are not files");
  }

  const ref = `refs/heads/${baseRef}`;
  const head = readSmallFile(path.join(gitDir, "HEAD"), "HEAD");
  if (head === null) throw new RepoTipError("the repository has no HEAD");
  const m = /^ref: (\S+)\n?$/.exec(head);
  if (!m) {
    throw new RepoTipError(`HEAD is detached; the tip must be the branch ${baseRef}`);
  }
  if (m[1] !== ref) {
    throw new RepoTipError(
      `HEAD is on ${JSON.stringify(m[1])}; the tip must be the branch ${baseRef} (${ref})`,
    );
  }

  const oid = oidPattern(objectFormat);
  const loose = readSmallFile(path.join(commonDir, ...ref.split("/")), ref);
  if (loose !== null) {
    const lm = /^([0-9a-f]+)\n?$/.exec(loose);
    if (!lm || !oid.test(lm[1]!)) {
      throw new RepoTipError(`${ref} does not hold one ${objectFormat} object id`);
    }
    return { tip: lm[1]!, gitEntry, gitDir, commonDir };
  }

  const packed = readSmallFile(path.join(commonDir, "packed-refs"), "packed-refs");
  if (packed === null) throw new RepoTipError(`${ref} does not exist (the branch has no commit)`);
  const lines = packed.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let found: string | null = null;
  lines.forEach((line, i) => {
    if (i === 0 && line.startsWith("# pack-refs with:")) return;
    if (line.startsWith("^")) {
      if (i === 0 || !oid.test(line.slice(1))) {
        throw new RepoTipError(`packed-refs line ${i + 1} is malformed`);
      }
      return;
    }
    const sp = line.indexOf(" ");
    const id = line.slice(0, sp);
    const name = line.slice(sp + 1);
    if (sp < 0 || !oid.test(id) || name.length === 0 || /\s/.test(name)) {
      throw new RepoTipError(`packed-refs line ${i + 1} is malformed`);
    }
    if (name === ref) {
      if (found !== null) throw new RepoTipError(`packed-refs names ${ref} twice`);
      found = id;
    }
  });
  if (found === null) throw new RepoTipError(`${ref} does not exist (the branch has no commit)`);
  return { tip: found, gitEntry, gitDir, commonDir };
}
