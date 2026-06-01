/**
 * Compile-time assertions for the parity `Relax` helper — drift defense #22.
 *
 * These do NOT run under vitest; they bite `tsc`. If someone tightens or
 * loosens `Relax` so that it stops collapsing branded ids, or starts
 * collapsing the narrow literal unions a schema legitimately pins, one of
 * the `Assert<…>` aliases below fails its `extends true` constraint and
 * `pnpm --filter @motebit/wire-schemas typecheck` goes red. That is the
 * real regression defense for the relaxation itself.
 *
 * Excluded from the npm tarball (the package `files` allowlist ships only
 * `dist/`; this dev-only file is dropped — see step 5 / `pnpm pack --dry-run`).
 */
import type { MotebitId, GoalId, SettlementId, SuiteId } from "@motebit/protocol";

import type { Relax } from "./check.js";

type Assert<T extends true> = T;
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// ── 3a: branded ids collapse to string — for EVERY Brand<string,_>, not
//        just the three the original sketch enumerated. IsStringWide keys
//        off mutual assignability with `string`, so coverage is automatic.
export type _BrandMotebit = Assert<Eq<Relax<MotebitId>, string>>;
export type _BrandGoal = Assert<Eq<Relax<GoalId>, string>>;
export type _BrandSettlement = Assert<Eq<Relax<SettlementId>, string>>;

// ── 3a: distribution preserves `undefined` (optional fields).
export type _BrandOptional = Assert<Eq<Relax<MotebitId | undefined>, string | undefined>>;

// ── 3a: narrow string-literal unions are PRESERVED, not collapsed — this is
//        the regression case the optional-brand over-match used to break.
//        Covers `"completed"`-style enums-as-unions AND `SuiteId` (so the
//        suite-pin divergence stays visible until the step-3 doctrine call).
export type _LiteralKept = Assert<
  Eq<Relax<"completed" | "failed" | "denied">, "completed" | "failed" | "denied">
>;
export type _SuiteIdKept = Assert<Eq<Relax<SuiteId>, SuiteId>>;

// ── 3a: structural recursion — branded ids collapse at depth, in arrays and
//        nested objects.
export type _NestedObject = Assert<
  Eq<Relax<{ id: MotebitId; status: "ok" }>, { id: string; status: "ok" }>
>;
export type _ArrayElements = Assert<Eq<Relax<MotebitId[]>, string[]>>;

// ── 3a: readonly arrays are NOT yet stripped — that is 3c's one-line change.
//        This asserts the *current* behaviour so 3c is a deliberate, visible
//        edit (flip this to `Eq<…, string[]>` when 3c lands).
export type _ReadonlyArrayPreserved = Assert<
  Relax<readonly string[]> extends string[] ? false : true
>;
