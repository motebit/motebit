import { Hono } from "hono";
import { cors } from "hono/cors";

const app = new Hono();

// Middleware
app.use("*", cors());

// Health check
app.get("/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));

// === Identity Routes ===

app.post("/api/v1/identity", async (c) => {
  const body = await c.req.json<{ owner_id: string }>();
  // In production: create identity via IdentityManager
  return c.json({
    mote_id: crypto.randomUUID(),
    created_at: Date.now(),
    owner_id: body.owner_id,
    version_clock: 0,
  }, 201);
});

app.get("/api/v1/identity/:moteId", async (c) => {
  const moteId = c.req.param("moteId");
  // In production: load identity via IdentityManager
  return c.json({ mote_id: moteId, status: "found" });
});

// === Memory Routes ===

app.get("/api/v1/memory/:moteId", async (c) => {
  const moteId = c.req.param("moteId");
  const limit = Number(c.req.query("limit") ?? "50");
  // In production: query via PrivacyLayer
  return c.json({ mote_id: moteId, memories: [], limit });
});

app.post("/api/v1/memory/:moteId", async (c) => {
  const moteId = c.req.param("moteId");
  const body = await c.req.json<{ content: string; sensitivity?: string }>();
  // In production: form memory via MemoryGraph
  return c.json({ mote_id: moteId, node_id: crypto.randomUUID(), content: body.content }, 201);
});

app.delete("/api/v1/memory/:moteId/:nodeId", async (c) => {
  const moteId = c.req.param("moteId");
  const nodeId = c.req.param("nodeId");
  // In production: delete via PrivacyLayer
  return c.json({ mote_id: moteId, node_id: nodeId, deleted: true });
});

// === State Routes ===

app.get("/api/v1/state/:moteId", async (c) => {
  const moteId = c.req.param("moteId");
  // In production: get from StateVectorEngine
  return c.json({ mote_id: moteId, state: {} });
});

// === Sync Routes ===

app.post("/api/v1/sync/:moteId/push", async (c) => {
  const moteId = c.req.param("moteId");
  const body = await c.req.json<{ events: unknown[] }>();
  // In production: accept events via SyncEngine
  return c.json({ mote_id: moteId, accepted: body.events.length });
});

app.get("/api/v1/sync/:moteId/pull", async (c) => {
  const moteId = c.req.param("moteId");
  const afterClock = Number(c.req.query("after_clock") ?? "0");
  // In production: return events from EventStore
  return c.json({ mote_id: moteId, events: [], after_clock: afterClock });
});

// === Export Routes ===

app.get("/api/v1/export/:moteId", async (c) => {
  const moteId = c.req.param("moteId");
  // In production: export via PrivacyLayer
  return c.json({ mote_id: moteId, exported_at: Date.now() });
});

// === Delete Routes ===

app.post("/api/v1/delete/:moteId", async (c) => {
  const moteId = c.req.param("moteId");
  // In production: full data deletion via PrivacyLayer + Crypto
  return c.json({ mote_id: moteId, deletion_requested: true });
});

export default app;
export { app };
