---
"@motebit/relay": minor
---

§6.2 federation orchestrator now retries within the §6.6 72h adjudication window — closes the v1 sync trade-off where a single peer hiccup at fan-out time became a permanently-lost vote.

Pre-this-commit, the orchestrator ran one `Promise.allSettled` fan-out per `/resolve` call and aggregated whatever votes came back inside the per-request 10s timeout. A peer flakiness window of even 11 seconds collapsed the entire §6.6 72h window. Post-this-commit, the per-request timeout governs ONE attempt; the §6.6 72h window governs the orchestrator's overall deadline. The two are now separate concerns, as the spec §6.6 promised.

```text
First /resolve attempt:
  - quorum reached → 200 with full DisputeResolution (regression — current behavior)
  - quorum NOT reached, deadline NOT elapsed → 202 Accepted with orchestration state
  - 72h deadline elapsed → 200 with §6.6 fallback (split, split_ratio 0.5)

Subsequent /resolve polls within 72h:
  - drive additional attempts (idempotent — votes from prior attempts contribute)
  - peers that already voted are NOT re-contacted; peers that failed are retried

Background worker:
  - polls relay_dispute_orchestrations for in_progress rows whose
    next_attempt_at <= now
  - drives retries on exponential backoff (10s × 2^attempt, capped at 30 min)
  - finalizes ready / timed_out outcomes via the same path /resolve uses
```

Migration 22 adds `relay_dispute_orchestrations` for per-(dispute, round) state. Restart-resumability is automatic — the table is the single source of truth, the worker picks up `in_progress` rows on every poll regardless of process identity. Cross-process concurrency is bounded by `relay_dispute_resolutions UNIQUE(dispute_id, round)` and `relay_dispute_votes ON CONFLICT DO UPDATE`.

`spec/dispute-v1.md` §6.6 documents the deferred-orchestration contract + the 202 polling shape clients can expect. New module `services/relay/src/dispute-orchestration.ts` houses the persistence helpers + finalize helper. 6 new orchestrator tests cover the three terminal outcomes (ready / deferred / timed_out), composition across attempts, the worker poll cycle, and restart-resumability.
