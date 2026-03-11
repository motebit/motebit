/**
 * @motebit/api — Sync relay
 *
 * Thin event relay for cross-device sync. No AI, no memory, no state.
 * Devices run MotebitRuntime locally; this server is just an event mailbox.
 *
 * Endpoints:
 *   GET  /health                                       — health check (public)
 *   WS   /ws/sync/:motebitId                           — bidirectional event stream (primary)
 *   POST /sync/:motebitId/push                         — push events (HTTP fallback)
 *   GET  /sync/:motebitId/pull                         — pull events (HTTP fallback)
 *   GET  /sync/:motebitId/clock                        — latest version clock
 *   POST /sync/:motebitId/conversations                — push conversations
 *   GET  /sync/:motebitId/conversations?since=<ts>     — pull conversations
 *   POST /sync/:motebitId/messages                     — push conversation messages
 *   GET  /sync/:motebitId/messages?conversation_id=&since= — pull conversation messages
 *   POST /identity                                     — create identity for device registration
 *   GET  /identity/:motebitId                          — load identity
 *   GET  /api/v1/state/:motebitId                      — current state vector
 *   GET  /api/v1/memory/:motebitId                     — all memory nodes + edges
 *   DELETE /api/v1/memory/:motebitId/:nodeId           — tombstone a memory node
 *   GET  /api/v1/goals/:motebitId                      — list goals
 *   GET  /api/v1/conversations/:motebitId              — list conversations
 *   GET  /api/v1/conversations/:motebitId/:id/messages — conversation messages
 *   GET  /api/v1/devices/:motebitId                    — registered devices
 *   GET  /api/v1/audit/:motebitId                      — tool audit log
 *   GET  /api/v1/plans/:motebitId                      — list plans with steps
 *   GET  /api/v1/plans/:motebitId/:planId              — single plan with steps
 *   GET  /api/v1/gradient/:motebitId?limit=100         — intelligence gradient snapshots
 *   GET  /api/v1/sync/:motebitId/pull                  — pull events (aliased for admin)
 *   POST /api/v1/agents/register                       — register/refresh agent MCP endpoint
 *   POST /api/v1/agents/heartbeat                      — refresh agent TTL
 *   GET  /api/v1/agents/discover?capability=&motebit_id=&limit= — discover agents
 *   GET  /api/v1/agents/:motebitId                     — get specific agent
 *   DELETE /api/v1/agents/deregister                   — remove agent registration
 *
 * WebSocket protocol:
 *   Client → Server:  { type: "push", events: EventLogEntry[] }
 *   Client → Server:  { type: "push_conversations", conversations: SyncConversation[] }
 *   Client → Server:  { type: "push_messages", messages: SyncConversationMessage[] }
 *   Server → Client:  { type: "event", event: EventLogEntry }
 *   Server → Client:  { type: "conversation", conversation: SyncConversation }
 *   Server → Client:  { type: "conversation_message", message: SyncConversationMessage }
 *   Server → Client:  { type: "ack", accepted: number }
 *   Server → Client:  { type: "ack_conversations", accepted: number }
 *   Server → Client:  { type: "ack_messages", accepted: number }
 */

import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { EventStore } from "@motebit/event-log";
import { IdentityManager } from "@motebit/core-identity";
import { openMotebitDatabase } from "@motebit/persistence";
import type { MotebitDatabase } from "@motebit/persistence";
import type {
  EventLogEntry,
  ToolAuditEntry,
  SyncConversation,
  SyncConversationMessage,
  ExecutionReceipt,
} from "@motebit/sdk";
import { AgentTaskStatus } from "@motebit/sdk";
import type { AgentTask } from "@motebit/sdk";
import type { WSContext } from "hono/ws";
import { verifySignedToken, verifyExecutionReceipt } from "@motebit/crypto";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/** Decode the payload half of a signed token without verifying the signature. */
function parseTokenPayloadUnsafe(
  token: string,
): { mid: string; did: string; iat: number; exp: number } | null {
  const dotIdx = token.indexOf(".");
  if (dotIdx === -1) return null;
  try {
    const padded = token.slice(0, dotIdx).replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded);
    return JSON.parse(json) as { mid: string; did: string; iat: number; exp: number };
  } catch {
    return null;
  }
}

/** Verify a signed token against a specific device's public key. O(1) lookup by did. */
async function verifySignedTokenForDevice(
  token: string,
  motebitId: string,
  identityManager: IdentityManager,
): Promise<boolean> {
  const claims = parseTokenPayloadUnsafe(token);
  if (!claims || claims.mid !== motebitId || !claims.did) return false;

  const device = await identityManager.loadDeviceById(claims.did, motebitId);
  if (!device || !device.public_key) return false;

  const pubKeyBytes = hexToBytes(device.public_key);
  const payload = await verifySignedToken(token, pubKeyBytes);
  return payload !== null && payload.mid === motebitId;
}

// === Config ===

export interface SyncRelayConfig {
  dbPath?: string;
  apiToken?: string; // Legacy single token (still supported as admin/master token)
  corsOrigin?: string;
  enableDeviceAuth?: boolean; // When true, validates per-device tokens (default: true)
  verifyDeviceSignature?: boolean; // When true, uses Ed25519 signed token verification (default: true)
}

export interface ConnectedDevice {
  ws: WSContext;
  deviceId: string;
}

export interface SyncRelay {
  app: Hono;
  close(): void;
  /** Connected WebSocket clients per motebitId. Exposed for testing. */
  connections: Map<string, ConnectedDevice[]>;
}

// === Factory ===

// === Pairing Code Generator ===

const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 30 chars, no ambiguous 0/O/1/I/L
const PAIRING_CODE_LENGTH = 6;
const PAIRING_TTL_MS = 5 * 60 * 1000; // 5 minutes

function generatePairingCode(): string {
  const bytes = new Uint8Array(PAIRING_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length])
    .join("");
}

export async function createSyncRelay(config: SyncRelayConfig = {}): Promise<SyncRelay> {
  const {
    dbPath = ":memory:",
    apiToken,
    corsOrigin = "*",
    enableDeviceAuth = true,
    verifyDeviceSignature = true,
  } = config;

  const moteDb: MotebitDatabase = await openMotebitDatabase(dbPath);
  const eventStore = new EventStore(moteDb.eventStore);
  const identityManager = new IdentityManager(moteDb.identityStorage, eventStore);

  // Create pairing_sessions table
  moteDb.db.exec(`
      CREATE TABLE IF NOT EXISTS pairing_sessions (
        pairing_id TEXT PRIMARY KEY,
        motebit_id TEXT NOT NULL,
        initiator_device_id TEXT NOT NULL,
        pairing_code TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        claiming_device_name TEXT,
        claiming_public_key TEXT,
        approved_device_id TEXT,
        approved_device_token TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pairing_code ON pairing_sessions (pairing_code);
  `);

  // Create conversation sync tables (relay-side storage)
  moteDb.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_conversations (
        conversation_id TEXT PRIMARY KEY,
        motebit_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        title TEXT,
        summary TEXT,
        message_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sync_conv_motebit
        ON sync_conversations (motebit_id, last_active_at DESC);

      CREATE TABLE IF NOT EXISTS sync_conversation_messages (
        message_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        motebit_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        tool_call_id TEXT,
        created_at INTEGER NOT NULL,
        token_estimate INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sync_conv_messages
        ON sync_conversation_messages (conversation_id, created_at ASC);
  `);

  // Create agent discovery registry table
  moteDb.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_registry (
        motebit_id    TEXT PRIMARY KEY,
        public_key    TEXT NOT NULL,
        endpoint_url  TEXT NOT NULL,
        capabilities  TEXT NOT NULL DEFAULT '[]',
        metadata      TEXT,
        registered_at INTEGER NOT NULL,
        last_heartbeat INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL
      );
  `);

  // Track connected WebSocket clients per motebitId with device identity
  const connections = new Map<string, ConnectedDevice[]>();

  // In-memory agent task queue: task_id → { task, receipt?, expiresAt }
  const TASK_TTL_MS = 10 * 60 * 1000; // 10 minutes
  const taskQueue = new Map<
    string,
    { task: AgentTask; receipt?: ExecutionReceipt; expiresAt: number }
  >();

  // Periodic cleanup of expired tasks and agent registrations
  const taskCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of taskQueue) {
      if (entry.expiresAt < now) {
        taskQueue.delete(id);
      }
    }
    // Clean expired agent registrations
    const stmtClean = moteDb.db.prepare("DELETE FROM agent_registry WHERE expires_at < ?");
    stmtClean.run(now);
  }, 60_000);

  const app = new Hono();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- hono utility functions, not bound methods
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // --- Middleware ---
  app.use("*", secureHeaders());
  app.use("*", cors({ origin: corsOrigin }));

  if (apiToken != null && apiToken !== "") {
    app.use("/identity/*", bearerAuth({ token: apiToken }));
    app.use("/identity", bearerAuth({ token: apiToken }));
    // Device registration is protected by the master token
    app.use("/device/*", bearerAuth({ token: apiToken }));
  }

  if (enableDeviceAuth) {
    // Device auth middleware for sync routes: validates per-device tokens or signed tokens
    app.use("/sync/*", async (c, next) => {
      const authHeader = c.req.header("authorization");
      if (authHeader == null || !authHeader.startsWith("Bearer ")) {
        throw new HTTPException(401, { message: "Missing device token" });
      }
      const token = authHeader.slice(7);

      // Master token bypass
      if (apiToken != null && apiToken !== "" && token === apiToken) {
        await next();
        return;
      }

      // Extract motebitId from URL path (/sync/:motebitId/...)
      const pathParts = new URL(c.req.url, "http://localhost").pathname.split("/");
      const motebitId = pathParts[2];
      if (motebitId == null || motebitId === "") {
        throw new HTTPException(400, { message: "Missing motebitId" });
      }

      if (verifyDeviceSignature && token.includes(".")) {
        // Signed token verification — O(1) lookup by device ID from token payload
        const verified = await verifySignedTokenForDevice(token, motebitId, identityManager);
        if (!verified) {
          throw new HTTPException(403, { message: "Device not authorized for this motebit" });
        }
      } else {
        // Legacy device token validation
        const device = await identityManager.validateDeviceToken(token, motebitId);
        if (!device) {
          throw new HTTPException(403, { message: "Device not authorized for this motebit" });
        }
      }
      await next();
    });
  } else if (apiToken != null && apiToken !== "") {
    // Legacy single-token auth for sync routes
    app.use("/sync/*", bearerAuth({ token: apiToken }));
  }

  // --- Error handler ---
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message, status: err.status }, err.status);
    }
    // eslint-disable-next-line no-console
    console.error(err);
    return c.json({ error: "Internal server error", status: 500 }, 500);
  });

  // --- Health (public, no auth) ---
  app.get("/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));

  // --- WebSocket: bidirectional event stream ---
  app.get(
    "/ws/sync/:motebitId",
    upgradeWebSocket((c) => {
      // Route param is guaranteed by /ws/sync/:motebitId pattern; guard in onOpen for defense-in-depth
      const motebitId = c.req.param("motebitId") as string;
      const url = new URL(c.req.url, "http://localhost");
      const deviceId = url.searchParams.get("device_id") ?? crypto.randomUUID();
      const token = url.searchParams.get("token");

      return {
        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- hono ws adapter supports async handlers
        async onOpen(_event, ws) {
          if (!motebitId) {
            ws.close(4000, "Missing motebitId");
            return;
          }

          // Validate token for WebSocket connections
          if (enableDeviceAuth && token != null && token !== "") {
            // Master token bypass
            if (apiToken != null && apiToken !== "" && token === apiToken) {
              // OK — master token
            } else if (verifyDeviceSignature && token.includes(".")) {
              // Signed token verification — O(1) lookup by device ID from token payload
              const verified = await verifySignedTokenForDevice(token, motebitId, identityManager);
              if (!verified) {
                ws.close(4003, "Unauthorized");
                return;
              }
            } else {
              // Legacy device token validation
              const device = await identityManager.validateDeviceToken(token, motebitId);
              if (!device) {
                ws.close(4003, "Unauthorized");
                return;
              }
            }
          } else if (enableDeviceAuth && (token == null || token === "")) {
            // No token provided but device auth is required — reject (mirrors REST middleware)
            ws.close(4001, "Missing device token");
            return;
          } else if (apiToken != null && apiToken !== "" && token !== apiToken) {
            ws.close(4001, "Unauthorized");
            return;
          }

          if (!connections.has(motebitId)) {
            connections.set(motebitId, []);
          }
          connections.get(motebitId)!.push({ ws, deviceId });
        },

        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- hono ws adapter supports async handlers
        async onMessage(event, ws) {
          try {
            const raw = event.data;
            const msg = JSON.parse(
              typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer),
            ) as {
              type: string;
              events?: EventLogEntry[];
              conversations?: SyncConversation[];
              messages?: SyncConversationMessage[];
              task_id?: string;
            };

            // Agent protocol: task_claim
            if (msg.type === "task_claim" && msg.task_id) {
              const entry = taskQueue.get(msg.task_id);
              if (!entry || entry.task.motebit_id !== motebitId) {
                ws.send(
                  JSON.stringify({
                    type: "task_claim_rejected",
                    task_id: msg.task_id,
                    reason: "Task not found",
                  }),
                );
              } else if (entry.task.status !== AgentTaskStatus.Pending) {
                ws.send(
                  JSON.stringify({
                    type: "task_claim_rejected",
                    task_id: msg.task_id,
                    reason: "Task already claimed",
                  }),
                );
              } else {
                entry.task.status = AgentTaskStatus.Claimed;
                entry.task.claimed_by = deviceId;
                ws.send(JSON.stringify({ type: "task_claimed", task_id: msg.task_id }));
              }
            }

            if (msg.type === "push" && Array.isArray(msg.events)) {
              for (const entry of msg.events) {
                await eventStore.append(entry);
              }

              // Acknowledge
              ws.send(JSON.stringify({ type: "ack", accepted: msg.events.length }));

              // Fan out to other connected clients for the same motebitId
              const peers = connections.get(motebitId);
              if (peers) {
                for (const entry of msg.events) {
                  const payload = JSON.stringify({ type: "event", event: entry });
                  for (const peer of peers) {
                    if (peer.ws !== ws && peer.ws.readyState === 1) {
                      peer.ws.send(payload);
                    }
                  }
                }
              }
            }

            if (msg.type === "push_conversations" && Array.isArray(msg.conversations)) {
              for (const conv of msg.conversations) {
                upsertSyncConversation(conv);
              }
              ws.send(
                JSON.stringify({ type: "ack_conversations", accepted: msg.conversations.length }),
              );

              // Fan out conversation updates to peers
              const peers = connections.get(motebitId);
              if (peers) {
                for (const conv of msg.conversations) {
                  const payload = JSON.stringify({ type: "conversation", conversation: conv });
                  for (const peer of peers) {
                    if (peer.ws !== ws && peer.ws.readyState === 1) {
                      peer.ws.send(payload);
                    }
                  }
                }
              }
            }

            if (msg.type === "push_messages" && Array.isArray(msg.messages)) {
              for (const m of msg.messages) {
                upsertSyncMessage(m);
              }
              ws.send(JSON.stringify({ type: "ack_messages", accepted: msg.messages.length }));

              // Fan out new messages to peers
              const peers = connections.get(motebitId);
              if (peers) {
                for (const m of msg.messages) {
                  const payload = JSON.stringify({ type: "conversation_message", message: m });
                  for (const peer of peers) {
                    if (peer.ws !== ws && peer.ws.readyState === 1) {
                      peer.ws.send(payload);
                    }
                  }
                }
              }
            }
          } catch {
            // Ignore malformed messages
          }
        },

        onClose(_event, ws) {
          const peers = connections.get(motebitId);
          if (peers) {
            const idx = peers.findIndex((p) => p.ws === ws);
            if (idx !== -1) peers.splice(idx, 1);
            if (peers.length === 0) connections.delete(motebitId);
          }
        },
      };
    }),
  );

  // --- Sync: push events (HTTP fallback) ---
  app.post("/sync/:motebitId/push", async (c) => {
    const motebitId = c.req.param("motebitId");
    const body = await c.req.json<{ events: EventLogEntry[] }>();
    if (!Array.isArray(body.events)) {
      throw new HTTPException(400, {
        message: "Missing or invalid 'events' field (must be array)",
      });
    }
    for (const event of body.events) {
      await eventStore.append(event);
    }

    // Fan out to WebSocket clients, skipping the sender device
    const senderDeviceId = c.req.header("x-device-id");
    const peers = connections.get(motebitId);
    if (peers) {
      for (const event of body.events) {
        const payload = JSON.stringify({ type: "event", event });
        for (const peer of peers) {
          if (peer.deviceId !== senderDeviceId) {
            peer.ws.send(payload);
          }
        }
      }
    }

    return c.json({ motebit_id: motebitId, accepted: body.events.length });
  });

  // --- Sync: pull events (HTTP fallback) ---
  app.get("/sync/:motebitId/pull", async (c) => {
    const motebitId = c.req.param("motebitId");
    const afterClock = Number(c.req.query("after_clock") ?? "0");
    const events = await eventStore.query({
      motebit_id: motebitId,
      after_version_clock: afterClock,
    });
    return c.json({ motebit_id: motebitId, events, after_clock: afterClock });
  });

  // --- Sync: latest clock ---
  app.get("/sync/:motebitId/clock", async (c) => {
    const motebitId = c.req.param("motebitId");
    const clock = await eventStore.getLatestClock(motebitId);
    return c.json({ motebit_id: motebitId, latest_clock: clock });
  });

  // --- Device: register ---
  app.post("/device/register", async (c) => {
    const body = await c.req.json<{
      motebit_id: string;
      device_name?: string;
      public_key?: string;
    }>();
    if (!body.motebit_id) {
      throw new HTTPException(400, { message: "Missing 'motebit_id' field" });
    }
    if (
      body.public_key !== undefined &&
      (typeof body.public_key !== "string" || !/^[0-9a-f]{64}$/i.test(body.public_key))
    ) {
      throw new HTTPException(400, {
        message: "Invalid 'public_key' — must be 64-char hex string (32 bytes Ed25519 public key)",
      });
    }
    const identity = await identityManager.load(body.motebit_id);
    if (!identity) {
      throw new HTTPException(404, { message: "Identity not found" });
    }
    const device = await identityManager.registerDevice(
      body.motebit_id,
      body.device_name,
      body.public_key,
    );
    return c.json(device, 201);
  });

  // --- Audit: query tool audit log ---
  if (apiToken != null && apiToken !== "") {
    // Agent registry routes use their own auth middleware (supports device tokens)
    app.use("/api/v1/*", async (c, next) => {
      if (c.req.path.startsWith("/api/v1/agents")) {
        await next();
        return;
      }
      const mw = bearerAuth({ token: apiToken });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      return mw(c as never, next);
    });
  }

  app.get("/api/v1/audit/:motebitId", (c) => {
    const motebitId = c.req.param("motebitId");
    const turnId = c.req.query("turn_id");
    let entries: ToolAuditEntry[] = [];
    if (moteDb.toolAuditSink != null) {
      entries =
        turnId != null && turnId !== ""
          ? moteDb.toolAuditSink.query(turnId)
          : moteDb.toolAuditSink.getAll();
    }
    return c.json({ motebit_id: motebitId, entries });
  });

  // --- Plans: list all plans for a motebit with their steps ---
  app.get("/api/v1/plans/:motebitId", (c) => {
    const motebitId = c.req.param("motebitId");
    const plans = moteDb.planStore.listPlans(motebitId);
    const plansWithSteps = plans.map((plan) => ({
      ...plan,
      steps: moteDb.planStore.getStepsForPlan(plan.plan_id),
    }));
    return c.json({ motebit_id: motebitId, plans: plansWithSteps });
  });

  // --- Plans: get single plan with steps ---
  app.get("/api/v1/plans/:motebitId/:planId", (c) => {
    const motebitId = c.req.param("motebitId");
    const planId = c.req.param("planId");
    const plan = moteDb.planStore.getPlan(planId);
    if (!plan || plan.motebit_id !== motebitId) {
      throw new HTTPException(404, { message: "Plan not found" });
    }
    const steps = moteDb.planStore.getStepsForPlan(planId);
    return c.json({ motebit_id: motebitId, plan: { ...plan, steps } });
  });

  // --- Gradient: intelligence gradient snapshots ---
  app.get("/api/v1/gradient/:motebitId", (c) => {
    const motebitId = c.req.param("motebitId");
    const limit = Number(c.req.query("limit") ?? "100");
    const rows = moteDb.db
      .prepare(
        `SELECT * FROM gradient_snapshots WHERE motebit_id = ? ORDER BY timestamp DESC LIMIT ?`,
      )
      .all(motebitId, limit) as Array<{
      motebit_id: string;
      timestamp: number;
      gradient: number;
      delta: number;
      knowledge_density: number;
      knowledge_density_raw: number;
      knowledge_quality: number;
      graph_connectivity: number;
      graph_connectivity_raw: number;
      temporal_stability: number;
      retrieval_quality: number;
      stats: string;
    }>;
    const snapshots = rows.map((r) => ({
      ...r,
      stats: JSON.parse(r.stats) as Record<string, unknown>,
    }));
    return c.json({
      motebit_id: motebitId,
      current: snapshots[0] ?? null,
      history: snapshots,
    });
  });

  // --- State: current state vector ---
  app.get("/api/v1/state/:motebitId", (c) => {
    const motebitId = c.req.param("motebitId");
    const json = moteDb.stateSnapshot.loadState(motebitId);
    if (json == null || json === "") {
      return c.json({ motebit_id: motebitId, state: null });
    }
    try {
      const state = JSON.parse(json) as Record<string, unknown>;
      return c.json({ motebit_id: motebitId, state });
    } catch {
      return c.json({ motebit_id: motebitId, state: null });
    }
  });

  // --- Memory: list all nodes and edges ---
  app.get("/api/v1/memory/:motebitId", async (c) => {
    const motebitId = c.req.param("motebitId");
    const [memories, edges] = await Promise.all([
      moteDb.memoryStorage.getAllNodes(motebitId),
      moteDb.memoryStorage.getAllEdges(motebitId),
    ]);
    return c.json({ motebit_id: motebitId, memories, edges });
  });

  // --- Memory: tombstone a node ---
  app.delete("/api/v1/memory/:motebitId/:nodeId", async (c) => {
    const motebitId = c.req.param("motebitId");
    const nodeId = c.req.param("nodeId");
    try {
      await moteDb.memoryStorage.tombstoneNode(nodeId);
      return c.json({ motebit_id: motebitId, node_id: nodeId, deleted: true });
    } catch {
      return c.json({ motebit_id: motebitId, node_id: nodeId, deleted: false }, 404);
    }
  });

  // --- Goals: list all goals ---
  app.get("/api/v1/goals/:motebitId", (c) => {
    const motebitId = c.req.param("motebitId");
    const goals = moteDb.goalStore.list(motebitId);
    return c.json({ motebit_id: motebitId, goals });
  });

  // --- Conversations: list all (from sync relay storage) ---
  app.get("/api/v1/conversations/:motebitId", (c) => {
    const motebitId = c.req.param("motebitId");
    const conversations = moteDb.db
      .prepare(`SELECT * FROM sync_conversations WHERE motebit_id = ? ORDER BY last_active_at DESC`)
      .all(motebitId) as Array<Record<string, unknown>>;
    return c.json({ motebit_id: motebitId, conversations });
  });

  // --- Conversations: list messages for a conversation ---
  app.get("/api/v1/conversations/:motebitId/:conversationId/messages", (c) => {
    const motebitId = c.req.param("motebitId");
    const conversationId = c.req.param("conversationId");
    const messages = moteDb.db
      .prepare(
        `SELECT * FROM sync_conversation_messages WHERE conversation_id = ? AND motebit_id = ? ORDER BY created_at ASC`,
      )
      .all(conversationId, motebitId) as Array<Record<string, unknown>>;
    return c.json({ motebit_id: motebitId, conversation_id: conversationId, messages });
  });

  // --- Devices: list registered devices ---
  app.get("/api/v1/devices/:motebitId", async (c) => {
    const motebitId = c.req.param("motebitId");
    const devices = await identityManager.listDevices(motebitId);
    return c.json({ motebit_id: motebitId, devices });
  });

  // --- Events: alias under /api/v1 prefix (admin dashboard uses this path) ---
  app.get("/api/v1/sync/:motebitId/pull", async (c) => {
    const motebitId = c.req.param("motebitId");
    const afterClock = Number(c.req.query("after_clock") ?? "0");
    const events = await eventStore.query({
      motebit_id: motebitId,
      after_version_clock: afterClock,
    });
    return c.json({ motebit_id: motebitId, events, after_clock: afterClock });
  });

  // --- Identity: create ---
  app.post("/identity", async (c) => {
    const body = await c.req.json<{ owner_id: string }>();
    if (!body.owner_id || typeof body.owner_id !== "string" || body.owner_id.trim() === "") {
      throw new HTTPException(400, { message: "Missing or empty 'owner_id' field" });
    }
    const identity = await identityManager.create(body.owner_id);
    return c.json(identity, 201);
  });

  // --- Identity: load ---
  app.get("/identity/:motebitId", async (c) => {
    const id = c.req.param("motebitId");
    const identity = await identityManager.load(id);
    if (!identity) {
      return c.json({ error: "identity not found" }, 404);
    }
    return c.json(identity);
  });

  // --- Pairing: helper to verify device auth and extract motebitId ---
  async function verifyPairingAuth(
    authHeader: string | undefined,
  ): Promise<{ motebitId: string; deviceId: string } | null> {
    if (authHeader == null || !authHeader.startsWith("Bearer ")) return null;
    const token = authHeader.slice(7);

    // Master token bypass
    if (apiToken != null && apiToken !== "" && token === apiToken) return null; // master token can't initiate pairing (no motebitId context)

    if (!token.includes(".")) return null; // must be a signed token

    const claims = parseTokenPayloadUnsafe(token);
    if (!claims || !claims.mid || !claims.did) return null;

    const verified = await verifySignedTokenForDevice(token, claims.mid, identityManager);
    if (!verified) return null;

    return { motebitId: claims.mid, deviceId: claims.did };
  }

  // --- Pairing: initiate (Device A, authenticated) ---
  app.post("/pairing/initiate", async (c) => {
    const device = await verifyPairingAuth(c.req.header("authorization"));
    if (!device) {
      throw new HTTPException(401, { message: "Signed device token required for pairing" });
    }

    const pairingId = crypto.randomUUID();
    const pairingCode = generatePairingCode();
    const now = Date.now();
    const expiresAt = now + PAIRING_TTL_MS;

    moteDb.db
      .prepare(
        `
      INSERT INTO pairing_sessions (pairing_id, motebit_id, initiator_device_id, pairing_code, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `,
      )
      .run(pairingId, device.motebitId, device.deviceId, pairingCode, now, expiresAt);

    return c.json({ pairing_id: pairingId, pairing_code: pairingCode, expires_at: expiresAt }, 201);
  });

  // --- Pairing: claim (Device B, no auth) ---
  app.post("/pairing/claim", async (c) => {
    const body = await c.req.json<{
      pairing_code: string;
      device_name: string;
      public_key: string;
    }>();
    const { pairing_code, device_name, public_key } = body;

    if (!pairing_code || typeof pairing_code !== "string" || !/^[A-Z2-9]{6}$/.test(pairing_code)) {
      throw new HTTPException(400, { message: "Invalid pairing code format" });
    }
    if (!device_name || typeof device_name !== "string") {
      throw new HTTPException(400, { message: "Missing device_name" });
    }
    if (!public_key || typeof public_key !== "string" || !/^[0-9a-f]{64}$/i.test(public_key)) {
      throw new HTTPException(400, { message: "Invalid public_key — must be 64-char hex string" });
    }

    const session = moteDb.db
      .prepare(
        `
      SELECT * FROM pairing_sessions WHERE pairing_code = ?
    `,
      )
      .get(pairing_code) as Record<string, unknown> | undefined;

    if (!session) {
      throw new HTTPException(404, { message: "Invalid pairing code" });
    }
    if ((session.expires_at as number) < Date.now()) {
      throw new HTTPException(410, { message: "Pairing code expired" });
    }
    if ((session.status as string) !== "pending") {
      throw new HTTPException(409, { message: "Pairing code already used" });
    }

    moteDb.db
      .prepare(
        `
      UPDATE pairing_sessions SET status = 'claimed', claiming_device_name = ?, claiming_public_key = ? WHERE pairing_id = ?
    `,
      )
      .run(device_name, public_key, session.pairing_id as string);

    return c.json({ pairing_id: session.pairing_id, motebit_id: session.motebit_id });
  });

  // --- Pairing: get session (Device A, authenticated) ---
  app.get("/pairing/:pairingId", async (c) => {
    const device = await verifyPairingAuth(c.req.header("authorization"));
    if (!device) {
      throw new HTTPException(401, { message: "Signed device token required" });
    }

    const pairingId = c.req.param("pairingId");
    const session = moteDb.db
      .prepare(
        `
      SELECT * FROM pairing_sessions WHERE pairing_id = ?
    `,
      )
      .get(pairingId) as Record<string, unknown> | undefined;

    if (!session) {
      throw new HTTPException(404, { message: "Pairing session not found" });
    }
    if ((session.motebit_id as string) !== device.motebitId) {
      throw new HTTPException(403, { message: "Not authorized for this pairing session" });
    }

    return c.json({
      pairing_id: session.pairing_id,
      motebit_id: session.motebit_id,
      status: session.status,
      pairing_code: session.pairing_code,
      claiming_device_name: session.claiming_device_name,
      claiming_public_key: session.claiming_public_key,
      created_at: session.created_at,
      expires_at: session.expires_at,
    });
  });

  // --- Pairing: approve (Device A, authenticated) ---
  app.post("/pairing/:pairingId/approve", async (c) => {
    const device = await verifyPairingAuth(c.req.header("authorization"));
    if (!device) {
      throw new HTTPException(401, { message: "Signed device token required" });
    }

    const pairingId = c.req.param("pairingId");
    const session = moteDb.db
      .prepare(
        `
      SELECT * FROM pairing_sessions WHERE pairing_id = ?
    `,
      )
      .get(pairingId) as Record<string, unknown> | undefined;

    if (!session) {
      throw new HTTPException(404, { message: "Pairing session not found" });
    }
    if ((session.motebit_id as string) !== device.motebitId) {
      throw new HTTPException(403, { message: "Not authorized for this pairing session" });
    }
    if ((session.status as string) !== "claimed") {
      throw new HTTPException(409, {
        message: `Cannot approve — status is '${String(session.status)}'`,
      });
    }

    // Register the claiming device under the same motebit identity
    const registeredDevice = await identityManager.registerDevice(
      session.motebit_id as string,
      (session.claiming_device_name as string) || "Paired Device",
      session.claiming_public_key as string,
    );

    moteDb.db
      .prepare(
        `
      UPDATE pairing_sessions SET status = 'approved', approved_device_id = ?, approved_device_token = ? WHERE pairing_id = ?
    `,
      )
      .run(registeredDevice.device_id, registeredDevice.device_token, pairingId);

    return c.json({
      device_id: registeredDevice.device_id,
      device_token: registeredDevice.device_token,
      motebit_id: session.motebit_id,
    });
  });

  // --- Pairing: deny (Device A, authenticated) ---
  app.post("/pairing/:pairingId/deny", async (c) => {
    const device = await verifyPairingAuth(c.req.header("authorization"));
    if (!device) {
      throw new HTTPException(401, { message: "Signed device token required" });
    }

    const pairingId = c.req.param("pairingId");
    const session = moteDb.db
      .prepare(
        `
      SELECT * FROM pairing_sessions WHERE pairing_id = ?
    `,
      )
      .get(pairingId) as Record<string, unknown> | undefined;

    if (!session) {
      throw new HTTPException(404, { message: "Pairing session not found" });
    }
    if ((session.motebit_id as string) !== device.motebitId) {
      throw new HTTPException(403, { message: "Not authorized for this pairing session" });
    }

    moteDb.db
      .prepare(
        `
      UPDATE pairing_sessions SET status = 'denied' WHERE pairing_id = ?
    `,
      )
      .run(pairingId);

    return c.json({ status: "denied" });
  });

  // --- Pairing: status (Device B polls, no auth) ---
  app.get("/pairing/:pairingId/status", (c) => {
    const pairingId = c.req.param("pairingId");
    const session = moteDb.db
      .prepare(
        `
      SELECT status, motebit_id, approved_device_id, approved_device_token FROM pairing_sessions WHERE pairing_id = ?
    `,
      )
      .get(pairingId) as Record<string, unknown> | undefined;

    if (!session) {
      throw new HTTPException(404, { message: "Pairing session not found" });
    }

    const result: Record<string, unknown> = { status: session.status };
    if ((session.status as string) === "approved") {
      result.motebit_id = session.motebit_id;
      result.device_id = session.approved_device_id;
      result.device_token = session.approved_device_token;
    }

    return c.json(result);
  });

  // === Conversation Sync Helpers ===

  function upsertSyncConversation(conv: SyncConversation): void {
    moteDb.db
      .prepare(
        `INSERT INTO sync_conversations (conversation_id, motebit_id, started_at, last_active_at, title, summary, message_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         last_active_at = MAX(excluded.last_active_at, sync_conversations.last_active_at),
         title = CASE WHEN excluded.last_active_at >= sync_conversations.last_active_at THEN excluded.title ELSE sync_conversations.title END,
         summary = CASE WHEN excluded.last_active_at >= sync_conversations.last_active_at THEN excluded.summary ELSE sync_conversations.summary END,
         message_count = MAX(excluded.message_count, sync_conversations.message_count)`,
      )
      .run(
        conv.conversation_id,
        conv.motebit_id,
        conv.started_at,
        conv.last_active_at,
        conv.title,
        conv.summary,
        conv.message_count,
      );
  }

  function upsertSyncMessage(msg: SyncConversationMessage): void {
    moteDb.db
      .prepare(
        `INSERT OR IGNORE INTO sync_conversation_messages
       (message_id, conversation_id, motebit_id, role, content, tool_calls, tool_call_id, created_at, token_estimate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.message_id,
        msg.conversation_id,
        msg.motebit_id,
        msg.role,
        msg.content,
        msg.tool_calls,
        msg.tool_call_id,
        msg.created_at,
        msg.token_estimate,
      );
  }

  // --- Conversation Sync: push conversations ---
  app.post("/sync/:motebitId/conversations", async (c) => {
    const motebitId = c.req.param("motebitId");
    const body = await c.req.json<{ conversations: SyncConversation[] }>();
    if (!Array.isArray(body.conversations)) {
      throw new HTTPException(400, {
        message: "Missing or invalid 'conversations' field (must be array)",
      });
    }
    for (const conv of body.conversations) {
      upsertSyncConversation(conv);
    }

    // Fan out to WebSocket clients, skipping the sender device
    const senderDeviceId = c.req.header("x-device-id");
    const peers = connections.get(motebitId);
    if (peers) {
      for (const conv of body.conversations) {
        const payload = JSON.stringify({ type: "conversation", conversation: conv });
        for (const peer of peers) {
          if (peer.deviceId !== senderDeviceId) {
            peer.ws.send(payload);
          }
        }
      }
    }

    return c.json({ motebit_id: motebitId, accepted: body.conversations.length });
  });

  // --- Conversation Sync: pull conversations ---
  app.get("/sync/:motebitId/conversations", (c) => {
    const motebitId = c.req.param("motebitId");
    const since = Number(c.req.query("since") ?? "0");
    const rows = moteDb.db
      .prepare(
        `SELECT * FROM sync_conversations WHERE motebit_id = ? AND last_active_at > ? ORDER BY last_active_at ASC`,
      )
      .all(motebitId, since) as SyncConversation[];
    return c.json({ motebit_id: motebitId, conversations: rows, since });
  });

  // --- Conversation Sync: push messages ---
  app.post("/sync/:motebitId/messages", async (c) => {
    const motebitId = c.req.param("motebitId");
    const body = await c.req.json<{ messages: SyncConversationMessage[] }>();
    if (!Array.isArray(body.messages)) {
      throw new HTTPException(400, {
        message: "Missing or invalid 'messages' field (must be array)",
      });
    }
    for (const msg of body.messages) {
      upsertSyncMessage(msg);
    }

    // Fan out to WebSocket clients, skipping the sender device
    const senderDeviceId = c.req.header("x-device-id");
    const peers = connections.get(motebitId);
    if (peers) {
      for (const msg of body.messages) {
        const payload = JSON.stringify({ type: "conversation_message", message: msg });
        for (const peer of peers) {
          if (peer.deviceId !== senderDeviceId) {
            peer.ws.send(payload);
          }
        }
      }
    }

    return c.json({ motebit_id: motebitId, accepted: body.messages.length });
  });

  // --- Conversation Sync: pull messages ---
  app.get("/sync/:motebitId/messages", (c) => {
    const motebitId = c.req.param("motebitId");
    const conversationId = c.req.query("conversation_id");
    const since = Number(c.req.query("since") ?? "0");
    if (conversationId == null || conversationId === "") {
      throw new HTTPException(400, { message: "Missing 'conversation_id' query parameter" });
    }
    const rows = moteDb.db
      .prepare(
        `SELECT * FROM sync_conversation_messages WHERE conversation_id = ? AND motebit_id = ? AND created_at > ? ORDER BY created_at ASC`,
      )
      .all(conversationId, motebitId, since) as SyncConversationMessage[];
    return c.json({
      motebit_id: motebitId,
      conversation_id: conversationId,
      messages: rows,
      since,
    });
  });

  // === Agent Protocol Endpoints ===

  // POST /agent/:motebitId/task — submit a task (master token auth)
  if (apiToken != null && apiToken !== "") {
    app.use("/agent/*/task", async (c, next) => {
      // Only apply master token auth to POST (submit) requests
      if (c.req.method === "POST" && !c.req.url.includes("/result")) {
        const authHeader = c.req.header("authorization");
        if (
          authHeader == null ||
          !authHeader.startsWith("Bearer ") ||
          authHeader.slice(7) !== apiToken
        ) {
          throw new HTTPException(401, { message: "Master token required" });
        }
      }
      await next();
    });
  }

  app.post("/agent/:motebitId/task", async (c) => {
    const motebitId = c.req.param("motebitId");
    const body = await c.req.json<{
      prompt: string;
      submitted_by?: string;
      wall_clock_ms?: number;
    }>();

    if (!body.prompt || typeof body.prompt !== "string" || body.prompt.trim() === "") {
      throw new HTTPException(400, { message: "Missing or empty 'prompt' field" });
    }

    const taskId = crypto.randomUUID();
    const now = Date.now();
    const task: AgentTask = {
      task_id: taskId,
      motebit_id: motebitId,
      prompt: body.prompt,
      submitted_at: now,
      submitted_by: body.submitted_by,
      wall_clock_ms: body.wall_clock_ms,
      status: AgentTaskStatus.Pending,
    };

    taskQueue.set(taskId, { task, expiresAt: now + TASK_TTL_MS });

    // Push task_request to connected devices
    const peers = connections.get(motebitId);
    if (peers) {
      const payload = JSON.stringify({ type: "task_request", task });
      for (const peer of peers) {
        peer.ws.send(payload);
      }
    }

    return c.json({ task_id: taskId, status: task.status }, 201);
  });

  // GET /agent/:motebitId/task/:taskId — poll task status
  app.get("/agent/:motebitId/task/:taskId", async (c) => {
    const motebitId = c.req.param("motebitId");
    const taskId = c.req.param("taskId");

    // Device auth: require signed token or master token
    const authHeader = c.req.header("authorization");
    if (authHeader == null || !authHeader.startsWith("Bearer ")) {
      throw new HTTPException(401, { message: "Authorization required" });
    }
    const token = authHeader.slice(7);
    if (apiToken == null || token !== apiToken) {
      // Verify as device signed token
      if (enableDeviceAuth && token.includes(".")) {
        const verified = await verifySignedTokenForDevice(token, motebitId, identityManager);
        if (!verified) {
          throw new HTTPException(403, { message: "Device not authorized" });
        }
      } else {
        throw new HTTPException(403, { message: "Invalid authorization" });
      }
    }

    const entry = taskQueue.get(taskId);

    if (!entry || entry.task.motebit_id !== motebitId) {
      throw new HTTPException(404, { message: "Task not found" });
    }

    return c.json({ task: entry.task, receipt: entry.receipt ?? null });
  });

  // POST /agent/:motebitId/task/:taskId/result — device posts signed receipt
  app.post("/agent/:motebitId/task/:taskId/result", async (c) => {
    const motebitId = c.req.param("motebitId");
    const taskId = c.req.param("taskId");

    // Device auth: require signed token or master token
    const authHeader = c.req.header("authorization");
    if (authHeader == null || !authHeader.startsWith("Bearer ")) {
      throw new HTTPException(401, { message: "Authorization required" });
    }
    const token = authHeader.slice(7);
    if (apiToken == null || token !== apiToken) {
      // Verify as device signed token
      if (enableDeviceAuth && token.includes(".")) {
        const verified = await verifySignedTokenForDevice(token, motebitId, identityManager);
        if (!verified) {
          throw new HTTPException(403, { message: "Device not authorized" });
        }
      } else {
        throw new HTTPException(403, { message: "Invalid authorization" });
      }
    }

    const entry = taskQueue.get(taskId);
    if (!entry || entry.task.motebit_id !== motebitId) {
      throw new HTTPException(404, { message: "Task not found" });
    }

    const receipt = await c.req.json<ExecutionReceipt>();

    // Structural validation: require essential receipt fields
    const validStatuses = ["completed", "failed", "denied"];
    if (
      typeof receipt.task_id !== "string" || receipt.task_id === "" ||
      typeof receipt.motebit_id !== "string" || receipt.motebit_id === "" ||
      typeof receipt.signature !== "string" || receipt.signature === "" ||
      typeof receipt.status !== "string" || !validStatuses.includes(receipt.status)
    ) {
      throw new HTTPException(400, {
        message: "Invalid receipt: must include non-empty task_id, motebit_id, signature, and valid status",
      });
    }

    entry.receipt = receipt;
    entry.task.status =
      receipt.status === "completed"
        ? AgentTaskStatus.Completed
        : receipt.status === "denied"
          ? AgentTaskStatus.Denied
          : AgentTaskStatus.Failed;

    // Fan out task_result to all connected devices
    const peers = connections.get(motebitId);
    if (peers) {
      const payload = JSON.stringify({ type: "task_result", task_id: taskId, receipt });
      for (const peer of peers) {
        peer.ws.send(payload);
      }
    }

    return c.json({ status: entry.task.status });
  });

  // GET /agent/:motebitId/capabilities — public (no auth)
  app.get("/agent/:motebitId/capabilities", async (c) => {
    const motebitId = c.req.param("motebitId");
    const identity = await identityManager.load(motebitId);
    if (!identity) {
      throw new HTTPException(404, { message: "Identity not found" });
    }

    const devices = await identityManager.listDevices(motebitId);
    const onlinePeers = connections.get(motebitId);
    const onlineCount = onlinePeers ? onlinePeers.length : 0;

    // Find the first device with a public key for capabilities
    const deviceWithKey = devices.find((d) => d.public_key);
    const publicKey = deviceWithKey ? deviceWithKey.public_key : "";

    return c.json({
      motebit_id: motebitId,
      public_key: publicKey,
      tools: [],
      governance: {
        trust_mode: "guarded",
        max_risk_auto: 1,
        require_approval_above: 2,
        deny_above: 4,
      },
      online_devices: onlineCount,
    });
  });

  // POST /agent/:motebitId/verify-receipt — public receipt verification
  app.post("/agent/:motebitId/verify-receipt", async (c) => {
    const motebitId = c.req.param("motebitId");
    const receipt = await c.req.json<ExecutionReceipt>();

    if (receipt.motebit_id !== motebitId) {
      return c.json({ valid: false, reason: "motebit_id mismatch" });
    }

    // Find the device's public key
    const devices = await identityManager.listDevices(motebitId);
    const device = devices.find((d) => d.device_id === receipt.device_id);
    if (!device || !device.public_key) {
      return c.json({ valid: false, reason: "Device or public key not found" });
    }

    const pubKeyBytes = hexToBytes(device.public_key);
    const valid = await verifyExecutionReceipt(receipt, pubKeyBytes);
    return c.json({ valid });
  });

  // === Agent Discovery Registry ===

  // Auth middleware for agent registry routes
  app.use("/api/v1/agents/*", async (c, next) => {
    const authHeader = c.req.header("authorization");
    if (authHeader == null || !authHeader.startsWith("Bearer ")) {
      throw new HTTPException(401, { message: "Missing auth token" });
    }
    const token = authHeader.slice(7);

    // Master token bypass
    if (apiToken != null && apiToken !== "" && token === apiToken) {
      await next();
      return;
    }

    // Parse token to get motebitId, then verify
    const claims = parseTokenPayloadUnsafe(token);
    if (!claims?.mid) {
      throw new HTTPException(401, { message: "Invalid token" });
    }
    const valid = await verifySignedTokenForDevice(token, claims.mid, identityManager);
    if (!valid) {
      throw new HTTPException(401, { message: "Token verification failed" });
    }

    // Store caller identity for route handlers
    c.set("callerMotebitId" as never, claims.mid as never);
    await next();
  });

  // POST /api/v1/agents/register — register/refresh an agent's MCP endpoint
  app.post("/api/v1/agents/register", async (c) => {
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;

    // For master token, require motebit_id in body
    const body = await c.req.json<{
      motebit_id?: string;
      endpoint_url: string;
      capabilities: string[];
      metadata?: { name?: string; description?: string };
    }>();
    const motebitId = callerMotebitId ?? body.motebit_id;
    if (!motebitId || typeof motebitId !== "string") {
      throw new HTTPException(400, { message: "Missing motebit_id" });
    }

    if (!body.endpoint_url || typeof body.endpoint_url !== "string") {
      throw new HTTPException(400, { message: "Missing or invalid 'endpoint_url'" });
    }
    if (!Array.isArray(body.capabilities)) {
      throw new HTTPException(400, {
        message: "Missing or invalid 'capabilities' (must be array)",
      });
    }

    // Look up public key from devices
    const devices = await identityManager.listDevices(motebitId);
    const deviceWithKey = devices.find((d) => d.public_key);
    const publicKey = deviceWithKey ? deviceWithKey.public_key : "";

    const now = Date.now();
    const expiresAt = now + 15 * 60 * 1000; // 15 minutes

    moteDb.db
      .prepare(
        `
      INSERT INTO agent_registry (motebit_id, public_key, endpoint_url, capabilities, metadata, registered_at, last_heartbeat, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(motebit_id) DO UPDATE SET
        public_key = excluded.public_key,
        endpoint_url = excluded.endpoint_url,
        capabilities = excluded.capabilities,
        metadata = excluded.metadata,
        last_heartbeat = excluded.last_heartbeat,
        expires_at = excluded.expires_at
    `,
      )
      .run(
        motebitId,
        publicKey,
        body.endpoint_url,
        JSON.stringify(body.capabilities),
        body.metadata ? JSON.stringify(body.metadata) : null,
        now,
        now,
        expiresAt,
      );

    return c.json({ registered: true, motebit_id: motebitId, expires_at: expiresAt });
  });

  // POST /api/v1/agents/heartbeat — refresh TTL
  app.post("/api/v1/agents/heartbeat", (c) => {
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (!callerMotebitId) {
      throw new HTTPException(400, { message: "Cannot determine motebit_id from token" });
    }

    const now = Date.now();
    const expiresAt = now + 15 * 60 * 1000;

    const result = moteDb.db
      .prepare(
        `
      UPDATE agent_registry SET last_heartbeat = ?, expires_at = ? WHERE motebit_id = ?
    `,
      )
      .run(now, expiresAt, callerMotebitId);

    if (result.changes === 0) {
      throw new HTTPException(404, { message: "Agent not registered" });
    }

    return c.json({ ok: true });
  });

  // GET /api/v1/agents/discover — find agents
  app.get("/api/v1/agents/discover", (c) => {
    const capability = c.req.query("capability");
    const motebitId = c.req.query("motebit_id");
    const limitParam = Number(c.req.query("limit") ?? "20");
    const limit = Math.min(Math.max(1, limitParam), 100);
    const now = Date.now();

    let rows: Array<Record<string, unknown>>;

    if (capability && motebitId) {
      rows = moteDb.db
        .prepare(
          `
        SELECT * FROM agent_registry
        WHERE expires_at > ? AND motebit_id = ?
          AND EXISTS (SELECT 1 FROM json_each(capabilities) WHERE value = ?)
        LIMIT ?
      `,
        )
        .all(now, motebitId, capability, limit) as Array<Record<string, unknown>>;
    } else if (capability) {
      rows = moteDb.db
        .prepare(
          `
        SELECT * FROM agent_registry
        WHERE expires_at > ?
          AND EXISTS (SELECT 1 FROM json_each(capabilities) WHERE value = ?)
        LIMIT ?
      `,
        )
        .all(now, capability, limit) as Array<Record<string, unknown>>;
    } else if (motebitId) {
      rows = moteDb.db
        .prepare(
          `
        SELECT * FROM agent_registry WHERE expires_at > ? AND motebit_id = ? LIMIT ?
      `,
        )
        .all(now, motebitId, limit) as Array<Record<string, unknown>>;
    } else {
      rows = moteDb.db
        .prepare(
          `
        SELECT * FROM agent_registry WHERE expires_at > ? LIMIT ?
      `,
        )
        .all(now, limit) as Array<Record<string, unknown>>;
    }

    const agents = rows.map((r) => ({
      motebit_id: r.motebit_id,
      public_key: r.public_key,
      endpoint_url: r.endpoint_url,
      capabilities: JSON.parse(r.capabilities as string) as string[],
      metadata: r.metadata ? (JSON.parse(r.metadata as string) as Record<string, unknown>) : null,
    }));

    return c.json({ agents });
  });

  // GET /api/v1/agents/:motebitId — get specific agent
  app.get("/api/v1/agents/:motebitId", (c) => {
    const motebitId = c.req.param("motebitId");
    const now = Date.now();

    const row = moteDb.db
      .prepare(
        `
      SELECT * FROM agent_registry WHERE motebit_id = ? AND expires_at > ?
    `,
      )
      .get(motebitId, now) as Record<string, unknown> | undefined;

    if (!row) {
      throw new HTTPException(404, { message: "Agent not found" });
    }

    return c.json({
      motebit_id: row.motebit_id,
      public_key: row.public_key,
      endpoint_url: row.endpoint_url,
      capabilities: JSON.parse(row.capabilities as string) as string[],
      metadata: row.metadata
        ? (JSON.parse(row.metadata as string) as Record<string, unknown>)
        : null,
    });
  });

  // DELETE /api/v1/agents/deregister — remove registration
  app.delete("/api/v1/agents/deregister", (c) => {
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (!callerMotebitId) {
      throw new HTTPException(400, { message: "Cannot determine motebit_id from token" });
    }

    moteDb.db.prepare(`DELETE FROM agent_registry WHERE motebit_id = ?`).run(callerMotebitId);
    return c.json({ ok: true });
  });

  function close(): void {
    // Close all WebSocket connections
    for (const peers of connections.values()) {
      for (const peer of peers) {
        peer.ws.close();
      }
    }
    connections.clear();
    clearInterval(taskCleanupInterval);
    moteDb.close();
  }

  // Inject WebSocket support into the underlying Node.js server
  const originalApp = app as Hono & { injectWebSocket?: typeof injectWebSocket };
  originalApp.injectWebSocket = injectWebSocket;

  return { app, close, connections };
}

// === Standalone boot ===

let app: Hono;

if (process.env.VITEST != null) {
  app = new Hono();
} else {
  const relay = await createSyncRelay({
    dbPath: process.env.MOTEBIT_DB_PATH,
    apiToken: process.env.MOTEBIT_API_TOKEN,
    corsOrigin: process.env.MOTEBIT_CORS_ORIGIN,
    enableDeviceAuth: process.env.MOTEBIT_ENABLE_DEVICE_AUTH !== "false",
  });
  app = relay.app;

  const port = Number(process.env.PORT ?? 3000);
  const server = serve({ fetch: app.fetch, port }, (info) => {
    // eslint-disable-next-line no-console
    console.log(`Motebit sync relay listening on http://localhost:${info.port}`);
  });
  // Inject WebSocket support
  const injectWs = (app as Hono & { injectWebSocket?: (server: unknown) => void }).injectWebSocket;
  if (injectWs) injectWs(server);
}

export default app;
export { app };
