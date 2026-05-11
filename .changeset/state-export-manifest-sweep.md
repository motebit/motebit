---
"@motebit/protocol": minor
---

Extend `ContentArtifactType` registry from 3 → 12 types — one per state-export endpoint in `services/relay/src/state-export.ts`. New named constants: `STATE_SNAPSHOT_ARTIFACT`, `GOAL_LIST_ARTIFACT`, `CONVERSATION_LIST_ARTIFACT`, `CONVERSATION_MESSAGES_ARTIFACT`, `DEVICE_LIST_ARTIFACT`, `PLAN_LIST_ARTIFACT`, `PLAN_DETAIL_ARTIFACT`, `GRADIENT_HISTORY_ARTIFACT`, `SYNC_PULL_ARTIFACT` (9 added; `AUDIT_TRAIL_ARTIFACT`, `MEMORY_EXPORT_ARTIFACT`, `EXECUTION_LEDGER_ARTIFACT` carried over).

```ts
import {
  type ContentArtifactType,
  STATE_SNAPSHOT_ARTIFACT,
  GOAL_LIST_ARTIFACT,
  PLAN_DETAIL_ARTIFACT,
  // ...
  ALL_CONTENT_ARTIFACT_TYPES,
  isContentArtifactType,
} from "@motebit/protocol";
```

Closes the doctrine §8 coherency gap (`docs/doctrine/nist-alignment.md`): every state-export endpoint now wraps its body in a relay-asserted `ContentArtifactManifest` emitted via the `X-Motebit-Content-Manifest` HTTP header. The registry expansion follows the same closure-by-construction pattern as `TokenAudience` and `SuiteId`. Sixth closed-registry drift gate (`check-state-export-signed`, drift-defense #86) makes consumer-side coherency permanent.

Type-level note: the literal union was introduced 2026-05-10; this extension expands the union from 3 → 12 members. Consumers that exhaustively switch on `ContentArtifactType` (rare — most callers narrow via `isContentArtifactType` or compare against specific named constants) will see TypeScript narrowing flag any missing cases.
