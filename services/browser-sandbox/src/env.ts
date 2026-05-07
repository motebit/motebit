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
   * Bearer token the service accepts on every request. Verified
   * constant-time in `auth.ts`. v1 is a single shared secret keyed
   * by the relay; the federation-grade signed-token model graduates
   * here when a second operator runs a browser-sandbox.
   */
  readonly apiToken: string;
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
  const apiToken = process.env["MOTEBIT_API_TOKEN"];
  if (!apiToken || apiToken.length < 16) {
    throw new Error(
      "browser-sandbox: MOTEBIT_API_TOKEN env var is required and must be >= 16 chars",
    );
  }
  return {
    apiToken,
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
