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
import {
  type TokenAudience,
  TASK_SUBMIT_AUDIENCE,
  BROWSER_SANDBOX_GRANT_AUDIENCE,
  ACCOUNT_BALANCE_AUDIENCE,
  ACCOUNT_WITHDRAW_AUDIENCE,
  ACCOUNT_WITHDRAWALS_AUDIENCE,
  ACCOUNT_CHECKOUT_AUDIENCE,
  MARKET_QUERY_AUDIENCE,
} from "@motebit/protocol";
import { FixedWindowLimiter } from "./rate-limiter.js";
import type { verifySignedTokenForDevice, parseTokenPayloadUnsafe } from "./auth.js";
import { createLogger } from "./logger.js";
import type { AuthEvent } from "./auth-events.js";
import { requestContext, enrichRequestContext } from "./request-context.js";
import type { RequestContext } from "./request-context.js";
import {
  RelayError,
  RateLimitError,
  AuthenticationError,
  AuthorizationError,
  InsufficientFundsError,
  P2pProofAlreadyAdmittedError,
  X402OutcomeUnknownError,
  X402PaymentReplayedError,
  EmergencyFrozenError,
} from "./errors.js";
import { isEmergencyFrozenAbort } from "./freeze.js";
import {
  CALLER_VERIFIED_KEY,
  recordMasterTokenOnce,
  recordRefusalBeforeVerify,
} from "./auth-events.js";
import { pathIdentity } from "./id-bounds.js";
import { SYNC_PRESENTER_KEY } from "./identity-binding.js";

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
  /**
   * Release a claimed-but-uncompleted idempotency key when a handler
   * throws after claiming it (#459) — wired by index.ts to
   * `releaseIdempotency`. The claiming handler stamps ownership via
   * `c.set("idempotencyClaim", …)`; the error boundary calls this so a
   * failed submission never strands its key in 'processing'.
   */
  releaseIdempotencyClaim?: (key: string, motebitId: string) => void;
  /**
   * Durable auth-event record (auth-events.ts): every master-token
   * presentation and every refused signed token, so posture is proven from a
   * record the relay keeps rather than a log tail. Optional so hand-built
   * test deps still compile; production always wires it.
   */
  recordAuthEvent?: (event: AuthEvent) => void;
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
    expectedAudience: TokenAudience,
  ): Promise<Response | void> {
    const authHeader = c.req.header("authorization");
    if (authHeader == null || !authHeader.startsWith("Bearer ")) {
      recordRefusalBeforeVerify(c, deps.recordAuthEvent, {
        kind: "device_token_rejected",
        audience: expectedAudience,
        reason: "missing_token",
      });
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
      recordMasterTokenOnce(c, deps.recordAuthEvent, {
        method: c.req.method,
        path: new URL(c.req.url, "http://localhost").pathname,
        correlationId: c.req.header("x-correlation-id") ?? null,
      });
      await next();
      return;
    }

    // Signed device token path
    const claims = deps.parseTokenPayloadUnsafe(token);
    if (!claims?.mid) {
      recordRefusalBeforeVerify(c, deps.recordAuthEvent, {
        kind: "device_token_rejected",
        audience: expectedAudience,
        reason: "unparseable_token",
      });
      throw new AuthenticationError("AUTH_INVALID_TOKEN", "Invalid token");
    }
    let verifiedKey: string | undefined;
    const valid = await deps.verifySignedTokenForDevice(
      token,
      claims.mid,
      deps.identityManager,
      expectedAudience,
      deps.isTokenBlacklisted,
      deps.isAgentRevoked,
      undefined,
      // Rejection legibility (#460): a device-auth 401 previously left ZERO
      // server-side trace (witnessed live 2026-07-29 — undiagnosable from
      // the operator seat). Log the structured reason; never the token.
      (reason) => {
        logger.warn("auth.device_token_rejected", {
          correlationId: c.req.header("x-correlation-id") ?? "none",
          reason,
          expectedAudience,
          mid: claims.mid,
          path: new URL(c.req.url, "http://localhost").pathname,
        });
        deps.recordAuthEvent?.({
          kind: "device_token_rejected",
          method: c.req.method,
          path: new URL(c.req.url, "http://localhost").pathname,
          motebitId: claims.mid,
          audience: expectedAudience,
          reason,
          correlationId: c.req.header("x-correlation-id") ?? null,
        });
      },
      // The key the token verified under, from the verifier's own read: a
      // P2P submission's payer must derive from it (#918, p2p-payer.ts).
      (publicKey) => {
        verifiedKey = publicKey;
      },
    );
    if (!valid) {
      throw new AuthenticationError("AUTH_INVALID_TOKEN", "Token verification failed");
    }

    c.set("callerMotebitId" as never, claims.mid as never);
    if (verifiedKey != null) c.set(CALLER_VERIFIED_KEY, verifiedKey as never);
    enrichRequestContext({ motebitId: claims.mid });
    await next();
  };
}

/**
 * Response headers a cross-origin BROWSER client must be able to read.
 *
 * A browser (and the Tauri webview's global `fetch`) hands page JS only the
 * CORS-safelisted response headers (Cache-Control, Content-Language,
 * Content-Length, Content-Type, Expires, Last-Modified, Pragma) unless the
 * response names the rest in `Access-Control-Expose-Headers`. Anything else
 * reads as `null` — no error, just absence. React Native's fetch is not a
 * browser and sees everything, so a header can work on mobile and silently
 * vanish on web and desktop.
 *
 * The list is every header this relay sets that a browser-run client reads:
 *   - `Retry-After` — the 429 back-off bound (rate limiter, RateLimitError,
 *     intake). Read by the roster clients (apps/web, apps/desktop
 *     `machine-roster.ts`) and `@motebit/runtime` `relay-delegation.ts`
 *     (`classifyRelayError`).
 *   - `X-Motebit-Content-Manifest` — the signed state-export manifest
 *     (`state-export.ts`), read by `@motebit/state-export-client`
 *     (`verified-fetch.ts`) in desktop and the inspector; unexposed, every
 *     browser verification reads "no manifest".
 * A new header a browser client reads is added here in the same change.
 */
export const CORS_EXPOSED_RESPONSE_HEADERS = ["Retry-After", "X-Motebit-Content-Manifest"] as const;

// ---------------------------------------------------------------------------
// Master-token carve-outs — the routes the /api/v1/* catch-all lets through
// ---------------------------------------------------------------------------

/** A method a carve-out names. `HEAD` is served by the `GET` handler, so a `GET` entry covers it. */
export type CarveOutMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface MasterTokenCarveOut {
  method: CarveOutMethod;
  /**
   * The route pattern EXACTLY as the route is registered (`app.get(path, …)`):
   * literal segments and `:param` segments only. It is matched anchored, as a
   * whole, against `c.req.path` — the path Hono's router dispatches on.
   */
  path: string;
  /** What authenticates the route instead of the master token. */
  auth: string;
}

const AGENT_ROUTE_AUTH =
  "registerAgentAuthMiddleware (agents.ts): a device token for the RELAY_ROUTE_AUDIENCES audience, or a PUBLIC_AGENT_ROUTES self-authenticating route";
const PUBLIC_ARTIFACT =
  "public protocol artifact (services/relay CLAUDE.md rule 6): an external verifier holds no relay token";
const SIGNATURE_IS_AUTH = "self-attesting: the handler verifies the request's own signature";
const USER_INITIATED_RAMP =
  "user-initiated ramp session: the user is the ramp provider's customer, not a relay-token holder (off-ramp-as-user-action.md)";
const DISPUTE_PARTY =
  "dispute party's signed filing / evidence / appeal, or a public read (spec/dispute-v1.md)";
const SKILLS_REGISTRY =
  "skills registry (spec/skills-registry-v1.md §5): signed envelope on submit, public read";
const SUBSCRIPTION_OWNER =
  "registerAuthMiddleware: account:checkout device token or the master token (#846)";

/**
 * The /api/v1/* master-token catch-all (registerMiddleware) exempts EXACTLY
 * these routes, each one method and one registered route pattern, matched
 * anchored against the routed path (#855). A prefix or unanchored carve-out
 * reached routes it was never meant to: `startsWith("/api/v1/credentials/verify")`
 * let `POST /api/v1/credentials/verify/reputation` skip the master token and
 * reach `POST /api/v1/credentials/:motebitId/reputation` with the id `verify`.
 *
 * A new /api/v1 route is master-only until it is added here. Adding one is a
 * reviewed decision: name what authenticates it instead. The gate
 * `check-master-token-carve-outs` proves every entry names a registered route
 * and reaches no other; `master-token-carve-outs-855.test.ts` proves it against
 * the running relay.
 */
export const MASTER_TOKEN_CARVE_OUTS: ReadonlyArray<MasterTokenCarveOut> = [
  // --- Agent registry: its own fail-closed middleware (agents.ts) ---
  { method: "POST", path: "/api/v1/agents/register", auth: AGENT_ROUTE_AUTH },
  { method: "POST", path: "/api/v1/agents/bootstrap", auth: AGENT_ROUTE_AUTH },
  { method: "POST", path: "/api/v1/agents/heartbeat", auth: AGENT_ROUTE_AUTH },
  { method: "DELETE", path: "/api/v1/agents/deregister", auth: AGENT_ROUTE_AUTH },
  { method: "GET", path: "/api/v1/agents/discover", auth: AGENT_ROUTE_AUTH },
  { method: "GET", path: "/api/v1/agents/revocations", auth: AGENT_ROUTE_AUTH },
  { method: "POST", path: "/api/v1/agents/push-token", auth: AGENT_ROUTE_AUTH },
  { method: "DELETE", path: "/api/v1/agents/push-token", auth: AGENT_ROUTE_AUTH },
  { method: "POST", path: "/api/v1/agents/accept-migration", auth: AGENT_ROUTE_AUTH },
  { method: "GET", path: "/api/v1/agents/:motebitId", auth: AGENT_ROUTE_AUTH },
  { method: "POST", path: "/api/v1/agents/:motebitId/approvals", auth: AGENT_ROUTE_AUTH },
  {
    method: "GET",
    path: "/api/v1/agents/:motebitId/approvals/:approvalId",
    auth: AGENT_ROUTE_AUTH,
  },
  {
    method: "POST",
    path: "/api/v1/agents/:motebitId/approvals/:approvalId/vote",
    auth: AGENT_ROUTE_AUTH,
  },
  { method: "GET", path: "/api/v1/agents/:motebitId/balance", auth: AGENT_ROUTE_AUTH },
  { method: "GET", path: "/api/v1/agents/:motebitId/bond", auth: AGENT_ROUTE_AUTH },
  { method: "POST", path: "/api/v1/agents/:motebitId/bond", auth: AGENT_ROUTE_AUTH },
  { method: "POST", path: "/api/v1/agents/:motebitId/checkout", auth: AGENT_ROUTE_AUTH },
  { method: "POST", path: "/api/v1/agents/:motebitId/command", auth: AGENT_ROUTE_AUTH },
  { method: "GET", path: "/api/v1/agents/:motebitId/credentials", auth: AGENT_ROUTE_AUTH },
  {
    method: "POST",
    path: "/api/v1/agents/:motebitId/credentials/submit",
    auth: AGENT_ROUTE_AUTH,
  },
  { method: "POST", path: "/api/v1/agents/:motebitId/debit", auth: AGENT_ROUTE_AUTH },
  {
    method: "POST",
    path: "/api/v1/agents/:motebitId/devices/:deviceId/hardware-attestation",
    auth: AGENT_ROUTE_AUTH,
  },
  { method: "GET", path: "/api/v1/agents/:motebitId/graph", auth: AGENT_ROUTE_AUTH },
  { method: "GET", path: "/api/v1/agents/:motebitId/listing", auth: AGENT_ROUTE_AUTH },
  { method: "POST", path: "/api/v1/agents/:motebitId/listing", auth: AGENT_ROUTE_AUTH },
  { method: "POST", path: "/api/v1/agents/:motebitId/migrate", auth: AGENT_ROUTE_AUTH },
  { method: "POST", path: "/api/v1/agents/:motebitId/migrate/cancel", auth: AGENT_ROUTE_AUTH },
  { method: "POST", path: "/api/v1/agents/:motebitId/migrate/depart", auth: AGENT_ROUTE_AUTH },
  {
    method: "GET",
    path: "/api/v1/agents/:motebitId/migration/attestation",
    auth: AGENT_ROUTE_AUTH,
  },
  {
    method: "GET",
    path: "/api/v1/agents/:motebitId/migration/export",
    auth: AGENT_ROUTE_AUTH,
  },
  { method: "GET", path: "/api/v1/agents/:motebitId/p2p-eligibility", auth: AGENT_ROUTE_AUTH },
  { method: "GET", path: "/api/v1/agents/:motebitId/path-to/:targetId", auth: AGENT_ROUTE_AUTH },
  { method: "POST", path: "/api/v1/agents/:motebitId/presentation", auth: AGENT_ROUTE_AUTH },
  { method: "POST", path: "/api/v1/agents/:motebitId/proxy-token", auth: AGENT_ROUTE_AUTH },
  { method: "GET", path: "/api/v1/agents/:motebitId/receipts", auth: AGENT_ROUTE_AUTH },
  { method: "GET", path: "/api/v1/agents/:motebitId/receipts/:taskId", auth: AGENT_ROUTE_AUTH },
  { method: "POST", path: "/api/v1/agents/:motebitId/restore-listing", auth: AGENT_ROUTE_AUTH },
  { method: "POST", path: "/api/v1/agents/:motebitId/revoke", auth: AGENT_ROUTE_AUTH },
  {
    method: "POST",
    path: "/api/v1/agents/:motebitId/revoke-credential",
    auth: AGENT_ROUTE_AUTH,
  },
  { method: "POST", path: "/api/v1/agents/:motebitId/revoke-listing", auth: AGENT_ROUTE_AUTH },
  { method: "POST", path: "/api/v1/agents/:motebitId/revoke-tokens", auth: AGENT_ROUTE_AUTH },
  { method: "GET", path: "/api/v1/agents/:motebitId/roster", auth: AGENT_ROUTE_AUTH },
  { method: "POST", path: "/api/v1/agents/:motebitId/roster", auth: AGENT_ROUTE_AUTH },
  { method: "POST", path: "/api/v1/agents/:motebitId/rotate-key", auth: AGENT_ROUTE_AUTH },
  {
    method: "GET",
    path: "/api/v1/agents/:motebitId/routing-explanation",
    auth: AGENT_ROUTE_AUTH,
  },
  { method: "GET", path: "/api/v1/agents/:motebitId/settlements", auth: AGENT_ROUTE_AUTH },
  { method: "GET", path: "/api/v1/agents/:motebitId/solvency-proof", auth: AGENT_ROUTE_AUTH },
  { method: "GET", path: "/api/v1/agents/:motebitId/succession", auth: AGENT_ROUTE_AUTH },
  { method: "PATCH", path: "/api/v1/agents/:motebitId/sweep-config", auth: AGENT_ROUTE_AUTH },
  { method: "GET", path: "/api/v1/agents/:motebitId/trust-closure", auth: AGENT_ROUTE_AUTH },
  { method: "POST", path: "/api/v1/agents/:motebitId/withdraw", auth: AGENT_ROUTE_AUTH },
  { method: "GET", path: "/api/v1/agents/:motebitId/withdrawals", auth: AGENT_ROUTE_AUTH },

  // --- Self-attesting intake: the request's signature IS the auth ---
  // spec/device-self-registration-v1.md; a first-launch motebit holds no
  // relay-issued bearer token (intake-routes.ts).
  { method: "POST", path: "/api/v1/devices/register-self", auth: SIGNATURE_IS_AUTH },
  { method: "POST", path: "/api/v1/motebits/announce", auth: SIGNATURE_IS_AUTH },

  // --- Credential verification + status: public verifier surface ---
  { method: "POST", path: "/api/v1/credentials/verify", auth: PUBLIC_ARTIFACT },
  { method: "POST", path: "/api/v1/credentials/batch-status", auth: PUBLIC_ARTIFACT },
  { method: "GET", path: "/api/v1/credentials/:credentialId/status", auth: PUBLIC_ARTIFACT },

  // --- Anchor proofs: independently verifiable onchain without relay contact ---
  {
    method: "GET",
    path: "/api/v1/credentials/:credentialId/anchor-proof",
    auth: PUBLIC_ARTIFACT,
  },
  { method: "GET", path: "/api/v1/credential-anchors/:batchId", auth: PUBLIC_ARTIFACT },
  {
    method: "GET",
    path: "/api/v1/settlements/:settlementId/anchor-proof",
    auth: PUBLIC_ARTIFACT,
  },
  { method: "GET", path: "/api/v1/settlement-anchors/:batchId", auth: PUBLIC_ARTIFACT },

  // --- Identity-transparency binding material (identity-binding-verification.md):
  // current key, self-signed succession chain, Merkle inclusion proof ---
  { method: "GET", path: "/api/v1/identity/:motebitId", auth: PUBLIC_ARTIFACT },

  // --- Payment-provider callbacks and user-initiated money sessions ---
  { method: "POST", path: "/api/v1/stripe/webhook", auth: "Stripe webhook signature" },
  {
    method: "POST",
    path: "/api/v1/subscriptions/webhook",
    auth: "Stripe webhook signature",
  },
  {
    method: "POST",
    path: "/api/v1/subscriptions/checkout",
    auth: "user-initiated Stripe checkout session",
  },
  {
    method: "GET",
    path: "/api/v1/subscriptions/session-status",
    auth: "Stripe checkout session id",
  },
  {
    method: "GET",
    path: "/api/v1/subscriptions/:motebitId/status",
    auth: "public read; creates no row (subscriptions.ts)",
  },
  { method: "POST", path: "/api/v1/subscriptions/:motebitId/cancel", auth: SUBSCRIPTION_OWNER },
  {
    method: "POST",
    path: "/api/v1/subscriptions/:motebitId/resubscribe",
    auth: SUBSCRIPTION_OWNER,
  },
  { method: "POST", path: "/api/v1/onramp/session", auth: USER_INITIATED_RAMP },
  { method: "POST", path: "/api/v1/offramp/session", auth: USER_INITIATED_RAMP },

  // --- Discovery ---
  { method: "GET", path: "/api/v1/discover/:motebitId", auth: "public discovery read" },
  // `market:query` device token or master (dualAuth, registerAuthMiddleware).
  // /api/v1/market/revenue is NOT here — operator-only.
  {
    method: "GET",
    path: "/api/v1/market/candidates",
    auth: "registerAuthMiddleware: market:query device token or master",
  },

  // --- Routes whose own device-token auth the catch-all used to shadow (#827) ---
  { method: "GET", path: "/api/v1/proposals", auth: "proposalAuth (agents.ts): proposal audience" },
  {
    method: "POST",
    path: "/api/v1/proposals",
    auth: "proposalAuth (agents.ts): proposal audience",
  },
  {
    method: "GET",
    path: "/api/v1/proposals/:proposalId",
    auth: "proposalAuth (agents.ts): proposal audience",
  },
  {
    method: "POST",
    path: "/api/v1/proposals/:proposalId/respond",
    auth: "proposalAuth (agents.ts): proposal audience",
  },
  {
    method: "POST",
    path: "/api/v1/proposals/:proposalId/step-result",
    auth: "proposalAuth (agents.ts): proposal audience",
  },
  {
    method: "POST",
    path: "/api/v1/proposals/:proposalId/withdraw",
    auth: "proposalAuth (agents.ts): proposal audience",
  },
  {
    method: "POST",
    path: "/api/v1/browser-sandbox/token",
    auth: "registerAuthMiddleware: browser-sandbox-grant device token or master",
  },

  // --- Disputes: the parties' signed acts; /resolve has its own operator-only door ---
  { method: "POST", path: "/api/v1/allocations/:allocationId/dispute", auth: DISPUTE_PARTY },
  { method: "GET", path: "/api/v1/disputes/:disputeId", auth: DISPUTE_PARTY },
  { method: "POST", path: "/api/v1/disputes/:disputeId/evidence", auth: DISPUTE_PARTY },
  { method: "POST", path: "/api/v1/disputes/:disputeId/appeal", auth: DISPUTE_PARTY },
  { method: "GET", path: "/api/v1/disputes/:disputeId/resolutions", auth: DISPUTE_PARTY },
  {
    method: "POST",
    path: "/api/v1/disputes/:disputeId/resolve",
    auth: "registerAuthMiddleware: operator master token only, refused with none configured",
  },

  // --- Skills registry ---
  { method: "POST", path: "/api/v1/skills/submit", auth: SKILLS_REGISTRY },
  { method: "GET", path: "/api/v1/skills/discover", auth: SKILLS_REGISTRY },
  { method: "GET", path: "/api/v1/skills/:submitter/:name/:version", auth: SKILLS_REGISTRY },

  // --- Delegation-revocation cache (standing-delegation §5/§6 D2): a
  // delegator-signed revocation on submit, public read of the cache ---
  { method: "POST", path: "/api/v1/delegations/revocations", auth: SIGNATURE_IS_AUTH },
  { method: "GET", path: "/api/v1/delegations/revocations", auth: PUBLIC_ARTIFACT },
];

/**
 * A carve-out's route pattern as the anchored expression the catch-all tests:
 * each literal segment escaped, each `:param` the one-segment `[^/]+` Hono's
 * router gives an unconstrained param, and the whole path pinned by `^…$`.
 */
export function carveOutPattern(path: string): RegExp {
  const body = path
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${body}$`);
}

/**
 * The one matcher for a route table of exact carve-outs (#855): a request
 * matches an entry when its method is the entry's (HEAD as GET — Hono serves
 * HEAD with the GET handler) and its path matches the entry's pattern
 * anchored at both ends. Used by the master-token catch-all and by the
 * agent-route middleware's PUBLIC_AGENT_ROUTES (agents.ts).
 */
export function routeTableMatcher(
  entries: ReadonlyArray<{ method: CarveOutMethod; path: string }>,
): (method: string, path: string) => boolean {
  const compiled = entries.map((e) => ({ method: e.method, pattern: carveOutPattern(e.path) }));
  return (method, path) => {
    const m = method === "HEAD" ? "GET" : method;
    return compiled.some((e) => e.method === m && e.pattern.test(path));
  };
}

const matchMasterTokenCarveOut = routeTableMatcher(MASTER_TOKEN_CARVE_OUTS);

/**
 * Whether the /api/v1/* catch-all lets `method path` through without the
 * master token. `path` is `c.req.path`: the same decoded path the router
 * dispatches on, so the route this admits is the route the handler serves.
 */
export function isMasterTokenCarveOut(method: string, path: string): boolean {
  return matchMasterTokenCarveOut(method, path);
}

// ---------------------------------------------------------------------------
// registerMiddleware — wire up all middleware on the app
// ---------------------------------------------------------------------------

export function registerMiddleware(deps: MiddlewareDeps): MiddlewareResult {
  const { app, apiToken, corsOrigin, enableDeviceAuth } = deps;

  // --- Security & CORS ---
  app.use("*", secureHeaders());
  app.use("*", cors({ origin: corsOrigin, exposeHeaders: [...CORS_EXPOSED_RESPONSE_HEADERS] }));

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
    c.set("correlationId" as never, correlationId);
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

  // Commitment-bond submission + status read: write-rate (an agent posts its own
  // self-verifying proof-of-funds; the GET status read shares the path). Same
  // artifact-verified class as credentials/submit — no new audience.
  app.use("/api/v1/agents/:motebitId/bond", rl(writeLimiter));
  // Machine roster (spec/machine-roster-v1.md §11): write-rate. Every
  // surface of a motebit re-presents its whole cached set whenever it
  // connects, and each entry costs a signature verification — which is
  // what the limit protects. The GET shares the path and the tier.
  app.use("/api/v1/agents/:motebitId/roster", rl(writeLimiter));

  // Delegation-revocation cache: submit is write-rate (signed-artifact
  // ingestion, the bond class); the cache read shares the same path, so the
  // stricter write tier covers both methods.
  app.use("/api/v1/delegations/revocations", rl(writeLimiter));

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

  // Virtual account endpoints (write: withdraw, read: balance/withdrawals)
  app.use("/api/v1/agents/:motebitId/withdraw", rl(writeLimiter));
  app.use("/api/v1/agents/:motebitId/balance", rl(readLimiter));
  app.use("/api/v1/agents/:motebitId/solvency-proof", rl(readLimiter));
  app.use("/api/v1/agents/:motebitId/withdrawals", rl(readLimiter));
  app.use("/api/v1/agents/:motebitId/checkout", rl(writeLimiter));
  app.use("/api/v1/agents/:motebitId/settlements", rl(readLimiter));
  app.use("/api/v1/stripe/webhook", rl(publicLimiter));
  app.use("/api/v1/admin/withdrawals/*", rl(writeLimiter));
  app.use("/api/v1/admin/reconciliation", rl(expensiveLimiter));
  app.use("/api/v1/admin/freeze", rl(writeLimiter));
  app.use("/api/v1/admin/unfreeze", rl(writeLimiter));
  app.use("/api/v1/admin/freeze-status", rl(readLimiter));
  app.use("/api/v1/admin/x402-settlements", rl(readLimiter));
  app.use("/api/v1/admin/x402-settlements/*", rl(writeLimiter));

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
  app.use("/api/v1/admin/auth-events", rl(expensiveLimiter));
  app.use("/api/v1/admin/credential-anchoring", rl(expensiveLimiter));
  app.use("/api/v1/admin/treasury-reconciliation", rl(expensiveLimiter));
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
        recordRefusalBeforeVerify(c, deps.recordAuthEvent, {
          kind: "device_token_rejected",
          audience: "sync",
          reason: "missing_token",
        });
        throw new AuthenticationError("AUTH_MISSING_TOKEN", "Missing device token");
      }
      const token = authHeader.slice(7);

      // Master token bypass
      if (apiToken != null && apiToken !== "" && token === apiToken) {
        recordMasterTokenOnce(c, deps.recordAuthEvent, {
          method: c.req.method,
          path: new URL(c.req.url, "http://localhost").pathname,
          correlationId: c.req.header("x-correlation-id") ?? null,
        });
        await next();
        return;
      }

      // Extract motebitId from URL path (/sync/:motebitId/...). This reads
      // the RAW segment; the handlers read Hono's DECODED param. The token
      // must be verified against the identity the handler acts on, so a
      // segment the two readers could disagree about is refused (#853: the
      // raw `%37f3…` verified an attacker's own token while the handler
      // served the victim `7f3…`).
      const pathParts = new URL(c.req.url, "http://localhost").pathname.split("/");
      const rawSegment = pathParts[2];
      if (rawSegment == null || rawSegment === "") {
        throw new HTTPException(400, { message: "Missing motebitId" });
      }
      const motebitId = pathIdentity(rawSegment);
      if (motebitId == null) {
        const presenter = deps.parseTokenPayloadUnsafe(token)?.mid ?? null;
        logger.warn("auth.device_token_rejected", {
          correlationId: c.req.header("x-correlation-id") ?? "none",
          reason: "path_id_not_literal",
          expectedAudience: "sync",
          mid: presenter,
        });
        deps.recordAuthEvent?.({
          kind: "device_token_rejected",
          method: c.req.method,
          path: new URL(c.req.url, "http://localhost").pathname,
          motebitId: presenter,
          audience: "sync",
          reason: "path_id_not_literal",
          correlationId: c.req.header("x-correlation-id") ?? null,
        });
        throw new HTTPException(400, {
          message: "motebitId in the path must be literal — no percent-encoding",
        });
      }

      if (!token.includes(".")) {
        // Legacy device tokens (plain UUIDs) are no longer accepted — signed JWTs only
        recordRefusalBeforeVerify(c, deps.recordAuthEvent, {
          kind: "device_token_rejected",
          audience: "sync",
          reason: "legacy_token",
        });
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
        undefined,
        (reason) => {
          logger.warn("auth.device_token_rejected", {
            correlationId: c.req.header("x-correlation-id") ?? "none",
            reason,
            expectedAudience: "sync",
            mid: motebitId,
            path: new URL(c.req.url, "http://localhost").pathname,
          });
          deps.recordAuthEvent?.({
            kind: "device_token_rejected",
            method: c.req.method,
            path: new URL(c.req.url, "http://localhost").pathname,
            motebitId,
            audience: "sync",
            reason,
            correlationId: c.req.header("x-correlation-id") ?? null,
          });
        },
      );
      if (!verified) {
        throw new AuthorizationError(
          "AUTHZ_DEVICE_NOT_AUTHORIZED",
          "Device not authorized for this motebit",
        );
      }
      // The presenter: the verifier bound the token's `mid` to the path id.
      // A refused cross-identity push is recorded under it (#846).
      c.set(SYNC_PRESENTER_KEY as never, motebitId);
      await next();
    });
  } else if (apiToken != null && apiToken !== "") {
    // Legacy single-token auth for sync routes
    app.use("/sync/*", bearerAuth({ token: apiToken }));
  }

  // --- Catch-all /api/v1/* middleware ---
  // Every /api/v1 route is master-only except the routes MASTER_TOKEN_CARVE_OUTS
  // names, each by one method and its exact route pattern, matched anchored
  // against the routed path (#855). The exemption is decided by that table and
  // nothing else. `check-master-token-carve-outs` (R6) holds this handler to an
  // allowlist: its first statement is exactly the guard below — the matcher
  // called on `(c.req.method, c.req.path)`, its block `await next(); return;`,
  // nothing or'd, and'd or ternaried beside it — it calls only
  // isMasterTokenCarveOut / bearerAuth / mw / c.req.header /
  // recordMasterTokenOnce, it reads `c` only as `c.req.method` / `c.req.path`
  // (matcher arguments or record fields), `c.req.header("authorization" |
  // "x-correlation-id")`, or as an argument of recordMasterTokenOnce / mw, and
  // `next` is reached only by the guard or through `mw`. The gate also refuses
  // any carve-out that reaches a route it does not name.
  if (apiToken != null && apiToken !== "") {
    app.use("/api/v1/*", async (c, next) => {
      if (isMasterTokenCarveOut(c.req.method, c.req.path)) {
        await next();
        return;
      }
      const mw = bearerAuth({ token: apiToken });
      const presented = c.req.header("authorization");
      if (presented === `Bearer ${apiToken}`) {
        recordMasterTokenOnce(c, deps.recordAuthEvent, {
          method: c.req.method,
          path: c.req.path,
          correlationId: c.req.header("x-correlation-id") ?? null,
        });
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance between middleware and handler signatures
      return mw(c as never, next);
    });
  }

  // --- Error handler ---
  app.onError((caught, c) => {
    // A freeze guard aborted this request's money write (the freeze landed
    // after the entry check): a typed 503, never a 500. An x402 settlement the
    // freeze left uncredited is already a 503 that names its record.
    const err =
      !(caught instanceof EmergencyFrozenError) &&
      !(caught instanceof X402OutcomeUnknownError) &&
      isEmergencyFrozenAbort(caught)
        ? new EmergencyFrozenError(undefined, { cause: caught })
        : caught;
    // #459: if THIS request claimed an idempotency key and then failed
    // before completing it, release the claim — else the key is stranded
    // in 'processing' and an honest same-key retry gets 409 until the 24h
    // sweep. Ownership is stamped only by the claiming request, so a 409
    // conflict on someone else's live claim never reaches here with a stamp.
    const claim = c.get("idempotencyClaim" as never) as
      { key: string; motebitId: string } | undefined;
    if (claim != null && deps.releaseIdempotencyClaim != null) {
      try {
        deps.releaseIdempotencyClaim(claim.key, claim.motebitId);
      } catch {
        // Release is best-effort — the 24h sweep remains the backstop.
      }
    } // A request whose money write the freeze refused (a route that does not
    // release on every failure stamps this): its key reopens, so the same-key
    // retry after unfreeze does the work once instead of a 409.
    const frozenClaim = c.get("idempotencyClaimOnFreeze" as never) as
      { key: string; motebitId: string } | undefined;
    if (err instanceof EmergencyFrozenError && frozenClaim != null && claim == null) {
      try {
        deps.releaseIdempotencyClaim?.(frozenClaim.key, frozenClaim.motebitId);
      } catch {
        // Best-effort — the 24h sweep remains the backstop.
      }
    }

    if (err instanceof RelayError) {
      const status = err.statusCode as 400;
      if (err instanceof RateLimitError) {
        c.header("Retry-After", String(err.retryAfter));
      }
      // A funding refusal after this request's own payment was credited names
      // that payment, so the client does not pay again (#901). Additive field.
      if (err instanceof InsufficientFundsError && err.creditedPayment != null) {
        return c.json(
          {
            error: err.message,
            code: err.code,
            status: err.statusCode,
            payment_credited: err.creditedPayment,
          },
          status,
        );
      }
      // A proof already bound to an admitted task names that task only when
      // the caller is entitled to see it (#918); the error decides that.
      // An x402 outcome the client must not pay again for names the record
      // being reconciled (#907 round 2). Additive field.
      if (
        (err instanceof X402OutcomeUnknownError || err instanceof X402PaymentReplayedError) &&
        err.settlement != null
      ) {
        return c.json(
          {
            error: err.message,
            code: err.code,
            status: err.statusCode,
            x402_settlement: err.settlement,
          },
          status,
        );
      }
      if (err instanceof P2pProofAlreadyAdmittedError && err.existingTaskId != null) {
        return c.json(
          {
            error: err.message,
            code: err.code,
            status: err.statusCode,
            task_id: err.existingTaskId,
          },
          status,
        );
      }
      return c.json({ error: err.message, code: err.code, status: err.statusCode }, status);
    }
    if (err instanceof HTTPException) {
      return c.json({ error: err.message, status: err.status }, err.status);
    }
    // Structured-log the unhandled exception per CLAUDE.md rule 3
    // ("Never `console.log` in production paths"). The request-scope
    // logger pulls correlationId from AsyncLocalStorage automatically;
    // surfacing `correlation_id` in the response gives users a token
    // they can quote in support reports so the operator can grep the
    // matching log line — turning a silent 500 into a reconcilable
    // failure category for the client.
    const correlationId = c.get("correlationId" as never) as string | undefined;
    logger.error("relay.unhandled_exception", {
      error_name: err instanceof Error ? err.name : "unknown",
      error_message: err instanceof Error ? err.message : String(err),
      method: c.req.method,
      path: c.req.path,
    });
    return c.json(
      {
        error: "Internal server error",
        status: 500,
        code: "INTERNAL_ERROR",
        ...(correlationId != null ? { correlation_id: correlationId } : {}),
      },
      500,
    );
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

/** `POST /agent/:motebitId/task/:taskId/result` — the one POST under `/agent/*\/task` that is not a submission. */
const TASK_RESULT_PATH = /^\/agent\/[^/]+\/task\/[^/]+\/result$/;

/**
 * `recordAuthEvent` is REQUIRED here (optional on the shared deps type): every
 * door below authenticates, and a door that authenticates without recording
 * is invisible to the relay's own posture record (rule 6). It was optional,
 * and index.ts never passed it (#827).
 */
export function registerAuthMiddleware(
  deps: MiddlewareDeps & { recordAuthEvent: NonNullable<MiddlewareDeps["recordAuthEvent"]> },
): void {
  const { app, apiToken } = deps;
  const dualAuth = createDualAuth(deps);

  // Subscription owner routes (#846): cancel and resubscribe act on ONE
  // identity's Stripe subscription, so they take that identity's device token
  // (`account:checkout` — the billing-mutation audience the web/desktop/
  // mobile billing panels already mint for checkout) or the master token.
  // The prefix stays out of the master-token catch-all for the Stripe webhook
  // (signature-verified) and checkout/session-status; these two are the
  // owner-facing mutations. The handler binds the caller to `:motebitId`
  // (identity-binding.ts). Installed before the no-apiToken early return:
  // with no master token configured a device token must still be verified.
  for (const sub of ["cancel", "resubscribe"]) {
    app.use(`/api/v1/subscriptions/:motebitId/${sub}`, async (c, next) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
      return dualAuth(c, next, ACCOUNT_CHECKOUT_AUDIENCE);
    });
  }

  // Dispute adjudication is the OPERATOR's act (spec/dispute-v1.md §6: on a
  // single relay the operator's body IS the resolution; the federation path
  // is driven by the relay itself). `/api/v1/disputes/` is carved out of the
  // master-token catch-all for the parties' signed filing, evidence and
  // appeal, and nothing else authenticated `/resolve`: any caller could set
  // the verdict, fund action and split ratio of any dispute (#846 v2 audit).
  // Master token only; with no master token configured it is refused.
  app.use("/api/v1/disputes/:disputeId/resolve", async (c, next) => {
    const header = c.req.header("authorization");
    const presented = header != null && header.startsWith("Bearer ") ? header.slice(7) : null;
    const path = new URL(c.req.url, "http://localhost").pathname;
    if (apiToken != null && apiToken !== "" && presented === apiToken) {
      recordMasterTokenOnce(c, deps.recordAuthEvent, {
        method: c.req.method,
        path,
        correlationId: c.req.header("x-correlation-id") ?? null,
      });
      await next();
      return;
    }
    const claimed =
      presented != null ? (deps.parseTokenPayloadUnsafe(presented)?.mid ?? null) : null;
    logger.warn("auth.dispute_resolve_refused", { path, presenter: claimed });
    deps.recordAuthEvent({
      kind: "agent_token_rejected",
      method: c.req.method,
      path,
      motebitId: claimed,
      reason:
        presented == null ? "dispute:resolve:unauthenticated" : "dispute:resolve:operator_only",
      correlationId: c.req.header("x-correlation-id") ?? null,
    });
    throw new HTTPException(presented == null ? 401 : 403, {
      message: "Dispute resolution is the operator's act",
    });
  });

  if (apiToken == null || apiToken === "") return;

  // POST /agent/:motebitId/task — submit a task (master token or signed device token)
  app.use("/agent/*/task", async (c, next) => {
    // Only apply auth to POST (submit) requests, not to /result sub-routes.
    // Decided on `c.req.path` — the path the router routes — never on the
    // raw URL: `c.req.url.includes("/result")` also matched a QUERY string,
    // so `POST /agent/:id/task?x=/result` reached the submit handler with
    // no authentication at all (found in the #853 audit).
    if (c.req.method === "POST" && !TASK_RESULT_PATH.test(c.req.path)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
      return dualAuth(c, next, TASK_SUBMIT_AUDIENCE);
    }
    await next();
  });

  // POST /api/v1/browser-sandbox/token — exchange a motebit-signed grant
  // token for a relay-signed sandbox token. Verifies the request under
  // the `browser-sandbox-grant` audience; the response is a token bound
  // to the `browser-sandbox` audience (minted by the route handler with
  // the relay's identity key). See ./browser-sandbox.ts.
  app.use("/api/v1/browser-sandbox/token", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
    return dualAuth(c, next, BROWSER_SANDBOX_GRANT_AUDIENCE);
  });

  // Auth middleware for ledger and settlement routes — master token required
  app.use("/agent/*/ledger", bearerAuth({ token: apiToken }));
  app.use("/agent/*/ledger/*", bearerAuth({ token: apiToken }));
  app.use("/agent/*/settlements", bearerAuth({ token: apiToken }));

  // Auth middleware for virtual account routes — master token or signed device token.
  // (The self-declared `/deposit` route was removed — treasury-drain vector; balance
  // is credited only by verified server-side funding. `ACCOUNT_DEPOSIT_AUDIENCE`
  // remains reserved in the registry for a future funded deposit-initiation endpoint.)
  app.use("/api/v1/agents/*/balance", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
    return dualAuth(c, next, ACCOUNT_BALANCE_AUDIENCE);
  });
  // Per-peer settlement summary — the caller's own economic history (the
  // money side of the first-person trust graph). Lives in the /api/v1/agents
  // namespace so the catch-all master-token gate exempts it (like balance);
  // same security class as balance (read-only own financial state, no
  // mutation), so it reuses the `account:balance` audience rather than
  // expanding the audience registry. The handler in state-export.ts enforces
  // own-id (path == caller).
  app.use("/api/v1/agents/*/settlements", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
    return dualAuth(c, next, ACCOUNT_BALANCE_AUDIENCE);
  });
  app.use("/api/v1/agents/*/withdraw", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
    return dualAuth(c, next, ACCOUNT_WITHDRAW_AUDIENCE);
  });
  app.use("/api/v1/agents/*/withdrawals", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
    return dualAuth(c, next, ACCOUNT_WITHDRAWALS_AUDIENCE);
  });
  app.use("/api/v1/agents/*/checkout", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
    return dualAuth(c, next, ACCOUNT_CHECKOUT_AUDIENCE);
  });
  // Market candidate discovery is device-authable: a delegating agent (sovereign
  // delegation / `motebit delegate`) calls it with its OWN `market:query` device
  // token to find workers — it does not hold the operator master token. Carved
  // out of the /api/v1/* master-only catch-all below. (`/api/v1/market/revenue`
  // is operator-only and deliberately stays under the catch-all.)
  app.use("/api/v1/market/candidates", async (c, next) => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
    return dualAuth(c, next, MARKET_QUERY_AUDIENCE);
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
  app.use("/api/v1/admin/auth-events", bearerAuth({ token: apiToken }));
  app.use("/api/v1/admin/credential-anchoring", bearerAuth({ token: apiToken }));
  app.use("/api/v1/admin/treasury-reconciliation", bearerAuth({ token: apiToken }));
  // Admin x402 settlement records (#907 round 3): list + proof-of-execution resolve.
  app.use("/api/v1/admin/x402-settlements", bearerAuth({ token: apiToken }));
  app.use("/api/v1/admin/x402-settlements/*", bearerAuth({ token: apiToken }));
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
