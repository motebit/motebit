---
"@motebit/policy": patch
"@motebit/runtime": patch
"@motebit/molecule-runner": patch
"@motebit/clerk": patch
"@motebit/research": patch
---

**A malformed spend limit denies instead of authorizing unbounded spend.** `evaluateBlastRadius` compared limits with `>`, which is never true against NaN or Infinity, so a ceiling of `lifetime_limit_micro: NaN` allowed any amount. It now denies with the new `invalid_ceiling` code when any present limit is not a non-negative safe integer, and `spendCeilingFromGrant` throws `InvalidSpendCeilingError` (the money meter reports it as `invalid_ceiling`). `selfIssueGrant` refuses to sign such a ceiling, because `canonicalJson` writes NaN as `null` and the grant would still verify. Money-denominated env now goes through one strict parser, `parseMicroEnv` (`@motebit/molecule-runner`): `MOTEBIT_CLERK_CEILING_MICRO`, `MOTEBIT_RESEARCH_CEILING_MICRO` and `MOTEBIT_SWEEP_MIN_MICRO` keep their defaults when unset and refuse the boot when set to anything but a plain non-negative integer (an empty value included).
