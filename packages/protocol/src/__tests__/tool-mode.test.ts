/**
 * Tool-mode priority tests. `toolModePriority` is the dispatch function
 * the runtime's tool registry sorts by — `api` cheapest, `pixels`
 * universal-fallback, undeclared deprioritized. Locking the order
 * here keeps the hybrid-engine doctrine (api → ax → pixels → undeclared)
 * structurally enforced.
 */
import { describe, it, expect } from "vitest";
import { TOOL_MODES, toolModePriority } from "../tool-mode.js";

describe("TOOL_MODES", () => {
  it("lists modes cheapest-first", () => {
    expect([...TOOL_MODES]).toEqual(["api", "ax", "pixels"]);
  });
});

describe("toolModePriority", () => {
  it("api < ax < pixels", () => {
    expect(toolModePriority("api")).toBe(0);
    expect(toolModePriority("ax")).toBe(1);
    expect(toolModePriority("pixels")).toBe(2);
  });

  it("undefined sorts to the end (deprioritized, not rejected)", () => {
    expect(toolModePriority(undefined)).toBe(TOOL_MODES.length);
    expect(toolModePriority(undefined)).toBeGreaterThan(toolModePriority("pixels"));
  });
});
