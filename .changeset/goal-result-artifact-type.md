---
"@motebit/protocol": minor
---

Add `"goal-result"` as the 13th entry in the closed `ContentArtifactType` registry — the **first non-relay-state-export consumer** of the C2PA-shape content-provenance primitive. The prior twelve entries are all relay-assembled state-export bundles signed by `relayIdentity`; `goal-result` is signed by the **agent's** motebit identity at fire-time (per the goal-results Phase 3 doctrine close, `docs/doctrine/goal-results.md` §"Phase 3").

The registry's stated semantic generalizes cleanly — "content-artifact category for C2PA-shape provenance," not "relay state-export bundle." The producer-identity dimension is orthogonal to the category dimension: same JCS-canonical signing, same suite-dispatch verification, same `motebit-verify content-artifact` CLI entry point; just a different signer. Future motebit-direct artifacts (chat-bundle exports, generated documents, tool-call-result bundles) compose against this same shape without further registry expansion.

New exports:

- `"goal-result"` literal added to the `ContentArtifactType` union.
- `GOAL_RESULT_ARTIFACT` named constant.
- `ALL_CONTENT_ARTIFACT_TYPES` iteration array gains the new entry.

The runtime helper that consumes the new type (`@motebit/runtime::signGoalArtifact(content, { goalId, runId })`) wraps the artifact bytes via `signContentArtifact` from `@motebit/crypto` (pinned suite `motebit-jcs-ed25519-hex-v1`). Identity-load-pending fires return `null` fail-safe — never silently sign with a placeholder. Drift gate `check-artifact-type-canonical` mirrors the registry addition (scanned 896 files; passes).

Sibling doctrine updates:

- `docs/doctrine/goal-results.md` §"Phase 3" marked SHIPPED 2026-05-14.
- `docs/doctrine/receipts-unified.md` table extended (`ContentArtifactManifest` signer column now reads "Relay identity **or** agent (`goal-result`)").
- `docs/doctrine/nist-alignment.md` §8 gains "First non-relay-state-export consumer shipped 2026-05-14" paragraph naming the expansion + the verifier auto-support path + which drift gates scope to which producer (`check-state-export-signed` only to relay; `check-artifact-type-canonical` to both).

Test `artifact-type.test.ts` count assertion adjusted 12→13; named-constant enumeration updated.
