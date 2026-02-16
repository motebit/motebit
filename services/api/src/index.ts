import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  CloudProvider,
  runTurn,
} from "@mote/ai-core";
import type { CloudProviderConfig, MoteLoopDependencies } from "@mote/ai-core";
import { EventStore } from "@mote/event-log";
import { MemoryGraph, embedText } from "@mote/memory-graph";
import { StateVectorEngine } from "@mote/state-vector";
import { BehaviorEngine } from "@mote/behavior-engine";
import { createMoteDatabase } from "@mote/persistence";
import type { MoteDatabase } from "@mote/persistence";
import { IdentityManager } from "@mote/core-identity";
import { PrivacyLayer } from "@mote/privacy-layer";
import { SyncEngine } from "@mote/sync-engine";
import { SensitivityLevel } from "@mote/sdk";
import type { EventLogEntry } from "@mote/sdk";

// === Config & Types ===

export interface MoteServerConfig {
  moteId: string;
  apiKey: string;
  dbPath?: string; // default ":memory:" for tests
}

export interface MoteServer {
  app: Hono;
  deps: MoteLoopDependencies;
  close(): void;
}

// === Factory ===

/**
 * Create a fully-wired Hono app backed by SQLite persistence.
 */
export function createMoteServer(config: MoteServerConfig): MoteServer {
  const { moteId, apiKey, dbPath = ":memory:" } = config;

  const cloudConfig: CloudProviderConfig = {
    provider: "anthropic",
    api_key: apiKey,
    model: "claude-sonnet-4-5-20250514",
  };

  // Persistence
  const moteDb: MoteDatabase = createMoteDatabase(dbPath);

  // Core services
  const eventStore = new EventStore(moteDb.eventStore);
  const memoryGraph = new MemoryGraph(moteDb.memoryStorage, eventStore, moteId);
  const identityManager = new IdentityManager(moteDb.identityStorage, eventStore);
  const privacyLayer = new PrivacyLayer(
    moteDb.memoryStorage,
    memoryGraph,
    eventStore,
    moteDb.auditLog,
    moteId,
  );
  const syncEngine = new SyncEngine(moteDb.eventStore, moteId);

  // AI/behavior
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
    const identity = await identityManager.create(body.owner_id);
    return c.json(identity, 201);
  });

  app.get("/api/v1/identity/:moteId", async (c) => {
    const id = c.req.param("moteId");
    const identity = await identityManager.load(id);
    if (!identity) {
      return c.json({ error: "identity not found" }, 404);
    }
    return c.json(identity);
  });

  // === Memory Routes ===

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
    const sensitivity = parseSensitivity(body.sensitivity);
    const embedding = await embedText(body.content);
    const node = await memoryGraph.formMemory(
      { content: body.content, confidence: 1.0, sensitivity },
      embedding,
    );
    return c.json(node, 201);
  });

  app.delete("/api/v1/memory/:moteId/:nodeId", async (c) => {
    const nodeId = c.req.param("nodeId");
    await memoryGraph.deleteMemory(nodeId);
    return c.json({ mote_id: moteId, node_id: nodeId, deleted: true });
  });

  // === State Routes ===

  app.get("/api/v1/state/:moteId", async (c) => {
    const state = stateEngine.getState();
    return c.json({ mote_id: moteId, state });
  });

  // === Sync Routes ===

  app.post("/api/v1/sync/:moteId/push", async (c) => {
    const body = await c.req.json<{ events: EventLogEntry[] }>();
    for (const event of body.events) {
      await eventStore.append(event);
    }
    return c.json({ mote_id: moteId, accepted: body.events.length });
  });

  app.get("/api/v1/sync/:moteId/pull", async (c) => {
    const afterClock = Number(c.req.query("after_clock") ?? "0");
    const events = await eventStore.query({
      mote_id: moteId,
      after_version_clock: afterClock,
    });
    return c.json({ mote_id: moteId, events, after_clock: afterClock });
  });

  // === Export Route ===

  app.get("/api/v1/export/:moteId", async (c) => {
    const id = c.req.param("moteId");
    const identity = await identityManager.load(id);
    if (!identity) {
      return c.json({ error: "identity not found" }, 404);
    }
    const manifest = await privacyLayer.exportAll(identity);
    return c.json(manifest);
  });

  // === Delete Route ===

  app.post("/api/v1/delete/:moteId", async (c) => {
    const id = c.req.param("moteId");
    const body = await c.req.json<{ deleted_by: string }>();

    const identity = await identityManager.load(id);
    if (!identity) {
      return c.json({ error: "identity not found" }, 404);
    }

    // Get all memories, delete each one
    const memories = await privacyLayer.listMemories();
    const deletionCertificates = [];
    for (const mem of memories) {
      const cert = await privacyLayer.deleteMemory(mem.node_id, body.deleted_by);
      deletionCertificates.push(cert);
    }

    // Record a DeleteRequested event
    const clock = await eventStore.getLatestClock(id);
    await eventStore.append({
      event_id: crypto.randomUUID(),
      mote_id: id,
      timestamp: Date.now(),
      event_type: "delete_requested" as EventLogEntry["event_type"],
      payload: { deleted_by: body.deleted_by, memories_deleted: deletionCertificates.length },
      version_clock: clock + 1,
      tombstoned: false,
    });

    return c.json({ mote_id: id, deletion_certificates: deletionCertificates });
  });

  function close(): void {
    syncEngine.stop();
    moteDb.close();
  }

  return { app, deps, close };
}

// === Helpers ===

function parseSensitivity(value?: string): SensitivityLevel {
  if (!value) return SensitivityLevel.None;
  const valid = Object.values(SensitivityLevel) as string[];
  if (valid.includes(value)) {
    return value as SensitivityLevel;
  }
  return SensitivityLevel.None;
}

// === Default app for standalone use ===

const { app } = createMoteServer({
  moteId: process.env.MOTE_ID ?? "default-mote",
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  dbPath: process.env.MOTE_DB_PATH,
});

export default app;
export { app };
