/**
 * Shared assembly helper for zod 4's native `z.toJSONSchema` output.
 *
 * Every wire-format module calls `toDraft7(Schema)` to render the schema, then
 * `assembleJsonSchemaFor(raw, meta)` to wrap it in the published draft-07
 * envelope (`$schema` + `$id`/`title`/`description` on top).
 *
 * History: this replaced `zod-to-json-schema@3`, which is zod-3-only — under
 * zod 4 it type-fails AND silently emits an empty `definitions` bag at runtime.
 * zod 4's native `z.toJSONSchema(schema, { target: "draft-7" })` inlines fully
 * (no `definitions`/`$defs` bag for the schemas in this package, recursive ones
 * included), so — unlike the old `$refStrategy: "root"` envelope — there is
 * nothing to hoist. The regenerated schemas are a validation-preserving reformat
 * of the previous output (same `required`/`properties`; `additionalProperties`
 * moves from `true` to `{}` for open objects, both meaning "allow extra"); the
 * committed `spec/schemas/*.json` were regenerated in place as v1.
 */
import { z } from "zod";

/** Render a zod schema to a draft-07 JSON Schema object (the target every
 * committed wire schema uses). Centralized so the options live in one place. */
export function toDraft7(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7" });
}

export function assembleJsonSchemaFor(
  raw: Record<string, unknown>,
  meta: { $id: string; title: string; description: string },
): Record<string, unknown> {
  // Strip the renderer's own `$schema` (we re-emit the canonical draft-07 URL
  // on top with the meta). `$defs`/`definitions` are not produced for any
  // schema in this package; guard so a future recursive shape that DOES emit
  // one is caught here rather than shipping refs pointing at a dropped bag.
  const { $schema: _rendererSchema, $defs, definitions, ...body } = raw;
  if ($defs != null || definitions != null) {
    throw new Error(
      "z.toJSONSchema emitted a $defs/definitions bag — a schema is now producing refs. " +
        "Rework assemble.ts to hoist it into `definitions` and rewrite the $ref paths " +
        "(#/$defs/X -> #/definitions/X) before shipping.",
    );
  }
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: meta.$id,
    title: meta.title,
    description: meta.description,
    ...body,
  };
}
