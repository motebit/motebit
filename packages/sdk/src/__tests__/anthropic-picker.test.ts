import { describe, it, expect } from "vitest";
import {
  ANTHROPIC_MODELS,
  ANTHROPIC_PICKER,
  DEFAULT_ANTHROPIC_MODEL,
  pickerModelForTier,
  pickerOptionsWithStored,
  providerAcceptsModel,
} from "../models.js";

describe("ANTHROPIC_PICKER (#654)", () => {
  it("has exactly one row per tier, in strongest → default → fast order", () => {
    expect(ANTHROPIC_PICKER.map((o) => o.tier)).toEqual(["strongest", "default", "fast"]);
  });

  it("every row is a registry id the anthropic provider admits", () => {
    for (const o of ANTHROPIC_PICKER) {
      expect((ANTHROPIC_MODELS as readonly string[]).includes(o.id)).toBe(true);
      expect(providerAcceptsModel("anthropic", o.id)).toBe(true);
    }
  });

  it("the default row IS DEFAULT_ANTHROPIC_MODEL", () => {
    expect(pickerModelForTier("default")).toBe(DEFAULT_ANTHROPIC_MODEL);
  });

  it("offers Opus 5.5 as the strongest tier and Haiku 4.5 as the fast tier", () => {
    expect(pickerModelForTier("strongest")).toBe("claude-opus-5-5");
    expect(pickerModelForTier("fast")).toBe("claude-haiku-4-5-20251001");
  });

  it("keeps Fable 5.1 selectable by id (registry) but off the curated rows", () => {
    expect((ANTHROPIC_MODELS as readonly string[]).includes("claude-fable-5-1")).toBe(true);
    expect(ANTHROPIC_PICKER.some((o) => o.id === "claude-fable-5-1")).toBe(false);
  });
});

describe("pickerOptionsWithStored", () => {
  it("selects the default row when nothing is stored", () => {
    for (const stored of [undefined, null, "", "   "]) {
      const rows = pickerOptionsWithStored(stored);
      expect(rows).toHaveLength(ANTHROPIC_PICKER.length);
      expect(rows.filter((r) => r.selected).map((r) => r.id)).toEqual([DEFAULT_ANTHROPIC_MODEL]);
    }
  });

  it("selects a stored picker id without adding a row", () => {
    const rows = pickerOptionsWithStored(pickerModelForTier("fast"));
    expect(rows).toHaveLength(ANTHROPIC_PICKER.length);
    expect(rows.find((r) => r.selected)?.id).toBe(pickerModelForTier("fast"));
  });

  it("a stored pre-#654 claude-sonnet-4-6 loads, is shown, and stays selected — never migrated", () => {
    const rows = pickerOptionsWithStored("claude-sonnet-4-6");
    expect(rows[0]).toEqual({
      id: "claude-sonnet-4-6",
      label: "claude-sonnet-4-6",
      selected: true,
    });
    expect(rows.filter((r) => r.selected)).toHaveLength(1);
    expect(rows.slice(1).map((r) => r.id)).toEqual(ANTHROPIC_PICKER.map((o) => o.id));
  });

  it("a typed Fable 5.1 id is kept as its own selected row", () => {
    const rows = pickerOptionsWithStored("claude-fable-5-1");
    expect(rows[0]?.id).toBe("claude-fable-5-1");
    expect(rows[0]?.selected).toBe(true);
  });
});
