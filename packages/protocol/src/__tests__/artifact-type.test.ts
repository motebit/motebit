/**
 * ContentArtifactType registry tests. Mirror of `audience.test.ts` —
 * locks the closed vocabulary of `artifact_type` claim values on
 * `ContentArtifactManifest` so a new category can only land via
 * intentional update of both the `ContentArtifactType` union and the
 * `ALL_CONTENT_ARTIFACT_TYPES` array, and exercises the
 * `isContentArtifactType` guard that drift gates + the
 * `motebit-verify content-artifact` CLI consume.
 *
 * Adding a category requires: union entry + named constant +
 * `ALL_CONTENT_ARTIFACT_TYPES` entry + `CANONICAL_ARTIFACT_TYPES` in
 * `scripts/check-artifact-type-canonical.ts` + doctrine update at
 * `docs/doctrine/nist-alignment.md` §8. This test pins the
 * type-side discipline.
 */
import { describe, it, expect } from "vitest";
import {
  ALL_CONTENT_ARTIFACT_TYPES,
  isContentArtifactType,
  STATE_SNAPSHOT_ARTIFACT,
  MEMORY_EXPORT_ARTIFACT,
  GOAL_LIST_ARTIFACT,
  CONVERSATION_LIST_ARTIFACT,
  CONVERSATION_MESSAGES_ARTIFACT,
  DEVICE_LIST_ARTIFACT,
  AUDIT_TRAIL_ARTIFACT,
  PLAN_LIST_ARTIFACT,
  PLAN_DETAIL_ARTIFACT,
  GRADIENT_HISTORY_ARTIFACT,
  SYNC_PULL_ARTIFACT,
  EXECUTION_LEDGER_ARTIFACT,
  type ContentArtifactType,
} from "../artifact-type.js";

describe("ALL_CONTENT_ARTIFACT_TYPES", () => {
  it("has exactly the twelve registered entries — one per state-export endpoint", () => {
    expect(ALL_CONTENT_ARTIFACT_TYPES.length).toBe(12);
  });

  it("enumerates every named constant exactly once", () => {
    const named: ContentArtifactType[] = [
      STATE_SNAPSHOT_ARTIFACT,
      MEMORY_EXPORT_ARTIFACT,
      GOAL_LIST_ARTIFACT,
      CONVERSATION_LIST_ARTIFACT,
      CONVERSATION_MESSAGES_ARTIFACT,
      DEVICE_LIST_ARTIFACT,
      AUDIT_TRAIL_ARTIFACT,
      PLAN_LIST_ARTIFACT,
      PLAN_DETAIL_ARTIFACT,
      GRADIENT_HISTORY_ARTIFACT,
      SYNC_PULL_ARTIFACT,
      EXECUTION_LEDGER_ARTIFACT,
    ];
    expect([...named].sort()).toEqual([...ALL_CONTENT_ARTIFACT_TYPES].sort());
    expect(new Set(named).size).toBe(named.length);
  });

  it("is frozen — additions must edit the source, not the array at runtime", () => {
    expect(Object.isFrozen(ALL_CONTENT_ARTIFACT_TYPES)).toBe(true);
  });

  it("uses kebab-case for every entry — wire-form convention", () => {
    for (const t of ALL_CONTENT_ARTIFACT_TYPES) {
      expect(t).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    }
  });
});

describe("isContentArtifactType", () => {
  it("narrows every registered type", () => {
    for (const t of ALL_CONTENT_ARTIFACT_TYPES) {
      const value: unknown = t;
      if (isContentArtifactType(value)) {
        const narrowed: ContentArtifactType = value;
        expect(narrowed).toBe(t);
      } else {
        throw new Error(`isContentArtifactType should have narrowed ${t}`);
      }
    }
  });

  it("rejects unknown strings — the typo class the registry exists to catch", () => {
    expect(isContentArtifactType("audit_trail")).toBe(false); // underscore typo
    expect(isContentArtifactType("AUDIT-TRAIL")).toBe(false); // wrong case
    expect(isContentArtifactType("plan")).toBe(false); // not plan-list or plan-detail
    expect(isContentArtifactType("exec-ledger")).toBe(false); // abbreviation
    expect(isContentArtifactType("")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isContentArtifactType(0)).toBe(false);
    expect(isContentArtifactType(null)).toBe(false);
    expect(isContentArtifactType(undefined)).toBe(false);
    expect(isContentArtifactType({ artifact_type: "audit-trail" })).toBe(false);
    expect(isContentArtifactType(["audit-trail"])).toBe(false);
  });
});
