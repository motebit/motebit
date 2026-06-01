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
 *   - 3b: nominal-enum → value-literal-union equivalence via `` `${T}` ``
 *         (inventory § C1).
 *   - 3c: `readonly` array/property relaxation (inventory § C2).
 *   - 3d: per-arm discriminated-union handling (inventory § C4) — already
 *         provided by 3a's distributive wrapper (the `keyof`-on-union
 *         collapse was a probe artifact, never present in this
 *         `extends`-based check); no functional change, count unchanged.
 *         Locked by the `_DiscUnionPerArm` assertion in check.test-types.ts.
 *
 * Dev-only checker, not part of the public surface: `@motebit/wire-schemas`
 * is `private` / `0.0.0-private` and never publishes, and these consts are
 * not re-exported from `index.ts`. The types are pure compile-time (the
 * emitted JS is `export {}` — zero runtime surface); they do compile into
 * `dist/__parity/` but that is inert on a never-published package.
 *
 * `Relax` is applied to the PROTOCOL side only (`ParityForward` /
 * `ParityReverse`). That is sound because zod never infers branded,
 * `readonly`, or nominal-enum forms — so the schema side needs no
 * normalization. The premise is load-bearing: if a schema author ever
 * introduces `.brand(...)` or `z.readonly(...)`, this one-sided relaxation
 * would go asymmetric and must be revisited.
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
 * recurse element-wise; objects recurse homomorphically. Both NORMALIZE
 * read/write variance to mutable (3c): protocol `ReadonlyArray<X>` and
 * `readonly` properties are wire-equivalent to their mutable forms, but
 * `readonly T[]` is not assignable to the mutable `T[]` zod infers (inventory
 * § C2), so the single readonly-matching array arm (which also matches
 * mutable arrays) emits `Relax<U>[]`, and the object map strips `readonly`
 * via `-readonly`. Optional modifiers are preserved (homomorphic map).
 * Discriminated unions fall out of `Relax`'s distribution (3d). Nominal TS
 * enums are handled in `RelaxOne` (3b), not here.
 *
 * Known gap: the array arm matches fixed-length TUPLES too and flattens
 * `[A, B]` → `(A | B)[]`, which would mask a positional divergence. No wire
 * schema uses `z.tuple` and no wire protocol type is a fixed-length tuple
 * today, so the blast radius is nil; add a `T extends readonly [unknown,
 * ...unknown[]]` guard here if a tuple wire type is ever introduced.
 */
type RelaxStructural<T> = T extends readonly (infer U)[]
  ? Relax<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Relax<T[K]> }
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
 *   3b: nominal-enum → value-literal equivalence.
 *   3c: readonly-array/property → mutable.
 *   3d: per-arm discriminated-union handling — already provided here by the
 *       distributive `T extends unknown ? … : never` wrapper.
 */
export type Relax<T> = T extends unknown ? RelaxOne<T> : never;

/** Forward: every protocol value is a valid schema value. */
export type ParityForward<Protocol, Schema> = Relax<Protocol> extends Schema ? true : never;

/** Reverse: every schema value is a valid protocol value. */
export type ParityReverse<Protocol, Schema> = Schema extends Relax<Protocol> ? true : never;
