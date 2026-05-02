---
"motebit": patch
---

`motebit doctor` — new `Treasury reconciliation` probe surfaces relay-side reconciliation-loop liveness. Catches the silent failure mode where the loop has stopped firing (a dead loop emits no logs, so the loop itself can't surface the problem). Read-only, free, no money cost.

Operator-side concern, gracefully degrades for non-operators: with `MOTEBIT_API_TOKEN` set the probe reports healthy / stale / disabled / drift-detected; without a master token it reports `skipped — operator-only check`. Stale threshold is 30 min (2× the loop's default 15-min cadence).

Sibling-but-distinct primitive vs the deposit-detector — canonical doctrine in `packages/treasury-reconciliation/CLAUDE.md` Rule 1. The probe is the doctor-level partner to the runtime alert (`treasury.reconciliation.drift` structured log) and the admin endpoint (`GET /api/v1/admin/treasury-reconciliation`).
