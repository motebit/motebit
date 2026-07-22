/**
 * Environment variable parsing helpers.
 *
 * Rationale: previous relay boot code had two conflicting conventions for
 * boolean env vars — some opted out (raw value compared against the
 * literal `"false"`, default on), others opted in (raw value compared
 * against `"true"`, default off). Operators had to remember which
 * variable had which convention.
 *
 * These helpers centralize the parsing rules so every boolean env var
 * behaves the same way, and the default is explicit in the call site.
 *
 * The `env` source is INJECTABLE (default `process.env`) so the config
 * builder (`relay-config.ts`) can compute EFFECTIVE configuration under an
 * arbitrary env map — the seam that makes "boot the real config, assert what
 * the deployed process actually computes" testable (the effective-config
 * harness closing the #346/#357/#358 shadow-the-constant class). Existing
 * call sites pass two args and read `process.env` unchanged.
 */

/** The minimal shape of an environment source — `process.env` satisfies it. */
export type EnvSource = Record<string, string | undefined>;

/**
 * Parse a boolean environment variable with an explicit default.
 *
 * Accepts (case-insensitive): `"true" | "1" | "yes" | "on"` as true, and
 * `"false" | "0" | "no" | "off"` as false. Any other value (including
 * unset) falls back to `defaultValue`.
 *
 * Prefer this over ad-hoc string comparisons against the raw env value
 * (`=== "true"` / `!== "false"`) scattered across boot code.
 *
 * @example
 *   const deviceAuth = parseBoolEnv("MOTEBIT_ENABLE_DEVICE_AUTH", true);
 *   const freeze     = parseBoolEnv("MOTEBIT_EMERGENCY_FREEZE", false);
 */
export function parseBoolEnv(
  name: string,
  defaultValue: boolean,
  env: EnvSource = process.env,
): boolean {
  const raw = env[name];
  if (raw == null) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return defaultValue;
}

/**
 * Parse an integer environment variable with a default. Rejects NaN and
 * non-finite values, returning the default instead.
 */
export function parseIntEnv(
  name: string,
  defaultValue: number,
  env: EnvSource = process.env,
): number {
  const raw = env[name];
  if (raw == null) return defaultValue;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

/**
 * Parse a float environment variable with a default. Rejects NaN and
 * non-finite values.
 */
export function parseFloatEnv(
  name: string,
  defaultValue: number,
  env: EnvSource = process.env,
): number {
  const raw = env[name];
  if (raw == null) return defaultValue;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}
