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
