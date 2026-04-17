/**
 * Drift defense #21 — the committed `schema/motebit-yaml-v1.json` must
 * match the live `MotebitYamlObjectSchema` byte-for-byte (modulo
 * structural equality, which is what `expect(...).toEqual(...)` does).
 *
 * The published schema is part of motebit's protocol surface: external
 * validators (Red Hat YAML extension, CI actions, third-party tooling)
 * fetch the committed file. If the zod schema gains a new field and the
 * author forgets to run `pnpm --filter motebit build-schema`, the
 * committed artifact would silently misreport the contract. This test
 * closes that gap before PR review.
 *
 * On failure the fix is: `pnpm --filter motebit build-schema` and commit
 * the result. The test error message states that directly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildYamlJsonSchema, MOTEBIT_YAML_SCHEMA_ID } from "../yaml-json-schema.js";

describe("motebit-yaml-v1.json (drift defense #21)", () => {
  it("committed schema matches the live zod-derived JSON Schema", () => {
    const committedPath = resolve(
      import.meta.dirname,
      "..",
      "..",
      "schema",
      "motebit-yaml-v1.json",
    );
    const committed = JSON.parse(readFileSync(committedPath, "utf-8"));
    const live = buildYamlJsonSchema();
    expect(
      committed,
      "Committed schema drifted from zod source. Run `pnpm --filter motebit build-schema` and commit the result.",
    ).toEqual(live);
  });

  it("schema exposes the stable $id external tools pin to", () => {
    const schema = buildYamlJsonSchema();
    expect(schema.$id).toBe(MOTEBIT_YAML_SCHEMA_ID);
    // URL must be resolvable — i.e. point at a real path in the repo,
    // not a placeholder. Tight assertion: the final path segment must
    // match the committed filename.
    expect(String(schema.$id)).toMatch(/\/motebit-yaml-v1\.json$/);
  });

  it("every top-level property carries a description from the zod .describe()", () => {
    const schema = buildYamlJsonSchema();
    const props = schema.properties as Record<string, { description?: string }>;
    const undocumented: string[] = [];
    for (const [key, value] of Object.entries(props)) {
      if (value.description == null || value.description === "") {
        undocumented.push(key);
      }
    }
    expect(
      undocumented,
      `Top-level properties with no description — the LSP hover defense (#20) should have caught this upstream:\n  ${undocumented.join("\n  ")}`,
    ).toEqual([]);
  });
});
