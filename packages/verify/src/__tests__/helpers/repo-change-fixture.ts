/**
 * Fixture git repositories for `motebit-verify repo-change`: a real repository
 * in a temp directory (built with the system `git`, its config and HOME
 * isolated), ephemeral Ed25519 keys for the principal F and the agent A, and a
 * governed change built the way `motebit repo-task run` builds one — base →
 * change commit → bundle commit adding `.motebit/bundles/<grant_id>.json`,
 * whose bytes are the canonical JSON of a bundle signed with
 * `@motebit/crypto`. Only permissive packages; nothing reads `~/.motebit`.
 *
 * Every knob changes one input source, so each failing test names one rule.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  bytesToHex,
  canonicalJson,
  canonicalSha256,
  deriveSovereignMotebitId,
  ed25519Sign,
  generateKeypair,
  hash,
  signDelegation,
  signDelegationRevocation,
  signExecutionReceipt,
  signStandingDelegation,
  signToolInvocationReceipt,
  subjectBindingDigest,
} from "@motebit/crypto";
import type { KeyPair } from "@motebit/crypto";

export const NOW = 1_900_000_000_000;
export const HOUR = 3_600_000;
export const REPO = "motebit/motebit";
export const DOC = "notes/guide.md";
export const POLICY = JSON.stringify({
  spec: "motebit/repo-path-policy@1.0",
  include: ["notes/*.md"],
  exclude: [".motebit"],
});
const enc = new TextEncoder();

export interface Party {
  readonly keys: KeyPair;
  readonly motebitId: string;
  readonly publicKey: string;
}

export async function party(): Promise<Party> {
  const keys = await generateKeypair();
  const publicKey = bytesToHex(keys.publicKey);
  return { keys, publicKey, motebitId: await deriveSovereignMotebitId(publicKey) };
}

/** A signed `motebit.md` (spec motebit/identity@1.0): the signature is over the frontmatter text. */
export async function identityFile(p: Party): Promise<string> {
  const yaml = [
    'spec: "motebit/identity@1.0"',
    `motebit_id: "${p.motebitId}"`,
    'created_at: "2026-01-15T00:00:00.000Z"',
    'owner_id: "owner"',
    "identity:",
    '  algorithm: "Ed25519"',
    `  public_key: "${p.publicKey}"`,
    "governance:",
    '  trust_mode: "guarded"',
    '  max_risk_auto: "R1_DRAFT"',
    '  require_approval_above: "R1_DRAFT"',
    '  deny_above: "R4_MONEY"',
    "  operator_mode: false",
    "privacy:",
    '  default_sensitivity: "personal"',
    "  retention_days:",
    "    none: 365",
    "    personal: 90",
    "    medical: 30",
    "    financial: 30",
    "    secret: 7",
    "  fail_closed: true",
    "memory:",
    "  half_life_days: 7",
    "  confidence_threshold: 0.3",
    "  per_turn_limit: 5",
    "devices: []",
  ].join("\n");
  const sig = bytesToHex(await ed25519Sign(enc.encode(yaml), p.keys.privateKey));
  return `---\n${yaml}\n---\n<!-- motebit:sig:motebit-jcs-ed25519-hex-v1:${sig} -->\n`;
}

let gitHome = "";
function home(): string {
  if (gitHome === "") gitHome = fs.mkdtempSync(path.join(os.tmpdir(), "verify-rc-home-"));
  return gitHome;
}

export function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    GIT_AUTHOR_DATE: "@1800000000 +0000",
    GIT_COMMITTER_DATE: "@1800000000 +0000",
    ...extra,
  };
}

/** Run the system git in `repo` (test setup only; the code under test never does this). */
export function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    env: gitEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeFile(repo: string, rel: string, content: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), content);
}

function commitAll(repo: string, message: string): string {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "--allow-empty", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

export interface FixtureOptions {
  /** Default true. */
  principalPin?: boolean;
  /** The path policy at the base (default POLICY). */
  basePolicy?: string;
  /** A policy the change commit writes (the pull request widening its own predicate). */
  headPolicy?: string;
  /** Revoke the grant at the base (a revocation signed by F). */
  revoked?: boolean;
  /** The bundle path once existed on main's first-parent history, then was deleted. */
  spent?: boolean;
  /** An unrelated bundle already on main (default false). */
  otherBundle?: boolean;
  /** Extra files the change commit writes, outside the scope. */
  extraChange?: Record<string, string>;
  /** A second change commit between the change and the bundle commit. */
  threeCommits?: boolean;
  /** main moves on after the change was built: the pull request is no longer on the tip. */
  mainMovesOn?: boolean;
  /** Files the bundle commit adds or changes besides the bundle. */
  bundleCommitExtra?: Record<string, string>;
  /** Extra files on main at the base. */
  baseExtra?: Record<string, string>;
  /** The record's head_commit, when it should not be the change commit. */
  recordHeadCommit?: string;
  /** Rewrite the bundle object before it is serialized (after signing). */
  bundle?: (b: Record<string, unknown>) => void;
  /** Rewrite the bundle bytes. */
  bytes?: (b: Uint8Array) => Uint8Array;
}

export interface Fixture {
  readonly repo: string;
  readonly base: string;
  readonly change: string;
  readonly head: string;
  readonly grantId: string;
  readonly bundleFile: string;
  readonly bundleBytes: Uint8Array;
}

let keys: { f: Party; a: Party } | null = null;
export async function parties(): Promise<{ f: Party; a: Party }> {
  if (keys === null) keys = { f: await party(), a: await party() };
  return keys;
}

const BOTH = "repo_read_blob,repo_write_path";

/** Build a fixture repository holding a governed change's pull request. */
export async function fixture(root: string, o: FixtureOptions = {}): Promise<Fixture> {
  const { f, a } = await parties();
  const repo = fs.mkdtempSync(path.join(root, "repo-"));
  const grantId = crypto.randomUUID();
  git(repo, "init", "-q", "-b", "main");
  writeFile(repo, DOC, "teh typo\n");
  writeFile(repo, "src/code.ts", "export const x = 1;\n");
  if (o.principalPin !== false) {
    writeFile(repo, ".motebit/principals/principal.md", await identityFile(f));
  }
  writeFile(
    repo,
    `.motebit/principals/agents/${a.motebitId.slice(0, 12)}.md`,
    await identityFile(a),
  );
  writeFile(repo, ".motebit/repo-path-policy.json", o.basePolicy ?? POLICY);
  if (o.otherBundle) writeFile(repo, ".motebit/bundles/landed.json", "{}");
  for (const [p, c] of Object.entries(o.baseExtra ?? {})) writeFile(repo, p, c);
  let base = commitAll(repo, "init");
  if (o.spent) {
    writeFile(repo, `.motebit/bundles/${grantId}.json`, "{}");
    commitAll(repo, "landed");
    git(repo, "rm", "-q", `.motebit/bundles/${grantId}.json`);
    base = commitAll(repo, "deleted");
  }
  if (o.revoked) {
    const revocation = await signDelegationRevocation(
      {
        grant_id: grantId,
        delegator_id: f.motebitId,
        delegator_public_key: f.publicKey,
        revoked_at: NOW - 30_000,
      },
      f.keys.privateKey,
    );
    writeFile(repo, `.motebit/revocations/${grantId}.json`, canonicalJson(revocation));
    base = commitAll(repo, "revoke");
  }

  // -- The change commit(s), on the base, on a branch.
  git(repo, "checkout", "-q", "-b", "pr");
  writeFile(repo, DOC, "the typo\n");
  if (o.headPolicy !== undefined) writeFile(repo, ".motebit/repo-path-policy.json", o.headPolicy);
  for (const [p, c] of Object.entries(o.extraChange ?? {})) writeFile(repo, p, c);
  let change = commitAll(repo, "change");
  if (o.threeCommits) {
    writeFile(repo, DOC, "the typo, fixed\n");
    change = commitAll(repo, "change 2");
  }
  const blob = git(repo, "rev-parse", `${change}:${DOC}`);

  // -- The signed artifacts.
  const scope = {
    schema: "motebit.repo-task-scope.v1" as const,
    spec: "motebit/repo-task-scope@1.0" as const,
    repo: REPO,
    base_ref: "main" as const,
    object_format: "sha1" as const,
    allowed_paths: [DOC],
    max_changed_files: 1,
    task: "Fix the typo in notes/guide.md.",
  };
  const issued = NOW - 60_000;
  const grant = await signStandingDelegation(
    {
      grant_id: grantId,
      delegator_id: f.motebitId,
      delegator_public_key: f.publicKey,
      delegate_id: a.motebitId,
      delegate_public_key: a.publicKey,
      scope: BOTH,
      subject: "repo-change",
      subject_binding: {
        schema: "motebit.subject-binding.v1",
        artifact_schema: "motebit.repo-task-scope.v1",
        digest_method: "jcs-sha256-hex",
        digest: await subjectBindingDigest(scope),
      },
      cadence_ms: HOUR,
      issued_at: issued,
      not_before: null,
      expires_at: issued + HOUR,
      max_token_ttl_ms: HOUR,
    },
    f.keys.privateKey,
  );
  const tick = await signDelegation(
    {
      delegator_id: f.motebitId,
      delegator_public_key: f.publicKey,
      delegate_id: a.motebitId,
      delegate_public_key: a.publicKey,
      scope: BOTH,
      issued_at: issued,
      expires_at: issued + HOUR,
      grant_id: grantId,
    },
    f.keys.privateKey,
  );
  const taskId = "task-0001";
  const tool = await signToolInvocationReceipt(
    {
      invocation_id: "inv-1",
      task_id: taskId,
      motebit_id: a.motebitId,
      public_key: a.publicKey,
      device_id: "agent-device",
      tool_name: "repo_write_path",
      started_at: issued + 1_000,
      completed_at: issued + 1_000,
      status: "completed",
      args_hash: "c".repeat(64),
      result_hash: "d".repeat(64),
    },
    a.keys.privateKey,
  );
  const sha = (value: string) => ({ algorithm: "sha-256" as const, value });
  const record = {
    spec: "motebit/repo-change@1.0",
    grant_id: grantId,
    grant_digest: sha(await canonicalSha256(grant)),
    tick_digest: sha(await canonicalSha256(tick)),
    scope_digest: sha(await canonicalSha256(scope)),
    repo: REPO,
    object_format: "sha1",
    parent_commit: base,
    head_commit: o.recordHeadCommit ?? change,
    entries: [{ path: DOC, mode: "100644", blob }],
    tool_receipt_digests: [sha(await canonicalSha256(tool))],
    system_prompt_digest: sha("e".repeat(64)),
    provider: "anthropic",
    model: "model-1",
    runtime_version: "motebit test",
  };
  const result = canonicalJson(record);
  const receipt = await signExecutionReceipt(
    {
      task_id: taskId,
      motebit_id: a.motebitId,
      public_key: a.publicKey,
      device_id: "agent-device",
      submitted_at: issued + 500,
      completed_at: issued + 2_000,
      status: "completed",
      result,
      tools_used: ["repo_write_path"],
      memories_formed: 0,
      prompt_hash: await hash(enc.encode(scope.task)),
      result_hash: await hash(enc.encode(result)),
      delegated_scope: BOTH,
    },
    a.keys.privateKey,
  );
  const bundleObj: Record<string, unknown> = {
    spec: "motebit/repo-change-bundle@1.0",
    scope,
    grant,
    tick,
    tool_receipts: [tool],
    receipt,
  };
  o.bundle?.(bundleObj);
  let bundleBytes = enc.encode(canonicalJson(bundleObj));
  if (o.bytes) bundleBytes = o.bytes(bundleBytes);

  // -- The bundle commit.
  const bundleFile = `.motebit/bundles/${grantId}.json`;
  writeFile(repo, bundleFile, bundleBytes);
  for (const [p, c] of Object.entries(o.bundleCommitExtra ?? {})) writeFile(repo, p, c);
  const head = commitAll(repo, "bundle");

  // -- main moves on, if asked: the base the check is given is the new tip.
  if (o.mainMovesOn) {
    git(repo, "checkout", "-q", "main");
    writeFile(repo, "src/other.ts", "export const y = 2;\n");
    base = commitAll(repo, "main moves on");
  }
  git(repo, "checkout", "-q", "main");
  return { repo, base, change, head, grantId, bundleFile, bundleBytes };
}

/** The standard arguments for the fixture, in CI-on-PR mode. */
export function argsFor(
  fx: Fixture,
  over: Partial<
    Record<"repo" | "base" | "head" | "repository" | "baseRef" | "prAuthor", string>
  > = {},
): {
  repo: string;
  base: string;
  head: string;
  repository: string;
  baseRef: string;
  prAuthor: string;
  now: number;
} {
  return {
    repo: over.repo ?? fx.repo,
    base: over.base ?? fx.base,
    head: over.head ?? fx.head,
    repository: over.repository ?? REPO,
    baseRef: over.baseRef ?? "main",
    prAuthor: over.prAuthor ?? "motebit-agent",
    now: NOW,
  };
}
