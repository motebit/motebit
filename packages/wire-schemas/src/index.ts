/**
 * @motebit/wire-schemas — runtime-validated zod schemas for motebit's
 * wire-format types, and the committed JSON Schema artifacts derived
 * from them.
 *
 * Why this package exists. `@motebit/protocol` is MIT and type-only by
 * invariant (check-deps rule 10). That makes it the right home for
 * TypeScript declarations but the wrong home for runtime validators.
 * External implementers (Python, Go, Rust clients of the motebit
 * protocol) cannot consume TypeScript types; they need JSON Schema.
 * This BSL Layer-1 package holds zod schemas that:
 *
 *   1. Parse and validate wire-format payloads at runtime (services,
 *      relay, third-party adapters).
 *   2. Emit JSON Schema via `zod-to-json-schema` for publication as a
 *      protocol artifact (`packages/wire-schemas/schema/*-v1.json`).
 *   3. Statically assert — via the `typeParityCheck` satisfies
 *      assertion at the bottom of each schema — that `z.infer<typeof
 *      Schema>` is structurally assignable to the matching
 *      `@motebit/protocol` type. If the zod shape drifts from the
 *      TypeScript declaration, `tsc` fails at build time.
 *
 * The three-way pin (zod ↔ TypeScript ↔ committed JSON Schema) is the
 * drift defense. Adding a field to `ExecutionReceipt` in
 * `@motebit/protocol` without updating this package breaks the type
 * assertion; running `pnpm --filter @motebit/wire-schemas build-schemas`
 * refreshes the committed JSON; the roundtrip test pins it in CI.
 */

export { assembleJsonSchemaFor } from "./assemble.js";
export {
  ExecutionReceiptSchema,
  EXECUTION_RECEIPT_SCHEMA_ID,
  buildExecutionReceiptJsonSchema,
} from "./execution-receipt.js";
export {
  DelegationTokenSchema,
  DELEGATION_TOKEN_SCHEMA_ID,
  buildDelegationTokenJsonSchema,
} from "./delegation-token.js";
export {
  AgentServiceListingSchema,
  AGENT_SERVICE_LISTING_SCHEMA_ID,
  buildAgentServiceListingJsonSchema,
} from "./agent-service-listing.js";
export {
  AgentResolutionResultSchema,
  AGENT_RESOLUTION_RESULT_SCHEMA_ID,
  buildAgentResolutionResultJsonSchema,
} from "./agent-resolution-result.js";
export { AgentTaskSchema, AGENT_TASK_SCHEMA_ID, buildAgentTaskJsonSchema } from "./agent-task.js";
export {
  SettlementRecordSchema,
  SETTLEMENT_RECORD_SCHEMA_ID,
  buildSettlementRecordJsonSchema,
} from "./settlement-record.js";
export {
  RouteScoreSchema,
  ROUTE_SCORE_SCHEMA_ID,
  buildRouteScoreJsonSchema,
} from "./route-score.js";
export {
  CredentialBundleSchema,
  CREDENTIAL_BUNDLE_SCHEMA_ID,
  buildCredentialBundleJsonSchema,
} from "./credential-bundle.js";
export {
  MigrationRequestSchema,
  MIGRATION_REQUEST_SCHEMA_ID,
  buildMigrationRequestJsonSchema,
  MigrationTokenSchema,
  MIGRATION_TOKEN_SCHEMA_ID,
  buildMigrationTokenJsonSchema,
  DepartureAttestationSchema,
  DEPARTURE_ATTESTATION_SCHEMA_ID,
  buildDepartureAttestationJsonSchema,
  MigrationPresentationSchema,
  MIGRATION_PRESENTATION_SCHEMA_ID,
  buildMigrationPresentationJsonSchema,
  BalanceWaiverSchema,
  BALANCE_WAIVER_SCHEMA_ID,
  buildBalanceWaiverJsonSchema,
} from "./migration.js";
export {
  DisputeRequestSchema,
  DISPUTE_REQUEST_SCHEMA_ID,
  buildDisputeRequestJsonSchema,
  DisputeEvidenceSchema,
  DISPUTE_EVIDENCE_SCHEMA_ID,
  buildDisputeEvidenceJsonSchema,
  AdjudicatorVoteSchema,
  ADJUDICATOR_VOTE_SCHEMA_ID,
  buildAdjudicatorVoteJsonSchema,
  DisputeResolutionSchema,
  DISPUTE_RESOLUTION_SCHEMA_ID,
  buildDisputeResolutionJsonSchema,
  DisputeAppealSchema,
  DISPUTE_APPEAL_SCHEMA_ID,
  buildDisputeAppealJsonSchema,
} from "./dispute.js";
export {
  ReputationCredentialSubjectSchema,
  REPUTATION_CREDENTIAL_SUBJECT_SCHEMA_ID,
  buildReputationCredentialSubjectJsonSchema,
  TrustCredentialSubjectSchema,
  TRUST_CREDENTIAL_SUBJECT_SCHEMA_ID,
  buildTrustCredentialSubjectJsonSchema,
  GradientCredentialSubjectSchema,
  GRADIENT_CREDENTIAL_SUBJECT_SCHEMA_ID,
  buildGradientCredentialSubjectJsonSchema,
} from "./credential-subjects.js";
export {
  HardwareAttestationClaimSchema,
  HARDWARE_ATTESTATION_CLAIM_SCHEMA_ID,
  buildHardwareAttestationClaimJsonSchema,
} from "./hardware-attestation-claim.js";
export {
  CredentialAnchorBatchSchema,
  CREDENTIAL_ANCHOR_BATCH_SCHEMA_ID,
  buildCredentialAnchorBatchJsonSchema,
  CredentialAnchorProofSchema,
  CREDENTIAL_ANCHOR_PROOF_SCHEMA_ID,
  buildCredentialAnchorProofJsonSchema,
} from "./credential-anchor.js";
export {
  AgentSettlementAnchorBatchSchema,
  AGENT_SETTLEMENT_ANCHOR_BATCH_SCHEMA_ID,
  buildAgentSettlementAnchorBatchJsonSchema,
  AgentSettlementAnchorProofSchema,
  AGENT_SETTLEMENT_ANCHOR_PROOF_SCHEMA_ID,
  buildAgentSettlementAnchorProofJsonSchema,
} from "./agent-settlement-anchor.js";
export {
  ConsolidationReceiptSchema,
  CONSOLIDATION_RECEIPT_SCHEMA_ID,
  buildConsolidationReceiptJsonSchema,
  ConsolidationAnchorSchema,
  CONSOLIDATION_ANCHOR_SCHEMA_ID,
  buildConsolidationAnchorJsonSchema,
} from "./consolidation-receipt.js";
export {
  MemoryFormedPayloadSchema,
  MEMORY_FORMED_PAYLOAD_SCHEMA_ID,
  buildMemoryFormedPayloadJsonSchema,
  MemoryAccessedPayloadSchema,
  MEMORY_ACCESSED_PAYLOAD_SCHEMA_ID,
  buildMemoryAccessedPayloadJsonSchema,
  MemoryPinnedPayloadSchema,
  MEMORY_PINNED_PAYLOAD_SCHEMA_ID,
  buildMemoryPinnedPayloadJsonSchema,
  MemoryDeletedPayloadSchema,
  MEMORY_DELETED_PAYLOAD_SCHEMA_ID,
  buildMemoryDeletedPayloadJsonSchema,
  MemoryConsolidatedPayloadSchema,
  MEMORY_CONSOLIDATED_PAYLOAD_SCHEMA_ID,
  buildMemoryConsolidatedPayloadJsonSchema,
  MemoryAuditPayloadSchema,
  MEMORY_AUDIT_PAYLOAD_SCHEMA_ID,
  buildMemoryAuditPayloadJsonSchema,
  MemoryDecayedPayloadSchema,
  MEMORY_DECAYED_PAYLOAD_SCHEMA_ID,
  buildMemoryDecayedPayloadJsonSchema,
  MemoryPromotedPayloadSchema,
  MEMORY_PROMOTED_PAYLOAD_SCHEMA_ID,
  buildMemoryPromotedPayloadJsonSchema,
} from "./memory-events.js";
export {
  GoalCreatedPayloadSchema,
  GOAL_CREATED_PAYLOAD_SCHEMA_ID,
  buildGoalCreatedPayloadJsonSchema,
  GoalExecutedPayloadSchema,
  GOAL_EXECUTED_PAYLOAD_SCHEMA_ID,
  buildGoalExecutedPayloadJsonSchema,
  GoalProgressPayloadSchema,
  GOAL_PROGRESS_PAYLOAD_SCHEMA_ID,
  buildGoalProgressPayloadJsonSchema,
  GoalCompletedPayloadSchema,
  GOAL_COMPLETED_PAYLOAD_SCHEMA_ID,
  buildGoalCompletedPayloadJsonSchema,
  GoalRemovedPayloadSchema,
  GOAL_REMOVED_PAYLOAD_SCHEMA_ID,
  buildGoalRemovedPayloadJsonSchema,
} from "./goal-lifecycle.js";
export {
  PlanCreatedPayloadSchema,
  PLAN_CREATED_PAYLOAD_SCHEMA_ID,
  buildPlanCreatedPayloadJsonSchema,
  PlanStepStartedPayloadSchema,
  PLAN_STEP_STARTED_PAYLOAD_SCHEMA_ID,
  buildPlanStepStartedPayloadJsonSchema,
  PlanStepCompletedPayloadSchema,
  PLAN_STEP_COMPLETED_PAYLOAD_SCHEMA_ID,
  buildPlanStepCompletedPayloadJsonSchema,
  PlanStepFailedPayloadSchema,
  PLAN_STEP_FAILED_PAYLOAD_SCHEMA_ID,
  buildPlanStepFailedPayloadJsonSchema,
  PlanStepDelegatedPayloadSchema,
  PLAN_STEP_DELEGATED_PAYLOAD_SCHEMA_ID,
  buildPlanStepDelegatedPayloadJsonSchema,
  PlanCompletedPayloadSchema,
  PLAN_COMPLETED_PAYLOAD_SCHEMA_ID,
  buildPlanCompletedPayloadJsonSchema,
  PlanFailedPayloadSchema,
  PLAN_FAILED_PAYLOAD_SCHEMA_ID,
  buildPlanFailedPayloadJsonSchema,
} from "./plan-lifecycle.js";
export {
  ComputerActionRequestSchema,
  COMPUTER_ACTION_REQUEST_SCHEMA_ID,
  buildComputerActionRequestJsonSchema,
  ComputerObservationResultSchema,
  COMPUTER_OBSERVATION_RESULT_SCHEMA_ID,
  buildComputerObservationResultJsonSchema,
  ComputerSessionOpenedSchema,
  COMPUTER_SESSION_OPENED_SCHEMA_ID,
  buildComputerSessionOpenedJsonSchema,
  ComputerSessionClosedSchema,
  COMPUTER_SESSION_CLOSED_SCHEMA_ID,
  buildComputerSessionClosedJsonSchema,
} from "./computer-use.js";
