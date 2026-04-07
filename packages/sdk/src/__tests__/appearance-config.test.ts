import { describe, it, expect } from "vitest";
import { DEFAULT_APPEARANCE_CONFIG, migrateAppearanceConfig } from "../appearance-config.js";

describe("migrateAppearanceConfig", () => {
  it("returns a fresh default when input is null", () => {
    const result = migrateAppearanceConfig(null);
    expect(result).toEqual(DEFAULT_APPEARANCE_CONFIG);
    expect(result).not.toBe(DEFAULT_APPEARANCE_CONFIG);
  });

  it("returns a fresh default when input is undefined", () => {
    expect(migrateAppearanceConfig(undefined)).toEqual(DEFAULT_APPEARANCE_CONFIG);
  });

  it("returns a fresh default when input is a primitive", () => {
    expect(migrateAppearanceConfig("moonlight")).toEqual(DEFAULT_APPEARANCE_CONFIG);
    expect(migrateAppearanceConfig(42)).toEqual(DEFAULT_APPEARANCE_CONFIG);
  });

  it("normalizes the canonical mobile shape", () => {
    const input = {
      colorPreset: "violet",
      customHue: 180,
      customSaturation: 0.5,
      theme: "dark" as const,
    };
    expect(migrateAppearanceConfig(input)).toEqual(input);
  });

  it("migrates the web legacy shape {preset, customHue, customSaturation}", () => {
    const result = migrateAppearanceConfig({
      preset: "rose",
      customHue: 10,
      customSaturation: 0.8,
    });
    expect(result.colorPreset).toBe("rose");
    expect(result.customHue).toBe(10);
    expect(result.customSaturation).toBe(0.8);
    // theme not provided → default
    expect(result.theme).toBe(DEFAULT_APPEARANCE_CONFIG.theme);
  });

  it("migrates the desktop Tauri snake_case shape", () => {
    const result = migrateAppearanceConfig({
      interior_color_preset: "ember",
      custom_soul_color: { hue: 30, saturation: 0.9 },
    });
    expect(result.colorPreset).toBe("ember");
    expect(result.customHue).toBe(30);
    expect(result.customSaturation).toBe(0.9);
  });

  it("prefers canonical colorPreset over legacy keys when both present", () => {
    const result = migrateAppearanceConfig({
      colorPreset: "cyan",
      preset: "rose",
      interior_color_preset: "amber",
    });
    expect(result.colorPreset).toBe("cyan");
  });

  it("falls through preset priority: colorPreset → preset → interior_color_preset", () => {
    expect(migrateAppearanceConfig({ preset: "rose" }).colorPreset).toBe("rose");
    expect(migrateAppearanceConfig({ interior_color_preset: "amber" }).colorPreset).toBe("amber");
  });

  it("prefers canonical customHue/customSaturation over desktop snake_case", () => {
    const result = migrateAppearanceConfig({
      customHue: 100,
      customSaturation: 0.3,
      custom_soul_color: { hue: 200, saturation: 0.6 },
    });
    expect(result.customHue).toBe(100);
    expect(result.customSaturation).toBe(0.3);
  });

  it("accepts partial desktop custom_soul_color (hue only, saturation only)", () => {
    const hueOnly = migrateAppearanceConfig({
      custom_soul_color: { hue: 45 },
    });
    expect(hueOnly.customHue).toBe(45);
    expect(hueOnly.customSaturation).toBe(DEFAULT_APPEARANCE_CONFIG.customSaturation);

    const satOnly = migrateAppearanceConfig({
      custom_soul_color: { saturation: 0.4 },
    });
    expect(satOnly.customHue).toBe(DEFAULT_APPEARANCE_CONFIG.customHue);
    expect(satOnly.customSaturation).toBe(0.4);
  });

  it("accepts all three theme values", () => {
    expect(migrateAppearanceConfig({ theme: "light" }).theme).toBe("light");
    expect(migrateAppearanceConfig({ theme: "dark" }).theme).toBe("dark");
    expect(migrateAppearanceConfig({ theme: "system" }).theme).toBe("system");
  });

  it("falls back to default theme on invalid theme value", () => {
    const result = migrateAppearanceConfig({ theme: "nonsense" });
    expect(result.theme).toBe(DEFAULT_APPEARANCE_CONFIG.theme);
  });

  it("ignores wrong-type fields and uses defaults", () => {
    const result = migrateAppearanceConfig({
      colorPreset: 42, // wrong type
      customHue: "purple", // wrong type
    });
    expect(result.colorPreset).toBe(DEFAULT_APPEARANCE_CONFIG.colorPreset);
    expect(result.customHue).toBe(DEFAULT_APPEARANCE_CONFIG.customHue);
  });

  it("ignores unknown keys", () => {
    const result = migrateAppearanceConfig({
      colorPreset: "moonlight",
      unrelated: "value",
    });
    expect(result).not.toHaveProperty("unrelated");
  });
});
