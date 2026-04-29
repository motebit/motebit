/**
 * Dump every wire-format schema this package owns to disk. Adding a
 * new wire format means adding it to the list here (and to the
 * barrel export in `src/index.ts`). The drift test in
 * `src/__tests__/drift.test.ts` iterates the same list and pins each
 * committed file against live regeneration.
 *
 * Run manually after editing any schema:
 *   pnpm --filter @motebit/wire-schemas build-schemas
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { stampSchema } from "../src/spdx-stamp.js";
import { buildAgentResolutionResultJsonSchema } from "../src/agent-resolution-result.js";
import { buildAgentServiceListingJsonSchema } from "../src/agent-service-listing.js";
import { buildAgentTaskJsonSchema } from "../src/agent-task.js";
import { buildDelegationTokenJsonSchema } from "../src/delegation-token.js";
import { buildExecutionReceiptJsonSchema } from "../src/execution-receipt.js";
import {
  buildCredentialAnchorBatchJsonSchema,
  buildCredentialAnchorProofJsonSchema,
} from "../src/credential-anchor.js";
import {
  buildAgentSettlementAnchorBatchJsonSchema,
  buildAgentSettlementAnchorProofJsonSchema,
} from "../src/agent-settlement-anchor.js";
import {
  buildConsolidationReceiptJsonSchema,
  buildConsolidationAnchorJsonSchema,
} from "../src/consolidation-receipt.js";
import { buildCredentialBundleJsonSchema } from "../src/credential-bundle.js";
import {
  buildGradientCredentialSubjectJsonSchema,
  buildReputationCredentialSubjectJsonSchema,
  buildTrustCredentialSubjectJsonSchema,
} from "../src/credential-subjects.js";
import { buildHardwareAttestationClaimJsonSchema } from "../src/hardware-attestation-claim.js";
import {
  buildAdjudicatorVoteJsonSchema,
  buildDisputeAppealJsonSchema,
  buildDisputeEvidenceJsonSchema,
  buildDisputeRequestJsonSchema,
  buildDisputeResolutionJsonSchema,
} from "../src/dispute.js";
import {
  buildBalanceWaiverJsonSchema,
  buildDepartureAttestationJsonSchema,
  buildMigrationPresentationJsonSchema,
  buildMigrationRequestJsonSchema,
  buildMigrationTokenJsonSchema,
} from "../src/migration.js";
import {
  buildMemoryAccessedPayloadJsonSchema,
  buildMemoryAuditPayloadJsonSchema,
  buildMemoryConsolidatedPayloadJsonSchema,
  buildMemoryDecayedPayloadJsonSchema,
  buildMemoryDeletedPayloadJsonSchema,
  buildMemoryFormedPayloadJsonSchema,
  buildMemoryPinnedPayloadJsonSchema,
  buildMemoryPromotedPayloadJsonSchema,
} from "../src/memory-events.js";
import {
  buildGoalCreatedPayloadJsonSchema,
  buildGoalExecutedPayloadJsonSchema,
  buildGoalProgressPayloadJsonSchema,
  buildGoalCompletedPayloadJsonSchema,
  buildGoalRemovedPayloadJsonSchema,
} from "../src/goal-lifecycle.js";
import {
  buildPlanCreatedPayloadJsonSchema,
  buildPlanStepStartedPayloadJsonSchema,
  buildPlanStepCompletedPayloadJsonSchema,
  buildPlanStepFailedPayloadJsonSchema,
  buildPlanStepDelegatedPayloadJsonSchema,
  buildPlanCompletedPayloadJsonSchema,
  buildPlanFailedPayloadJsonSchema,
} from "../src/plan-lifecycle.js";
import {
  buildComputerActionRequestJsonSchema,
  buildComputerObservationResultJsonSchema,
  buildComputerSessionOpenedJsonSchema,
  buildComputerSessionClosedJsonSchema,
} from "../src/computer-use.js";
import { buildRouteScoreJsonSchema } from "../src/route-score.js";
import { buildSettlementRecordJsonSchema } from "../src/settlement-record.js";
import { buildSkillManifestJsonSchema } from "../src/skill-manifest.js";
import { buildSkillEnvelopeJsonSchema } from "../src/skill-envelope.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Schemas live in `spec/schemas/` alongside the Markdown protocol
// docs — protocol artifacts under the `spec/` Apache-2.0 license, separate
// from this BSL package's TypeScript sources. Resolving from this
// script's `__dirname` means walking up out of
// `packages/wire-schemas/scripts/` into the repo root, then into
// `spec/schemas/`.
const SCHEMA_DIR = join(__dirname, "..", "..", "..", "spec", "schemas");

const SCHEMAS: Array<{ filename: string; build: () => Record<string, unknown> }> = [
  { filename: "execution-receipt-v1.json", build: buildExecutionReceiptJsonSchema },
  { filename: "delegation-token-v1.json", build: buildDelegationTokenJsonSchema },
  { filename: "agent-service-listing-v1.json", build: buildAgentServiceListingJsonSchema },
  { filename: "agent-resolution-result-v1.json", build: buildAgentResolutionResultJsonSchema },
  { filename: "agent-task-v1.json", build: buildAgentTaskJsonSchema },
  { filename: "settlement-record-v1.json", build: buildSettlementRecordJsonSchema },
  { filename: "route-score-v1.json", build: buildRouteScoreJsonSchema },
  { filename: "credential-bundle-v1.json", build: buildCredentialBundleJsonSchema },
  { filename: "migration-request-v1.json", build: buildMigrationRequestJsonSchema },
  { filename: "migration-token-v1.json", build: buildMigrationTokenJsonSchema },
  { filename: "departure-attestation-v1.json", build: buildDepartureAttestationJsonSchema },
  { filename: "migration-presentation-v1.json", build: buildMigrationPresentationJsonSchema },
  { filename: "balance-waiver-v1.json", build: buildBalanceWaiverJsonSchema },
  { filename: "dispute-request-v1.json", build: buildDisputeRequestJsonSchema },
  { filename: "dispute-evidence-v1.json", build: buildDisputeEvidenceJsonSchema },
  { filename: "adjudicator-vote-v1.json", build: buildAdjudicatorVoteJsonSchema },
  { filename: "dispute-resolution-v1.json", build: buildDisputeResolutionJsonSchema },
  { filename: "dispute-appeal-v1.json", build: buildDisputeAppealJsonSchema },
  {
    filename: "reputation-credential-subject-v1.json",
    build: buildReputationCredentialSubjectJsonSchema,
  },
  {
    filename: "trust-credential-subject-v1.json",
    build: buildTrustCredentialSubjectJsonSchema,
  },
  {
    filename: "gradient-credential-subject-v1.json",
    build: buildGradientCredentialSubjectJsonSchema,
  },
  {
    filename: "hardware-attestation-claim-v1.json",
    build: buildHardwareAttestationClaimJsonSchema,
  },
  { filename: "credential-anchor-batch-v1.json", build: buildCredentialAnchorBatchJsonSchema },
  { filename: "credential-anchor-proof-v1.json", build: buildCredentialAnchorProofJsonSchema },
  {
    filename: "agent-settlement-anchor-batch-v1.json",
    build: buildAgentSettlementAnchorBatchJsonSchema,
  },
  {
    filename: "agent-settlement-anchor-proof-v1.json",
    build: buildAgentSettlementAnchorProofJsonSchema,
  },
  { filename: "consolidation-receipt-v1.json", build: buildConsolidationReceiptJsonSchema },
  { filename: "consolidation-anchor-v1.json", build: buildConsolidationAnchorJsonSchema },
  { filename: "memory-formed-payload-v1.json", build: buildMemoryFormedPayloadJsonSchema },
  { filename: "memory-accessed-payload-v1.json", build: buildMemoryAccessedPayloadJsonSchema },
  { filename: "memory-pinned-payload-v1.json", build: buildMemoryPinnedPayloadJsonSchema },
  { filename: "memory-deleted-payload-v1.json", build: buildMemoryDeletedPayloadJsonSchema },
  {
    filename: "memory-consolidated-payload-v1.json",
    build: buildMemoryConsolidatedPayloadJsonSchema,
  },
  { filename: "memory-audit-payload-v1.json", build: buildMemoryAuditPayloadJsonSchema },
  { filename: "memory-decayed-payload-v1.json", build: buildMemoryDecayedPayloadJsonSchema },
  { filename: "memory-promoted-payload-v1.json", build: buildMemoryPromotedPayloadJsonSchema },
  { filename: "goal-created-payload-v1.json", build: buildGoalCreatedPayloadJsonSchema },
  { filename: "goal-executed-payload-v1.json", build: buildGoalExecutedPayloadJsonSchema },
  { filename: "goal-progress-payload-v1.json", build: buildGoalProgressPayloadJsonSchema },
  { filename: "goal-completed-payload-v1.json", build: buildGoalCompletedPayloadJsonSchema },
  { filename: "goal-removed-payload-v1.json", build: buildGoalRemovedPayloadJsonSchema },
  { filename: "plan-created-payload-v1.json", build: buildPlanCreatedPayloadJsonSchema },
  { filename: "plan-step-started-payload-v1.json", build: buildPlanStepStartedPayloadJsonSchema },
  {
    filename: "plan-step-completed-payload-v1.json",
    build: buildPlanStepCompletedPayloadJsonSchema,
  },
  { filename: "plan-step-failed-payload-v1.json", build: buildPlanStepFailedPayloadJsonSchema },
  {
    filename: "plan-step-delegated-payload-v1.json",
    build: buildPlanStepDelegatedPayloadJsonSchema,
  },
  { filename: "plan-completed-payload-v1.json", build: buildPlanCompletedPayloadJsonSchema },
  { filename: "plan-failed-payload-v1.json", build: buildPlanFailedPayloadJsonSchema },
  { filename: "computer-action-request-v1.json", build: buildComputerActionRequestJsonSchema },
  {
    filename: "computer-observation-result-v1.json",
    build: buildComputerObservationResultJsonSchema,
  },
  { filename: "computer-session-opened-v1.json", build: buildComputerSessionOpenedJsonSchema },
  { filename: "computer-session-closed-v1.json", build: buildComputerSessionClosedJsonSchema },
  { filename: "skill-manifest-v1.json", build: buildSkillManifestJsonSchema },
  { filename: "skill-envelope-v1.json", build: buildSkillEnvelopeJsonSchema },
];

for (const { filename, build } of SCHEMAS) {
  const outPath = join(SCHEMA_DIR, filename);
  writeFileSync(outPath, JSON.stringify(stampSchema(build()), null, 2) + "\n", "utf-8");
  console.log(`wrote ${outPath}`);
}
