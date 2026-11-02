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
 * Never prints key material.
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
import {
  DELEGATION_FILES,
  RepoTaskDelegationRefusedError,
  delegateToDirectory,
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

/** Print each line sanitized (a message may carry file names or relay-shaped text), then exit 1. */
function die(text: string): never {
  for (const line of text.split("\n")) console.error(sanitizeRelayText(line, 1000));
  process.exit(1);
}

/** A positive number of hours, as whole milliseconds. Range is the self-check's. */
export function parseLifetimeHours(value: string | undefined): number {
  if (value === undefined) return 24 * HOUR_MS;
  const ms = Number(value) * HOUR_MS;
  if (!/^\d+(\.\d+)?$/.test(value) || !Number.isSafeInteger(ms) || ms <= 0) {
    die(`--hours must be a positive number of hours that is a whole number of ms (got "${value}")`);
  }
  return ms;
}

/** `--not-before`: Unix ms, or an ISO 8601 time. */
export function parseNotBefore(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isSafeInteger(ms)) {
    die(`--not-before must be Unix milliseconds or an ISO 8601 time (got "${value}")`);
  }
  return ms;
}

function parseMaxFiles(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n)) {
    die(`--max-files must be a whole number (got "${value}")`);
  }
  return n;
}

/** The task text, exactly: from `--task`, or a file decoded as strict UTF-8. */
function readTask(config: CliConfig): string {
  if ((config.task === undefined) === (config.taskFile === undefined)) {
    die(`Give exactly one of --task and --task-file.\n${DELEGATE_USAGE}`);
  }
  if (config.task !== undefined) return config.task;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(config.taskFile!));
  } catch (err) {
    die(`--task-file: ${err instanceof Error ? err.message : String(err)}`);
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

function refused(err: unknown): never {
  if (err instanceof RepoTaskDelegationRefusedError) {
    die(
      [
        "Refused, nothing written — the artifacts would not verify:",
        ...err.failures.map((f) => `  ${f.code}: ${f.detail}`),
      ].join("\n"),
    );
  }
  throw err;
}

// === motebit repo-task delegate =======================================

export async function handleRepoTaskDelegate(config: CliConfig): Promise<void> {
  const paths = config.paths ?? [];
  if (config.repo === undefined || config.delegateIdentity === undefined || paths.length === 0) {
    die(DELEGATE_USAGE);
  }
  const task = readTask(config);
  const lifetimeMs = parseLifetimeHours(config.hours);
  const notBefore = parseNotBefore(config.notBefore);
  const maxChangedFiles = parseMaxFiles(config.maxFiles, paths.length);

  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    die("No motebit identity configured — run `motebit init` first.");
  }
  let delegate: RepoTaskPin;
  try {
    delegate = await readAgentPin(config.delegateIdentity);
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  const active = await loadActiveSigningKey(fullConfig, { promptLabel: "Passphrase: " });
  let result: Awaited<ReturnType<typeof delegateToDirectory>>;
  try {
    result = await delegateToDirectory(
      {
        principal: { motebitId, publicKeyHex: active.publicKey, privateKey: active.privateKey },
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
        now: Date.now(),
      },
      (grantId) => config.output ?? path.resolve(`repo-task-${grantId}`),
    );
  } catch (err) {
    refused(err);
  } finally {
    secureErase(active.privateKey);
  }

  const { grant, scope } = result.delegation;
  console.log(`Delegation signed: ${grant.grant_id}`);
  for (const file of result.files) console.log(`  wrote  ${file}`);
  console.log(`  repo      ${scope.repo} (${scope.base_ref}, ${scope.object_format})`);
  console.log(`  paths     ${scope.allowed_paths.join(", ")} (at most ${scope.max_changed_files})`);
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
}

// === motebit repo-task revoke =========================================

/** The delegation directory a revoke argument names: a grant file, a directory, or a grant_id. */
export function resolveDelegationDirectory(arg: string): string {
  if (fs.existsSync(arg)) {
    return fs.statSync(arg).isDirectory() ? arg : path.dirname(arg);
  }
  if (UUID.test(arg)) return path.resolve(`repo-task-${arg}`);
  throw new Error(`${arg} is neither a grant file, a delegation directory nor a grant_id`);
}

export async function handleRepoTaskRevoke(config: CliConfig): Promise<void> {
  const arg = config.positionals[2];
  if (arg == null || arg === "") die(REVOKE_USAGE);
  let dir: string;
  let delegation: ReturnType<typeof readDelegationDirectory>;
  try {
    dir = resolveDelegationDirectory(arg);
    delegation = readDelegationDirectory(dir);
  } catch (err) {
    die(
      `${err instanceof Error ? err.message : String(err)}\nA revoke reads the delegation directory \`motebit repo-task delegate\` wrote (${Object.values(DELEGATION_FILES).join(", ")}).`,
    );
  }

  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    die("No motebit identity configured — run `motebit init` first.");
  }
  // Said before the passphrase prompt; the mint's self-check is the authority.
  if (
    fullConfig.device_public_key != null &&
    fullConfig.device_public_key !== delegation.grant.delegator_public_key
  ) {
    die(
      "Refused — this motebit's key is not the grant's delegator key, so its revocation would bind nothing (spec/standing-delegation-v1.md §5). Revoke from the principal that signed the grant.",
    );
  }

  const active = await loadActiveSigningKey(fullConfig, { promptLabel: "Passphrase: " });
  let file: string;
  try {
    ({ file } = await revokeToDirectory(
      {
        delegation,
        principal: { motebitId, publicKeyHex: active.publicKey, privateKey: active.privateKey },
        now: Date.now(),
      },
      config.output ?? dir,
    ));
  } catch (err) {
    refused(err);
  } finally {
    secureErase(active.privateKey);
  }

  console.log(`Revocation signed: ${delegation.grant.grant_id}`);
  console.log(`  wrote  ${file}`);
  console.log("");
  console.log(
    `It counts from the commit that lands it on main: .motebit/revocations/${delegation.grant.grant_id}.json (a founder-approved PR).`,
  );
}
