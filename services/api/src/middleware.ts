/**
 * Middleware registration: rate limiting, CORS, security headers, auth, error handling, health.
 *
 * Extracted from index.ts — registers all middleware on the Hono app in the correct order.
 */

import type { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import type { IdentityManager } from "@motebit/core-identity";
import { FixedWindowLimiter } from "./rate-limiter.js";
import type { verifySignedTokenForDevice, parseTokenPayloadUnsafe } from "./auth.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "middleware" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MiddlewareDeps {
  app: Hono;
  apiToken: string | undefined;
  corsOrigin: string;
  enableDeviceAuth: boolean;
  identityManager: IdentityManager;
  getEmergencyFreeze: () => boolean;
  getFreezeReason: () => string | null;
  isTokenBlacklisted: (jti: string, motebitId: string) => boolean;
  isAgentRevoked: (motebitId: string) => boolean;
  verifySignedTokenForDevice: typeof verifySignedTokenForDevice;
  parseTokenPayloadUnsafe: typeof parseTokenPayloadUnsafe;
}

export interface MiddlewareResult {
  allLimiters: FixedWindowLimiter[];
  wsLimiter: FixedWindowLimiter;
}

// ---------------------------------------------------------------------------
// Helpers (used by middleware and exported for other modules)
// ---------------------------------------------------------------------------

/**
 * Extract client IP. Uses the rightmost non-private IP from x-forwarded-for
 * to resist spoofing — the rightmost entry is set by the closest trusted proxy.
 * Falls back to x-real-ip or "unknown" for direct connections.
 */
export function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const ips = xff.split(",").map((ip) => ip.trim());
    // Rightmost IP is set by the trusted reverse proxy (Vercel/Cloudflare)
    return ips[ips.length - 1] ?? "unknown";
  }
  return c.req.header("x-real-ip") ?? "unknown";
}

export function isMasterToken(
  c: { req: { header: (name: string) => string | undefined } },
  apiToken: string | undefined,
): boolean {
  if (apiToken == null || apiToken === "") return false;
  const authHeader = c.req.header("authorization");
  return authHeader != null && authHeader === `Bearer ${apiToken}`;
}

/**
 * Factory: creates a Hono middleware that enforces a FixedWindowLimiter per client IP.
 * Master-token requests bypass rate limiting.
 */
export function rateLimitMiddleware(limiter: FixedWindowLimiter, apiToken: string | undefined) {
  return async (
    c: Parameters<Parameters<Hono["use"]>[1]>[0],
    next: () => Promise<void>,
  ): Promise<Response | void> => {
    // Master token bypasses rate limiting
    if (isMasterToken(c, apiToken)) {
      await next();
      return;
    }

    const ip = getClientIp(c);
    const { allowed, remaining, resetAt } = limiter.check(ip);
    const retryAfterSeconds = Math.ceil((resetAt - Date.now()) / 1000);

    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));

    if (!allowed) {
      c.header("Retry-After", String(retryAfterSeconds));
      return c.json({ error: "Rate limit exceeded", retry_after: retryAfterSeconds }, 429);
    }

    await next();
  };
}

// ---------------------------------------------------------------------------
// dualAuth — accepts either the master API token OR a valid Ed25519 signed device token.
// ---------------------------------------------------------------------------

/**
 * dualAuth — accepts either the master API token OR a valid Ed25519 signed device token.
 * Used by task submission so agents can delegate to each other without knowing the master token.
 * Sets c.set("callerMotebitId") on the context when a signed device token is used.
 * @param expectedAudience — audience claim to enforce on signed tokens (cross-endpoint replay prevention)
 */
export function createDualAuth(deps: MiddlewareDeps) {
  return async function dualAuth(
    c: Parameters<Parameters<Hono["use"]>[1]>[0],
    next: () => Promise<void>,
    expectedAudience: string,
  ): Promise<Response | void> {
    const authHeader = c.req.header("authorization");
    if (authHeader == null || !authHeader.startsWith("Bearer ")) {
      throw new HTTPException(401, { message: "Missing authorization" });
    }
    const token = authHeader.slice(7);

    // Master token bypass — log for audit trail (distinguishes admin from agent auth)
    if (deps.apiToken != null && deps.apiToken !== "" && token === deps.apiToken) {
      logger.info("auth.master_token", {
        correlationId: c.req.header("x-correlation-id") ?? "none",
        method: c.req.method,
        path: new URL(c.req.url, "http://localhost").pathname,
        ip: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown",
      });
      await next();
      return;
    }

    // Signed device token path
    const claims = deps.parseTokenPayloadUnsafe(token);
    if (!claims?.mid) {
      throw new HTTPException(401, { message: "Invalid token" });
    }
    const valid = await deps.verifySignedTokenForDevice(
      token,
      claims.mid,
      deps.identityManager,
      expectedAudience,
      deps.isTokenBlacklisted,
      deps.isAgentRevoked,
    );
    if (!valid) {
      throw new HTTPException(401, { message: "Token verification failed" });
    }

    c.set("callerMotebitId" as never, claims.mid as never);
    await next();
  };
}

// ---------------------------------------------------------------------------
// registerMiddleware — wire up all middleware on the app
// ---------------------------------------------------------------------------

export function registerMiddleware(deps: MiddlewareDeps): MiddlewareResult {
  const { app, apiToken, corsOrigin, enableDeviceAuth } = deps;

  // --- Security & CORS ---
  app.use("*", secureHeaders());
  app.use("*", cors({ origin: corsOrigin }));

  // --- Emergency freeze: block all state-mutating operations ---
  app.use("*", async (c, next) => {
    if (!deps.getEmergencyFreeze()) return next();

    // Allow reads
    if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
      return next();
    }

    // Allow health check and admin freeze toggle (must be reachable while frozen)
    if (
      c.req.path === "/health" ||
      c.req.path === "/api/v1/admin/freeze" ||
      c.req.path === "/api/v1/admin/unfreeze"
    ) {
      return next();
    }

    throw new HTTPException(503, {
      message: "Relay is in emergency freeze mode — all write operations are suspended",
    });
  });

  // --- Correlation ID middleware ---
  app.use("*", async (c, next) => {
    const correlationId = c.req.header("x-correlation-id") ?? crypto.randomUUID();
    c.set("correlationId" as never, correlationId as never);
    c.header("X-Correlation-ID", correlationId);
    await next();
  });

  // --- Rate Limiter Instances ---
  const authLimiter = new FixedWindowLimiter(30, 60_000); // 30 req/min
  const readLimiter = new FixedWindowLimiter(60, 60_000); // 60 req/min
  const writeLimiter = new FixedWindowLimiter(30, 60_000); // 30 req/min
  const publicLimiter = new FixedWindowLimiter(20, 60_000); // 20 req/min
  const expensiveLimiter = new FixedWindowLimiter(10, 60_000); // 10 req/min
  const wsLimiter = new FixedWindowLimiter(100, 10_000); // 100 msg/10s per connection
  const allLimiters = [
    authLimiter,
    readLimiter,
    writeLimiter,
    publicLimiter,
    expensiveLimiter,
    wsLimiter,
  ];

  const rl = (limiter: FixedWindowLimiter) => rateLimitMiddleware(limiter, apiToken);

  // --- Rate Limit Route Bindings ---

  // Auth endpoints: register, heartbeat (30 req/min)
  app.use("/api/v1/agents/register", rl(authLimiter));
  app.use("/api/v1/agents/heartbeat", rl(authLimiter));
  app.use("/api/v1/agents/deregister", rl(authLimiter));
  app.use("/api/v1/agents/:motebitId/rotate-key", rl(writeLimiter));
  app.use("/api/v1/agents/:motebitId/succession", rl(readLimiter));

  // Credential submission: write-rate (peers push collected credentials for relay indexing)
  app.use("/api/v1/agents/:motebitId/credentials/submit", rl(writeLimiter));

  // Read endpoints: discover, credentials, capabilities, listings (60 req/min)
  app.use("/api/v1/agents/discover", rl(readLimiter));
  app.use("/api/v1/agents/:motebitId/credentials", rl(readLimiter));
  app.use("/api/v1/agents/:motebitId/listing", rl(readLimiter));
  app.use("/agent/:motebitId/capabilities", rl(readLimiter));
  app.use("/agent/:motebitId/settlements", rl(readLimiter));
  app.use("/api/v1/agents/:motebitId/trust-closure", rl(readLimiter));
  app.use("/api/v1/agents/:motebitId/path-to/*", rl(readLimiter));
  app.use("/api/v1/agents/:motebitId/graph", rl(readLimiter));
  app.use("/api/v1/agents/:motebitId/routing-explanation", rl(readLimiter));

  // Virtual account endpoints (write: deposit/withdraw, read: balance/withdrawals)
  app.use("/api/v1/agents/:motebitId/deposit", rl(writeLimiter));
  app.use("/api/v1/agents/:motebitId/withdraw", rl(writeLimiter));
  app.use("/api/v1/agents/:motebitId/balance", rl(readLimiter));
  app.use("/api/v1/agents/:motebitId/withdrawals", rl(readLimiter));
  app.use("/api/v1/agents/:motebitId/checkout", rl(writeLimiter));
  app.use("/api/v1/stripe/webhook", rl(publicLimiter));
  app.use("/api/v1/admin/withdrawals/*", rl(writeLimiter));
  app.use("/api/v1/admin/reconciliation", rl(expensiveLimiter));
  app.use("/api/v1/admin/freeze", rl(writeLimiter));
  app.use("/api/v1/admin/unfreeze", rl(writeLimiter));

  // Write endpoints: task submission, result, ledger (30 req/min)
  app.use("/agent/:motebitId/task", rl(writeLimiter));
  app.use("/agent/:motebitId/task/:taskId/result", rl(writeLimiter));
  app.use("/agent/:motebitId/ledger", rl(writeLimiter));

  // Public endpoints: credential verification, credential status (20 req/min)
  app.use("/api/v1/credentials/verify", rl(publicLimiter));
  app.use("/api/v1/credentials/:credentialId/status", rl(publicLimiter));
  app.use("/api/v1/credentials/batch-status", rl(readLimiter));

  // Write endpoints: revocation (30 req/min)
  app.use("/api/v1/agents/:motebitId/revoke-tokens", rl(writeLimiter));
  app.use("/api/v1/agents/:motebitId/revoke-credential", rl(writeLimiter));
  app.use("/api/v1/agents/:motebitId/revoke", rl(writeLimiter));

  // Approval quorum endpoints (write tier for votes, read tier for status)
  app.use("/api/v1/agents/:motebitId/approvals/:approvalId/vote", rl(writeLimiter));
  app.use("/api/v1/agents/:motebitId/approvals/:approvalId", rl(readLimiter));

  // Expensive endpoints: presentation bundling, bootstrap (10 req/min)
  app.use("/api/v1/agents/:motebitId/presentation", rl(expensiveLimiter));
  app.use("/api/v1/agents/bootstrap", rl(expensiveLimiter));

  // Federation peering endpoints (30 req/min per IP — write tier)
  // POST handlers also enforce per-peer rate limiting (30 req/min per relay_id) in federation.ts
  app.use("/federation/v1/peer/*", rl(writeLimiter));

  // Federation discovery (60 req/min per IP — read tier, plus per-peer in federation.ts)
  app.use("/federation/v1/discover", rl(readLimiter));

  // Federation task routing (30 req/min per IP — write tier, plus per-peer in federation.ts)
  app.use("/federation/v1/task/*", rl(writeLimiter));

  // Federation settlement endpoints (Phase 5, plus per-peer in federation.ts)
  app.use("/federation/v1/settlement/*", rl(writeLimiter));
  app.use("/federation/v1/settlements", rl(readLimiter));

  // --- Bearer auth for admin/query routes (master API token) ---
  if (apiToken != null && apiToken !== "") {
    app.use("/identity/*", bearerAuth({ token: apiToken }));
    app.use("/identity", bearerAuth({ token: apiToken }));
    // Device registration is protected by the master token
    app.use("/device/*", bearerAuth({ token: apiToken }));
    // Admin query endpoints — interior state is not public surface
    app.use("/api/v1/state/*", bearerAuth({ token: apiToken }));
    app.use("/api/v1/memory/*", bearerAuth({ token: apiToken }));
    app.use("/api/v1/audit/*", bearerAuth({ token: apiToken }));
    app.use("/api/v1/goals/*", bearerAuth({ token: apiToken }));
    app.use("/api/v1/conversations/*", bearerAuth({ token: apiToken }));
    app.use("/api/v1/plans/*", bearerAuth({ token: apiToken }));
    app.use("/api/v1/agent-trust/*", bearerAuth({ token: apiToken }));
    app.use("/api/v1/gradient/*", bearerAuth({ token: apiToken }));
    app.use("/api/v1/sync/*", bearerAuth({ token: apiToken }));
    app.use("/api/v1/execution/*", bearerAuth({ token: apiToken }));
  }

  // --- Device auth middleware for sync routes ---
  if (enableDeviceAuth) {
    app.use("/sync/*", async (c, next) => {
      const authHeader = c.req.header("authorization");
      if (authHeader == null || !authHeader.startsWith("Bearer ")) {
        throw new HTTPException(401, { message: "Missing device token" });
      }
      const token = authHeader.slice(7);

      // Master token bypass
      if (apiToken != null && apiToken !== "" && token === apiToken) {
        await next();
        return;
      }

      // Extract motebitId from URL path (/sync/:motebitId/...)
      const pathParts = new URL(c.req.url, "http://localhost").pathname.split("/");
      const motebitId = pathParts[2];
      if (motebitId == null || motebitId === "") {
        throw new HTTPException(400, { message: "Missing motebitId" });
      }

      if (!token.includes(".")) {
        // Legacy device tokens (plain UUIDs) are no longer accepted — signed JWTs only
        throw new HTTPException(401, {
          message: "Legacy device tokens are no longer accepted — use signed JWTs",
        });
      }

      // Signed token verification — O(1) lookup by device ID from token payload
      const verified = await deps.verifySignedTokenForDevice(
        token,
        motebitId,
        deps.identityManager,
        "sync",
        deps.isTokenBlacklisted,
        deps.isAgentRevoked,
      );
      if (!verified) {
        throw new HTTPException(403, { message: "Device not authorized for this motebit" });
      }
      await next();
    });
  } else if (apiToken != null && apiToken !== "") {
    // Legacy single-token auth for sync routes
    app.use("/sync/*", bearerAuth({ token: apiToken }));
  }

  // --- Catch-all /api/v1/* middleware ---
  if (apiToken != null && apiToken !== "") {
    // Agent registry routes use their own auth middleware (supports device tokens)
    app.use("/api/v1/*", async (c, next) => {
      if (
        c.req.path.startsWith("/api/v1/agents") ||
        c.req.path.startsWith("/api/v1/credentials/verify") ||
        c.req.path.startsWith("/api/v1/credentials/batch-status") ||
        c.req.path.match(/\/api\/v1\/credentials\/[^/]+\/status/) ||
        c.req.path.startsWith("/api/v1/stripe/") ||
        c.req.path.startsWith("/api/v1/subscriptions/")
      ) {
        await next();
        return;
      }
      const mw = bearerAuth({ token: apiToken });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance between middleware and handler signatures
      return mw(c as never, next);
    });
  }

  // --- Error handler ---
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message, status: err.status }, err.status);
    }
    console.error(err);
    return c.json({ error: "Internal server error", status: 500 }, 500);
  });

  // --- Health (public, no auth) ---
  app.get("/health", (c) =>
    c.json({
      status: deps.getEmergencyFreeze() ? "frozen" : "ok",
      frozen: deps.getEmergencyFreeze(),
      ...(deps.getEmergencyFreeze() && deps.getFreezeReason()
        ? { freeze_reason: deps.getFreezeReason() }
        : {}),
      timestamp: Date.now(),
    }),
  );

  return { allLimiters, wsLimiter };
}

// ---------------------------------------------------------------------------
// registerAuthMiddleware — task/budget/admin auth routes (must run after
// registerMiddleware but before route handlers that need dualAuth)
// ---------------------------------------------------------------------------

export function registerAuthMiddleware(deps: MiddlewareDeps): void {
  const { app, apiToken } = deps;
  const dualAuth = createDualAuth(deps);

  if (apiToken == null || apiToken === "") return;

  // POST /agent/:motebitId/task — submit a task (master token or signed device token)
  app.use("/agent/*/task", async (c, next) => {
    // Only apply auth to POST (submit) requests, not to /result sub-routes
    if (c.req.method === "POST" && !c.req.url.includes("/result")) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
      return dualAuth(c, next, "task:submit");
    }
    await next();
  });

  // Auth middleware for ledger and settlement routes — master token required
  app.use("/agent/*/ledger", bearerAuth({ token: apiToken }));
  app.use("/agent/*/ledger/*", bearerAuth({ token: apiToken }));
  app.use("/agent/*/settlements", bearerAuth({ token: apiToken }));

  // Auth middleware for virtual account routes — master token or signed device token
  app.use("/api/v1/agents/*/deposit", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
    return dualAuth(c, next, "account:deposit");
  });
  app.use("/api/v1/agents/*/balance", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
    return dualAuth(c, next, "account:balance");
  });
  app.use("/api/v1/agents/*/withdraw", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
    return dualAuth(c, next, "account:withdraw");
  });
  app.use("/api/v1/agents/*/withdrawals", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
    return dualAuth(c, next, "account:withdrawals");
  });
  app.use("/api/v1/agents/*/checkout", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
    return dualAuth(c, next, "account:checkout");
  });
  // Note: /api/v1/stripe/webhook has NO auth middleware — Stripe calls it directly.
  // Verification is done via the webhook signature.
  // Admin withdrawal management — master token only
  app.use("/api/v1/admin/withdrawals/*", bearerAuth({ token: apiToken }));
  // Admin reconciliation — master token only
  app.use("/api/v1/admin/reconciliation", bearerAuth({ token: apiToken }));
  // Admin emergency freeze — master token only
  app.use("/api/v1/admin/freeze", bearerAuth({ token: apiToken }));
  app.use("/api/v1/admin/unfreeze", bearerAuth({ token: apiToken }));
}
