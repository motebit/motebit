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
];

for (const { filename, build } of SCHEMAS) {
  const outPath = join(SCHEMA_DIR, filename);
  writeFileSync(outPath, JSON.stringify(build(), null, 2) + "\n", "utf-8");
  console.log(`wrote ${outPath}`);
}
