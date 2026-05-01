---
"@motebit/relay": minor
---

Retention policy phase 6a — operator retention manifest at `/.well-known/motebit-retention.json`, signed by the relay identity, verified browser-side via `verifyRetentionManifest` (the primitive shipped in phase 2's protocol-algebra commit).

`services/relay`: new `services/relay/src/retention-manifest.ts` — sibling to `transparency.ts`. Builds a signed `RetentionManifest` at startup, registers `GET /.well-known/motebit-retention.json` (unauthenticated, canonical JSON). Today's manifest declares an empty `stores` list and names the deferred phases in `honest_gaps` (phase 4b-3 for operational ledgers, phase 5 for conversations + tool-audit). The empty list is the truthful state — declaring shapes the runtime doesn't yet enforce would breach the doctrine's honesty rule. `pre_classification_default_sensitivity` defaults to `personal` per decision 6b.

Same staged-honesty pattern as the operator-transparency stage 1.5 ship: the endpoint exists with explicit honest gaps; future phases fill the manifest as enforcement lands. Composes the operator-transparency manifest's existing key (resolved from `/.well-known/motebit-transparency.json` `relay_public_key`) — a single fetch + verify pair gives users the operator's retention claim audit.

Phase 6b (the `check-retention-coverage` HARD drift gate that requires every store with sensitivity-classified content to register) lands alongside phase 5's flush enforcement — the gate would fail today since conversations and tool-audit don't yet have shapes.
