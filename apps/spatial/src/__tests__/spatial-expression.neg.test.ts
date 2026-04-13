/**
 * Negative-proof test for the SpatialExpression category-3 boundary.
 *
 * The @ts-expect-error assertions below are the mechanical enforcement of
 * "Spatial rejects the panel metaphor" (CLAUDE.md). If someone widens
 * `SpatialKind` to include "panel", "list", "card", or any other
 * rectangular-surface metaphor, the @ts-expect-error directive fires
 * (because the error it expected is gone) and this file stops compiling
 * — the build fails for every contributor, including CI.
 *
 * Mirrors the pattern in services/api/src/__tests__/custody-boundary.test.ts
 * for the GuestRail / SovereignRail split. The enforcement lives in the
 * type system, not in a linter or doctrine document.
 */
import { describe, it, expect } from "vitest";
import type { SpatialDataModule, SpatialExpression, SpatialKind } from "../spatial-expression";
import { registerSpatialDataModule, listSpatialDataModules } from "../spatial-expression";
import { CREDENTIAL_SATELLITES_MODULE, credentialsToExpression } from "../credential-satellites";

describe("SpatialKind is the closed vocabulary", () => {
  it("accepts the four canonical kinds at the type level", () => {
    const kinds: SpatialKind[] = ["satellite", "creature", "environment", "attractor"];
    expect(kinds.length).toBe(4);
  });

  it("rejects 'panel' at compile time (category-3 enforcement)", () => {
    // @ts-expect-error — "panel" is not a SpatialKind. Doctrine: spatial
    // rejects the panel metaphor; widening this union is the anti-pattern.
    const p: SpatialKind = "panel";
    expect(p).toBe("panel"); // runtime string is fine; type system rejects it
  });

  it("rejects 'list' at compile time", () => {
    // @ts-expect-error — "list" is not a SpatialKind. Lists belong as
    // satellites (orbiting objects), not as flat rectangles.
    const l: SpatialKind = "list";
    expect(l).toBe("list");
  });

  it("rejects 'card' at compile time", () => {
    // @ts-expect-error — "card" is not a SpatialKind.
    const c: SpatialKind = "card";
    expect(c).toBe("card");
  });
});

describe("registerSpatialDataModule constrains kind at the call site", () => {
  it("accepts a valid satellite module", () => {
    const m: SpatialDataModule<"satellite"> = registerSpatialDataModule({
      kind: "satellite",
      name: "test-sat",
    });
    expect(m.kind).toBe("satellite");
  });

  it("rejects a 'panel' module at compile time", () => {
    const mod = registerSpatialDataModule({
      // @ts-expect-error — "panel" is not a SpatialKind. Every structured
      // -data module MUST choose one of the four spatial expressions.
      kind: "panel",
      name: "nope",
    });
    expect(mod.name).toBe("nope");
  });
});

describe("credential-satellites is registered as a satellite module", () => {
  it("registers with kind=satellite", () => {
    expect(CREDENTIAL_SATELLITES_MODULE.kind).toBe("satellite");
    expect(CREDENTIAL_SATELLITES_MODULE.name).toBe("credentials");
  });

  it("appears in the module registry", () => {
    const found = listSpatialDataModules().find((m) => m.name === "credentials");
    expect(found).toBeDefined();
    expect(found!.kind).toBe("satellite");
  });
});

describe("credentialsToExpression produces a SatelliteExpression", () => {
  it("maps credentials to orbiting satellite items", () => {
    const expr: SpatialExpression = credentialsToExpression([
      {
        credential_type: "AgentReputationCredential",
        issued_at: 1,
        credential: { issuanceDate: "2026-01-01" },
      },
      {
        credential_type: "AgentTrustCredential",
        issued_at: 2,
        credential: {},
      },
    ]);
    expect(expr.kind).toBe("satellite");
    if (expr.kind !== "satellite") throw new Error("unreachable");
    expect(expr.items.length).toBe(2);
    expect(expr.items[0]!.label).toBe("Reputation");
    expect(expr.items[1]!.label).toBe("Trust");
    // Different types get different hues.
    expect(expr.items[0]!.hue).not.toBe(expr.items[1]!.hue);
    // Phases are spread across the orbit.
    expect(expr.items[0]!.phase).not.toBe(expr.items[1]!.phase);
  });

  it("produces an empty expression for empty input", () => {
    const expr = credentialsToExpression([]);
    expect(expr.kind).toBe("satellite");
    expect(expr.items.length).toBe(0);
  });
});
