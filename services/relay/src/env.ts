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
 * The `env` source is INJECTABLE (default `relayEnv()`) so the config
 * builder (`relay-config.ts`) can compute EFFECTIVE configuration under an
 * arbitrary env map — the seam that makes "boot the real config, assert what
 * the deployed process actually computes" testable (the effective-config
 * harness closing the #346/#357/#358 shadow-the-constant class). Existing
 * call sites pass two args and read the process environment unchanged.
 */

/** The minimal shape of an environment source — `relayEnv()` satisfies it. */
export type EnvSource = Record<string, string | undefined>;

/**
 * The process environment as the relay's injected-env seam reads it: every
 * key read through an `EnvSource` (relay-config.ts's `env.<NAME>`, every
 * `parse*Env("NAME", …)`, and `X402_RPC_URL_<chain>` for each chain in
 * CONFIRMATIONS_BY_CHAIN), each a direct literal-key read of `process.env`.
 * check-service-truth refuses `process.env` as a value (deny-by-default: a
 * handle on the env object is how a service writes it), so the seam's
 * source is this explicit read set; `__tests__/relay-env.test.ts` fails when
 * a key read through the seam is missing here. Evaluated per call, so it
 * reflects the live environment exactly as `process.env` did.
 */
export function relayEnv(): EnvSource {
  return {
    BRIDGE_API_BASE_URL: process.env.BRIDGE_API_BASE_URL,
    BRIDGE_API_KEY: process.env.BRIDGE_API_KEY,
    BRIDGE_CUSTOMER_ID: process.env.BRIDGE_CUSTOMER_ID,
    BRIDGE_SOURCE_CURRENCY: process.env.BRIDGE_SOURCE_CURRENCY,
    BRIDGE_SOURCE_RAIL: process.env.BRIDGE_SOURCE_RAIL,
    BRIDGE_WEBHOOK_PUBLIC_KEY: process.env.BRIDGE_WEBHOOK_PUBLIC_KEY,
    MOTEBIT_ALLOW_PRIVATE_ENDPOINTS: process.env.MOTEBIT_ALLOW_PRIVATE_ENDPOINTS,
    MOTEBIT_API_TOKEN: process.env.MOTEBIT_API_TOKEN,
    MOTEBIT_CORS_ORIGIN: process.env.MOTEBIT_CORS_ORIGIN,
    MOTEBIT_DB_PATH: process.env.MOTEBIT_DB_PATH,
    MOTEBIT_EMERGENCY_FREEZE: process.env.MOTEBIT_EMERGENCY_FREEZE,
    MOTEBIT_ENABLE_DEVICE_AUTH: process.env.MOTEBIT_ENABLE_DEVICE_AUTH,
    MOTEBIT_FEDERATION_ALLOWED_PEERS: process.env.MOTEBIT_FEDERATION_ALLOWED_PEERS,
    MOTEBIT_FEDERATION_AUTO_ACCEPT: process.env.MOTEBIT_FEDERATION_AUTO_ACCEPT,
    MOTEBIT_FEDERATION_BLOCKED_PEERS: process.env.MOTEBIT_FEDERATION_BLOCKED_PEERS,
    MOTEBIT_FEDERATION_DISPLAY_NAME: process.env.MOTEBIT_FEDERATION_DISPLAY_NAME,
    MOTEBIT_FEDERATION_ENABLED: process.env.MOTEBIT_FEDERATION_ENABLED,
    MOTEBIT_FEDERATION_ENDPOINT_URL: process.env.MOTEBIT_FEDERATION_ENDPOINT_URL,
    MOTEBIT_FEDERATION_MAX_PEERS: process.env.MOTEBIT_FEDERATION_MAX_PEERS,
    MOTEBIT_FEDERATION_REQUIRE_DISCOVER_SIGNATURE:
      process.env.MOTEBIT_FEDERATION_REQUIRE_DISCOVER_SIGNATURE,
    MOTEBIT_PLATFORM_FEE_RATE: process.env.MOTEBIT_PLATFORM_FEE_RATE,
    MOTEBIT_RELAY_ISSUE_CREDENTIALS: process.env.MOTEBIT_RELAY_ISSUE_CREDENTIALS,
    MOTEBIT_RELAY_KEY_PASSPHRASE: process.env.MOTEBIT_RELAY_KEY_PASSPHRASE,
    MOTEBIT_SOLANA_TREASURY_RECONCILIATION_INTERVAL_MS:
      process.env.MOTEBIT_SOLANA_TREASURY_RECONCILIATION_INTERVAL_MS,
    MOTEBIT_TREASURY_RECONCILIATION_INTERVAL_MS:
      process.env.MOTEBIT_TREASURY_RECONCILIATION_INTERVAL_MS,
    MOTEBIT_X402_RECONCILIATION_INTERVAL_MS: process.env.MOTEBIT_X402_RECONCILIATION_INTERVAL_MS,
    STRIPE_CURRENCY: process.env.STRIPE_CURRENCY,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    X402_FACILITATOR_URL: process.env.X402_FACILITATOR_URL,
    X402_NETWORK: process.env.X402_NETWORK,
    X402_PAY_TO_ADDRESS: process.env.X402_PAY_TO_ADDRESS,
    X402_TESTNET: process.env.X402_TESTNET,
    // `x402RpcUrlFor` (x402-settlements.ts): one override per reconcilable chain.
    X402_RPC_URL_EIP155_1: process.env.X402_RPC_URL_EIP155_1,
    X402_RPC_URL_EIP155_8453: process.env.X402_RPC_URL_EIP155_8453,
    X402_RPC_URL_EIP155_84532: process.env.X402_RPC_URL_EIP155_84532,
    X402_RPC_URL_EIP155_10: process.env.X402_RPC_URL_EIP155_10,
    X402_RPC_URL_EIP155_137: process.env.X402_RPC_URL_EIP155_137,
    X402_RPC_URL_EIP155_42161: process.env.X402_RPC_URL_EIP155_42161,
  };
}

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
  env: EnvSource = relayEnv(),
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
  env: EnvSource = relayEnv(),
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
  env: EnvSource = relayEnv(),
): number {
  const raw = env[name];
  if (raw == null) return defaultValue;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}
