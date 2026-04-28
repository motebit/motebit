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
import type { X402Config } from "./index.js";
import { createLogger } from "./logger.js";
import { parseBoolEnv, parseIntEnv, parseFloatEnv } from "./env.js";

if (process.env.NODE_ENV === "production" && !process.env.MOTEBIT_DB_PATH) {
  createLogger({ service: "relay" }).error("relay.fatal", {
    reason: "MOTEBIT_DB_PATH must be set in production (otherwise data is lost on restart)",
  });
  process.exit(1);
}
// x402 payment layer: required — every task settlement flows through x402
if (!process.env.X402_PAY_TO_ADDRESS) {
  throw new Error("X402_PAY_TO_ADDRESS is required. Set it to the platform USDC wallet address.");
}
const x402Env: X402Config = {
  payToAddress: process.env.X402_PAY_TO_ADDRESS,
  network: process.env.X402_NETWORK ?? "eip155:84532",
  facilitatorUrl: process.env.X402_FACILITATOR_URL,
  testnet: process.env.X402_TESTNET !== "false",
};

// --- Shutdown state (shared with health check via config) ---
let shuttingDown = false;

const relay = await createSyncRelay({
  dbPath: process.env.MOTEBIT_DB_PATH,
  apiToken: process.env.MOTEBIT_API_TOKEN,
  corsOrigin: process.env.MOTEBIT_CORS_ORIGIN,
  // Opt-out booleans: default on, explicit "false" to disable.
  enableDeviceAuth: parseBoolEnv("MOTEBIT_ENABLE_DEVICE_AUTH", true),
  // Opt-in boolean: default off, explicit "true" to enable.
  emergencyFreeze: parseBoolEnv("MOTEBIT_EMERGENCY_FREEZE", false),
  getShuttingDown: () => shuttingDown,
  x402: x402Env,
  // Relay identity encryption passphrase. Read from env once, here, into
  // the config object — no more direct process.env access downstream.
  relayKeyPassphrase: process.env.MOTEBIT_RELAY_KEY_PASSPHRASE,
  platformFeeRate: parseFloatEnv("MOTEBIT_PLATFORM_FEE_RATE", 0.05),
  federation: process.env.MOTEBIT_FEDERATION_ENDPOINT_URL
    ? {
        endpointUrl: process.env.MOTEBIT_FEDERATION_ENDPOINT_URL,
        displayName: process.env.MOTEBIT_FEDERATION_DISPLAY_NAME,
        enabled: parseBoolEnv("MOTEBIT_FEDERATION_ENABLED", true),
        maxPeers: process.env.MOTEBIT_FEDERATION_MAX_PEERS
          ? parseIntEnv("MOTEBIT_FEDERATION_MAX_PEERS", 50)
          : undefined,
        autoAcceptPeers: parseBoolEnv("MOTEBIT_FEDERATION_AUTO_ACCEPT", false),
        allowedPeers: process.env.MOTEBIT_FEDERATION_ALLOWED_PEERS
          ? process.env.MOTEBIT_FEDERATION_ALLOWED_PEERS.split(",").map((s) => s.trim())
          : undefined,
        blockedPeers: process.env.MOTEBIT_FEDERATION_BLOCKED_PEERS
          ? process.env.MOTEBIT_FEDERATION_BLOCKED_PEERS.split(",").map((s) => s.trim())
          : undefined,
      }
    : undefined,
  stripe:
    process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET
      ? {
          secretKey: process.env.STRIPE_SECRET_KEY,
          webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
          currency: process.env.STRIPE_CURRENCY,
        }
      : undefined,
  bridge:
    process.env.BRIDGE_API_KEY && process.env.BRIDGE_CUSTOMER_ID
      ? {
          apiKey: process.env.BRIDGE_API_KEY,
          customerId: process.env.BRIDGE_CUSTOMER_ID,
          sourcePaymentRail: process.env.BRIDGE_SOURCE_RAIL,
          sourceCurrency: process.env.BRIDGE_SOURCE_CURRENCY,
          baseUrl: process.env.BRIDGE_API_BASE_URL,
          webhookPublicKey: process.env.BRIDGE_WEBHOOK_PUBLIC_KEY,
        }
      : undefined,
});
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
