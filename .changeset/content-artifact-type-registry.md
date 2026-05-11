---
"@motebit/protocol": minor
"@motebit/crypto": minor
---

Close the `ContentArtifactType` registry — `ContentArtifactManifest.artifact_type` is now a typed literal union (`@motebit/protocol`) instead of a free string. Three seed types match the consumers shipping or pending: `audit-trail`, `memory-export`, `execution-ledger`. New exports:

```ts
import {
  type ContentArtifactType,
  ALL_CONTENT_ARTIFACT_TYPES,
  isContentArtifactType,
  AUDIT_TRAIL_ARTIFACT,
  MEMORY_EXPORT_ARTIFACT,
  EXECUTION_LEDGER_ARTIFACT,
} from "@motebit/protocol";
```

Drift gate `check-artifact-type-canonical` mirrors `check-audience-canonical` — every `artifact_type: "<literal>"` / `artifactType: "<literal>"` site is scanned against the registry. Pre-registry, a producer-site typo (`artifact_type: "audit_trail"` vs `"audit-trail"`) was a verifier-side classification miss with no compile-time signal.

Type narrowing on `@motebit/crypto` — the `artifact_type` field on `ContentArtifactManifest` and the `artifactType` field on `SignContentArtifactOptions` now require a member of the registry. The primitive was published 2026-05-10 (commit c47251c0) with no external consumers yet; this hardening lands within the same day as the initial shape.
