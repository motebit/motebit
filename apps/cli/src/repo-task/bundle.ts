/**
 * The harness half of a governed repo change (docs/proposals/governed-repo-change-v1.md
 * § "The chain", steps 5–7; spec/repo-change-v1.md §3.3–§3.6): outside the
 * model, after the run.
 *
 *   - the change record (`RepoChangeResult`) and the agent's signed
 *     `ExecutionReceipt` whose `result` is that record's canonical JSON;
 *   - the bundle `{spec, scope, grant, tick, tool_receipts[], receipt}` as the
 *     canonical JSON of exactly those keys, at most 256 tool receipts;
 *   - the bundle commit: one commit on `head_commit` adding exactly
 *     `.motebit/bundles/<grant_id>.json`, built by the same private-index
 *     stager as the change commit — no worktree file, index or ref touched;
 *   - the self-check inputs, computed from the two trees (never `git diff`),
 *     for `verifyRepoChange` in CI-on-PR mode.
 *
 * Canonical JSON, digests and signing are the crypto primitives the verifier
 * itself calls (`canonicalJson`, `canonicalSha256`, `hash`,
 * `signExecutionReceipt`, re-exported by `@motebit/encryption`); the spec
 * constants are the protocol's. Nothing here re-states a verifier rule.
 */
import { canonicalJson, canonicalSha256, hash, signExecutionReceipt } from "@motebit/encryption";
import type { DelegationToken, StandingDelegation } from "@motebit/encryption";
import type {
  DigestRef,
  RepoChangeBundle,
  RepoChangeEntry,
  RepoChangeExecutionReceipt,
  RepoChangeResult,
  RepoChangeToolInvocationReceipt,
  RepoTaskScope,
} from "@motebit/sdk";
import type { RepoStagedEntry, RepoTaskAgent, RepoTaskRunResult } from "@motebit/runtime";
import {
  REPO_CHANGE_BUNDLE_SPEC_ID,
  REPO_CHANGE_MAX_TOOL_RECEIPTS,
  REPO_CHANGE_SPEC_ID,
  REPO_TASK_BASE_REF,
} from "@motebit/sdk";
import type { RepoChangeComputedEntry } from "@motebit/verifier";

import { createGitChangeStager } from "./git-change-stager.js";
import type { IsolatedGit } from "./git.js";
import { BUNDLES_DIR, listTree } from "./preflight.js";
import type { TreeEntry } from "./preflight.js";

const ENCODER = new TextEncoder();

/** Where a grant's bundle lands. */
export function bundlePath(grantId: string): string {
  return `${BUNDLES_DIR}${grantId}.json`;
}

const sha256Ref = (value: string): DigestRef => ({ algorithm: "sha-256", value });

/**
 * The receipt's `status` from how the run ended and what it changed:
 * `denied` when the authority check refused a call mid-run; `failed` when the
 * run hit a ceiling (model calls, receipts) or changed nothing; `completed`
 * only when the model finished and the change commit has entries.
 */
export function repoTaskOutcome(
  ended: RepoTaskRunResult["ended"],
  entries: readonly RepoStagedEntry[],
): "completed" | "failed" | "denied" {
  if (ended === "authority_lapsed") return "denied";
  if (ended !== "model_done" || entries.length === 0) return "failed";
  return "completed";
}

/** The change record (spec §3.3), exactly its keys. */
export async function buildRepoChangeRecord(i: {
  readonly scope: RepoTaskScope;
  readonly grant: StandingDelegation;
  readonly tick: DelegationToken;
  readonly parentCommit: string;
  readonly headCommit: string;
  readonly entries: readonly RepoStagedEntry[];
  readonly run: RepoTaskRunResult;
}): Promise<RepoChangeResult> {
  const entries: RepoChangeEntry[] = i.entries.map((e) => ({
    path: e.path,
    mode: e.mode,
    blob: e.blob,
  }));
  return {
    spec: REPO_CHANGE_SPEC_ID,
    grant_id: i.grant.grant_id,
    grant_digest: sha256Ref(await canonicalSha256(i.grant)),
    tick_digest: sha256Ref(await canonicalSha256(i.tick)),
    scope_digest: sha256Ref(await canonicalSha256(i.scope)),
    repo: i.scope.repo,
    object_format: i.scope.object_format,
    parent_commit: i.parentCommit,
    head_commit: i.headCommit,
    entries,
    tool_receipt_digests: await Promise.all(
      i.run.tool_receipts.map(async (r) => sha256Ref(await canonicalSha256(r))),
    ),
    system_prompt_digest: i.run.system_prompt_digest,
    provider: i.run.provider,
    model: i.run.model,
    runtime_version: i.run.runtime_version,
  };
}

/**
 * The agent's `ExecutionReceipt` (spec §3.4), signed by A: `result` is the
 * canonical JSON of the record for every status, `delegated_scope` is the
 * tick's scope, `memories_formed` is the run's literal 0.
 */
export async function signRepoChangeReceipt(i: {
  readonly run: RepoTaskRunResult;
  readonly record: RepoChangeResult;
  readonly status: "completed" | "failed" | "denied";
  readonly agent: RepoTaskAgent;
}): Promise<RepoChangeExecutionReceipt> {
  const result = canonicalJson(i.record);
  return (await signExecutionReceipt(
    {
      task_id: i.run.task_id,
      motebit_id: i.agent.motebitId,
      device_id: i.agent.deviceId,
      submitted_at: i.run.submitted_at,
      completed_at: i.run.completed_at,
      status: i.status,
      result,
      tools_used: [...i.run.tools_used],
      memories_formed: i.run.memories_formed,
      prompt_hash: i.run.prompt_hash,
      result_hash: await hash(ENCODER.encode(result)),
      delegated_scope: i.run.delegated_scope,
    },
    i.agent.privateKey,
    i.agent.publicKey,
  )) as RepoChangeExecutionReceipt;
}

/** The bundle's bytes (spec §3.6): the canonical JSON of exactly its six keys. */
export function repoChangeBundleBytes(i: {
  readonly scope: RepoTaskScope;
  readonly grant: StandingDelegation;
  readonly tick: DelegationToken;
  readonly toolReceipts: readonly RepoChangeToolInvocationReceipt[];
  readonly receipt: RepoChangeExecutionReceipt;
}): Uint8Array {
  if (i.toolReceipts.length > REPO_CHANGE_MAX_TOOL_RECEIPTS) {
    throw new Error(
      `a bundle carries at most ${REPO_CHANGE_MAX_TOOL_RECEIPTS} tool receipts (got ${i.toolReceipts.length})`,
    );
  }
  const bundle: RepoChangeBundle = {
    spec: REPO_CHANGE_BUNDLE_SPEC_ID,
    scope: i.scope,
    grant: i.grant,
    tick: i.tick as RepoChangeBundle["tick"],
    tool_receipts: i.toolReceipts,
    receipt: i.receipt,
  };
  return ENCODER.encode(canonicalJson(bundle));
}

/** The commit identity both harness commits carry. */
export interface HarnessCommit {
  readonly message: string;
  readonly authorName: string;
  readonly authorEmail: string;
  /** Seconds since the epoch. */
  readonly timestamp: number;
}

/**
 * The bundle commit (chain step 7): one commit on `head` adding exactly
 * `.motebit/bundles/<grant_id>.json`, on a private index (no worktree file,
 * repository index or ref is touched). Refuses when that path already exists
 * at `head`, and when the commit would carry anything but that one add.
 */
export async function commitBundle(
  git: IsolatedGit,
  head: string,
  grantId: string,
  bytes: Uint8Array,
  commit: HarnessCommit,
): Promise<string> {
  const target = bundlePath(grantId);
  const atHead = await listTree(git, head);
  if (atHead.some((e) => Buffer.from(e.path).toString("latin1") === target)) {
    throw new Error(`${target} already exists at the change commit`);
  }
  const stager = createGitChangeStager({ git, tip: head });
  await stager.stage(target, bytes);
  const { headCommit, entries } = await stager.buildChangeCommit(commit);
  if (entries.length !== 1 || entries[0]!.path !== target || entries[0]!.mode !== "100644") {
    throw new Error("the bundle commit would not be exactly one 100644 add of the bundle");
  }
  return headCommit;
}

/** A commit's parents, from its raw object. */
export async function commitParents(git: IsolatedGit, commit: string): Promise<string[]> {
  const raw = (await git.run(["cat-file", "commit", commit])).toString("latin1");
  const header = raw.slice(0, raw.indexOf("\n\n") >= 0 ? raw.indexOf("\n\n") : raw.length);
  return header
    .split("\n")
    .filter((l) => l.startsWith("parent "))
    .map((l) => l.slice("parent ".length));
}

/**
 * Every path `to`'s tree differs from `from`'s in, computed by listing both
 * trees completely and comparing in-process (spec §7: never from `git diff`).
 * A type change appears as a delete plus an add.
 */
export async function computeEntries(
  git: IsolatedGit,
  fromTree: readonly TreeEntry[],
  toTree: readonly TreeEntry[],
): Promise<RepoChangeComputedEntry[]> {
  const key = (e: TreeEntry): string => Buffer.from(e.path).toString("latin1");
  const before = new Map(fromTree.map((e) => [key(e), e]));
  const after = new Map(toTree.map((e) => [key(e), e]));
  const containsNul = async (e: TreeEntry): Promise<boolean> =>
    e.type === "blob" && (await git.run(["cat-file", "blob", e.oid])).includes(0);
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

/**
 * The CI-on-PR mode's ancestry and shape checks (spec §9), as far as they
 * exist before a pull request does, computed from the commit objects and the
 * trees: `parent_commit` is the tip; the change commit's only parent is the
 * tip and the bundle commit's only parent is the change commit; the bundle
 * commit adds exactly one 100644 file at the grant's bundle path; the base
 * is `main`; no change entry touches `.motebit/bundles/`. (The publisher
 * account and the PR's base are the CI check's: no PR exists yet.)
 */
export async function shapeFailures(i: {
  readonly git: IsolatedGit;
  readonly tip: string;
  readonly record: RepoChangeResult;
  readonly bundleCommit: string;
  readonly scope: RepoTaskScope;
  readonly changeEntries: readonly RepoChangeComputedEntry[];
  readonly headTree: readonly TreeEntry[];
  readonly bundleTree: readonly TreeEntry[];
}): Promise<string[]> {
  const out: string[] = [];
  if (i.record.parent_commit !== i.tip) out.push("parent_commit is not the tip of the base ref");
  const headParents = await commitParents(i.git, i.record.head_commit);
  if (headParents.length !== 1 || headParents[0] !== i.tip) {
    out.push("the change commit is not one non-merge commit on the tip");
  }
  const bundleParents = await commitParents(i.git, i.bundleCommit);
  if (bundleParents.length !== 1 || bundleParents[0] !== i.record.head_commit) {
    out.push("the bundle commit is not one commit on the change commit");
  }
  const added = await computeEntries(i.git, i.headTree, i.bundleTree);
  const target = bundlePath(i.record.grant_id);
  if (
    added.length !== 1 ||
    added[0]!.kind !== "add" ||
    added[0]!.mode !== "100644" ||
    Buffer.from(added[0]!.path).toString("latin1") !== target
  ) {
    out.push(`head_commit..bundle_commit is not exactly one A 100644 at ${target}`);
  }
  if (i.scope.base_ref !== REPO_TASK_BASE_REF) out.push("the base ref is not main");
  for (const e of i.changeEntries) {
    if (Buffer.from(e.path).toString("latin1").startsWith(BUNDLES_DIR)) {
      out.push("a change entry touches .motebit/bundles/");
    }
  }
  return out;
}
