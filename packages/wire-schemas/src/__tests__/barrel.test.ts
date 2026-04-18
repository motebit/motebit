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

  it("re-exports all wire-format $id URLs as stable raw-GitHub URLs", () => {
    const urls = [
      barrel.EXECUTION_RECEIPT_SCHEMA_ID,
      barrel.DELEGATION_TOKEN_SCHEMA_ID,
      barrel.AGENT_SERVICE_LISTING_SCHEMA_ID,
      barrel.AGENT_RESOLUTION_RESULT_SCHEMA_ID,
      barrel.AGENT_TASK_SCHEMA_ID,
      barrel.SETTLEMENT_RECORD_SCHEMA_ID,
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
  });

  it("re-exports the shared assemble helper", () => {
    expect(typeof barrel.assembleJsonSchemaFor).toBe("function");
  });
});
