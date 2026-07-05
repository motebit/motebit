/**
 * Grant blast-radius enforcement — the cumulative ceiling on autonomous spend
 * under a standing-delegation grant.
 *
 * ## What this is
 *
 * A pure, fail-closed enforcer that bounds the CUMULATIVE money an agent may move
 * autonomously under one grant — across turns, not just within a turn. It is the
 * "vault" that must exist before any standing-delegation auto-execution (R4_MONEY
 * with a `verifiedGrant`) is wired live: today's `BudgetEnforcer` bounds a single
 * turn; nothing bounds the decomposition attack (one large payment split into a
 * hundred individually-small ones across turns). This closes that, as a SECOND
 * fail-closed guard that composes with — never relaxes — the R4 standing-authority
 * invariant in `policy-gate.ts` (step 8b) and `check-money-authority`.
 *
 * ## Threat model — read this before trusting it
 *
 * These ceilings bind the **trusted-runtime / online path only**: an honest-but-
 * fallible runtime (a bug, a runaway agentic loop, prompt-injection that does NOT
 * compromise the signing key or this store), and any path where a trusted party
 * (the relay) holds the accumulator. They are **NOT an offline guarantee**. Per
 * `docs/doctrine/verify-family-fail-closed.md` §"Offline revocation freshness", a
 * cumulative counter the delegate tallies for itself does not bind a delegate that
 * is itself the adversary — a key/store-compromised delegate controls its own
 * `GrantSpendStore` and simply does not commit. Offline, the binding ceilings are
 * the grant's TOTAL SCOPE (`expires_at`), what each COUNTERPARTY independently
 * enforces against tokens it sees, and onchain rate caps at the rail
 * (`spec/settlement-v1.md` §"Onchain spending limits"). This module is the
 * trusted-runtime layer of that defense-in-depth stack — labeled honestly, never
 * sold as the offline cure.
 *
 * ## Don't collapse — this is a FOURTH spend boundary, not a merge
 *
 * Distinct from three existing primitives, deliberately:
 *   - per-turn resource budget — `BudgetEnforcer` (`./budget.ts`): calls/time/cost
 *     within ONE turn. Reset every turn. Resource, not money-destination.
 *   - goal self-execution budget — `checkGoalBudget` (`@motebit/runtime` `goals.ts`):
 *     a goal's own cumulative inference spend. Self-execution, token-axis.
 *   - per-task peer-delegation cap — `BudgetAllocation` (`@motebit/panels`
 *     `sovereign/controller.ts`): what a PEER agent may spend on one delegated task.
 * This is the grant-scoped ceiling on what THIS agent may spend AUTONOMOUSLY (no
 * human in the loop) under a standing grant. Self-execution vs peer-delegation vs
 * per-turn-resource vs autonomous-money: four boundaries. Don't collapse them.
 *
 * ## Layer
 *
 * BSL judgment (`@motebit/policy`). `GrantSpendState` is private accumulated state,
 * not interop law — it never crosses a wire, so it lives here, not in
 * `@motebit/protocol`. The signed-grant binding of `GrantSpendCeiling` (the ceiling
 * as the delegator's cryptographic commitment) is a later increment that will force
 * the wire shape against the published `StandingDelegation` artifact.
 */

import type { StandingDelegation } from "@motebit/protocol";

/**
 * The cumulative ceiling a grant authorizes. Fail-closed: a money grant MUST bound
 * total exposure, so at least one of `cumulative_limit_micro` / `lifetime_limit_micro`
 * is required (see `evaluateBlastRadius` — a ceiling with neither is denied). Every
 * limit is in integer micro-units (1 USD = 1,000,000); zero floating point on the
 * money path. A SET limit of `0` denies all positive spend on that dimension
 * (deny-all, not allow-all). Unset per-dimension limits do not bound that dimension,
 * but the required total bound still applies.
 *
 * Dimensions are an intentionally closed-extensible set (the `goals.ts` axis
 * pattern): a future axis (e.g. `capability_class_limit`) is an additive field, not
 * a signature change.
 */
export interface GrantSpendCeiling {
  /** Max cumulative spend within one rolling window. Requires `window_ms`. */
  readonly cumulative_limit_micro?: number;
  /** Max spend to any single (canonical) counterparty within one window. Requires `window_ms`. */
  readonly per_counterparty_limit_micro?: number;
  /** Max number of money actions within one window. Requires `window_ms`. */
  readonly max_action_count?: number;
  /**
   * Max cumulative spend over the grant's ENTIRE life — never reset by a window
   * roll. The offline-meaningful total bound (paired with the grant's `expires_at`).
   */
  readonly lifetime_limit_micro?: number;
  /** Rolling window length in ms. Required (and must be > 0) when any per-window limit is set. */
  readonly window_ms?: number;
}

/** A proposed autonomous money movement. `amount_micro` is integer micro-units, > 0. */
export interface MoneyAction {
  readonly amount_micro: number;
  /** Destination identity; canonicalized via `canonicalizeCounterparty` before bucketing. */
  readonly counterparty: string;
}

/**
 * Private per-grant accumulator. NOT interop law — never crosses a wire. The
 * window fields reset on roll; `lifetime_spent_micro` and `high_water_nonce` never do.
 */
export interface GrantSpendState {
  readonly grant_id: string;
  /** Injected-clock ms at which the current window opened. */
  readonly window_started_at: number;
  readonly window_spent_micro: number;
  readonly window_action_count: number;
  /** Canonical counterparty → spend within the current window. */
  readonly per_counterparty_micro: Readonly<Record<string, number>>;
  /** Cumulative spend over the grant's whole life. Never reset. */
  readonly lifetime_spent_micro: number;
  /** Highest token sequence consumed (monotonic). `-1` = none yet. */
  readonly high_water_nonce: number;
}

/** Why a blast-radius check denied — first failure wins (ordered most-fundamental first). */
export type BlastRadiusDenial =
  | "ceiling_absent" // no total bound set ⇒ a money grant authorizes nothing
  | "invalid_amount" // non-positive, non-integer, or would overflow MAX_SAFE_INTEGER
  | "invalid_counterparty" // unparseable / empty destination
  | "invalid_window" // a per-window limit is set but window_ms ≤ 0
  | "replay" // nonce ≤ high-water (dedupe; replay-of-signed-token lands with the wire binding)
  | "lifetime_exceeded"
  | "cumulative_exceeded"
  | "per_counterparty_exceeded"
  | "action_count_exceeded";

export interface BlastRadiusDecision {
  readonly allowed: boolean;
  /** Present iff `!allowed`. The first dimension that denied. */
  readonly denial?: BlastRadiusDenial;
  /** Headroom remaining after this action would commit (telemetry/UI). Present iff allowed. */
  readonly remaining?: {
    readonly cumulative_micro?: number;
    readonly lifetime_micro?: number;
    readonly per_counterparty_micro?: number;
    readonly actions?: number;
  };
}

/** Result of the pure evaluator: the decision plus the post-commit state (only on allow). */
export interface BlastRadiusEvaluation {
  readonly decision: BlastRadiusDecision;
  /** The state to persist iff `decision.allowed`. Undefined on denial (no mutation). */
  readonly nextState?: GrantSpendState;
}

/** A fresh, zeroed accumulator for a grant whose first window opens at `now`. */
export function freshGrantSpendState(grant_id: string, now: number): GrantSpendState {
  return {
    grant_id,
    window_started_at: now,
    window_spent_micro: 0,
    window_action_count: 0,
    per_counterparty_micro: {},
    lifetime_spent_micro: 0,
    high_water_nonce: -1,
  };
}

/**
 * Canonicalize a counterparty so encoding variants of the same destination map to
 * one bucket (else an adversary mints N sub-limits by varying the encoding).
 * EVM hex (`0x` + 40 hex) is case-insensitive (EIP-55 checksum casing) → lowercased.
 * Other forms (base58 Solana addresses are case-SENSITIVE) are trimmed only.
 * Empty/whitespace ⇒ `null` (fail-closed: an unparseable destination is denied).
 */
export function canonicalizeCounterparty(raw: string): string | null {
  const t = raw.trim();
  if (t.length === 0) return null;
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return t.toLowerCase();
  return t;
}

/**
 * Extract a `MoneyAction` from an R4 tool call's raw args — fail-closed and
 * deliberately narrow. Only the EXPLICIT wire shape is recognized:
 * `amount_micro` (positive safe integer) + `counterparty` (non-empty string).
 * No heuristics, no `amount`/`to`/`recipient` guessing — a money tool that
 * wants to auto-execute under a standing grant must declare its money facts
 * in this exact shape, or the dispatch AND-composition denies it as
 * unmeterable (a tool whose spend the enforcer cannot see must not move
 * money without a human). Returns `null` when the shape is absent/invalid.
 */
export function extractMoneyAction(args: Record<string, unknown>): MoneyAction | null {
  const amount = args["amount_micro"];
  const counterparty = args["counterparty"];
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) return null;
  if (typeof counterparty !== "string" || counterparty.trim().length === 0) return null;
  return { amount_micro: amount, counterparty };
}

/**
 * Extract the enforcer ceiling from a grant's signed `spend_ceiling`
 * (standing-delegation@1.2) — the ONLY sanctioned source of a
 * `GrantSpendCeiling` (spec §3.3 rule 2: the ceiling MUST come from a VERIFIED
 * grant, never local config — authority comes only from signed artifacts).
 *
 * The caller MUST pass a grant that already verified (`verifyGrantForTurn` /
 * `verifyStandingDelegation`) — this function maps shape, it does not verify.
 * Returns `null` when the grant carries no ceiling: a @1.0/@1.1 grant
 * authorizes NO autonomous money, and callers feed the null through as
 * `{}` ⇒ `ceiling_absent` denial (or refuse earlier). Fields are mapped
 * explicitly — a future wire field never leaks into enforcement semantics
 * silently.
 */
export function spendCeilingFromGrant(
  grant: Pick<StandingDelegation, "spend_ceiling">,
): GrantSpendCeiling | null {
  const wire = grant.spend_ceiling;
  if (wire == null) return null;
  return {
    ...(wire.cumulative_limit_micro !== undefined
      ? { cumulative_limit_micro: wire.cumulative_limit_micro }
      : {}),
    ...(wire.per_counterparty_limit_micro !== undefined
      ? { per_counterparty_limit_micro: wire.per_counterparty_limit_micro }
      : {}),
    ...(wire.max_action_count !== undefined ? { max_action_count: wire.max_action_count } : {}),
    ...(wire.lifetime_limit_micro !== undefined
      ? { lifetime_limit_micro: wire.lifetime_limit_micro }
      : {}),
    ...(wire.window_ms !== undefined ? { window_ms: wire.window_ms } : {}),
  };
}

const deny = (denial: BlastRadiusDenial): BlastRadiusEvaluation => ({
  decision: { allowed: false, denial },
});

/**
 * Pure blast-radius algebra — no I/O, injected clock. Given a ceiling, the current
 * accumulator, a proposed action, its nonce, and `now`, decide allow/deny and (on
 * allow) return the next accumulator. Strict & fail-closed throughout; the stateful
 * `GrantSpendStore` wraps this in an atomic check-and-commit.
 */
export function evaluateBlastRadius(
  ceiling: GrantSpendCeiling,
  state: GrantSpendState,
  action: MoneyAction,
  nonce: number,
  now: number,
): BlastRadiusEvaluation {
  // 1. Amount must be a positive safe integer (negative = refund-headroom attack;
  //    zero burns a nonce/action for free; non-integer breaks the micro-unit model).
  const amt = action.amount_micro;
  if (!Number.isSafeInteger(amt) || amt <= 0) return deny("invalid_amount");

  // 2. Destination must canonicalize.
  const cp = canonicalizeCounterparty(action.counterparty);
  if (cp === null) return deny("invalid_counterparty");

  // 3. A money grant must bound total exposure somehow. Neither total bound ⇒ deny.
  const hasWindowLimit =
    ceiling.cumulative_limit_micro !== undefined ||
    ceiling.per_counterparty_limit_micro !== undefined ||
    ceiling.max_action_count !== undefined;
  const hasTotalBound =
    ceiling.cumulative_limit_micro !== undefined || ceiling.lifetime_limit_micro !== undefined;
  if (!hasTotalBound) return deny("ceiling_absent");

  // 4. A per-window limit requires a positive window.
  if (hasWindowLimit && !(typeof ceiling.window_ms === "number" && ceiling.window_ms > 0)) {
    return deny("invalid_window");
  }

  // 5. Replay dedupe — strictly increasing nonce (monotonic high-water, O(1)).
  if (nonce <= state.high_water_nonce) return deny("replay");

  // 6. Window roll. Only roll FORWARD: a rolled-back clock (now < window_started_at)
  //    must never reset the window (that would widen headroom). Lifetime never rolls.
  const windowMs = ceiling.window_ms ?? 0;
  const rolled = hasWindowLimit && windowMs > 0 && now >= state.window_started_at + windowMs;
  const windowStartedAt = rolled ? now : state.window_started_at;
  const windowSpent = rolled ? 0 : state.window_spent_micro;
  const windowActions = rolled ? 0 : state.window_action_count;
  const perCp = rolled ? {} : state.per_counterparty_micro;
  const cpSpent = perCp[cp] ?? 0;

  // 7. Overflow guard on every running sum before comparing.
  const newWindow = windowSpent + amt;
  const newLifetime = state.lifetime_spent_micro + amt;
  const newCp = cpSpent + amt;
  if (!Number.isSafeInteger(newWindow) || !Number.isSafeInteger(newLifetime)) {
    return deny("invalid_amount");
  }

  // 8. Ceilings — lifetime first (strongest bound), then window dimensions.
  if (ceiling.lifetime_limit_micro !== undefined && newLifetime > ceiling.lifetime_limit_micro) {
    return deny("lifetime_exceeded");
  }
  if (ceiling.cumulative_limit_micro !== undefined && newWindow > ceiling.cumulative_limit_micro) {
    return deny("cumulative_exceeded");
  }
  if (
    ceiling.per_counterparty_limit_micro !== undefined &&
    newCp > ceiling.per_counterparty_limit_micro
  ) {
    return deny("per_counterparty_exceeded");
  }
  if (ceiling.max_action_count !== undefined && windowActions + 1 > ceiling.max_action_count) {
    return deny("action_count_exceeded");
  }

  // 9. Allowed — produce the committed state + remaining headroom.
  const nextState: GrantSpendState = {
    grant_id: state.grant_id,
    window_started_at: windowStartedAt,
    window_spent_micro: newWindow,
    window_action_count: windowActions + 1,
    per_counterparty_micro: { ...perCp, [cp]: newCp },
    lifetime_spent_micro: newLifetime,
    high_water_nonce: nonce,
  };
  const remaining = {
    ...(ceiling.cumulative_limit_micro !== undefined
      ? { cumulative_micro: ceiling.cumulative_limit_micro - newWindow }
      : {}),
    ...(ceiling.lifetime_limit_micro !== undefined
      ? { lifetime_micro: ceiling.lifetime_limit_micro - newLifetime }
      : {}),
    ...(ceiling.per_counterparty_limit_micro !== undefined
      ? { per_counterparty_micro: ceiling.per_counterparty_limit_micro - newCp }
      : {}),
    ...(ceiling.max_action_count !== undefined
      ? { actions: ceiling.max_action_count - (windowActions + 1) }
      : {}),
  };
  return { decision: { allowed: true, remaining }, nextState };
}

/**
 * Atomic check-and-commit store for grant spend. The contract is a SINGLE atomic
 * operation — never a `get()` then a later `commit()` with a gap between — so two
 * concurrent money actions cannot both pass a ceiling check before either commits
 * (the decomposition attack's race variant). The persistent (Inc 2) implementation
 * must achieve this via compare-and-set / `appendWithClock` (`CLAUDE.md`); the
 * in-memory reference below achieves it by running read→evaluate→write with no
 * `await` in between (JS run-to-completion).
 */
export interface GrantSpendStore {
  tryConsume(input: {
    grant_id: string;
    ceiling: GrantSpendCeiling;
    action: MoneyAction;
    nonce: number;
    now: number;
  }): Promise<BlastRadiusDecision>;
}

/** Reference in-memory store. Atomic by construction (no await between read and write). */
export class InMemoryGrantSpendStore implements GrantSpendStore {
  private readonly states = new Map<string, GrantSpendState>();

  tryConsume(input: {
    grant_id: string;
    ceiling: GrantSpendCeiling;
    action: MoneyAction;
    nonce: number;
    now: number;
  }): Promise<BlastRadiusDecision> {
    // read → evaluate → write, synchronously: no interleaving point.
    const state =
      this.states.get(input.grant_id) ?? freshGrantSpendState(input.grant_id, input.now);
    const { decision, nextState } = evaluateBlastRadius(
      input.ceiling,
      state,
      input.action,
      input.nonce,
      input.now,
    );
    if (decision.allowed && nextState) this.states.set(input.grant_id, nextState);
    return Promise.resolve(decision);
  }

  /** Test/inspection helper — current accumulator for a grant, if any. */
  peek(grant_id: string): GrantSpendState | undefined {
    return this.states.get(grant_id);
  }
}
