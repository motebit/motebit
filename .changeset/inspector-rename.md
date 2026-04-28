---
"@motebit/inspector": patch
---

Rename `@motebit/admin` → `@motebit/inspector`. The package was always a single-agent inspector — 13 of its 15 panels read one motebit's interior via the relay; only `FederationPanel` and `AccountsPanel` were fleet-shaped. The "admin dashboard" framing was a misnomer that a separate `apps/operator` surface will pick up. This commit is rename-only; behavior is unchanged. Doctrine prose (architecture.mdx, README, RUNBOOK, drift-defenses inventory) updated in the same pass.
