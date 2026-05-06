/**
 * Negative-proof test for the SpatialExpression category-3 boundary.
 *
 * The @ts-expect-error assertions below are the mechanical enforcement of
 * the calm-AR rule pinned in `docs/doctrine/spatial-as-endgame.md`:
 * "No disconnected window-manager panels; surfaces emerge from the
 * motebit's gesture and recede when work ends." If someone widens
 * `SpatialKind` to include "panel", "list", "card", or any other
 * rectangular-surface metaphor disconnected from the motebit's gesture,
 * the @ts-expect-error directive fires (because the error it expected is
 * gone) and this file stops compiling — the build fails for every
 * contributor, including CI.
 *
 * The five canonical primitives — creature, satellite, environment,
 * attractor, presentation — cover the doctrine's full vocabulary.
 * `presentation` was added 2026-05-06 alongside the AR-glasses-companion
 * thesis: it is the bridge primitive between the motebit and the spatial
 * OS, anchored to the creature's gesture (not free-floating chrome).
 *
 * Mirrors the pattern in services/relay/src/__tests__/custody-boundary.test.ts
 * for the GuestRail / SovereignRail split. The enforcement lives in the
 * type system, not in a linter or doctrine document.
 *
 * Note on the test bodies: the forbidden-kind blocks are pure compile-
 * time assertions. The `@ts-expect-error` directive is the test; there
 * is no meaningful runtime observation to make. The `expect(true)` calls
 * exist only so vitest counts the block as "passed"; do NOT replace them
 * with something that looks like a value check — that would be cargo-
 * cult and could be "fixed" by a future contributor in a way that
 * accidentally deletes the enforcement.
 */
import { describe, it, expect } from "vitest";
import type { SpatialDataModule, SpatialExpression, SpatialKind } from "@motebit/render-engine";
import {
  registerSpatialDataModule,
  listSpatialDataModules,
  CREDENTIAL_SATELLITES_MODULE,
  credentialsToExpression,
} from "@motebit/render-engine";

describe("SpatialKind is the closed vocabulary", () => {
  it("accepts the five canonical kinds at the type level", () => {
    const kinds: SpatialKind[] = [
      "satellite",
      "creature",
      "environment",
      "attractor",
      "presentation",
    ];
    expect(kinds.length).toBe(5);
  });

  it("rejects 'panel' at compile time (calm-AR enforcement)", () => {
    // @ts-expect-error — "panel" is not a SpatialKind. Doctrine
    // (spatial-as-endgame.md): disconnected window-manager panels are
    // the anti-pattern; motebit-anchored surfaces are the
    // `presentation` primitive instead.
    const _panel: SpatialKind = "panel";
    void _panel;
    expect(true).toBe(true); // compile-only assertion; see file header
  });

  it("rejects 'list' at compile time", () => {
    // @ts-expect-error — "list" is not a SpatialKind. Lists belong as
    // satellites (orbiting objects) or presentations (motebit-anchored
    // surfaces), not as flat rectangles in user-space.
    const _list: SpatialKind = "list";
    void _list;
    expect(true).toBe(true);
  });

  it("rejects 'card' at compile time", () => {
    // @ts-expect-error — "card" is not a SpatialKind.
    const _card: SpatialKind = "card";
    void _card;
    expect(true).toBe(true);
  });
});

describe("registerSpatialDataModule constrains kind at the call site", () => {
  it("accepts a valid satellite module", () => {
    const m: SpatialDataModule<"satellite"> = registerSpatialDataModule({
      kind: "satellite",
      name: "neg-test-valid",
    });
    expect(m.kind).toBe("satellite");
  });

  it("accepts a valid presentation module", () => {
    // Doctrine: spatial-as-endgame.md — `presentation` is the fifth
    // canonical primitive. The motebit shows you a held-tablet, a page,
    // a terminal; the surface is anchored to the creature's gesture and
    // recedes when work ends. Disconnected free-floating panels remain
    // forbidden by the @ts-expect-error block above; presentations are
    // not panels because they're motebit-anchored, lifecycle-bounded.
    const m: SpatialDataModule<"presentation"> = registerSpatialDataModule({
      kind: "presentation",
      name: "neg-test-presentation",
    });
    expect(m.kind).toBe("presentation");
  });

  it("rejects a 'panel' module at compile time", () => {
    registerSpatialDataModule({
      // @ts-expect-error — "panel" is not a SpatialKind. Every structured
      // -data module MUST choose one of the four spatial expressions.
      kind: "panel",
      name: "neg-test-panel",
    });
    expect(true).toBe(true);
  });

  it("registerSpatialDataModule is idempotent on repeated same-name/same-kind calls", () => {
    const a = registerSpatialDataModule({ kind: "creature", name: "neg-test-idem" });
    const b = registerSpatialDataModule({ kind: "creature", name: "neg-test-idem" });
    expect(a.name).toBe(b.name);
    const listed = listSpatialDataModules().filter((m) => m.name === "neg-test-idem");
    expect(listed.length).toBe(1);
  });

  it("refuses to re-register the same name under a different kind", () => {
    registerSpatialDataModule({ kind: "satellite", name: "neg-test-kind-clash" });
    expect(() =>
      registerSpatialDataModule({ kind: "attractor", name: "neg-test-kind-clash" }),
    ).toThrow(/refused to re-register/);
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
