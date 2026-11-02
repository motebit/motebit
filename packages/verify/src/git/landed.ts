/**
 * The inputs `verifyRepoChange` needs OFFLINE, on a change that has landed
 * (spec/repo-change-v1.md §7 and §9, "Offline on a landed change"; design of
 * record docs/proposals/governed-repo-change-v1.md § "The verifier", the
 * offline row and "The organizing choice"). Given a clone, the squash commit
 * that landed the change, and a TRUSTED tip of `main` the caller supplies:
 *
 *   - every commit and tree is read raw and re-hashed (`objects.ts`): git's
 *     object lookups, its commit-graph, grafts and replace refs are never
 *     trusted; first-parent chains are walked from the commits' own bytes;
 *   - the shape checks (each a failure string that folds into `integrity`):
 *     the squash commit has exactly one parent; its entries against that
 *     parent are exactly one `A 100644` at `.motebit/bundles/<grant_id>.json`
 *     plus entries equal to the record's `entries`, and nothing else touches
 *     `.motebit/bundles/`; `parent_commit` is a first-parent ancestor of
 *     (or is) the squash commit's parent; the squash commit is on the trusted
 *     tip's first-parent chain;
 *   - pins, revocations, the path policy and the tracked paths are read at the
 *     squash commit's PARENT, never from the squash commit itself;
 *   - spent: the bundle path ever existed on the parent's first-parent
 *     history;
 *   - the evaluation time: the squash commit's committer time
 *     (`operator_recorded`), accepted only when the committer is exactly
 *     `GitHub <noreply@github.com>` AND the commit's OpenPGP signature
 *     verifies under one of the pinned keys (`@motebit/crypto-openpgp`) AND the
 *     signature's creation time equals the committer time to the second;
 *     otherwise `landedAt` is `null`, so `authority` is `unknown`;
 *   - revocation freshness `asserted`, as of the accepted landing time (the
 *     parent was the tip when the squash commit was built on it), with the
 *     parent commit in `diagnostics`.
 *
 * Every input is computed even when a shape check fails, so the verifier
 * records every axis. Only what makes the change impossible to judge throws:
 * an object the store does not hold or whose bytes do not hash to its id, a
 * malformed tree or commit (`ObjectStoreError`), a squash commit with no
 * parent, no parsable path policy at the parent, or a shallow clone
 * (`RepoStateError`). Never fetches, never writes to the repository.
 *
 * Apache-2.0. Imports: Node built-ins and `@motebit/verifier`, Apache-2.0.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { isFullyVerified, isRepoPathPermitted, verifyRepoChange } from "@motebit/verifier";
import type {
  RepoChangeComputedEntry,
  RepoChangeVerification,
  VerifyRepoChangeInput,
} from "@motebit/verifier";

import { openRawObjects } from "./objects.js";
import type { RawObjects } from "./objects.js";
import { parsePinnedSigningKeys, verifyCommitSignature } from "@motebit/crypto-openpgp";
import type { PinnedSigningKey } from "@motebit/crypto-openpgp";
import { computeEntries, looseRecord } from "./repo-change.js";
import { openIsolatedGit, resolveGitDirectories } from "./session.js";
import type { IsolatedGit } from "./session.js";
import {
  BUNDLES_DIR,
  RepoStateError,
  bundlePath,
  isCanonicalGrantId,
  readRepoState,
} from "./state.js";
import type { RepoState } from "./state.js";
import { pathKey } from "./tree.js";

/** The hosting operator whose recorded time the offline mode accepts (design: "Squash commits on `main` are signed by GitHub with GitHub as committer"). */
export const LANDING_COMMITTER = { name: "GitHub", email: "noreply@github.com" } as const;

/** What a landed change is judged against. */
export interface LandedRepoChange {
  /** The isolated session on the clone (`openIsolatedGit`). */
  readonly git: IsolatedGit;
  /** The clone's common git directory, where `shallow` lives. */
  readonly commonDir: string;
  /** The squash commit that landed the change. */
  readonly landed: string;
  /** A trusted tip of `main` (an independent witness): the squash commit must be on its first-parent chain. */
  readonly trustedTip: string;
  /** The repository (`owner/name`); the scope's `repo` must equal it. */
  readonly repository: string;
  /** The pinned signing keys of the hosting operator (`parsePinnedSigningKeys`). */
  readonly signingKeys: readonly PinnedSigningKey[];
}

/** Whether the squash commit's committer time was accepted, and why not. */
export interface LandedTime {
  /** The committer time in ms, or `null` when it was not accepted. */
  readonly landedAt: number | null;
  /** The committer header's value, as recorded. */
  readonly committer: string;
  /** The pinned key's fingerprint that verified the signature, when one did. */
  readonly signer: string | null;
  /** Why the time was not accepted (`null` when it was). */
  readonly problem: string | null;
}

/** The computed inputs, and what they were computed from. */
export interface LandedRepoChangeInputs {
  /** Exactly what `verifyRepoChange` takes, in `landed` mode. */
  readonly input: VerifyRepoChangeInput;
  /** The squash commit's (first) parent: where everything was read. */
  readonly parent: string;
  /** The bundle file the squash commit adds, or `null` when it adds no single one. */
  readonly bundlePath: string | null;
  readonly shapeFailures: readonly string[];
  readonly time: LandedTime;
  /** What the parent says (pins, revocations, policy, every rule that did not hold). */
  readonly state: RepoState;
}

const COMMITTER = /^(.*) <([^<>]*)> (0|[1-9][0-9]{0,11}) [+-][0-9]{4}$/;

/** The committer time, accepted only under the operator's identity and a pinned signature. */
export function acceptLandingTime(
  raw: Buffer,
  committer: string,
  objectFormat: "sha1" | "sha256",
  keys: readonly PinnedSigningKey[],
): LandedTime {
  const no = (problem: string, signer: string | null = null): LandedTime => ({
    landedAt: null,
    committer,
    signer,
    problem,
  });
  const m = COMMITTER.exec(committer);
  if (!m) return no("the committer header is malformed");
  if (m[1] !== LANDING_COMMITTER.name || m[2] !== LANDING_COMMITTER.email) {
    return no(`the committer is not ${LANDING_COMMITTER.name} <${LANDING_COMMITTER.email}>`);
  }
  const seconds = Number(m[3]);
  const sig = verifyCommitSignature(raw, objectFormat, keys);
  if (!sig.ok) return no(sig.reason);
  if (sig.createdAt !== seconds) {
    return no(
      `the signature's creation time (${sig.createdAt}) is not the committer time (${seconds})`,
      sig.fingerprint,
    );
  }
  return { landedAt: seconds * 1000, committer, signer: sig.fingerprint, problem: null };
}

/** Walk `start`'s first-parent chain to the root, from the commits' own bytes. */
async function* firstParentChain(raw: RawObjects, start: string): AsyncGenerator<string> {
  let cur: string | undefined = start;
  while (cur !== undefined) {
    yield cur;
    cur = (await raw.commit(cur)).parents[0];
  }
}

/** Compute every input `verifyRepoChange` needs for a landed change (offline mode). */
export async function computeLandedRepoChangeInputs(
  c: LandedRepoChange,
): Promise<LandedRepoChangeInputs> {
  const { git } = c;
  if (fs.existsSync(path.join(c.commonDir, "shallow"))) {
    throw new RepoStateError([
      "the repository is shallow: its first-parent history cannot be established",
    ]);
  }
  const raw = openRawObjects(git);
  try {
    return await compute(c, raw);
  } finally {
    raw.close();
  }
}

async function compute(c: LandedRepoChange, raw: RawObjects): Promise<LandedRepoChangeInputs> {
  const shapes: string[] = [];
  const squash = await raw.commit(c.landed);
  const parent = squash.parents[0];
  if (parent === undefined) {
    throw new RepoStateError(["the squash commit has no parent: there is nothing to judge it on"]);
  }
  if (squash.parents.length !== 1) {
    shapes.push(
      `the squash commit does not have exactly one parent (it has ${squash.parents.length})`,
    );
  }

  // -- At the parent, never from the squash commit.
  const parentTree = await raw.listTree((await raw.commit(parent)).tree);
  const state = await readRepoState(c.git, parent, parentTree, raw.blob);
  if (state.policy === null) {
    throw new RepoStateError([
      `the path policy at the squash commit's parent cannot be used, so the change is not judged: ${state.problems
        .filter((p) => p.includes(".motebit/repo-path-policy.json"))
        .join("; ")}`,
    ]);
  }
  const policy = state.policy;

  // -- The squash commit's entries against its parent.
  const squashTree = await raw.listTree(squash.tree);
  const all = await computeEntries(c.git, parentTree, squashTree, raw.blob);

  // -- The bundle: the one regular file the squash commit adds under .motebit/bundles/.
  const added = all.filter((e) => e.kind === "add" && pathKey(e.path).startsWith(BUNDLES_DIR));
  let bundle: Uint8Array = new Uint8Array();
  let bundleEntry: RepoChangeComputedEntry | null = null;
  if (added.length === 1 && added[0]!.mode === "100644") {
    bundleEntry = added[0]!;
    bundle = await raw.blob(bundleEntry.blob);
  } else {
    shapes.push(
      `the squash commit does not add exactly one regular file under ${BUNDLES_DIR} (it adds ${added.length})`,
    );
  }
  const record = looseRecord(bundle);
  const target = record.grantId === null ? null : bundlePath(record.grantId);
  if (bundleEntry !== null && pathKey(bundleEntry.path) !== target) {
    shapes.push(
      `the squash commit's bundle is not at ${target ?? `${BUNDLES_DIR}<grant_id>.json`}`,
    );
  }

  // -- The change: every other entry, which must equal the record's entries.
  const entries = all.filter((e) => e !== bundleEntry);
  for (const e of entries) {
    if (pathKey(e.path).startsWith(BUNDLES_DIR)) {
      shapes.push(
        `the squash commit touches ${JSON.stringify(pathKey(e.path))} besides its bundle`,
      );
    }
  }
  if (!entriesMatch(entries, record.entries)) {
    shapes.push("the squash commit's entries besides its bundle are not the record's entries");
  }

  // -- The squash commit is on the trusted tip's first-parent chain.
  let onTip = false;
  for await (const commit of firstParentChain(raw, c.trustedTip)) {
    if (commit === c.landed) {
      onTip = true;
      break;
    }
  }
  if (!onTip) shapes.push("the squash commit is not on the trusted tip's first-parent chain");

  // -- parent_commit, and spent, on the parent's first-parent history.
  const spentCheck = record.grantId !== null && isCanonicalGrantId(record.grantId) ? target : null;
  let parentSeen = false;
  let spent = false;
  for await (const commit of firstParentChain(raw, parent)) {
    if (commit === record.parentCommit) parentSeen = true;
    if (spentCheck !== null && !spent) {
      spent = (await raw.lookup((await raw.commit(commit)).tree, spentCheck)) !== null;
    }
  }
  if (!parentSeen) {
    shapes.push("parent_commit is not a first-parent ancestor of the squash commit's parent");
  }

  // -- The evaluation time.
  const time = acceptLandingTime(squash.raw, squash.committer, raw.objectFormat, c.signingKeys);

  const input: VerifyRepoChangeInput = {
    bundle,
    entries,
    trackedPaths: parentTree.map((e) => e.path),
    pins: { principal: state.principal, agents: state.agents },
    isPathPermitted: (p: string) => isRepoPathPermitted(policy, p),
    revocations: {
      set: state.revocations.set,
      failures: state.revocations.failures,
      freshness: {
        basis: "asserted",
        asOf: time.landedAt === null ? {} : { timestamp_ms: time.landedAt },
      },
      readAt: parent,
    },
    spent,
    expectedRepo: c.repository,
    mode: { kind: "landed", shapeFailures: shapes, landedAt: time.landedAt },
  };
  return {
    input,
    parent,
    bundlePath: bundleEntry === null ? null : pathKey(bundleEntry.path),
    shapeFailures: shapes,
    time,
    state,
  };
}

/** The change entries are exactly the record's: each an add or modify, one-to-one by path, mode and blob. */
function entriesMatch(
  entries: readonly RepoChangeComputedEntry[],
  recorded: readonly { path: string; mode: string; blob: string }[] | null,
): boolean {
  if (recorded === null || recorded.length !== entries.length) return false;
  const want = new Map<string, string>();
  for (const r of recorded) {
    const k = Buffer.from(r.path, "utf8").toString("latin1");
    if (want.has(k)) return false;
    want.set(k, `${r.mode} ${r.blob}`);
  }
  for (const e of entries) {
    if (e.kind === "delete") return false;
    if (want.get(pathKey(e.path)) !== `${e.mode} ${e.blob}`) return false;
  }
  return true;
}

/** A landed change to judge, by the clone's path on disk. */
export interface LandedRepoChangeCheck {
  /** The clone: a worktree (its `.git` entry is used) or a bare git directory. */
  readonly repo: string;
  readonly landed: string;
  readonly trustedTip: string;
  readonly repository: string;
  /** The pinned signing keys file's text (`parsePinnedSigningKeys`). */
  readonly signingKeys: string;
}

/** What the offline mode decides. */
export interface LandedRepoChangeReport {
  readonly computed: LandedRepoChangeInputs;
  readonly verification: RepoChangeVerification;
  /** Fully verified AND outcome `completed`. */
  readonly accepted: boolean;
}

/**
 * Judge a landed change offline: parse the pinned keys, open the isolated
 * session on `repo` (its object format from the squash commit id's length),
 * compute every input (`computeLandedRepoChangeInputs`), then
 * `verifyRepoChange`. Throws when the change cannot be judged.
 */
export async function verifyRepoChangeLanded(
  c: LandedRepoChangeCheck,
): Promise<LandedRepoChangeReport> {
  const signingKeys = parsePinnedSigningKeys(c.signingKeys);
  const repo = path.resolve(c.repo);
  let gitEntry = path.join(repo, ".git");
  try {
    fs.lstatSync(gitEntry);
  } catch {
    gitEntry = repo;
  }
  const { commonDir } = resolveGitDirectories(gitEntry);
  const git = await openIsolatedGit({
    gitEntry,
    objectFormat: c.landed.length === 64 ? "sha256" : "sha1",
  });
  try {
    const computed = await computeLandedRepoChangeInputs({
      git,
      commonDir,
      landed: c.landed,
      trustedTip: c.trustedTip,
      repository: c.repository,
      signingKeys,
    });
    const verification = await verifyRepoChange(computed.input);
    const accepted = isFullyVerified(verification.verdict) && verification.outcome === "completed";
    return { computed, verification, accepted };
  } finally {
    git.close();
  }
}
