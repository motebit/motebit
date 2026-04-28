---
"@motebit/inspector": minor
---

Extract fleet-shaped panels (`FederationPanel`, `AccountsPanel`, `CredentialAnchoringPanel`) out of inspector. The inspector is single-agent — those three panels rendered relay-wide state and master-token-gated endpoints, the wrong category for an agent-introspection surface. Tab count drops from 15 to 12 (state, memory, behavior, events, audit, goals, plans, conversations, devices, gradient, trust, credentials).

Top-level component renamed `AdminApp` → `InspectorApp`; CSS classes `admin-*` → `inspector-*`; HTML title `Motebit Admin` → `Motebit Inspector`. Withdrawal-flow API helpers (`fetchBalance`, `fetchPendingWithdrawals`, `completeWithdrawal`, `failWithdrawal`) removed from `api.ts` — they ship in `apps/operator/` next.
