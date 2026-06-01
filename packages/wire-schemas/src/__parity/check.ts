/**
 * Shared compile-time type-parity machinery — drift defense #22, the
 * compile-time half.
 *
 * Each wire schema carries a `_*_TYPE_PARITY` block that asserts the zod
 * shape and the `@motebit/protocol` type agree on the wire. Historically
 * each block inlined its own `Protocol extends Inferred ? true : never`
 * comparison (and three files a bespoke `BrandedToString<T>` relaxation).
 * That duplication meant a fix to the comparison was 27 hand-edits, and
 * the comparison itself carried artifacts that made wire-identical shapes
 * read as drift (see `docs/parity-inventory.md` § C). This module is the
 * single point those comparisons route through.
 *
 * `Relax<T>` normalizes a protocol type to its on-the-wire-equivalent
 * shape before the structural comparison, so that constructs that differ
 * only in TypeScript's type system but serialize identically (branded IDs,
 * `readonly` arrays, nominal enums, per-arm discriminated unions) do not
 * read as drift. Its capabilities are introduced incrementally, one
 * commit each, so the strip-the-casts failure count drops by a measurable
 * amount per capability (the proof the relaxation is sound and not a
 * blanket mute):
 *
 *   - milestone 1: identity — behaviour-preserving extraction.
 *   - 3a: string-wide collapse keyed on MUTUAL assignability with `string`
 *         (so every `Brand<string, _>` id collapses to string, but narrow
 *         literals like `"completed"` do not — fixes the optional-brand
 *         over-match, inventory § C3) + structural recursion.
 *   - 3b (current): nominal-enum → value-literal-union equivalence via
 *         `` `${T}` `` (inventory § C1).
 *   - 3c: `readonly` array/property relaxation (inventory § C2).
 *   - 3d: per-arm discriminated-union handling (inventory § C4).
 *
 * NOT shipped to consumers — excluded from the npm tarball (the package
 * `files` allowlist). Pure compile-time types; zero runtime surface.
 */

/**
 * A field is "string-wide" when it is mutually assignable with `string`:
 * true for plain `string` and for every `Brand<string, _>` id (the brand
 * property is optional, so a branded id and `string` are mutually
 * assignable — see `docs/parity-inventory.md` § C3 / § D), false for narrow
 * string-literal unions (`"completed"`, `SuiteId`, `"relay" | "p2p"`).
 *
 * This is the generalization of brand relaxation: it collapses ALL branded
 * ids (`MotebitId`, `DeviceId`, `NodeId`, `GoalId`, `SettlementId`, … — 11
 * today, and any future `Brand<string, _>`) to `string` WITHOUT enumerating
 * them, while preserving the literal unions a schema legitimately pins. The
 * mutual check is what excludes narrow literals: `[string] extends
 * ["completed"]` is false, so `"completed"` is kept.
 */
type IsStringWide<X> = [X] extends [string] ? ([string] extends [X] ? true : false) : false;

/**
 * Structural relaxation, applied after the string-wide collapse. Arrays
 * recurse element-wise and PRESERVE their read/write variance (3c flips the
 * readonly arm to mutable — a one-line change); objects recurse
 * homomorphically, preserving optional/readonly modifiers (3c adds
 * `-readonly`). Discriminated unions fall out of `Relax`'s distribution
 * (3d). Nominal TS enums are left intact here — they are 3b's job, and
 * their continued failure after 3a is the metric that 3a did not over-reach.
 */
type RelaxStructural<T> = T extends (infer U)[]
  ? Relax<U>[]
  : T extends readonly (infer U)[]
    ? readonly Relax<U>[]
    : T extends object
      ? { [K in keyof T]: Relax<T[K]> }
      : T;

/**
 * A nominal TS `enum` type is a union of its members, each nominally
 * distinct from the bare string-literal a `z.enum([...])` infers — so
 * `DeviceCapability` reads as drift against `"stdio_mcp" | ...` even though
 * the serialized values are identical (inventory § C1). `` `${T}` ``
 * re-projects each member to its string value, erasing the nominal tag. It
 * is a no-op for plain literal unions (`` `${"a" | "b"}` `` is `"a" | "b"`),
 * so `SuiteId` / `"relay" | "p2p"` and other schema-pinned unions are
 * untouched — the real divergences they carry stay visible.
 */
type RelaxOne<T> =
  IsStringWide<T> extends true ? string : [T] extends [string] ? `${T}` : RelaxStructural<T>;

/**
 * Normalize a protocol type to its on-the-wire-equivalent shape before
 * comparison. Distributive over unions, so `Relax<MotebitId | undefined>`
 * is `string | undefined` (the brand collapses, `undefined` is preserved).
 *
 * Capability ladder (one commit each; see module header):
 *   3a: string-wide collapse + structural recursion.
 *   3b (here): nominal-enum → value-literal equivalence.
 *   3c: readonly-array/property → mutable.
 *   3d: explicit per-arm discriminated-union handling (today via distribution).
 */
export type Relax<T> = T extends unknown ? RelaxOne<T> : never;

/** Forward: every protocol value is a valid schema value. */
export type ParityForward<Protocol, Schema> = Relax<Protocol> extends Schema ? true : never;

/** Reverse: every schema value is a valid protocol value. */
export type ParityReverse<Protocol, Schema> = Schema extends Relax<Protocol> ? true : never;
