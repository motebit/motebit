---
"@motebit/operator": minor
"@motebit/relay": minor
---

Ship the Operator → Health panel — the default tab, opened-every-session, answering the load-bearing year-zero question: **is the relay being used, and by whom?**

The panel is a one-page snapshot from a single SQL aggregation pass over the truth tables — `agent_registry` + `relay_peers` + `relay_settlements` + `relay_federation_settlements`. No new instrumentation, no probabilistic sampling, no external analytics. Three classes of signal:

- **Motebits** — total registered, active in 24h / 7d / 30d (where "active" = `last_heartbeat` within window). The proof that registered identities are doing work, not just sitting in the DB.
- **Federation** — peer count by state (active / suspended / pending), 7d cross-relay settlement count + volume. Federation settlements only happen when an external peer's agent delegated to one of this relay's agents, so this is the sharpest external-traffic signal there is.
- **Tasks + money** — settlements + volume + 5% fees over 7d / 30d. The economic loop's heartbeat. Zero settlements on a relay with N>0 motebits = strongest "no real usage" signal possible.

Headline numbers color honestly: zero is red, low is yellow, healthy is green. Empty is empty — no softening. When 30d motebit activity is zero on a relay with ≤2 federation peers, the panel renders an explicit message: **"Signal: zero motebit activity in 30d, ≤2 federation peers. The relay is operationally idle. The next architectural pick is partnership / outreach, not more code."** That sentence is the load-bearing output of the panel.

New endpoint `GET /api/v1/admin/health` — bearerAuth gated (auto-defended by drift gate #61, `check-admin-route-auth`), `expensiveLimiter` rate-limit tier. Returns the typed `HealthSummary` shape (motebits / federation / tasks + `generated_at`).

Operator goes from 9 tabs to 10. Health becomes the default tab on open. Inspector-and-operator manual updated; RUNBOOK §6 updated.

Tests: 5 relay aggregator tests (empty schema, activity-window counting, settlement window math, HTTP 401 unauth, 200 with bearer); 3 panel tests (empty signal renders, active state suppresses signal, error path). Total operator tests 42 → 46.

Why this is shipping now: the architectural shape of motebit is settled (52 drift gates, complete deprecation discipline, inspector + operator surfaces, public RUNBOOK, doctrine sync). Federation Stage 2, dispute orchestration, transparency Stage 2 are all gated on the same prerequisite — a real third-party operator existing. The Health panel makes that prerequisite measurable instead of inferred. If it shows zero, the next year is outreach. If it shows real signal, the friction those users hit is the next pick. The trap is more architectural work always feeling productive; the load-bearing question is "is anyone using this?" and we've never had an instrument for it on the operator surface.
