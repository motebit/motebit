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
 *   - milestone 1 (here): identity — behaviour-preserving extraction.
 *   - 3a: brand relaxation keyed on MUTUAL assignability with a branded
 *         ID (so `MotebitId`/string-wide collapse to string, but narrow
 *         literals like `"completed"` do not — fixes the optional-brand
 *         over-match, inventory § C3).
 *   - 3b: nominal-enum → value-literal-union equivalence (inventory § C1).
 *   - 3c: `readonly` array/property relaxation (inventory § C2).
 *   - 3d: per-arm discriminated-union handling (inventory § C4).
 *
 * NOT shipped to consumers — excluded from the npm tarball (the package
 * `files` allowlist). Pure compile-time types; zero runtime surface.
 */

// milestone 1: identity. Grown in 3a–3d.
export type Relax<T> = T;

/** Forward: every protocol value is a valid schema value. */
export type ParityForward<Protocol, Schema> = Relax<Protocol> extends Schema ? true : never;

/** Reverse: every schema value is a valid protocol value. */
export type ParityReverse<Protocol, Schema> = Schema extends Relax<Protocol> ? true : never;
