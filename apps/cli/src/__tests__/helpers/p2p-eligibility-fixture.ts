/**
 * What a relay answers on `GET /api/v1/agents/:id/p2p-eligibility` — the
 * payment pre-flight a paid peer-to-peer delegation reads before it pays.
 *
 * The CURRENT relay service answers, for a worker with a priced listing and a
 * registered settlement address (`services/relay/src/agents.ts`, the
 * `p2p-eligibility` handler):
 *
 *   { allowed, reason, expected_amount_micro, expected_fee_micro, settlement_address }
 *
 * With the amounts present the client pays exactly them and reads NO signed
 * relay document (`packages/runtime/src/relay-delegation.ts`, "Prefer the
 * relay's canonical amounts from the pre-flight"). An OLDER relay answers
 * without the amounts; the client then reads the fee rate from the relay's
 * signed metadata and prices from the listing. The two shapes take different
 * paths through the payment code, so a fake relay must say which one it is.
 *
 * There is no shared type or schema for this answer in `@motebit/protocol` or
 * `@motebit/wire-schemas`, so `p2p-eligibility-fixture-shape.test.ts` pins the
 * current shape here to the real handler's answer, in-process.
 */

/** The fields of the current relay's answer for a priced, payable worker. */
export const CURRENT_ELIGIBILITY_KEYS = [
  "allowed",
  "expected_amount_micro",
  "expected_fee_micro",
  "reason",
  "settlement_address",
] as const;

export interface EligibilityFixtureArgs {
  settlementAddress: string;
  /** The worker leg: `toMicro(unit_cost)`. */
  expectedAmountMicro: number;
  /** The fee leg: `computeP2pFeeMicro(worker leg, the relay's fee rate)`. */
  expectedFeeMicro: number;
}

/** The current relay's answer (amounts included). */
export function currentEligibilityAnswer(args: EligibilityFixtureArgs): {
  allowed: true;
  reason: string;
  expected_amount_micro: number;
  expected_fee_micro: number;
  settlement_address: string;
} {
  return {
    allowed: true,
    reason: "caller not identified — advisory only",
    expected_amount_micro: args.expectedAmountMicro,
    expected_fee_micro: args.expectedFeeMicro,
    settlement_address: args.settlementAddress,
  };
}

/** An OLDER relay's answer: eligible, the address confirmed, no amounts. */
export function olderRelayEligibilityAnswer(
  args: Pick<EligibilityFixtureArgs, "settlementAddress">,
): {
  allowed: true;
  reason: string;
  settlement_address: string;
} {
  return {
    allowed: true,
    reason: "caller not identified — advisory only",
    settlement_address: args.settlementAddress,
  };
}
