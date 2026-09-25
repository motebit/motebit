/**
 * Settings Save writes into the SHARED `~/.motebit/config.json` — the file
 * the CLI keeps its identity key in (`cli_encrypted_key`, for a CLI identity
 * the only copy) and the desktop keeps its `motebit_id` / `device_id` in. It
 * once built the file from scratch, so every Save dropped all of that. It
 * now merges: only the fields the Settings form owns are written, and every
 * other field on disk is carried through untouched.
 */

/**
 * Fields the Settings form owns but writes only when set: absent from the
 * form ⇒ removed from the config, as the from-scratch write used to do. The
 * last three are the legacy spellings the form's values were loaded from
 * (`ui/config.ts`); the form writes the canonical keys, and a legacy key left
 * behind would resurrect a value the user just cleared.
 */
export const SETTINGS_OWNED_REMOVABLE_FIELDS = [
  "default_model",
  "local_server_endpoint",
  "ollama_endpoint",
  "interior_color_preset",
  "custom_soul_color",
] as const;

export function mergeSettingsIntoConfig(
  existing: Record<string, unknown>,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const key of SETTINGS_OWNED_REMOVABLE_FIELDS) {
    if (!(key in settings)) delete merged[key];
  }
  return { ...merged, ...settings };
}
