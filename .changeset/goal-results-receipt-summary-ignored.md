---
"@motebit/panels": minor
"@motebit/web": minor
---

Add the **receipt-summary row** to the goal card's collapsed view per `docs/doctrine/goal-results.md` §"Phase-3 deferral close." The Phase 3 doctrine assumed web rendered a "Signed" indicator alongside the receipt-category surface; web actually only persisted the manifest in localStorage with no visible indicator. This closes that asymmetry.

The row sits between the header row and the budget bar, renders only when `last_run_at` is set, and reads one of three shapes:

```
ran 5m ago · signed     ← successful fire, manifest minted
ran 5m ago              ← successful fire, signing skipped
failed 5m ago           ← last fire errored (amber tint)
```

New canonical fields on `@motebit/panels`:

- `ScheduledGoal.last_manifest_signed: boolean | null` — receipt indicator for the renderer. `true` if the most recent fire's artifact was wrapped as a `ContentArtifactManifest`; `false` if signing was skipped (identity not loaded, empty content, signer threw); `null` if the adapter doesn't yet wire signing (legacy / cross-surface deferral). Cleared symmetrically with `last_response_full` and `last_turn_id` on error fires so the indicator never outlives the artifact it attested.
- `GoalFireResult.fired.manifestSigned?: boolean` — adapter-side wire shape. Web populates `true`/`false` from the existing signing path in `apps/web/src/goals-runner.ts`; legacy adapters omit and the runner stores `null`.

Three new runner invariants pin the threading: signed `true` persists; signed `false` is distinct from "unknown" (`null`); error fires clear back to `null`.

Web's `apps/web/src/ui/gated-panels.ts` renders the row, removes the now-duplicated "ran Xm ago" from the expanded-meta block, and titles the "signed" chip with "Result wrapped as a signed ContentArtifactManifest — independently verifiable via motebit-verify" so the indicator maps to the unified-receipt doctrine without forcing a docs trip.

Desktop + mobile mirror lands in follow-up commits with `signed_manifest TEXT` columns on `goal_outcomes` (closes the explicit deferral note in §"Deferred from Phase 3").
