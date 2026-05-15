---
"@motebit/mobile": minor
---

Close the Phase-3 deferral on the mobile surface per `docs/doctrine/goal-results.md` §"Phase-3 deferral close — SHIPPED 2026-05-14 across all surfaces." Mobile's goal-scheduler now wraps every successful fire's artifact bytes as a signed `ContentArtifactManifest` (via `@motebit/runtime::signGoalArtifact`, suite-dispatched through `@motebit/crypto`) and persists the manifest JSON alongside the artifact on the `goal_outcomes` row.

- New `goal_outcomes.signed_manifest TEXT` column landed via `expo-sqlite-migrations` v24 (sibling of desktop's `tauri-migrations` v4). NULL on pre-v24 rows and on every signing-degradation path (no identity, empty content, signer threw).
- `MobileGoalScheduler.finishGoalSuccess` is now async — calls the new private `signArtifactManifestJson` helper (mirrors desktop's) before `insertOutcome`. Three call sites updated to `await` the new async signature.
- `MobileGoalScheduler.finishGoalFailure` writes `signed_manifest: null` for symmetric clear-on-error (the indicator must not outlive the artifact it attested).
- `GoalOutcome` / `GoalOutcomeRow` / `rowToGoalOutcome` extended with the new field. `ExpoGoalStore.insertOutcome` writes it; `getLatestOutcome` projects it.
- `GoalsPanel.tsx` derives `ScheduledGoal.last_manifest_signed = (latest.signed_manifest != null)` for completed outcomes (null for failed → no indicator). The new card row reads `ran 5m ago · signed` / `ran 5m ago` / `failed 5m ago` — same shape as web + desktop. The pre-existing "ran X ago" inside the meta row moved to its dedicated row below it so the cross-surface visual rhythm matches.

396 mobile tests pass; typecheck clean. Closes the Phase-3 deferral on the last surface — the `GOAL_RESULT_ARTIFACT` registry entry from `@motebit/protocol` now has three independent signing consumers (web localStorage, desktop SQLite, mobile expo-sqlite).
