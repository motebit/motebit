/**
 * Zod schema walker — the single bridge between `yaml-config.ts` (the source
 * of truth for the motebit.yaml contract) and the LSP server (hover text,
 * completion items).
 *
 * Nothing here duplicates the schema. Every description, enum value, and
 * field name is read from the live zod objects. Adding a `.describe()` in
 * `yaml-config.ts` lights up in hover without a code change here; adding a
 * new field lights up in completion; renaming an enum lights up in the
 * dropdown. That's the whole point of the placement choice.
 *
 * Sharp edges:
 *  - `.optional()`, `.default()`, and `.transform()` all wrap the inner
 *    schema in outer types (ZodOptional / ZodDefault / ZodEffects). Each
 *    carries its own `_def.description`, so `findDescription` walks outside
 *    → inside and returns the first non-empty description it finds.
 *  - `z.literal(1)` is not enumerable like `z.enum([...])`; `enumValues`
 *    returns the single literal value as a one-element array so completion
 *    can still offer it as a value hint.
 */

import { z } from "zod";

/** Unwrap one layer of an outer wrapper type. Returns null if nothing to unwrap. */
export function unwrapOne(schema: z.ZodTypeAny): z.ZodTypeAny | null {
  if (schema instanceof z.ZodOptional) return schema.unwrap() as z.ZodTypeAny;
  if (schema instanceof z.ZodDefault) return schema.removeDefault() as z.ZodTypeAny;
  if (schema instanceof z.ZodEffects) return schema.innerType() as z.ZodTypeAny;
  if (schema instanceof z.ZodNullable) return schema.unwrap() as z.ZodTypeAny;
  return null;
}

/** Fully unwrap a schema to its innermost type (ZodObject / ZodArray / ZodString / ...). */
export function unwrapAll(schema: z.ZodTypeAny): z.ZodTypeAny {
  let cur: z.ZodTypeAny = schema;
  for (;;) {
    const next = unwrapOne(cur);
    if (next === null) return cur;
    cur = next;
  }
}

/**
 * Walk outside-in, returning the first description found. Preserves the
 * outer-most description when the field was described at the `.optional()`
 * or `.default()` layer — which is the common case in yaml-config.ts.
 */
export function findDescription(schema: z.ZodTypeAny): string | undefined {
  let cur: z.ZodTypeAny = schema;
  for (;;) {
    const desc = (cur._def as { description?: string }).description;
    if (desc != null && desc !== "") return desc;
    const next = unwrapOne(cur);
    if (next === null) return undefined;
    cur = next;
  }
}

/**
 * Follow `path` into `schema`, descending into ZodObject shapes and ZodArray
 * elements. Returns null if any segment does not resolve.
 */
export function resolvePath(
  schema: z.ZodTypeAny,
  path: readonly (string | number)[],
): z.ZodTypeAny | null {
  let cur: z.ZodTypeAny = schema;
  for (const seg of path) {
    const inner = unwrapAll(cur);
    if (inner instanceof z.ZodObject) {
      const shape = inner.shape as Record<string, z.ZodTypeAny>;
      const next = shape[String(seg)];
      if (!next) return null;
      cur = next;
      continue;
    }
    if (inner instanceof z.ZodArray) {
      // Array index steps descend into the element; string-valued "schema
      // paths" from callers are normalized to numbers on the way in.
      cur = (inner as z.ZodArray<z.ZodTypeAny>).element;
      continue;
    }
    return null;
  }
  return cur;
}

/** Keys of the ZodObject reached by `path`, or [] if the target is not an object. */
export function objectKeys(schema: z.ZodTypeAny, path: readonly (string | number)[]): string[] {
  const target = resolvePath(schema, path);
  if (target == null) return [];
  const inner = unwrapAll(target);
  if (inner instanceof z.ZodObject) {
    return Object.keys(inner.shape as Record<string, unknown>);
  }
  if (inner instanceof z.ZodArray) {
    // For array targets, offer the element object's keys — that's what the
    // user is about to write after a `-` bullet.
    const elem = unwrapAll((inner as z.ZodArray<z.ZodTypeAny>).element);
    if (elem instanceof z.ZodObject) {
      return Object.keys(elem.shape as Record<string, unknown>);
    }
  }
  return [];
}

/**
 * Enum values for the schema at `path`. Covers `z.enum([...])`, `z.literal`,
 * `z.boolean` (as ["true","false"]). Returns null for anything else.
 */
export function enumValues(
  schema: z.ZodTypeAny,
  path: readonly (string | number)[],
): string[] | null {
  const target = resolvePath(schema, path);
  if (target == null) return null;
  const inner = unwrapAll(target);
  if (inner instanceof z.ZodEnum) {
    return [...(inner.options as string[])];
  }
  if (inner instanceof z.ZodLiteral) {
    return [String(inner.value as unknown)];
  }
  if (inner instanceof z.ZodBoolean) {
    return ["true", "false"];
  }
  return null;
}
