/**
 * The repo-task run's preflight — everything `motebit repo-task run` must
 * know about the repository before the first model call
 * (docs/proposals/governed-repo-change-v1.md § "The chain", step 4), read
 * from the TIP'S TREE through the isolated git session, never from the
 * filesystem.
 *
 * The reading itself is `@motebit/verify/git` (Apache-2.0), the same code
 * `motebit-verify repo-change` reads the trusted base with: the pins, the
 * strictly parsed revocations, the path policy (`readRepoState`) and the spent
 * status (`isGrantSpent`). What is the run's own lives here:
 *
 *   - a refusal on ANY rule that did not hold (`readTipState`): the verifier
 *     judges a missing pin as "not a pin", the run refuses to start;
 *   - the worktree is clean at the tip: every tracked path is in the worktree
 *     with the same type and mode, and its bytes hash (in-process, the scope's
 *     object format) to the tip's blob — read through no symlinked directory.
 *     The run never writes the worktree; this only proves the worktree the
 *     operator sees IS the tip the change is built on.
 *
 * Nothing here decides authority: the pieces fill `RepoTaskAuthorityBundle`,
 * and the run's authority law (`checkRepoTaskAuthority` → the verifier's own
 * rules) judges them.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { RepoTaskPin, RepoTaskRevocations } from "@motebit/runtime";
import { isRepoPathPermitted } from "@motebit/verifier";
import type { RepoPathPolicy } from "@motebit/verifier";
import {
  RepoStateError,
  gitBlobId,
  isGrantSpent,
  pinFromIdentityFile as pinFromIdentityFileAt,
  readRepoState,
} from "@motebit/verify/git";
import type { IsolatedGit, TreeEntry } from "@motebit/verify/git";

/** One or more preflight rules did not hold; nothing ran. */
export class RepoTaskPreflightError extends Error {
  constructor(readonly refusals: readonly string[]) {
    super(`repo task preflight refused:\n${refusals.map((r) => `  ${r}`).join("\n")}`);
    this.name = "RepoTaskPreflightError";
  }
}

/** The pin an identity file holds: its verified `(motebit_id, public_key)` pair. Throws when not intact. */
export async function pinFromIdentityFile(content: string, what: string): Promise<RepoTaskPin> {
  return pinFromIdentityFileAt(content, what);
}

/** What the tip says: pins, revocations, the path policy. */
export interface TipState {
  readonly principal: RepoTaskPin;
  readonly agents: readonly RepoTaskPin[];
  readonly revocations: RepoTaskRevocations;
  readonly policy: RepoPathPolicy;
  readonly isPathPermitted: (p: string) => boolean;
}

/**
 * Read the pins, revocations and path policy from the tip's tree (`tree`, the
 * full listing of `tip`), through the isolated session. Throws
 * `RepoTaskPreflightError` naming every rule that did not hold.
 */
export async function readTipState(
  git: IsolatedGit,
  tip: string,
  tree: readonly TreeEntry[],
): Promise<TipState> {
  const state = await readRepoState(git, tip, tree);
  const { principal, policy } = state;
  if (state.problems.length > 0 || principal === null || policy === null) {
    throw new RepoTaskPreflightError(state.problems);
  }
  return {
    principal,
    agents: state.agents,
    revocations: {
      set: state.revocations.set,
      failures: state.revocations.failures,
      readAt: tip,
    },
    policy,
    isPathPermitted: (p: string) => isRepoPathPermitted(policy, p),
  };
}

/**
 * Spent (spec §7): the grant's bundle path ever existed on the tip's
 * first-parent history (`isGrantSpent`); a shallow repository or a
 * malformed grant id is a refusal.
 */
export async function isGrantSpentAtTip(
  git: IsolatedGit,
  tip: string,
  grantId: string,
  commonDir: string,
): Promise<boolean> {
  try {
    return await isGrantSpent(git, tip, grantId, commonDir);
  } catch (err) {
    if (err instanceof RepoStateError) throw new RepoTaskPreflightError(err.problems);
    throw err;
  }
}

/**
 * The worktree is clean at the tip: for every tracked path, the worktree
 * entry exists with the same type and mode, reached through real directories
 * only, and its bytes (a symlink's target) hash to the tip's blob. A gitlink
 * is refused: a submodule's checkout cannot be proven to be the recorded
 * commit without running git in it. Returns every difference (empty = clean).
 */
export function worktreeDifferences(
  repoDir: string,
  tree: readonly TreeEntry[],
  objectFormat: "sha1" | "sha256",
): string[] {
  const out: string[] = [];
  const root = Buffer.from(path.resolve(repoDir));
  const realDirs = new Set<string>();
  const sep = Buffer.from("/");
  for (const e of tree) {
    const rel = Buffer.from(e.path);
    const label = JSON.stringify(rel.toString("utf8"));
    // Every directory on the way must be a real directory, not a symlink.
    let dirOk = true;
    for (let i = rel.indexOf(0x2f); i >= 0; i = rel.indexOf(0x2f, i + 1)) {
      const prefix = rel.subarray(0, i);
      const key = prefix.toString("latin1");
      if (realDirs.has(key)) continue;
      let st: fs.Stats | null = null;
      try {
        st = fs.lstatSync(Buffer.concat([root, sep, prefix]));
      } catch {
        st = null;
      }
      if (st === null || st.isSymbolicLink() || !st.isDirectory()) {
        dirOk = false;
        break;
      }
      realDirs.add(key);
    }
    if (!dirOk) {
      out.push(`${label}: a directory on its path is missing or not a real directory`);
      continue;
    }
    const full = Buffer.concat([root, sep, rel]);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(full);
    } catch {
      out.push(`${label}: missing from the worktree`);
      continue;
    }
    if (e.mode === "100644" || e.mode === "100755") {
      if (!st.isFile()) {
        out.push(`${label}: not a regular file in the worktree (tracked ${e.mode})`);
        continue;
      }
      const executable = (st.mode & 0o100) !== 0;
      if (executable !== (e.mode === "100755")) {
        out.push(`${label}: mode differs from the tip's ${e.mode}`);
        continue;
      }
      if (gitBlobId(fs.readFileSync(full), objectFormat) !== e.oid) {
        out.push(`${label}: content differs from the tip`);
      }
    } else if (e.mode === "120000") {
      if (!st.isSymbolicLink()) {
        out.push(`${label}: not a symlink in the worktree (tracked 120000)`);
        continue;
      }
      if (gitBlobId(fs.readlinkSync(full, { encoding: "buffer" }), objectFormat) !== e.oid) {
        out.push(`${label}: symlink target differs from the tip`);
      }
    } else if (e.mode === "160000") {
      out.push(`${label}: a submodule cannot be proven clean`);
    } else {
      out.push(`${label}: unexpected tracked mode ${e.mode}`);
    }
  }
  return out;
}
