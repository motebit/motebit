/**
 * The relay keeps its own record of master-token presentations and refused
 * signed tokens — proven posture, not a log tail. No token bytes, no IP.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
// eslint-disable-next-line no-restricted-imports -- tests need direct keypair generation
import { generateKeypair, bytesToHex, createSignedToken } from "@motebit/encryption";
import type { SyncRelay } from "../index.js";
import { AUTH_EVENT_RETENTION_MS, createAuthEventSink } from "../auth-events.js";
import { AUTH_HEADER, JSON_AUTH, createTestRelay, createAgent } from "./test-helpers.js";

describe("relay auth-event record", () => {
  let relay: SyncRelay;
  beforeEach(async () => {
    relay = await createTestRelay();
  });
  afterEach(async () => {
    await relay.close();
  });

  it("records every master-token presentation with route + method, never the token or an IP", async () => {
    await relay.app.request("/api/v1/admin/health", {
      headers: { ...AUTH_HEADER, "x-forwarded-for": "203.0.113.9", "x-correlation-id": "corr-1" },
    });
    const rows = relay.moteDb.db
      .prepare("SELECT * FROM relay_auth_events WHERE kind = 'master_token'")
      .all() as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows.find((r) => r["path"] === "/api/v1/admin/health")!;
    expect(row).toBeDefined();
    expect(row["method"]).toBe("GET");
    expect(row["correlation_id"]).toBe("corr-1");
    // Columns are the whole schema: nothing to hold an IP or a token.
    const cols = (
      relay.moteDb.db.prepare("PRAGMA table_info(relay_auth_events)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toEqual([
      "id",
      "at",
      "kind",
      "method",
      "path",
      "motebit_id",
      "audience",
      "reason",
      "correlation_id",
    ]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("203.0.113.9");
    expect(serialized).not.toContain(AUTH_HEADER.Authorization.replace("Bearer ", ""));
  });

  it("records a refused signed token on an agent route with its reason, audience and claimed motebit id", async () => {
    const kp = await generateKeypair();
    const agent = await createAgent(relay, bytesToHex((await generateKeypair()).publicKey));
    // Signed by a key the relay does not know for this identity ⇒ refused.
    const bogus = await createSignedToken(
      {
        mid: agent.motebitId,
        did: agent.deviceId,
        iat: Date.now(),
        exp: Date.now() + 60_000,
        jti: crypto.randomUUID(),
        aud: "admin:query",
      },
      kp.privateKey,
    );
    const res = await relay.app.request(`/api/v1/agents/${agent.motebitId}`, {
      headers: { Authorization: `Bearer ${bogus}` },
    });
    expect(res.status).toBe(401);
    const row = relay.moteDb.db
      .prepare(
        "SELECT * FROM relay_auth_events WHERE kind = 'agent_token_rejected' ORDER BY id DESC",
      )
      .get() as Record<string, unknown>;
    expect(row["motebit_id"]).toBe(agent.motebitId);
    expect(row["audience"]).toBe("admin:query");
    expect(typeof row["reason"]).toBe("string");
    expect(row["path"]).toBe(`/api/v1/agents/${agent.motebitId}`);
  });

  it("GET /api/v1/admin/auth-events answers the operator's question from the record", async () => {
    await relay.app.request("/api/v1/admin/health", { headers: AUTH_HEADER });
    const res = await relay.app.request("/api/v1/admin/auth-events?since_hours=1", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts_by_kind: Record<string, number>;
      master_token: { total: number; by_path: Array<{ path: string; count: number }> };
      recent: Array<Record<string, unknown>>;
    };
    expect(body.master_token.total).toBeGreaterThanOrEqual(1);
    expect(body.master_token.by_path.some((p) => p.path === "/api/v1/admin/health")).toBe(true);
    expect(body.counts_by_kind.master_token).toBeGreaterThanOrEqual(1);
    for (const r of body.recent) {
      expect(r).not.toHaveProperty("ip");
      expect(r).not.toHaveProperty("token");
    }
    // The health summary carries the 24h counts too, so the daily look sees it.
    const health = (await (
      await relay.app.request("/api/v1/admin/health", { headers: AUTH_HEADER })
    ).json()) as { auth_events_24h?: Record<string, number> };
    expect(health.auth_events_24h?.master_token).toBeGreaterThanOrEqual(1);
    // And the route is operator-only: no bearer ⇒ refused.
    expect((await relay.app.request("/api/v1/admin/auth-events")).status).toBe(401);
  });

  it("sweeps rows past the 30-day window and keeps the rest", () => {
    const sink = createAuthEventSink(relay.moteDb.db);
    const now = Date.now();
    relay.moteDb.db
      .prepare(
        "INSERT INTO relay_auth_events (at, kind, method, path) VALUES (?, 'master_token', 'GET', '/old')",
      )
      .run(now - AUTH_EVENT_RETENTION_MS - 1000);
    sink.record({ kind: "master_token", method: "GET", path: "/new" });
    const removed = sink.sweep(now);
    expect(removed).toBe(1);
    const left = relay.moteDb.db
      .prepare("SELECT path FROM relay_auth_events WHERE path IN ('/old','/new')")
      .all() as Array<{ path: string }>;
    expect(left.map((r) => r.path)).toEqual(["/new"]);
  });

  it("a failing write never fails the request it describes", async () => {
    relay.moteDb.db.exec("DROP TABLE relay_auth_events");
    const res = await relay.app.request("/api/v1/admin/health", { headers: JSON_AUTH });
    expect(res.status).toBe(200);
  });
});
