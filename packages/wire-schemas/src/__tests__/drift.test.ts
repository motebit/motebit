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
