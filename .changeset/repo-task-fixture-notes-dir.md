---
---

Test-only: the repo-task node-adapters fixture builds its temp repository under `notes/` instead of `docs/`, so the pre-push allowlist scan (no package may read `docs/`) stays exact. Nothing that ships changes, so this releases no package.
