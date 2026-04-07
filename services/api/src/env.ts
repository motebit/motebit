/**
 * Environment variable parsing helpers.
 *
 * Rationale: previous relay boot code had two conflicting conventions for
 * boolean env vars — some used `process.env.FOO !== "false"` (opt-out,
 * default on), others used `process.env.FOO === "true"` (opt-in, default
 * off). Operators had to remember which variable had which convention.
 *
 * These helpers centralize the parsing rules so every boolean env var
 * behaves the same way, and the default is explicit in the call site.
 */

/**
 * Parse a boolean environment variable with an explicit default.
 *
 * Accepts (case-insensitive): `"true" | "1" | "yes" | "on"` as true, and
 * `"false" | "0" | "no" | "off"` as false. Any other value (including
 * unset) falls back to `defaultValue`.
 *
 * Prefer this over ad-hoc `process.env.FOO === "true"` / `!== "false"`
 * checks scattered in boot code.
 *
 * @example
 *   const deviceAuth = parseBoolEnv("MOTEBIT_ENABLE_DEVICE_AUTH", true);
 *   const freeze     = parseBoolEnv("MOTEBIT_EMERGENCY_FREEZE", false);
 */
export function parseBoolEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
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
export function parseIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

/**
 * Parse a float environment variable with a default. Rejects NaN and
 * non-finite values.
 */
export function parseFloatEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}
