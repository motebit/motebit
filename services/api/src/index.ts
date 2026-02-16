import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { rateLimiter } from "hono-rate-limiter";
import {
  CloudProvider,
  runTurn,
  runTurnStreaming,
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
import { SensitivityLevel } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";

// === Config & Types ===

export interface MotebitServerConfig {
  motebitId: string;
  apiKey: string;
  dbPath?: string; // default ":memory:" for tests
  apiToken?: string; // bearer token for auth; undefined = no auth enforced
  corsOrigin?: string; // CORS origin; defaults to "*"
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
  const { motebitId, apiKey, dbPath = ":memory:", apiToken, corsOrigin = "*" } = config;

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
    provider: cloudProvider,
  };

  const app = new Hono();

  // === Middleware Stack ===

  // 1. Secure headers (all routes)
  app.use("*", secureHeaders());

  // 2. CORS (configurable origin)
  app.use("*", cors({ origin: corsOrigin }));

  // 3. Rate limiting — tight limit for expensive AI routes
  app.use(
    "/api/v1/message/*",
    rateLimiter({
      windowMs: 60 * 1000,
      limit: 20,
      keyGenerator: (c) => c.req.header("x-forwarded-for") ?? "anonymous",
    }),
  );

  // 3b. Rate limiting — general API routes
  app.use(
    "/api/*",
    rateLimiter({
      windowMs: 60 * 1000,
      limit: 200,
      keyGenerator: (c) => c.req.header("x-forwarded-for") ?? "anonymous",
    }),
  );

  // 4. Bearer auth on /api/* (skipped when apiToken is undefined)
  if (apiToken) {
    app.use("/api/*", bearerAuth({ token: apiToken }));
  }

  // === Global Error Handler ===

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message, status: err.status }, err.status);
    }
    console.error(err);
    return c.json({ error: "Internal server error", status: 500 }, 500);
  });

  // Health check (public — before /api/* auth)
  app.get("/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));

  // === Message Route (wired to orchestrator) ===

  app.post("/api/v1/message/:motebitId", async (c) => {
    const body = await c.req.json<{ message: string }>();
    if (!body.message || typeof body.message !== "string" || body.message.trim() === "") {
      throw new HTTPException(400, { message: "Missing or empty 'message' field" });
    }

    try {
      const result = await runTurn(deps, body.message);
      return c.json({
        motebit_id: motebitId,
        response: result.response,
        memories_formed: result.memoriesFormed,
        state: result.stateAfter,
        cues: result.cues,
      });
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      console.error("AI provider error:", err);
      throw new HTTPException(502, { message: "AI provider error" });
    }
  });

  // === Streaming Message Route ===

  app.post("/api/v1/message/:motebitId/stream", async (c) => {
    const body = await c.req.json<{ message: string }>();
    if (!body.message || typeof body.message !== "string" || body.message.trim() === "") {
      throw new HTTPException(400, { message: "Missing or empty 'message' field" });
    }

    return streamSSE(
      c,
      async (stream) => {
        for await (const chunk of runTurnStreaming(deps, body.message)) {
          if (chunk.type === "text") {
            await stream.writeSSE({ event: "text", data: chunk.text });
          } else {
            await stream.writeSSE({
              event: "done",
              data: JSON.stringify({
                motebit_id: motebitId,
                response: chunk.result.response,
                memories_formed: chunk.result.memoriesFormed,
                state: chunk.result.stateAfter,
                cues: chunk.result.cues,
              }),
            });
          }
        }
      },
      async (err, stream) => {
        console.error("Streaming error:", err);
        await stream.writeSSE({
          event: "error",
          data: err.message,
        });
      },
    );
  });

  // === Identity Routes ===

  app.post("/api/v1/identity", async (c) => {
    const body = await c.req.json<{ owner_id: string }>();
    if (!body.owner_id || typeof body.owner_id !== "string" || body.owner_id.trim() === "") {
      throw new HTTPException(400, { message: "Missing or empty 'owner_id' field" });
    }
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
    if (!body.content || typeof body.content !== "string" || body.content.trim() === "") {
      throw new HTTPException(400, { message: "Missing or empty 'content' field" });
    }

    try {
      const sensitivity = parseSensitivity(body.sensitivity);
      const embedding = await embedText(body.content);
      const node = await memoryGraph.formMemory(
        { content: body.content, confidence: 1.0, sensitivity },
        embedding,
      );
      return c.json(node, 201);
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      console.error("Embedding error:", err);
      throw new HTTPException(502, { message: "AI provider error" });
    }
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
    if (!Array.isArray(body.events)) {
      throw new HTTPException(400, { message: "Missing or invalid 'events' field (must be array)" });
    }
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

  app.get("/api/v1/sync/:motebitId/clock", async (c) => {
    const clock = await eventStore.getLatestClock(motebitId);
    return c.json({ motebit_id: motebitId, latest_clock: clock });
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
    if (!body.deleted_by || typeof body.deleted_by !== "string" || body.deleted_by.trim() === "") {
      throw new HTTPException(400, { message: "Missing or empty 'deleted_by' field" });
    }

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

function createDefaultApp(): Hono {
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
  if (!anthropicKey) {
    console.error("FATAL: ANTHROPIC_API_KEY is required");
    process.exit(1);
  }

  const token = process.env.MOTEBIT_API_TOKEN;
  if (!token) {
    console.warn("WARNING: MOTEBIT_API_TOKEN not set — API auth is disabled");
  }

  return createMotebitServer({
    motebitId: process.env.MOTEBIT_ID ?? "default-motebit",
    apiKey: anthropicKey,
    dbPath: process.env.MOTEBIT_DB_PATH,
    apiToken: token,
    corsOrigin: process.env.MOTEBIT_CORS_ORIGIN,
  }).app;
}

// Skip standalone initialization during tests (vitest sets VITEST env var)
const app = process.env.VITEST ? new Hono() : createDefaultApp();

export default app;
export { app };
