/**
 * `motebit repo-task run` — the agent side of a governed repo change
 * (docs/proposals/governed-repo-change-v1.md § "The chain", steps 4–7;
 * build step 4).
 *
 * In order, failing closed at each step:
 *
 *   1. PREFLIGHT, before any passphrase prompt or model call — the agent
 *      identity A (`--agent <dir>`, never the default config directory; only
 *      its identity and key fields), the delegation (`--delegation <dir>`),
 *      the tip (`parent_commit`, resolved from the files without git: HEAD on
 *      the scope's `base_ref`), the pins, revocations and path policy read
 *      from the TIP'S TREE, the spent status, the worktree clean at the tip,
 *      A ≠ the principal, A an agent pin — then the run's authority law
 *      (`checkRepoTaskAuthority`, the verifier's own rules) at the local clock.
 *   2. THE RUN — A's key unlocked (erased on every exit path), the provider
 *      built from flags only, `runRepoTask` over the isolated git adapters:
 *      no interior, exactly the scope's tools, a durable receipt per call.
 *   3. THE CHANGE COMMIT (step 5) — on a private index from the staged blobs.
 *   4. THE OUTCOME (step 6) — A's `ExecutionReceipt`, its `result` the
 *      canonical change record.
 *   5. THE BUNDLE COMMIT (step 7) — one commit adding exactly
 *      `.motebit/bundles/<grant_id>.json`.
 *   6. THE SELF-CHECK — `verifyRepoChange` over the committed bundle, with
 *      inputs computed by `motebit-verify repo-change`'s own function
 *      (`computeRepoChangeInputs`: CI-on-PR mode, base = tip, head = the
 *      bundle commit, the run's clock).
 *
 * No ref is created or moved, nothing is pushed, the worktree is never
 * written: the commits are objects in the repository's store, reachable from
 * nothing until the operator pushes the bundle commit.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { StreamingProvider } from "@motebit/ai-core";
import { hexToBytes } from "@motebit/encryption";
import type { DelegationToken, StandingDelegation } from "@motebit/encryption";
import type { RepoChangeToolInvocationReceipt, RepoTaskScope } from "@motebit/sdk";
import { RepoTaskRefusedError, checkRepoTaskAuthority, runRepoTask } from "@motebit/runtime";
import type {
  RepoTaskAgent,
  RepoTaskAuthorityBundle,
  RepoTaskPin,
  RepoTaskRunResult,
} from "@motebit/runtime";
import {
  isFullyVerified,
  isRepoChangeGrantShape,
  isRepoChangeTickShape,
  isRepoTaskScopeShape,
  verifyRepoChange,
} from "@motebit/verifier";
import type { RepoChangeVerification } from "@motebit/verifier";
import {
  RepoTipError,
  computeRepoChangeInputs,
  listTree,
  openIsolatedGit,
  resolveGitDirectories,
  resolveRepoTip,
} from "@motebit/verify/git";
import type { RepoTip } from "@motebit/verify/git";

import type { FullConfig } from "../config.js";
import { mkdirOwnerOnly } from "../durable-file.js";
import type { ActiveSigningKey, LoadActiveSigningKeyOptions } from "../identity.js";
import { agentKeyConfig, isDefaultConfigDir, readAgentIdentity } from "./agent-identity.js";
import { canonicalPath, fileIdentity, isSameEntry, isWithinEntry } from "./fs-identity.js";
import {
  buildRepoChangeRecord,
  bundlePath,
  commitBundle,
  repoChangeBundleBytes,
  repoTaskOutcome,
  signRepoChangeReceipt,
} from "./bundle.js";
import type { HarnessCommit } from "./bundle.js";
import { keySpellingFault, readDelegationDirectory } from "./delegation.js";
import { createGitChangeStager } from "./git-change-stager.js";
import { createGitTreeReader } from "./git-tree-reader.js";
import {
  RepoTaskPreflightError,
  isGrantSpentAtTip,
  readTipState,
  worktreeDifferences,
} from "./preflight.js";
import { createReceiptFileSink } from "./receipt-file-sink.js";

export interface RepoTaskRunOptions {
  /** A's config directory (`--agent`). */
  readonly agentDir: string;
  /** The directory `motebit repo-task delegate` wrote (`--delegation`). */
  readonly delegationDir: string;
  /** The repository's worktree (`--repo`, default cwd). */
  readonly repoDir: string;
  /** Where the receipt file goes (`--output`, default the delegation directory); never inside the repository. */
  readonly outputDir?: string;
  /** The provider's name, recorded in the change record (informational). */
  readonly providerName: string;
}

/** The process-touching calls the run makes; injected so tests watch the key and the clock. */
export interface RepoTaskRunDeps {
  readonly loadActiveSigningKey: (
    config: FullConfig,
    options: LoadActiveSigningKeyOptions,
  ) => Promise<ActiveSigningKey>;
  readonly secureErase: (key: Uint8Array) => void;
  /** Builds the provider from flags only (default personality, API key from the environment). */
  readonly createProvider: () => StreamingProvider;
  /** How A's passphrase is obtained (never the principal's session cache or keychain). */
  readonly getPassphrase: (label: string) => Promise<string>;
  /** The directories `--agent` may never name. */
  readonly defaultConfigDirs: () => string[];
  readonly now: () => number;
  readonly runtimeVersion: string;
}

export interface RepoTaskRunReport {
  readonly grantId: string;
  readonly parentCommit: string;
  readonly headCommit: string;
  readonly bundleCommit: string;
  readonly bundlePath: string;
  readonly bundleBytes: Uint8Array;
  readonly status: "completed" | "failed" | "denied";
  readonly run: RepoTaskRunResult;
  readonly receiptsFile: string;
  readonly verification: RepoChangeVerification;
  /** Fully verified AND outcome `completed`: what CI would require. */
  readonly accepted: boolean;
}

const COMMIT_AUTHOR = { authorName: "motebit repo-task", authorEmail: "repo-task@motebit.invalid" };

function refuse(...lines: string[]): never {
  throw new RepoTaskPreflightError(lines);
}

/**
 * `outputDir` lies in this repository: inside its git directory or its
 * common git directory, or below a directory holding a `.git` entry whose
 * common git directory is this repository's (by filesystem identity). That
 * covers this worktree, the main worktree and every linked worktree without
 * trusting git's worktree list, which a moved worktree or a separate git
 * directory leaves incomplete. An ancestor `.git` that cannot be resolved
 * might be this repository's, so it fails closed.
 */
function isInsideRepository(outputDir: string, tipInfo: RepoTip): string | null {
  if (isWithinEntry(outputDir, tipInfo.gitDir) || isWithinEntry(outputDir, tipInfo.commonDir)) {
    return "inside the repository's git directory";
  }
  // Walk the real path: a symlink into the repository is the repository.
  let cur = canonicalPath(outputDir);
  for (;;) {
    const dotGit = path.join(cur, ".git");
    if (fileIdentity(dotGit) !== null || isSymlink(dotGit)) {
      let common: string;
      try {
        common = resolveGitDirectories(dotGit).commonDir;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `below ${cur}, whose .git cannot be resolved (${msg}), so it may be this repository`;
      }
      if (isSameEntry(common, tipInfo.commonDir)) return `inside the repository's worktree ${cur}`;
    }
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Run a governed repo change. Every refusal before the run is a
 * `RepoTaskPreflightError` (no prompt, no model call, nothing written);
 * after the key is unlocked, it is erased before anything propagates.
 */
export async function runGovernedRepoTask(
  opts: RepoTaskRunOptions,
  deps: RepoTaskRunDeps,
): Promise<RepoTaskRunReport> {
  // -- A: never the default config directory, then only identity and key fields.
  if (isDefaultConfigDir(opts.agentDir, deps.defaultConfigDirs())) {
    refuse(
      `--agent ${opts.agentDir} is this machine's default motebit config directory: the agent must be a separate identity in its own directory`,
    );
  }
  let agent: ReturnType<typeof readAgentIdentity>;
  try {
    agent = readAgentIdentity(opts.agentDir);
  } catch (err) {
    refuse(err instanceof Error ? err.message : String(err));
  }
  const fault = await keySpellingFault(agent.publicKeyHex);
  if (fault !== null) {
    refuse(`--agent: device_public_key is not in its one spelling (${fault})`);
  }
  const agentPin: RepoTaskPin = { motebit_id: agent.motebitId, public_key: agent.publicKeyHex };

  // -- The delegation, of the strict shapes before any field is used.
  let scope: RepoTaskScope;
  let grant: StandingDelegation;
  let tick: DelegationToken;
  try {
    ({ scope, grant, tick } = readDelegationDirectory(opts.delegationDir));
  } catch (err) {
    refuse(err instanceof Error ? err.message : String(err));
  }
  if (!isRepoTaskScopeShape(scope))
    refuse("scope.json is not a repo-task scope of the strict shape");
  if (!isRepoChangeGrantShape(grant)) refuse("grant.json is not a grant of the strict shape");
  if (!isRepoChangeTickShape(tick)) refuse("tick.json is not a tick of the strict shape");

  // -- The tip, from the files alone: HEAD on the scope's base_ref.
  const repoDir = path.resolve(opts.repoDir);
  let tipInfo: ReturnType<typeof resolveRepoTip>;
  try {
    tipInfo = resolveRepoTip(repoDir, scope.base_ref, scope.object_format);
  } catch (err) {
    if (err instanceof RepoTipError) refuse(err.message);
    throw err;
  }
  const { tip } = tipInfo;
  const outputDir = path.resolve(opts.outputDir ?? opts.delegationDir);
  // By filesystem identity, not spelling: a case alias of the repository is
  // the repository, and every worktree of it is the repository.
  const inside = isInsideRepository(outputDir, tipInfo);
  if (inside !== null) {
    refuse(`the output directory ${outputDir} is ${inside}: the run never writes the repository`);
  }

  const git = await openIsolatedGit({
    gitEntry: tipInfo.gitEntry,
    objectFormat: scope.object_format,
  });
  try {
    // -- The tip's tree: pins, revocations, policy; spent; worktree clean.
    const tree = await listTree(git, tip);
    const tipState = await readTipState(git, tip, tree);
    const spent = await isGrantSpentAtTip(git, tip, grant.grant_id, tipInfo.commonDir);
    const dirty = worktreeDifferences(repoDir, tree, scope.object_format);
    if (dirty.length > 0) {
      refuse(
        "the worktree is not clean at the tip:",
        ...dirty.slice(0, 20).map((d) => `  ${d}`),
        ...(dirty.length > 20 ? [`  … and ${dirty.length - 20} more`] : []),
      );
    }
    const { principal, agents } = tipState;
    if (
      agentPin.motebit_id === principal.motebit_id ||
      agentPin.public_key === principal.public_key
    ) {
      refuse("--agent is the principal: the agent must be a separate identity");
    }
    if (
      !agents.some(
        (p) => p.motebit_id === agentPin.motebit_id && p.public_key === agentPin.public_key,
      )
    ) {
      refuse("--agent is not an agent pin at the tip (.motebit/principals/agents/*.md)");
    }

    // -- The run's authority law at the local clock, before the key is unlocked.
    const authority: RepoTaskAuthorityBundle = {
      scope,
      grant,
      tick,
      revocations: tipState.revocations,
      principal,
      agents,
      // The run has no source of the repository's name but the scope (it
      // reads no git config and no remote); CI holds `repo` to the
      // repository it runs in.
      expectedRepo: scope.repo,
      isPathPermitted: tipState.isPathPermitted,
      spent,
    };
    const preflightAt = deps.now();
    const check = await checkRepoTaskAuthority(authority, agentPin, preflightAt);
    if (!check.ok) {
      refuse(
        "the delegation does not authorize this run:",
        ...check.failures.map((f) => `  ${f.code}: ${f.detail}`),
      );
    }

    // -- The run: the provider from flags, A's key held only inside.
    const provider = deps.createProvider();
    mkdirOwnerOnly(outputDir);
    const receiptsFile = path.join(outputDir, `receipts-${grant.grant_id}-${preflightAt}.jsonl`);
    const sink = createReceiptFileSink(receiptsFile);
    const stager = createGitChangeStager({ git, tip });
    const commitAt = (message: string): HarnessCommit => ({
      message,
      ...COMMIT_AUTHOR,
      timestamp: Math.floor(deps.now() / 1000),
    });
    let made: Awaited<ReturnType<typeof runAndRecord>>;
    try {
      const active = await deps.loadActiveSigningKey(agentKeyConfig(agent), {
        promptLabel: "Agent passphrase: ",
        getPassphrase: deps.getPassphrase,
      });
      try {
        if (active.publicKey !== agent.publicKeyHex) {
          refuse("--agent: the decrypted key is not the config's device_public_key");
        }
        made = await runAndRecord({
          authority,
          agent: {
            motebitId: agent.motebitId,
            deviceId: agent.deviceId,
            privateKey: active.privateKey,
            publicKey: hexToBytes(active.publicKey),
          },
          provider,
          providerName: opts.providerName,
          git,
          tip,
          stager,
          sink,
          runtimeVersion: deps.runtimeVersion,
          now: deps.now,
          commitAt,
        });
      } finally {
        deps.secureErase(active.privateKey);
      }
    } finally {
      await sink.close();
    }

    // -- The bundle commit (step 7): exactly one file on head_commit.
    const bundleCommit = await commitBundle(
      git,
      made.record.head_commit,
      grant.grant_id,
      made.bundleBytes,
      commitAt(`repo-task ${grant.grant_id}: bundle\n`),
    );

    // -- The self-check. EVIDENCE, NOT AUTHORITY: this verdict is the agent
    // checking its own output with the verifier's law before it reports
    // success, and it confers nothing. Only signed artifacts authorize
    // (docs/doctrine/memory-never-confers-authority.md), and authority comes
    // from a principal who is not the delegate (spec/repo-change-v1.md §2
    // rule 3) — so the agent's own verdict over its own work can never stand
    // in for the check CI runs from the protected base. The inputs are
    // computed by the SAME function `motebit-verify repo-change` runs in CI
    // (`computeRepoChangeInputs`, `@motebit/verify/git`), from the committed
    // objects — base = the tip, head = the bundle commit — at the run's
    // clock. No pull request exists yet, so its author is CI's check; the
    // base ref is the scope's, the expected repository the scope's (the run
    // reads no git config and no remote; CI holds `repo` to its repository).
    const computed = await computeRepoChangeInputs({
      git,
      commonDir: tipInfo.commonDir,
      base: tip,
      head: bundleCommit,
      repository: scope.repo,
      baseRef: scope.base_ref,
      prAuthor: null,
      now: deps.now(),
      revocationsAsOf: preflightAt,
    });
    const verification = await verifyRepoChange(computed.input);
    const accepted = isFullyVerified(verification.verdict) && verification.outcome === "completed";
    return {
      grantId: grant.grant_id,
      parentCommit: tip,
      headCommit: made.record.head_commit,
      bundleCommit,
      bundlePath: bundlePath(grant.grant_id),
      bundleBytes: made.bundleBytes,
      status: made.status,
      run: made.run,
      receiptsFile,
      verification,
      accepted,
    };
  } finally {
    git.close();
  }
}

/**
 * The part that holds A's key: the run, the change commit (step 5), the
 * signed outcome (step 6) and the bundle bytes. The caller erases the key
 * when this returns or throws.
 */
async function runAndRecord(i: {
  readonly authority: RepoTaskAuthorityBundle;
  readonly agent: RepoTaskAgent;
  readonly provider: StreamingProvider;
  readonly providerName: string;
  readonly git: Awaited<ReturnType<typeof openIsolatedGit>>;
  readonly tip: string;
  readonly stager: ReturnType<typeof createGitChangeStager>;
  readonly sink: ReturnType<typeof createReceiptFileSink>;
  readonly runtimeVersion: string;
  readonly now: () => number;
  readonly commitAt: (message: string) => HarnessCommit;
}): Promise<{
  run: RepoTaskRunResult;
  record: Awaited<ReturnType<typeof buildRepoChangeRecord>>;
  status: "completed" | "failed" | "denied";
  bundleBytes: Uint8Array;
}> {
  const { scope, grant, tick } = i.authority;
  let run: RepoTaskRunResult;
  try {
    run = await runRepoTask({
      authority: i.authority,
      agent: i.agent,
      provider: i.provider,
      providerName: i.providerName,
      reader: createGitTreeReader({ git: i.git, tip: i.tip }),
      stager: i.stager,
      receipts: i.sink,
      runtimeVersion: i.runtimeVersion,
      clock: i.now,
    });
  } catch (err) {
    if (err instanceof RepoTaskRefusedError) {
      refuse("the run refused to start:", ...err.failures.map((f) => `  ${f.code}: ${f.detail}`));
    }
    throw err;
  }
  // -- The change commit (step 5), from the staged blobs on a private index.
  const { headCommit, entries } = await i.stager.buildChangeCommit(
    i.commitAt(`repo-task ${grant.grant_id}\n`),
  );
  const status = repoTaskOutcome(run.ended, entries);
  // -- The outcome (step 6), signed by A.
  const record = await buildRepoChangeRecord({
    scope,
    grant,
    tick,
    parentCommit: i.tip,
    headCommit,
    entries,
    run,
  });
  const receipt = await signRepoChangeReceipt({ run, record, status, agent: i.agent });
  const bundleBytes = repoChangeBundleBytes({
    scope,
    grant,
    tick,
    toolReceipts: run.tool_receipts as unknown as RepoChangeToolInvocationReceipt[],
    receipt,
  });
  return { run, record, status, bundleBytes };
}
