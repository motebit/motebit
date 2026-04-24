/**
 * Canonical appearance / theme configuration shape.
 *
 * Every surface (web, mobile, desktop, spatial) has historically carried its
 * own appearance config — with drifted field names (`preset` vs
 * `colorPreset`, web's `SoulColorConfig` vs mobile's flat fields vs
 * desktop's Tauri snake_case `interior_color_preset` + `custom_soul_color`)
 * and different subsets of the feature set. This module is the
 * authoritative vocabulary. Surfaces may keep UI-internal state in their
 * own shapes, but anything crossing the SDK boundary — sync, import/export,
 * cross-surface helpers — speaks `AppearanceConfig`.
 *
 * Migration helpers are provided for the legacy shapes so each surface can
 * normalize on load without inventing its own migration one-offs.
 */

/**
 * The canonical appearance configuration. Narrow, descriptive, surface-agnostic.
 *
 * - `colorPreset`: opaque preset identifier — the specific string space depends
 *   on the surface (`"moonlight"`, `"amber"`, `"rose"`, …) plus the special
 *   value `"custom"` which means "render from `customHue` + `customSaturation`".
 * - `customHue`: 0-360, only meaningful when `colorPreset === "custom"`.
 * - `customSaturation`: 0-1, only meaningful when `colorPreset === "custom"`.
 * - `theme`: master light/dark/system theme. Optional because some surfaces
 *   (web, spatial) derive it from the OS without exposing a setting.
 */
export interface AppearanceConfig {
  colorPreset: string;
  customHue?: number;
  customSaturation?: number;
  theme?: "light" | "dark" | "system";
}

/** Default appearance — moonlight preset, no custom override, system theme. */
export const DEFAULT_APPEARANCE_CONFIG: AppearanceConfig = {
  colorPreset: "moonlight",
  customHue: 220,
  customSaturation: 0.7,
  theme: "system",
};

/**
 * Normalize any of the historical surface-specific appearance shapes onto
 * the canonical `AppearanceConfig`. Unknown fields are ignored. Missing
 * fields fall back to `DEFAULT_APPEARANCE_CONFIG`.
 *
 * Accepted legacy keys:
 *   - web:     `{preset, customHue?, customSaturation?}` (the field is
 *              `preset`, not `colorPreset`, in `SoulColorConfig`).
 *   - mobile:  `{colorPreset, customHue, customSaturation, theme}` flat
 *              on `MobileSettings`.
 *   - desktop: `{interior_color_preset, custom_soul_color: {hue, saturation}}`
 *              snake_case in the Tauri JSON config.
 *   - spatial: `{colorPreset, customHue, customSaturation}` flat on
 *              `SpatialSettings`.
 *
 * The function is intentionally defensive — it operates on `unknown` because
 * the typical caller is reading from `localStorage` / `AsyncStorage` / a
 * Tauri JSON config, all of which return untyped blobs.
 *
 * @permanent — never remove. Unlike a deprecated-then-sunset API symbol
 * (which has callers we can refactor and ship a removal for), this
 * migration reads persisted user data we can never crawl and rewrite.
 * It must keep working for every `localStorage` / `AsyncStorage` /
 * Tauri JSON config that has ever existed in the wild.
 */
export function migrateAppearanceConfig(raw: unknown): AppearanceConfig {
  if (raw == null || typeof raw !== "object") return { ...DEFAULT_APPEARANCE_CONFIG };
  const obj = raw as Record<string, unknown>;

  const isStr = (v: unknown): v is string => typeof v === "string";
  const isNum = (v: unknown): v is number => typeof v === "number";

  // Color preset: prefer canonical `colorPreset`, fall back to web's
  // legacy `preset`, then desktop's snake_case `interior_color_preset`.
  const colorPreset =
    (isStr(obj.colorPreset) ? obj.colorPreset : undefined) ??
    (isStr(obj.preset) ? obj.preset : undefined) ??
    (isStr(obj.interior_color_preset) ? obj.interior_color_preset : undefined) ??
    DEFAULT_APPEARANCE_CONFIG.colorPreset;

  // Custom hue/saturation: canonical first, then desktop's nested
  // `custom_soul_color: {hue, saturation}` shape.
  let customHue: number | undefined;
  let customSaturation: number | undefined;
  if (isNum(obj.customHue)) customHue = obj.customHue;
  if (isNum(obj.customSaturation)) customSaturation = obj.customSaturation;
  const desktopCustom = obj.custom_soul_color as { hue?: number; saturation?: number } | undefined;
  if (customHue === undefined && desktopCustom != null && isNum(desktopCustom.hue)) {
    customHue = desktopCustom.hue;
  }
  if (customSaturation === undefined && desktopCustom != null && isNum(desktopCustom.saturation)) {
    customSaturation = desktopCustom.saturation;
  }

  // Theme: canonical key only — no surface uses an alternative name.
  const themeRaw = obj.theme;
  const theme =
    themeRaw === "light" || themeRaw === "dark" || themeRaw === "system" ? themeRaw : undefined;

  return {
    colorPreset,
    customHue: customHue ?? DEFAULT_APPEARANCE_CONFIG.customHue,
    customSaturation: customSaturation ?? DEFAULT_APPEARANCE_CONFIG.customSaturation,
    theme: theme ?? DEFAULT_APPEARANCE_CONFIG.theme,
  };
}
