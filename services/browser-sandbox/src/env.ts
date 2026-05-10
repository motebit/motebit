/**
 * Environment-derived config for the browser-sandbox service.
 *
 * Single source of truth: every env-sensitive value flows through
 * `loadConfig()` so tests can pass a stub instead of reading
 * `process.env` directly. Mirrors the pattern in `services/research`
 * and `services/code-review`.
 */

export interface BrowserSandboxConfig {
  /**
   * Legacy shared bearer token. Verified constant-time in `auth.ts`.
   * The v1 single-tenant model. Optional in v1.5+: deployments that
   * configure `trustedRelayPublicKeyHex` accept relay-signed
   * audience-bound tokens (`aud: "browser-sandbox"`) under the same
   * `dualAuth` shape the relay uses for its own audience-bound
   * endpoints.
   *
   * At least one of `apiToken` or `trustedRelayPublicKeyHex` MUST be
   * set — otherwise the service has no way to authenticate any
   * caller and `loadConfig` throws at boot. Marked deprecated when
   * the relay-signed-token path lands as the default; sunsets in
   * `@motebit/browser-sandbox@2.0.0` once federation-grade trust
   * anchors are the only path.
   */
  readonly apiToken: string | null;
  /**
   * Pinned hex-encoded Ed25519 public key of the trusted relay. When
   * set, the service accepts `Authorization: Bearer <token>` headers
   * carrying a relay-signed audience-bound token (the
   * `BROWSER_SANDBOX_AUDIENCE` from `@motebit/protocol`) and verifies
   * the signature against this pinned key. The motebit_id (`mid`
   * claim) appears in the audit log for attribution.
   *
   * Single trust anchor: browser-sandbox never needs any motebit's
   * identity directly — it trusts the relay to vouch via the audience-
   * bound token flow at `services/relay/src/browser-sandbox.ts`.
   * Multi-relay trust = future work (an array of pinned keys, or a
   * discovery hop).
   */
  readonly trustedRelayPublicKeyHex: string | null;
  /** TCP port to listen on. */
  readonly port: number;
  /**
   * Hard cap on concurrent browser sessions across all motebits. A
   * Chromium context is ~150-200 MB; the cap prevents a single misuse
   * from OOMing the box.
   */
  readonly maxConcurrentSessions: number;
  /**
   * Idle timeout before a session is auto-disposed (ms). Frees
   * Chromium contexts whose motebit forgot to close them.
   */
  readonly sessionIdleMs: number;
  /**
   * Logical viewport (`display.width × display.height`) the service
   * advertises on every `POST /sessions/ensure`. Action coordinates
   * live in this space; per the spec, screenshot dimensions also
   * match these values.
   */
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

const DEFAULT_PORT = 3500;
const DEFAULT_MAX_SESSIONS = 4;
const DEFAULT_IDLE_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_VIEWPORT_WIDTH = 1280;
const DEFAULT_VIEWPORT_HEIGHT = 800;

export function loadConfig(): BrowserSandboxConfig {
  // Either path satisfies auth: legacy shared bearer (single-tenant
  // local-dev) or pinned relay public key (federation-grade). At least
  // one MUST be set; both is also fine (dualAuth pattern).
  const rawApiToken = process.env["MOTEBIT_API_TOKEN"];
  const apiToken = rawApiToken && rawApiToken.length >= 16 ? rawApiToken : null;

  const rawRelayPubkey = process.env["MOTEBIT_TRUSTED_RELAY_PUBKEY"];
  // Ed25519 public keys are 32 bytes = 64 hex chars. Reject anything
  // shorter to fail loud on a malformed env var.
  const trustedRelayPublicKeyHex =
    rawRelayPubkey && /^[0-9a-fA-F]{64}$/.test(rawRelayPubkey)
      ? rawRelayPubkey.toLowerCase()
      : null;

  if (rawApiToken && !apiToken) {
    throw new Error(
      "browser-sandbox: MOTEBIT_API_TOKEN was set but is shorter than 16 chars — set a real token or unset to use relay-signed-token auth only",
    );
  }
  if (rawRelayPubkey && !trustedRelayPublicKeyHex) {
    throw new Error(
      "browser-sandbox: MOTEBIT_TRUSTED_RELAY_PUBKEY was set but is not a 64-char hex Ed25519 public key — set a valid relay pubkey or unset to use legacy bearer auth only",
    );
  }
  if (!apiToken && !trustedRelayPublicKeyHex) {
    throw new Error(
      "browser-sandbox: at least one of MOTEBIT_API_TOKEN (legacy shared bearer) or MOTEBIT_TRUSTED_RELAY_PUBKEY (federation-grade signed-token) must be set",
    );
  }

  return {
    apiToken,
    trustedRelayPublicKeyHex,
    port: parseIntEnv("MOTEBIT_PORT", DEFAULT_PORT),
    maxConcurrentSessions: parseIntEnv("BROWSER_SANDBOX_MAX_SESSIONS", DEFAULT_MAX_SESSIONS),
    sessionIdleMs: parseIntEnv("BROWSER_SANDBOX_IDLE_MS", DEFAULT_IDLE_MS),
    viewportWidth: parseIntEnv("BROWSER_SANDBOX_VIEWPORT_WIDTH", DEFAULT_VIEWPORT_WIDTH),
    viewportHeight: parseIntEnv("BROWSER_SANDBOX_VIEWPORT_HEIGHT", DEFAULT_VIEWPORT_HEIGHT),
  };
}

/**
 * Read an integer env var, returning `fallback` when absent / empty /
 * non-positive. Same name-first shape as `services/relay/src/env.ts`'s
 * helpers — `check-deploy-parity` recognises this signature and binds
 * the named env var to the service's source-walk inventory.
 */
function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
