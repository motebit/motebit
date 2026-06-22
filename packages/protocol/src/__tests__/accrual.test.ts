import { describe, it, expect } from "vitest";
import {
  ALL_ACCRUAL_KINDS,
  isAccrualKind,
  ACCRUAL_KIND_MARKERS,
  SensitivityLevel,
  type AccrualKind,
  type AccrualBasis,
  type AccrualAttributed,
} from "../index.js";

/**
 * Inc-1 contract tests for the accrual (leverage) register.
 * Doctrine: docs/doctrine/felt-accumulation.md.
 */
describe("AccrualKind registry", () => {
  it("ALL_ACCRUAL_KINDS is the five-kind closed vocabulary, no dups", () => {
    expect(ALL_ACCRUAL_KINDS).toEqual([
      "recalled_memory",
      "trust_edge",
      "consolidated_fact",
      "prior_approval_pattern",
      "standing_delegation",
    ]);
    expect(new Set(ALL_ACCRUAL_KINDS).size).toBe(ALL_ACCRUAL_KINDS.length);
  });

  it("ALL_ACCRUAL_KINDS is frozen — the single source of truth cannot be mutated", () => {
    expect(Object.isFrozen(ALL_ACCRUAL_KINDS)).toBe(true);
  });

  it("isAccrualKind accepts every member", () => {
    for (const k of ALL_ACCRUAL_KINDS) {
      expect(isAccrualKind(k)).toBe(true);
    }
  });

  it("isAccrualKind rejects non-members and non-strings (no coercion to a real kind)", () => {
    for (const bad of [
      "recalled", // marker, not a kind
      "memory",
      "",
      "RECALLED_MEMORY",
      42,
      null,
      undefined,
      {},
      ["recalled_memory"],
    ]) {
      expect(isAccrualKind(bad)).toBe(false);
    }
  });
});

describe("ACCRUAL_KIND_MARKERS", () => {
  it("has exactly one marker per kind — no missing, no extra (compile-time + runtime lock)", () => {
    expect(Object.keys(ACCRUAL_KIND_MARKERS).sort()).toEqual([...ALL_ACCRUAL_KINDS].sort());
  });

  it("every marker is a non-empty, distinct anchor", () => {
    const markers = Object.values(ACCRUAL_KIND_MARKERS);
    for (const m of markers) expect(m.length).toBeGreaterThan(0);
    expect(new Set(markers).size).toBe(markers.length);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(ACCRUAL_KIND_MARKERS)).toBe(true);
  });
});

describe("AccrualBasis shape", () => {
  it("carries kind + opaque sourceRef + the leveraged source's sensitivity ceiling", () => {
    const basis: AccrualBasis = {
      kind: "recalled_memory",
      sourceRef: "mem_01H...",
      sensitivity: SensitivityLevel.Personal,
    };
    expect(isAccrualKind(basis.kind)).toBe(true);
    expect(basis.sourceRef).toBeTruthy();
    // sensitivity is a real tier — the render ceiling is structural, not optional.
    expect(Object.values(SensitivityLevel)).toContain(basis.sensitivity);
  });

  it("AccrualAttributed.accrualBasis is optional — absence is the fail-closed default (no leverage → no attribution)", () => {
    const plainAct: AccrualAttributed = {};
    expect(plainAct.accrualBasis).toBeUndefined();

    const leveragedAct: AccrualAttributed = {
      accrualBasis: {
        kind: "trust_edge",
        sourceRef: "0xpeer...",
        sensitivity: SensitivityLevel.None,
      },
    };
    expect(leveragedAct.accrualBasis?.kind).toBe("trust_edge");
  });

  it("a kind value round-trips through the guard (local re-read safety)", () => {
    const kinds: AccrualKind[] = [...ALL_ACCRUAL_KINDS];
    for (const k of kinds) {
      const reread: unknown = JSON.parse(JSON.stringify(k));
      expect(isAccrualKind(reread)).toBe(true);
    }
  });
});
