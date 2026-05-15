/**
 * Routing registry tests. Mirror of `artifact-type.test.ts` and
 * `audience.test.ts` — locks the closed `TaskShape` vocabulary so a
 * new shape can only land via intentional update of both the
 * `TaskShape` union and the `ALL_TASK_SHAPES` array, and exercises
 * the `isTaskShape` guard that drift gates + consumer task
 * classifiers consume.
 *
 * Adding a shape requires: union entry + named constant +
 * `ALL_TASK_SHAPES` entry + new arm in `REFERENCE_ROUTING_POLICY`
 * (`@motebit/policy`) + drift-gate coverage in every consumer +
 * doctrine update at
 * `docs/doctrine/auto-routing-as-protocol-primitive.md`. This test
 * pins the type-side discipline.
 */
import { describe, it, expect } from "vitest";
import {
  ALL_TASK_SHAPES,
  isTaskShape,
  QUICK_TASK_SHAPE,
  CHAT_TASK_SHAPE,
  REASONING_TASK_SHAPE,
  CODE_TASK_SHAPE,
  RESEARCH_TASK_SHAPE,
  CREATIVE_TASK_SHAPE,
  MATH_TASK_SHAPE,
  type TaskShape,
} from "../routing.js";

describe("ALL_TASK_SHAPES", () => {
  it("has exactly the seven registered entries", () => {
    expect(ALL_TASK_SHAPES.length).toBe(7);
  });

  it("enumerates every named constant exactly once", () => {
    const named: TaskShape[] = [
      QUICK_TASK_SHAPE,
      CHAT_TASK_SHAPE,
      REASONING_TASK_SHAPE,
      CODE_TASK_SHAPE,
      RESEARCH_TASK_SHAPE,
      CREATIVE_TASK_SHAPE,
      MATH_TASK_SHAPE,
    ];
    expect([...named].sort()).toEqual([...ALL_TASK_SHAPES].sort());
    expect(new Set(named).size).toBe(named.length);
  });

  it("is frozen — additions must edit the source, not the array at runtime", () => {
    expect(Object.isFrozen(ALL_TASK_SHAPES)).toBe(true);
  });

  it("uses lowercase kebab-style identifiers — wire-form convention", () => {
    for (const t of ALL_TASK_SHAPES) {
      expect(t).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    }
  });
});

describe("isTaskShape", () => {
  it("narrows every registered shape", () => {
    for (const t of ALL_TASK_SHAPES) {
      const value: unknown = t;
      if (isTaskShape(value)) {
        const narrowed: TaskShape = value;
        expect(narrowed).toBe(t);
      } else {
        throw new Error(`isTaskShape should have narrowed ${t}`);
      }
    }
  });

  it("rejects unknown strings — the typo class the registry exists to catch", () => {
    expect(isTaskShape("Quick")).toBe(false); // wrong case
    expect(isTaskShape("conversation")).toBe(false); // not a registered shape
    expect(isTaskShape("voice-conversation")).toBe(false); // proposed future shape, not yet registered
    expect(isTaskShape("image-generation")).toBe(false); // proposed future shape, not yet registered
    expect(isTaskShape("")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isTaskShape(0)).toBe(false);
    expect(isTaskShape(null)).toBe(false);
    expect(isTaskShape(undefined)).toBe(false);
    expect(isTaskShape({ task: "quick" })).toBe(false);
    expect(isTaskShape(["quick"])).toBe(false);
  });
});
