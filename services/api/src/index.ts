/**
 * @motebit/api — Sync relay
 *
 * Thin event relay for cross-device sync. No AI, no memory, no state.
 * Devices run MotebitRuntime locally; this server is just an event mailbox.
 *
 * Endpoints:
 *   GET  /health                         — health check (public)
 *   WS   /sync/:motebitId               — bidirectional event stream (primary)
 *   POST /sync/:motebitId/push           — HTTP fallback for push
 *   GET  /sync/:motebitId/pull           — HTTP fallback for pull
 *   GET  /sync/:motebitId/clock          — latest version clock
 *   POST /identity                       — create identity for device registration
 *   GET  /identity/:motebitId            — load identity
 *
 * WebSocket protocol:
 *   Client → Server:  { type: "push", events: EventLogEntry[] }
 *   Server → Client:  { type: "event", event: EventLogEntry }
 *   Server → Client:  { type: "ack", accepted: number }
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
import { createMotebitDatabase } from "@motebit/persistence";
import type { MotebitDatabase } from "@motebit/persistence";
import type { EventLogEntry, ToolAuditEntry } from "@motebit/sdk";
import type { WSContext } from "hono/ws";
import { verifySignedToken } from "@motebit/crypto";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/** Decode the payload half of a signed token without verifying the signature. */
function parseTokenPayloadUnsafe(token: string): { mid: string; did: string; iat: number; exp: number } | null {
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
  apiToken?: string;       // Legacy single token (still supported as admin/master token)
  corsOrigin?: string;
  enableDeviceAuth?: boolean;  // When true, validates per-device tokens (default: true)
  verifyDeviceSignature?: boolean;  // When true, uses Ed25519 signed token verification (default: true)
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

export function createSyncRelay(config: SyncRelayConfig = {}): SyncRelay {
  const { dbPath = ":memory:", apiToken, corsOrigin = "*", enableDeviceAuth = true, verifyDeviceSignature = true } = config;

  const moteDb: MotebitDatabase = createMotebitDatabase(dbPath);
  const eventStore = new EventStore(moteDb.eventStore);
  const identityManager = new IdentityManager(moteDb.identityStorage, eventStore);

  // Track connected WebSocket clients per motebitId with device identity
  const connections = new Map<string, ConnectedDevice[]>();

  const app = new Hono();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // --- Middleware ---
  app.use("*", secureHeaders());
  app.use("*", cors({ origin: corsOrigin }));

  if (apiToken) {
    app.use("/identity/*", bearerAuth({ token: apiToken }));
    app.use("/identity", bearerAuth({ token: apiToken }));
    // Device registration is protected by the master token
    app.use("/device/*", bearerAuth({ token: apiToken }));
  }

  if (enableDeviceAuth) {
    // Device auth middleware for sync routes: validates per-device tokens or signed tokens
    app.use("/sync/*", async (c, next) => {
      const authHeader = c.req.header("authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        throw new HTTPException(401, { message: "Missing device token" });
      }
      const token = authHeader.slice(7);

      // Master token bypass
      if (apiToken && token === apiToken) {
        await next();
        return;
      }

      // Extract motebitId from URL path (/sync/:motebitId/...)
      const pathParts = new URL(c.req.url, "http://localhost").pathname.split("/");
      const motebitId = pathParts[2];
      if (!motebitId) {
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
  } else if (apiToken) {
    // Legacy single-token auth for sync routes
    app.use("/sync/*", bearerAuth({ token: apiToken }));
  }

  // --- Error handler ---
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: err.message, status: err.status }, err.status);
    }
    console.error(err);
    return c.json({ error: "Internal server error", status: 500 }, 500);
  });

  // --- Health (public, no auth) ---
  app.get("/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));

  // --- WebSocket: bidirectional event stream ---
  app.get(
    "/ws/sync/:motebitId",
    upgradeWebSocket((c) => {
      const motebitId = c.req.param("motebitId");
      const url = new URL(c.req.url, "http://localhost");
      const deviceId = url.searchParams.get("device_id") ?? crypto.randomUUID();
      const token = url.searchParams.get("token");

      return {
        async onOpen(_event, ws) {
          // Validate token for WebSocket connections
          if (enableDeviceAuth && token) {
            // Master token bypass
            if (apiToken && token === apiToken) {
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
          } else if (apiToken && token !== apiToken) {
            ws.close(4001, "Unauthorized");
            return;
          }

          if (!connections.has(motebitId)) {
            connections.set(motebitId, []);
          }
          connections.get(motebitId)!.push({ ws, deviceId });
        },

        async onMessage(event, ws) {
          try {
            const msg = JSON.parse(String(event.data)) as { type: string; events?: EventLogEntry[] };

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
                    if (peer.ws !== ws) {
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
            const idx = peers.findIndex(p => p.ws === ws);
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
      throw new HTTPException(400, { message: "Missing or invalid 'events' field (must be array)" });
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
    const body = await c.req.json<{ motebit_id: string; device_name?: string; public_key?: string }>();
    if (!body.motebit_id) {
      throw new HTTPException(400, { message: "Missing 'motebit_id' field" });
    }
    if (body.public_key !== undefined && (typeof body.public_key !== "string" || !/^[0-9a-f]{64}$/i.test(body.public_key))) {
      throw new HTTPException(400, { message: "Invalid 'public_key' — must be 64-char hex string (32 bytes Ed25519 public key)" });
    }
    const identity = await identityManager.load(body.motebit_id);
    if (!identity) {
      throw new HTTPException(404, { message: "Identity not found" });
    }
    const device = await identityManager.registerDevice(body.motebit_id, body.device_name, body.public_key);
    return c.json(device, 201);
  });

  // --- Audit: query tool audit log ---
  if (apiToken) {
    app.use("/api/v1/*", bearerAuth({ token: apiToken }));
  }

  app.get("/api/v1/audit/:motebitId", async (c) => {
    const motebitId = c.req.param("motebitId");
    const turnId = c.req.query("turn_id");
    let entries: ToolAuditEntry[] = [];
    if (moteDb.toolAuditSink) {
      entries = turnId
        ? moteDb.toolAuditSink.query(turnId)
        : moteDb.toolAuditSink.getAll();
    }
    return c.json({ motebit_id: motebitId, entries });
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

  function close(): void {
    // Close all WebSocket connections
    for (const peers of connections.values()) {
      for (const peer of peers) {
        peer.ws.close();
      }
    }
    connections.clear();
    moteDb.close();
  }

  // Inject WebSocket support into the underlying Node.js server
  const originalApp = app as Hono & { injectWebSocket?: typeof injectWebSocket };
  originalApp.injectWebSocket = injectWebSocket;

  return { app, close, connections };
}

// === Standalone boot ===

const app = process.env.VITEST ? new Hono() : createSyncRelay({
  dbPath: process.env.MOTEBIT_DB_PATH,
  apiToken: process.env.MOTEBIT_API_TOKEN,
  corsOrigin: process.env.MOTEBIT_CORS_ORIGIN,
  enableDeviceAuth: process.env.MOTEBIT_ENABLE_DEVICE_AUTH !== "false",
}).app;

if (!process.env.VITEST) {
  const port = Number(process.env.PORT ?? 3000);
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`Motebit sync relay listening on http://localhost:${info.port}`);
  });
  // Inject WebSocket support
  const injectWs = (app as Hono & { injectWebSocket?: (server: unknown) => void }).injectWebSocket;
  if (injectWs) injectWs(server);
}

export default app;
export { app };
