/**
 * ProjectionClass — the closed registry that keeps evidence-provenance §7 binary.
 * A present `projection` declares HOW it is re-verified: `spec-reproducible` (§7.1,
 * independently reimplementable from spec) or `tool-pinned` (§7-tool, reproducible
 * only by the recipe's content-addressed pinned tool). Absent ⇒ spec-reproducible.
 * See spec/evidence-provenance-v1.md §7 and docs/doctrine/evidence-provenance.md.
 */
import { describe, it, expect } from "vitest";
import {
  ALL_PROJECTION_CLASSES,
  isProjectionClass,
  type ProjectionClass,
  type EvidenceProvenance,
} from "../index";

describe("ProjectionClass closed registry", () => {
  it("enumerates exactly the two honest rungs", () => {
    expect([...ALL_PROJECTION_CLASSES].sort()).toEqual(["spec-reproducible", "tool-pinned"]);
  });

  it("the array is frozen (closed registry, append-only by code change)", () => {
    expect(Object.isFrozen(ALL_PROJECTION_CLASSES)).toBe(true);
  });

  it("isProjectionClass accepts members and rejects everything else", () => {
    for (const c of ALL_PROJECTION_CLASSES) expect(isProjectionClass(c)).toBe(true);
    for (const bad of ["", "spec", "tool", "independent", "advisory", "SPEC-REPRODUCIBLE"]) {
      expect(isProjectionClass(bad)).toBe(false);
    }
  });

  it("isProjectionClass narrows the type", () => {
    const s: string = "tool-pinned";
    if (isProjectionClass(s)) {
      const narrowed: ProjectionClass = s; // compile-time proof of the guard
      expect(narrowed).toBe("tool-pinned");
    } else {
      throw new Error("expected tool-pinned to be a ProjectionClass");
    }
  });

  it("rides on EvidenceProvenance as optional, alongside a present projection", () => {
    const toolPinned: EvidenceProvenance = {
      digest: { algorithm: "sha-256", value: "deadbeef" },
      projection: "agency.pdf-text.v1",
      projectionClass: "tool-pinned",
      span: "Net income was $4.2M",
    };
    expect(toolPinned.projectionClass).toBe("tool-pinned");

    // Absent ⇒ the strong rung by default (the weaker class is opt-in, never by omission).
    const defaulted: EvidenceProvenance = {
      digest: { algorithm: "sha-256", value: "deadbeef" },
      projection: "agency.html-text.v1",
      span: "exact span",
    };
    expect(defaulted.projectionClass).toBeUndefined();
  });
});
