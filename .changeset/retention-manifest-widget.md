---
"motebit": minor
---

Operator retention manifest, browser-verified, embedded in the Activity panel. Activity (`d5e66e34`'s deletion choke + `eb10bac6`'s timeline panel) shows what the motebit DID. The retention widget shows what the operator PROMISED — the second axis of sovereignty visibility. Together they're the pair: the operator's signed retention claim is re-verified in the browser without trusting the relay, and the user's motebit's actual signed-deletion log sits below it.

The verifier (`verifyRetentionManifest`) was shipped at `fda8dd08` (phase 6a of the retention doctrine). The relay has been serving the signed JSON at `/.well-known/motebit-retention.json` ever since, with operator pubkey at `/.well-known/motebit-transparency.json`. No surface rendered them. This commit closes that.

Cross-surface controller in `@motebit/panels` (`createRetentionController`, `summarizeRetentionCeilings`, `RetentionVerification`) — same Layer 5 BSL pattern. Two-fetch coordination (transparency manifest first for the key, then retention manifest for the body), verifier dispatch, discrete verification status (`idle | loading | verified | invalid | unreachable`). `summarizeRetentionCeilings` projects the manifest's per-store `mutable_pruning` shapes into a single per-sensitivity table sorted strictest-first, taking the worst-case ceiling across all stores that hold each tier.

Web embeds it as a header block inside the Activity panel, above the filter chips. `@motebit/encryption` re-exports `verifyRetentionManifest` (matching the established `verifySkillBundle` pattern) so apps consume product vocabulary, not protocol primitives. Drift gate `check-app-primitives` enforces the layering.

11 controller tests covering verification status state machine (verified / invalid / unreachable / loading), error paths (transparency null, retention null, fetch throws, verifier throws), summary projection (sort order, multi-store strictest-ceiling, ignore non-mutable_pruning shapes).

Mobile + desktop will mount the same controller as a follow-up — the panels CLAUDE.md drift-gate idiom applies.
