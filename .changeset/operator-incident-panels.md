---
"@motebit/operator": minor
"@motebit/relay": patch
---

Add three operator-console panels covering RUNBOOK's curl-only workflows: **Reconciliation**, **Receipts**, **Freeze**. Operator goes from 6 tabs to 9. The relay's "incident response quick reference" workflows now have UI affordances; the operator surface is finally what an operator does their job through, not "panels for the convenient subset."

**Reconciliation** — `GET /api/v1/admin/reconciliation` runs the 5 ledger invariant checks (balance equation, no negative balances, settled-allocation ↔ settlement match, no double-settled allocations, no orphaned settlements). Panel renders consistent/inconsistent state in green/red and lists every violation. The single most useful daily-health signal — answers "is the relay's money state consistent right now?"

**Receipts** — `GET /api/v1/admin/receipts/:motebitId/:taskId` returns byte-identical canonical JSON of a stored ExecutionReceipt — same bytes that were signed at ingestion. Panel takes motebit_id + task_id, fetches the body as text, renders the JSON for offline re-canonicalization + signature re-verification.

**Freeze** — the relay's emergency kill switch. New `GET /api/v1/admin/freeze-status` route added (the freeze state wasn't queryable before; only writable). Panel renders current state (active / FROZEN with reason), shows freeze button (confirm-twice with required reason) when active, shows unfreeze button (single confirm) when frozen. RUNBOOK §7's curl recipe becomes "click the red button."

The new `/api/v1/admin/freeze-status` route is auto-defended by `check-admin-route-auth` (gate #61, landed in the prior commit) — middleware coverage is mechanically required.

Inspector-and-operator manual updated: 6 → 9 tabs documented, daily/incident operational rhythm now includes Reconciliation as the first check and Freeze as the post-confirm kill-switch step. RUNBOOK §6 updated to point at the manual + list the new tabs.

42 operator tests pass (was 21); coverage 58/68/72/58 (was 44/58/67/44). New panel branch tests added to lift the threshold rather than relax it. 52 drift gates green.
