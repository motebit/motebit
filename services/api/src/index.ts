import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  CloudProvider,
  runTurn,
} from "@motebit/ai-core";
import type { CloudProviderConfig, MotebitLoopDependencies } from "@motebit/ai-core";
import { EventStore } from "@motebit/event-log";
import { MemoryGraph, embedText } from "@motebit/memory-graph";
import { StateVectorEngine } from "@motebit/state-vector";
import { BehaviorEngine } from "@motebit/behavior-engine";
import { createMotebitDatabase } from "@motebit/persistence";
import type { MotebitDatabase } from "@motebit/persistence";
import { IdentityManager } from "@motebit/core-identity";
import { PrivacyLayer } from "@motebit/privacy-layer";
import { SyncEngine } from "@motebit/sync-engine";
import { SensitivityLevel } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";

// === Config & Types ===

export interface MotebitServerConfig {
  motebitId: string;
  apiKey: string;
  dbPath?: string; // default ":memory:" for tests
}

export interface MotebitServer {
  app: Hono;
  deps: MotebitLoopDependencies;
  close(): void;
}

// === Factory ===

/**
 * Create a fully-wired Hono app backed by SQLite persistence.
 */
export function createMotebitServer(config: MotebitServerConfig): MotebitServer {
  const { motebitId, apiKey, dbPath = ":memory:" } = config;

  const cloudConfig: CloudProviderConfig = {
    provider: "anthropic",
    api_key: apiKey,
    model: "claude-sonnet-4-5-20250514",
  };

  // Persistence
  const moteDb: MotebitDatabase = createMotebitDatabase(dbPath);

  // Core services
  const eventStore = new EventStore(moteDb.eventStore);
  const memoryGraph = new MemoryGraph(moteDb.memoryStorage, eventStore, motebitId);
  const identityManager = new IdentityManager(moteDb.identityStorage, eventStore);
  const privacyLayer = new PrivacyLayer(
    moteDb.memoryStorage,
    memoryGraph,
    eventStore,
    moteDb.auditLog,
    motebitId,
  );
  const syncEngine = new SyncEngine(moteDb.eventStore, motebitId);

  // AI/behavior
  const stateEngine = new StateVectorEngine();
  const behaviorEngine = new BehaviorEngine();
  const cloudProvider = new CloudProvider(cloudConfig);

  const deps: MotebitLoopDependencies = {
    motebitId,
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

  app.post("/api/v1/message/:motebitId", async (c) => {
    const body = await c.req.json<{ message: string }>();
    const result = await runTurn(deps, body.message);
    return c.json({
      motebit_id: motebitId,
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

  app.get("/api/v1/identity/:motebitId", async (c) => {
    const id = c.req.param("motebitId");
    const identity = await identityManager.load(id);
    if (!identity) {
      return c.json({ error: "identity not found" }, 404);
    }
    return c.json(identity);
  });

  // === Memory Routes ===

  app.get("/api/v1/memory/:motebitId", async (c) => {
    const exported = await memoryGraph.exportAll();
    return c.json({
      motebit_id: motebitId,
      memories: exported.nodes,
      edges: exported.edges,
    });
  });

  app.post("/api/v1/memory/:motebitId", async (c) => {
    const body = await c.req.json<{ content: string; sensitivity?: string }>();
    const sensitivity = parseSensitivity(body.sensitivity);
    const embedding = await embedText(body.content);
    const node = await memoryGraph.formMemory(
      { content: body.content, confidence: 1.0, sensitivity },
      embedding,
    );
    return c.json(node, 201);
  });

  app.delete("/api/v1/memory/:motebitId/:nodeId", async (c) => {
    const nodeId = c.req.param("nodeId");
    await memoryGraph.deleteMemory(nodeId);
    return c.json({ motebit_id: motebitId, node_id: nodeId, deleted: true });
  });

  // === State Routes ===

  app.get("/api/v1/state/:motebitId", async (c) => {
    const state = stateEngine.getState();
    return c.json({ motebit_id: motebitId, state });
  });

  // === Sync Routes ===

  app.post("/api/v1/sync/:motebitId/push", async (c) => {
    const body = await c.req.json<{ events: EventLogEntry[] }>();
    for (const event of body.events) {
      await eventStore.append(event);
    }
    return c.json({ motebit_id: motebitId, accepted: body.events.length });
  });

  app.get("/api/v1/sync/:motebitId/pull", async (c) => {
    const afterClock = Number(c.req.query("after_clock") ?? "0");
    const events = await eventStore.query({
      motebit_id: motebitId,
      after_version_clock: afterClock,
    });
    return c.json({ motebit_id: motebitId, events, after_clock: afterClock });
  });

  // === Export Route ===

  app.get("/api/v1/export/:motebitId", async (c) => {
    const id = c.req.param("motebitId");
    const identity = await identityManager.load(id);
    if (!identity) {
      return c.json({ error: "identity not found" }, 404);
    }
    const manifest = await privacyLayer.exportAll(identity);
    return c.json(manifest);
  });

  // === Delete Route ===

  app.post("/api/v1/delete/:motebitId", async (c) => {
    const id = c.req.param("motebitId");
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
      motebit_id: id,
      timestamp: Date.now(),
      event_type: "delete_requested" as EventLogEntry["event_type"],
      payload: { deleted_by: body.deleted_by, memories_deleted: deletionCertificates.length },
      version_clock: clock + 1,
      tombstoned: false,
    });

    return c.json({ motebit_id: id, deletion_certificates: deletionCertificates });
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

const { app } = createMotebitServer({
  motebitId: process.env.MOTEBIT_ID ?? "default-mote",
  apiKey: process.env.ANTHROPIC_API_KEY ?? "",
  dbPath: process.env.MOTEBIT_DB_PATH,
});

export default app;
export { app };
