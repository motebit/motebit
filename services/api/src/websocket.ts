/**
 * WebSocket route handler for bidirectional event stream.
 * Extracted from index.ts — zero behavior changes.
 *
 * Handles /ws/sync/:motebitId with onOpen (auth + task recovery),
 * onMessage (push events, conversations, messages, task claims, capabilities),
 * and onClose (connection cleanup).
 */

import type { Hono } from "hono";
import type { createNodeWebSocket } from "@hono/node-ws";
import type { WSContext } from "hono/ws";
import type { EventStore } from "@motebit/event-log";
import type { IdentityManager } from "@motebit/core-identity";
import type { DatabaseDriver } from "@motebit/persistence";
import type { EventLogEntry, SyncConversation, SyncConversationMessage } from "@motebit/sdk";
import { AgentTaskStatus, asMotebitId } from "@motebit/sdk";
import type { FixedWindowLimiter } from "./rate-limiter.js";
import { upsertSyncConversation, upsertSyncMessage } from "./data-sync.js";
import type { TaskQueueEntry } from "./tasks.js";
import type { createLogger } from "./logger.js";

export interface ConnectedDevice {
  ws: WSContext;
  deviceId: string;
  capabilities?: string[];
}

export interface WebSocketDeps {
  app: Hono;
  upgradeWebSocket: ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"];
  connections: Map<string, ConnectedDevice[]>;
  taskQueue: Map<string, TaskQueueEntry>;
  eventStore: EventStore;
  identityManager: IdentityManager;
  db: DatabaseDriver;
  apiToken: string | undefined;
  enableDeviceAuth: boolean;
  wsLimiter: FixedWindowLimiter;
  isTokenBlacklisted: (jti: string, motebitId: string) => boolean;
  isAgentRevoked: (motebitId: string) => boolean;
  verifySignedTokenForDevice: (
    token: string,
    motebitId: string,
    identityManager: IdentityManager,
    expectedAudience: string,
    blacklistCheck?: (jti: string, motebitId: string) => boolean,
    agentRevokedCheck?: (motebitId: string) => boolean,
  ) => Promise<boolean>;
  parseTokenPayloadUnsafe: (
    token: string,
  ) => { mid: string; did: string; iat: number; exp: number; jti?: string } | null;
  logger: ReturnType<typeof createLogger>;
}

export function registerWebSocketRoutes(deps: WebSocketDeps): void {
  const {
    app,
    upgradeWebSocket,
    connections,
    taskQueue,
    eventStore,
    identityManager,
    db,
    apiToken,
    enableDeviceAuth,
    wsLimiter,
    isTokenBlacklisted,
    isAgentRevoked,
    verifySignedTokenForDevice,
    logger,
  } = deps;

  app.get(
    "/ws/sync/:motebitId",
    upgradeWebSocket((c) => {
      // Route param is guaranteed by /ws/sync/:motebitId pattern; guard in onOpen for defense-in-depth
      const motebitId = asMotebitId(c.req.param("motebitId") as string);
      const url = new URL(c.req.url, "http://localhost");
      const deviceId = url.searchParams.get("device_id") ?? crypto.randomUUID();
      const token = url.searchParams.get("token");

      // Per-connection rate limit key — wsLimiter provides 100 msg/10s
      const wsRateKey = `ws:${motebitId}:${deviceId}`;

      return {
        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- hono ws adapter supports async handlers
        async onOpen(_event, ws) {
          if (motebitId == null) {
            ws.close(4000, "Missing motebitId");
            return;
          }

          // Validate token for WebSocket connections
          if (enableDeviceAuth && token != null && token !== "") {
            // Master token bypass
            if (apiToken != null && apiToken !== "" && token === apiToken) {
              // OK — master token (WebSocket)
              logger.info("auth.master_token_ws", { motebitId });
            } else if (token.includes(".")) {
              // Signed token verification — O(1) lookup by device ID from token payload
              const verified = await verifySignedTokenForDevice(
                token,
                motebitId,
                identityManager,
                "sync",
                isTokenBlacklisted,
                isAgentRevoked,
              );
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

          // Parse device capabilities from URL query param
          const capsParam = url.searchParams.get("capabilities");
          const capabilities =
            capsParam != null && capsParam !== ""
              ? capsParam.split(",").filter((c) => c !== "")
              : undefined;

          if (!connections.has(motebitId)) {
            connections.set(motebitId, []);
          }
          connections.get(motebitId)!.push({ ws, deviceId, capabilities });

          // Task recovery: re-dispatch any pending tasks for this agent to the
          // newly connected device. Covers reconnection after disconnect (e.g.
          // cellular→WiFi handoff) and federation-forwarded tasks that arrived
          // while no device was connected.
          for (const [, entry] of taskQueue) {
            if (
              entry.task.motebit_id === motebitId &&
              entry.task.status === AgentTaskStatus.Pending &&
              !entry.receipt
            ) {
              ws.send(JSON.stringify({ type: "task_request", task: entry.task }));
              logger.info("task.recovery_on_reconnect", {
                correlationId: entry.task.task_id,
                motebitId,
                deviceId,
              });
            }
          }
        },

        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- hono ws adapter supports async handlers
        async onMessage(event, ws) {
          // Per-connection rate limiting (shared FixedWindowLimiter, keyed by connection)
          const { allowed } = wsLimiter.check(wsRateKey);
          if (!allowed) {
            ws.send(JSON.stringify({ type: "error", message: "Rate limit exceeded" }));
            return;
          }

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
              capabilities?: string[];
            };

            // Agent protocol: capabilities_announce
            if (msg.type === "capabilities_announce" && Array.isArray(msg.capabilities)) {
              const peers = connections.get(motebitId);
              if (peers) {
                const self = peers.find((p) => p.ws === ws);
                if (self) self.capabilities = msg.capabilities;
              }
            }

            // Agent protocol: task_claim
            if (msg.type === "task_claim" && msg.task_id) {
              const taskId = msg.task_id;
              const entry = taskQueue.get(taskId);

              if (!entry || entry.task.motebit_id !== motebitId) {
                ws.send(
                  JSON.stringify({
                    type: "task_claim_rejected",
                    task_id: taskId,
                    reason: "Task not found",
                  }),
                );
              } else if (entry.task.status !== AgentTaskStatus.Pending) {
                // Already claimed — atomic check: status is read BEFORE any async work
                ws.send(
                  JSON.stringify({
                    type: "task_claim_rejected",
                    task_id: taskId,
                    reason: "already_claimed",
                  }),
                );
              } else {
                // Atomic claim: set status BEFORE any further checks or responses.
                // Safe in single-threaded JS; prevents bugs if relay ever runs with
                // worker threads or multi-instance.
                entry.task.status = AgentTaskStatus.Claimed;
                entry.task.claimed_by = deviceId;

                // Verify claiming device has required capabilities
                const requiredCaps = entry.task.required_capabilities ?? [];
                if (requiredCaps.length > 0) {
                  const claimingPeers = connections.get(motebitId);
                  const claimingDevice = claimingPeers?.find((p) => p.ws === ws);
                  if (claimingDevice?.capabilities) {
                    const hasAll = requiredCaps.every((c) =>
                      claimingDevice.capabilities!.includes(c),
                    );
                    if (!hasAll) {
                      // Roll back claim — device lacks capabilities
                      entry.task.status = AgentTaskStatus.Pending;
                      entry.task.claimed_by = undefined;
                      ws.send(
                        JSON.stringify({
                          type: "task_claim_rejected",
                          task_id: taskId,
                          reason: "Device lacks required capabilities",
                        }),
                      );
                    } else {
                      ws.send(JSON.stringify({ type: "task_claimed", task_id: taskId }));
                    }
                  } else {
                    ws.send(JSON.stringify({ type: "task_claimed", task_id: taskId }));
                  }
                } else {
                  ws.send(JSON.stringify({ type: "task_claimed", task_id: taskId }));
                }
              }
            }

            if (msg.type === "push" && Array.isArray(msg.events)) {
              let wsAccepted = 0;
              for (const entry of msg.events) {
                // Receipt idempotency: skip events with duplicate receipt signatures
                const receipt = entry.payload?.receipt as Record<string, unknown> | undefined;
                if (receipt && typeof receipt.signature === "string" && receipt.signature !== "") {
                  const existing = await eventStore.query({ motebit_id: entry.motebit_id });
                  const isDuplicate = existing.some((e) => {
                    const r = e.payload?.receipt as Record<string, unknown> | undefined;
                    return r && r.signature === receipt.signature;
                  });
                  if (isDuplicate) continue;
                }
                await eventStore.append(entry);
                wsAccepted++;
              }

              // Acknowledge
              ws.send(JSON.stringify({ type: "ack", accepted: wsAccepted }));

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
                upsertSyncConversation(db, conv);
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
                upsertSyncMessage(db, m);
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
}
