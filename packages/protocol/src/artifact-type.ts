/**
 * Content-artifact types — the closed registry of `artifact_type` claim
 * values for the C2PA-shape content-provenance primitive
 * (`ContentArtifactManifest` in `@motebit/crypto`).
 *
 * Provenance binding (per `docs/doctrine/self-attesting-system.md` and
 * `docs/doctrine/nist-alignment.md` §8) requires every signed motebit
 * artifact to carry a producer-declared category so a verifier can
 * route, audit, or display the artifact without parsing its bytes.
 * Pre-registry, the category was a free string in the manifest —
 * a typo at a producer site (`artifact_type: "audit_trail"` instead
 * of `"audit-trail"`) became a verifier-side classification miss
 * with no compile-time signal. Locking the registry as a closed
 * union makes the typo a compile error AND a CI error.
 *
 * **Closed registry shape** — same closure pattern as `TokenAudience`,
 * `SuiteId`, `SettlementRail`, `ToolMode`, `ComputerActionKind`. The
 * `ContentArtifactType` literal union is the wire law; named
 * constants are the developer ergonomics. The drift gate
 * `check-artifact-type-canonical` scans every `artifact_type:
 * "<literal>"` and `artifactType: "<literal>"` call against
 * `ALL_CONTENT_ARTIFACT_TYPES`.
 *
 * Adding a category is intentional protocol-level work: a new entry
 * here, a new producer site, the doctrine reference at
 * `docs/doctrine/nist-alignment.md` §8 updated. Same governance as
 * cryptosuite agility (`SuiteId` registry) and audience binding
 * (`TokenAudience` registry).
 *
 * Permissive floor (Apache-2.0), type-only, zero runtime deps.
 */

/**
 * The closed set of content-artifact categories motebit currently
 * signs. Thirteen cover the state-export endpoints at
 * `services/relay/src/state-export.ts` (relay-assembled bundles
 * the relay signs as a witness over its database state per the
 * recognition note in `docs/doctrine/nist-alignment.md` §8) — the
 * original twelve plus `settlement-summary` (the per-peer economic
 * projection over `relay_settlements`). `goal-result` is the **first
 * non-relay-state-export consumer**: a motebit-direct, per-fire
 * artifact that the motebit itself signs as the producer (the agent's
 * own work product, not a relay-assembled bundle). The expansion is doctrinally aligned —
 * the registry's stated semantic is "content-artifact category for
 * C2PA-shape provenance," not "relay state-export bundle." Goals
 * is the first arc to prove the registry generalizes; future
 * motebit-direct artifacts (chat-bundle exports, generated documents,
 * tool-call-result bundles) compose against the same shape.
 *
 *   - `state-snapshot` — relay's stored state vector for a motebit
 *     (`/api/v1/state/:motebitId`)
 *   - `memory-export` — memory-graph snapshot (nodes + edges) with
 *     optional sensitivity redaction (`/api/v1/memory/:motebitId`)
 *   - `goal-list` — motebit's declared goals
 *     (`/api/v1/goals/:motebitId`)
 *   - `conversation-list` — conversation index for a motebit
 *     (`/api/v1/conversations/:motebitId`)
 *   - `conversation-messages` — message history for a specific
 *     conversation
 *     (`/api/v1/conversations/:motebitId/:conversationId/messages`)
 *   - `device-list` — registered devices for a motebit
 *     (`/api/v1/devices/:motebitId`)
 *   - `audit-trail` — `ToolAuditEntry[]` for a motebit's session
 *     window (`/api/v1/audit/:motebitId`)
 *   - `plan-list` — plans for a motebit, each carrying its steps
 *     (`/api/v1/plans/:motebitId`)
 *   - `plan-detail` — a single plan with its steps
 *     (`/api/v1/plans/:motebitId/:planId`)
 *   - `gradient-history` — intelligence-gradient snapshots
 *     (`/api/v1/gradient/:motebitId`)
 *   - `sync-pull` — event-log pull beyond a clock cursor
 *     (`/api/v1/sync/:motebitId/pull`)
 *   - `execution-ledger` — execution timeline for a goal, including
 *     inner motebit-signed delegation receipt summaries; the
 *     canonical layered-signing consumer
 *     (`/api/v1/execution/:motebitId/:goalId`)
 *   - `goal-result` — per-fire content motebit produced for a
 *     scheduled goal. Producer = motebit identity (not relay).
 *     Doctrine: `docs/doctrine/goal-results.md` §"The three
 *     categories" — the artifact category's cryptographic
 *     provenance envelope. Bound to the fire via `invocation`
 *     (goal_id + execution-receipt id when present).
 *   - `settlement-summary` — per-peer economic history projected
 *     from the relay's signed settlement ledger
 *     (`/api/v1/agents/:motebitId/settlements`). Relay-assembled witness
 *     over `relay_settlements`: for the calling motebit, what it
 *     earned from and paid to each counterparty, in micro-units.
 *     The money side of the first-person trust graph — receipts
 *     stay source of truth, this is a materialized projection, never
 *     a denormalized balance. Doctrine:
 *     `docs/doctrine/agents-as-first-person-trust-graph.md` §6.
 *
 * Adding an endpoint is intentional protocol-level work: a new
 * `ContentArtifactType` entry here, a new named constant, a new
 * `ALL_CONTENT_ARTIFACT_TYPES` member, gate-side `CANONICAL_ARTIFACT_TYPES`
 * update in `scripts/check-artifact-type-canonical.ts`. Drift gate
 * `check-state-export-signed` enforces that every new `app.get(...)`
 * in `services/relay/src/state-export.ts` emits a manifest before
 * returning — that gate scopes only to relay state-export endpoints,
 * not to motebit-direct consumers like `goal-result`, which the
 * runtime signs at fire-time through its own helper.
 */
export type ContentArtifactType =
  | "state-snapshot"
  | "memory-export"
  | "goal-list"
  | "conversation-list"
  | "conversation-messages"
  | "device-list"
  | "audit-trail"
  | "plan-list"
  | "plan-detail"
  | "gradient-history"
  | "sync-pull"
  | "execution-ledger"
  | "goal-result"
  | "settlement-summary";

// === Named constants — same value, narrower type ============================
//
// Callers that import these get `ContentArtifactType` typing without the
// union being inferred from a string-literal at every site. Two ergonomic
// shapes: pass a constant (`EXECUTION_LEDGER_ARTIFACT`) for documentation +
// grep affordance, or inline the literal — the union narrowing catches typos
// in either case.

/** Relay's stored state-vector snapshot for a motebit. */
export const STATE_SNAPSHOT_ARTIFACT: ContentArtifactType = "state-snapshot";

/** Relay-assembled memory-graph snapshot (nodes + edges). */
export const MEMORY_EXPORT_ARTIFACT: ContentArtifactType = "memory-export";

/** Relay-assembled goal list for a motebit. */
export const GOAL_LIST_ARTIFACT: ContentArtifactType = "goal-list";

/** Relay-assembled conversation index for a motebit. */
export const CONVERSATION_LIST_ARTIFACT: ContentArtifactType = "conversation-list";

/** Relay-assembled message history for a specific conversation. */
export const CONVERSATION_MESSAGES_ARTIFACT: ContentArtifactType = "conversation-messages";

/** Relay-assembled list of devices registered to a motebit. */
export const DEVICE_LIST_ARTIFACT: ContentArtifactType = "device-list";

/** Relay-assembled tool-audit-trail export. */
export const AUDIT_TRAIL_ARTIFACT: ContentArtifactType = "audit-trail";

/** Relay-assembled list of plans for a motebit, each with embedded steps. */
export const PLAN_LIST_ARTIFACT: ContentArtifactType = "plan-list";

/** Relay-assembled single-plan export with its steps. */
export const PLAN_DETAIL_ARTIFACT: ContentArtifactType = "plan-detail";

/** Relay-assembled intelligence-gradient-history export. */
export const GRADIENT_HISTORY_ARTIFACT: ContentArtifactType = "gradient-history";

/** Relay-assembled event-log pull beyond a `version_clock` cursor. */
export const SYNC_PULL_ARTIFACT: ContentArtifactType = "sync-pull";

/**
 * Relay-assembled execution-timeline export with embedded motebit-signed
 * delegation receipts. Canonical layered-signing consumer — outer relay
 * manifest attests bundle assembly, inner motebit signatures pass through
 * byte-identical. See `spec/execution-ledger-v1.md`.
 */
export const EXECUTION_LEDGER_ARTIFACT: ContentArtifactType = "execution-ledger";

/**
 * Per-fire artifact bytes for a scheduled goal — the content motebit
 * produced when the goal cadence fired (or the user invoked
 * `runNow`). First non-relay-state-export consumer of the registry:
 * the motebit identity signs as producer, not the relay. Doctrine:
 * `docs/doctrine/goal-results.md` §"The three categories" — the
 * artifact category's cryptographic provenance envelope.
 */
export const GOAL_RESULT_ARTIFACT: ContentArtifactType = "goal-result";

/**
 * Relay-assembled per-peer economic history for a motebit — what it
 * earned from and paid to each counterparty, projected from the signed
 * `relay_settlements` ledger. The money side of the first-person trust
 * graph; a materialized projection, never a stored balance. Doctrine:
 * `docs/doctrine/agents-as-first-person-trust-graph.md` §6.
 */
export const SETTLEMENT_SUMMARY_ARTIFACT: ContentArtifactType = "settlement-summary";

// === Iteration + type guard =================================================

/**
 * Canonical iteration order, frozen. Consumers that need to iterate
 * (drift gates, tooling, docs) use this so TypeScript sees the narrow
 * union rather than `string[]`.
 */
export const ALL_CONTENT_ARTIFACT_TYPES: readonly ContentArtifactType[] = Object.freeze([
  "state-snapshot",
  "memory-export",
  "goal-list",
  "conversation-list",
  "conversation-messages",
  "device-list",
  "audit-trail",
  "plan-list",
  "plan-detail",
  "gradient-history",
  "sync-pull",
  "execution-ledger",
  "goal-result",
  "settlement-summary",
]);

/**
 * Type guard — narrows `unknown` to `ContentArtifactType`. Drift-gate-driven
 * literal scanners use this to validate strings; verifiers that want to
 * dispatch on category call this before the switch so an unchecked cast
 * is a fail-open path the gate will flag.
 */
export function isContentArtifactType(value: unknown): value is ContentArtifactType {
  return (
    typeof value === "string" && (ALL_CONTENT_ARTIFACT_TYPES as readonly string[]).includes(value)
  );
}
