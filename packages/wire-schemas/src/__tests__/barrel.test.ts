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

  it("re-exports EXECUTION_RECEIPT_SCHEMA_ID as a stable URL", () => {
    expect(barrel.EXECUTION_RECEIPT_SCHEMA_ID).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/motebit\/motebit\/main\//,
    );
  });

  it("re-exports buildExecutionReceiptJsonSchema as a function", () => {
    expect(typeof barrel.buildExecutionReceiptJsonSchema).toBe("function");
    const schema = barrel.buildExecutionReceiptJsonSchema();
    expect(schema.title).toBe("ExecutionReceipt (v1)");
  });
});
