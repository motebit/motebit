/**
 * Shared assembly helper for zod-to-json-schema output.
 *
 * Every wire-format module follows the same pattern: call `zodToJsonSchema`
 * with `name: "X"` + `$refStrategy: "root"`, which produces a
 * `{ $ref, definitions: { X: {...} } }` envelope, then inline the named
 * definition onto the top level so external tools get a self-describing
 * object while keeping `#/definitions/X` references intact for recursive
 * schemas.
 *
 * Extracted when the second wire format (DelegationToken) duplicated
 * what ExecutionReceipt was doing inline — the "two's a pattern" rule.
 */

export function assembleJsonSchemaFor(
  definitionName: string,
  raw: Record<string, unknown>,
  meta: { $id: string; title: string; description: string },
): Record<string, unknown> {
  const definitions = raw["definitions"] as Record<string, Record<string, unknown>> | undefined;
  if (definitions == null) {
    throw new Error(
      `zod-to-json-schema did not emit a definitions bag for ${definitionName} — upstream library behavior changed, fix this builder.`,
    );
  }
  const root = definitions[definitionName];
  if (root == null) {
    throw new Error(
      `zod-to-json-schema did not emit definitions.${definitionName} — upstream library behavior changed, fix this builder.`,
    );
  }
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: meta.$id,
    title: meta.title,
    description: meta.description,
    ...root,
    definitions,
  };
}
