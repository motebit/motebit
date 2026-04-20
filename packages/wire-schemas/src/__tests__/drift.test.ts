/**
 * Drift defense #22 — `packages/wire-schemas/schema/*-v1.json` files
 * must match the live zod-derived JSON Schemas byte-for-byte
 * (structural equality).
 *
 * The published JSON Schemas are part of motebit's protocol surface.
 * Third-party Python/Go/Rust implementers resolve them via stable
 * `$id` URLs. If the zod source gains a new field and the author
 * forgets to run `pnpm --filter @motebit/wire-schemas build-schemas`,
 * the published contract silently misreports the shape. This test
 * closes that gap before PR review — the error message is the fix
 * recipe.
 *
 * Forward + reverse type parity (zod ↔ TypeScript types in
 * @motebit/protocol) is enforced at build time by the `satisfies`
 * assertions inside each schema module; this file is the
 * runtime/artifact pin.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  AGENT_RESOLUTION_RESULT_SCHEMA_ID,
  buildAgentResolutionResultJsonSchema,
} from "../agent-resolution-result.js";
import {
  AGENT_SERVICE_LISTING_SCHEMA_ID,
  buildAgentServiceListingJsonSchema,
} from "../agent-service-listing.js";
import { AGENT_TASK_SCHEMA_ID, buildAgentTaskJsonSchema } from "../agent-task.js";
import {
  CREDENTIAL_ANCHOR_BATCH_SCHEMA_ID,
  CREDENTIAL_ANCHOR_PROOF_SCHEMA_ID,
  buildCredentialAnchorBatchJsonSchema,
  buildCredentialAnchorProofJsonSchema,
} from "../credential-anchor.js";
import {
  AGENT_SETTLEMENT_ANCHOR_BATCH_SCHEMA_ID,
  AGENT_SETTLEMENT_ANCHOR_PROOF_SCHEMA_ID,
  buildAgentSettlementAnchorBatchJsonSchema,
  buildAgentSettlementAnchorProofJsonSchema,
} from "../agent-settlement-anchor.js";
import {
  CREDENTIAL_BUNDLE_SCHEMA_ID,
  buildCredentialBundleJsonSchema,
} from "../credential-bundle.js";
import {
  GRADIENT_CREDENTIAL_SUBJECT_SCHEMA_ID,
  REPUTATION_CREDENTIAL_SUBJECT_SCHEMA_ID,
  TRUST_CREDENTIAL_SUBJECT_SCHEMA_ID,
  buildGradientCredentialSubjectJsonSchema,
  buildReputationCredentialSubjectJsonSchema,
  buildTrustCredentialSubjectJsonSchema,
} from "../credential-subjects.js";
import {
  HARDWARE_ATTESTATION_CLAIM_SCHEMA_ID,
  buildHardwareAttestationClaimJsonSchema,
} from "../hardware-attestation-claim.js";
import {
  ADJUDICATOR_VOTE_SCHEMA_ID,
  DISPUTE_APPEAL_SCHEMA_ID,
  DISPUTE_EVIDENCE_SCHEMA_ID,
  DISPUTE_REQUEST_SCHEMA_ID,
  DISPUTE_RESOLUTION_SCHEMA_ID,
  buildAdjudicatorVoteJsonSchema,
  buildDisputeAppealJsonSchema,
  buildDisputeEvidenceJsonSchema,
  buildDisputeRequestJsonSchema,
  buildDisputeResolutionJsonSchema,
} from "../dispute.js";
import {
  BALANCE_WAIVER_SCHEMA_ID,
  DEPARTURE_ATTESTATION_SCHEMA_ID,
  MIGRATION_PRESENTATION_SCHEMA_ID,
  MIGRATION_REQUEST_SCHEMA_ID,
  MIGRATION_TOKEN_SCHEMA_ID,
  buildBalanceWaiverJsonSchema,
  buildDepartureAttestationJsonSchema,
  buildMigrationPresentationJsonSchema,
  buildMigrationRequestJsonSchema,
  buildMigrationTokenJsonSchema,
} from "../migration.js";
import { ROUTE_SCORE_SCHEMA_ID, buildRouteScoreJsonSchema } from "../route-score.js";
import {
  SETTLEMENT_RECORD_SCHEMA_ID,
  buildSettlementRecordJsonSchema,
} from "../settlement-record.js";
import { DELEGATION_TOKEN_SCHEMA_ID, buildDelegationTokenJsonSchema } from "../delegation-token.js";
import {
  EXECUTION_RECEIPT_SCHEMA_ID,
  buildExecutionReceiptJsonSchema,
} from "../execution-receipt.js";
import {
  MEMORY_ACCESSED_PAYLOAD_SCHEMA_ID,
  MEMORY_AUDIT_PAYLOAD_SCHEMA_ID,
  MEMORY_CONSOLIDATED_PAYLOAD_SCHEMA_ID,
  MEMORY_DECAYED_PAYLOAD_SCHEMA_ID,
  MEMORY_DELETED_PAYLOAD_SCHEMA_ID,
  MEMORY_FORMED_PAYLOAD_SCHEMA_ID,
  MEMORY_PINNED_PAYLOAD_SCHEMA_ID,
  MEMORY_PROMOTED_PAYLOAD_SCHEMA_ID,
  buildMemoryAccessedPayloadJsonSchema,
  buildMemoryAuditPayloadJsonSchema,
  buildMemoryConsolidatedPayloadJsonSchema,
  buildMemoryDecayedPayloadJsonSchema,
  buildMemoryDeletedPayloadJsonSchema,
  buildMemoryFormedPayloadJsonSchema,
  buildMemoryPinnedPayloadJsonSchema,
  buildMemoryPromotedPayloadJsonSchema,
} from "../memory-events.js";
import {
  GOAL_CREATED_PAYLOAD_SCHEMA_ID,
  GOAL_EXECUTED_PAYLOAD_SCHEMA_ID,
  GOAL_PROGRESS_PAYLOAD_SCHEMA_ID,
  GOAL_COMPLETED_PAYLOAD_SCHEMA_ID,
  GOAL_REMOVED_PAYLOAD_SCHEMA_ID,
  buildGoalCreatedPayloadJsonSchema,
  buildGoalExecutedPayloadJsonSchema,
  buildGoalProgressPayloadJsonSchema,
  buildGoalCompletedPayloadJsonSchema,
  buildGoalRemovedPayloadJsonSchema,
} from "../goal-lifecycle.js";
import {
  PLAN_CREATED_PAYLOAD_SCHEMA_ID,
  PLAN_STEP_STARTED_PAYLOAD_SCHEMA_ID,
  PLAN_STEP_COMPLETED_PAYLOAD_SCHEMA_ID,
  PLAN_STEP_FAILED_PAYLOAD_SCHEMA_ID,
  PLAN_STEP_DELEGATED_PAYLOAD_SCHEMA_ID,
  PLAN_COMPLETED_PAYLOAD_SCHEMA_ID,
  PLAN_FAILED_PAYLOAD_SCHEMA_ID,
  buildPlanCreatedPayloadJsonSchema,
  buildPlanStepStartedPayloadJsonSchema,
  buildPlanStepCompletedPayloadJsonSchema,
  buildPlanStepFailedPayloadJsonSchema,
  buildPlanStepDelegatedPayloadJsonSchema,
  buildPlanCompletedPayloadJsonSchema,
  buildPlanFailedPayloadJsonSchema,
} from "../plan-lifecycle.js";

interface SchemaCase {
  name: string;
  filename: string;
  expectedId: string;
  build: () => Record<string, unknown>;
}

const CASES: SchemaCase[] = [
  {
    name: "execution-receipt-v1",
    filename: "execution-receipt-v1.json",
    expectedId: EXECUTION_RECEIPT_SCHEMA_ID,
    build: buildExecutionReceiptJsonSchema,
  },
  {
    name: "delegation-token-v1",
    filename: "delegation-token-v1.json",
    expectedId: DELEGATION_TOKEN_SCHEMA_ID,
    build: buildDelegationTokenJsonSchema,
  },
  {
    name: "agent-service-listing-v1",
    filename: "agent-service-listing-v1.json",
    expectedId: AGENT_SERVICE_LISTING_SCHEMA_ID,
    build: buildAgentServiceListingJsonSchema,
  },
  {
    name: "agent-resolution-result-v1",
    filename: "agent-resolution-result-v1.json",
    expectedId: AGENT_RESOLUTION_RESULT_SCHEMA_ID,
    build: buildAgentResolutionResultJsonSchema,
  },
  {
    name: "agent-task-v1",
    filename: "agent-task-v1.json",
    expectedId: AGENT_TASK_SCHEMA_ID,
    build: buildAgentTaskJsonSchema,
  },
  {
    name: "settlement-record-v1",
    filename: "settlement-record-v1.json",
    expectedId: SETTLEMENT_RECORD_SCHEMA_ID,
    build: buildSettlementRecordJsonSchema,
  },
  {
    name: "route-score-v1",
    filename: "route-score-v1.json",
    expectedId: ROUTE_SCORE_SCHEMA_ID,
    build: buildRouteScoreJsonSchema,
  },
  {
    name: "credential-bundle-v1",
    filename: "credential-bundle-v1.json",
    expectedId: CREDENTIAL_BUNDLE_SCHEMA_ID,
    build: buildCredentialBundleJsonSchema,
  },
  {
    name: "migration-request-v1",
    filename: "migration-request-v1.json",
    expectedId: MIGRATION_REQUEST_SCHEMA_ID,
    build: buildMigrationRequestJsonSchema,
  },
  {
    name: "migration-token-v1",
    filename: "migration-token-v1.json",
    expectedId: MIGRATION_TOKEN_SCHEMA_ID,
    build: buildMigrationTokenJsonSchema,
  },
  {
    name: "departure-attestation-v1",
    filename: "departure-attestation-v1.json",
    expectedId: DEPARTURE_ATTESTATION_SCHEMA_ID,
    build: buildDepartureAttestationJsonSchema,
  },
  {
    name: "migration-presentation-v1",
    filename: "migration-presentation-v1.json",
    expectedId: MIGRATION_PRESENTATION_SCHEMA_ID,
    build: buildMigrationPresentationJsonSchema,
  },
  {
    name: "balance-waiver-v1",
    filename: "balance-waiver-v1.json",
    expectedId: BALANCE_WAIVER_SCHEMA_ID,
    build: buildBalanceWaiverJsonSchema,
  },
  {
    name: "dispute-request-v1",
    filename: "dispute-request-v1.json",
    expectedId: DISPUTE_REQUEST_SCHEMA_ID,
    build: buildDisputeRequestJsonSchema,
  },
  {
    name: "dispute-evidence-v1",
    filename: "dispute-evidence-v1.json",
    expectedId: DISPUTE_EVIDENCE_SCHEMA_ID,
    build: buildDisputeEvidenceJsonSchema,
  },
  {
    name: "adjudicator-vote-v1",
    filename: "adjudicator-vote-v1.json",
    expectedId: ADJUDICATOR_VOTE_SCHEMA_ID,
    build: buildAdjudicatorVoteJsonSchema,
  },
  {
    name: "dispute-resolution-v1",
    filename: "dispute-resolution-v1.json",
    expectedId: DISPUTE_RESOLUTION_SCHEMA_ID,
    build: buildDisputeResolutionJsonSchema,
  },
  {
    name: "dispute-appeal-v1",
    filename: "dispute-appeal-v1.json",
    expectedId: DISPUTE_APPEAL_SCHEMA_ID,
    build: buildDisputeAppealJsonSchema,
  },
  {
    name: "reputation-credential-subject-v1",
    filename: "reputation-credential-subject-v1.json",
    expectedId: REPUTATION_CREDENTIAL_SUBJECT_SCHEMA_ID,
    build: buildReputationCredentialSubjectJsonSchema,
  },
  {
    name: "trust-credential-subject-v1",
    filename: "trust-credential-subject-v1.json",
    expectedId: TRUST_CREDENTIAL_SUBJECT_SCHEMA_ID,
    build: buildTrustCredentialSubjectJsonSchema,
  },
  {
    name: "gradient-credential-subject-v1",
    filename: "gradient-credential-subject-v1.json",
    expectedId: GRADIENT_CREDENTIAL_SUBJECT_SCHEMA_ID,
    build: buildGradientCredentialSubjectJsonSchema,
  },
  {
    name: "hardware-attestation-claim-v1",
    filename: "hardware-attestation-claim-v1.json",
    expectedId: HARDWARE_ATTESTATION_CLAIM_SCHEMA_ID,
    build: buildHardwareAttestationClaimJsonSchema,
  },
  {
    name: "credential-anchor-batch-v1",
    filename: "credential-anchor-batch-v1.json",
    expectedId: CREDENTIAL_ANCHOR_BATCH_SCHEMA_ID,
    build: buildCredentialAnchorBatchJsonSchema,
  },
  {
    name: "credential-anchor-proof-v1",
    filename: "credential-anchor-proof-v1.json",
    expectedId: CREDENTIAL_ANCHOR_PROOF_SCHEMA_ID,
    build: buildCredentialAnchorProofJsonSchema,
  },
  {
    name: "agent-settlement-anchor-batch-v1",
    filename: "agent-settlement-anchor-batch-v1.json",
    expectedId: AGENT_SETTLEMENT_ANCHOR_BATCH_SCHEMA_ID,
    build: buildAgentSettlementAnchorBatchJsonSchema,
  },
  {
    name: "agent-settlement-anchor-proof-v1",
    filename: "agent-settlement-anchor-proof-v1.json",
    expectedId: AGENT_SETTLEMENT_ANCHOR_PROOF_SCHEMA_ID,
    build: buildAgentSettlementAnchorProofJsonSchema,
  },
  // Memory-delta-v1 payloads — one case per event type under §5 of the spec.
  {
    name: "memory-formed-payload-v1",
    filename: "memory-formed-payload-v1.json",
    expectedId: MEMORY_FORMED_PAYLOAD_SCHEMA_ID,
    build: buildMemoryFormedPayloadJsonSchema,
  },
  {
    name: "memory-accessed-payload-v1",
    filename: "memory-accessed-payload-v1.json",
    expectedId: MEMORY_ACCESSED_PAYLOAD_SCHEMA_ID,
    build: buildMemoryAccessedPayloadJsonSchema,
  },
  {
    name: "memory-pinned-payload-v1",
    filename: "memory-pinned-payload-v1.json",
    expectedId: MEMORY_PINNED_PAYLOAD_SCHEMA_ID,
    build: buildMemoryPinnedPayloadJsonSchema,
  },
  {
    name: "memory-deleted-payload-v1",
    filename: "memory-deleted-payload-v1.json",
    expectedId: MEMORY_DELETED_PAYLOAD_SCHEMA_ID,
    build: buildMemoryDeletedPayloadJsonSchema,
  },
  {
    name: "memory-consolidated-payload-v1",
    filename: "memory-consolidated-payload-v1.json",
    expectedId: MEMORY_CONSOLIDATED_PAYLOAD_SCHEMA_ID,
    build: buildMemoryConsolidatedPayloadJsonSchema,
  },
  {
    name: "memory-audit-payload-v1",
    filename: "memory-audit-payload-v1.json",
    expectedId: MEMORY_AUDIT_PAYLOAD_SCHEMA_ID,
    build: buildMemoryAuditPayloadJsonSchema,
  },
  {
    name: "memory-decayed-payload-v1",
    filename: "memory-decayed-payload-v1.json",
    expectedId: MEMORY_DECAYED_PAYLOAD_SCHEMA_ID,
    build: buildMemoryDecayedPayloadJsonSchema,
  },
  {
    name: "memory-promoted-payload-v1",
    filename: "memory-promoted-payload-v1.json",
    expectedId: MEMORY_PROMOTED_PAYLOAD_SCHEMA_ID,
    build: buildMemoryPromotedPayloadJsonSchema,
  },
  // Goal-lifecycle-v1 payloads — one case per event type under §5 of the spec.
  {
    name: "goal-created-payload-v1",
    filename: "goal-created-payload-v1.json",
    expectedId: GOAL_CREATED_PAYLOAD_SCHEMA_ID,
    build: buildGoalCreatedPayloadJsonSchema,
  },
  {
    name: "goal-executed-payload-v1",
    filename: "goal-executed-payload-v1.json",
    expectedId: GOAL_EXECUTED_PAYLOAD_SCHEMA_ID,
    build: buildGoalExecutedPayloadJsonSchema,
  },
  {
    name: "goal-progress-payload-v1",
    filename: "goal-progress-payload-v1.json",
    expectedId: GOAL_PROGRESS_PAYLOAD_SCHEMA_ID,
    build: buildGoalProgressPayloadJsonSchema,
  },
  {
    name: "goal-completed-payload-v1",
    filename: "goal-completed-payload-v1.json",
    expectedId: GOAL_COMPLETED_PAYLOAD_SCHEMA_ID,
    build: buildGoalCompletedPayloadJsonSchema,
  },
  {
    name: "goal-removed-payload-v1",
    filename: "goal-removed-payload-v1.json",
    expectedId: GOAL_REMOVED_PAYLOAD_SCHEMA_ID,
    build: buildGoalRemovedPayloadJsonSchema,
  },
  // Plan-lifecycle-v1 payloads — one case per event type under §5 of the spec.
  {
    name: "plan-created-payload-v1",
    filename: "plan-created-payload-v1.json",
    expectedId: PLAN_CREATED_PAYLOAD_SCHEMA_ID,
    build: buildPlanCreatedPayloadJsonSchema,
  },
  {
    name: "plan-step-started-payload-v1",
    filename: "plan-step-started-payload-v1.json",
    expectedId: PLAN_STEP_STARTED_PAYLOAD_SCHEMA_ID,
    build: buildPlanStepStartedPayloadJsonSchema,
  },
  {
    name: "plan-step-completed-payload-v1",
    filename: "plan-step-completed-payload-v1.json",
    expectedId: PLAN_STEP_COMPLETED_PAYLOAD_SCHEMA_ID,
    build: buildPlanStepCompletedPayloadJsonSchema,
  },
  {
    name: "plan-step-failed-payload-v1",
    filename: "plan-step-failed-payload-v1.json",
    expectedId: PLAN_STEP_FAILED_PAYLOAD_SCHEMA_ID,
    build: buildPlanStepFailedPayloadJsonSchema,
  },
  {
    name: "plan-step-delegated-payload-v1",
    filename: "plan-step-delegated-payload-v1.json",
    expectedId: PLAN_STEP_DELEGATED_PAYLOAD_SCHEMA_ID,
    build: buildPlanStepDelegatedPayloadJsonSchema,
  },
  {
    name: "plan-completed-payload-v1",
    filename: "plan-completed-payload-v1.json",
    expectedId: PLAN_COMPLETED_PAYLOAD_SCHEMA_ID,
    build: buildPlanCompletedPayloadJsonSchema,
  },
  {
    name: "plan-failed-payload-v1",
    filename: "plan-failed-payload-v1.json",
    expectedId: PLAN_FAILED_PAYLOAD_SCHEMA_ID,
    build: buildPlanFailedPayloadJsonSchema,
  },
];

describe("wire-schemas drift (invariant #22)", () => {
  for (const c of CASES) {
    describe(c.name, () => {
      it("committed schema matches the live zod-derived JSON Schema", () => {
        const path = resolve(import.meta.dirname, "..", "..", "schema", c.filename);
        const committed = JSON.parse(readFileSync(path, "utf-8"));
        const live = c.build();
        expect(
          committed,
          `Committed ${c.filename} drifted from zod source. Run \`pnpm --filter @motebit/wire-schemas build-schemas\` and commit the result.`,
        ).toEqual(live);
      });

      it("schema exposes the stable $id external tools pin to", () => {
        const live = c.build();
        expect(live.$id).toBe(c.expectedId);
        expect(String(live.$id)).toMatch(new RegExp(`/${c.filename.replace(/\./g, "\\.")}$`));
      });

      it("declares JSON Schema draft-07", () => {
        const live = c.build();
        expect(live.$schema).toBe("http://json-schema.org/draft-07/schema#");
      });

      it("every top-level property carries a description", () => {
        const live = c.build();
        const props = live.properties as Record<string, { description?: string }>;
        const undocumented: string[] = [];
        for (const [key, value] of Object.entries(props)) {
          if (value.description == null || value.description === "") {
            undocumented.push(key);
          }
        }
        expect(
          undocumented,
          `Top-level properties with no description:\n  ${undocumented.join("\n  ")}`,
        ).toEqual([]);
      });
    });
  }
});
