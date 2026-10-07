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
 * The named boot error: a SET environment variable the relay cannot read
 * exactly. Every relay env var that moves money, prices it, caps it, paces a
 * money loop or is a safety switch is read through the strict parsers below,
 * which throw this instead of guessing — a malformed money or kill-switch
 * setting refuses to boot and never authorizes (`MOTEBIT_FREE_CREDIT_USD=0x10`
 * was $16 per motebit through `Number()`, `MOTEBIT_EMERGENCY_FREEZE=ture` booted
 * unfrozen). The message names the variable and the accepted form.
 */
export class RelayEnvConfigError extends Error {
  readonly variable: string;
  constructor(variable: string, raw: string, accepted: string) {
    super(
      `${variable}=${JSON.stringify(raw)} is not accepted: ${variable} must be ${accepted}. ` +
        `The relay refuses to boot rather than guess; fix the value or unset ${variable} for its default.`,
    );
    this.name = "RelayEnvConfigError";
    this.variable = variable;
  }
}

const BOOL_ON = new Set(["true", "1"]);
const BOOL_OFF = new Set(["false", "0"]);

/**
 * Parse a boolean environment variable with an explicit default.
 *
 * Exact vocabulary after trim + lowercase: `true` / `1` is on, `false` / `0`
 * is off; unset or empty (whitespace only) is `defaultValue`. Anything else —
 * `ture`, `y`, `enabled`, `yes`, `on` — throws {@link RelayEnvConfigError}:
 * every relay boolean gates money or security (the emergency freeze, device
 * auth, private endpoints, federation admission, x402 testnet), and a
 * typo'd switch must not leave money moving.
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
  if (normalized === "") return defaultValue;
  if (BOOL_ON.has(normalized)) return true;
  if (BOOL_OFF.has(normalized)) return false;
  throw new RelayEnvConfigError(name, raw, "one of `true`, `1`, `false`, `0` (case-insensitive)");
}

/** Bounds for {@link parseIntEnv}. */
export interface IntEnvBounds {
  min: number;
  max: number;
}

/** Accepted cadence of every money-reconciliation loop: 1 ms to 24 h (0 would spin). */
export const RECONCILIATION_INTERVAL_BOUNDS: IntEnvBounds = { min: 1, max: 86_400_000 };
/** Accepted `MOTEBIT_FEDERATION_MAX_PEERS`. */
export const FEDERATION_MAX_PEERS_BOUNDS: IntEnvBounds = { min: 0, max: 10_000 };

/**
 * Parse a non-negative integer environment variable. Unset keeps
 * `defaultValue`; anything SET (the empty string included) must be plain
 * decimal digits (surrounding whitespace ignored) within `[min, max]`, or this
 * throws {@link RelayEnvConfigError}. `parseInt("12abc")` is 12 and
 * `parseInt("1e6")` is 1 — neither is a count the operator wrote.
 */
export function parseIntEnv(
  name: string,
  defaultValue: number,
  bounds: IntEnvBounds,
  env: EnvSource = process.env,
): number {
  const raw = env[name];
  if (raw == null) return defaultValue;
  const trimmed = raw.trim();
  const n = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isSafeInteger(n) || n < bounds.min || n > bounds.max) {
    throw new RelayEnvConfigError(
      name,
      raw,
      `a whole number from ${String(bounds.min)} to ${String(bounds.max)} (digits only)`,
    );
  }
  return n;
}

/**
 * Parse a rate environment variable in `[0, 1)` — e.g. the platform fee
 * (`0.05`). Unset keeps `defaultValue`; anything SET must be `0` or `0.` plus
 * one to six digits (surrounding whitespace ignored): no sign, exponent, hex,
 * separator or leading `.`, or this throws {@link RelayEnvConfigError}.
 */
export function parseFloatEnv(
  name: string,
  defaultValue: number,
  env: EnvSource = process.env,
): number {
  const raw = env[name];
  if (raw == null) return defaultValue;
  const trimmed = raw.trim();
  if (!/^0(\.\d{1,6})?$/.test(trimmed)) {
    throw new RelayEnvConfigError(
      name,
      raw,
      "a decimal rate from 0 up to (not including) 1, at most 6 decimal places (e.g. `0.05`)",
    );
  }
  return Number(trimmed);
}

/**
 * Parse a USD amount environment variable to integer micro-units. Unset keeps
 * `defaultMicro`; anything SET must be digits with an optional `.` and one to
 * six fractional digits (surrounding whitespace ignored) — no sign, exponent,
 * hex or separator — and at most `maxUsd` dollars, or this throws
 * {@link RelayEnvConfigError}. The micro amount is computed from the digits,
 * never through a float (`toMicro` semantics, exact for ≤ 6 decimals).
 */
export function parseUsdMicroEnv(
  name: string,
  defaultMicro: number,
  maxUsd: number,
  env: EnvSource = process.env,
): number {
  const raw = env[name];
  if (raw == null) return defaultMicro;
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(raw.trim());
  const accepted =
    `a USD amount from 0 to ${String(maxUsd)}: digits with an optional \`.\` and up to 6 ` +
    "decimal places (e.g. `0.10`), no sign, exponent or separators";
  if (m == null || m[1]!.length > 15) throw new RelayEnvConfigError(name, raw, accepted);
  const micro = Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
  if (!Number.isSafeInteger(micro) || micro > maxUsd * 1_000_000) {
    throw new RelayEnvConfigError(name, raw, accepted);
  }
  return micro;
}
