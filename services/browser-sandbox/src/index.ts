/**
 * Boot entrypoint for the browser-sandbox service.
 *
 * Wires the Playwright `chromium.launch()` browser into a `BrowserPool`,
 * builds the Hono app with the typed routes, and starts a Node HTTP
 * listener via `@hono/node-server`. Mirrors the boot shape of
 * `services/relay` (Hono + node-server) — kept thin so every testable
 * piece (`action-executor`, `routes`, `chromium-pool`, `auth`) is
 * unit-testable without standing up the network or a real browser.
 *
 * Idle reaper: a 60s interval calls `pool.reapIdle()` to free Chromium
 * contexts whose `lastUsedAt` is older than `BROWSER_SANDBOX_IDLE_MS`.
 * The dispatcher's `dispose` path is the happy case; the reaper is the
 * floor for forgotten sessions.
 *
 * Graceful shutdown: SIGINT/SIGTERM → close every active session +
 * the singleton browser → exit cleanly. Fly's deploy lifecycle expects
 * this; without it, Chromium processes leak across deploys.
 */

import { serve } from "@hono/node-server";
import { chromium } from "playwright-core";

import { BrowserPool } from "./chromium-pool.js";
import { loadConfig } from "./env.js";
import { buildApp } from "./routes.js";

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] browser-sandbox: ${msg}`);
}

const REAPER_INTERVAL_MS = 60_000;

async function main(): Promise<void> {
  const config = loadConfig();

  const pool = new BrowserPool({
    maxConcurrent: config.maxConcurrentSessions,
    idleMs: config.sessionIdleMs,
    viewportWidth: config.viewportWidth,
    viewportHeight: config.viewportHeight,
  });

  log(`launching chromium (headless)`);
  await pool.start(() => chromium.launch({ headless: true }));

  const app = buildApp({ config, pool });
  const server = serve({ fetch: app.fetch, port: config.port });
  log(`listening on :${config.port} — max sessions=${config.maxConcurrentSessions}`);

  const reaper = setInterval(() => {
    void pool.reapIdle().catch((err: unknown) => {
      log(`reaper error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, REAPER_INTERVAL_MS);

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      void (async () => {
        log(`${sig} received — draining`);
        clearInterval(reaper);
        server.close();
        await pool.shutdown();
        log(`shutdown complete`);
        process.exit(0);
      })();
    });
  }
}

void main().catch((err: unknown) => {
  log(`boot failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
