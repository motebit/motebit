---
"@motebit/relay": minor
---

§7.2 fund_action federation parity — federation-resolved disputes now emit the granular `release_to_worker` / `refund_to_delegator` arms instead of always emitting `split` with a verdict-encoded `split_ratio`.

Migration 21 adds a `filer_role` column to `relay_disputes`, captured at filing time when the allocation / p2p settlement row is definitely present (per the retention-safety constraint — task rows can be pruned per `relay_disputes`-adjacent retention policies before the orchestrator runs). The orchestrator maps `(resolution, filer_role)` to `(fund_action, split_ratio)` per the table:

```text
upheld + worker        → release_to_worker  (split_ratio 1.0)
upheld + delegator     → refund_to_delegator (split_ratio 0.0)
overturned + worker    → refund_to_delegator (split_ratio 0.0)
overturned + delegator → release_to_worker  (split_ratio 1.0)
split                  → split              (split_ratio 0.5)
```

Legacy disputes filed before migration 21 carry `filer_role: NULL`; the orchestrator falls back to the v1 uniform `split` shape with `split_ratio` encoding the verdict (`1.0`/`0.0`/`0.5`) so audit reads of pre-migration disputes stay coherent. The two shapes are mechanically equivalent in the locked-funds mover; the granular arms give operator dashboards / audit queries / accounting integration the direct shape they need without joining `fund_action` to `resolution`.

`spec/dispute-v1.md` §7.2 updated to document the mapping table and the legacy fallback. Tests added: 5 new in `federation-orchestrator.test.ts` (one per mapping arm + the split-passthrough), 2 new in `disputes.test.ts` (filer_role capture for worker / delegator at filing time).
