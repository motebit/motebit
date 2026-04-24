---
"@motebit/protocol": patch
"@motebit/sdk": patch
"@motebit/crypto": patch
---

Rename `DEFAULT_TRUST_THRESHOLDS` → `REFERENCE_TRUST_THRESHOLDS` (additive + deprecation, no behavior change).

## Why

`DEFAULT_TRUST_THRESHOLDS` is exported from `@motebit/protocol` — the permissive-floor layer whose rule (see `packages/protocol/CLAUDE.md` rule 1) is "types, enums, constants, deterministic math." The values (`promoteToVerified_minTasks: 5`, `demote_belowRate: 0.5`, etc.) are constants, so they technically fit, but the **name** claimed more protocol authority than they carry:

- The semiring algebra above (`trustAdd`, `trustMultiply`, `TRUST_LEVEL_SCORES`, `TRUST_ZERO`, `TRUST_ONE`) IS interop law — two motebit implementations MUST compute trust the same way to exchange scores across federation boundaries.
- The transition thresholds (when to promote an agent, when to demote) are **motebit product tuning** — a federated implementation can choose stricter or looser values and still interoperate. The scores are compared; the policy that derives them is not.

The `DEFAULT_` prefix read as "THE value every motebit implementation uses." `REFERENCE_` correctly signals "motebit's reference default; implementers MAY choose their own."

## What shipped

- New export: `REFERENCE_TRUST_THRESHOLDS` from `@motebit/protocol` (identical values, clearer name)
- Deprecation: `DEFAULT_TRUST_THRESHOLDS` marked `@deprecated since 1.0.1, removed in 2.0.0` with pointer to the new name and the reason above
- Internal consumers (`@motebit/semiring`, `@motebit/market`, reference tests) migrated to the new name
- Parity test in `packages/protocol/src/__tests__/trust-algebra.test.ts` asserts `DEFAULT_TRUST_THRESHOLDS === REFERENCE_TRUST_THRESHOLDS` until the 2.0.0 removal, preventing silent divergence during the deprecation window

## Impact

Zero runtime change. Third-party consumers pinned to `@motebit/protocol@1.x` keep working — the old export is re-exported as an alias. Consumers should migrate to `REFERENCE_TRUST_THRESHOLDS` at their convenience before 2.0.0. The `check-deprecation-discipline` gate (drift-defenses #39) tracks the sunset.
