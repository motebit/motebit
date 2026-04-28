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
  parseTokenPayloadUnsafe: (token: string) => import("./auth.js").TokenPayload | null;
  logger: ReturnType<typeof createLogger>;
  onCommandResponse?: (commandId: string, result: unknown) => void;
  /** When true, new WebSocket upgrades are rejected with close code 1001. */
  isDraining?: () => boolean;
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

  /** @internal */
  app.get(
    "/ws/sync/:motebitId",
    upgradeWebSocket((c) => {
      // Route param is guaranteed by /ws/sync/:motebitId pattern; guard in onOpen for defense-in-depth
      const motebitId = asMotebitId(c.req.param("motebitId") as string);
      const url = new URL(c.req.url, "http://localhost");
      const deviceId = url.searchParams.get("device_id") ?? crypto.randomUUID();
      // Backwards compat: accept token from query param during migration.
      // Preferred path: post-connect auth frame (token never in URL).
      const queryToken = url.searchParams.get("token");

      // Per-connection rate limit key — wsLimiter provides 100 msg/10s
      const wsRateKey = `ws:${motebitId}:${deviceId}`;

      // Track whether this connection has been authenticated (via query param or auth frame)
      let authenticated = false;
      // Track whether we're still waiting for an auth frame (connection not yet finalized)
      let awaitingAuthFrame = false;

      /**
       * Validate a bearer token (shared by query-param and post-connect auth frame paths).
       * Returns true if valid, false if invalid (and closes the WS unless suppressClose).
       * When `sendAuthResult` is true, sends auth_result frame on failure instead of closing directly.
       */
      async function validateToken(
        token: string,
        mid: string,
        ws: WSContext,
        sendAuthResult = false,
      ): Promise<boolean> {
        if (enableDeviceAuth) {
          // Master token bypass
          if (apiToken != null && apiToken !== "" && token === apiToken) {
            logger.info("auth.master_token_ws", { motebitId: mid });
            return true;
          }
          if (!token.includes(".")) {
            // Legacy device tokens (plain UUIDs) are no longer accepted
            if (sendAuthResult) {
              ws.send(
                JSON.stringify({
                  type: "auth_result",
                  ok: false,
                  error: "Legacy device tokens are no longer accepted",
                }),
              );
            }
            ws.close(4003, "Legacy device tokens are no longer accepted");
            return false;
          }
          // Signed token verification
          const verified = await verifySignedTokenForDevice(
            token,
            mid,
            identityManager,
            "sync",
            isTokenBlacklisted,
            isAgentRevoked,
          );
          if (!verified) {
            if (sendAuthResult) {
              ws.send(JSON.stringify({ type: "auth_result", ok: false, error: "Unauthorized" }));
            }
            ws.close(4003, "Unauthorized");
            return false;
          }
          return true;
        }
        // No device auth — check apiToken (shared secret)
        if (apiToken != null && apiToken !== "" && token !== apiToken) {
          if (sendAuthResult) {
            ws.send(JSON.stringify({ type: "auth_result", ok: false, error: "Unauthorized" }));
          }
          ws.close(4001, "Unauthorized");
          return false;
        }
        return true;
      }

      /** Finalize a connection: register in connections map, recover pending tasks. */
      function finalizeConnection(ws: WSContext): void {
        // Parse device capabilities from URL query param
        const capsParam = url.searchParams.get("capabilities");
        const capabilities =
          capsParam != null && capsParam !== ""
            ? capsParam.split(",").filter((cap) => cap !== "")
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
      }

      return {
        // eslint-disable-next-line @typescript-eslint/no-misused-promises -- hono ws adapter supports async handlers
        async onOpen(_event, ws) {
          // Reject new connections during graceful drain
          if (deps.isDraining?.()) {
            ws.close(1001, "Server is draining");
            return;
          }

          if (motebitId == null) {
            ws.close(4000, "Missing motebitId");
            return;
          }

          // Backwards compat: if token was provided via query param, validate it now
          if (queryToken != null && queryToken !== "") {
            const authResult = await validateToken(queryToken, motebitId, ws);
            if (!authResult) return; // ws already closed by validateToken
            authenticated = true;
          } else if (enableDeviceAuth) {
            // Device auth required but no query token — wait for post-connect auth frame
            awaitingAuthFrame = true;
          } else if (apiToken != null && apiToken !== "") {
            // API token required but no token at all — wait for post-connect auth frame
            awaitingAuthFrame = true;
          }

          // If already authenticated (query param) or no auth required, finalize connection
          if (!awaitingAuthFrame) {
            finalizeConnection(ws);
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
              token?: string;
              events?: EventLogEntry[];
              conversations?: SyncConversation[];
              messages?: SyncConversationMessage[];
              task_id?: string;
              capabilities?: string[];
            };

            // Post-connect auth frame: client sends { type: "auth", token: "..." }
            // as the first message. Validate and respond with auth_result.
            if (msg.type === "auth") {
              if (authenticated) {
                // Already authenticated (e.g. via query param) — ignore duplicate auth
                ws.send(JSON.stringify({ type: "auth_result", ok: true }));
                return;
              }
              const token = typeof msg.token === "string" ? msg.token : "";
              if (token === "") {
                ws.send(JSON.stringify({ type: "auth_result", ok: false, error: "Missing token" }));
                ws.close(4001, "Missing token");
                return;
              }
              const valid = await validateToken(token, motebitId, ws, true);
              if (!valid) {
                // validateToken already sent auth_result with ok:false and closed
                return;
              }
              authenticated = true;
              awaitingAuthFrame = false;
              ws.send(JSON.stringify({ type: "auth_result", ok: true }));
              finalizeConnection(ws);
              return;
            }

            // Reject all non-auth messages if still waiting for auth frame
            if (awaitingAuthFrame) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: "Authentication required. Send auth frame first.",
                }),
              );
              return;
            }

            // Agent protocol: capabilities_announce
            if (msg.type === "capabilities_announce" && Array.isArray(msg.capabilities)) {
              const peers = connections.get(motebitId);
              if (peers) {
                const self = peers.find((p) => p.ws === ws);
                if (self) self.capabilities = msg.capabilities;
              }
            }

            // Agent protocol: command_response (forwarded runtime command result)
            if (
              msg.type === "command_response" &&
              typeof (msg as Record<string, unknown>).id === "string"
            ) {
              const cmdMsg = msg as unknown as { id: string; result: unknown };
              deps.onCommandResponse?.(cmdMsg.id, cmdMsg.result);
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
                taskQueue.set(taskId, entry); // Persist claim to durable queue

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
                      taskQueue.set(taskId, entry); // Persist rollback
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
