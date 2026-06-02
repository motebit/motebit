---
"@motebit/protocol": patch
"@motebit/crypto": patch
"@motebit/crypto-appattest": patch
"@motebit/state-export-client": patch
"@motebit/verifier": patch
"create-motebit": patch
---

Recalibrate coverage thresholds for the vitest-4 `coverage-v8` measurement change. vitest 4's coverage-v8 counts branches/statements more granularly than v2 (notably JSX/conditional branches in render-heavy code), so measured coverage dropped across the workspace even though the actual tests and source are unchanged — the ruler changed, not the code. This is a forced consequence of the vitest-4 security upgrade (closed critical GHSA-5xrq-8626-4rwp; cannot be reverted without re-opening the CVE, and coverage-v8 must match the vitest major). Each failing threshold is set to its new v4-measured floor; passing thresholds are untouched.

This is a one-time recalibration to a new measurement tool, not a relaxation of the testing bar — the same tests cover the same code. The recalibrated thresholds are a temporary floor: they should be raised back toward the prior targets as coverage improves under the new tool. Money/identity-path packages all stayed ≥80% after recalibration (crypto branches 85, crypto-appattest statements 86, etc.), so none crossed the `coverage-graduation.json` <80% raise-by trigger. Doctrine: `docs/doctrine/foundational-tool-adoption.md` (vitest-4 worked example).
