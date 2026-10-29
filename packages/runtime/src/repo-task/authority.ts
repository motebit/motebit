/**
 * Repo task — the run's authority check (docs/proposals/governed-repo-change-v1.md
 * § "The chain", step 4; spec/repo-change-v1.md §5).
 *
 * One pure function, `checkRepoTaskAuthority`, run before the first model
 * call and again before every tool call. It judges the tick against the grant
 * at the run's clock through the shipped `verifyDelegationTokenVerdict`, and
 * the repo-change rules a verifier will later hold the landed change to:
 * scope bound into the grant, the two-tool ceiling, the 24-hour lifetime, no
 * spend ceiling, cadence ≥ lifetime, the strictly parsed revocations read at
 * preflight, and the pins (delegator = principal pin, delegate = this agent).
 *
 * Deliberately NOT the money path: `verifyGrantForTurn` / `TurnContext.verifiedGrant`
 * require delegator = this runtime and gate R4 spending
 * (docs/doctrine/memory-never-confers-authority.md). A repo task's delegator
 * is the principal, its delegate is this agent, and nothing here touches money.
 *
 * Mirrors the authority and identity rules of `verifyRepoChange`
 * (`@motebit/verifier`, step 1) for the subset that exists before a change
 * does. The verifier stays the judge of the landed change; this check only
 * keeps the run from acting on authority the verifier would refuse.
 */

import {
  findGrantRevocation,
  fromBase64Url,
  isScopeNarrowed,
  toBase64Url,
  verifyDelegationTokenVerdict,
  verifyStandingDelegation,
  verifySubjectBinding,
} from "@motebit/crypto";
import type { DelegationRevocation, DelegationToken, StandingDelegation } from "@motebit/crypto";
import {
  ALL_GIT_OBJECT_FORMATS,
  ALL_REPO_CHANGE_TOOLS,
  REPO_CHANGE_MAX_GRANT_LIFETIME_MS,
  REPO_CHANGE_SUBJECT,
  REPO_TASK_BASE_REF,
  REPO_TASK_SCOPE_SCHEMA,
  REPO_TASK_SCOPE_SPEC_ID,
} from "@motebit/protocol";
import type { RepoChangeTool, RepoTaskScope } from "@motebit/protocol";

/** A pinned identity: the `(motebit_id, public_key)` pair a role file holds. */
export interface RepoTaskPin {
  readonly motebit_id: string;
  /** 64 lowercase hex. */
  readonly public_key: string;
}

/**
 * The revocations under `.motebit/revocations/` at the tip, parsed strictly by
 * the preflight (file name = `grant_id`, canonical key and base64url,
 * verifying signature). Any `failures` entry makes the run refuse to start:
 * a malformed revocation can never be silently ignored.
 */
export interface RepoTaskRevocations {
  readonly set: readonly DelegationRevocation[];
  readonly failures: readonly string[];
  /** The commit they were read at. */
  readonly readAt: string;
}

/**
 * The pre-verified authority bundle a repo-task run takes as input — the seam
 * step 4's CLI preflight fills (git tip, pins, revocations, worktree clean,
 * path predicate from data). The run re-checks everything in it that can be
 * checked without git, before the first model call and on every tool call.
 */
export interface RepoTaskAuthorityBundle {
  readonly scope: RepoTaskScope;
  readonly grant: StandingDelegation;
  readonly tick: DelegationToken;
  /** Read once at preflight; continuous re-reading during the run is milestone C's. */
  readonly revocations: RepoTaskRevocations;
  /** The principal pin at the tip (`.motebit/principals/principal.md`). */
  readonly principal: RepoTaskPin;
  /** The repository the change lands in; the scope's `repo` must equal it byte for byte. */
  readonly expectedRepo: string;
  /** The repository's path predicate at the tip, interpreted from data. Pure. */
  readonly isPathPermitted: (path: string) => boolean;
}

export type RepoTaskAuthorityCheck =
  | { readonly ok: true; readonly tools: ReadonlySet<RepoChangeTool> }
  | { readonly ok: false; readonly failures: readonly string[] };

const HEX64 = /^[0-9a-f]{64}$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * The scope's path rule (spec/repo-change-v1.md §4): ASCII segments
 * `[A-Za-z0-9._-]+` joined by `/`; no segment ends in `.` (so no `.`, `..`,
 * `a.`) and none is `.git` in any case. The same rule as the verifier's.
 */
export function isCanonicalRepoPath(p: string): boolean {
  if (p.length === 0) return false;
  for (const seg of p.split("/")) {
    if (!PATH_SEGMENT.test(seg)) return false;
    if (seg.endsWith(".") || seg.toLowerCase() === ".git") return false;
  }
  return true;
}

function isCanonicalBase64Url(s: string): boolean {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return false;
  try {
    return toBase64Url(fromBase64Url(s)) === s;
  } catch {
    return false;
  }
}

/**
 * A capability list in its one spelling: comma-separated repo-change tool
 * names, no spaces, no repeats. Anything else is `null`.
 */
export function parseRepoTaskTools(scope: string): Set<RepoChangeTool> | null {
  const out = new Set<RepoChangeTool>();
  for (const part of scope.split(",")) {
    const tool = ALL_REPO_CHANGE_TOOLS.find((t) => t === part);
    if (tool === undefined || out.has(tool)) return null;
    out.add(tool);
  }
  return out;
}

/**
 * Judge the run's authority at `now`. Fails closed: any rule that does not
 * hold is a failure, and only an empty failure list authorizes. `agent` is
 * the identity signing the run's receipts (this runtime's A).
 */
export async function checkRepoTaskAuthority(
  bundle: RepoTaskAuthorityBundle,
  agent: RepoTaskPin,
  now: number,
): Promise<RepoTaskAuthorityCheck> {
  const failures: string[] = [];
  const fail = (why: string): void => {
    failures.push(why);
  };
  const { scope, grant, tick, revocations, principal } = bundle;

  if (typeof now !== "number" || !Number.isFinite(now)) {
    return { ok: false, failures: ["the run's clock is not a finite time"] };
  }

  // -- The scope: strict shape, canonical paths, the predicate, the repo.
  if (
    scope.schema !== REPO_TASK_SCOPE_SCHEMA ||
    scope.spec !== REPO_TASK_SCOPE_SPEC_ID ||
    scope.base_ref !== REPO_TASK_BASE_REF ||
    !ALL_GIT_OBJECT_FORMATS.includes(scope.object_format) ||
    typeof scope.task !== "string" ||
    scope.task.length === 0 ||
    !Number.isSafeInteger(scope.max_changed_files) ||
    scope.max_changed_files < 1 ||
    !Array.isArray(scope.allowed_paths) ||
    scope.allowed_paths.length === 0
  ) {
    fail("the scope is not a repo-task scope of the strict shape");
  } else {
    const seen = new Set<unknown>();
    for (const p of scope.allowed_paths as readonly unknown[]) {
      if (typeof p !== "string" || !isCanonicalRepoPath(p)) {
        fail(`allowed path ${JSON.stringify(p)} is not canonical`);
      } else if (!bundle.isPathPermitted(p)) {
        fail(`allowed path ${JSON.stringify(p)} fails the repository's path predicate`);
      }
      if (seen.has(p)) fail(`allowed path ${JSON.stringify(p)} repeats`);
      seen.add(p);
    }
  }
  if (scope.repo !== bundle.expectedRepo) fail("the scope names another repository");

  // -- Canonical values: one spelling each.
  for (const [what, key] of [
    ["grant.delegator_public_key", grant.delegator_public_key],
    ["grant.delegate_public_key", grant.delegate_public_key],
    ["tick.delegator_public_key", tick.delegator_public_key],
    ["tick.delegate_public_key", tick.delegate_public_key],
    ["agent.public_key", agent.public_key],
    ["principal.public_key", principal.public_key],
  ] as const) {
    if (typeof key !== "string" || !HEX64.test(key)) fail(`${what} is not 64 lowercase hex`);
  }
  for (const [what, sig] of [
    ["grant.signature", grant.signature],
    ["tick.signature", tick.signature],
  ] as const) {
    if (typeof sig !== "string" || !isCanonicalBase64Url(sig)) {
      fail(`${what} is not canonical base64url`);
    }
  }
  if (!CANONICAL_UUID.test(grant.grant_id)) fail("grant.grant_id is not a lowercase UUID");

  // -- The grant: signed, active, unexpired, bound to this scope, repo-change shaped.
  if (!(await verifyStandingDelegation(grant, { now }))) {
    fail("the grant does not verify at the run's clock (signature, not_before or expiry)");
  }
  if (grant.subject !== REPO_CHANGE_SUBJECT)
    fail(`the grant's subject is not "${REPO_CHANGE_SUBJECT}"`);
  if (grant.subject_binding === undefined) {
    fail("the grant carries no subject_binding");
  } else if (grant.subject_binding.artifact_schema !== REPO_TASK_SCOPE_SCHEMA) {
    fail("the grant's subject_binding binds another artifact schema");
  } else {
    const match = await verifySubjectBinding(grant.subject_binding, scope);
    if (!match.valid)
      fail(`the scope is not the one the grant binds: ${match.error ?? "no match"}`);
  }
  if (grant.spend_ceiling !== undefined) fail("the grant carries a spend_ceiling");
  const grantTools = parseRepoTaskTools(grant.scope);
  if (grantTools === null) fail("the grant's scope is not a repo-change tool list");
  const tickTools = parseRepoTaskTools(tick.scope);
  if (tickTools === null) fail("the tick's scope is not a repo-change tool list");
  const grantStart = Math.max(grant.issued_at, grant.not_before ?? grant.issued_at);
  const tickStart = Math.max(tick.issued_at, tick.not_before ?? tick.issued_at);
  const lifetime = grant.expires_at - grantStart;
  if (lifetime < 0) fail("the grant starts after it expires");
  if (lifetime > REPO_CHANGE_MAX_GRANT_LIFETIME_MS) fail("the grant lives longer than 24 hours");
  if (!(grant.cadence_ms >= lifetime)) fail("the grant's cadence_ms is less than its lifetime");

  // -- The tick against the grant, at the run's clock.
  if (tick.grant_id !== grant.grant_id) fail("the tick's grant_id is not the grant's");
  if (
    tick.delegator_id !== grant.delegator_id ||
    tick.delegator_public_key !== grant.delegator_public_key ||
    tick.delegate_id !== grant.delegate_id ||
    tick.delegate_public_key !== grant.delegate_public_key
  ) {
    fail("the tick's parties are not the grant's");
  }
  if (!isScopeNarrowed(grant.scope, tick.scope)) fail("the tick's scope is wider than the grant's");
  if (tick.expires_at > grant.expires_at) fail("the tick outlives the grant");
  if (tick.issued_at < grant.issued_at) fail("the tick was issued before the grant");
  if (tickStart > tick.expires_at) fail("the tick starts after it expires");
  if (now < grantStart) fail("the grant is not yet active");
  if (now < tickStart) fail("the tick is not yet valid");
  if (now > tick.expires_at || now > grant.expires_at) fail("the tick has expired");
  const verdict = await verifyDelegationTokenVerdict(tick, grant, {
    revocations: revocations.set,
    // As of the tip commit the preflight read (`revocations.readAt`); the
    // freshness type has no commit field, so the time is left unstated.
    revocationFreshness: { basis: "asserted", asOf: {} },
    now,
    temporalMode: "wall_clock",
  });
  if (verdict.integrity !== "verified") fail("the tick's signature does not verify");
  if (verdict.authority !== "valid") fail(`the tick's authority is ${verdict.authority}`);

  // -- Revocation: the strictly parsed set read at preflight.
  if (revocations.failures.length > 0) {
    fail(
      `revocation is unchecked: ${revocations.failures.length} revocation file(s) failed strict parsing`,
    );
  }
  if (
    verdict.revocation.status !== "fresh" ||
    (await findGrantRevocation(grant, revocations.set))
  ) {
    fail(`the grant's revocation status is ${verdict.revocation.status}`);
  }

  // -- Identity: strict pins, (motebit_id, public_key) as pairs.
  if (
    grant.delegator_id !== principal.motebit_id ||
    grant.delegator_public_key !== principal.public_key
  ) {
    fail("the grant's delegator is not the principal pin");
  }
  if (grant.delegate_id !== agent.motebit_id || grant.delegate_public_key !== agent.public_key) {
    fail("this agent is not the grant's delegate");
  }
  if (
    grant.delegator_id === grant.delegate_id ||
    grant.delegator_public_key === grant.delegate_public_key
  ) {
    fail("the grant's delegator and delegate are one identity");
  }

  if (failures.length > 0 || tickTools === null) {
    return { ok: false, failures: failures.length > 0 ? failures : ["no authorized tools"] };
  }
  return { ok: true, tools: tickTools };
}
