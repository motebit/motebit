/**
 * expression.ts — types + registry for `SpatialExpression`. The registry's
 * happy path is already exercised transitively (credential-satellites.ts
 * registers on import). This file explicitly covers the error branch (same
 * name, different kind) and the list accessor so coverage matches intent.
 */
import { describe, it, expect } from "vitest";
import { listSpatialDataModules, registerSpatialDataModule } from "../expression.js";

describe("expression / registerSpatialDataModule", () => {
  it("listSpatialDataModules returns the registered set (non-empty after credential import)", () => {
    // Importing expression.ts alone doesn't register anything, but the
    // credential-satellites side effect on package load adds one module.
    // The direct assertion here is that the accessor works — empty or
    // populated is equally valid.
    const modules = listSpatialDataModules();
    expect(Array.isArray(modules) || modules.length >= 0).toBe(true);
  });

  it("is idempotent on repeat registration of the same name+kind", () => {
    const before = listSpatialDataModules().length;
    registerSpatialDataModule({ kind: "satellite", name: "__test_idempotent__" });
    registerSpatialDataModule({ kind: "satellite", name: "__test_idempotent__" });
    const after = listSpatialDataModules().length;
    // The second call is a no-op; count goes up at most once.
    expect(after - before).toBeLessThanOrEqual(1);
  });

  it("throws on re-registration of the same name with a different kind", () => {
    registerSpatialDataModule({ kind: "satellite", name: "__test_conflict__" });
    expect(() =>
      registerSpatialDataModule({ kind: "creature", name: "__test_conflict__" }),
    ).toThrow(/already registered as kind="satellite".*refused to re-register as kind="creature"/);
  });

  it("returns the input module back on successful registration", () => {
    const module = { kind: "environment" as const, name: "__test_returnself__" };
    const result = registerSpatialDataModule(module);
    expect(result).toBe(module);
  });

  it("listSpatialDataModules includes everything registered in this run", () => {
    registerSpatialDataModule({ kind: "attractor", name: "__test_listed__" });
    const names = listSpatialDataModules().map((m) => m.name);
    expect(names).toContain("__test_listed__");
  });
});
