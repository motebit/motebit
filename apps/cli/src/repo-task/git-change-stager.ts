/**
 * Node adapter for the repo-task run's `RepoChangeStager` port
 * (`@motebit/runtime`, packages/runtime/src/repo-task/tools.ts).
 *
 * The end-game shape of a governed write (design amendment 2026-10-29,
 * docs/proposals/governed-repo-change-v1.md § "The chain", step 4): the run
 * NEVER writes the worktree filesystem. A path-based writer cannot be made
 * race-free in Node (no `openat`; a two-swap directory race escaped the
 * worktree), so there is no path to race:
 *
 *   - `stage(path, content)` stores the content in git's object store
 *     (`git hash-object -w --no-filters --stdin`) and records
 *     `path → {100644, blob}` in an in-memory map. No file is opened.
 *   - `buildChangeCommit` builds the change commit on the tip from that map
 *     on a PRIVATE index (`GIT_INDEX_FILE` in an owner-only temporary
 *     directory): `read-tree <tip>`, `update-index -z --index-info` (every
 *     path goes in on stdin as exact bytes — never an argument, so nothing is
 *     shell-, glob- or option-interpreted), `write-tree`, `commit-tree -p
 *     <tip>`. No worktree file, no repository index and no ref is touched.
 *     The entries are what git's own `diff-tree` says changed against the
 *     tip — the same ground truth the verifier computes.
 *
 * Every git call runs isolated (`git.ts`). Not wired to any command yet:
 * build step 4's `motebit repo-task run` constructs it on the pinned tip.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { RepoChangeStager, RepoStagedEntry } from "@motebit/runtime";

import { OID, runGit } from "./git.js";

export interface GitChangeStagerOptions {
  /** The repository's git directory (`.git`, or a bare repository). */
  readonly gitDir: string;
  /** The tip commit the change lands on, as a full lowercase object id. */
  readonly tip: string;
}

const ENCODER = new TextEncoder();
const REGULAR_FILE_MODE = "100644";

export function createGitChangeStager(
  opts: GitChangeStagerOptions,
): RepoChangeStager & { staged(): ReadonlyMap<string, string> } {
  if (!OID.test(opts.tip))
    throw new Error("git change stager: tip must be a full lowercase object id");
  const { gitDir, tip } = opts;
  /** path → blob id. A later stage of the same path replaces the earlier one. */
  const staging = new Map<string, string>();

  return {
    staged: () => new Map(staging),

    async stage(p: string, content: Uint8Array): Promise<void> {
      // Defensive: the runtime handler passes only exact allowed paths.
      if (p.length === 0 || p.includes("\0") || p.startsWith("/")) {
        throw new Error("git change stager: not a repository-relative path");
      }
      const out = await runGit(gitDir, ["hash-object", "-w", "--no-filters", "--stdin"], {
        input: content,
      });
      const blob = out.toString("latin1").trim();
      if (!OID.test(blob)) throw new Error("git change stager: hash-object returned no object id");
      staging.set(p, blob);
    },

    async buildChangeCommit(commit) {
      // A private index in an owner-only directory (mkdtemp creates 0700).
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-repo-index-"));
      const env = { GIT_INDEX_FILE: path.join(dir, "index") };
      try {
        await runGit(gitDir, ["read-tree", tip], { env });
        // NUL-terminated "<mode> SP <blob> TAB <path>" records on stdin: the
        // path bytes are never an argv element.
        const records = [...staging].map(([p, blob]) => `${REGULAR_FILE_MODE} ${blob}\t${p}\0`);
        await runGit(gitDir, ["update-index", "-z", "--index-info"], {
          env,
          input: ENCODER.encode(records.join("")),
        });
        const tree = (await runGit(gitDir, ["write-tree"], { env })).toString("latin1").trim();
        if (!OID.test(tree)) throw new Error("git change stager: write-tree returned no tree id");
        const when = `${Math.floor(commit.timestamp)} +0000`;
        const identity = {
          GIT_AUTHOR_NAME: commit.authorName,
          GIT_AUTHOR_EMAIL: commit.authorEmail,
          GIT_AUTHOR_DATE: when,
          GIT_COMMITTER_NAME: commit.authorName,
          GIT_COMMITTER_EMAIL: commit.authorEmail,
          GIT_COMMITTER_DATE: when,
        };
        // The message on stdin (`-F -`), never as an argument.
        const headCommit = (
          await runGit(gitDir, ["commit-tree", tree, "-p", tip, "-F", "-"], {
            env: { ...env, ...identity },
            input: ENCODER.encode(commit.message),
          })
        )
          .toString("latin1")
          .trim();
        if (!OID.test(headCommit))
          throw new Error("git change stager: commit-tree returned no commit id");
        // What changed against the tip, as git records it (no renames).
        const diff = await runGit(gitDir, [
          "diff-tree",
          "-r",
          "-z",
          "--no-renames",
          tip,
          headCommit,
        ]);
        const entries: RepoStagedEntry[] = [];
        const fields = diff.toString("utf8").split("\0");
        for (let i = 0; i + 1 < fields.length; i += 2) {
          const meta = fields[i]!;
          const p = fields[i + 1]!;
          if (!meta.startsWith(":")) break;
          const [, dstMode, , dstBlob] = meta.slice(1).split(" ");
          if (dstMode === undefined || dstBlob === undefined) continue;
          entries.push({ path: p, mode: dstMode, blob: dstBlob });
        }
        entries.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
        return { headCommit, entries };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
