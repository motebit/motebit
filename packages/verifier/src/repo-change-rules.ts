/**
 * Governed repo change — the shared rules (spec/repo-change-v1.md §4–§7).
 *
 * ONE LAW, ONE IMPLEMENTATION: the predicates both judges of a repo change
 * run — `verifyRepoChange` over a landed bundle, and the repo-task run
 * (`@motebit/runtime`) before its first model call and on every tool call.
 * A second copy of a security rule drifts; this module is the only copy.
 *
 * Pure: no git, no file I/O, no clock. Every `check*` reports each failed rule
 * through the caller's sink with its repo-change repair code, in a fixed
 * order (the verdict's `repair` names the first failure of an axis).
 */

import { fromBase64Url, isScopeNarrowed, toBase64Url } from "@motebit/crypto";
import type { DelegationToken, StandingDelegation, VerificationVerdict } from "@motebit/crypto";
import {
  ALL_GIT_OBJECT_FORMATS,
  ALL_REPO_CHANGE_TOOLS,
  REPO_CHANGE_MAX_GRANT_LIFETIME_MS,
  REPO_CHANGE_SUBJECT,
  REPO_TASK_BASE_REF,
  REPO_TASK_SCOPE_SCHEMA,
  REPO_TASK_SCOPE_SPEC_ID,
} from "@motebit/protocol";
import type { RepoChangeRepairCode, RepoChangeTool, RepoTaskScope } from "@motebit/protocol";

/** Receives one failed rule: its repair code and what failed. */
export type RepoChangeRuleSink = (code: RepoChangeRepairCode, detail: string) => void;

/** A pinned identity: the `(motebit_id, public_key)` pair a role file holds. */
export interface RepoChangePin {
  readonly motebit_id: string;
  readonly public_key: string;
}

/** The pins at the commit being judged, typed by role. */
export interface RepoChangePins {
  /** `.motebit/principals/principal.md` — absent means no principal is pinned. */
  readonly principal: RepoChangePin | null;
  /** `.motebit/principals/agents/*.md`. */
  readonly agents: readonly RepoChangePin[];
}

const PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** @internal */
export type Json = Record<string, unknown>;

// -- Small strict-shape helpers (internal to the package; not re-exported) --

export function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Exactly the `required` keys, plus any of the `optional` ones, and nothing else. */
export function hasExactKeys(
  o: Json,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  for (const k of required) if (!Object.prototype.hasOwnProperty.call(o, k)) return false;
  for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) return false;
  return true;
}

export function isString(v: unknown): v is string {
  return typeof v === "string";
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Canonical unpadded base64url: `toBase64Url(fromBase64Url(s)) === s` (spec §4). */
export function isCanonicalBase64Url(s: string): boolean {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return false;
  try {
    return toBase64Url(fromBase64Url(s)) === s;
  } catch {
    return false;
  }
}

/** The scope's path rule (spec §4): ASCII segments, no `.`/`..`/`.git` (any case), no empty segment. */
export function isCanonicalRepoPath(p: string): boolean {
  for (const seg of p.split("/")) {
    if (!PATH_SEGMENT.test(seg)) return false;
    // A trailing "." (".", "..", "a.", ".git.") is an alias on NTFS, which drops it.
    if (seg.endsWith(".") || seg.toLowerCase() === ".git") return false;
  }
  return true;
}

/**
 * A grant/tick/receipt capability list in its one spelling: comma-separated
 * repo-change tool names, no spaces, no repeats. Anything else is `null`.
 */
export function parseRepoChangeTools(scope: string): Set<RepoChangeTool> | null {
  const out = new Set<RepoChangeTool>();
  for (const part of scope.split(",")) {
    const tool = ALL_REPO_CHANGE_TOOLS.find((t) => t === part);
    if (tool === undefined || out.has(tool)) return null;
    out.add(tool);
  }
  return out;
}

const strictTools = parseRepoChangeTools;

/** A repo-task scope of the strict shape (spec §3.1): exactly its keys, each well-typed. */
export function isRepoTaskScopeShape(v: unknown): v is RepoTaskScope {
  return (
    isObject(v) &&
    hasExactKeys(v, [
      "schema",
      "spec",
      "repo",
      "base_ref",
      "object_format",
      "allowed_paths",
      "max_changed_files",
      "task",
    ]) &&
    v.schema === REPO_TASK_SCOPE_SCHEMA &&
    v.spec === REPO_TASK_SCOPE_SPEC_ID &&
    isNonEmptyString(v.repo) &&
    v.base_ref === REPO_TASK_BASE_REF &&
    (ALL_GIT_OBJECT_FORMATS as readonly unknown[]).includes(v.object_format) &&
    Array.isArray(v.allowed_paths) &&
    v.allowed_paths.length > 0 &&
    v.allowed_paths.every(isString) &&
    Number.isSafeInteger(v.max_changed_files) &&
    (v.max_changed_files as number) >= 1 &&
    isNonEmptyString(v.task)
  );
}

/**
 * The grant's and the tick's authority windows (spec §5): each starts at
 * max(`issued_at`, `not_before`). Crypto judges `not_before` and expiry; these
 * bound the rest from `issued_at`, so a future-dated or back-dated grant or
 * tick cannot open a window wider than the one the grant states.
 */
export function repoChangeAuthorityWindow(
  grant: StandingDelegation,
  tick: DelegationToken,
): { grantStart: number; tickStart: number } {
  const grantStart = Math.max(grant.issued_at, grant.not_before ?? grant.issued_at);
  const tickStart = Math.max(tick.issued_at, tick.not_before ?? tick.issued_at);
  return { grantStart, tickStart };
}

/**
 * The tick's structure against the grant, clockless: both windows the right
 * way round, the tick issued no earlier than the grant, and the tick a tick
 * of this grant (grant_id, parties, scope within the grant's, TTL).
 */
export function checkRepoChangeTickStructure(
  grant: StandingDelegation,
  tick: DelegationToken,
  fail: RepoChangeRuleSink,
): void {
  const { grantStart, tickStart } = repoChangeAuthorityWindow(grant, tick);
  if (grantStart > grant.expires_at) {
    fail("authority.repo_change.window_inverted", "the grant starts after it expires");
  }
  if (tickStart > tick.expires_at) {
    fail("authority.repo_change.window_inverted", "the tick starts after it expires");
  }
  if (tick.issued_at < grant.issued_at) {
    fail("authority.repo_change.tick_predates_grant", "tick.issued_at < grant.issued_at");
  }
  // The tick's STRUCTURE, judged from its own properties against the grant and
  // independent of any clock, so a structural failure is never masked by a
  // temporal one. Deliberately NOT crypto's grant-at-the-tick's-slot step: the
  // grant is judged at the evaluation time (standing-delegation-v1 §4), so a
  // pre-minted tick whose slot precedes the grant's not_before stays valid.
  if (tick.grant_id !== grant.grant_id) {
    fail("authority.repo_change.tick_insufficient", "tick.grant_id is not the grant's");
  }
  if (
    tick.delegator_id !== grant.delegator_id ||
    tick.delegator_public_key !== grant.delegator_public_key
  ) {
    fail("authority.repo_change.tick_insufficient", "the tick's delegator is not the grant's");
  }
  if (
    tick.delegate_id !== grant.delegate_id ||
    tick.delegate_public_key !== grant.delegate_public_key
  ) {
    fail("authority.repo_change.tick_insufficient", "the tick's delegate is not the grant's");
  }
  if (!isScopeNarrowed(grant.scope, tick.scope)) {
    fail("authority.repo_change.tick_insufficient", "the tick's scope is wider than the grant's");
  }
  if (tick.expires_at - tick.issued_at > grant.max_token_ttl_ms) {
    fail("authority.repo_change.tick_insufficient", "the tick's TTL exceeds max_token_ttl_ms");
  }
}

/**
 * The window at the evaluation time. `now` is `null` when no time could be
 * accepted; `wallClock` is `verifyDelegationTokenVerdict(tick, grant, { now,
 * temporalMode: "wall_clock" })` at that time (`null` with `now`). `failures`
 * are the rules already failed, so a structural `tick_insufficient` is never
 * reported twice.
 */
export function checkRepoChangeWindow(
  input: {
    readonly grant: StandingDelegation;
    readonly tick: DelegationToken;
    readonly now: number | null;
    readonly wallClock: Pick<VerificationVerdict, "authority"> | null;
    readonly failures: readonly { readonly code: RepoChangeRepairCode }[];
  },
  fail: RepoChangeRuleSink,
): void {
  const { grant, tick, now, wallClock, failures } = input;
  const { grantStart, tickStart } = repoChangeAuthorityWindow(grant, tick);
  // A structural `insufficient` reported before this still outranks whatever
  // these report (the verifier's finish()).
  if (now === null || wallClock === null) {
    fail("authority.repo_change.time_unavailable", "the evaluation time could not be accepted");
  } else if (now < grantStart) {
    fail(
      "authority.repo_change.grant_not_yet_valid",
      "the grant was not yet active at the evaluation time",
    );
  } else if (wallClock.authority === "expired" || now > grant.expires_at) {
    fail("authority.repo_change.tick_expired", "the tick had expired at the evaluation time");
  } else if (now < tickStart) {
    // `tickStart` is max(issued_at, not_before): it covers crypto's own
    // not_before check and the issued_at bound crypto does not make.
    fail(
      "authority.repo_change.tick_not_yet_valid",
      "the tick was not yet valid (issued_at or not_before) at the evaluation time",
    );
  } else if (
    wallClock.authority !== "valid" &&
    !failures.some((f) => f.code === "authority.repo_change.tick_insufficient")
  ) {
    // Inside both windows, structure sound, yet crypto refuses the tick at
    // this time: the grant itself does not verify (e.g. its signature). Fail
    // closed, once — a structural fault above already reported this.
    fail(
      "authority.repo_change.tick_insufficient",
      "the grant does not verify at the evaluation time",
    );
  }
}

/**
 * The repo-change grant rules: the tick within the grant's lifetime, the
 * scope bound (`subject_binding` of the scope schema), subject `repo-change`,
 * grant and tick scopes strict repo-change tool lists, a lifetime of at most
 * 24 hours, no spend ceiling, cadence no less than the lifetime. Returns the
 * tick's tool set (`null` when its scope is not a strict tool list).
 */
export function checkRepoChangeGrantShape(
  grant: StandingDelegation,
  tick: DelegationToken,
  fail: RepoChangeRuleSink,
): Set<RepoChangeTool> | null {
  const { grantStart } = repoChangeAuthorityWindow(grant, tick);
  if (tick.expires_at > grant.expires_at) {
    fail("authority.repo_change.tick_outlives_grant", "tick.expires_at > grant.expires_at");
  }
  if (grant.subject_binding === undefined) {
    fail("authority.repo_change.subject_binding_absent", "the grant has no subject_binding");
  } else if (grant.subject_binding.artifact_schema !== REPO_TASK_SCOPE_SCHEMA) {
    fail(
      "authority.repo_change.subject_binding_wrong_schema",
      `subject_binding.artifact_schema is ${JSON.stringify(grant.subject_binding.artifact_schema)}`,
    );
  }
  if (grant.subject !== REPO_CHANGE_SUBJECT) {
    fail(
      "authority.repo_change.subject_wrong",
      `grant.subject is ${JSON.stringify(grant.subject)}`,
    );
  }
  if (strictTools(grant.scope) === null) {
    fail(
      "authority.repo_change.scope_tools_outside",
      `grant.scope is ${JSON.stringify(grant.scope)}`,
    );
  }
  const tickTools = strictTools(tick.scope);
  if (tickTools === null) {
    fail(
      "authority.repo_change.scope_tools_outside",
      `tick.scope is ${JSON.stringify(tick.scope)}`,
    );
  }
  const lifetime = grant.expires_at - grantStart;
  if (lifetime > REPO_CHANGE_MAX_GRANT_LIFETIME_MS) {
    fail("authority.repo_change.lifetime_exceeded", `the grant lives ${lifetime} ms`);
  }
  if (grant.spend_ceiling !== undefined) {
    fail("authority.repo_change.spend_ceiling_present", "the grant carries a spend_ceiling");
  }
  if (grant.cadence_ms < lifetime) {
    fail(
      "authority.repo_change.cadence_below_lifetime",
      `cadence_ms ${grant.cadence_ms} < lifetime ${lifetime}`,
    );
  }
  return tickTools;
}

/**
 * The pins: the delegator is the principal pin, the delegate an agent pin,
 * and they are two identities — each matched as a `(motebit_id, public_key)`
 * pair, byte for byte.
 */
export function checkRepoChangeParties(
  grant: StandingDelegation,
  pins: RepoChangePins,
  fail: RepoChangeRuleSink,
): void {
  const principal = pins.principal;
  if (
    principal === null ||
    grant.delegator_id !== principal.motebit_id ||
    grant.delegator_public_key !== principal.public_key
  ) {
    fail(
      "identity.repo_change.delegator_not_principal",
      "the grant's delegator is not the principal pin",
    );
  }
  if (
    !pins.agents.some(
      (a) => a.motebit_id === grant.delegate_id && a.public_key === grant.delegate_public_key,
    )
  ) {
    fail("identity.repo_change.delegate_not_agent", "the grant's delegate is not an agent pin");
  }
  if (
    grant.delegator_id === grant.delegate_id ||
    grant.delegator_public_key === grant.delegate_public_key
  ) {
    fail(
      "identity.repo_change.delegator_is_delegate",
      "the grant's delegator and delegate are one identity",
    );
  }
}
