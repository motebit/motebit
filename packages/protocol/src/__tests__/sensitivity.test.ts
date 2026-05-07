/**
 * Sensitivity ladder algebra — pure math over the closed
 * SensitivityLevel enum.
 *
 * Single source of truth for ordering and composition. Every
 * downstream consumer (runtime, ai-core, conversation) derives
 * comparison decisions through these primitives so a future tier
 * insertion remains a one-file change at the protocol layer.
 */

import { describe, expect, it } from "vitest";
import { rankSensitivity, maxSensitivity, sensitivityPermits, SensitivityLevel } from "../index.js";

describe("rankSensitivity — ladder ordering", () => {
  it("None < Personal < Medical < Financial < Secret", () => {
    expect(rankSensitivity(SensitivityLevel.None)).toBe(0);
    expect(rankSensitivity(SensitivityLevel.Personal)).toBe(1);
    expect(rankSensitivity(SensitivityLevel.Medical)).toBe(2);
    expect(rankSensitivity(SensitivityLevel.Financial)).toBe(3);
    expect(rankSensitivity(SensitivityLevel.Secret)).toBe(4);
  });

  it("ranks are strictly monotonic — every adjacent pair differs by exactly 1", () => {
    const ladder = [
      SensitivityLevel.None,
      SensitivityLevel.Personal,
      SensitivityLevel.Medical,
      SensitivityLevel.Financial,
      SensitivityLevel.Secret,
    ];
    for (let i = 1; i < ladder.length; i++) {
      expect(rankSensitivity(ladder[i]!) - rankSensitivity(ladder[i - 1]!)).toBe(1);
    }
  });

  it("every enum member has a defined rank (no gaps)", () => {
    const allLevels = Object.values(SensitivityLevel);
    for (const level of allLevels) {
      const r = rankSensitivity(level);
      expect(Number.isInteger(r)).toBe(true);
      expect(r).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("maxSensitivity — join-semilattice composition", () => {
  it("returns the higher-ranked of two tiers", () => {
    expect(maxSensitivity(SensitivityLevel.None, SensitivityLevel.Personal)).toBe(
      SensitivityLevel.Personal,
    );
    expect(maxSensitivity(SensitivityLevel.Medical, SensitivityLevel.Personal)).toBe(
      SensitivityLevel.Medical,
    );
    expect(maxSensitivity(SensitivityLevel.Secret, SensitivityLevel.Financial)).toBe(
      SensitivityLevel.Secret,
    );
  });

  it("None is the identity element: max(a, None) === a", () => {
    for (const level of Object.values(SensitivityLevel)) {
      expect(maxSensitivity(level, SensitivityLevel.None)).toBe(level);
      expect(maxSensitivity(SensitivityLevel.None, level)).toBe(level);
    }
  });

  it("idempotent: max(a, a) === a", () => {
    for (const level of Object.values(SensitivityLevel)) {
      expect(maxSensitivity(level, level)).toBe(level);
    }
  });

  it("commutative: max(a, b) === max(b, a)", () => {
    const ladder = Object.values(SensitivityLevel);
    for (const a of ladder) {
      for (const b of ladder) {
        expect(maxSensitivity(a, b)).toBe(maxSensitivity(b, a));
      }
    }
  });

  it("associative: max(max(a, b), c) === max(a, max(b, c))", () => {
    const ladder = Object.values(SensitivityLevel);
    for (const a of ladder) {
      for (const b of ladder) {
        for (const c of ladder) {
          expect(maxSensitivity(maxSensitivity(a, b), c)).toBe(
            maxSensitivity(a, maxSensitivity(b, c)),
          );
        }
      }
    }
  });
});

describe("sensitivityPermits — read-side filter", () => {
  it("upper permits candidate iff candidate <= upper", () => {
    expect(sensitivityPermits(SensitivityLevel.Personal, SensitivityLevel.None)).toBe(true);
    expect(sensitivityPermits(SensitivityLevel.Personal, SensitivityLevel.Personal)).toBe(true);
    expect(sensitivityPermits(SensitivityLevel.Personal, SensitivityLevel.Medical)).toBe(false);
    expect(sensitivityPermits(SensitivityLevel.Secret, SensitivityLevel.Medical)).toBe(true);
  });

  it("None content is admissible at every tier", () => {
    for (const upper of Object.values(SensitivityLevel)) {
      expect(sensitivityPermits(upper, SensitivityLevel.None)).toBe(true);
    }
  });

  it("Secret content is admissible only at Secret upper", () => {
    expect(sensitivityPermits(SensitivityLevel.None, SensitivityLevel.Secret)).toBe(false);
    expect(sensitivityPermits(SensitivityLevel.Personal, SensitivityLevel.Secret)).toBe(false);
    expect(sensitivityPermits(SensitivityLevel.Medical, SensitivityLevel.Secret)).toBe(false);
    expect(sensitivityPermits(SensitivityLevel.Financial, SensitivityLevel.Secret)).toBe(false);
    expect(sensitivityPermits(SensitivityLevel.Secret, SensitivityLevel.Secret)).toBe(true);
  });

  it("dual of maxSensitivity: candidate is permitted iff max(upper, candidate) === upper", () => {
    const ladder = Object.values(SensitivityLevel);
    for (const upper of ladder) {
      for (const candidate of ladder) {
        const permitted = sensitivityPermits(upper, candidate);
        const dominated = maxSensitivity(upper, candidate) === upper;
        expect(permitted).toBe(dominated);
      }
    }
  });

  it("reflexive: every tier permits itself", () => {
    for (const level of Object.values(SensitivityLevel)) {
      expect(sensitivityPermits(level, level)).toBe(true);
    }
  });
});
