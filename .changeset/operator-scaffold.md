---
"@motebit/operator": patch
---

Scaffold relay-operator console at `apps/operator/`. New Vite + React surface, BUSL-1.1, 6 tabs: withdrawals queue, federation peers, transparency (declared vs proven, side-by-side), disputes, fees, credential anchoring. Master-token gated — same auth model as the inspector (`bearerAuth({ token: apiToken })` on `/api/v1/admin/*`). No AI loop; every action is a typed call.

Federation peers, withdrawals, and credential anchoring panels carry forward what was previously misshelved in the inspector. Transparency and disputes are new operator-shape surfaces. Fees ships with an "endpoint pending" placeholder until `/api/v1/admin/fees` lands in the next commit.

Surface count rolls from `5 surfaces + 4 supporting apps` to `5 surfaces + 5 supporting apps` (CLAUDE.md, README, architecture.mdx).
