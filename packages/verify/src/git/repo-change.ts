/**
 * The inputs `verifyRepoChange` needs in CI-on-PR mode (spec/repo-change-v1.md
 * §7 and §9; design of record docs/proposals/governed-repo-change-v1.md § "The
 * verifier", the "CI on a PR" row), computed from a repository through the
 * isolated git session — and nothing else. ONE implementation for both
 * judges: `motebit-verify repo-change` (CI) and the self-check `motebit
 * repo-task run` makes over its own output.
 *
 * Given the trusted tip `base` and the pull request's head:
 *
 *   - the bundle: the one file the pull request adds under
 *     `.motebit/bundles/` (its exact bytes, never re-serialized) or, when
 *     it adds none and modifies exactly one there, that file at the head
 *     (the shape checks still fail; every axis is judged from it);
 *   - the entries: the change commit's full tree against the base's,
 *     compared in-process, never from `git diff`; the change commit is the
 *     pull request head's only parent;
 *   - the tracked paths at the parent the change lands on: the base's tree;
 *   - pins, revocations and the path policy read at `base`, NEVER from the
 *     pull request;
 *   - spent: the bundle path ever existed on `base`'s first-parent history;
 *   - the shape checks (each a failure string that folds into `integrity`):
 *     `parent_commit` is `base`; the pull request is exactly the change commit
 *     and the bundle commit, linear; `head_commit..pr_head` is exactly one
 *     `A 100644` at `.motebit/bundles/<grant_id>.json`; the base ref is
 *     `main`; the pull request's author is the publisher account; nothing
 *     modifies or deletes anything under `.motebit/bundles/`.
 *
 * Every input is computed even when a shape check fails, so the verifier
 * records every axis. Only what makes the change impossible to judge throws
 * (`RepoStateError`): no parsable path policy at the base (spec §7.2), a
 * shallow history (spent cannot be established), or a git failure.
 *
 * Apache-2.0. Imports: Node built-ins and `@motebit/protocol`,
 * `@motebit/verifier`, all Apache-2.0.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { REPO_TASK_BASE_REF } from "@motebit/protocol";
import { isFullyVerified, isRepoPathPermitted, verifyRepoChange } from "@motebit/verifier";
import type {
  RepoChangeComputedEntry,
  RepoChangeVerification,
  VerifyRepoChangeInput,
} from "@motebit/verifier";

import { openIsolatedGit, resolveGitDirectories } from "./session.js";
import type { IsolatedGit } from "./session.js";
import {
  BUNDLES_DIR,
  RepoStateError,
  bundlePath,
  isCanonicalGrantId,
  isGrantSpent,
  readRepoState,
} from "./state.js";
import type { RepoState } from "./state.js";
import { commitParents, listTree, pathKey, readBlob } from "./tree.js";
import type { TreeEntry } from "./tree.js";

/** The account that publishes governed repo changes (the design's Publisher role). */
export const REPO_CHANGE_PUBLISHER = "motebit-agent";

/**
 * Every path `to`'s tree differs from `from`'s in, computed by listing both
 * trees completely and comparing in-process (spec §7: never from `git diff`).
 * A type change appears as a delete plus an add.
 *
 * `blob` reads a blob's bytes (for the NUL flag); default `cat-file blob`
 * through the session. The offline mode passes its re-hashing reader.
 */
export async function computeEntries(
  git: IsolatedGit,
  fromTree: readonly TreeEntry[],
  toTree: readonly TreeEntry[],
  blob: (oid: string) => Promise<Uint8Array> = async (oid) => git.run(["cat-file", "blob", oid]),
): Promise<RepoChangeComputedEntry[]> {
  const before = new Map(fromTree.map((e) => [pathKey(e.path), e]));
  const after = new Map(toTree.map((e) => [pathKey(e.path), e]));
  const containsNul = async (e: TreeEntry): Promise<boolean> =>
    e.type === "blob" && (await blob(e.oid)).includes(0);
  const out: RepoChangeComputedEntry[] = [];
  for (const [k, e] of after) {
    const was = before.get(k);
    if (was !== undefined && was.type !== e.type) {
      out.push({
        kind: "delete",
        path: was.path,
        mode: was.mode,
        previousMode: was.mode,
        blob: was.oid,
        containsNul: false,
      });
    }
    if (was === undefined || was.type !== e.type) {
      out.push({
        kind: "add",
        path: e.path,
        mode: e.mode,
        blob: e.oid,
        containsNul: await containsNul(e),
      });
    } else if (was.mode !== e.mode || was.oid !== e.oid) {
      out.push({
        kind: "modify",
        path: e.path,
        mode: e.mode,
        previousMode: was.mode,
        blob: e.oid,
        containsNul: await containsNul(e),
      });
    }
  }
  for (const [k, was] of before) {
    if (!after.has(k)) {
      out.push({
        kind: "delete",
        path: was.path,
        mode: was.mode,
        previousMode: was.mode,
        blob: was.oid,
        containsNul: false,
      });
    }
  }
  return out;
}

/** What the pull request is judged against. */
export interface RepoChangePullRequest {
  /** The isolated session on the repository (`openIsolatedGit`). */
  readonly git: IsolatedGit;
  /** The repository's common git directory (`resolveGitDirectories`), where `shallow` lives. */
  readonly commonDir: string;
  /** The trusted tip of the base ref: pins, revocations, policy and spent are read here. */
  readonly base: string;
  /** The pull request's head commit (the bundle commit). */
  readonly head: string;
  /** The repository the check runs in (`owner/name`); the scope's `repo` must equal it. */
  readonly repository: string;
  /** The pull request's base ref name. */
  readonly baseRef: string;
  /**
   * The pull request's author. `null` only before a pull request exists (the
   * producer's self-check): the publisher check is then CI's, and is skipped.
   */
  readonly prAuthor: string | null;
  /** The evaluation time (ms since the epoch), the runner's clock (`local_clock`). */
  readonly now: number;
  /** When the revocations were read (ms), recorded as their freshness; default `now`. */
  readonly revocationsAsOf?: number;
}

/** The computed inputs, and what they were computed from. */
export interface RepoChangeInputs {
  /** Exactly what `verifyRepoChange` takes, in `pull_request` mode. */
  readonly input: VerifyRepoChangeInput;
  /**
   * The bundle file judged: the one the pull request adds, else the one it
   * modifies when it adds none and modifies exactly one; `null` otherwise.
   */
  readonly bundlePath: string | null;
  /** The pull request head's only parent, or `null` when it has none or several. */
  readonly changeCommit: string | null;
  /** Every ancestry and shape check that failed (also in `input.mode.shapeFailures`). */
  readonly shapeFailures: readonly string[];
  /** What the base says, as read (pins, revocations, policy, and every rule that did not hold). */
  readonly state: RepoState;
}

/** The bundle fields the shape checks need (`looseRecord`). */
export interface LooseRecord {
  readonly grantId: string | null;
  readonly parentCommit: string | null;
  readonly headCommit: string | null;
  /** The record's `entries`, when every one is a `{path, mode, blob}` of strings. */
  readonly entries: readonly { path: string; mode: string; blob: string }[] | null;
}

/** A record's `entries`, read loosely: each a `{path, mode, blob}` of strings, else `null`. */
function looseEntries(v: unknown): { path: string; mode: string; blob: string }[] | null {
  if (!Array.isArray(v)) return null;
  const out: { path: string; mode: string; blob: string }[] = [];
  for (const e of v as unknown[]) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) return null;
    const { path: p, mode, blob } = e as Record<string, unknown>;
    if (typeof p !== "string" || typeof mode !== "string" || typeof blob !== "string") return null;
    out.push({ path: p, mode, blob });
  }
  return out;
}

/** The fields the shape checks need, read loosely: the verifier judges the strict shape. */
export function looseRecord(bytes: Uint8Array): LooseRecord {
  const none: LooseRecord = { grantId: null, parentCommit: null, headCommit: null, entries: null };
  let bundle: unknown;
  try {
    bundle = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return none;
  }
  const obj = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const b = obj(bundle);
  const grantId = str(obj(b?.grant)?.grant_id);
  const result = str(obj(b?.receipt)?.result);
  let record: Record<string, unknown> | null = null;
  try {
    record = result === null ? null : obj(JSON.parse(result));
  } catch {
    record = null;
  }
  return {
    grantId,
    parentCommit: str(record?.parent_commit),
    headCommit: str(record?.head_commit),
    entries: looseEntries(record?.entries),
  };
}

/** Compute every input `verifyRepoChange` needs for a pull request (CI-on-PR mode). */
export async function computeRepoChangeInputs(
  pr: RepoChangePullRequest,
): Promise<RepoChangeInputs> {
  const { git, base, head } = pr;
  const shapes: string[] = [];

  // -- At the base, never from the pull request.
  const baseTree = await listTree(git, base);
  const state = await readRepoState(git, base, baseTree);
  if (state.policy === null) {
    throw new RepoStateError([
      `the path policy at the base cannot be used, so the change is not judged: ${state.problems
        .filter((p) => p.includes(".motebit/repo-path-policy.json"))
        .join("; ")}`,
    ]);
  }
  const policy = state.policy;

  // -- The pull request: the whole change against the base.
  const headTree = await listTree(git, head);
  const prEntries = await computeEntries(git, baseTree, headTree);

  // -- The bundle: the one file the pull request adds under .motebit/bundles/.
  const added = prEntries.filter(
    (e) => e.kind === "add" && pathKey(e.path).startsWith(BUNDLES_DIR),
  );
  let bundle: Uint8Array = new Uint8Array();
  let foundPath: string | null = null;
  if (added.length === 1 && added[0]!.mode === "100644") {
    bundle = await readBlob(git, added[0]!.blob);
    foundPath = pathKey(added[0]!.path);
  } else {
    shapes.push(
      `the pull request does not add exactly one regular file under ${BUNDLES_DIR} (it adds ${added.length})`,
    );
    // It adds none but modifies exactly one regular file there: that file at
    // the head is the bundle judged. The shape checks still fail (it adds
    // none, and it modifies a bundle), and every axis is computed from it
    // (§9), so a second bundle under a spent grant reads as spent. A delete
    // has no bundle at the head.
    const modified = prEntries.filter(
      (e) => e.kind === "modify" && pathKey(e.path).startsWith(BUNDLES_DIR),
    );
    if (added.length === 0 && modified.length === 1 && modified[0]!.mode === "100644") {
      bundle = await readBlob(git, modified[0]!.blob);
      foundPath = pathKey(modified[0]!.path);
    }
  }
  const record = looseRecord(bundle);

  // -- Ancestry: base ← change commit ← bundle commit (= the pull request head).
  const headParents = await commitParents(git, head);
  const changeCommit = headParents.length === 1 ? headParents[0]! : null;
  if (changeCommit === null) {
    shapes.push("the pull request head is not one non-merge commit (the bundle commit)");
  }
  const changeParents = changeCommit === null ? [] : await commitParents(git, changeCommit);
  if (changeParents.length !== 1 || changeParents[0] !== base) {
    shapes.push(
      "the pull request is not exactly the change commit and the bundle commit, linear on the base",
    );
  }
  if (record.parentCommit !== base) shapes.push("parent_commit is not the tip of the base ref");
  if (changeCommit !== null && record.headCommit !== changeCommit) {
    shapes.push("head_commit is not the bundle commit's parent");
  }

  // -- The change: the change commit's full tree against the base's.
  const changeTree = changeCommit === null ? baseTree : await listTree(git, changeCommit);
  const entries = await computeEntries(git, baseTree, changeTree);

  // -- head_commit..pr_head: exactly one A 100644 at the grant's bundle path.
  const bundleEntries = await computeEntries(git, changeTree, headTree);
  const target = record.grantId === null ? null : bundlePath(record.grantId);
  if (
    target === null ||
    bundleEntries.length !== 1 ||
    bundleEntries[0]!.kind !== "add" ||
    bundleEntries[0]!.mode !== "100644" ||
    pathKey(bundleEntries[0]!.path) !== target
  ) {
    shapes.push(
      `head_commit..bundle_commit is not exactly one A 100644 at ${target ?? `${BUNDLES_DIR}<grant_id>.json`}`,
    );
  }

  // -- The pull request's base and author.
  if (pr.baseRef !== REPO_TASK_BASE_REF) {
    shapes.push(`the base ref is not ${REPO_TASK_BASE_REF}`);
  }
  if (pr.prAuthor !== null && pr.prAuthor !== REPO_CHANGE_PUBLISHER) {
    shapes.push(`the pull request's author is not ${REPO_CHANGE_PUBLISHER}`);
  }

  // -- Nothing under .motebit/bundles/ is modified or deleted, and the change touches none of it.
  for (const e of prEntries) {
    if (e.kind !== "add" && pathKey(e.path).startsWith(BUNDLES_DIR)) {
      shapes.push(`the pull request modifies or deletes ${JSON.stringify(pathKey(e.path))}`);
    }
  }
  for (const e of entries) {
    if (pathKey(e.path).startsWith(BUNDLES_DIR)) {
      shapes.push("a change entry touches .motebit/bundles/");
    }
  }

  // -- Spent, on the base's first-parent history. A grant id that is not a
  // lowercase UUID is the verifier's integrity failure; it has no bundle path.
  const spent =
    record.grantId !== null && isCanonicalGrantId(record.grantId)
      ? await isGrantSpent(git, base, record.grantId, pr.commonDir)
      : false;

  const input: VerifyRepoChangeInput = {
    bundle,
    entries,
    trackedPaths: baseTree.map((e) => e.path),
    pins: { principal: state.principal, agents: state.agents },
    isPathPermitted: (p: string) => isRepoPathPermitted(policy, p),
    revocations: {
      set: state.revocations.set,
      failures: state.revocations.failures,
      freshness: { basis: "asserted", asOf: { timestamp_ms: pr.revocationsAsOf ?? pr.now } },
      readAt: base,
    },
    spent,
    expectedRepo: pr.repository,
    mode: { kind: "pull_request", shapeFailures: shapes, now: pr.now },
  };
  return { input, bundlePath: foundPath, changeCommit, shapeFailures: shapes, state };
}

/** A pull request to judge, by the repository's path on disk. */
export interface RepoChangePullRequestCheck {
  /** The clone: a worktree (its `.git` entry is used) or a bare git directory. */
  readonly repo: string;
  readonly base: string;
  readonly head: string;
  readonly repository: string;
  readonly baseRef: string;
  readonly prAuthor: string;
  /** The evaluation time (ms), the runner's clock (`local_clock`). */
  readonly now: number;
}

/** What `motebit-verify repo-change` decides. */
export interface RepoChangeReport {
  readonly computed: RepoChangeInputs;
  readonly verification: RepoChangeVerification;
  /** Fully verified AND outcome `completed`: what CI requires. */
  readonly accepted: boolean;
  readonly evaluatedAt: number;
}

/**
 * Judge a pull request in CI-on-PR mode: open the isolated session on `repo`
 * (its object format from `base`'s length), compute every input
 * (`computeRepoChangeInputs`), then `verifyRepoChange`. Never fetches and
 * never runs git on the repository's own git directory. Throws when the
 * change cannot be judged (I/O, no parsable policy at the base, a shallow
 * clone, a commit that is not there).
 */
export async function verifyRepoChangePullRequest(
  c: RepoChangePullRequestCheck,
): Promise<RepoChangeReport> {
  const repo = path.resolve(c.repo);
  // A worktree's `.git` entry (a directory, or a gitdir file), else the
  // repository itself is a bare git directory. Resolved without git.
  let gitEntry = path.join(repo, ".git");
  try {
    fs.lstatSync(gitEntry);
  } catch {
    gitEntry = repo;
  }
  const { commonDir } = resolveGitDirectories(gitEntry);
  const git = await openIsolatedGit({
    gitEntry,
    objectFormat: c.base.length === 64 ? "sha256" : "sha1",
  });
  try {
    const computed = await computeRepoChangeInputs({
      git,
      commonDir,
      base: c.base,
      head: c.head,
      repository: c.repository,
      baseRef: c.baseRef,
      prAuthor: c.prAuthor,
      now: c.now,
    });
    const verification = await verifyRepoChange(computed.input);
    const accepted = isFullyVerified(verification.verdict) && verification.outcome === "completed";
    return { computed, verification, accepted, evaluatedAt: c.now };
  } finally {
    git.close();
  }
}
