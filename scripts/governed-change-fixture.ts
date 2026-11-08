#!/usr/bin/env tsx
/**
 * governed-change-fixture — the negative acceptance tests B3, B4, B5a, B5b and
 * B6 of the governed repo change design (docs/proposals/governed-repo-change-v1.md,
 * "Acceptance tests"): a governed pull request whose bundle is wrong in
 * EXACTLY ONE way, every other axis as it would be on a real run, so a
 * failure on one axis cannot be mistaken for a failure on another.
 *
 *   npx tsx scripts/governed-change-fixture.ts --case b3|b4|b5a|b5b|b6 \
 *     --agent <A's config dir> --delegation <dir from `motebit repo-task delegate`> \
 *     [--repo <worktree, default cwd>] [--author "Name <email>"] [--output <dir>]
 *
 * A repository script, never a CLI subcommand: nothing that makes
 * deliberately invalid bundles ships to npm. It mirrors `motebit repo-task
 * run` (apps/cli/src/repo-task/run-command.ts) step for step — the same
 * preflight, the same key handling (A's key unlocked by the CLI's own loader,
 * erased on every exit; the principal F's key is never touched), the same
 * commit identity (`--author`), the same output-directory rule, the same
 * self-check (`computeRepoChangeInputs` + `verifyRepoChange`, CI-on-PR mode)
 * — and builds with the CLI's own builders (bundle.ts, the git change
 * stager). Each case then applies exactly the one defect it names; every
 * departure from a real run is in `DEPARTURES` below and printed with the
 * output.
 *
 *   b3   the change also touches one path outside `allowed_paths` (staged
 *        past the run's write handler, which refuses it); A signs the record
 *        over the real entries. Only `authority` fails
 *        (`entry_path_not_allowed`). Needs `max_changed_files` >= 2, else
 *        `entries_exceed_max` would be a second defect.
 *   b4   no run: an ephemeral Ed25519 key, generated in memory and erased,
 *        signs the tool receipts and the receipt in A's place (A's identity
 *        and device, the ephemeral key). A's key is never unlocked. Only
 *        `identityBinding` fails (`signer_not_delegate`).
 *   b5a  the run uses the tick as signed; the bundle carries the tick's
 *        signature re-spelled in non-canonical base64url (an unused low bit
 *        of the last character set: the same signature bytes), and A signs
 *        the record over the re-spelled tick. Only `integrity` fails
 *        (`value_not_canonical`, tick.signature).
 *   b5b  the grant's first bundle already landed: the run is told
 *        `spent: false` (local only), and the bundle commit MODIFIES the
 *        landed bundle path. `authority` is `insufficient` with
 *        `grant_spent` (spent computed true), `integrity` is invalid from
 *        the PR-shape checks alone.
 *   b6   a revocation of the grant landed: the run is told the revocation set
 *        is empty (local only); the landed revocation stays in the repository.
 *        Only `revocation` fails (`revoked`).
 *
 * The script runs the verifier locally and REFUSES to print the push command
 * unless the verdict is exactly the case's expectation (`expectedVerdict`):
 * every axis value, the outcome, spent, the shape failures and the multiset
 * of failures. Expected and actual are printed either way. No ref is created
 * or moved, nothing is pushed, the worktree is never written: the two commits
 * are unreachable objects until the operator pushes the bundle commit.
 *
 * The CLI's internals are imported by relative path; the `@motebit/*`
 * packages are loaded through the CLI's own dependency graph (`fromCli`), so
 * the fixture runs exactly the builds `motebit repo-task run` runs.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import type { StreamingProvider } from "@motebit/ai-core";
import type { DelegationToken, StandingDelegation } from "@motebit/encryption";
import type { RepoChangeToolInvocationReceipt, RepoTaskScope } from "@motebit/sdk";
import type {
  RepoTaskAgent,
  RepoTaskAuthorityBundle,
  RepoTaskAuthorityCheck,
  RepoTaskPin,
  RepoTaskRunResult,
  RepoStagedEntry,
} from "@motebit/runtime";
import type { RepoChangeVerification } from "@motebit/verifier";
import type { IsolatedGit, RepoChangeInputs } from "@motebit/verify/git";

import { mkdirOwnerOnly } from "../apps/cli/src/durable-file.js";
import { loadActiveSigningKey, promptPassphrase } from "../apps/cli/src/identity.js";
import type { ActiveSigningKey, LoadActiveSigningKeyOptions } from "../apps/cli/src/identity.js";
import { VERSION } from "../apps/cli/src/config.js";
import type { FullConfig } from "../apps/cli/src/config.js";
import {
  agentKeyConfig,
  defaultConfigDirs,
  isDefaultConfigDir,
  readAgentIdentity,
} from "../apps/cli/src/repo-task/agent-identity.js";
import {
  buildRepoChangeRecord,
  bundlePath,
  commitBundle,
  repoChangeBundleBytes,
  repoTaskOutcome,
  signRepoChangeReceipt,
} from "../apps/cli/src/repo-task/bundle.js";
import type { HarnessCommit } from "../apps/cli/src/repo-task/bundle.js";
import { keySpellingFault, readDelegationDirectory } from "../apps/cli/src/repo-task/delegation.js";
import { createGitChangeStager } from "../apps/cli/src/repo-task/git-change-stager.js";
import { createGitTreeReader } from "../apps/cli/src/repo-task/git-tree-reader.js";
import {
  RepoTaskPreflightError,
  isGrantSpentAtTip,
  readTipState,
  worktreeDifferences,
} from "../apps/cli/src/repo-task/preflight.js";
import { createReceiptFileSink } from "../apps/cli/src/repo-task/receipt-file-sink.js";
import {
  DEFAULT_COMMIT_AUTHOR,
  isInsideRepository,
  parseCommitAuthor,
} from "../apps/cli/src/repo-task/run-command.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// -- The @motebit packages, from the CLI's own dependency graph ----------------

const cliRequire = createRequire(path.join(ROOT, "apps", "cli", "package.json"));

async function fromCli<T>(specifier: string): Promise<T> {
  return (await import(pathToFileURL(cliRequire.resolve(specifier)).href)) as T;
}

interface Modules {
  readonly runtime: typeof import("@motebit/runtime");
  readonly verifier: typeof import("@motebit/verifier");
  readonly git: typeof import("@motebit/verify/git");
  readonly crypto: typeof import("@motebit/crypto");
  readonly encryption: typeof import("@motebit/encryption");
  readonly syncEngine: typeof import("@motebit/sync-engine");
}

let loaded: Promise<Modules> | undefined;
function modules(): Promise<Modules> {
  loaded ??= (async () => ({
    runtime: await fromCli<Modules["runtime"]>("@motebit/runtime"),
    verifier: await fromCli<Modules["verifier"]>("@motebit/verifier"),
    git: await fromCli<Modules["git"]>("@motebit/verify/git"),
    crypto: await fromCli<Modules["crypto"]>("@motebit/crypto"),
    encryption: await fromCli<Modules["encryption"]>("@motebit/encryption"),
    syncEngine: await fromCli<Modules["syncEngine"]>("@motebit/sync-engine"),
  }))();
  return loaded;
}

// -- The cases ----------------------------------------------------------------

export const FIXTURE_CASES = ["b3", "b4", "b5a", "b5b", "b6"] as const;
export type FixtureCase = (typeof FIXTURE_CASES)[number];

/** The acceptance row each case produces (docs/proposals/governed-repo-change-v1.md). */
export const ACCEPTANCE_ROW: Readonly<Record<FixtureCase, string>> = {
  b3: "B3: a change touching a path outside allowed_paths",
  b4: "B4: a bundle signed by a key other than the grant's delegate",
  b5a: "B5a: the tick signature re-spelled in non-canonical base64url, re-signed by A",
  b5b: "B5b: a second PR on the current tip with a grant whose first bundle already landed",
  b6: "B6: a PR on the tip with a grant whose revocation landed",
};

/** Every departure from a real `motebit repo-task run`, per case; printed with the output. */
export const DEPARTURES: Readonly<Record<FixtureCase, readonly string[]>> = {
  b3: [
    "no model call: a scripted provider makes the edit (provider governed-change-fixture, model scripted)",
    "after the run, one path outside allowed_paths is staged past the run's write handler (which refuses it); no tool receipt covers it",
    "A signs the record and the receipt over the real entries, the out-of-scope one included",
  ],
  b4: [
    "no run: runRepoTask refuses an agent that is not the grant's delegate, so the scope's real tool handlers are invoked directly with the scripted edit (provider governed-change-fixture, model scripted)",
    "an ephemeral Ed25519 key, generated in memory and erased, signs every tool receipt and the receipt in A's place (A's motebit_id and device_id, the ephemeral public key); A's key is never unlocked",
  ],
  b5a: [
    "no model call: a scripted provider makes the edit (provider governed-change-fixture, model scripted)",
    "the run uses the tick as signed; the bundle and the record carry tick.signature re-spelled in non-canonical base64url (the same signature bytes), and A signs the record over it",
    "the acceptance row names B1's tick, but B1's grant is spent and expired: b5a needs a fresh, unexpired grant that never landed (G3)",
  ],
  b5b: [
    "no model call: a scripted provider makes the edit (provider governed-change-fixture, model scripted)",
    "the run is told spent: false (local only; the tip says the grant's bundle landed)",
    "the bundle commit modifies the landed bundle path (commitBundle refuses an existing path; a fixture-local commit on the same private-index stager makes it)",
  ],
  b6: [
    "no model call: a scripted provider makes the edit (provider governed-change-fixture, model scripted)",
    "the run is told the revocation set is empty (local only; the landed revocation stays in the repository)",
  ],
};

export const FIXTURE_PROVIDER = "governed-change-fixture";
export const FIXTURE_MODEL = "scripted";

/** The line the scripted edit appends to the scope's first allowed path. */
export function fixtureMarker(c: FixtureCase): string {
  return `Governed-change fixture ${c}: a deliberately failing acceptance test (${ACCEPTANCE_ROW[c].split(":")[0]}).\n`;
}

// -- Options, deps, report ------------------------------------------------------

export interface FixtureOptions {
  readonly case: FixtureCase;
  /** A's config directory (`--agent`). */
  readonly agentDir: string;
  /** The directory `motebit repo-task delegate` wrote (`--delegation`). */
  readonly delegationDir: string;
  /** The repository's worktree (`--repo`). */
  readonly repoDir: string;
  /** Where the receipt file goes (`--output`, default the delegation directory); never inside the repository. */
  readonly outputDir?: string;
  /** The git author and committer of both commits (`--author "Name <email>"`), as `repo-task run`. */
  readonly author?: string;
}

/** The process-touching calls; injected so tests watch the keys and the clock. */
export interface FixtureDeps {
  readonly loadActiveSigningKey: (
    config: FullConfig,
    options: LoadActiveSigningKeyOptions,
  ) => Promise<ActiveSigningKey>;
  readonly secureErase: (key: Uint8Array) => void;
  /** How A's passphrase is obtained (never the principal's session cache or keychain). */
  readonly getPassphrase: (label: string) => Promise<string>;
  /** b4's in-memory signer. */
  readonly ephemeralKeypair: () => Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }>;
  readonly defaultConfigDirs: () => string[];
  readonly now: () => number;
  readonly runtimeVersion: string;
}

export interface FixtureReport {
  readonly case: FixtureCase;
  readonly grantId: string;
  readonly parentCommit: string;
  readonly headCommit: string;
  readonly bundleCommit: string;
  readonly bundlePath: string;
  readonly receiptsFile: string;
  readonly status: "completed" | "failed" | "denied";
  readonly computed: RepoChangeInputs;
  readonly verification: RepoChangeVerification;
  readonly expected: ExpectedVerdict;
  readonly judgement: Judgement;
}

function refuse(...lines: string[]): never {
  throw new RepoTaskPreflightError(lines);
}

const ENCODER = new TextEncoder();
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// -- The expectation ------------------------------------------------------------

/** One expected failure: its code, and its detail exactly (or any detail when absent). */
export interface ExpectedFailure {
  readonly code: string;
  readonly detail?: string;
}

/** What the self-check must say, exactly, before the push command is printed. */
export interface ExpectedVerdict {
  readonly integrity: string;
  readonly identityBinding: string;
  readonly authority: string;
  readonly revocation: string;
  readonly outcome: string;
  readonly spent: boolean;
  readonly bundlePath: string;
  readonly changeCommit: string;
  /** Exactly these shape failures, in this order. */
  readonly shapeFailures: readonly string[];
  /** Exactly these failures, as a multiset. */
  readonly failures: readonly ExpectedFailure[];
}

/**
 * The verdict a case must produce: the valid change's on every axis but the
 * case's own. `toolReceipts` is the bundle's tool receipt count (b4 names
 * each one's signer); `outsidePath` is b3's out-of-scope path.
 */
export function expectedVerdict(
  c: FixtureCase,
  ctx: {
    readonly grantId: string;
    readonly changeCommit: string;
    readonly toolReceipts: number;
    readonly outsidePath?: string;
  },
): ExpectedVerdict {
  const target = bundlePath(ctx.grantId);
  const valid: ExpectedVerdict = {
    integrity: "verified",
    identityBinding: "pinned",
    authority: "valid",
    revocation: "fresh",
    outcome: "completed",
    spent: false,
    bundlePath: target,
    changeCommit: ctx.changeCommit,
    shapeFailures: [],
    failures: [],
  };
  switch (c) {
    case "b3":
      return {
        ...valid,
        authority: "insufficient",
        failures: [
          {
            code: "authority.repo_change.entry_path_not_allowed",
            detail: `${JSON.stringify(ctx.outsidePath)} is not an allowed path`,
          },
        ],
      };
    case "b4":
      return {
        ...valid,
        identityBinding: "invalid",
        failures: [
          {
            code: "identity.repo_change.signer_not_delegate",
            detail: "the execution receipt's signer is not the grant's delegate",
          },
          ...Array.from({ length: ctx.toolReceipts }, (_, i) => ({
            code: "identity.repo_change.signer_not_delegate",
            detail: `tool_receipts[${i}]'s signer is not the grant's delegate`,
          })),
        ],
      };
    case "b5a":
      return {
        ...valid,
        integrity: "invalid",
        failures: [
          {
            code: "integrity.repo_change.value_not_canonical",
            detail: "tick.signature is not canonical base64url",
          },
        ],
      };
    case "b5b": {
      // computeRepoChangeInputs's own shape failures for a PR that modifies
      // the landed bundle and adds none (spec §9, CI-on-PR row).
      const shapes = [
        "the pull request does not add exactly one regular file under .motebit/bundles/ (it adds 0)",
        `head_commit..bundle_commit is not exactly one A 100644 at ${target}`,
        `the pull request modifies or deletes ${JSON.stringify(target)}`,
      ];
      return {
        ...valid,
        integrity: "invalid",
        authority: "insufficient",
        spent: true,
        shapeFailures: shapes,
        failures: [
          ...shapes.map((detail) => ({ code: "integrity.repo_change.shape_check_failed", detail })),
          { code: "authority.repo_change.grant_spent" },
        ],
      };
    }
    case "b6":
      return {
        ...valid,
        revocation: "revoked",
        failures: [{ code: "revocation.repo_change.revoked" }],
      };
  }
}

export interface JudgementRow {
  readonly name: string;
  readonly expected: string;
  readonly actual: string;
  readonly ok: boolean;
}

export interface Judgement {
  /** Every row holds and the failures are exactly the expected multiset. */
  readonly matches: boolean;
  readonly rows: readonly JudgementRow[];
  /** Expected failures with no actual match. */
  readonly missing: readonly ExpectedFailure[];
  /** Actual failures no expected one accounts for. */
  readonly unexpected: readonly { code: string; detail: string }[];
}

/** Hold the self-check to the expectation, exactly. */
export function judge(
  expected: ExpectedVerdict,
  computed: RepoChangeInputs,
  verification: RepoChangeVerification,
): Judgement {
  const v = verification.verdict;
  const row = (name: string, want: string, got: string): JudgementRow => ({
    name,
    expected: want,
    actual: got,
    ok: want === got,
  });
  const rows: JudgementRow[] = [
    row("integrity", expected.integrity, v.integrity),
    row("identityBinding", expected.identityBinding, v.identityBinding),
    row("authority", expected.authority, v.authority),
    row("revocation", expected.revocation, v.revocation.status),
    row("outcome", expected.outcome, String(verification.outcome)),
    row("spent", String(expected.spent), String(computed.input.spent)),
    row("bundle", expected.bundlePath, String(computed.bundlePath)),
    row("change commit", expected.changeCommit, String(computed.changeCommit)),
    row(
      "shape failures",
      JSON.stringify(expected.shapeFailures),
      JSON.stringify(computed.shapeFailures),
    ),
  ];
  // The failures as a multiset: an exact-detail expectation first, then any-detail ones.
  const unexpected = verification.diagnostics.failures.map((f) => ({
    code: f.code as string,
    detail: f.detail,
  }));
  const missing: ExpectedFailure[] = [];
  const ordered = [
    ...expected.failures.filter((f) => f.detail !== undefined),
    ...expected.failures.filter((f) => f.detail === undefined),
  ];
  for (const want of ordered) {
    const i = unexpected.findIndex(
      (f) => f.code === want.code && (want.detail === undefined || f.detail === want.detail),
    );
    if (i < 0) missing.push(want);
    else unexpected.splice(i, 1);
  }
  const matches = rows.every((r) => r.ok) && missing.length === 0 && unexpected.length === 0;
  return { matches, rows, missing, unexpected };
}

/**
 * A second spelling of the same bytes: the last character of an unpadded
 * base64url string with its lowest unused bit set, or null when there is
 * none (no unused bits, or the bit is already set). The tick's signature is
 * canonical (the authority check holds it so), so a second spelling of its
 * bytes is non-canonical; the self-check confirms value_not_canonical.
 */
export function respellBase64Url(s: string): string | null {
  const last = s.at(-1);
  if (last === undefined || !BASE64URL.includes(last)) return null;
  const respelled = s.slice(0, -1) + BASE64URL[BASE64URL.indexOf(last) | 1];
  if (respelled === s) return null;
  if (!Buffer.from(respelled, "base64url").equals(Buffer.from(s, "base64url"))) return null;
  return respelled;
}

// -- The scripted provider --------------------------------------------------------

/** A scripted model: read the path, write the content, then answer. No model call. */
function scriptedProvider(target: string, content: string): StreamingProvider {
  const turns = [
    [{ id: "1", name: "repo_read_blob", args: { path: target } }],
    [{ id: "2", name: "repo_write_path", args: { path: target, content } }],
  ];
  let n = 0;
  const respond = () => {
    const calls = turns[n++];
    return calls
      ? { text: "", confidence: 1, memory_candidates: [], state_updates: {}, tool_calls: calls }
      : {
          text: "Done (scripted).",
          confidence: 1,
          memory_candidates: [],
          state_updates: {},
        };
  };
  const provider = {
    model: FIXTURE_MODEL,
    setModel: () => {},
    generate: async () => respond(),
    estimateConfidence: async () => 1,
    extractMemoryCandidates: async () => [],
    async *generateStream() {
      yield { type: "done" as const, response: respond() };
    },
  };
  return provider as unknown as StreamingProvider;
}

// -- The fixture ------------------------------------------------------------------

/** The authority check's failure codes, as a sorted set. */
function codesOf(check: RepoTaskAuthorityCheck): string[] {
  return check.ok ? [] : [...new Set(check.failures.map((f) => f.code as string))].sort();
}

function checkLines(check: RepoTaskAuthorityCheck): string[] {
  return check.ok ? [] : check.failures.map((f) => `  ${f.code}: ${f.detail}`);
}

/**
 * Make one negative fixture. Every refusal before the key is unlocked is a
 * `RepoTaskPreflightError` (nothing written); once a key is held it is erased
 * before anything propagates. Returns the commits and the self-check; the
 * caller prints the push command only when `judgement.matches`.
 */
export async function runGovernedChangeFixture(
  opts: FixtureOptions,
  deps: FixtureDeps,
): Promise<FixtureReport> {
  const m = await modules();
  const c = opts.case;
  if (!(FIXTURE_CASES as readonly string[]).includes(c)) {
    refuse(`--case must be one of ${FIXTURE_CASES.join(", ")}: ${JSON.stringify(c)}`);
  }

  // -- As `repo-task run`: the commit identity, A, the delegation, the tip, the output.
  let commitAuthor = DEFAULT_COMMIT_AUTHOR;
  if (opts.author !== undefined) {
    const parsed = parseCommitAuthor(opts.author);
    if (parsed === null) refuse(`--author must be "Name <email>": ${JSON.stringify(opts.author)}`);
    commitAuthor = parsed;
  }
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
  if (fault !== null) refuse(`--agent: device_public_key is not in its one spelling (${fault})`);
  const agentPin: RepoTaskPin = { motebit_id: agent.motebitId, public_key: agent.publicKeyHex };

  let scope: RepoTaskScope;
  let grant: StandingDelegation;
  let tick: DelegationToken;
  try {
    ({ scope, grant, tick } = readDelegationDirectory(opts.delegationDir));
  } catch (err) {
    refuse(err instanceof Error ? err.message : String(err));
  }
  if (!m.verifier.isRepoTaskScopeShape(scope)) {
    refuse("scope.json is not a repo-task scope of the strict shape");
  }
  if (!m.verifier.isRepoChangeGrantShape(grant)) {
    refuse("grant.json is not a grant of the strict shape");
  }
  if (!m.verifier.isRepoChangeTickShape(tick))
    refuse("tick.json is not a tick of the strict shape");

  const repoDir = path.resolve(opts.repoDir);
  let tipInfo: ReturnType<typeof m.git.resolveRepoTip>;
  try {
    tipInfo = m.git.resolveRepoTip(repoDir, scope.base_ref, scope.object_format);
  } catch (err) {
    if (err instanceof m.git.RepoTipError) refuse(err.message);
    throw err;
  }
  const { tip } = tipInfo;
  const outputDir = path.resolve(opts.outputDir ?? opts.delegationDir);
  const inside = isInsideRepository(outputDir, tipInfo);
  if (inside !== null) {
    refuse(
      `the output directory ${outputDir} is ${inside}: the fixture never writes the repository`,
    );
  }

  const git = await m.git.openIsolatedGit({
    gitEntry: tipInfo.gitEntry,
    objectFormat: scope.object_format,
  });
  try {
    const tree = await m.git.listTree(git, tip);
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

    // -- The honest authority (what a real run is told), then the case's departure.
    const honest: RepoTaskAuthorityBundle = {
      scope,
      grant,
      tick,
      revocations: tipState.revocations,
      principal,
      agents,
      expectedRepo: scope.repo,
      isPathPermitted: tipState.isPathPermitted,
      spent,
    };
    const preflightAt = deps.now();
    const honestCheck = await m.runtime.checkRepoTaskAuthority(honest, agentPin, preflightAt);
    const target = bundlePath(grant.grant_id);
    let told: RepoTaskAuthorityBundle = honest;
    if (c === "b5b" || c === "b6") {
      // The real law must fail on exactly the case's one rule: the departure
      // hides that rule, and only it, from the run.
      const want =
        c === "b5b" ? "authority.repo_change.grant_spent" : "revocation.repo_change.revoked";
      const got = codesOf(honestCheck);
      if (got.length !== 1 || got[0] !== want) {
        refuse(
          `--case ${c} needs a grant the tip ${c === "b5b" ? "records as spent (its bundle landed)" : "records as revoked (its revocation landed)"}, and nothing else wrong; a real run's authority check says:`,
          ...(honestCheck.ok ? ["  (it authorizes the run)"] : checkLines(honestCheck)),
        );
      }
      if (c === "b5b") {
        const landed = tree.find((e) => Buffer.from(e.path).toString("latin1") === target);
        if (landed === undefined || landed.mode !== "100644") {
          refuse(
            `--case b5b modifies the landed bundle, but ${target} is not a regular file at the tip`,
          );
        }
        told = { ...honest, spent: false };
      } else {
        told = {
          ...honest,
          revocations: { set: [], failures: [], readAt: honest.revocations.readAt },
        };
      }
    } else if (!honestCheck.ok) {
      refuse("the delegation does not authorize this run:", ...checkLines(honestCheck));
    }
    const check = await m.runtime.checkRepoTaskAuthority(told, agentPin, preflightAt);
    if (!check.ok) {
      refuse("the delegation does not authorize this run:", ...checkLines(check));
    }

    // -- The scripted edit: the scope's first allowed path, the case's marker appended.
    const reader = createGitTreeReader({ git, tip });
    const editPath = scope.allowed_paths[0]!;
    const atTip = await reader.lookup(editPath);
    if (atTip !== null && atTip.kind !== "blob") {
      refuse(`${editPath} is not a regular file at the tip`);
    }
    const before = atTip === null ? "" : Buffer.from(await reader.readBlob(atTip.oid)).toString();
    const content = `${before}${before === "" || before.endsWith("\n") ? "" : "\n"}${fixtureMarker(c)}`;

    // -- b3: the out-of-scope path, permitted by the policy so it is the only defect.
    let outsidePath: string | undefined;
    if (c === "b3") {
      if (scope.max_changed_files < 2) {
        refuse(
          `--case b3 adds one path to the scope's change, so it needs max_changed_files >= 2 (the scope says ${scope.max_changed_files}); otherwise entries_exceed_max is a second defect`,
        );
      }
      const dir = path.posix.dirname(editPath);
      const ext = path.posix.extname(editPath);
      outsidePath = `${dir === "." ? "" : `${dir}/`}governed-change-fixture-b3${ext}`;
      // Canonical by construction: the directory of a canonical allowed path
      // (the authority check passed, so it is canonical), a fixed ASCII name,
      // and the extension of a canonical segment (never ending in "."). A
      // path that were not would read value_not_canonical in the self-check,
      // and the verdict would not match.
      if (scope.allowed_paths.includes(outsidePath)) {
        refuse(`--case b3's out-of-scope path ${JSON.stringify(outsidePath)} is in allowed_paths`);
      }
      if (!tipState.isPathPermitted(outsidePath)) {
        refuse(
          `--case b3's out-of-scope path ${JSON.stringify(outsidePath)} fails the tip's path policy (entry_path_not_permitted would be a second defect)`,
        );
      }
      if ((await reader.lookup(outsidePath)) !== null) {
        refuse(
          `--case b3's out-of-scope path ${JSON.stringify(outsidePath)} is tracked at the tip: it must be an add`,
        );
      }
    }

    // -- b5a: the tick's signature, re-spelled: the same bytes, a second spelling.
    let bundleTick: DelegationToken = tick;
    if (c === "b5a") {
      const respelled = respellBase64Url(tick.signature);
      if (respelled === null) {
        refuse("--case b5a: the tick's signature has no second spelling of the same bytes");
      }
      bundleTick = { ...tick, signature: respelled };
    }

    // -- The run (or b4's hand-signed stand-in), the key held only inside.
    mkdirOwnerOnly(outputDir);
    const receiptsFile = path.join(
      outputDir,
      `fixture-${c}-receipts-${grant.grant_id}-${preflightAt}.jsonl`,
    );
    const sink = createReceiptFileSink(receiptsFile);
    const stager = createGitChangeStager({ git, tip });
    const commitAt = (message: string): HarnessCommit => ({
      message,
      ...commitAuthor,
      timestamp: Math.floor(deps.now() / 1000),
    });
    const record = async (
      run: RepoTaskRunResult,
      signer: RepoTaskAgent,
    ): Promise<{ headCommit: string; bytes: Uint8Array; status: FixtureReport["status"] }> => {
      if (outsidePath !== undefined) {
        // b3's defect: staged past the run's write handler.
        await stager.stage(outsidePath, ENCODER.encode(fixtureMarker(c)));
      }
      const { headCommit, entries } = await stager.buildChangeCommit(
        commitAt(`repo-task ${grant.grant_id}: governed-change fixture ${c}\n`),
      );
      const status = repoTaskOutcome(run.ended, entries);
      const changeRecord = await buildRepoChangeRecord({
        scope,
        grant,
        tick: bundleTick,
        parentCommit: tip,
        headCommit,
        entries,
        run,
      });
      const receipt = await signRepoChangeReceipt({
        run,
        record: changeRecord,
        status,
        agent: signer,
      });
      const bytes = repoChangeBundleBytes({
        scope,
        grant,
        tick: bundleTick,
        toolReceipts: run.tool_receipts as unknown as RepoChangeToolInvocationReceipt[],
        receipt,
      });
      return { headCommit, bytes, status };
    };
    let made: Awaited<ReturnType<typeof record>> & { toolReceipts: number };
    try {
      if (c === "b4") {
        const key = await deps.ephemeralKeypair();
        try {
          const signer: RepoTaskAgent = {
            motebitId: agent.motebitId,
            deviceId: agent.deviceId,
            privateKey: key.privateKey,
            publicKey: key.publicKey,
          };
          const run = await handSignedRun({
            m,
            authority: told,
            agentPin,
            signer,
            check,
            reader,
            stager,
            sink,
            editPath,
            content,
            runtimeVersion: deps.runtimeVersion,
            now: deps.now,
          });
          made = { ...(await record(run, signer)), toolReceipts: run.tool_receipts.length };
        } finally {
          deps.secureErase(key.privateKey);
        }
      } else {
        const active = await deps.loadActiveSigningKey(agentKeyConfig(agent), {
          promptLabel: "Agent passphrase: ",
          getPassphrase: deps.getPassphrase,
        });
        try {
          if (active.publicKey !== agent.publicKeyHex) {
            refuse("--agent: the decrypted key is not the config's device_public_key");
          }
          const signer: RepoTaskAgent = {
            motebitId: agent.motebitId,
            deviceId: agent.deviceId,
            privateKey: active.privateKey,
            publicKey: Buffer.from(active.publicKey, "hex"),
          };
          let run: RepoTaskRunResult;
          try {
            run = await m.runtime.runRepoTask({
              authority: told,
              agent: signer,
              provider: scriptedProvider(editPath, content),
              providerName: FIXTURE_PROVIDER,
              reader,
              stager,
              receipts: sink,
              runtimeVersion: deps.runtimeVersion,
              clock: deps.now,
            });
          } catch (err) {
            if (err instanceof m.runtime.RepoTaskRefusedError) {
              refuse(
                "the run refused to start:",
                ...err.failures.map((f) => `  ${f.code}: ${f.detail}`),
              );
            }
            throw err;
          }
          if (
            run.ended !== "model_done" ||
            run.written_paths.length !== 1 ||
            run.written_paths[0] !== editPath
          ) {
            refuse(
              `the scripted run did not make its edit (ended ${run.ended}, wrote ${JSON.stringify(run.written_paths)})`,
            );
          }
          made = { ...(await record(run, signer)), toolReceipts: run.tool_receipts.length };
        } finally {
          deps.secureErase(active.privateKey);
        }
      }
    } finally {
      await sink.close();
    }

    // -- The bundle commit: exactly one add, or (b5b) the modify of the landed bundle.
    const bundleMessage = `repo-task ${grant.grant_id}: bundle (governed-change fixture ${c})\n`;
    const bundleCommit =
      c === "b5b"
        ? await commitBundleOverLanded(
            git,
            made.headCommit,
            target,
            made.bytes,
            commitAt(bundleMessage),
          )
        : await commitBundle(
            git,
            made.headCommit,
            grant.grant_id,
            made.bytes,
            commitAt(bundleMessage),
          );

    // -- The self-check, as `repo-task run`'s: CI-on-PR mode, base = the tip,
    // head = the bundle commit, the run's clock. Evidence, never authority.
    const computed = await m.git.computeRepoChangeInputs({
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
    const verification = await m.verifier.verifyRepoChange(computed.input);
    const expected = expectedVerdict(c, {
      grantId: grant.grant_id,
      changeCommit: made.headCommit,
      toolReceipts: made.toolReceipts,
      ...(outsidePath !== undefined ? { outsidePath } : {}),
    });
    return {
      case: c,
      grantId: grant.grant_id,
      parentCommit: tip,
      headCommit: made.headCommit,
      bundleCommit,
      bundlePath: target,
      receiptsFile,
      status: made.status,
      computed,
      verification,
      expected,
      judgement: judge(expected, computed, verification),
    };
  } finally {
    git.close();
  }
}

/**
 * b4: what `runRepoTask` would record for the scripted edit, signed by the
 * ephemeral key in A's place (runRepoTask refuses that signer). The scope's
 * own handlers do the read and the write (the same reader and stager), the
 * system prompt is the run's pure function of (scope, tools, runtime
 * version, model), and each receipt carries the fields runRepoTask signs.
 */
async function handSignedRun(i: {
  readonly m: Modules;
  readonly authority: RepoTaskAuthorityBundle;
  readonly agentPin: RepoTaskPin;
  readonly signer: RepoTaskAgent;
  readonly check: RepoTaskAuthorityCheck & { ok: true };
  readonly reader: ReturnType<typeof createGitTreeReader>;
  readonly stager: ReturnType<typeof createGitChangeStager>;
  readonly sink: ReturnType<typeof createReceiptFileSink>;
  readonly editPath: string;
  readonly content: string;
  readonly runtimeVersion: string;
  readonly now: () => number;
}): Promise<RepoTaskRunResult> {
  const { runtime, crypto } = i.m;
  const { scope, tick } = i.authority;
  const { registry } = runtime.buildRepoTaskTools(i.check.tools, scope, {
    reader: i.reader,
    stager: i.stager,
    authorize: async () =>
      (await runtime.checkRepoTaskAuthority(i.authority, i.agentPin, i.now())).ok,
  });
  const toolNames = registry.entries.map(
    (e) => e.definition.name,
  ) as RepoTaskRunResult["tools_used"][number][];
  const systemPrompt = runtime.repoTaskSystemPrompt(
    runtime.buildRepoTaskPack({
      scope,
      tools: registry.entries.map((e) => e.definition),
      frame: runtime.repoTaskFrame(scope, toolNames, i.runtimeVersion),
      history: [],
      first: true,
    }),
    FIXTURE_MODEL,
  );
  const taskId = randomUUID();
  const submittedAt = i.now();
  const calls: { name: string; args: Record<string, unknown> }[] = [
    { name: "repo_read_blob", args: { path: i.editPath } },
    { name: "repo_write_path", args: { path: i.editPath, content: i.content } },
  ];
  const receipts: RepoTaskRunResult["tool_receipts"][number][] = [];
  const used = new Set<string>();
  for (const call of calls) {
    const entry = registry.entries.find((e) => e.definition.name === call.name);
    if (entry === undefined) refuse(`--case b4: the tick does not grant ${call.name}`);
    const startedAt = i.now();
    const outcome = await entry.handler.invoke(call.args);
    if (outcome.status !== "completed") {
      refuse(`--case b4: the scripted ${call.name} did not complete (${outcome.status})`);
    }
    used.add(call.name);
    const visible = outcome.result.ok
      ? (outcome.result.data ?? null)
      : (outcome.result.error ?? null);
    const receipt = await crypto.signToolInvocationReceipt(
      {
        invocation_id: randomUUID(),
        task_id: taskId,
        motebit_id: i.signer.motebitId,
        device_id: i.signer.deviceId,
        tool_name: call.name,
        started_at: startedAt,
        completed_at: i.now(),
        status: outcome.status,
        args_hash: await crypto.hashToolPayload(call.args),
        result_hash: await crypto.hashToolPayload(visible),
        invocation_origin: "ai-loop",
      },
      i.signer.privateKey,
      i.signer.publicKey,
    );
    await i.sink.append(receipt);
    receipts.push(receipt);
  }
  return {
    task_id: taskId,
    ended: "model_done",
    tool_receipts: receipts,
    tools_used: toolNames.filter((t) => used.has(t)),
    delegated_scope: tick.scope,
    memories_formed: 0,
    prompt_hash: await crypto.hash(ENCODER.encode(scope.task)),
    system_prompt: systemPrompt,
    system_prompt_digest: {
      algorithm: "sha-256",
      value: await crypto.hash(ENCODER.encode(systemPrompt)),
    },
    written_paths: [i.editPath],
    response: "",
    provider: FIXTURE_PROVIDER,
    model: FIXTURE_MODEL,
    runtime_version: i.runtimeVersion,
    submitted_at: submittedAt,
    completed_at: i.now(),
    tool_failures: [],
  };
}

/**
 * b5b's bundle commit: one commit on `head` that MODIFIES the landed bundle
 * at `target` (a 100644 file there), on the same private-index stager as
 * `commitBundle`, whose refusal of an existing path stays as it is. The
 * stager's postcondition admits only an add or a modify of a 100644 file,
 * and the commit must be exactly that one modify.
 */
export async function commitBundleOverLanded(
  git: IsolatedGit,
  head: string,
  target: string,
  bytes: Uint8Array,
  commit: HarnessCommit,
): Promise<string> {
  const m = await modules();
  const landed = (await m.git.listTree(git, head)).find(
    (e) => Buffer.from(e.path).toString("latin1") === target,
  );
  if (landed === undefined || landed.mode !== "100644") {
    throw new Error(`${target} is not a regular file at the change commit`);
  }
  const stager = createGitChangeStager({ git, tip: head });
  await stager.stage(target, bytes);
  const { headCommit, entries } = await stager.buildChangeCommit(commit);
  const only: RepoStagedEntry | undefined = entries[0];
  if (
    entries.length !== 1 ||
    only === undefined ||
    only.path !== target ||
    only.mode !== "100644" ||
    only.blob === landed.oid
  ) {
    throw new Error("the bundle commit would not be exactly one modify of the landed bundle");
  }
  return headCommit;
}

// -- The command ------------------------------------------------------------------

export interface FixtureCommandDeps extends FixtureDeps {
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
  readonly exit: (code: number) => never;
}

export const USAGE =
  'Usage: npx tsx scripts/governed-change-fixture.ts --case b3|b4|b5a|b5b|b6 --agent <dir> --delegation <dir> [--repo <worktree>] [--author "Name <email>"] [--output <dir>]';

/** Parse, run, print; exit 1 on a refusal or on a verdict that is not the case's. */
export async function governedChangeFixtureCommand(
  argv: readonly string[],
  deps: FixtureCommandDeps,
): Promise<void> {
  let values: Record<string, string | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        case: { type: "string" },
        agent: { type: "string" },
        delegation: { type: "string" },
        repo: { type: "string" },
        author: { type: "string" },
        output: { type: "string" },
      },
    }));
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    deps.error(USAGE);
    deps.exit(1);
  }
  const { case: c, agent, delegation } = values;
  if (c === undefined || agent === undefined || delegation === undefined) {
    deps.error(USAGE);
    deps.exit(1);
  }
  const { syncEngine, git: verifyGit } = await modules();
  const clean = (text: string): string => syncEngine.sanitizeRelayText(text, 1000);
  deps.log(
    "Before a live run, rebuild the verifier the fixture judges with (it loads the built dist): pnpm --filter @motebit/verifier --filter @motebit/verify build",
  );
  let report: FixtureReport;
  try {
    report = await runGovernedChangeFixture(
      {
        case: c as FixtureCase,
        agentDir: agent,
        delegationDir: delegation,
        repoDir: values.repo ?? process.cwd(),
        ...(values.output !== undefined ? { outputDir: values.output } : {}),
        ...(values.author !== undefined ? { author: values.author } : {}),
      },
      deps,
    );
  } catch (err) {
    if (err instanceof RepoTaskPreflightError) {
      deps.error("Refused — no bundle was made, nothing was pushed:");
      for (const r of err.refusals) {
        for (const line of r.split("\n")) deps.error(`  ${clean(line)}`);
      }
      deps.exit(1);
    }
    throw err;
  }
  const log = deps.log;
  log(`Governed-change fixture ${report.case} (${ACCEPTANCE_ROW[report.case]})`);
  log(`Repo task ${report.grantId}: ${report.status}`);
  log(`  parent_commit  ${report.parentCommit}`);
  log(`  head_commit    ${report.headCommit}`);
  log(`  bundle_commit  ${report.bundleCommit}`);
  log(`  bundle         ${report.bundlePath}`);
  log(`  receipts       ${report.receiptsFile}`);
  log("");
  log("Departures from a real `motebit repo-task run`:");
  for (const d of DEPARTURES[report.case]) log(`  - ${d}`);
  log("");
  log("Self-check (verifyRepoChange, CI-on-PR mode), expected vs actual:");
  for (const r of report.judgement.rows) {
    log(
      `  ${r.ok ? "ok  " : "DIFF"} ${r.name.padEnd(16)} expected ${r.expected}; actual ${r.actual}`,
    );
  }
  log("  failures (actual):");
  for (const f of report.verification.diagnostics.failures) {
    log(`    ${f.code}: ${clean(f.detail)}`);
  }
  for (const f of report.judgement.missing) {
    log(
      `  DIFF expected and missing: ${f.code}${f.detail !== undefined ? `: ${clean(f.detail)}` : ""}`,
    );
  }
  for (const f of report.judgement.unexpected) {
    log(`  DIFF not expected: ${f.code}: ${clean(f.detail)}`);
  }
  if (!report.judgement.matches) {
    deps.error(
      `The verdict is not exactly ${report.case}'s expectation, so this is not the acceptance test it names: no push command. Nothing was published: the commits are unreachable objects (no ref names them) and git's garbage collection removes them.`,
    );
    deps.exit(1);
  }
  log("");
  log(
    `The verdict is exactly ${report.case}'s expectation. No ref was created or moved and nothing was pushed.`,
  );
  log(
    "To publish this deliberately failing change (record its verdict, then close the pull request), the operator pushes the bundle commit as a new branch:",
  );
  log(
    `  - the pull request must be opened by ${verifyGit.REPO_CHANGE_PUBLISHER} (another author adds a shape failure);`,
  );
  log(
    `  - its base must be main and main's tip must still be ${report.parentCommit} when CI runs (a moved tip adds shape failures, and the verdict is no longer this one).`,
  );
  log("");
  log(
    `  git push <publisher-remote> ${report.bundleCommit}:refs/heads/repo-task/${report.grantId}-${report.case}`,
  );
}

/** A's passphrase, as `repo-task run`'s (apps/cli/src/subcommands/repo-task.ts `agentPassphrase`). */
async function agentPassphrase(label: string): Promise<string> {
  const env = process.env["MOTEBIT_AGENT_PASSPHRASE"];
  if (env != null && env !== "") return env;
  return promptPassphrase(label);
}

export async function nodeFixtureDeps(): Promise<FixtureCommandDeps> {
  const { crypto, encryption } = await modules();
  return {
    loadActiveSigningKey: (cfg, o) => loadActiveSigningKey(cfg, o),
    secureErase: (key) => encryption.secureErase(key),
    getPassphrase: agentPassphrase,
    ephemeralKeypair: () => crypto.generateKeypair(),
    defaultConfigDirs: () => defaultConfigDirs(),
    now: () => Date.now(),
    runtimeVersion: `motebit ${VERSION}`,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    exit: (code) => process.exit(code),
  };
}

const invoked = process.argv[1] !== undefined && path.resolve(process.argv[1]);
if (invoked === fileURLToPath(import.meta.url)) {
  void (async () => {
    await governedChangeFixtureCommand(process.argv.slice(2), await nodeFixtureDeps());
  })().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
}
