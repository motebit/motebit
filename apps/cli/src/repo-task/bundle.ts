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
 *
 * The self-check's inputs are not computed here: they are
 * `computeRepoChangeInputs` (`@motebit/verify/git`), the same function
 * `motebit-verify repo-change` runs in CI.
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
} from "@motebit/sdk";
import { bundlePath, listTree } from "@motebit/verify/git";
import type { IsolatedGit } from "@motebit/verify/git";

import { createGitChangeStager } from "./git-change-stager.js";

export { bundlePath };

const ENCODER = new TextEncoder();

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
