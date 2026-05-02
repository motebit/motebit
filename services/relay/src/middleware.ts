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
import { requestContext, enrichRequestContext } from "./request-context.js";
import type { RequestContext } from "./request-context.js";
import { RelayError, RateLimitError, AuthenticationError, AuthorizationError } from "./errors.js";

const logger = createLogger({ service: "middleware" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Dependencies for readiness health checks — passed through from createSyncRelay. */
export interface HealthCheckDeps {
  /** Run a lightweight DB probe (SELECT 1). Returns latency in ms, or throws on failure. */
  dbProbe: () => number;
  /** Current task queue size. */
  getTaskQueueSize: () => number;
  /** Hard cap on task queue. */
  taskQueueCapacity: number;
  /** Whether the relay is draining (graceful shutdown in progress). */
  isDraining: () => boolean;
  /**
   * Registered settlement rail manifest (name, type, deposit support).
   * Pure metadata — no network probes. Operators use this to spot silent
   * misconfiguration (env var missing → rail not registered).
   */
  getRailManifest?: () => ReadonlyArray<{
    name: string;
    custody: "relay";
    railType: "fiat" | "protocol" | "orchestration";
    supportsDeposit: boolean;
  }>;
}

export interface MiddlewareDeps {
  app: Hono;
  apiToken: string | undefined;
  corsOrigin: string;
  enableDeviceAuth: boolean;
  identityManager: IdentityManager;
  getEmergencyFreeze: () => boolean;
  getFreezeReason: () => string | null;
  getShuttingDown?: () => boolean;
  getConnectionCount?: () => number;
  isDraining?: () => boolean;
  isTokenBlacklisted: (jti: string, motebitId: string) => boolean;
  isAgentRevoked: (motebitId: string) => boolean;
  verifySignedTokenForDevice: typeof verifySignedTokenForDevice;
  parseTokenPayloadUnsafe: typeof parseTokenPayloadUnsafe;
  healthCheckDeps?: HealthCheckDeps;
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

    c.header("X-RateLimit-Limit", String(limiter.limit));
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
      throw new AuthenticationError("AUTH_MISSING_TOKEN", "Missing authorization");
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
      throw new AuthenticationError("AUTH_INVALID_TOKEN", "Invalid token");
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
      throw new AuthenticationError("AUTH_INVALID_TOKEN", "Token verification failed");
    }

    c.set("callerMotebitId" as never, claims.mid as never);
    enrichRequestContext({ motebitId: claims.mid });
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

    // Allow health checks and admin freeze toggle (must be reachable while frozen)
    if (
      c.req.path === "/health" ||
      c.req.path === "/health/live" ||
      c.req.path === "/health/ready" ||
      c.req.path === "/api/v1/admin/freeze" ||
      c.req.path === "/api/v1/admin/unfreeze"
    ) {
      return next();
    }

    throw new HTTPException(503, {
      message: "Relay is in emergency freeze mode — all write operations are suspended",
    });
  });

  // --- Request context (AsyncLocalStorage) + Correlation ID middleware ---
  app.use("*", async (c, next) => {
    const correlationId = c.req.header("x-correlation-id") ?? crypto.randomUUID();
    c.set("correlationId" as never, correlationId as never);
    c.header("X-Correlation-ID", correlationId);
    const ctx: RequestContext = {
      correlationId,
      startedAt: Date.now(),
      method: c.req.method,
      path: c.req.path,
    };
    return requestContext.run(ctx, () => next());
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
  // Self-attesting device registration (spec/device-self-registration-v1.md):
  // auth-less endpoint, signature is the auth — same authLimiter tier as the
  // master-token-protected /agents/register, so a flood of signed-but-zero-trust
  // registrations can't outpace legitimate device bootstrap.
  app.use("/api/v1/devices/register-self", rl(authLimiter));
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
  app.use("/api/v1/agents/:motebitId/solvency-proof", rl(readLimiter));
  app.use("/api/v1/agents/:motebitId/withdrawals", rl(readLimiter));
  app.use("/api/v1/agents/:motebitId/checkout", rl(writeLimiter));
  app.use("/api/v1/stripe/webhook", rl(publicLimiter));
  app.use("/api/v1/bridge/webhook", rl(publicLimiter));
  app.use("/api/v1/admin/withdrawals/*", rl(writeLimiter));
  app.use("/api/v1/admin/reconciliation", rl(expensiveLimiter));
  app.use("/api/v1/admin/freeze", rl(writeLimiter));
  app.use("/api/v1/admin/unfreeze", rl(writeLimiter));
  app.use("/api/v1/admin/freeze-status", rl(readLimiter));

  // Write endpoints: task submission, result, ledger (30 req/min)
  app.use("/agent/:motebitId/task", rl(writeLimiter));
  app.use("/agent/:motebitId/task/:taskId/result", rl(writeLimiter));
  app.use("/agent/:motebitId/ledger", rl(writeLimiter));

  // Public endpoints: credential verification, credential status (20 req/min)
  app.use("/api/v1/credentials/verify", rl(publicLimiter));
  app.use("/api/v1/credentials/:credentialId/status", rl(publicLimiter));
  app.use("/api/v1/credentials/batch-status", rl(readLimiter));

  // Skills registry (spec/skills-registry-v1.md): submit is write-tier
  // (signature verification + sha256 over body + per-file hashes is the
  // expensive part), discover/resolve are read-tier.
  app.use("/api/v1/skills/submit", rl(writeLimiter));
  app.use("/api/v1/skills/discover", rl(readLimiter));
  app.use("/api/v1/skills/:submitter/:name/:version", rl(readLimiter));

  // Public anchor proof endpoints — auditor flood protection without auth
  // gating (CLAUDE.md rule 6). Same publicLimiter tier as credential status.
  app.use("/api/v1/credentials/:credentialId/anchor-proof", rl(publicLimiter));
  app.use("/api/v1/credential-anchors/:batchId", rl(publicLimiter));
  app.use("/api/v1/settlements/:settlementId/anchor-proof", rl(publicLimiter));
  app.use("/api/v1/settlement-anchors/:batchId", rl(publicLimiter));

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

  // Discovery endpoints (discovery-v1.md)
  app.use("/.well-known/motebit.json", rl(publicLimiter));
  app.use("/api/v1/discover/*", rl(readLimiter));

  // Dispute endpoints (dispute-v1.md)
  app.use("/api/v1/allocations/*/dispute", rl(writeLimiter));
  app.use("/api/v1/disputes/*/evidence", rl(writeLimiter));
  app.use("/api/v1/disputes/*/resolve", rl(writeLimiter));
  app.use("/api/v1/disputes/*/appeal", rl(writeLimiter));
  app.use("/api/v1/disputes/*", rl(readLimiter));

  // Admin endpoints — dispute + settlement + credential-anchoring + transparency dashboards
  app.use("/api/v1/admin/disputes", rl(expensiveLimiter));
  app.use("/api/v1/admin/settlements", rl(expensiveLimiter));
  app.use("/api/v1/admin/fees", rl(expensiveLimiter));
  app.use("/api/v1/admin/health", rl(expensiveLimiter));
  app.use("/api/v1/admin/transparency", rl(expensiveLimiter));
  app.use("/api/v1/admin/credential-anchoring", rl(expensiveLimiter));
  app.use("/api/v1/admin/receipts/*", rl(expensiveLimiter));
  app.use("/api/v1/admin/pending-withdrawals", rl(expensiveLimiter));

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
        throw new AuthenticationError("AUTH_MISSING_TOKEN", "Missing device token");
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
        throw new AuthenticationError(
          "AUTH_LEGACY_TOKEN",
          "Legacy device tokens are no longer accepted — use signed JWTs",
        );
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
        throw new AuthorizationError(
          "AUTHZ_DEVICE_NOT_AUTHORIZED",
          "Device not authorized for this motebit",
        );
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
        // Self-attesting device registration is auth-less by design — the
        // request's signature IS the auth (spec/device-self-registration-v1.md).
        // The handler verifies the signature against the public key carried
        // in the request body itself.
        c.req.path === "/api/v1/devices/register-self" ||
        c.req.path.startsWith("/api/v1/credentials/verify") ||
        c.req.path.startsWith("/api/v1/credentials/batch-status") ||
        c.req.path.match(/\/api\/v1\/credentials\/[^/]+\/status/) ||
        // Anchor proof endpoints are public protocol artifacts (services/relay
        // CLAUDE.md rule 6 — every truth the relay asserts is independently
        // verifiable onchain without relay contact). An external auditor
        // will not hold a relay-issued bearer token.
        c.req.path.match(/\/api\/v1\/credentials\/[^/]+\/anchor-proof/) ||
        c.req.path.startsWith("/api/v1/credential-anchors/") ||
        c.req.path.match(/\/api\/v1\/settlements\/[^/]+\/anchor-proof/) ||
        c.req.path.startsWith("/api/v1/settlement-anchors/") ||
        c.req.path.startsWith("/api/v1/stripe/") ||
        c.req.path.startsWith("/api/v1/bridge/") ||
        c.req.path.startsWith("/api/v1/subscriptions/") ||
        c.req.path.startsWith("/api/v1/onramp/") ||
        c.req.path.startsWith("/api/v1/discover/") ||
        c.req.path.startsWith("/api/v1/allocations/") ||
        c.req.path.startsWith("/api/v1/disputes/") ||
        // Skills registry (spec/skills-registry-v1.md §5): permissive-by-
        // signature on submit, public-read on discover/resolve. The submit
        // handler verifies the envelope signature itself — that IS the auth
        // (mirrors /api/v1/devices/register-self above).
        c.req.path.startsWith("/api/v1/skills/")
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
    if (err instanceof RelayError) {
      const status = err.statusCode as 400;
      if (err instanceof RateLimitError) {
        c.header("Retry-After", String(err.retryAfter));
      }
      return c.json({ error: err.message, code: err.code, status: err.statusCode }, status);
    }
    if (err instanceof HTTPException) {
      return c.json({ error: err.message, status: err.status }, err.status);
    }
    console.error(err);
    return c.json({ error: "Internal server error", status: 500 }, 500);
  });

  // --- Health (public, no auth, no rate limiting) ---
  const startTime = Date.now();
  const uptimeSeconds = () => Math.floor((Date.now() - startTime) / 1000);

  // GET /health — backward compatible
  /** @internal */
  app.get("/health", (c) => {
    const isDraining =
      deps.healthCheckDeps?.isDraining() ??
      deps.isDraining?.() ??
      deps.getShuttingDown?.() ??
      false;
    const status = isDraining ? 503 : 200;
    return c.json(
      {
        status: deps.getEmergencyFreeze() ? "frozen" : isDraining ? "draining" : "ok",
        frozen: deps.getEmergencyFreeze(),
        ...(deps.getEmergencyFreeze() && deps.getFreezeReason()
          ? { freeze_reason: deps.getFreezeReason() }
          : {}),
        ...(isDraining ? { draining: true } : {}),
        ...(deps.getConnectionCount != null ? { ws_connections: deps.getConnectionCount() } : {}),
        timestamp: Date.now(),
      },
      status,
    );
  });

  // GET /health/live — liveness probe (always 200 if process is running)
  /** @internal */
  app.get("/health/live", (c) => c.json({ status: "alive", uptime_s: uptimeSeconds() }));

  // GET /health/ready — readiness probe with dependency checks
  /** @internal */
  app.get("/health/ready", (c) => {
    const hd = deps.healthCheckDeps;
    if (!hd) {
      return c.json({ status: "ready", uptime_s: uptimeSeconds(), checks: {} });
    }

    // Database check (SELECT 1 with implicit timeout from SQLite)
    let dbStatus: "ok" | "degraded" | "fail" = "fail";
    let dbLatencyMs = 0;
    let dbError: string | undefined;
    try {
      dbLatencyMs = hd.dbProbe();
      if (dbLatencyMs < 1000) dbStatus = "ok";
      else if (dbLatencyMs < 5000) dbStatus = "degraded";
      else dbStatus = "fail";
    } catch (err) {
      dbStatus = "fail";
      dbError = err instanceof Error ? err.message : String(err);
    }

    // Emergency freeze (informational — always "ok")
    const frozen = deps.getEmergencyFreeze();

    // Shutdown / draining
    const draining = hd.isDraining();
    const shutdownStatus: "ok" | "fail" = draining ? "fail" : "ok";

    // Task queue capacity
    const queueSize = hd.getTaskQueueSize();
    const queueCapacity = hd.taskQueueCapacity;
    const queueUtilization = queueCapacity > 0 ? queueSize / queueCapacity : 0;
    let taskQueueStatus: "ok" | "degraded" | "fail" = "ok";
    if (queueUtilization >= 1) taskQueueStatus = "fail";
    else if (queueUtilization >= 0.8) taskQueueStatus = "degraded";

    // Overall status
    const allStatuses = [dbStatus, shutdownStatus, taskQueueStatus];
    let overallStatus: "ready" | "degraded" | "not_ready" = "ready";
    if (allStatuses.includes("fail") || draining) overallStatus = "not_ready";
    else if (allStatuses.includes("degraded")) overallStatus = "degraded";

    const httpStatus = overallStatus === "ready" ? 200 : 503;

    // Settlement rail manifest — registered rails only, no network probe.
    // Operators use this to confirm expected rails are wired; missing rails
    // here reveal env-var gaps that would otherwise surface as silent 503s.
    const rails = hd.getRailManifest ? hd.getRailManifest() : [];

    return c.json(
      {
        status: overallStatus,
        uptime_s: uptimeSeconds(),
        checks: {
          database: {
            status: dbStatus,
            latency_ms: dbLatencyMs,
            ...(dbError ? { error: dbError } : {}),
          },
          emergency_freeze: { status: "ok" as const, frozen },
          shutdown: { status: shutdownStatus, draining },
          task_queue: {
            status: taskQueueStatus,
            size: queueSize,
            capacity: queueCapacity,
          },
          settlement_rails: {
            status: "ok" as const,
            count: rails.length,
            rails,
          },
        },
      },
      httpStatus,
    );
  });

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
  app.use("/api/v1/admin/freeze-status", bearerAuth({ token: apiToken }));
  // Admin dispute + settlement + credential-anchoring + fees + transparency dashboards — master token only
  app.use("/api/v1/admin/disputes", bearerAuth({ token: apiToken }));
  app.use("/api/v1/admin/settlements", bearerAuth({ token: apiToken }));
  app.use("/api/v1/admin/fees", bearerAuth({ token: apiToken }));
  app.use("/api/v1/admin/health", bearerAuth({ token: apiToken }));
  app.use("/api/v1/admin/transparency", bearerAuth({ token: apiToken }));
  app.use("/api/v1/admin/credential-anchoring", bearerAuth({ token: apiToken }));
  // Admin receipt audit — master token only; serves byte-identical
  // canonical JSON so an auditor can re-verify the signature offline.
  app.use("/api/v1/admin/receipts/*", bearerAuth({ token: apiToken }));
  // Admin aggregated-withdrawal queue summary — master token only.
  app.use("/api/v1/admin/pending-withdrawals", bearerAuth({ token: apiToken }));
  // Admin federation signing oracles (peer-removal-signature today; future
  // siblings under the same namespace) — master token only. The signature
  // shape is unauthenticated-replayable, so the oracle is admin-only.
  app.use("/api/v1/admin/federation/*", bearerAuth({ token: apiToken }));
}
