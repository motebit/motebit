---
"@motebit/mcp-server": patch
"@motebit/molecule-runner": patch
"@motebit/research": patch
---

The Researcher's paid-spend budget bounds the ADMITTED task, not one run of it.

- `@motebit/mcp-server`: `handleAgentTask` receives `admittedRelayTaskId` — the verified dispatch token's `sub`, set only when task admission admitted the call (never a caller-supplied `relay_task_id`).
- `@motebit/molecule-runner`: a durable per-admitted-task spend ledger (`task-spend.json` beside `admitted-tasks.json`, same atomic write) with atomic reserve-before-pay / settle-after; the spend handle exposes `taskSpend(admittedRelayTaskId)`. Holds of a run that died stay charged; a corrupt ledger fails closed; rows are kept 24 h after the last charge (never shorter than the admission row).
- `@motebit/research`: every paid hop reserves the task's remaining budget before the live call and settles to what actually left the wallet; a timed-out run still paying and its honest retry under the same dispatch token share one budget (was: 105,264 micro paid against a 66,200 budget across two runs). Unadmitted calls keep the per-run budget.
