/**
 * Money meter — the runtime half of the R4 AND-composition
 * (gate-allow ∧ meter-allow ⇒ execute; anything else ⇒ deny).
 *
 * This is the ONLY sanctioned composition of the blast-radius enforcer
 * with live dispatch (`check-ceiling-from-grant`): the ceiling comes
 * exclusively from the verified grant's signed `spend_ceiling` via
 * `spendCeilingFromGrant` (spec/standing-delegation-v1.md §3.3 rule 2 —
 * authority from signed artifacts, never local config), the money facts
 * come exclusively from `extractMoneyAction` over the raw tool args, and
 * the replay nonce is the verified tick token's signed `issued_at`
 * (`VerifiedGrant.token_issued_at` — one tick meters at most one money
 * action; a second action under the same token is a nonce replay and is
 * denied).
 *
 * Fail-closed at every absence: no ceiling on the grant (`ceiling_absent`),
 * un-extractable money facts (`unmeterable_action` — a tool whose spend the
 * enforcer cannot see must not move money without a human), no signed nonce
 * (`nonce_absent` — a pre-@1.2 VerifiedGrant cannot meter). Denials name
 * the enforcer's own `BlastRadiusDenial` vocabulary where one exists.
 *
 * Durability note: with the in-memory store, accumulators reset on process
 * restart — the per-window and lifetime bounds then re-arm from zero.
 * Deployments wiring live money MUST inject the persistent
 * `SqliteGrantSpendStore` (`@motebit/persistence`) so the lifetime bound
 * survives restarts; the CLI runtime factory does.
 */

import type { GrantSpendStore } from "@motebit/policy";
import { spendCeilingFromGrant, extractMoneyAction } from "@motebit/policy";
import type { TurnContext, SovereignP2pPaymentRequest, P2pPaymentProof } from "@motebit/protocol";

export interface MeterVerdict {
  allowed: boolean;
  denial?: string;
}

/**
 * The TurnContext grant shape (nonce/ceiling optional on the wire type —
 * the meter handles absence fail-closed), not the producer's stricter
 * `VerifiedGrant`: the meter must meter whatever the loop actually holds.
 */
export type MoneyMeter = (
  verifiedGrant: NonNullable<TurnContext["verifiedGrant"]>,
  toolName: string,
  args: Record<string, unknown>,
) => Promise<MeterVerdict>;

export function createMoneyMeter(
  store: GrantSpendStore,
  options?: { now?: () => number },
): MoneyMeter {
  const now = options?.now ?? Date.now;
  return async (verifiedGrant, _toolName, args) => {
    const ceiling = spendCeilingFromGrant(verifiedGrant);
    if (ceiling == null) return { allowed: false, denial: "ceiling_absent" };

    const action = extractMoneyAction(args);
    if (action == null) return { allowed: false, denial: "unmeterable_action" };

    const nonce = verifiedGrant.token_issued_at;
    if (typeof nonce !== "number") return { allowed: false, denial: "nonce_absent" };

    const decision = await store.tryConsume({
      grant_id: verifiedGrant.grant_id,
      ceiling,
      action,
      nonce,
      now: now(),
    });
    return decision.allowed
      ? { allowed: true }
      : { allowed: false, denial: decision.denial ?? "denied" };
  };
}

/**
 * Typed refusal thrown by the metered payment builder BEFORE any
 * broadcast. Carries a `.reason` so the loop's `extractErrorReason`
 * lifts the category onto the tool_status chunk — the surface sees a
 * structured governance deny, not an opaque failure.
 */
export class MoneyMeterDeniedError extends Error {
  readonly reason = "money_meter_denied";
  readonly denial: string;
  constructor(denial: string) {
    super(
      `Payment refused by the grant blast-radius meter before broadcast: ${denial}. ` +
        `The standing grant's signed ceiling does not authorize this spend.`,
    );
    this.name = "MoneyMeterDeniedError";
    this.denial = denial;
  }
}

/**
 * The RAIL-SEAM half of late-bound metering (`ToolDefinition.moneyBinding:
 * "late"`). A late-bound money tool's spend is unknown at args time — the
 * loop's AND-composition lets a grant-cleared call proceed on grant+meter
 * PRESENCE, and THIS wrapper is where the enforcement actually happens:
 * it sits between quote resolution and the irreversible broadcast, meters
 * the delegator's TOTAL outflow (worker net + every fee leg) against the
 * grant's signed ceiling, and throws before `build` on any deny.
 *
 * No active grant ⇒ pass-through, deliberately: policy-gate step 8b
 * guarantees an R4 call with no verified grant only reaches execution via
 * live human approval — and the human, not the meter, is that path's
 * authorizer. The wrapper meters standing authority, never human consent.
 *
 * This is the ONLY sanctioned binding of a `SovereignWalletRail` payment
 * builder into the delegation manager (`check-ceiling-from-grant`): the
 * runtime must never hand the raw wallet method through.
 */
export function wrapP2pPaymentWithMeter(
  build: (request: SovereignP2pPaymentRequest) => Promise<P2pPaymentProof>,
  getActiveGrant: () => NonNullable<TurnContext["verifiedGrant"]> | null,
  meter: MoneyMeter,
): (request: SovereignP2pPaymentRequest) => Promise<P2pPaymentProof> {
  return async (request) => {
    const grant = getActiveGrant();
    if (grant == null) return build(request);

    const totalOutflowMicro =
      request.amountMicro + request.feeAmountMicro + (request.executorFeeAmountMicro ?? 0);
    const verdict = await meter(grant, "p2p_payment", {
      amount_micro: totalOutflowMicro,
      counterparty: request.workerAddress,
    });
    if (!verdict.allowed) {
      throw new MoneyMeterDeniedError(verdict.denial ?? "denied");
    }
    return build(request);
  };
}
