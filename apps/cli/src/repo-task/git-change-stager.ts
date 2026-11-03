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
 *     shell-, glob- or option-interpreted), `write-tree`, then a fail-closed
 *     POSTCONDITION, then `commit-tree -p <tip>`. No worktree file,
 *     repository index or ref is touched.
 *   - The postcondition: `diff-tree` from the tip to the written tree must
 *     be exactly the staged paths whose content changed — each an add (no
 *     old entry) or a modify of a 100644 file, new mode 100644, with the
 *     staged blob — and nothing else. A
 *     directory/file collision (staging `a` and `a/b`, or a path under a
 *     tracked file) would delete something; any such tree throws and no
 *     commit is made.
 *
 * Every git call runs in an isolated session (`@motebit/verify/git`): no git
 * process ever runs on the real git directory, so git never reads the
 * repository's own config. `motebit repo-task run` constructs it on the
 * pinned tip. Stays in the CLI (BUSL-1.1): it implements a `@motebit/runtime`
 * port.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { RepoChangeStager, RepoStagedEntry } from "@motebit/runtime";
import { OID } from "@motebit/verify/git";
import type { IsolatedGit } from "@motebit/verify/git";

export interface GitChangeStagerOptions {
  /** The isolated git session on the repository (`openIsolatedGit`). */
  readonly git: IsolatedGit;
  /** The tip commit the change lands on, as a full lowercase object id. */
  readonly tip: string;
}

const ENCODER = new TextEncoder();
const REGULAR_FILE_MODE = "100644";
/** Seconds since the epoch below this; a millisecond value of any date after 1973 is above it. */
const MAX_TIMESTAMP_SECONDS = 100_000_000_000;

/** git's own date format for an integer count of seconds, in UTC. */
export function gitTimestamp(seconds: number): string {
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds >= MAX_TIMESTAMP_SECONDS) {
    throw new Error(
      "git change stager: the commit timestamp must be integer seconds since the epoch (not milliseconds)",
    );
  }
  return `@${seconds} +0000`;
}

function byPathBytes(a: { path: string }, b: { path: string }): number {
  return Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
}

export function createGitChangeStager(
  opts: GitChangeStagerOptions,
): RepoChangeStager & { staged(): ReadonlyMap<string, string> } {
  if (!OID.test(opts.tip))
    throw new Error("git change stager: tip must be a full lowercase object id");
  const { git, tip } = opts;
  /** path → blob id. A later stage of the same path replaces the earlier one. */
  const staging = new Map<string, string>();

  return {
    staged: () => new Map(staging),

    async stage(p: string, content: Uint8Array): Promise<void> {
      // Defensive: the runtime handler passes only exact allowed paths.
      if (p.length === 0 || p.includes("\0") || p.startsWith("/")) {
        throw new Error("git change stager: not a repository-relative path");
      }
      const out = await git.run(["hash-object", "-w", "--no-filters", "--stdin"], {
        input: content,
      });
      const blob = out.toString("latin1").trim();
      if (!OID.test(blob)) throw new Error("git change stager: hash-object returned no object id");
      staging.set(p, blob);
    },

    async buildChangeCommit(commit) {
      const when = gitTimestamp(commit.timestamp);
      // A private index in an owner-only directory (mkdtemp creates 0700).
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-repo-index-"));
      const env = { GIT_INDEX_FILE: path.join(dir, "index") };
      try {
        await git.run(["read-tree", tip], { env });
        // The tip's own entries, from the private index, before anything is staged.
        const atTip = new Map<string, { mode: string; blob: string }>();
        const listed = await git.run(["ls-files", "-s", "-z"], { env });
        for (const rec of listed.toString("utf8").split("\0")) {
          const tab = rec.indexOf("\t");
          if (tab < 0) continue;
          const [mode, blob] = rec.slice(0, tab).split(" ");
          if (mode !== undefined && blob !== undefined) {
            atTip.set(rec.slice(tab + 1), { mode, blob });
          }
        }
        // NUL-terminated "<mode> SP <blob> TAB <path>" records on stdin: the
        // path bytes are never an argv element.
        const records = [...staging].map(([p, blob]) => `${REGULAR_FILE_MODE} ${blob}\t${p}\0`);
        await git.run(["update-index", "-z", "--index-info"], {
          env,
          input: ENCODER.encode(records.join("")),
        });
        const tree = (await git.run(["write-tree"], { env })).toString("latin1").trim();
        if (!OID.test(tree)) throw new Error("git change stager: write-tree returned no tree id");

        // POSTCONDITION (fail closed): the tree differs from the tip exactly
        // at the staged paths whose content changed, as adds or modifies of
        // 100644 blobs carrying the staged content — nothing else.
        const expected = new Map<string, string>();
        for (const [p, blob] of staging) {
          const was = atTip.get(p);
          if (was === undefined || was.blob !== blob || was.mode !== REGULAR_FILE_MODE) {
            expected.set(p, blob);
          }
        }
        const diff = await git.run(["diff-tree", "-r", "-z", "--no-renames", tip, tree]);
        const entries: RepoStagedEntry[] = [];
        const fields = diff.toString("utf8").split("\0");
        let changedRecords = 0;
        for (let i = 0; i + 1 < fields.length; i += 2) {
          const meta = fields[i]!;
          if (!meta.startsWith(":")) break;
          const p = fields[i + 1]!;
          changedRecords++;
          const [srcMode, dstMode, , dstBlob, status] = meta.slice(1).split(" ");
          const want = expected.get(p);
          if (
            want === undefined ||
            (status !== "A" && status !== "M") ||
            // The old mode: absent for an add, a regular 100644 file for a
            // modify — an executable or any other kind is never rewritten.
            (status === "A" ? srcMode !== "000000" : srcMode !== REGULAR_FILE_MODE) ||
            dstMode !== REGULAR_FILE_MODE ||
            dstBlob !== want
          ) {
            throw new Error(
              `git change stager: the change tree is not exactly the staged adds and modifies (${status ?? "?"} ${p})`,
            );
          }
          entries.push({ path: p, mode: dstMode, blob: dstBlob });
        }
        if (changedRecords !== expected.size) {
          throw new Error("git change stager: a staged change is missing from the change tree");
        }

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
          await git.run(["commit-tree", tree, "-p", tip, "-F", "-"], {
            env: { ...env, ...identity },
            input: ENCODER.encode(commit.message),
          })
        )
          .toString("latin1")
          .trim();
        if (!OID.test(headCommit)) {
          throw new Error("git change stager: commit-tree returned no commit id");
        }
        entries.sort(byPathBytes);
        return { headCommit, entries };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
