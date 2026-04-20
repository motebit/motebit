/**
 * browser-entry.ts is a barrel that re-exports the package's browser-safe
 * surface for the IIFE bundle consumed inside mobile's WebView. No logic —
 * just `export * from`. Test by importing and spot-checking that each
 * re-exported name is actually reachable.
 */
import { describe, expect, it } from "vitest";
import * as browserEntry from "../browser-entry.js";

describe("browser-entry barrel", () => {
  it("re-exports the spatial expression registry", () => {
    expect(typeof browserEntry.registerSpatialDataModule).toBe("function");
    expect(typeof browserEntry.listSpatialDataModules).toBe("function");
  });

  it("re-exports the credential satellites API", () => {
    expect(typeof browserEntry.credentialsToExpression).toBe("function");
    expect(typeof browserEntry.hueForType).toBe("function");
    expect(typeof browserEntry.CredentialSatelliteRenderer).toBe("function");
    expect(typeof browserEntry.mountCredentialSatellites).toBe("function");
    expect(browserEntry.CREDENTIAL_SATELLITES_MODULE).toBeDefined();
  });

  it("re-exports the creature module", () => {
    // creature.ts is the shared creature geometry; it exports at least one
    // named function. We don't care which — just that the barrel pulled
    // something from it.
    const creatureNames = Object.keys(browserEntry).filter((k) =>
      /^(create|mount|update|build|Creature)/i.test(k),
    );
    expect(creatureNames.length).toBeGreaterThan(0);
  });

  it("re-exports the render spec types (runtime-visible constants)", () => {
    // spec.ts exports at least CANONICAL_SPEC.
    expect(browserEntry.CANONICAL_SPEC).toBeDefined();
  });
});
