import { describe, it, expect } from "vitest";
import { ALL_EVAL_KINDS, isEvalKind, type EvalKind } from "../eval-attestation.js";

// `EvalKind` canonical-registry tests. The eleventh registered registry
// per `docs/doctrine/registry-pattern-canonical.md`, promoted with the
// EvalAttestation artifact (docs/doctrine/evals-as-attestations.md,
// trigger #1: the Auditor archetype). Single member at land — the
// registry exists because a consumer that cannot interpret the
// measurement family must fail closed at wire intake, exactly the
// audience-typo drift class registries defend. The per-registry coverage
// gate (`check-eval-kind-canonical`) enforces sibling-alignment across
// the union, the array, the crypto-side mirror, and emit sites; this
// file locks the iteration + guard primitives.

describe("ALL_EVAL_KINDS", () => {
  it("is a frozen array (registry pattern)", () => {
    expect(Object.isFrozen(ALL_EVAL_KINDS)).toBe(true);
  });

  it("enumerates the closed set in canonical order", () => {
    expect(ALL_EVAL_KINDS).toEqual(["verification_audit"]);
  });

  it("contains every literal in the EvalKind union", () => {
    // Exhaustive switch — TypeScript catches a missing arm at compile
    // time. Forces a mismatch to surface in BOTH `tsc` and this test
    // if the union is rotated without also updating the array.
    const acc: EvalKind[] = [];
    for (const kind of ALL_EVAL_KINDS) {
      switch (kind) {
        case "verification_audit":
          acc.push(kind);
          break;
      }
    }
    expect(acc).toHaveLength(ALL_EVAL_KINDS.length);
  });

  it("contains no duplicates", () => {
    const set = new Set(ALL_EVAL_KINDS);
    expect(set.size).toBe(ALL_EVAL_KINDS.length);
  });

  it("every member is wire-compliant snake_case", () => {
    for (const kind of ALL_EVAL_KINDS) {
      expect(kind).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe("isEvalKind", () => {
  it("narrows every registry member", () => {
    for (const kind of ALL_EVAL_KINDS) {
      expect(isEvalKind(kind)).toBe(true);
    }
  });

  it("rejects unknown strings (fail-closed wire intake)", () => {
    expect(isEvalKind("verification_audit_v2")).toBe(false);
    expect(isEvalKind("VERIFICATION_AUDIT")).toBe(false);
    expect(isEvalKind("verification-audit")).toBe(false);
    expect(isEvalKind("")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isEvalKind(undefined)).toBe(false);
    expect(isEvalKind(null)).toBe(false);
    expect(isEvalKind(42)).toBe(false);
    expect(isEvalKind(["verification_audit"])).toBe(false);
    expect(isEvalKind({ kind: "verification_audit" })).toBe(false);
  });
});
