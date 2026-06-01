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
 * Dev-only: `@motebit/wire-schemas` is `private` / `0.0.0-private` and never
 * publishes. This file compiles to an inert `export {}` in `dist/__parity/`;
 * it carries no runtime surface.
 */
import type { MotebitId, GoalId, SettlementId, SuiteId, AgentTaskStatus } from "@motebit/protocol";

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

// ── 3b: a nominal TS enum relaxes to its string-value union, so it matches
//        the `z.enum([...])` a schema infers. Bites if `${T}` projection is
//        removed.
export type _EnumToLiterals = Assert<
  Eq<
    Relax<AgentTaskStatus>,
    "pending" | "claimed" | "running" | "completed" | "failed" | "denied" | "expired"
  >
>;

// ── 3a: structural recursion — branded ids collapse at depth, in arrays and
//        nested objects.
export type _NestedObject = Assert<
  Eq<Relax<{ id: MotebitId; status: "ok" }>, { id: string; status: "ok" }>
>;
export type _ArrayElements = Assert<Eq<Relax<MotebitId[]>, string[]>>;

// ── 3d: discriminated unions relax PER ARM (Relax distributes via its
//        `T extends unknown ? … : never` wrapper), so each arm's branded
//        fields collapse independently and a per-arm divergence is still
//        caught — never masked by a union-level `keyof` (the keyof collapse
//        was a probe artifact, never present in this `extends`-based check).
//        Bites if the distributive wrapper is removed.
export type _DiscUnionPerArm = Assert<
  Eq<
    Relax<{ kind: "a"; id: MotebitId } | { kind: "b"; ref: SettlementId }>,
    { kind: "a"; id: string } | { kind: "b"; ref: string }
  >
>;

// ── 3c: readonly arrays and readonly properties relax to mutable (wire-
//        equivalent; `readonly T[]` is not assignable to the mutable `T[]`
//        zod infers). Bites if the readonly normalization regresses.
export type _ReadonlyArrayStripped = Assert<Eq<Relax<readonly string[]>, string[]>>;
export type _ReadonlyPropStripped = Assert<Eq<Relax<{ readonly id: MotebitId }>, { id: string }>>;
