/**
 * Standalone boot entry for `@motebit/relay`.
 *
 * This file is the executable wrapper around the `createSyncRelay`
 * library. `index.ts` is the library entry and must stay
 * side-effect-free at module load so embedders (the CLI's
 * `motebit relay up`, tests, future multi-tenant hosts) can `import
 * { createSyncRelay }` without tripping env requirements or binding
 * a port.
 *
 * Production deployment runs `node dist/server.js`. See
 * `services/relay/run.sh`, `services/relay/package.json` `start`, and
 * the systemd `ExecStart` in `DEPLOY.md` — all three point here.
 *
 * The env-reading is centralized here (not in `createSyncRelay`) per
 * the relay CLAUDE.md: the library takes a typed config, the boot
 * entry is the only place `process.env` reads happen for the
 * production service.
 */

import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { createSyncRelay } from "./index.js";
import { createLogger } from "./logger.js";
import { parseBoolEnv } from "./env.js";
import { buildRelayConfigFromEnv } from "./relay-config.js";

if (process.env.NODE_ENV === "production" && !process.env.MOTEBIT_DB_PATH) {
  createLogger({ service: "relay" }).error("relay.fatal", {
    reason: "MOTEBIT_DB_PATH must be set in production (otherwise data is lost on restart)",
  });
  process.exit(1);
}

// --- Shutdown state (shared with health check via config) ---
let shuttingDown = false;

// MOTEBIT_TEST_VOTE_POLICY: STAGING/development-only affordance for the
// §6.2 federation orchestrator's peer-side vote callback. When set to
// `upheld`/`overturned`/`split`, this relay returns a deterministic vote
// for every incoming /federation/v1/disputes/:disputeId/vote-request,
// satisfying the gate-6 `vote_policy_configured` check so federation
// peers can validate the orchestrator end-to-end against the live K4
// staging mesh (`scripts/test-federation-live.mjs` Phase 8).
//
// SECURITY: never set in production. Default behavior (no env var = no
// callback wired = 501 `policy_not_configured`) is the safe production
// posture per `spec/relay-federation-v1.md` §16.2 mandate-callback
// semantics. The startup-log warning below makes prod misconfig
// operator-visible immediately.
const testVotePolicyRaw = process.env.MOTEBIT_TEST_VOTE_POLICY;
let testVotePolicy: "upheld" | "overturned" | "split" | undefined;
if (testVotePolicyRaw !== undefined) {
  if (
    testVotePolicyRaw === "upheld" ||
    testVotePolicyRaw === "overturned" ||
    testVotePolicyRaw === "split"
  ) {
    testVotePolicy = testVotePolicyRaw;
    createLogger({ service: "relay" }).warn("relay.test_vote_policy.enabled", {
      policy: testVotePolicy,
      warning:
        "STAGING/development affordance — every §6.2 vote-request returns this deterministic outcome. MUST NOT be set on production relays.",
    });
  } else {
    createLogger({ service: "relay" }).error("relay.test_vote_policy.invalid", {
      received: testVotePolicyRaw,
      expected: "upheld | overturned | split",
    });
    process.exit(1);
  }
}

// The entire env → config computation lives in the pure
// `buildRelayConfigFromEnv` (relay-config.ts) so the EFFECTIVE configuration
// the deployed process computes is unit-testable under arbitrary env maps —
// the seam that closes the #346/#357/#358 shadow-the-constant class (a test
// on the constant is now a test on production). The boot entry supplies only
// the runtime closures the pure builder cannot produce.
const relay = await createSyncRelay(
  buildRelayConfigFromEnv(process.env, {
    getShuttingDown: () => shuttingDown,
    testVotePolicy,
  }),
);
const app: Hono = relay.app;

const port = Number(process.env.PORT ?? 3000);
const bootLogger = createLogger({ service: "relay" });
bootLogger.info("relay.starting", {
  db: process.env.MOTEBIT_DB_PATH ?? ":memory:",
  driver: relay.moteDb.db.driverName,
  deviceAuth: parseBoolEnv("MOTEBIT_ENABLE_DEVICE_AUTH", true),
  federation: process.env.MOTEBIT_FEDERATION_ENDPOINT_URL ?? "disabled",
  keyEncryption: process.env.MOTEBIT_RELAY_KEY_PASSPHRASE ? "active" : "disabled",
});
const server = serve({ fetch: app.fetch, port }, (info) => {
  bootLogger.info("relay.listening", { port: info.port });
});
// Inject WebSocket support
const injectWs = (app as Hono & { injectWebSocket?: (server: unknown) => void }).injectWebSocket;
if (injectWs) injectWs(server);

// --- Graceful shutdown ---
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 30_000);
let forceOnNextSignal = false;

const gracefulShutdown = (signal: string): void => {
  if (forceOnNextSignal) {
    bootLogger.warn("relay.shutdown.forced", { signal });
    process.exit(1);
  }
  forceOnNextSignal = true;
  shuttingDown = true;
  bootLogger.info("relay.shutdown.draining", { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS });

  // Hard deadline: force exit if drain exceeds timeout
  const forceTimer = setTimeout(() => {
    bootLogger.error("relay.shutdown.timeout", { timeoutMs: SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  // Unref so this timer alone doesn't keep the process alive
  if (typeof forceTimer === "object" && "unref" in forceTimer) {
    forceTimer.unref();
  }

  // Stop accepting new connections, wait for in-flight requests to finish
  server.close(() => {
    bootLogger.info("relay.shutdown.server_closed");
    void relay.close().then(() => {
      bootLogger.info("relay.shutdown.complete");
      process.exit(0);
    });
  });
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

export default app;
export { app };
