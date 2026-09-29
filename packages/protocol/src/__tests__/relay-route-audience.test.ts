/**
 * `RELAY_ROUTE_AUDIENCES` / `relayRouteAudience` — the route → audience table
 * clients resolve from. The relay-side proof that each entry is what the relay
 * actually verifies lives in services/relay (route-audience-conformance.test.ts);
 * these pin the table's shape and the matcher's semantics.
 */
import { describe, expect, it } from "vitest";

import {
  ALL_TOKEN_AUDIENCES,
  RELAY_PUBLIC_ROUTES,
  RELAY_ROUTE_AUDIENCES,
  relayRouteAudience,
} from "../index.js";

describe("RELAY_ROUTE_AUDIENCES", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(RELAY_ROUTE_AUDIENCES)).toBe(true);
  });

  it("names only registered audiences", () => {
    for (const e of RELAY_ROUTE_AUDIENCES) {
      expect(ALL_TOKEN_AUDIENCES).toContain(e.audience);
    }
  });

  it("has no duplicate method + path", () => {
    const keys = RELAY_ROUTE_AUDIENCES.map((e) => `${e.method} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never names an audience the relay does not accept inbound", () => {
    // task:dispatch is verified by a worker, runtime:attach by the local
    // runtime-host, browser-sandbox by the sandbox, mcp:call by a motebit
    // MCP server — never by a relay route.
    const inboundNever = new Set([
      "task:dispatch",
      "runtime:attach",
      "browser-sandbox",
      "mcp:call",
    ]);
    for (const e of RELAY_ROUTE_AUDIENCES) expect(inboundNever.has(e.audience)).toBe(false);
  });
});

describe("relayRouteAudience", () => {
  it("resolves the #827 routes to what the relay verifies", () => {
    expect(relayRouteAudience("PATCH", "/api/v1/agents/m1/sweep-config")).toBe("admin:query");
    expect(relayRouteAudience("GET", "/api/v1/agents/m1/balance")).toBe("account:balance");
    expect(relayRouteAudience("GET", "/api/v1/proposals?status=active")).toBe("proposal");
    expect(relayRouteAudience("POST", "/pairing/initiate")).toBe("device:auth");
    expect(relayRouteAudience("POST", "/api/v1/agents/push-token")).toBe("push:register");
    expect(relayRouteAudience("DELETE", "/api/v1/agents/push-token")).toBe("push:register");
  });

  it("returns undefined for a public route, even where a :param sibling would match", () => {
    expect(Object.isFrozen(RELAY_PUBLIC_ROUTES)).toBe(true);
    for (const r of RELAY_PUBLIC_ROUTES) {
      const concrete = r.path.replace(/:[A-Za-z]+/g, "x");
      expect(relayRouteAudience(r.method, concrete), `${r.method} ${r.path}`).toBeUndefined();
    }
    // `GET /api/v1/agents/:motebitId` (admin:query) must not swallow these.
    expect(relayRouteAudience("GET", "/api/v1/agents/discover")).toBeUndefined();
    expect(relayRouteAudience("GET", "/api/v1/agents/revocations")).toBeUndefined();
  });

  it("returns undefined for a route that does not exist or takes no device token", () => {
    // #827: there is no per-agent proposals route.
    expect(relayRouteAudience("GET", "/api/v1/agents/m1/proposals")).toBeUndefined();
    // Master-token-only state export.
    expect(relayRouteAudience("GET", "/api/v1/goals/m1")).toBeUndefined();
  });

  it("resolves HEAD exactly as GET (servers answer HEAD with the GET handler)", () => {
    for (const e of RELAY_ROUTE_AUDIENCES.filter((r) => r.method === "GET")) {
      const concrete = e.path.replace(/:[A-Za-z]+/g, "x");
      expect(relayRouteAudience("HEAD", concrete), e.path).toBe(e.audience);
      expect(relayRouteAudience("head", concrete), e.path).toBe(e.audience);
    }
    expect(relayRouteAudience("HEAD", "/api/v1/agents/discover")).toBeUndefined();
  });

  it("matches the method, case-insensitively", () => {
    expect(relayRouteAudience("get", "/api/v1/agents/m1/withdrawals")).toBe("account:withdrawals");
    expect(relayRouteAudience("GET", "/api/v1/agents/m1/withdraw")).toBeUndefined();
    expect(relayRouteAudience("POST", "/api/v1/agents/m1/withdraw")).toBe("account:withdraw");
  });

  it("prefers the more literal pattern over a :param sibling", () => {
    // `/api/v1/agents/:motebitId` would also match; the literal route wins.
    expect(relayRouteAudience("GET", "/api/v1/agents/m1")).toBe("admin:query");
    expect(relayRouteAudience("GET", "/agent/m1/task/t1")).toBe("task:query");
    expect(relayRouteAudience("POST", "/agent/m1/task/t1/result")).toBe("task:result");
  });

  it("requires every segment to match (no prefix match)", () => {
    expect(relayRouteAudience("GET", "/api/v1/agents/m1/balance/extra")).toBeUndefined();
    expect(relayRouteAudience("GET", "/api/v1/agents/m1/receipts/t1")).toBe("receipts:read");
  });
});
