/**
 * Repo task — the run's authority check (docs/proposals/governed-repo-change-v1.md
 * § "The chain", step 4; spec/repo-change-v1.md §5).
 *
 * One pure function, `checkRepoTaskAuthority`, run before the first model
 * call and again before every tool call. It holds the run to the law a
 * verifier will later hold the landed change to — and it does so by calling
 * the verifier's own rules (`@motebit/verifier`'s repo-change rules module:
 * scope shape and canonical paths, the tick's structure against the grant,
 * the window at the run's clock, the grant rules, the pins), never a copy of
 * them. One law, one implementation. What is added here is only what exists
 * before a change does: the run's clock, the revocations read at preflight,
 * and this agent as the one pinned delegate.
 *
 * Deliberately NOT the money path: `verifyGrantForTurn` / `TurnContext.verifiedGrant`
 * require delegator = this runtime and gate R4 spending
 * (docs/doctrine/memory-never-confers-authority.md). A repo task's delegator
 * is the principal, its delegate is this agent, and nothing here touches money.
 */

import {
  verifyDelegationTokenVerdict,
  verifyStandingDelegation,
  verifySubjectBinding,
} from "@motebit/crypto";
import type { DelegationRevocation, DelegationToken, StandingDelegation } from "@motebit/crypto";
import type { RepoChangeRepairCode, RepoChangeTool, RepoTaskScope } from "@motebit/protocol";
import {
  checkRepoChangeGrantShape,
  checkRepoChangeParties,
  checkRepoChangeRevocationSet,
  checkRepoChangeTickStructure,
  checkRepoChangeWindow,
  isCanonicalBase64Url,
  isCanonicalRepoPath,
  isRepoChangeGrantShape,
  isRepoChangeTickShape,
  isRepoTaskScopeShape,
} from "@motebit/verifier";

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

/** One failed rule, with the repo-change repair code the verifier would report. */
export interface RepoTaskAuthorityFailure {
  readonly code: RepoChangeRepairCode;
  readonly detail: string;
}

export type RepoTaskAuthorityCheck =
  | { readonly ok: true; readonly tools: ReadonlySet<RepoChangeTool> }
  | { readonly ok: false; readonly failures: readonly RepoTaskAuthorityFailure[] };

const HEX64 = /^[0-9a-f]{64}$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  const failures: RepoTaskAuthorityFailure[] = [];
  const fail = (code: RepoChangeRepairCode, detail: string): void => {
    failures.push({ code, detail });
  };
  const { scope, grant, tick, revocations, principal } = bundle;
  const clock = typeof now === "number" && Number.isFinite(now) ? now : null;

  // -- Strict shapes first, the verifier's own: a scope, grant or tick that is
  // not of its exact shape (an extra signed key, a missing one) is judged no
  // further, as the verifier judges a malformed bundle no further.
  const malformed = (
    [
      ["the scope", isRepoTaskScopeShape(scope)],
      ["the grant", isRepoChangeGrantShape(grant)],
      ["the tick", isRepoChangeTickShape(tick)],
    ] as const
  ).filter(([, ok]) => !ok);
  if (malformed.length > 0) {
    return {
      ok: false,
      failures: malformed.map(([what]) => ({
        code: "integrity.repo_change.bundle_malformed" as const,
        detail: `${what} is not of the strict shape`,
      })),
    };
  }

  // -- The scope's canonical paths, the predicate, the repo.
  const seen = new Set<string>();
  for (const p of scope.allowed_paths) {
    if (!isCanonicalRepoPath(p)) {
      fail("integrity.repo_change.value_not_canonical", `allowed path ${JSON.stringify(p)}`);
    } else if (!bundle.isPathPermitted(p)) {
      fail("authority.repo_change.scope_path_not_permitted", `allowed path ${JSON.stringify(p)}`);
    }
    if (seen.has(p)) {
      fail(
        "integrity.repo_change.value_not_canonical",
        `allowed path ${JSON.stringify(p)} repeats`,
      );
    }
    seen.add(p);
  }
  if (scope.repo !== bundle.expectedRepo) {
    fail("authority.repo_change.repo_mismatch", "the scope names another repository");
  }

  // -- Canonical values: one spelling each (spec §4).
  for (const [what, key] of [
    ["grant.delegator_public_key", grant.delegator_public_key],
    ["grant.delegate_public_key", grant.delegate_public_key],
    ["tick.delegator_public_key", tick.delegator_public_key],
    ["tick.delegate_public_key", tick.delegate_public_key],
    ["agent.public_key", agent.public_key],
    ["principal.public_key", principal.public_key],
  ] as const) {
    if (typeof key !== "string" || !HEX64.test(key)) {
      fail("integrity.repo_change.value_not_canonical", `${what} is not 64 lowercase hex`);
    }
  }
  for (const [what, sig] of [
    ["grant.signature", grant.signature],
    ["tick.signature", tick.signature],
  ] as const) {
    if (typeof sig !== "string" || !isCanonicalBase64Url(sig)) {
      fail("integrity.repo_change.value_not_canonical", `${what} is not canonical base64url`);
    }
  }
  if (!CANONICAL_UUID.test(grant.grant_id)) {
    fail("integrity.repo_change.value_not_canonical", "grant.grant_id is not a lowercase UUID");
  }
  if (grant.subject_binding !== undefined && !HEX64.test(grant.subject_binding.digest)) {
    fail(
      "integrity.repo_change.value_not_canonical",
      "grant.subject_binding.digest is not 64 lowercase hex",
    );
  }

  // -- Signatures, each clockless (the window is judged below), and the binding.
  if (
    !(await verifyStandingDelegation(grant, { checkExpiry: false, now: Number.MAX_SAFE_INTEGER }))
  ) {
    fail("integrity.repo_change.signature_invalid", "the grant's signature does not verify");
  }
  if (grant.subject_binding !== undefined) {
    const match = await verifySubjectBinding(grant.subject_binding, scope);
    if (!match.valid) {
      fail("integrity.repo_change.scope_binding_mismatch", match.error ?? "no match");
    }
  }
  // The tick's verdict at the run's clock: its integrity is the tick's
  // signature; its authority feeds the shared window rule.
  const verdict =
    clock === null
      ? null
      : await verifyDelegationTokenVerdict(tick, grant, {
          // Revocation is judged below by the strict set rule, not here.
          now: clock,
          temporalMode: "wall_clock",
        });
  if (verdict !== null && verdict.integrity !== "verified") {
    fail("integrity.repo_change.signature_invalid", "the tick's signature does not verify");
  }

  // -- Identity: the verifier's pin rules, with this agent as the one agent pin.
  checkRepoChangeParties(grant, { principal, agents: [agent] }, fail);

  // -- Authority: the verifier's tick-structure, window and grant rules, at the run's clock.
  checkRepoChangeTickStructure(grant, tick, fail);
  checkRepoChangeWindow({ grant, tick, now: clock, wallClock: verdict, failures }, fail);
  const tickTools = checkRepoChangeGrantShape(grant, tick, fail);

  // -- Revocation: the set read at preflight, parsed strictly by the
  // verifier's own rule — a malformed entry is set_malformed, never skipped.
  await checkRepoChangeRevocationSet(grant, revocations, fail);

  if (failures.length > 0 || tickTools === null) {
    return {
      ok: false,
      failures:
        failures.length > 0
          ? failures
          : [{ code: "authority.repo_change.scope_tools_outside", detail: "no authorized tools" }],
    };
  }
  return { ok: true, tools: tickTools };
}
