/**
 * Build script — dump `MotebitYamlObjectSchema` as a JSON Schema file.
 *
 * The committed `apps/cli/schema/motebit-yaml-v1.json` is the public
 * artifact: any editor that speaks YAML Language Server (VS Code's Red
 * Hat YAML extension, NeoVim's yaml-language-server, JetBrains' built-in
 * YAML support) picks it up via `# yaml-language-server: $schema=…` or
 * the equivalent `yaml.schemas` config entry. Publishing it as a file —
 * not a CLI-runtime dump — is what makes motebit.yaml validatable by
 * third-party tools without installing the CLI.
 *
 * The CLI also exposes `motebit schema` which emits the same JSON on
 * stdout; the drift test `__tests__/yaml-json-schema.test.ts` runs this
 * generation in-process and deep-equals the committed file.
 *
 * Run manually after editing `src/yaml-config.ts`:
 *   pnpm --filter motebit build-schema
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildYamlJsonSchema } from "../src/yaml-json-schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(__dirname, "..", "schema", "motebit-yaml-v1.json");

const schema = buildYamlJsonSchema();
writeFileSync(OUT_PATH, JSON.stringify(schema, null, 2) + "\n", "utf-8");
console.log(`wrote ${OUT_PATH}`);
