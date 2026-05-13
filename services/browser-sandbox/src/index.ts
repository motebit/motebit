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
 *
 * Stealth: `playwright-extra` + `puppeteer-extra-plugin-stealth`
 * patches the JS-fingerprint signals that headless Chromium leaks
 * by default (`navigator.webdriver`, `chrome.runtime` shape, plugin
 * lists, WebGL renderer strings, console.debug fingerprints). This
 * is one detection layer. It does not address IP reputation, TLS
 * fingerprinting, CAPTCHA challenges, behavioral analysis, or
 * server-side policy. Treat stealth as a quality-of-baseline patch,
 * not as a bot-detection-defeat product. The architectural answer
 * to "agent and web" is `virtual_browser` (governed, isolated
 * browser embodiment owned by motebit, supervised by the user,
 * operated by the agent through computer-use actions, emitting
 * receipts) — tracked as a separate arc, not screenshot polish.
 */

import { serve } from "@hono/node-server";
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

import { BrowserPool } from "./chromium-pool.js";
import { loadConfig } from "./env.js";
import { buildApp } from "./routes.js";

// Apply stealth at module load — once per process. The plugin
// registers JS evasion modules that run on every newContext via
// init scripts; per-session opt-out isn't needed because the
// patches are non-destructive (they spoof presence of normal
// browser APIs that headless Chromium otherwise exposes as
// missing or malformed).
chromium.use(StealthPlugin());

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
  await pool.start(() =>
    chromium.launch({
      headless: true,
      // Playwright passes `--hide-scrollbars` to headless Chromium by
      // default; the page's overlay scrollbars never appear in the
      // captured screencast frames. Stop suppressing them so users see
      // the page's natural OS-overlay scrollbar during scroll —
      // matches what Chrome / Safari / Firefox show on every regular
      // page. Surgical override via ignoreDefaultArgs preserves every
      // other Playwright default (sandbox, GPU flags, etc.) and lets
      // Chromium's own scrollbar behavior (autohide, fade, color) ride
      // through to the user without any client-side overlay rendering.
      // The witnessed 2026-05-12 complaint: "I don't see the scroll
      // sidebar like regular browsers when u scroll."
      ignoreDefaultArgs: ["--hide-scrollbars"],
    }),
  );

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
