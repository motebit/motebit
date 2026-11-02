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
  canonicalJsonForSigning,
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
import {
  ALL_REPO_CHANGE_TOOLS,
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
  readonly code: RepoTaskAuthorityFailure["code"] | "revoke.not_delegator";
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
 * Build, sign and self-check the scope, the grant and the tick. Throws
 * `RepoTaskDelegationRefusedError` when the result would not verify.
 */
export async function mintRepoTaskDelegation(
  req: RepoTaskDelegationRequest,
): Promise<RepoTaskDelegation> {
  const { principal, delegate, now, lifetimeMs } = req;
  const scope = {
    schema: REPO_TASK_SCOPE_SCHEMA,
    spec: REPO_TASK_SCOPE_SPEC_ID,
    repo: req.repo,
    base_ref: req.baseRef,
    object_format: req.objectFormat,
    allowed_paths: [...req.allowedPaths],
    max_changed_files: req.maxChangedFiles,
    task: req.task,
  } as RepoTaskScope;
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

/**
 * Write canonical JSON files into `dir` (created owner-only if absent). Every
 * file is created exclusively — an existing file is never overwritten — and on
 * any failure the files this call created are removed. Returns their paths.
 */
export function writeCanonicalFiles(dir: string, files: Record<string, unknown>): string[] {
  const contents = serialize(files);
  mkdirOwnerOnly(dir);
  const written: string[] = [];
  try {
    for (const [name, text] of contents) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, text, { flag: "wx", mode: 0o600 });
      written.push(file);
    }
  } catch (err) {
    for (const file of written) fs.rmSync(file, { force: true });
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
  // A revocation that binds makes the check fail with exactly `revoked` on
  // the revocation axis; the grant's other faults (expired, say) are no
  // reason not to revoke it.
  const failures = check.ok ? [] : check.failures;
  const malformed = failures.filter((f) => f.code === "revocation.repo_change.set_malformed");
  const binds = failures.some((f) => f.code === "revocation.repo_change.revoked");
  if (malformed.length > 0) throw new RepoTaskDelegationRefusedError(malformed);
  if (!binds) {
    throw new RepoTaskDelegationRefusedError([
      ...failures,
      {
        code: "revoke.not_delegator",
        detail:
          "the revocation would bind nothing: the loaded key is not the grant's delegator key",
      },
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
