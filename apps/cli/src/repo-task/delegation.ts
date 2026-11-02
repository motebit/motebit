/**
 * The founder side of a governed repo change (docs/proposals/governed-repo-change-v1.md,
 * "Build order" step 3; spec/repo-change-v1.md §3.1, §4, §5): mint the
 * principal-signed authority a repo-task run acts under, and revoke it.
 *
 *   - `mintRepoTaskDelegation` builds a canonical `RepoTaskScope`, a
 *     `StandingDelegation` from the principal to the agent bound to it
 *     (`subject_binding`), and the ONE pre-minted tick (`grant_id` set,
 *     ending with the grant).
 *   - `mintRepoTaskRevocation` signs the grant's `DelegationRevocation`.
 *
 * Both SELF-CHECK what they produce before anything is written, with the run's
 * own authority law (`checkRepoTaskAuthority` in `@motebit/runtime`, which
 * calls the verifier's shared repo-change rules — scope shape, canonical paths
 * and values, signatures, subject binding, pins, tick structure, window, grant
 * rules, the strict revocation set). Never a second copy of a rule: when the
 * produced artifacts would not verify, the mint refuses with the verifier's
 * repair codes and nothing reaches the disk.
 *
 * A sibling of `motebit grant`, never an extension of it: no `spend_ceiling`,
 * no self-delegation, no stored copy under `~/.motebit`, no relay propagation.
 * The artifacts are files the founder lands on `main` (pins, revocations) or
 * hands to the agent's machine (scope, grant, tick); `main` is the custody
 * boundary, not this machine.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  bytesToHex,
  canonicalJsonForSigning,
  generateKeypair,
  secureErase,
  canonicalSha256,
  signDelegation,
  signDelegationRevocation,
  signStandingDelegation,
} from "@motebit/encryption";
import type {
  DelegationRevocation,
  DelegationToken,
  StandingDelegation,
} from "@motebit/encryption";
import { checkRepoTaskAuthority } from "@motebit/runtime";
import type {
  RepoTaskAuthorityBundle,
  RepoTaskAuthorityFailure,
  RepoTaskPin,
} from "@motebit/runtime";
import { isCanonicalRepoPath, isRepoTaskScopeShape, parseRepoChangeTools } from "@motebit/verifier";
import {
  ALL_REPO_CHANGE_TOOLS,
  REPO_CHANGE_MAX_GRANT_LIFETIME_MS,
  REPO_CHANGE_SUBJECT,
  REPO_TASK_SCOPE_SCHEMA,
  REPO_TASK_SCOPE_SPEC_ID,
} from "@motebit/sdk";
import type { RepoTaskScope } from "@motebit/sdk";

import { mkdirOwnerOnly } from "../durable-file.js";

/** The files a delegation directory holds (the input `motebit repo-task run` takes). */
export const DELEGATION_FILES = {
  scope: "scope.json",
  grant: "grant.json",
  tick: "tick.json",
} as const;

/** The principal: the identity whose key signs the grant, the tick and revocations. */
export interface RepoTaskPrincipal {
  readonly motebitId: string;
  /** 64 lowercase hex — the key the private key derives. */
  readonly publicKeyHex: string;
  readonly privateKey: Uint8Array;
}

export interface RepoTaskDelegationRequest {
  readonly principal: RepoTaskPrincipal;
  /** The agent's pin: the `(motebit_id, public_key)` pair of its identity file. */
  readonly delegate: RepoTaskPin;
  readonly repo: string;
  readonly baseRef: string;
  readonly objectFormat: string;
  /** Exact path strings, in the order given — never trimmed, split or normalized. */
  readonly allowedPaths: readonly string[];
  readonly maxChangedFiles: number;
  readonly task: string;
  /** The grant's and the tick's capability list, comma-separated. */
  readonly tools: string;
  /** `expires_at − start`; the grant's `cadence_ms` and the tick's TTL are this, by construction. */
  readonly lifetimeMs: number;
  /** Optional activation delay (Unix ms). */
  readonly notBefore?: number;
  readonly now: number;
  /** Injected for tests; a fresh UUIDv7 otherwise. */
  readonly grantId?: string;
}

export interface RepoTaskDelegation {
  readonly scope: RepoTaskScope;
  readonly grant: StandingDelegation;
  readonly tick: DelegationToken;
}

/**
 * One reason a mint was refused: a verifier repair code, or (for a revocation
 * that would bind nothing) `revoke.not_delegator`.
 */
export interface RepoTaskRefusal {
  readonly code:
    RepoTaskAuthorityFailure["code"] | "revoke.not_delegator" | "revoke.does_not_bind" | "precheck";
  readonly detail: string;
}

/** The produced artifacts would not verify; nothing was written. */
export class RepoTaskDelegationRefusedError extends Error {
  constructor(readonly failures: readonly RepoTaskRefusal[]) {
    super(
      `the artifacts would not verify:\n${failures
        .map((f) => `  ${f.code}: ${f.detail}`)
        .join("\n")}`,
    );
    this.name = "RepoTaskDelegationRefusedError";
  }
}

/** UUIDv7 (time-ordered, lowercase): the grant_id shape of standing-delegation-v1 §3.1. */
function generateUUIDv7(now: number): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 6; i++) bytes[i] = Math.floor(now / 2 ** (8 * (5 - i))) & 0xff;
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The capability list in its canonical order (the order of
 * `ALL_REPO_CHANGE_TOOLS`). Only reorders: a name that is not a repo-change
 * tool, or a repeat, is kept so the self-check refuses it.
 */
function canonicalToolOrder(tools: string): string {
  const parts = tools.split(",");
  const rank = (t: string): number => {
    const i = (ALL_REPO_CHANGE_TOOLS as readonly string[]).indexOf(t);
    return i === -1 ? ALL_REPO_CHANGE_TOOLS.length : i;
  };
  return [...parts].sort((a, b) => rank(a) - rank(b)).join(",");
}

/**
 * The authority bundle a run on this delegation would judge, with what the
 * founder's machine cannot know yet: no revocations, not spent, the scope's
 * own repository, and every path permitted — the repository's path predicate
 * is data at the tip (build step 4); the run and the verifier judge it there.
 */
function selfCheckBundle(
  d: RepoTaskDelegation,
  principal: RepoTaskPin,
  delegate: RepoTaskPin,
  revocations: readonly DelegationRevocation[],
): RepoTaskAuthorityBundle {
  return {
    scope: d.scope,
    grant: d.grant,
    tick: d.tick,
    revocations: { set: revocations, failures: [], readAt: "(self-check)" },
    principal,
    agents: [delegate],
    expectedRepo: d.scope.repo,
    isPathPermitted: () => true,
    spent: false,
  };
}

/** When the tick's window opens: max(issued_at, not_before) of grant and tick. */
function windowOpens(d: RepoTaskDelegation): number {
  return Math.max(
    d.grant.issued_at,
    d.grant.not_before ?? d.grant.issued_at,
    d.tick.issued_at,
    d.tick.not_before ?? d.tick.issued_at,
  );
}

/**
 * The refusals that need no key, judged BEFORE the principal's key is unlocked
 * so a delegation that cannot verify never prompts for a passphrase: the
 * scope's strict shape, every path canonical and unique, the tool list, the
 * lifetime, and the delegate not being the principal. Each is the verifier's
 * own predicate (`@motebit/verifier`'s shared repo-change rules); the
 * post-sign self-check in `mintRepoTaskDelegation` stays the authority.
 */
export async function precheckRepoTaskDelegation(
  req: Omit<RepoTaskDelegationRequest, "principal">,
  principal: RepoTaskPin,
): Promise<RepoTaskRefusal[]> {
  const out: RepoTaskRefusal[] = [];
  const refuse = (detail: string): void => {
    out.push({ code: "precheck", detail });
  };
  if (!isRepoTaskScopeShape(buildScope(req))) {
    refuse(
      "the scope is not of the strict shape (base_ref main, object_format sha1|sha256, a non-empty repo, task and path list, max_changed_files ≥ 1)",
    );
  }
  const seen = new Set<string>();
  for (const p of req.allowedPaths) {
    if (!isCanonicalRepoPath(p)) refuse(`path ${JSON.stringify(p)} is not canonical`);
    if (seen.has(p)) refuse(`path ${JSON.stringify(p)} repeats`);
    seen.add(p);
  }
  if (parseRepoChangeTools(canonicalToolOrder(req.tools)) === null) {
    refuse(`--scope ${JSON.stringify(req.tools)} is not a list of repo-change tools`);
  }
  if (
    !Number.isSafeInteger(req.lifetimeMs) ||
    req.lifetimeMs <= 0 ||
    req.lifetimeMs > REPO_CHANGE_MAX_GRANT_LIFETIME_MS
  ) {
    refuse(`the lifetime must be at most ${REPO_CHANGE_MAX_GRANT_LIFETIME_MS / 3_600_000} hours`);
  }
  if (
    req.delegate.motebit_id === principal.motebit_id ||
    req.delegate.public_key === principal.public_key
  ) {
    refuse("the delegate is this motebit: a principal cannot delegate to itself");
  }
  const keyFault = await delegateKeyFault(req.delegate);
  if (keyFault !== null) refuse(keyFault);
  return out;
}

/**
 * The delegate key's one spelling (standing-delegation-v1 §5), judged by the
 * signer's own rule without the principal's key: sign a throwaway token naming
 * the delegate under an ephemeral key generated here and erased at once. The
 * signer refuses a non-canonical party key before it signs, so a refusal here
 * is exactly the refusal the real mint would meet. `null` when canonical.
 */
async function delegateKeyFault(delegate: RepoTaskPin): Promise<string | null> {
  const probe = await generateKeypair();
  try {
    await signDelegation(
      {
        delegator_id: "repo-task-precheck",
        delegator_public_key: bytesToHex(probe.publicKey),
        delegate_id: delegate.motebit_id,
        delegate_public_key: delegate.public_key,
        scope: ALL_REPO_CHANGE_TOOLS.join(","),
        issued_at: 0,
        expires_at: 1,
      },
      probe.privateKey,
    );
    return null;
  } catch (err) {
    return `the delegate's key: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    secureErase(probe.privateKey);
  }
}

/**
 * The integrity of a delegation read from disk, judged BEFORE the principal's
 * key is unlocked: the run's authority law over the scope, grant and tick
 * (strict shapes, canonical values, the grant's and the tick's signatures, the
 * subject binding) needs no private key. Only its integrity axis is kept — a
 * revocation may revoke an expired grant. The post-sign self-check in
 * `mintRepoTaskRevocation` stays the authority.
 */
export async function precheckRepoTaskRevocation(
  delegation: RepoTaskDelegation,
  principal: RepoTaskPin,
  now: number,
): Promise<RepoTaskRefusal[]> {
  const { grant } = delegation;
  const delegate = { motebit_id: grant.delegate_id, public_key: grant.delegate_public_key };
  const check = await checkRepoTaskAuthority(
    selfCheckBundle(delegation, principal, delegate, []),
    delegate,
    now,
  );
  return check.ok ? [] : check.failures.filter((f) => f.code.startsWith("integrity."));
}

function buildScope(req: Omit<RepoTaskDelegationRequest, "principal">): RepoTaskScope {
  return {
    schema: REPO_TASK_SCOPE_SCHEMA,
    spec: REPO_TASK_SCOPE_SPEC_ID,
    repo: req.repo,
    base_ref: req.baseRef,
    object_format: req.objectFormat,
    allowed_paths: [...req.allowedPaths],
    max_changed_files: req.maxChangedFiles,
    task: req.task,
  } as RepoTaskScope;
}

/**
 * Build, sign and self-check the scope, the grant and the tick. Throws
 * `RepoTaskDelegationRefusedError` when the result would not verify.
 */
export async function mintRepoTaskDelegation(
  req: RepoTaskDelegationRequest,
): Promise<RepoTaskDelegation> {
  const { principal, delegate, now, lifetimeMs } = req;
  const scope = buildScope(req);
  const tools = canonicalToolOrder(req.tools);
  const grantId = req.grantId ?? generateUUIDv7(now);
  const notBefore = req.notBefore ?? null;
  // The grant's start (spec §5): max(issued_at, not_before ?? issued_at).
  const start = Math.max(now, notBefore ?? now);

  // The signers refuse a non-canonical party key outright (standing-delegation-v1
  // §5); that is a refusal like any other, not a crash.
  const signed = <T>(what: string, p: Promise<T>): Promise<T> =>
    p.catch((err: unknown) => {
      throw new RepoTaskDelegationRefusedError([
        {
          code: "integrity.repo_change.value_not_canonical",
          detail: `${what}: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    });
  const grant = await signed(
    "the grant",
    signStandingDelegation(
      {
        grant_id: grantId,
        delegator_id: principal.motebitId,
        delegator_public_key: principal.publicKeyHex,
        delegate_id: delegate.motebit_id,
        delegate_public_key: delegate.public_key,
        scope: tools,
        subject: REPO_CHANGE_SUBJECT,
        subject_binding: {
          schema: "motebit.subject-binding.v1",
          artifact_schema: REPO_TASK_SCOPE_SCHEMA,
          digest_method: "jcs-sha256-hex",
          digest: await canonicalSha256(scope),
        },
        // One tick and no second (spec §5): the cadence IS the lifetime.
        cadence_ms: lifetimeMs,
        issued_at: now,
        not_before: notBefore,
        expires_at: start + lifetimeMs,
        max_token_ttl_ms: lifetimeMs,
      },
      principal.privateKey,
    ),
  );
  // The single pre-minted tick: the grant's whole window, signed by the
  // principal now (standing-delegation-v1 §4), gated like the grant.
  const tick = await signed(
    "the tick",
    signDelegation(
      {
        delegator_id: grant.delegator_id,
        delegator_public_key: grant.delegator_public_key,
        delegate_id: grant.delegate_id,
        delegate_public_key: grant.delegate_public_key,
        scope: tools,
        issued_at: start,
        expires_at: grant.expires_at,
        ...(notBefore !== null ? { not_before: notBefore } : {}),
        grant_id: grantId,
      },
      principal.privateKey,
    ),
  );

  const minted: RepoTaskDelegation = { scope, grant, tick };
  const principalPin = { motebit_id: principal.motebitId, public_key: principal.publicKeyHex };
  // Judged when the tick's window opens: the earliest moment a run can use it.
  const check = await checkRepoTaskAuthority(
    selfCheckBundle(minted, principalPin, delegate, []),
    delegate,
    windowOpens(minted),
  );
  if (!check.ok) throw new RepoTaskDelegationRefusedError(check.failures);
  return minted;
}

/** Every file's canonical JSON, serialized before anything is written. */
function serialize(files: Record<string, unknown>): [string, string][] {
  return Object.entries(files).map(([name, value]) => [name, canonicalJsonForSigning(value)]);
}

/** The file-system calls the writer makes; a seam so a test can fail a write midway. */
export interface CanonicalFileIo {
  readonly writeSync: (fd: number, data: Uint8Array) => number;
}
const NODE_IO: CanonicalFileIo = { writeSync: (fd, data) => fs.writeSync(fd, data) };

/** The outermost directory on the way to `dir` that does not exist yet, or null. */
function firstMissingAncestor(dir: string): string | null {
  let missing: string | null = null;
  for (let d = path.resolve(dir); !fs.existsSync(d); d = path.dirname(d)) {
    missing = d;
    if (path.dirname(d) === d) break;
  }
  return missing;
}

/**
 * Write canonical JSON files into `dir` (created owner-only if absent; files
 * 0600). Every file is created exclusively — an existing file is never
 * overwritten — and on any failure everything this call created is removed:
 * each file it opened (recorded before a byte is written, so a write that
 * fails midway leaves no truncated file) and the directories it made.
 * Returns the files' paths.
 */
export function writeCanonicalFiles(
  dir: string,
  files: Record<string, unknown>,
  io: CanonicalFileIo = NODE_IO,
): string[] {
  const contents = serialize(files);
  const created = firstMissingAncestor(dir);
  const written: string[] = [];
  try {
    mkdirOwnerOnly(dir);
    for (const [name, text] of contents) {
      const file = path.join(dir, name);
      const fd = fs.openSync(file, "wx", 0o600);
      written.push(file);
      try {
        const bytes = new TextEncoder().encode(text);
        for (let off = 0; off < bytes.length;) off += io.writeSync(fd, bytes.subarray(off));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch (err) {
    for (const file of written) fs.rmSync(file, { force: true });
    if (created !== null) {
      // Only the directories this call made, innermost first, and only when empty.
      for (let d = path.resolve(dir); ; d = path.dirname(d)) {
        try {
          fs.rmdirSync(d);
        } catch {
          break;
        }
        if (d === created) break;
      }
    }
    throw new Error(`could not write ${dir}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  return written;
}

/**
 * Mint, self-check, then write `scope.json`, `grant.json` and `tick.json` into
 * `dir` (or the directory `dir` names for the minted grant_id).
 */
export async function delegateToDirectory(
  req: RepoTaskDelegationRequest,
  dir: string | ((grantId: string) => string),
): Promise<{ delegation: RepoTaskDelegation; dir: string; files: string[] }> {
  const delegation = await mintRepoTaskDelegation(req);
  const out = typeof dir === "string" ? dir : dir(delegation.grant.grant_id);
  const files = writeCanonicalFiles(out, {
    [DELEGATION_FILES.scope]: delegation.scope,
    [DELEGATION_FILES.grant]: delegation.grant,
    [DELEGATION_FILES.tick]: delegation.tick,
  });
  return { delegation, dir: out, files };
}

/**
 * Sign the grant's revocation with the loaded principal key, and self-check
 * it with the strict revocation-set rule a run and the verifier apply: it must
 * be well-formed AND bind the grant (standing-delegation-v1 §5 — same
 * `grant_id`, `delegator_public_key` equal to that grant's delegator key). A
 * key that is not the grant's delegator key yields a revocation that binds
 * nothing, so it is refused, never written.
 */
export async function mintRepoTaskRevocation(input: {
  readonly delegation: RepoTaskDelegation;
  readonly principal: RepoTaskPrincipal;
  readonly now: number;
}): Promise<DelegationRevocation> {
  const { delegation, principal, now } = input;
  const { grant } = delegation;
  const revocation = await signDelegationRevocation(
    {
      grant_id: grant.grant_id,
      delegator_id: grant.delegator_id,
      // The key that actually signs: a revocation states who signed it.
      delegator_public_key: principal.publicKeyHex,
      revoked_at: now,
    },
    principal.privateKey,
  );
  const delegate = { motebit_id: grant.delegate_id, public_key: grant.delegate_public_key };
  const principalPin = { motebit_id: principal.motebitId, public_key: principal.publicKeyHex };
  const check = await checkRepoTaskAuthority(
    selfCheckBundle(delegation, principalPin, delegate, [revocation]),
    delegate,
    now,
  );
  // A revocation that binds makes the check fail with `revoked` on the
  // revocation axis. Temporal and structural authority faults (expired, not
  // yet valid) are no reason not to revoke a grant; an INTEGRITY fault is: a
  // grant, tick or scope that is malformed, non-canonical or not signed by its
  // delegator is not a grant the principal made, and a revocation of it would
  // revoke nothing real.
  const failures = check.ok ? [] : check.failures;
  const integrity = failures.filter((f) => f.code.startsWith("integrity."));
  if (integrity.length > 0) throw new RepoTaskDelegationRefusedError(integrity);
  const malformed = failures.filter((f) => f.code === "revocation.repo_change.set_malformed");
  if (malformed.length > 0) throw new RepoTaskDelegationRefusedError(malformed);
  // With integrity sound the revocation axis was evaluated, so a revocation
  // that does not bind is exactly a key that is not the grant's delegator key.
  if (!failures.some((f) => f.code === "revocation.repo_change.revoked")) {
    throw new RepoTaskDelegationRefusedError([
      principal.publicKeyHex !== grant.delegator_public_key
        ? {
            code: "revoke.not_delegator",
            detail:
              "the revocation would bind nothing: the loaded key is not the grant's delegator key",
          }
        : { code: "revoke.does_not_bind", detail: "the revocation would bind nothing" },
    ]);
  }
  return revocation;
}

/** Mint and self-check the revocation, then write it into `dir` as `<grant_id>.json`. */
export async function revokeToDirectory(
  input: Parameters<typeof mintRepoTaskRevocation>[0],
  dir: string,
): Promise<{ revocation: DelegationRevocation; file: string }> {
  const revocation = await mintRepoTaskRevocation(input);
  const [file] = writeCanonicalFiles(dir, { [`${revocation.grant_id}.json`]: revocation });
  return { revocation, file: file! };
}

/** Read a delegation directory (`scope.json`, `grant.json`, `tick.json`). */
export function readDelegationDirectory(dir: string): RepoTaskDelegation {
  const read = (name: string): unknown => {
    const file = path.join(dir, name);
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    } catch (err) {
      throw new Error(
        `could not read ${file}: ${err instanceof Error ? err.message : String(err)}`,
        {
          cause: err,
        },
      );
    }
  };
  return {
    scope: read(DELEGATION_FILES.scope) as RepoTaskScope,
    grant: read(DELEGATION_FILES.grant) as StandingDelegation,
    tick: read(DELEGATION_FILES.tick) as DelegationToken,
  };
}
