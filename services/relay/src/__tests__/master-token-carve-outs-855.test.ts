/**
 * #855 — the /api/v1/* master-token catch-all exempts EXACTLY the routes it
 * names. It exempted paths by prefix and by unanchored regex, so a carve-out
 * reached routes it was never meant to: `startsWith("/api/v1/credentials/verify")`
 * let `POST /api/v1/credentials/verify/reputation` skip the master token and
 * reach `POST /api/v1/credentials/:motebitId/reputation` with the id `verify`,
 * and the relay signed a reputation credential for it.
 *
 * Now every carve-out is one method and one registered route pattern
 * (`MASTER_TOKEN_CARVE_OUTS`), matched anchored against `c.req.path`, the path
 * the router dispatches on. This file proves:
 *
 *   1. every over-match the old carve-outs allowed is refused by the catch-all
 *      (a prefix, an unanchored start or end, a method the route does not
 *      serve, a stale namespace);
 *   2. every declared carve-out still gets past the catch-all with no token
 *      (and HEAD with its GET), one fresh relay per route so no rate limiter
 *      can answer first;
 *   3. against the RUNNING relay's route table: every carve-out names a
 *      registered route, and none reaches a route it does not name. The gate
 *      `check-master-token-carve-outs` proves the same from source; this proves
 *      it from what Hono actually registered, routes from every module.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import type { SyncRelay } from "../index.js";
import { AUTH_HEADER, createTestRelay } from "./test-helpers.js";
import { MASTER_TOKEN_CARVE_OUTS, carveOutPattern, isMasterTokenCarveOut } from "../middleware.js";
import { PUBLIC_AGENT_ROUTES, isPublicAgentRoute } from "../agents.js";

type Req = readonly [method: string, path: string];

/**
 * The catch-all's own refusal: Hono's `bearerAuth` throws an HTTPException
 * with no message, which the relay's error handler renders as exactly this
 * body. Every other auth layer a carve-out defers to names its refusal
 * (`Missing auth token`, `AUTH_MISSING_TOKEN`, …), so this body identifies the
 * catch-all. The first test below pins the fingerprint on a master-only route.
 */
async function refusedByCatchAll(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  const text = await res.clone().text();
  return text === JSON.stringify({ error: "", status: 401 });
}

async function send(relay: SyncRelay, [method, path]: Req, token = false): Promise<Response> {
  return relay.app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? AUTH_HEADER : {}),
    },
    ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
  });
}

/** A concrete path for a route pattern: each `:param` a plain, literal id. */
function concrete(pattern: string): string {
  return pattern
    .split("/")
    .map((s) => (s.startsWith(":") ? `probe-${s.slice(1)}` : s))
    .join("/");
}

/**
 * Requests the old carve-outs let through without the master token and that
 * reach no route the carve-out names. One (at least) per former carve-out.
 */
const OVER_MATCHES: ReadonlyArray<readonly [label: string, req: Req]> = [
  // The issue's two: a prefix reaching `POST /credentials/:motebitId/reputation`.
  ["verify prefix → reputation", ["POST", "/api/v1/credentials/verify/reputation"]],
  ["verify prefix, longer id → reputation", ["POST", "/api/v1/credentials/verifyX/reputation"]],
  ["batch-status prefix → reputation", ["POST", "/api/v1/credentials/batch-statusX/reputation"]],
  // The percent-encoded spelling routes as the decoded one (#853): still refused.
  ["encoded verify → reputation", ["POST", "/api/v1/credentials/%76erify/reputation"]],
  // Unanchored regexes: a trailing segment, and a match that starts mid-path.
  ["status regex, trailing segment", ["GET", "/api/v1/credentials/x/status/extra"]],
  ["status regex, suffix", ["GET", "/api/v1/credentials/x/statusX"]],
  ["status regex, mid-path start", ["GET", "/api/v1/x/api/v1/credentials/y/status"]],
  ["credential anchor-proof regex", ["GET", "/api/v1/credentials/x/anchor-proof/extra"]],
  ["settlement anchor-proof regex", ["GET", "/api/v1/settlements/x/anchor-proof/extra"]],
  // Former prefixes, one segment past the route they meant.
  ["credential-anchors/ prefix", ["GET", "/api/v1/credential-anchors/x/extra"]],
  ["settlement-anchors/ prefix", ["GET", "/api/v1/settlement-anchors/x/extra"]],
  ["identity/ prefix", ["GET", "/api/v1/identity/x/extra"]],
  ["stripe/ prefix", ["POST", "/api/v1/stripe/other"]],
  ["bridge/ prefix (no route left)", ["POST", "/api/v1/bridge/webhook"]],
  ["subscriptions/ prefix", ["POST", "/api/v1/subscriptions/x/other"]],
  ["onramp/ prefix", ["POST", "/api/v1/onramp/other"]],
  ["offramp/ prefix", ["POST", "/api/v1/offramp/other"]],
  ["discover/ prefix", ["GET", "/api/v1/discover/x/extra"]],
  ["proposals/ prefix", ["POST", "/api/v1/proposals/x/other"]],
  ["allocations/ prefix", ["POST", "/api/v1/allocations/x/other"]],
  ["disputes/ prefix", ["POST", "/api/v1/disputes/x/other"]],
  ["skills/ prefix", ["POST", "/api/v1/skills/other"]],
  ["agents prefix without a slash", ["GET", "/api/v1/agentsX"]],
  // A method the carved route does not serve.
  ["GET on the POST-only verify", ["GET", "/api/v1/credentials/verify"]],
  ["DELETE on revocations", ["DELETE", "/api/v1/delegations/revocations"]],
  ["GET on the Stripe webhook", ["GET", "/api/v1/stripe/webhook"]],
  ["PUT on register-self", ["PUT", "/api/v1/devices/register-self"]],
  // Found by the cold review: main's method-blind `=== "/api/v1/devices/register-self"`
  // let a tokenless GET through, and `GET /api/v1/devices/:motebitId` served
  // it with the id "register-self" — 200 on main.
  [
    "GET on register-self (served by GET /devices/:motebitId)",
    ["GET", "/api/v1/devices/register-self"],
  ],
];

describe("#855 the pure matcher", () => {
  it("carveOutPattern is anchored at both ends and a param is one segment", () => {
    const re = carveOutPattern("/api/v1/credentials/:credentialId/status");
    expect(re.test("/api/v1/credentials/abc/status")).toBe(true);
    expect(re.test("/api/v1/credentials/abc/status/extra")).toBe(false);
    expect(re.test("/x/api/v1/credentials/abc/status")).toBe(false);
    expect(re.test("/api/v1/credentials/a/b/status")).toBe(false);
    expect(re.test("/api/v1/credentials//status")).toBe(false);
  });

  it.each(OVER_MATCHES)("%s is not a carve-out", (_label, [method, path]) => {
    expect(isMasterTokenCarveOut(method, path)).toBe(false);
  });

  it.each(MASTER_TOKEN_CARVE_OUTS.map((e) => [`${e.method} ${e.path}`, e] as const))(
    "%s is a carve-out",
    (_label, e) => {
      expect(isMasterTokenCarveOut(e.method, concrete(e.path))).toBe(true);
    },
  );

  it("HEAD is carved exactly where its GET is", () => {
    expect(isMasterTokenCarveOut("HEAD", "/api/v1/identity/abc")).toBe(true);
    expect(isMasterTokenCarveOut("HEAD", "/api/v1/credentials/verify")).toBe(false);
  });
});

describe("#855 the catch-all refuses every over-match", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(async () => {
    await relay.close();
  });

  it("the fingerprint is the catch-all's: a master-only route with no token", async () => {
    const res = await send(relay, ["GET", "/api/v1/market/revenue"]);
    expect(await refusedByCatchAll(res)).toBe(true);
    const ok = await send(relay, ["GET", "/api/v1/market/revenue"], true);
    expect(ok.status).not.toBe(401);
  });

  it.each(OVER_MATCHES)("%s → 401 without the master token", async (_label, req) => {
    const res = await send(relay, req);
    expect(res.status, `${req[0]} ${req[1]}: ${await res.clone().text()}`).toBe(401);
    expect(await refusedByCatchAll(res)).toBe(true);
  });

  it("the issue's request never reaches the reputation handler", async () => {
    // With the master token the same path IS served by the reputation route
    // (it is a real route, and the master token may call it) — so the 401
    // above is the catch-all, not a missing route.
    const res = await send(relay, ["POST", "/api/v1/credentials/verify/reputation"], true);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(404);
  });
});

describe("#855 every declared carve-out still passes the catch-all with no token", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    // One relay per route: the per-route rate limiters run before the
    // catch-all, and a 429 would say nothing about it.
    relay = await createTestRelay();
  });
  afterEach(async () => {
    await relay.close();
  });

  it.each(MASTER_TOKEN_CARVE_OUTS.map((e) => [`${e.method} ${e.path}`, e] as const))(
    "%s",
    async (_label, e) => {
      const res = await send(relay, [e.method, concrete(e.path)]);
      const text = await res.clone().text();
      expect(res.status, `rate-limited, proves nothing: ${text}`).not.toBe(429);
      expect(await refusedByCatchAll(res), `refused by the catch-all: ${text}`).toBe(false);
      if (e.method === "GET") {
        // A HEAD response has no body, so the fingerprint cannot be read.
        // Hono serves HEAD with the GET handler, so past the catch-all a HEAD
        // is answered exactly as its GET was; a catch-all refusal would be a
        // 401 where the GET was not.
        const head = await send(relay, ["HEAD", concrete(e.path)]);
        expect(head.status).not.toBe(429);
        expect(head.status, `HEAD answered unlike its GET (${res.status})`).toBe(res.status);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Against the running relay's own route table
// ---------------------------------------------------------------------------

/** A registered route pattern's segments, every `:param` spelled `:`. */
function shape(pattern: string): string[] {
  return pattern.split("/").map((s) => (s.startsWith(":") ? ":" : s));
}

/** Whether some concrete path matches both patterns (literal and `:param` segments only). */
function intersects(a: string, b: string): boolean {
  const x = shape(a);
  const y = shape(b);
  if (x.length !== y.length) return false;
  return x.every((s, i) => s === ":" || y[i] === ":" || s === y[i]);
}

describe("#855 carve-outs against the relay's registered routes", () => {
  let relay: SyncRelay;
  let handlers: Array<{ method: string; path: string }>;

  beforeAll(async () => {
    relay = await createTestRelay();
    const seen = new Set<string>();
    handlers = [];
    for (const r of relay.app.routes) {
      // `app.use` registers under ALL; a handler route under its method.
      if (r.method === "ALL" || !r.path.startsWith("/api/v1/")) continue;
      const key = `${r.method} ${r.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      handlers.push({ method: r.method, path: r.path });
    }
  });
  afterAll(async () => {
    await relay.close();
  });

  it("the registered /api/v1 handler routes are plain patterns the matcher models", () => {
    expect(handlers.length).toBeGreaterThan(100);
    for (const h of handlers) {
      expect(h.path, `${h.method} ${h.path}`).toMatch(/^(\/([A-Za-z0-9._-]+|:[A-Za-z0-9_]+))+$/);
    }
  });

  it.each(MASTER_TOKEN_CARVE_OUTS.map((e) => [`${e.method} ${e.path}`, e] as const))(
    "%s names a registered route",
    (_label, e) => {
      const named = handlers.some(
        (h) => h.method === e.method && shape(h.path).join("/") === shape(e.path).join("/"),
      );
      expect(named, `no ${e.method} ${e.path} is registered`).toBe(true);
    },
  );

  it("no carve-out reaches a route it does not name", () => {
    const declared = new Set(
      MASTER_TOKEN_CARVE_OUTS.map((e) => `${e.method} ${shape(e.path).join("/")}`),
    );
    const reached: string[] = [];
    for (const e of MASTER_TOKEN_CARVE_OUTS) {
      for (const h of handlers) {
        if (h.method !== e.method) continue;
        if (declared.has(`${h.method} ${shape(h.path).join("/")}`)) continue;
        if (intersects(e.path, h.path)) reached.push(`${e.method} ${e.path} reaches ${h.path}`);
      }
    }
    expect(reached).toEqual([]);
  });

  it("every route main's catch-all exempted for an ordinary id is still carved (no route lost)", () => {
    // main's predicate, verbatim in effect (method-blind, prefix and
    // unanchored regex). Applied to each registered route with ordinary
    // `probe-…` ids, it names the routes the carve-outs were MEANT for; the
    // over-matches need a crafted id (`verify…`) or path, and are refused above.
    const mainExempt = (p: string): boolean =>
      p.startsWith("/api/v1/agents") ||
      p === "/api/v1/devices/register-self" ||
      p === "/api/v1/motebits/announce" ||
      p.startsWith("/api/v1/credentials/verify") ||
      p.startsWith("/api/v1/credentials/batch-status") ||
      /\/api\/v1\/credentials\/[^/]+\/status/.test(p) ||
      /\/api\/v1\/credentials\/[^/]+\/anchor-proof/.test(p) ||
      p.startsWith("/api/v1/credential-anchors/") ||
      /\/api\/v1\/settlements\/[^/]+\/anchor-proof/.test(p) ||
      p.startsWith("/api/v1/settlement-anchors/") ||
      p.startsWith("/api/v1/identity/") ||
      p.startsWith("/api/v1/stripe/") ||
      p.startsWith("/api/v1/bridge/") ||
      p.startsWith("/api/v1/subscriptions/") ||
      p.startsWith("/api/v1/onramp/") ||
      p.startsWith("/api/v1/offramp/") ||
      p.startsWith("/api/v1/discover/") ||
      p === "/api/v1/market/candidates" ||
      p === "/api/v1/proposals" ||
      p.startsWith("/api/v1/proposals/") ||
      p === "/api/v1/browser-sandbox/token" ||
      p.startsWith("/api/v1/allocations/") ||
      p.startsWith("/api/v1/disputes/") ||
      p.startsWith("/api/v1/skills/") ||
      p === "/api/v1/delegations/revocations";
    const lost = handlers
      .filter((h) => mainExempt(concrete(h.path)))
      .filter((h) => !isMasterTokenCarveOut(h.method, concrete(h.path)))
      .map((h) => `${h.method} ${h.path}`);
    expect(lost).toEqual([]);
    // …and nothing is carved that main did not exempt: #855 narrows, never widens.
    const gained = MASTER_TOKEN_CARVE_OUTS.filter((e) => !mainExempt(concrete(e.path))).map(
      (e) => `${e.method} ${e.path}`,
    );
    expect(gained).toEqual([]);
  });

  it("the old verify prefix is exactly the shape this check catches", () => {
    // A self-test of `intersects`: the reputation route is reachable from a
    // carve-out that admits `verify` as its id segment.
    expect(
      intersects("/api/v1/credentials/:x/reputation", "/api/v1/credentials/:motebitId/reputation"),
    ).toBe(true);
    expect(
      intersects("/api/v1/credentials/verify", "/api/v1/credentials/:motebitId/reputation"),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The sibling door: the agent-route middleware's PUBLIC_AGENT_ROUTES
// ---------------------------------------------------------------------------

/**
 * The agent-route middleware's own refusal of a tokenless request. The
 * catch-all carves every agent route out, so a request refused HERE got past
 * it — and was then refused by the door that holds PUBLIC_AGENT_ROUTES.
 */
async function refusedByAgentDoor(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  const text = await res.clone().text();
  return text === JSON.stringify({ error: "Missing auth token", status: 401 });
}

/**
 * Requests the old closures (`endsWith("/solvency-proof")`,
 * `endsWith("/succession")`, method-blind `bootstrap` and
 * `credentials/submit`) let through with no token, each served by a route the
 * entry never named.
 */
const AGENT_OVER_MATCHES: ReadonlyArray<readonly [label: string, req: Req]> = [
  ["solvency-proof as an agent id", ["GET", "/api/v1/agents/solvency-proof"]],
  ["succession as an agent id", ["GET", "/api/v1/agents/succession"]],
  ["bootstrap read as an agent id (method-blind)", ["GET", "/api/v1/agents/bootstrap"]],
  ["receipts/solvency-proof", ["GET", "/api/v1/agents/probe-a/receipts/solvency-proof"]],
  ["receipts/succession", ["GET", "/api/v1/agents/probe-a/receipts/succession"]],
  ["approvals/solvency-proof", ["GET", "/api/v1/agents/probe-a/approvals/solvency-proof"]],
  ["path-to/solvency-proof", ["GET", "/api/v1/agents/probe-a/path-to/solvency-proof"]],
  ["path-to/succession", ["GET", "/api/v1/agents/probe-a/path-to/succession"]],
  [
    "GET on credentials/submit (method-blind)",
    ["GET", "/api/v1/agents/probe-a/credentials/submit"],
  ],
];

describe("#855 sibling: PUBLIC_AGENT_ROUTES is exact", () => {
  it.each(AGENT_OVER_MATCHES)("%s is not public", (_label, [method, path]) => {
    expect(isPublicAgentRoute(method, path)).toBe(false);
  });

  it.each(PUBLIC_AGENT_ROUTES.map((e) => [`${e.method} ${e.path}`, e] as const))(
    "%s is public (and HEAD with its GET)",
    (_label, e) => {
      expect(isPublicAgentRoute(e.method, concrete(e.path))).toBe(true);
      if (e.method === "GET") expect(isPublicAgentRoute("HEAD", concrete(e.path))).toBe(true);
    },
  );

  it.each(PUBLIC_AGENT_ROUTES.map((e) => [`${e.method} ${e.path}`, e] as const))(
    "%s is also a master-token carve-out (else the catch-all refuses it first)",
    (_label, e) => {
      expect(isMasterTokenCarveOut(e.method, concrete(e.path))).toBe(true);
    },
  );
});

// With no master token configured there is no catch-all, so the agent door is
// the only thing between these requests and the routes they reach.
describe("#855 sibling: the agent door refuses every over-match with no token (relay with no master token)", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay({ apiToken: undefined, allowInsecureNoAuth: true });
  });
  afterEach(async () => {
    await relay.close();
  });

  it("the fingerprint is the agent door's: an authenticated agent route with no token", async () => {
    const res = await send(relay, ["GET", "/api/v1/agents/probe-a/balance"]);
    expect(await refusedByAgentDoor(res)).toBe(true);
  });

  it.each(AGENT_OVER_MATCHES)("%s → the agent door's 401", async (_label, req) => {
    const res = await send(relay, req);
    const text = await res.clone().text();
    expect(await refusedByAgentDoor(res), `${req[0]} ${req[1]}: ${res.status} ${text}`).toBe(true);
  });
});

describe("#855 sibling: every public agent route still works with no token", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(async () => {
    await relay.close();
  });

  it.each(PUBLIC_AGENT_ROUTES.map((e) => [`${e.method} ${e.path}`, e] as const))(
    "%s",
    async (_label, e) => {
      const res = await send(relay, [e.method, concrete(e.path)]);
      const text = await res.clone().text();
      expect(res.status, `rate-limited, proves nothing: ${text}`).not.toBe(429);
      expect(await refusedByCatchAll(res), `refused by the catch-all: ${text}`).toBe(false);
      expect(await refusedByAgentDoor(res), `refused by the agent door: ${text}`).toBe(false);
      if (e.method === "GET") {
        // HEAD of a public GET is public: past both doors it is answered as its GET.
        const head = await send(relay, ["HEAD", concrete(e.path)]);
        expect(head.status, `HEAD answered unlike its GET (${res.status})`).toBe(res.status);
      }
    },
  );
});

describe("#855 sibling: PUBLIC_AGENT_ROUTES against the relay's registered routes", () => {
  let relay: SyncRelay;
  let ordered: Array<{ method: string; path: string; index: number }>;

  beforeAll(async () => {
    relay = await createTestRelay();
    ordered = relay.app.routes
      .map((r, index) => ({ method: r.method, path: r.path, index }))
      .filter((r) => r.method !== "ALL" && r.path.startsWith("/api/v1/agents/"));
  });
  afterAll(async () => {
    await relay.close();
  });

  const key = (method: string, path: string): string => `${method} ${shape(path).join("/")}`;

  it.each(PUBLIC_AGENT_ROUTES.map((e) => [`${e.method} ${e.path}`, e] as const))(
    "%s names a registered route",
    (_label, e) => {
      expect(ordered.some((r) => key(r.method, r.path) === key(e.method, e.path))).toBe(true);
    },
  );

  it("every route main's closures made public for an ordinary id is still public, and nothing more", () => {
    // main's PUBLIC_AGENT_ROUTES closures, verbatim in effect. Over the
    // registered routes with ordinary `probe-…` ids they name exactly the
    // routes the entries were meant for; the over-matches need a crafted id.
    const mainPublic = (p: string, m: string): boolean =>
      p === "/api/v1/agents/bootstrap" ||
      (p.endsWith("/succession") && m === "GET") ||
      (p === "/api/v1/agents/discover" && m === "GET") ||
      (p === "/api/v1/agents/revocations" && m === "GET") ||
      p.endsWith("/credentials/submit") ||
      (/\/devices\/[^/]+\/hardware-attestation$/.test(p) && m === "POST") ||
      (p.endsWith("/debit") && m === "POST") ||
      (p.endsWith("/solvency-proof") && m === "GET");
    const lost = ordered
      .filter((r) => mainPublic(concrete(r.path), r.method))
      .filter((r) => !isPublicAgentRoute(r.method, concrete(r.path)))
      .map((r) => `${r.method} ${r.path}`);
    expect(lost).toEqual([]);
    const gained = PUBLIC_AGENT_ROUTES.filter((e) => !mainPublic(concrete(e.path), e.method)).map(
      (e) => `${e.method} ${e.path}`,
    );
    expect(gained).toEqual([]);
  });

  it("no public entry reaches a route it does not name (Hono serves the first-registered match)", () => {
    const declared = new Set(PUBLIC_AGENT_ROUTES.map((e) => key(e.method, e.path)));
    const reached: string[] = [];
    for (const e of PUBLIC_AGENT_ROUTES) {
      const own = ordered.filter((r) => key(r.method, r.path) === key(e.method, e.path));
      const first = Math.min(...own.map((r) => r.index));
      for (const r of ordered) {
        if (r.method !== e.method || declared.has(key(r.method, r.path))) continue;
        // A shared path goes to the earlier registration: the entry reaches an
        // undeclared route only if that route is registered first.
        if (intersects(e.path, r.path) && r.index < first) {
          reached.push(`${e.method} ${e.path} reaches ${r.path}`);
        }
      }
    }
    expect(reached).toEqual([]);
  });

  it("the literal public routes that share paths with GET /api/v1/agents/:motebitId are registered first", () => {
    const idx = (p: string): number =>
      ordered.find((r) => r.method === "GET" && r.path === p)?.index ?? Infinity;
    expect(idx("/api/v1/agents/discover")).toBeLessThan(idx("/api/v1/agents/:motebitId"));
    expect(idx("/api/v1/agents/revocations")).toBeLessThan(idx("/api/v1/agents/:motebitId"));
  });
});
