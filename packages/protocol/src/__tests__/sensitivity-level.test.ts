/**
 * `SensitivityLevel` canonical-registry tests. Mirror of
 * `artifact-type.test.ts` / `audience.test.ts` / `routing.test.ts` —
 * locks the closed iteration over `SensitivityLevel` so a new tier
 * (e.g. `"regulatory"`) can only land via intentional update of
 * (a) the enum in `index.ts`, (b) `ALL_SENSITIVITY_LEVELS` in
 * `sensitivity.ts`, (c) `SENSITIVITY_RANK` in `sensitivity.ts`, and
 * (d) the drift gate `check-sensitivity-canonical`. The algebra
 * (`rankSensitivity`, `maxSensitivity`, `sensitivityPermits`) is
 * covered by `sensitivity.test.ts`; this file pins the registry-
 * coverage surface.
 *
 * Doctrine: `docs/doctrine/retention-policy.md` § "Sensitivity
 * ceilings as interop law"; the load-bearing privacy invariant
 * named in `CLAUDE.md` § "Fail-closed privacy."
 */
import { describe, it, expect } from "vitest";
import { ALL_SENSITIVITY_LEVELS, isSensitivityLevel, SensitivityLevel } from "../index.js";

describe("ALL_SENSITIVITY_LEVELS", () => {
  it("has exactly the five registered levels", () => {
    expect(ALL_SENSITIVITY_LEVELS.length).toBe(5);
  });

  it("enumerates every enum member exactly once, in ladder order (none → secret)", () => {
    expect([...ALL_SENSITIVITY_LEVELS]).toEqual([
      SensitivityLevel.None,
      SensitivityLevel.Personal,
      SensitivityLevel.Medical,
      SensitivityLevel.Financial,
      SensitivityLevel.Secret,
    ]);
  });

  it("is frozen — additions must edit the source, not the array at runtime", () => {
    expect(Object.isFrozen(ALL_SENSITIVITY_LEVELS)).toBe(true);
  });

  it("uses lowercase identifiers — wire-form convention", () => {
    for (const level of ALL_SENSITIVITY_LEVELS) {
      expect(level).toMatch(/^[a-z]+$/);
    }
  });
});

describe("isSensitivityLevel", () => {
  it("narrows every registered level", () => {
    for (const level of ALL_SENSITIVITY_LEVELS) {
      const value: unknown = level;
      if (isSensitivityLevel(value)) {
        const narrowed: SensitivityLevel = value;
        expect(narrowed).toBe(level);
      } else {
        throw new Error(`isSensitivityLevel should have narrowed ${String(level)}`);
      }
    }
  });

  it("rejects unknown strings — the typo class the registry exists to catch", () => {
    expect(isSensitivityLevel("None")).toBe(false); // capitalized
    expect(isSensitivityLevel("PII")).toBe(false); // alternate vocabulary
    expect(isSensitivityLevel("regulatory")).toBe(false); // proposed future tier, not yet registered
    expect(isSensitivityLevel("public")).toBe(false); // not "none"
    expect(isSensitivityLevel("")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isSensitivityLevel(0)).toBe(false);
    expect(isSensitivityLevel(null)).toBe(false);
    expect(isSensitivityLevel(undefined)).toBe(false);
    expect(isSensitivityLevel({ sensitivity: "medical" })).toBe(false);
    expect(isSensitivityLevel(["medical"])).toBe(false);
  });
});
