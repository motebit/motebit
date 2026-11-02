/**
 * `motebit repo-task delegate` and `motebit repo-task revoke` — the principal's
 * side of a governed repo change (docs/proposals/governed-repo-change-v1.md,
 * "Build order" step 3).
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
import { identityVerifyOutcome, verify } from "@motebit/identity-file";
import type { RepoTaskPin } from "@motebit/runtime";
import { REPO_TASK_BASE_REF } from "@motebit/sdk";
import { sanitizeRelayText } from "@motebit/sync-engine";

import type { CliConfig } from "../args.js";
import { loadFullConfig } from "../config.js";
import { loadActiveSigningKey } from "../identity.js";
import type { ActiveSigningKey } from "../identity.js";
import type { FullConfig } from "../config.js";
import {
  DELEGATION_FILES,
  RepoTaskDelegationRefusedError,
  delegateToDirectory,
  precheckRepoTaskDelegation,
  precheckRepoTaskRevocation,
  readDelegationDirectory,
  revokeToDirectory,
} from "../repo-task/delegation.js";

const HOUR_MS = 3_600_000;
const DEFAULT_TOOLS = "repo_read_blob,repo_write_path";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const DELEGATE_USAGE =
  "Usage: motebit repo-task delegate --repo <owner/name> --path <path> [--path <path> ...] (--task <text> | --task-file <file>) --delegate <agent motebit.md> [--hours 24] [--max-files <n>] [--not-before <iso|ms>] [--object-format sha1] [--scope repo_read_blob,repo_write_path] [--output <dir>]";
const REVOKE_USAGE =
  "Usage: motebit repo-task revoke <grant.json | delegation dir | grant_id> [--output <dir>]";

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
async function runCommand(deps: RepoTaskCommandDeps, body: () => Promise<void>): Promise<void> {
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
      throw new RepoTaskCliRefusal(
        refusalText("Refused, nothing written — the artifacts would not verify:", err),
      );
    }
    throw err;
  } finally {
    deps.secureErase(active.privateKey);
  }
}

function requireIdentity(fullConfig: FullConfig): RepoTaskPin {
  const motebitId = fullConfig.motebit_id;
  const publicKey = fullConfig.device_public_key;
  if (motebitId == null || motebitId === "" || publicKey == null || publicKey === "") {
    refuse("No motebit identity configured — run `motebit init` first.");
  }
  return { motebit_id: motebitId, public_key: publicKey };
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
    const principalPin = requireIdentity(fullConfig);
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
    const pre = await precheckRepoTaskDelegation(request, principalPin);
    if (pre.length > 0) {
      refuse(
        ["Refused before signing — this delegation could not verify:"]
          .concat(pre.map((f) => `  ${f.detail}`))
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
    console.log("One grant backs one landing. Hand the directory to the agent's machine.");
    console.log(
      `Revoke it: motebit repo-task revoke ${path.join(result.dir, DELEGATION_FILES.grant)}`,
    );
  });
}

// === motebit repo-task revoke =========================================

/**
 * The delegation directory a revoke argument names: the directory itself, its
 * `grant.json`, or a grant_id (`./repo-task-<grant_id>`). A file of any other
 * name is refused: the grant is always read as `grant.json` beside its
 * `scope.json` and `tick.json`, so naming `grant-B.json` would revoke whatever
 * `grant.json` sits next to it.
 */
export function resolveDelegationDirectory(arg: string): string {
  if (fs.existsSync(arg)) {
    if (fs.statSync(arg).isDirectory()) return arg;
    if (path.basename(arg) === DELEGATION_FILES.grant) return path.dirname(arg);
    throw new Error(
      `${arg} is not a delegation's ${DELEGATION_FILES.grant} — name the delegation directory or its ${DELEGATION_FILES.grant}`,
    );
  }
  if (UUID.test(arg)) return path.resolve(`repo-task-${arg}`);
  throw new Error(`${arg} is neither a grant file, a delegation directory nor a grant_id`);
}

export function handleRepoTaskRevoke(
  config: CliConfig,
  deps: RepoTaskCommandDeps = NODE_DEPS,
): Promise<void> {
  return runCommand(deps, async () => {
    const arg = config.positionals[2];
    if (arg == null || arg === "") refuse(REVOKE_USAGE);
    let dir: string;
    let delegation: ReturnType<typeof readDelegationDirectory>;
    try {
      dir = resolveDelegationDirectory(arg);
      delegation = readDelegationDirectory(dir);
    } catch (err) {
      refuse(
        `${err instanceof Error ? err.message : String(err)}\nA revoke reads the delegation directory \`motebit repo-task delegate\` wrote (${Object.values(DELEGATION_FILES).join(", ")}).`,
      );
    }

    const fullConfig = deps.loadFullConfig();
    const principalPin = requireIdentity(fullConfig);
    // Said before the passphrase prompt; the mint's self-check is the authority.
    if (principalPin.public_key !== delegation.grant.delegator_public_key) {
      refuse(
        "Refused — this motebit's key is not the grant's delegator key, so its revocation would bind nothing (spec/standing-delegation-v1.md §5). Revoke from the principal that signed the grant.",
      );
    }
    // The delegation's integrity needs no key: a forged or malformed grant,
    // tick or scope is refused before the passphrase prompt.
    const pre = await precheckRepoTaskRevocation(delegation, principalPin, deps.now());
    if (pre.length > 0) {
      refuse(
        ["Refused before signing — this is not a delegation the principal signed:"]
          .concat(pre.map((f) => `  ${f.code}: ${f.detail}`))
          .join("\n"),
      );
    }

    const { file } = await withPrincipalKey(deps, fullConfig, (active) =>
      deps.revokeToDirectory(
        {
          delegation,
          principal: {
            motebitId: principalPin.motebit_id,
            publicKeyHex: active.publicKey,
            privateKey: active.privateKey,
          },
          now: deps.now(),
        },
        config.output ?? dir,
      ),
    );

    console.log(`Revocation signed: ${delegation.grant.grant_id}`);
    console.log(`  wrote  ${file}`);
    console.log("");
    console.log(
      `It counts from the commit that lands it on main: .motebit/revocations/${delegation.grant.grant_id}.json (a founder-approved PR).`,
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
  const result = await verify(content, { expectedType: "identity" });
  const outcome = identityVerifyOutcome(result);
  if (result.type !== "identity" || !outcome.valid || !result.identity) {
    throw new Error(
      `--delegate: ${file} is not an intact identity file (${outcome.error ?? "verification failed"})`,
    );
  }
  return {
    motebit_id: result.identity.motebit_id,
    public_key: result.identity.identity.public_key,
  };
}
