/**
 * A malformed limit is not an absent limit — and it is never an unbounded one.
 *
 * `evaluateBlastRadius` compared limits with `!== undefined` and `>`. Every
 * comparison against NaN is false, and nothing exceeds Infinity, so a ceiling of
 * `lifetime_limit_micro: NaN` or `Infinity` ALLOWED any spend (1e10 µ passed).
 * The value reaches the enforcer through ordinary paths: a service parsing an
 * empty ceiling env with `parseInt` (NaN) signs it into its own grant, and
 * `canonicalJson` writes NaN as `null`, so the grant still verifies. Each present
 * limit must be a non-negative safe integer or the action is denied with the
 * distinct `invalid_ceiling` code (fail-closed, never mistaken for
 * `ceiling_absent`).
 */
import { describe, it, expect } from "vitest";
import {
  evaluateBlastRadius,
  freshGrantSpendState,
  spendCeilingFromGrant,
  InvalidSpendCeilingError,
  type GrantSpendCeiling,
} from "../grant-blast-radius";

const PAYEE = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpZHY5e7pump";
const T0 = 1_000_000_000;
const BIG = { amount_micro: 10_000_000_000, counterparty: PAYEE }; // $10,000

/** The malformed values: non-finite, negative, fractional, type-confused, unsafe. */
const MALFORMED: unknown[] = [NaN, Infinity, -Infinity, -1, 1.5, "", "abc", 2 ** 53, null];

const LIMIT_FIELDS = [
  "lifetime_limit_micro",
  "cumulative_limit_micro",
  "per_counterparty_limit_micro",
  "max_action_count",
] as const;

/** A well-formed ceiling with every dimension huge, so only the malformed field can deny. */
function baseCeiling(): Record<string, unknown> {
  return {
    lifetime_limit_micro: Number.MAX_SAFE_INTEGER,
    cumulative_limit_micro: Number.MAX_SAFE_INTEGER,
    per_counterparty_limit_micro: Number.MAX_SAFE_INTEGER,
    max_action_count: 1_000_000,
    window_ms: 60_000,
  };
}

describe("evaluateBlastRadius — a malformed present limit denies invalid_ceiling", () => {
  for (const field of LIMIT_FIELDS) {
    for (const bad of MALFORMED) {
      it(`${field} = ${String(bad === "" ? '""' : bad)} ⇒ deny invalid_ceiling`, () => {
        const ceiling = { ...baseCeiling(), [field]: bad } as unknown as GrantSpendCeiling;
        const r = evaluateBlastRadius(ceiling, freshGrantSpendState("g", T0), BIG, 0, T0);
        expect(r.decision.allowed).toBe(false);
        expect(r.decision.denial).toBe("invalid_ceiling");
        expect(r.nextState).toBeUndefined();
      });
    }
  }

  it("the reported bypass: a lone lifetime limit of NaN or Infinity no longer authorizes $10,000", () => {
    for (const bad of [NaN, Infinity]) {
      const r = evaluateBlastRadius(
        { lifetime_limit_micro: bad },
        freshGrantSpendState("g", T0),
        BIG,
        0,
        T0,
      );
      expect(r.decision).toMatchObject({ allowed: false, denial: "invalid_ceiling" });
    }
  });

  it("well-formed limits (0 and MAX_SAFE_INTEGER) are still decided by the ceiling", () => {
    const zero = evaluateBlastRadius(
      { lifetime_limit_micro: 0 },
      freshGrantSpendState("g", T0),
      BIG,
      0,
      T0,
    );
    expect(zero.decision.denial).toBe("lifetime_exceeded");
    const max = evaluateBlastRadius(
      { lifetime_limit_micro: Number.MAX_SAFE_INTEGER },
      freshGrantSpendState("g", T0),
      BIG,
      0,
      T0,
    );
    expect(max.decision.allowed).toBe(true);
  });
});

describe("spendCeilingFromGrant — rejects a malformed wire limit", () => {
  for (const field of [...LIMIT_FIELDS, "window_ms"] as const) {
    for (const bad of MALFORMED) {
      it(`${field} = ${String(bad === "" ? '""' : bad)} ⇒ throws InvalidSpendCeilingError`, () => {
        const grant = {
          spend_ceiling: {
            schema: "motebit.spend-ceiling.v1",
            lifetime_limit_micro: 1,
            [field]: bad,
          },
        } as never;
        expect(() => spendCeilingFromGrant(grant)).toThrow(InvalidSpendCeilingError);
      });
    }
  }

  it("a well-formed wire ceiling still maps through", () => {
    expect(
      spendCeilingFromGrant({
        spend_ceiling: {
          schema: "motebit.spend-ceiling.v1",
          lifetime_limit_micro: 0,
          cumulative_limit_micro: 5,
          window_ms: 1000,
        },
      }),
    ).toEqual({ lifetime_limit_micro: 0, cumulative_limit_micro: 5, window_ms: 1000 });
  });
});
