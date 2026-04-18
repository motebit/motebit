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

import { buildAgentResolutionResultJsonSchema } from "../src/agent-resolution-result.js";
import { buildAgentServiceListingJsonSchema } from "../src/agent-service-listing.js";
import { buildAgentTaskJsonSchema } from "../src/agent-task.js";
import { buildDelegationTokenJsonSchema } from "../src/delegation-token.js";
import { buildExecutionReceiptJsonSchema } from "../src/execution-receipt.js";
import {
  buildCredentialAnchorBatchJsonSchema,
  buildCredentialAnchorProofJsonSchema,
} from "../src/credential-anchor.js";
import { buildCredentialBundleJsonSchema } from "../src/credential-bundle.js";
import {
  buildGradientCredentialSubjectJsonSchema,
  buildReputationCredentialSubjectJsonSchema,
  buildTrustCredentialSubjectJsonSchema,
} from "../src/credential-subjects.js";
import {
  buildAdjudicatorVoteJsonSchema,
  buildDisputeAppealJsonSchema,
  buildDisputeEvidenceJsonSchema,
  buildDisputeRequestJsonSchema,
  buildDisputeResolutionJsonSchema,
} from "../src/dispute.js";
import {
  buildDepartureAttestationJsonSchema,
  buildMigrationPresentationJsonSchema,
  buildMigrationRequestJsonSchema,
  buildMigrationTokenJsonSchema,
} from "../src/migration.js";
import { buildRouteScoreJsonSchema } from "../src/route-score.js";
import { buildSettlementRecordJsonSchema } from "../src/settlement-record.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(__dirname, "..", "schema");

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
  { filename: "credential-anchor-batch-v1.json", build: buildCredentialAnchorBatchJsonSchema },
  { filename: "credential-anchor-proof-v1.json", build: buildCredentialAnchorProofJsonSchema },
];

for (const { filename, build } of SCHEMAS) {
  const outPath = join(SCHEMA_DIR, filename);
  writeFileSync(outPath, JSON.stringify(build(), null, 2) + "\n", "utf-8");
  console.log(`wrote ${outPath}`);
}
