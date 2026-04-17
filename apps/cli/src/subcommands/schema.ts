/**
 * `motebit schema` — dump the motebit.yaml JSON Schema to stdout.
 *
 * Two use cases:
 *   - `motebit schema > motebit-yaml.schema.json` — vendor the schema
 *     into a project that wants IDE validation without fetching from
 *     GitHub (e.g. air-gapped environments).
 *   - `motebit schema | jq …` — programmatic inspection.
 *
 * Emits the same JSON Schema that `scripts/build-schema.ts` writes to
 * `apps/cli/schema/motebit-yaml-v1.json` — the drift test in
 * `__tests__/yaml-json-schema.test.ts` enforces equality.
 */

import { buildYamlJsonSchema } from "../yaml-json-schema.js";

export function handleSchema(): void {
  const schema = buildYamlJsonSchema();
  process.stdout.write(JSON.stringify(schema, null, 2) + "\n");
}
