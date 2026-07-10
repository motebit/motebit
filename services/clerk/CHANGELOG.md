# @motebit/clerk

## 0.0.0

The Clerk archetype — the money-execution pole (docs/doctrine/agent-archetypes.md §6).
Executes paid sub-delegations under a self-issued signed standing grant, within a
self-imposed spend ceiling; ships dry-run-first. Enforcement is the runtime's
granted-spend AND (`executeGrantedDelegation`), locked by `check-money-authority`.
