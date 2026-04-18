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
  DEPARTURE_ATTESTATION_SCHEMA_ID,
  MIGRATION_PRESENTATION_SCHEMA_ID,
  MIGRATION_REQUEST_SCHEMA_ID,
  MIGRATION_TOKEN_SCHEMA_ID,
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
