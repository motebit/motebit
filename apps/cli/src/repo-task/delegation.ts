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
  verifyStandingDelegation,
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
  checkRepoChangeParties,
  checkRepoChangeRevocationSet,
  isCanonicalBase64Url,
  isRepoChangeGrantShape,
} from "@motebit/verifier";
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
  readonly code: RepoTaskAuthorityFailure["code"] | "revoke.not_delegator" | "file.exists";
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
 * Every refusal that needs no principal key, judged BEFORE the key is unlocked
 * so a delegation that cannot verify never prompts for a passphrase. Not a
 * second copy of any rule — the authority's own rules over the inputs:
 *
 *   1. A dry run of the real mint under an EPHEMERAL key, generated here and
 *      erased at once, standing in for the principal's: the same signers and
 *      the same post-sign self-check (`checkRepoTaskAuthority` over the
 *      verifier's shared rules) judge every input-only rule — scope shape,
 *      paths, tools, lifetime, the delegate's identity and key spelling.
 *   2. The rule the dry run cannot see, because it involves the principal's
 *      real key: the verifier's own party rule (`checkRepoChangeParties`) over
 *      the dry-run grant with the configured principal pair put back, so a
 *      delegate that is this motebit (by id or by key) is refused.
 *
 * The post-sign self-check with the real key stays the authority.
 */
export async function precheckRepoTaskDelegation(
  req: Omit<RepoTaskDelegationRequest, "principal">,
  principal: RepoTaskPin,
): Promise<RepoTaskRefusal[]> {
  const probe = await generateKeypair();
  let dryRun: RepoTaskDelegation;
  try {
    dryRun = await mintRepoTaskDelegation({
      ...req,
      principal: {
        motebitId: principal.motebit_id,
        publicKeyHex: bytesToHex(probe.publicKey),
        privateKey: probe.privateKey,
      },
    });
  } catch (err) {
    if (err instanceof RepoTaskDelegationRefusedError) return [...err.failures];
    throw err;
  } finally {
    secureErase(probe.privateKey);
  }
  const out: RepoTaskRefusal[] = [];
  checkRepoChangeParties(
    {
      ...dryRun.grant,
      delegator_id: principal.motebit_id,
      delegator_public_key: principal.public_key,
    },
    { principal, agents: [req.delegate] },
    (code, detail) => out.push({ code, detail }),
  );
  return out;
}

/**
 * A grant_id's one spelling, judged before any key by the revocation-set rule
 * itself (`checkRepoChangeRevocationSet`, the strict parse a run and the
 * verifier apply to `.motebit/revocations/`): a revocation of it, signed under
 * an ephemeral key generated and erased here, must parse as well-formed.
 */
export async function grantIdRefusals(grantId: string): Promise<RepoTaskRefusal[]> {
  const probe = await generateKeypair();
  const key = bytesToHex(probe.publicKey);
  try {
    const rev = await signDelegationRevocation(
      {
        grant_id: grantId,
        delegator_id: "repo-task-precheck",
        delegator_public_key: key,
        revoked_at: 0,
      },
      probe.privateKey,
    );
    const out: RepoTaskRefusal[] = [];
    await checkRepoChangeRevocationSet(
      { grant_id: grantId, delegator_public_key: key },
      { set: [rev], failures: [] },
      (code, detail) => {
        if (code === "revocation.repo_change.set_malformed") {
          out.push({
            code,
            detail: `grant_id ${JSON.stringify(grantId)} is not a lowercase UUID (${detail})`,
          });
        }
      },
    );
    return out;
  } finally {
    secureErase(probe.privateKey);
  }
}

/**
 * A grant read from its own file, judged before the principal's key is
 * unlocked: the verifier's strict grant shape, a canonical base64url
 * signature, a canonical grant_id (the revocation-set rule), a signature that
 * verifies under the grant's own `delegator_public_key` (`verifyStandingDelegation`,
 * which also refuses a non-canonical key), and that key being the configured
 * principal's — the only key whose revocation can bind it. Nothing else is
 * read: a revocation binds by `grant_id` and the delegator key alone
 * (standing-delegation-v1 §5).
 */
export async function grantRefusals(
  grant: unknown,
  principal: RepoTaskPin,
): Promise<RepoTaskRefusal[]> {
  if (!isRepoChangeGrantShape(grant)) {
    return [
      {
        code: "integrity.repo_change.bundle_malformed",
        detail: "grant.json is not a StandingDelegation of the strict shape",
      },
    ];
  }
  const out: RepoTaskRefusal[] = [...(await grantIdRefusals(grant.grant_id))];
  if (!isCanonicalBase64Url(grant.signature)) {
    out.push({
      code: "integrity.repo_change.value_not_canonical",
      detail: "the grant's signature is not canonical base64url",
    });
  }
  if (
    !(await verifyStandingDelegation(grant, { checkExpiry: false, now: Number.MAX_SAFE_INTEGER }))
  ) {
    out.push({
      code: "integrity.repo_change.signature_invalid",
      detail:
        "the grant's signature does not verify under its own delegator key: it is not a grant that key signed",
    });
  }
  if (grant.delegator_public_key !== principal.public_key) {
    out.push({
      code: "revoke.not_delegator",
      detail:
        "this motebit's key is not the grant's delegator key, so its revocation would bind nothing (spec/standing-delegation-v1.md §5)",
    });
  }
  return out;
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

/** An output file already exists; nothing was overwritten. */
export class CanonicalFileExistsError extends Error {
  constructor(
    readonly dir: string,
    readonly file: string,
  ) {
    super(`could not write ${dir}: ${file} already exists`);
    this.name = "CanonicalFileExistsError";
  }
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
  let failedFile: string | null = null;
  try {
    mkdirOwnerOnly(dir);
    for (const [name, text] of contents) {
      const file = path.join(dir, name);
      failedFile = file;
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
    if ((err as NodeJS.ErrnoException).code === "EEXIST" && failedFile !== null) {
      throw new CanonicalFileExistsError(dir, failedFile);
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

/** What a revocation binds: a grant's id and its delegator key (standing-delegation-v1 §5). */
export interface RevocationTarget {
  readonly grant_id: string;
  readonly delegator_id: string;
  readonly delegator_public_key: string;
}

/**
 * Sign a revocation of `target` with the loaded principal key, and self-check
 * it with the revocation-set rule a run and the verifier apply to
 * `.motebit/revocations/` (`checkRepoChangeRevocationSet`: strict parse, then
 * `findGrantRevocation`): it must be well-formed AND bind the target. A key
 * that is not the target's delegator key yields a revocation that binds
 * nothing, so it is refused, never written.
 */
export async function mintRepoTaskRevocation(input: {
  readonly target: RevocationTarget;
  readonly principal: RepoTaskPrincipal;
  readonly now: number;
}): Promise<DelegationRevocation> {
  const { target, principal, now } = input;
  const signed = await signDelegationRevocation(
    {
      grant_id: target.grant_id,
      delegator_id: target.delegator_id,
      // The key that actually signs: a revocation states who signed it.
      delegator_public_key: principal.publicKeyHex,
      revoked_at: now,
    },
    principal.privateKey,
  ).catch((err: unknown) => {
    throw new RepoTaskDelegationRefusedError([
      {
        code: "integrity.repo_change.value_not_canonical",
        detail: err instanceof Error ? err.message : String(err),
      },
    ]);
  });
  const malformed: RepoTaskRefusal[] = [];
  const { binding } = await checkRepoChangeRevocationSet(
    target,
    { set: [signed], failures: [] },
    (code, detail) => {
      if (code === "revocation.repo_change.set_malformed") malformed.push({ code, detail });
    },
  );
  if (malformed.length > 0) throw new RepoTaskDelegationRefusedError(malformed);
  if (binding === null) {
    throw new RepoTaskDelegationRefusedError([
      {
        code: "revoke.not_delegator",
        detail:
          "the revocation would bind nothing: the loaded key is not the grant's delegator key",
      },
    ]);
  }
  return signed;
}

/** Mint and self-check the revocation, then write it into `dir` as `<grant_id>.json`. */
export async function revokeToDirectory(
  input: Parameters<typeof mintRepoTaskRevocation>[0],
  dir: string,
): Promise<{ revocation: DelegationRevocation; file: string }> {
  const revocation = await mintRepoTaskRevocation(input);
  try {
    const [file] = writeCanonicalFiles(dir, { [`${revocation.grant_id}.json`]: revocation });
    return { revocation, file: file! };
  } catch (err) {
    if (err instanceof CanonicalFileExistsError) {
      throw new RepoTaskDelegationRefusedError([
        {
          code: "file.exists",
          detail: `a revocation for ${revocation.grant_id} already exists at ${err.file}`,
        },
      ]);
    }
    throw err;
  }
}

/** Read a grant file as JSON (shape is judged by `grantRefusals`). */
export function readGrantFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (err) {
    throw new Error(`could not read ${file}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
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
