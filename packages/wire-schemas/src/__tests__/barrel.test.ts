/**
 * Exercise the barrel export to confirm the public surface loads and
 * matches the per-module re-exports. If a new wire-format schema ships
 * without being added to `src/index.ts`, external consumers can't reach
 * it — this test shouts about that.
 */
import { describe, expect, it } from "vitest";

import * as barrel from "../index.js";

describe("@motebit/wire-schemas barrel", () => {
  it("re-exports ExecutionReceiptSchema", () => {
    expect(barrel.ExecutionReceiptSchema).toBeDefined();
    expect(typeof barrel.ExecutionReceiptSchema.parse).toBe("function");
  });

  it("re-exports DelegationTokenSchema", () => {
    expect(barrel.DelegationTokenSchema).toBeDefined();
    expect(typeof barrel.DelegationTokenSchema.parse).toBe("function");
  });

  it("re-exports AgentServiceListingSchema", () => {
    expect(barrel.AgentServiceListingSchema).toBeDefined();
    expect(typeof barrel.AgentServiceListingSchema.parse).toBe("function");
  });

  it("re-exports AgentResolutionResultSchema", () => {
    expect(barrel.AgentResolutionResultSchema).toBeDefined();
    expect(typeof barrel.AgentResolutionResultSchema.parse).toBe("function");
  });

  it("re-exports AgentTaskSchema", () => {
    expect(barrel.AgentTaskSchema).toBeDefined();
    expect(typeof barrel.AgentTaskSchema.parse).toBe("function");
  });

  it("re-exports SettlementRecordSchema", () => {
    expect(barrel.SettlementRecordSchema).toBeDefined();
    expect(typeof barrel.SettlementRecordSchema.parse).toBe("function");
  });

  it("re-exports RouteScoreSchema", () => {
    expect(barrel.RouteScoreSchema).toBeDefined();
    expect(typeof barrel.RouteScoreSchema.parse).toBe("function");
  });

  it("re-exports CredentialBundleSchema", () => {
    expect(barrel.CredentialBundleSchema).toBeDefined();
    expect(typeof barrel.CredentialBundleSchema.parse).toBe("function");
  });

  it("re-exports the migration cluster (Request/Token/Attestation/Presentation)", () => {
    expect(typeof barrel.MigrationRequestSchema.parse).toBe("function");
    expect(typeof barrel.MigrationTokenSchema.parse).toBe("function");
    expect(typeof barrel.DepartureAttestationSchema.parse).toBe("function");
    expect(typeof barrel.MigrationPresentationSchema.parse).toBe("function");
  });

  it("re-exports the dispute cluster (Request/Evidence/Vote/Resolution/Appeal)", () => {
    expect(typeof barrel.DisputeRequestSchema.parse).toBe("function");
    expect(typeof barrel.DisputeEvidenceSchema.parse).toBe("function");
    expect(typeof barrel.AdjudicatorVoteSchema.parse).toBe("function");
    expect(typeof barrel.DisputeResolutionSchema.parse).toBe("function");
    expect(typeof barrel.DisputeAppealSchema.parse).toBe("function");
  });

  it("re-exports the credential-subject triple (Reputation/Trust/Gradient)", () => {
    expect(typeof barrel.ReputationCredentialSubjectSchema.parse).toBe("function");
    expect(typeof barrel.TrustCredentialSubjectSchema.parse).toBe("function");
    expect(typeof barrel.GradientCredentialSubjectSchema.parse).toBe("function");
  });

  it("re-exports all wire-format $id URLs as stable raw-GitHub URLs", () => {
    const urls = [
      barrel.EXECUTION_RECEIPT_SCHEMA_ID,
      barrel.DELEGATION_TOKEN_SCHEMA_ID,
      barrel.AGENT_SERVICE_LISTING_SCHEMA_ID,
      barrel.AGENT_RESOLUTION_RESULT_SCHEMA_ID,
      barrel.AGENT_TASK_SCHEMA_ID,
      barrel.SETTLEMENT_RECORD_SCHEMA_ID,
      barrel.ROUTE_SCORE_SCHEMA_ID,
      barrel.CREDENTIAL_BUNDLE_SCHEMA_ID,
      barrel.MIGRATION_REQUEST_SCHEMA_ID,
      barrel.MIGRATION_TOKEN_SCHEMA_ID,
      barrel.DEPARTURE_ATTESTATION_SCHEMA_ID,
      barrel.MIGRATION_PRESENTATION_SCHEMA_ID,
      barrel.DISPUTE_REQUEST_SCHEMA_ID,
      barrel.DISPUTE_EVIDENCE_SCHEMA_ID,
      barrel.ADJUDICATOR_VOTE_SCHEMA_ID,
      barrel.DISPUTE_RESOLUTION_SCHEMA_ID,
      barrel.DISPUTE_APPEAL_SCHEMA_ID,
      barrel.REPUTATION_CREDENTIAL_SUBJECT_SCHEMA_ID,
      barrel.TRUST_CREDENTIAL_SUBJECT_SCHEMA_ID,
      barrel.GRADIENT_CREDENTIAL_SUBJECT_SCHEMA_ID,
    ];
    for (const url of urls) {
      expect(url).toMatch(/^https:\/\/raw\.githubusercontent\.com\/motebit\/motebit\/main\//);
    }
  });

  it("re-exports every build-*JsonSchema builder as a function", () => {
    expect(typeof barrel.buildExecutionReceiptJsonSchema).toBe("function");
    expect(barrel.buildExecutionReceiptJsonSchema().title).toBe("ExecutionReceipt (v1)");
    expect(typeof barrel.buildDelegationTokenJsonSchema).toBe("function");
    expect(barrel.buildDelegationTokenJsonSchema().title).toBe("DelegationToken (v1)");
    expect(typeof barrel.buildAgentServiceListingJsonSchema).toBe("function");
    expect(barrel.buildAgentServiceListingJsonSchema().title).toBe("AgentServiceListing (v1)");
    expect(typeof barrel.buildAgentResolutionResultJsonSchema).toBe("function");
    expect(barrel.buildAgentResolutionResultJsonSchema().title).toBe("AgentResolutionResult (v1)");
    expect(typeof barrel.buildAgentTaskJsonSchema).toBe("function");
    expect(barrel.buildAgentTaskJsonSchema().title).toBe("AgentTask (v1)");
    expect(typeof barrel.buildSettlementRecordJsonSchema).toBe("function");
    expect(barrel.buildSettlementRecordJsonSchema().title).toBe("SettlementRecord (v1)");
    expect(typeof barrel.buildRouteScoreJsonSchema).toBe("function");
    expect(barrel.buildRouteScoreJsonSchema().title).toBe("RouteScore (v1)");
    expect(typeof barrel.buildCredentialBundleJsonSchema).toBe("function");
    expect(barrel.buildCredentialBundleJsonSchema().title).toBe("CredentialBundle (v1)");
    expect(barrel.buildMigrationRequestJsonSchema().title).toBe("MigrationRequest (v1)");
    expect(barrel.buildMigrationTokenJsonSchema().title).toBe("MigrationToken (v1)");
    expect(barrel.buildDepartureAttestationJsonSchema().title).toBe("DepartureAttestation (v1)");
    expect(barrel.buildMigrationPresentationJsonSchema().title).toBe("MigrationPresentation (v1)");
    expect(barrel.buildDisputeRequestJsonSchema().title).toBe("DisputeRequest (v1)");
    expect(barrel.buildDisputeEvidenceJsonSchema().title).toBe("DisputeEvidence (v1)");
    expect(barrel.buildAdjudicatorVoteJsonSchema().title).toBe("AdjudicatorVote (v1)");
    expect(barrel.buildDisputeResolutionJsonSchema().title).toBe("DisputeResolution (v1)");
    expect(barrel.buildDisputeAppealJsonSchema().title).toBe("DisputeAppeal (v1)");
    expect(barrel.buildReputationCredentialSubjectJsonSchema().title).toBe(
      "ReputationCredentialSubject (v1)",
    );
    expect(barrel.buildTrustCredentialSubjectJsonSchema().title).toBe(
      "TrustCredentialSubject (v1)",
    );
    expect(barrel.buildGradientCredentialSubjectJsonSchema().title).toBe(
      "GradientCredentialSubject (v1)",
    );
  });

  it("re-exports the shared assemble helper", () => {
    expect(typeof barrel.assembleJsonSchemaFor).toBe("function");
  });
});
