---
"motebit": minor
---

`motebit smoke reconciliation` — operator-runnable end-to-end probe that asserts the treasury reconciliation loop is enabled, fresh (last cycle within 30 min), and reporting consistent state. Master token required; exits non-zero on `stale` or `drift` verdicts so it slots into CI / cron without ceremony.

Five terminal verdicts: `healthy`, `stale`, `drift`, `no_cycles_yet` (recent boot, no failure), `loop_disabled` (testnet relay or mainnet without `X402_PAY_TO_ADDRESS`, no failure). Canonical `verdict=...` output for grep.

Complements the free `Treasury reconciliation` probe in `motebit doctor` — same five branches, but `doctor` is read-only and degrades for non-operators while `smoke reconciliation` is hard-failing and operator-required. Sibling-but-distinct primitive vs the deposit-detector — canonical doctrine in `packages/treasury-reconciliation/CLAUDE.md` Rule 1.

The paid-flow companion (`motebit smoke x402` — buyer/worker settlement that gives reconciliation a non-zero `recorded_fee_sum_micro` to observe) is a future deliverable; this changeset ships the read-side validation that the paid flow's `--verify-reconciliation` step will eventually call.
