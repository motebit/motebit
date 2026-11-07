/**
 * `motebit repo-task delegate` and `motebit repo-task revoke` — the principal's
 * side of a governed repo change (docs/proposals/governed-repo-change-v1.md,
 * "Build order" step 3) — and `motebit repo-task run`, the agent's side
 * (build step 4; the orchestration is `../repo-task/run-command.ts`).
 *
 * The shell around `../repo-task/delegation.ts`: parse the flags, read the
 * delegate's identity file, unlock the principal's key the way `motebit grant`
 * does (`loadActiveSigningKey`, erased after use), and hand everything to the
 * mint, which self-checks with the run's authority law before a byte is
 * written. A sibling of `motebit grant`, never an extension of its money path.
 * Never prints key material, and erases the key before any exit: every
 * refusal that needs no key (flags, the delegate's identity, the verifier's
 * own scope predicates) is decided BEFORE the passphrase prompt; a refusal
 * after it propagates only once the key is erased.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { secureErase } from "@motebit/encryption";
import type { RepoTaskPin } from "@motebit/runtime";
import { REPO_TASK_BASE_REF } from "@motebit/sdk";
import { sanitizeRelayText } from "@motebit/sync-engine";

import type { CliConfig } from "../args.js";
import { VERSION, loadFullConfig } from "../config.js";
import { loadActiveSigningKey, promptPassphrase } from "../identity.js";
import type { ActiveSigningKey } from "../identity.js";
import type { FullConfig } from "../config.js";
import { createProvider } from "../runtime-factory.js";
import { defaultConfigDirs } from "../repo-task/agent-identity.js";
import { RepoTaskPreflightError, pinFromIdentityFile } from "../repo-task/preflight.js";
import { runGovernedRepoTask } from "../repo-task/run-command.js";
import type { RepoTaskRunDeps, RepoTaskRunReport } from "../repo-task/run-command.js";
import type { RevocationTarget } from "../repo-task/delegation.js";
import {
  DELEGATION_FILES,
  RepoTaskDelegationRefusedError,
  delegateToDirectory,
  CanonicalFileExistsError,
  grantIdRefusals,
  keySpellingFault,
  grantRefusals,
  precheckRepoTaskDelegation,
  readGrantFile,
  revokeToDirectory,
} from "../repo-task/delegation.js";

const HOUR_MS = 3_600_000;
const DEFAULT_TOOLS = "repo_read_blob,repo_write_path";

const DELEGATE_USAGE =
  "Usage: motebit repo-task delegate --repo <owner/name> --path <path> [--path <path> ...] (--task <text> | --task-file <file>) --delegate <agent motebit.md> [--hours 24] [--max-files <n>] [--not-before <iso|ms>] [--object-format sha1] [--scope repo_read_blob,repo_write_path] [--output <dir>]";
const REVOKE_USAGE =
  "Usage: motebit repo-task revoke <grant_id | grant.json | its directory> [--output <dir>]";

/** A refusal the command prints and exits 1 on; thrown, so `finally` blocks run first. */
export class RepoTaskCliRefusal extends Error {
  constructor(readonly text: string) {
    super(text);
    this.name = "RepoTaskCliRefusal";
  }
}

function refuse(text: string): never {
  throw new RepoTaskCliRefusal(text);
}

/** The process-touching calls a handler makes; injected so tests can watch the key's lifetime. */
export interface RepoTaskCommandDeps {
  readonly loadFullConfig: () => FullConfig;
  readonly loadActiveSigningKey: (
    config: FullConfig,
    options: { promptLabel: string },
  ) => Promise<ActiveSigningKey>;
  readonly secureErase: (key: Uint8Array) => void;
  readonly readAgentPin: (file: string) => Promise<RepoTaskPin>;
  /** The signing operations, run while the key is held. */
  readonly delegateToDirectory: typeof delegateToDirectory;
  readonly revokeToDirectory: typeof revokeToDirectory;
  readonly exit: (code: number) => never;
  readonly now: () => number;
}

// Each binding is read at call time, never at module load, so a test that
// mocks one of these modules without it still loads this one.
const NODE_DEPS: RepoTaskCommandDeps = {
  loadFullConfig: () => loadFullConfig(),
  loadActiveSigningKey: (config, options) => loadActiveSigningKey(config, options),
  secureErase: (key) => secureErase(key),
  readAgentPin: (file) => readAgentPin(file),
  delegateToDirectory: (req, dir) => delegateToDirectory(req, dir),
  revokeToDirectory: (input, dir) => revokeToDirectory(input, dir),
  exit: (code) => process.exit(code),
  now: () => Date.now(),
};

/** Run a handler body; a refusal is printed sanitized (it may carry file names) and exits 1. */
async function runCommand(
  deps: Pick<RepoTaskCommandDeps, "exit">,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (err) {
    if (!(err instanceof RepoTaskCliRefusal)) throw err;
    for (const line of err.text.split("\n")) console.error(sanitizeRelayText(line, 1000));
    deps.exit(1);
  }
}

function refusalText(head: string, err: RepoTaskDelegationRefusedError): string {
  return [head, ...err.failures.map((f) => `  ${f.code}: ${f.detail}`)].join("\n");
}

/**
 * Hold the principal's key for `use` and erase it on every path — the
 * outcome is computed inside, the key erased in `finally`, and only then does
 * a refusal propagate toward the exit.
 */
async function withPrincipalKey<T>(
  deps: RepoTaskCommandDeps,
  fullConfig: FullConfig,
  use: (key: ActiveSigningKey) => Promise<T>,
): Promise<T> {
  const active = await deps.loadActiveSigningKey(fullConfig, { promptLabel: "Passphrase: " });
  try {
    return await use(active);
  } catch (err) {
    if (err instanceof RepoTaskDelegationRefusedError) {
      throw new RepoTaskCliRefusal(refusalText("Refused, nothing written:", err));
    }
    if (err instanceof CanonicalFileExistsError) {
      throw new RepoTaskCliRefusal(`Refused, nothing overwritten: ${err.file} already exists.`);
    }
    throw err;
  } finally {
    deps.secureErase(active.privateKey);
  }
}

/**
 * The configured principal, refused up front unless its key is in its one
 * spelling: every comparison against it (the grant's delegator key, the
 * revocation's) is byte-exact, while the key loader compares case-blind and
 * returns the derived lowercase key — so an uppercase config key would make a
 * grant unrevocable. Judged before any mint or prompt.
 */
async function requirePrincipal(fullConfig: FullConfig): Promise<RepoTaskPin> {
  const motebitId = fullConfig.motebit_id;
  const publicKey = fullConfig.device_public_key;
  if (motebitId == null || motebitId === "" || publicKey == null || publicKey === "") {
    refuse("No motebit identity configured — run `motebit init` first.");
  }
  const fault = await keySpellingFault(publicKey);
  if (fault !== null) {
    refuse(
      `Refused — device_public_key in this motebit's config.json is not in its one spelling (${fault}). Rewrite it as the 64 lowercase hex characters of the same key, then retry.`,
    );
  }
  return { motebit_id: motebitId, public_key: publicKey };
}

/** Advisory, before the prompt: refuse when an output file already exists (exclusive create stays the guard). */
function refuseExisting(files: readonly string[]): void {
  const existing = files.filter((f) => fs.existsSync(f));
  if (existing.length > 0) {
    refuse(
      [`Refused, nothing overwritten — already exists:`, ...existing.map((f) => `  ${f}`)].join(
        "\n",
      ),
    );
  }
}

// === motebit repo-task delegate =======================================

export function handleRepoTaskDelegate(
  config: CliConfig,
  deps: RepoTaskCommandDeps = NODE_DEPS,
): Promise<void> {
  return runCommand(deps, async () => {
    const paths = config.paths ?? [];
    if (config.repo === undefined || config.delegateIdentity === undefined || paths.length === 0) {
      refuse(DELEGATE_USAGE);
    }
    const task = readTask(config);
    const lifetimeMs = parseLifetimeHours(config.hours);
    const notBefore = parseNotBefore(config.notBefore);
    const maxChangedFiles = parseMaxFiles(config.maxFiles, paths.length);

    const fullConfig = deps.loadFullConfig();
    const principalPin = await requirePrincipal(fullConfig);
    let delegate: RepoTaskPin;
    try {
      delegate = await deps.readAgentPin(config.delegateIdentity);
    } catch (err) {
      refuse(err instanceof Error ? err.message : String(err));
    }
    const request = {
      delegate,
      repo: config.repo,
      baseRef: config.baseRef ?? REPO_TASK_BASE_REF,
      objectFormat: config.objectFormat ?? "sha1",
      allowedPaths: paths,
      maxChangedFiles,
      task,
      tools: config.scope ?? DEFAULT_TOOLS,
      lifetimeMs,
      ...(notBefore !== undefined ? { notBefore } : {}),
      now: deps.now(),
    };
    // Every refusal that needs no key, before the passphrase prompt.
    if (config.output !== undefined) {
      refuseExisting(Object.values(DELEGATION_FILES).map((n) => path.join(config.output!, n)));
    }
    const pre = await precheckRepoTaskDelegation(request, principalPin);
    if (pre.length > 0) {
      refuse(
        ["Refused before signing — this delegation could not verify:"]
          .concat(pre.map((f) => `  ${f.code}: ${f.detail}`))
          .join("\n"),
      );
    }

    const result = await withPrincipalKey(deps, fullConfig, (active) =>
      deps.delegateToDirectory(
        {
          ...request,
          principal: {
            motebitId: principalPin.motebit_id,
            publicKeyHex: active.publicKey,
            privateKey: active.privateKey,
          },
        },
        (grantId) => config.output ?? path.resolve(`repo-task-${grantId}`),
      ),
    );

    const { grant, scope } = result.delegation;
    console.log(`Delegation signed: ${grant.grant_id}`);
    for (const file of result.files) console.log(`  wrote  ${file}`);
    console.log(`  repo      ${scope.repo} (${scope.base_ref}, ${scope.object_format})`);
    console.log(
      `  paths     ${scope.allowed_paths.join(", ")} (at most ${scope.max_changed_files})`,
    );
    console.log(`  tools     ${grant.scope}`);
    console.log(`  from      ${grant.delegator_id} (principal)`);
    console.log(`  to        ${grant.delegate_id} (agent)`);
    if (grant.not_before !== null) {
      console.log(`  active    ${new Date(grant.not_before).toISOString()}`);
    }
    console.log(`  expires   ${new Date(grant.expires_at).toISOString()}`);
    console.log("");
    console.log("One grant backs one landing. Hand the directory to the agent's machine,");
    console.log("and keep a copy of grant.json. Revoking needs only the grant_id:");
    console.log("");
    console.log(`  motebit repo-task revoke ${grant.grant_id}`);
  });
}

// === motebit repo-task revoke =========================================

/** What a revoke argument names: a grant file, or a bare grant_id (no files needed). */
export type RevokeArgument =
  | { readonly kind: "grant-file"; readonly file: string }
  | { readonly kind: "grant-id"; readonly grantId: string };

/**
 * A revoke argument: an existing directory (its `grant.json`), an existing
 * file named `grant.json`, or anything else as a grant_id. A file of another
 * name is refused rather than guessed at. Only `grant.json` is ever read —
 * never the scope or the tick: a revocation binds by `grant_id` and the
 * grant's delegator key alone (standing-delegation-v1 §5).
 */
export async function resolveRevokeArgument(arg: string): Promise<RevokeArgument> {
  const isGrantId = async (): Promise<boolean> => (await grantIdRefusals(arg)).length === 0;
  if (fs.existsSync(arg)) {
    if (fs.statSync(arg).isDirectory()) {
      const file = path.join(arg, DELEGATION_FILES.grant);
      if (fs.existsSync(file)) return { kind: "grant-file", file };
      // A directory that happens to carry a grant_id's name, holding no grant.
      if (await isGrantId()) return { kind: "grant-id", grantId: arg };
      throw new RepoTaskCliRefusal(`${arg} holds no ${DELEGATION_FILES.grant}`);
    }
    if (path.basename(arg) === DELEGATION_FILES.grant) return { kind: "grant-file", file: arg };
    throw new RepoTaskCliRefusal(
      `${arg} is not a ${DELEGATION_FILES.grant} — name the grant file, its directory, or the grant_id`,
    );
  }
  return { kind: "grant-id", grantId: arg };
}

export function handleRepoTaskRevoke(
  config: CliConfig,
  deps: RepoTaskCommandDeps = NODE_DEPS,
): Promise<void> {
  return runCommand(deps, async () => {
    const arg = config.positionals[2];
    if (arg == null || arg === "") refuse(REVOKE_USAGE);
    const fullConfig = deps.loadFullConfig();
    const principalPin = await requirePrincipal(fullConfig);

    // Everything below needs no key, and is decided before the passphrase prompt.
    const what = await resolveRevokeArgument(arg);
    let target: RevocationTarget;
    let outDir: string;
    if (what.kind === "grant-id") {
      // A revocation under the principal's key binds only grants that key
      // signed, so no grant file is needed.
      const pre = await grantIdRefusals(what.grantId);
      if (pre.length > 0) {
        refuse(
          [`Refused — ${arg} is neither a grant file, its directory, nor a grant_id:`]
            .concat(pre.map((f) => `  ${f.detail}`))
            .join("\n"),
        );
      }
      // The target key is the loaded key's derived public key, filled once
      // the key is held — never the config string.
      target = {
        grant_id: what.grantId,
        delegator_id: principalPin.motebit_id,
        delegator_public_key: "",
      };
      outDir = config.output ?? process.cwd();
    } else {
      let grant: unknown;
      try {
        grant = readGrantFile(what.file);
      } catch (err) {
        refuse(err instanceof Error ? err.message : String(err));
      }
      const pre = await grantRefusals(grant, principalPin);
      if (pre.length > 0) {
        refuse(
          [`Refused — ${what.file} cannot be revoked by this motebit:`]
            .concat(pre.map((f) => `  ${f.code}: ${f.detail}`))
            .join("\n"),
        );
      }
      target = grant as RevocationTarget;
      outDir = config.output ?? path.dirname(what.file);
    }

    refuseExisting([path.join(outDir, `${target.grant_id}.json`)]);

    const { file } = await withPrincipalKey(deps, fullConfig, (active) =>
      deps.revokeToDirectory(
        {
          target: {
            grant_id: target.grant_id,
            delegator_id: target.delegator_id,
            delegator_public_key:
              what.kind === "grant-id" ? active.publicKey : target.delegator_public_key,
          },
          principal: {
            motebitId: principalPin.motebit_id,
            publicKeyHex: active.publicKey,
            privateKey: active.privateKey,
          },
          now: deps.now(),
        },
        outDir,
      ),
    );

    console.log(`Revocation signed: ${target.grant_id}`);
    console.log(`  wrote  ${file}`);
    if (what.kind === "grant-id") {
      console.log(
        "  note   it binds only a grant with exactly this grant_id signed by the current key — check the id against what `motebit repo-task delegate` printed",
      );
    }
    console.log("");
    console.log(
      `It counts from the commit that lands it on main: .motebit/revocations/${target.grant_id}.json (a founder-approved PR).`,
    );
  });
}

/** A positive number of hours, as whole milliseconds. Range is the self-check's. */
export function parseLifetimeHours(value: string | undefined): number {
  if (value === undefined) return 24 * HOUR_MS;
  const ms = Number(value) * HOUR_MS;
  if (!/^\d+(\.\d+)?$/.test(value) || !Number.isSafeInteger(ms) || ms <= 0) {
    refuse(
      `--hours must be a positive number of hours that is a whole number of ms (got "${value}")`,
    );
  }
  return ms;
}

/** `--not-before`: Unix ms, or an ISO 8601 time. */
export function parseNotBefore(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isSafeInteger(ms)) {
    refuse(`--not-before must be Unix milliseconds or an ISO 8601 time (got "${value}")`);
  }
  return ms;
}

function parseMaxFiles(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n)) {
    refuse(`--max-files must be a whole number (got "${value}")`);
  }
  return n;
}

/** The task text, exactly: from `--task`, or a file decoded as strict UTF-8. */
function readTask(config: CliConfig): string {
  if ((config.task === undefined) === (config.taskFile === undefined)) {
    refuse(`Give exactly one of --task and --task-file.\n${DELEGATE_USAGE}`);
  }
  if (config.task !== undefined) return config.task;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(config.taskFile!));
  } catch (err) {
    refuse(`--task-file: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The agent's pin from its identity file: the verified `(motebit_id, public_key)` pair. */
export async function readAgentPin(file: string): Promise<RepoTaskPin> {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`--delegate: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  return pinFromIdentityFile(content, `--delegate: ${file}`);
}

// === motebit repo-task run ============================================

const RUN_USAGE =
  'Usage: motebit repo-task run --agent <agent config dir> --delegation <dir> [--repo <worktree>] [--provider <p>] [--model <m>] [--output <dir>] [--author "Name <email>"]';

/** The providers a run may use: a vendor or a local server, keyed from the environment; never the motebit cloud (it authenticates with an identity). */
const RUN_PROVIDERS: readonly CliConfig["provider"][] = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "groq",
  "local-server",
];

/** A's passphrase: `MOTEBIT_AGENT_PASSPHRASE`, else a prompt — never the principal's session cache or keychain. */
async function agentPassphrase(label: string): Promise<string> {
  const env = process.env["MOTEBIT_AGENT_PASSPHRASE"];
  if (env != null && env !== "") return env;
  return promptPassphrase(label);
}

/** The process-touching calls `repo-task run` makes. */
export interface RepoTaskRunCommandDeps extends RepoTaskRunDeps {
  readonly exit: (code: number) => never;
  readonly log: (line: string) => void;
}

function nodeRunDeps(config: CliConfig): RepoTaskRunCommandDeps {
  return {
    loadActiveSigningKey: (c, o) => loadActiveSigningKey(c, o),
    secureErase: (key) => secureErase(key),
    // Flags only: `createProvider` reads the --provider/--model flags and the
    // provider's API-key environment variable, with the default personality.
    createProvider: () => createProvider(config),
    getPassphrase: agentPassphrase,
    defaultConfigDirs: () => defaultConfigDirs(),
    now: () => Date.now(),
    runtimeVersion: `motebit ${VERSION}`,
    exit: (code) => process.exit(code),
    log: (line) => console.log(line),
  };
}

export function handleRepoTaskRun(
  config: CliConfig,
  deps: RepoTaskRunCommandDeps = nodeRunDeps(config),
): Promise<void> {
  return runCommand(deps, async () => {
    const agentDir = config.agent;
    const delegationDir = config.delegation;
    if (agentDir === undefined || delegationDir === undefined) refuse(RUN_USAGE);
    if (!RUN_PROVIDERS.includes(config.provider)) {
      refuse(
        `--provider ${config.provider} is not available to a repo task: use one of ${RUN_PROVIDERS.join(", ")}`,
      );
    }
    let report: RepoTaskRunReport;
    try {
      report = await runGovernedRepoTask(
        {
          agentDir,
          delegationDir,
          repoDir: config.repo ?? process.cwd(),
          ...(config.output !== undefined ? { outputDir: config.output } : {}),
          ...(config.author !== undefined ? { author: config.author } : {}),
          providerName: config.provider,
        },
        deps,
      );
    } catch (err) {
      if (err instanceof RepoTaskPreflightError) {
        refuse(
          [
            "Refused before the first model call — nothing ran:",
            ...err.refusals.map((r) => `  ${r}`),
          ].join("\n"),
        );
      }
      throw err;
    }
    const { verification: v } = report;
    const log = deps.log;
    log(`Repo task ${report.grantId}: ${report.status} (${report.run.ended})`);
    log(`  parent_commit  ${report.parentCommit}`);
    log(`  head_commit    ${report.headCommit}`);
    log(`  bundle_commit  ${report.bundleCommit}`);
    log(`  bundle         ${report.bundlePath}`);
    log(`  receipts       ${report.receiptsFile} (${report.run.tool_receipts.length})`);
    if (report.run.tool_failures.length > 0) {
      log(
        `  tool failures  ${report.run.tool_failures.length} (local detail in the run, never shown to the model)`,
      );
    }
    log("");
    log(
      `Self-check (verifyRepoChange, CI-on-PR mode): integrity ${v.verdict.integrity}, identityBinding ${v.verdict.identityBinding}, authority ${v.verdict.authority}, revocation ${v.verdict.revocation.status}; outcome ${v.outcome ?? "none"}`,
    );
    for (const f of v.diagnostics.failures) log(`  ${f.code}: ${sanitizeRelayText(f.detail, 500)}`);
    if (!report.accepted) {
      console.error(
        "Not verified as a completed change. Nothing was published: the commits are unreachable objects (no ref names them) and git's garbage collection removes them.",
      );
      deps.exit(1);
    }
    log("");
    log("Verified as a completed change. No ref was created or moved and nothing was pushed.");
    log("To publish, the operator pushes the bundle commit as a new branch:");
    log("");
    log(
      `  git push <publisher-remote> ${report.bundleCommit}:refs/heads/repo-task/${report.grantId}`,
    );
  });
}
