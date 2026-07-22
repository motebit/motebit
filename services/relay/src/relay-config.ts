/**
 * Effective relay configuration — the pure env → config seam.
 *
 * WHY THIS EXISTS. Three production incidents in one week
 * (#346 the discover-signature sunset shipped inert because `server.ts`
 * hard-coded the tolerant default and shadowed the canonical constant;
 * #357 signing keys never reached deployed molecules; #358 a produced
 * transcript was lost before egress) share ONE root: a security control is
 * implemented and unit-tested at the source layer while the DEPLOYMENT
 * WIRING neutralizes it, and the test asserts the source layer, so CI is
 * green while the shipped binary is fail-open. Nothing exercised the
 * EFFECTIVE configuration the deployed process actually computes.
 *
 * The fix is single-source-of-truth + testability of the real thing:
 *
 *   1. `buildRelayConfigFromEnv(env, deps)` — a PURE function that turns an
 *      injected env map into the exact `SyncRelayConfig` the production boot
 *      passes to `createSyncRelay`. `server.ts` calls it with `process.env`;
 *      tests call it with arbitrary env maps and assert the computed result.
 *      This is what makes "boot the real config, assert what the deployed
 *      process computes" a unit test — a test on the constant becomes a test
 *      on production.
 *
 *   2. `SECURITY_BOUNDARY_DEFAULTS` — the enumerable registry of every
 *      config field that IS a security boundary, each carrying its canonical
 *      safe-when-unset value, an accessor that reads its EFFECTIVE value from
 *      a built config, and (where observable) a black-box probe descriptor.
 *      One registry, three enforcement layers bind to it: the static gate
 *      (`check-security-default-wiring`), the effective-config unit test
 *      (`relay-config.test.ts`), and the deployed black-box probe
 *      (`probeSecurityBoundaries`). A new boundary is one registry entry,
 *      auto-covered at all three layers.
 *
 * The parse helpers (`env.ts`) take an injectable `env` (default
 * `process.env`) so this builder is pure over its input.
 */

import type { SyncRelayConfig, X402Config, ShutdownStateGetter } from "./index.js";
import { parseBoolEnv, parseIntEnv, parseFloatEnv, type EnvSource } from "./env.js";
import { DEFAULT_REQUIRE_DISCOVER_SIGNATURE } from "./federation.js";

/**
 * Runtime-only config pieces the pure env builder cannot produce — closures
 * and already-validated values the boot entry computes with side effects
 * (shutdown state, the staging-only vote policy). Injected explicitly so the
 * env → config portion stays pure and testable.
 */
export interface RelayConfigRuntimeDeps {
  getShuttingDown: ShutdownStateGetter;
  testVotePolicy?: "upheld" | "overturned" | "split";
}

/**
 * Build the production relay config from an env source. PURE: no I/O, no
 * `process.env` read (all env access flows through the injected `env`), no
 * port binding. `server.ts` is the only production caller; the effective-
 * config test drives it with crafted env maps.
 *
 * Throws `X402ConfigError`-shaped `Error` when the required
 * `X402_PAY_TO_ADDRESS` is absent — the one config-validation invariant that
 * belongs in the pure builder (every task settlement flows through x402).
 */
export function buildRelayConfigFromEnv(
  env: EnvSource,
  deps: RelayConfigRuntimeDeps,
): SyncRelayConfig {
  if (env.X402_PAY_TO_ADDRESS == null || env.X402_PAY_TO_ADDRESS === "") {
    throw new Error("X402_PAY_TO_ADDRESS is required. Set it to the platform USDC wallet address.");
  }
  const x402: X402Config = {
    payToAddress: env.X402_PAY_TO_ADDRESS,
    network: env.X402_NETWORK ?? "eip155:84532",
    facilitatorUrl: env.X402_FACILITATOR_URL,
    testnet: env.X402_TESTNET !== "false",
  };

  return {
    dbPath: env.MOTEBIT_DB_PATH,
    apiToken: env.MOTEBIT_API_TOKEN,
    corsOrigin: env.MOTEBIT_CORS_ORIGIN,
    // Opt-out boolean (device auth): safe default ON — an operator disables it
    // explicitly. A shadowing literal here would silently drop device-token
    // verification, so it is a registered security boundary.
    enableDeviceAuth: parseBoolEnv("MOTEBIT_ENABLE_DEVICE_AUTH", true, env),
    emergencyFreeze: parseBoolEnv("MOTEBIT_EMERGENCY_FREEZE", false, env),
    getShuttingDown: deps.getShuttingDown,
    x402,
    relayKeyPassphrase: env.MOTEBIT_RELAY_KEY_PASSPHRASE,
    platformFeeRate: parseFloatEnv("MOTEBIT_PLATFORM_FEE_RATE", 0.05, env),
    federation: env.MOTEBIT_FEDERATION_ENDPOINT_URL
      ? {
          endpointUrl: env.MOTEBIT_FEDERATION_ENDPOINT_URL,
          displayName: env.MOTEBIT_FEDERATION_DISPLAY_NAME,
          enabled: parseBoolEnv("MOTEBIT_FEDERATION_ENABLED", true, env),
          maxPeers: env.MOTEBIT_FEDERATION_MAX_PEERS
            ? parseIntEnv("MOTEBIT_FEDERATION_MAX_PEERS", 50, env)
            : undefined,
          // Anti-sybil safe default: do NOT auto-accept peering proposals.
          autoAcceptPeers: parseBoolEnv("MOTEBIT_FEDERATION_AUTO_ACCEPT", false, env),
          // Strict per-hop discover signing. The default is the canonical
          // constant (flipped strict by the #188 sunset), never a literal —
          // that shadowing is exactly what made #346 inert in production.
          requireDiscoverSignature: parseBoolEnv(
            "MOTEBIT_FEDERATION_REQUIRE_DISCOVER_SIGNATURE",
            DEFAULT_REQUIRE_DISCOVER_SIGNATURE,
            env,
          ),
          allowedPeers: env.MOTEBIT_FEDERATION_ALLOWED_PEERS
            ? env.MOTEBIT_FEDERATION_ALLOWED_PEERS.split(",").map((s) => s.trim())
            : undefined,
          blockedPeers: env.MOTEBIT_FEDERATION_BLOCKED_PEERS
            ? env.MOTEBIT_FEDERATION_BLOCKED_PEERS.split(",").map((s) => s.trim())
            : undefined,
        }
      : undefined,
    stripe:
      env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET
        ? {
            secretKey: env.STRIPE_SECRET_KEY,
            webhookSecret: env.STRIPE_WEBHOOK_SECRET,
            currency: env.STRIPE_CURRENCY,
          }
        : undefined,
    bridge: env.BRIDGE_API_KEY
      ? {
          apiKey: env.BRIDGE_API_KEY,
          customerId: env.BRIDGE_CUSTOMER_ID,
          sourcePaymentRail: env.BRIDGE_SOURCE_RAIL,
          sourceCurrency: env.BRIDGE_SOURCE_CURRENCY,
          baseUrl: env.BRIDGE_API_BASE_URL,
          webhookPublicKey: env.BRIDGE_WEBHOOK_PUBLIC_KEY,
        }
      : undefined,
    testVotePolicy: deps.testVotePolicy,
  };
}

// ---------------------------------------------------------------------------
// Security-boundary registry — the single source of truth the static gate,
// the effective-config test, and the black-box probe all bind to.
// ---------------------------------------------------------------------------

/**
 * A black-box probe descriptor: how to assert, against a RUNNING relay, that
 * a boundary is in its strict posture — the deployed-behavior layer that
 * catches what neither source-scan nor unit-config can (a build/wiring/env
 * divergence between the tested config and the shipped artifact).
 */
export interface SecurityBoundaryProbe {
  method: "GET" | "POST";
  path: string;
  /** JSON body for POST probes. */
  body?: unknown;
  /** HTTP status the endpoint MUST return when the boundary is strict. */
  expectStatusWhenStrict: number;
  /**
   * When the boundary lives under `federation`, the probe only means anything
   * on a federation-enabled relay. `true` ⇒ skip the probe when federation is
   * disabled (the boundary is unreachable, not fail-open).
   */
  requiresFederation?: boolean;
}

/** A config field that is a security boundary — enumerable, three-layer-enforced. */
export interface SecurityBoundaryDefault {
  /** Human-readable boundary name (for messages). */
  boundary: string;
  /** The env var that overrides the default. */
  envVar: string;
  /**
   * The canonical name of the constant that supplies the default, when the
   * default is a named constant rather than an inline literal. The static
   * gate asserts `server.ts`/the builder references THIS symbol (not a
   * shadowing literal). `null` when the safe default is an inline literal the
   * builder owns directly (e.g. auto-accept `false`, device-auth `true`).
   */
  canonicalConstant: string | null;
  /** The safe value the effective config MUST carry when the env var is unset. */
  strictWhenUnset: boolean;
  /**
   * Read the EFFECTIVE value of this boundary from a built config. `undefined`
   * means the boundary is not present in this config shape (e.g. federation
   * disabled) — the test treats that as not-applicable, never a pass.
   */
  effectiveValue: (cfg: SyncRelayConfig) => boolean | undefined;
  /** Optional deployed-behavior probe. */
  probe?: SecurityBoundaryProbe;
}

export const SECURITY_BOUNDARY_DEFAULTS: readonly SecurityBoundaryDefault[] = [
  {
    boundary: "federation per-hop discover signing (cross-org trust boundary; #188 sunset)",
    envVar: "MOTEBIT_FEDERATION_REQUIRE_DISCOVER_SIGNATURE",
    canonicalConstant: "DEFAULT_REQUIRE_DISCOVER_SIGNATURE",
    strictWhenUnset: true,
    effectiveValue: (cfg) => cfg.federation?.requireDiscoverSignature,
    probe: {
      method: "POST",
      path: "/federation/v1/discover",
      body: {
        query: { capability: "web_search" },
        hop_count: 0,
        max_hops: 1,
        visited: [],
        query_id: "security-probe-unsigned",
        origin_relay: "security-probe",
      },
      expectStatusWhenStrict: 403,
      requiresFederation: true,
    },
  },
  {
    boundary: "per-device token authentication",
    envVar: "MOTEBIT_ENABLE_DEVICE_AUTH",
    canonicalConstant: null,
    strictWhenUnset: true,
    effectiveValue: (cfg) => cfg.enableDeviceAuth,
  },
  {
    boundary: "federation auto-accept peering (anti-sybil: never auto-admit peers)",
    envVar: "MOTEBIT_FEDERATION_AUTO_ACCEPT",
    canonicalConstant: null,
    // Safe default is FALSE — the boundary is "strict" when auto-accept is off.
    strictWhenUnset: false,
    effectiveValue: (cfg) => cfg.federation?.autoAcceptPeers,
  },
];

/**
 * The minimal env a valid relay config requires (x402 pay-to). Exposed so the
 * effective-config test builds a realistic baseline before permuting the
 * security env vars around it.
 */
export const MINIMAL_VALID_RELAY_ENV: EnvSource = {
  X402_PAY_TO_ADDRESS: "0x0000000000000000000000000000000000000000",
};

/**
 * Probe a RUNNING relay's security boundaries (deployed-behavior layer).
 * Returns one result per applicable boundary. `federationEnabled` gates the
 * federation-scoped probes (an unreachable boundary is skipped, not failed).
 * Pure over an injected `fetchImpl` so it is drivable in tests and against
 * prod alike.
 */
export async function probeSecurityBoundaries(
  baseUrl: string,
  opts: {
    federationEnabled: boolean;
    fetchImpl?: typeof fetch;
  },
): Promise<
  Array<{
    boundary: string;
    envVar: string;
    skipped: boolean;
    strict: boolean;
    detail: string;
  }>
> {
  const doFetch = opts.fetchImpl ?? fetch;
  const results: Array<{
    boundary: string;
    envVar: string;
    skipped: boolean;
    strict: boolean;
    detail: string;
  }> = [];
  for (const b of SECURITY_BOUNDARY_DEFAULTS) {
    if (b.probe == null) continue;
    if (b.probe.requiresFederation && !opts.federationEnabled) {
      results.push({
        boundary: b.boundary,
        envVar: b.envVar,
        skipped: true,
        strict: false,
        detail: "federation disabled — boundary unreachable, probe skipped",
      });
      continue;
    }
    const url = `${baseUrl.replace(/\/$/, "")}${b.probe.path}`;
    let status: number;
    try {
      const resp = await doFetch(url, {
        method: b.probe.method,
        headers: { "Content-Type": "application/json" },
        ...(b.probe.body != null ? { body: JSON.stringify(b.probe.body) } : {}),
      });
      status = resp.status;
    } catch (err) {
      results.push({
        boundary: b.boundary,
        envVar: b.envVar,
        skipped: false,
        strict: false,
        detail: `probe request failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    const strict = status === b.probe.expectStatusWhenStrict;
    results.push({
      boundary: b.boundary,
      envVar: b.envVar,
      skipped: false,
      strict,
      detail: `${b.probe.method} ${b.probe.path} → ${status} (strict expects ${b.probe.expectStatusWhenStrict})`,
    });
  }
  return results;
}
