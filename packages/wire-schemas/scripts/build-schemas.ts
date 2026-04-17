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

import { buildDelegationTokenJsonSchema } from "../src/delegation-token.js";
import { buildExecutionReceiptJsonSchema } from "../src/execution-receipt.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = join(__dirname, "..", "schema");

const SCHEMAS: Array<{ filename: string; build: () => Record<string, unknown> }> = [
  { filename: "execution-receipt-v1.json", build: buildExecutionReceiptJsonSchema },
  { filename: "delegation-token-v1.json", build: buildDelegationTokenJsonSchema },
];

for (const { filename, build } of SCHEMAS) {
  const outPath = join(SCHEMA_DIR, filename);
  writeFileSync(outPath, JSON.stringify(build(), null, 2) + "\n", "utf-8");
  console.log(`wrote ${outPath}`);
}
