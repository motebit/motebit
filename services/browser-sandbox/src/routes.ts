/**
 * Hono route registration for the browser-sandbox.
 *
 * Three endpoints (the wire shape `CloudBrowserDispatcher` reads):
 *
 *   POST   /sessions/ensure          → open a new session, return id+display
 *   POST   /sessions/:id/actions     → execute one action against a session
 *   DELETE /sessions/:id             → tear down a session
 *
 * Plus `GET /health` (unauth) for Fly's health-check loop.
 *
 * Every authed route uses `requireBearer` from `auth.ts`. Errors flow
 * through `ServiceError` and the global `app.onError` handler so the
 * dispatcher always receives the structured `{ error: { reason,
 * message } }` envelope it knows how to map.
 *
 * Why session_id is in the URL (not just the body): explicit
 * multi-tenancy. With multiple concurrent dispatchers sharing the
 * same shared-secret token, the session id in the URL is what
 * disambiguates which session this request targets. The dispatcher
 * already tracks the session id from `/sessions/ensure` — putting it
 * in subsequent URLs is mechanical, no additional state.
 */

import { Hono } from "hono";

import type { ComputerAction } from "@motebit/protocol";

import { requireBearer } from "./auth.js";
import { executeAction } from "./action-executor.js";
import type { BrowserPool } from "./chromium-pool.js";
import type { BrowserSandboxConfig } from "./env.js";
import { ServiceError, isServiceError } from "./errors.js";

export interface BuildAppDeps {
  readonly config: BrowserSandboxConfig;
  readonly pool: BrowserPool;
}

export function buildApp(deps: BuildAppDeps): Hono {
  const app = new Hono();

  // ── Unauthenticated ──────────────────────────────────────────────
  app.get("/health", (c) =>
    c.json({ ok: true, service: "browser-sandbox", sessions: deps.pool.size() }),
  );

  // ── Authenticated routes ────────────────────────────────────────
  app.use("/sessions/*", requireBearer(deps.config.apiToken));

  app.post("/sessions/ensure", async (c) => {
    const session = await deps.pool.openSession();
    return c.json({
      session_id: session.sessionId,
      display: {
        width: deps.config.viewportWidth,
        height: deps.config.viewportHeight,
        scaling_factor: 1,
      },
    });
  });

  app.post("/sessions/:id/actions", async (c) => {
    const sessionId = c.req.param("id");
    const session = deps.pool.getSession(sessionId);
    if (!session) {
      throw new ServiceError("session_closed", `session not found: ${sessionId}`);
    }
    const body = (await c.req.json().catch(() => ({}))) as { action?: unknown };
    const action = body.action;
    if (
      action === null ||
      action === undefined ||
      typeof action !== "object" ||
      typeof (action as { kind?: unknown }).kind !== "string"
    ) {
      throw new ServiceError("not_supported", "missing or malformed `action` body");
    }
    deps.pool.touchSession(sessionId);
    deps.pool.beginAction(sessionId);
    try {
      const result = await executeAction(session, action as ComputerAction);
      return c.json(result);
    } finally {
      // `finally` so a thrown executor returns inFlight to zero — the
      // global error handler still runs after this and surfaces the
      // ServiceError envelope; the reaper sees the session as idle-able
      // again (assuming `lastUsedAt` is past the cutoff).
      deps.pool.endAction(sessionId);
    }
  });

  app.delete("/sessions/:id", async (c) => {
    const sessionId = c.req.param("id");
    await deps.pool.closeSession(sessionId);
    return c.body(null, 204);
  });

  // ── Global error handler ────────────────────────────────────────
  // Every route's thrown `ServiceError` lands here and is serialized
  // into the wire envelope the dispatcher knows. Anything else maps
  // to `platform_blocked` so the dispatcher's reason taxonomy stays
  // closed — there's no "unknown error" leak.
  app.onError((err, c) => {
    if (isServiceError(err)) {
      const status = err.status();
      // Hono's `c.json` overload requires `StatusCode`; the
      // `ServiceError.status()` outputs are all valid HTTP statuses.
      return c.json(err.toEnvelope(), status as Parameters<typeof c.json>[1]);
    }
    const fallback = new ServiceError(
      "platform_blocked",
      err instanceof Error ? err.message : String(err),
    );
    return c.json(fallback.toEnvelope(), fallback.status() as Parameters<typeof c.json>[1]);
  });

  return app;
}
