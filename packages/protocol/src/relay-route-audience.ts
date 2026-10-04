/**
 * Relay route → token audience — the closed table of which `aud` a relay
 * route requires of a device-signed bearer token.
 *
 * `TokenAudience` (`./audience.ts`) closes the VOCABULARY: a signing site
 * cannot mint a value that does not exist. It says nothing about WHICH value
 * a given route expects, and that second fact had no home. Clients guessed it
 * per call site (`audienceForPath` helpers, a `createSyncToken()` default of
 * `sync`, a CLI default of `admin:query`), the relay decided it in its own
 * middleware, and the two drifted. A client that mints one audience where the
 * route verifies another is refused on every call, and nothing says so until
 * someone reads the relay's `auth.agent_token_rejected` line: #460 (balance),
 * #702 (rotate-key), #825 (push-token), #827 (sweep-config, balance from
 * mobile and the CLI, a proposals path that never existed, web pairing).
 *
 * This table is that fact, stated once, as wire law (`spec/auth-token-v1.md`
 * §5 is its prose). Three consumers read it:
 *
 *   - clients resolve the audience to mint with `relayRouteAudience(method,
 *     path)` instead of a local guess;
 *   - `scripts/check-audience-route-parity.ts` checks every static client
 *     mint site and every client relay-path literal against it (a path the
 *     table does not name is a call to a route that does not accept a device
 *     token, or does not exist);
 *   - the relay's conformance test (`services/relay/src/__tests__/
 *     route-audience-conformance.test.ts`) mints each entry's audience against
 *     the in-process relay and proves the route accepts exactly that audience
 *     and refuses another — so the table cannot say something the relay does
 *     not do.
 *
 * Scope: routes where a DEVICE-signed token can succeed. Master-token-only
 * routes (`/api/v1/admin/*`, the state-export family, `/agent/:id/ledger`)
 * and public or self-authenticating routes (register-self, credentials/submit,
 * succession, discover, ...) are deliberately absent: no audience makes a
 * device token pass there, so a client minting one for them is the defect.
 *
 * Paths are patterns: a `:name` segment matches exactly one non-empty path
 * segment. Adding a route that takes a device token is one entry here plus
 * the relay route, and the conformance test proves them equal.
 *
 * Permissive floor (Apache-2.0), zero runtime deps.
 */

import type { TokenAudience } from "./audience.js";

/** HTTP methods a relay route can be registered under. */
export type RelayRouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One relay route and the audience its auth requires of a device-signed token. */
export interface RelayRouteAudience {
  readonly method: RelayRouteMethod;
  /** Path pattern; `:name` matches one non-empty segment. No query string. */
  readonly path: string;
  readonly audience: TokenAudience;
}

const A = "/api/v1/agents/:motebitId";

/**
 * Every relay route that accepts a device-signed token, with the audience it
 * requires. Frozen; order is documentation only. Where two patterns match one
 * path (`/api/v1/agents/:motebitId` and a literal sibling), the one with more
 * literal segments wins.
 */
export const RELAY_ROUTE_AUDIENCES: readonly RelayRouteAudience[] = Object.freeze([
  // --- Agent registry: a service's own registration family (spec §5 admin:query)
  { method: "POST", path: "/api/v1/agents/register", audience: "admin:query" },
  { method: "POST", path: "/api/v1/agents/heartbeat", audience: "admin:query" },
  { method: "DELETE", path: "/api/v1/agents/deregister", audience: "admin:query" },
  { method: "POST", path: "/api/v1/agents/accept-migration", audience: "admin:query" },
  { method: "GET", path: A, audience: "admin:query" },

  // --- Push-notification token registration
  { method: "POST", path: "/api/v1/agents/push-token", audience: "push:register" },
  { method: "DELETE", path: "/api/v1/agents/push-token", audience: "push:register" },

  // --- Per-agent routes, by the relay's agent-route middleware family
  { method: "POST", path: `${A}/approvals`, audience: "admin:query" },
  { method: "GET", path: `${A}/approvals/:approvalId`, audience: "admin:query" },
  { method: "POST", path: `${A}/approvals/:approvalId/vote`, audience: "admin:query" },
  { method: "GET", path: `${A}/bond`, audience: "admin:query" },
  { method: "POST", path: `${A}/bond`, audience: "admin:query" },
  { method: "POST", path: `${A}/command`, audience: "admin:query" },
  { method: "GET", path: `${A}/graph`, audience: "admin:query" },
  { method: "GET", path: `${A}/path-to/:targetId`, audience: "admin:query" },
  { method: "GET", path: `${A}/routing-explanation`, audience: "admin:query" },
  { method: "GET", path: `${A}/trust-closure`, audience: "admin:query" },
  { method: "POST", path: `${A}/migrate`, audience: "admin:query" },
  { method: "POST", path: `${A}/migrate/cancel`, audience: "admin:query" },
  { method: "POST", path: `${A}/migrate/depart`, audience: "admin:query" },
  { method: "GET", path: `${A}/migration/attestation`, audience: "admin:query" },
  { method: "GET", path: `${A}/migration/export`, audience: "admin:query" },
  { method: "POST", path: `${A}/revoke`, audience: "admin:query" },
  { method: "POST", path: `${A}/revoke-credential`, audience: "admin:query" },
  { method: "POST", path: `${A}/revoke-tokens`, audience: "admin:query" },
  { method: "PATCH", path: `${A}/sweep-config`, audience: "admin:query" },
  { method: "POST", path: `${A}/revoke-listing`, audience: "admin:query" },
  { method: "POST", path: `${A}/restore-listing`, audience: "admin:query" },

  { method: "GET", path: `${A}/listing`, audience: "market:listing" },
  { method: "POST", path: `${A}/listing`, audience: "market:listing" },
  { method: "GET", path: `${A}/p2p-eligibility`, audience: "market:listing" },

  { method: "GET", path: `${A}/credentials`, audience: "credentials" },
  { method: "POST", path: `${A}/presentation`, audience: "credentials:present" },
  { method: "POST", path: `${A}/rotate-key`, audience: "rotate-key" },
  { method: "POST", path: `${A}/proxy-token`, audience: "proxy:token" },
  { method: "GET", path: `${A}/receipts`, audience: "receipts:read" },
  { method: "GET", path: `${A}/receipts/:taskId`, audience: "receipts:read" },

  { method: "GET", path: `${A}/balance`, audience: "account:balance" },
  { method: "GET", path: `${A}/settlements`, audience: "account:balance" },
  // What a key rotation would leave owed to the retiring key's derived
  // address — read-only own financial state, the balance class.
  { method: "GET", path: `${A}/rotation-obligations`, audience: "account:balance" },
  { method: "POST", path: `${A}/withdraw`, audience: "account:withdraw" },
  { method: "GET", path: `${A}/withdrawals`, audience: "account:withdrawals" },
  { method: "POST", path: `${A}/checkout`, audience: "account:checkout" },

  // --- Subscription owner routes (#846): the identity's own billing mutation.
  // They had no authentication at all; `account:checkout` is the existing
  // billing-mutation audience every billing panel already mints.
  { method: "POST", path: "/api/v1/subscriptions/:motebitId/cancel", audience: "account:checkout" },
  {
    method: "POST",
    path: "/api/v1/subscriptions/:motebitId/resubscribe",
    audience: "account:checkout",
  },

  { method: "GET", path: `${A}/roster`, audience: "device:auth" },
  { method: "POST", path: `${A}/roster`, audience: "device:auth" },

  // --- Task routing
  { method: "POST", path: "/agent/:motebitId/task", audience: "task:submit" },
  { method: "GET", path: "/agent/:motebitId/task/:taskId", audience: "task:query" },
  { method: "POST", path: "/agent/:motebitId/task/:taskId/result", audience: "task:result" },

  // --- Market discovery
  { method: "GET", path: "/api/v1/market/candidates", audience: "market:query" },

  // --- Collaborative proposals
  { method: "GET", path: "/api/v1/proposals", audience: "proposal" },
  { method: "POST", path: "/api/v1/proposals", audience: "proposal" },
  { method: "GET", path: "/api/v1/proposals/:proposalId", audience: "proposal" },
  { method: "POST", path: "/api/v1/proposals/:proposalId/respond", audience: "proposal" },
  { method: "POST", path: "/api/v1/proposals/:proposalId/step-result", audience: "proposal" },
  { method: "POST", path: "/api/v1/proposals/:proposalId/withdraw", audience: "proposal" },

  // --- Browser sandbox grant
  { method: "POST", path: "/api/v1/browser-sandbox/token", audience: "browser-sandbox-grant" },

  // --- Multi-device sync (HTTP + WebSocket upgrade)
  { method: "GET", path: "/ws/sync/:motebitId", audience: "sync" },
  { method: "GET", path: "/sync/:motebitId/clock", audience: "sync" },
  { method: "GET", path: "/sync/:motebitId/pull", audience: "sync" },
  { method: "POST", path: "/sync/:motebitId/push", audience: "sync" },
  { method: "GET", path: "/sync/:motebitId/conversations", audience: "sync" },
  { method: "POST", path: "/sync/:motebitId/conversations", audience: "sync" },
  { method: "GET", path: "/sync/:motebitId/messages", audience: "sync" },
  { method: "POST", path: "/sync/:motebitId/messages", audience: "sync" },
  { method: "GET", path: "/sync/:motebitId/plans", audience: "sync" },
  { method: "POST", path: "/sync/:motebitId/plans", audience: "sync" },
  { method: "GET", path: "/sync/:motebitId/plan-steps", audience: "sync" },
  { method: "POST", path: "/sync/:motebitId/plan-steps", audience: "sync" },

  // --- Device pairing (the initiating/approving device authenticates)
  { method: "POST", path: "/pairing/initiate", audience: "device:auth" },
  { method: "GET", path: "/pairing/:pairingId", audience: "device:auth" },
  { method: "POST", path: "/pairing/:pairingId/approve", audience: "device:auth" },
  { method: "POST", path: "/pairing/:pairingId/deny", audience: "device:auth" },
] satisfies RelayRouteAudience[]);

/** A relay route in the same families that takes NO bearer token. */
export interface RelayPublicRoute {
  readonly method: RelayRouteMethod;
  readonly path: string;
}

/**
 * Routes in the device-token families that need no token at all — public
 * reads, and requests that authenticate themselves (a signed envelope, a
 * pairing code). `relayRouteAudience` answers `undefined` for these even
 * where a `:param` sibling in `RELAY_ROUTE_AUDIENCES` would otherwise match
 * (`GET /api/v1/agents/discover` is not `GET /api/v1/agents/:motebitId`).
 */
export const RELAY_PUBLIC_ROUTES: readonly RelayPublicRoute[] = Object.freeze([
  { method: "GET", path: "/api/v1/agents/discover" },
  { method: "GET", path: "/api/v1/agents/revocations" },
  { method: "POST", path: "/api/v1/agents/bootstrap" },
  { method: "GET", path: `${A}/succession` },
  { method: "GET", path: `${A}/solvency-proof` },
  { method: "POST", path: `${A}/credentials/submit` },
  { method: "POST", path: `${A}/devices/:deviceId/hardware-attestation` },
  { method: "GET", path: "/agent/:motebitId/capabilities" },
  { method: "POST", path: "/pairing/claim" },
  { method: "GET", path: "/pairing/:pairingId/status" },
  { method: "POST", path: "/pairing/:pairingId/update-key" },
] satisfies RelayPublicRoute[]);

function segments(path: string): string[] {
  const q = path.search(/[?#]/);
  const bare = q === -1 ? path : path.slice(0, q);
  return bare.split("/").filter((s) => s.length > 0);
}

/**
 * How specifically a concrete path matches a `:param` pattern: the number of
 * literal segments, or -1 when it does not match segment for segment.
 */
function specificity(pattern: string, path: string): number {
  const p = segments(pattern);
  const s = segments(path);
  if (p.length !== s.length) return -1;
  let literals = 0;
  for (let i = 0; i < p.length; i++) {
    const want = p[i]!;
    if (want.startsWith(":")) continue;
    if (want !== s[i]) return -1;
    literals++;
  }
  return literals;
}

/**
 * The audience a relay route requires of a device-signed token, or
 * `undefined` when the route is public (`RELAY_PUBLIC_ROUTES`) or no route in
 * `RELAY_ROUTE_AUDIENCES` matches — the route does not exist, or it does not
 * accept a device token at all. Pure lookup over the frozen tables; the query
 * string is ignored.
 *
 * `HEAD` resolves as `GET`: HTTP servers (Hono included) answer a HEAD with
 * the GET handler, so a HEAD must be authenticated exactly as its GET is. A
 * table with no HEAD rows let a HEAD fall to the `admin:query` default and be
 * served by the GET handler with the wrong audience (#836 review).
 */
export function relayRouteAudience(method: string, path: string): TokenAudience | undefined {
  const upper = method.toUpperCase();
  const m = upper === "HEAD" ? "GET" : upper;
  for (const pub of RELAY_PUBLIC_ROUTES) {
    if (pub.method === m && specificity(pub.path, path) >= 0) return undefined;
  }
  let best: RelayRouteAudience | undefined;
  let bestScore = -1;
  for (const entry of RELAY_ROUTE_AUDIENCES) {
    if (entry.method !== m) continue;
    const score = specificity(entry.path, path);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best?.audience;
}
