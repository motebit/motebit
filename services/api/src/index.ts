import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  CloudProvider,
  runTurn,
} from "@mote/ai-core";
import type { CloudProviderConfig, MoteLoopDependencies } from "@mote/ai-core";
import { EventStore, InMemoryEventStore } from "@mote/event-log";
import { MemoryGraph, InMemoryMemoryStorage } from "@mote/memory-graph";
import { StateVectorEngine } from "@mote/state-vector";
import { BehaviorEngine } from "@mote/behavior-engine";

// === Factory ===

export interface MoteServer {
  app: Hono;
  deps: MoteLoopDependencies;
}

/**
 * Create a fully-wired Hono app backed by in-memory stores.
 * In production the adapters would be swapped for persistent ones.
 */
export function createMoteServer(moteId: string, apiKey: string): MoteServer {
  const cloudConfig: CloudProviderConfig = {
    provider: "anthropic",
    api_key: apiKey,
    model: "claude-sonnet-4-5-20250514",
  };

  const eventStore = new EventStore(new InMemoryEventStore());
  const storage = new InMemoryMemoryStorage();
  const memoryGraph = new MemoryGraph(storage, eventStore, moteId);
  const stateEngine = new StateVectorEngine();
  const behaviorEngine = new BehaviorEngine();
  const cloudProvider = new CloudProvider(cloudConfig);

  const deps: MoteLoopDependencies = {
    moteId,
    eventStore,
    memoryGraph,
    stateEngine,
    behaviorEngine,
    cloudProvider,
  };

  const app = new Hono();

  // Middleware
  app.use("*", cors());

  // Health check
  app.get("/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));

  // === Message Route (wired to orchestrator) ===

  app.post("/api/v1/message/:moteId", async (c) => {
    const body = await c.req.json<{ message: string }>();
    const result = await runTurn(deps, body.message);
    return c.json({
      mote_id: moteId,
      response: result.response,
      memories_formed: result.memoriesFormed,
      state: result.stateAfter,
      cues: result.cues,
    });
  });

  // === Identity Routes ===

  app.post("/api/v1/identity", async (c) => {
    const body = await c.req.json<{ owner_id: string }>();
    // TODO: create identity via IdentityManager
    return c.json({
      mote_id: crypto.randomUUID(),
      created_at: Date.now(),
      owner_id: body.owner_id,
      version_clock: 0,
    }, 201);
  });

  app.get("/api/v1/identity/:moteId", async (c) => {
    const id = c.req.param("moteId");
    // TODO: load identity via IdentityManager
    return c.json({ mote_id: id, status: "found" });
  });

  // === Memory Routes (wired to MemoryGraph) ===

  app.get("/api/v1/memory/:moteId", async (c) => {
    const exported = await memoryGraph.exportAll();
    return c.json({
      mote_id: moteId,
      memories: exported.nodes,
      edges: exported.edges,
    });
  });

  app.post("/api/v1/memory/:moteId", async (c) => {
    const body = await c.req.json<{ content: string; sensitivity?: string }>();
    // TODO: form memory via MemoryGraph with proper sensitivity parsing
    return c.json({ mote_id: moteId, node_id: crypto.randomUUID(), content: body.content }, 201);
  });

  app.delete("/api/v1/memory/:moteId/:nodeId", async (c) => {
    const nodeId = c.req.param("nodeId");
    await memoryGraph.deleteMemory(nodeId);
    return c.json({ mote_id: moteId, node_id: nodeId, deleted: true });
  });

  // === State Routes (wired to StateVectorEngine) ===

  app.get("/api/v1/state/:moteId", async (c) => {
    const state = stateEngine.getState();
    return c.json({ mote_id: moteId, state });
  });

  // === Sync Routes ===

  app.post("/api/v1/sync/:moteId/push", async (c) => {
    const body = await c.req.json<{ events: unknown[] }>();
    // TODO: accept events via SyncEngine
    return c.json({ mote_id: moteId, accepted: body.events.length });
  });

  app.get("/api/v1/sync/:moteId/pull", async (c) => {
    const afterClock = Number(c.req.query("after_clock") ?? "0");
    // TODO: return events from EventStore via SyncEngine
    return c.json({ mote_id: moteId, events: [], after_clock: afterClock });
  });

  // === Export Routes ===

  app.get("/api/v1/export/:moteId", async (c) => {
    // TODO: export via PrivacyLayer
    return c.json({ mote_id: moteId, exported_at: Date.now() });
  });

  // === Delete Routes ===

  app.post("/api/v1/delete/:moteId", async (c) => {
    // TODO: full data deletion via PrivacyLayer + Crypto
    return c.json({ mote_id: moteId, deletion_requested: true });
  });

  return { app, deps };
}

// === Default app for standalone use ===

const moteId = process.env.MOTE_ID ?? "default-mote";
const apiKey = process.env.ANTHROPIC_API_KEY ?? "";

const { app } = createMoteServer(moteId, apiKey);

export default app;
export { app };
