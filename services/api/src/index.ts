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
 *   POST /sync/:motebitId/plans                          — push plans
 *   GET  /sync/:motebitId/plans?since=<ts>               — pull plans
 *   POST /sync/:motebitId/plan-steps                     — push plan steps
 *   GET  /sync/:motebitId/plan-steps?since=<ts>          — pull plan steps
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
 *   GET  /api/v1/execution/:motebitId/:goalId          — execution ledger manifest
 *   GET  /api/v1/agent-trust/:motebitId                 — agent trust records
 *   GET  /api/v1/gradient/:motebitId?limit=100         — intelligence gradient snapshots
 *   GET  /api/v1/sync/:motebitId/pull                  — pull events (aliased for admin)
 *   POST /api/v1/agents/register                       — register/refresh agent MCP endpoint
 *   POST /api/v1/agents/heartbeat                      — refresh agent TTL
 *   GET  /api/v1/agents/discover?capability=&motebit_id=&limit= — discover agents
 *   GET  /api/v1/agents/:motebitId                     — get specific agent
 *   DELETE /api/v1/agents/deregister                   — remove agent registration
 *   POST /api/v1/agents/:motebitId/listing              — register/update service listing
 *   GET  /api/v1/agents/:motebitId/listing              — get service listing
 *   GET  /api/v1/agents/:motebitId/credentials?type=&limit=  — credentials issued to agent
 *   POST /api/v1/agents/:motebitId/credentials/submit        — peer submits collected credentials for relay indexing
 *   POST /api/v1/agents/:motebitId/presentation?type=  — bundle credentials into signed VP
 *   POST /agent/:motebitId/ledger                       — submit signed execution ledger
 *   GET  /agent/:motebitId/ledger/:goalId               — retrieve signed execution ledger
 *   POST /api/v1/agents/:motebitId/revoke-tokens             — blacklist specific token JTIs (agent auth)
 *   POST /api/v1/agents/:motebitId/revoke-credential        — revoke a verifiable credential (agent auth)
 *   POST /api/v1/agents/:motebitId/revoke                   — mark agent identity as revoked (agent auth)
 *   GET  /api/v1/credentials/:credentialId/status            — credential revocation status (public)
 *   POST /api/v1/credentials/verify                        — verify a VerifiableCredential (public)
 *   GET  /api/v1/market/candidates?capability=&max_budget=&limit= — scored candidate list (max_budget filters, x402 handles payment)
 *   POST /api/v1/agents/bootstrap                       — register identity + device in one unauthenticated call (rate-limited)
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
import { EventStore } from "@motebit/event-log";
import { IdentityManager } from "@motebit/core-identity";
import { openMotebitDatabase } from "@motebit/persistence";
import type { MotebitDatabase } from "@motebit/persistence";
import { createLogger } from "./logger.js";
import { createRelaySchema } from "./schema.js";
import { parseTokenPayloadUnsafe, verifySignedTokenForDevice } from "./auth.js";
import { registerMiddleware, registerAuthMiddleware } from "./middleware.js";
import { registerWebSocketRoutes } from "./websocket.js";
import type { ConnectedDevice } from "./websocket.js";
import { registerSyncRoutes, redactSensitiveEvents } from "./sync-routes.js";
import {
  createFederationTables,
  initRelayIdentity,
  createFederationQueryCache,
  registerFederationRoutes,
  startHeartbeatLoop,
  startSettlementRetryLoop,
} from "./federation.js";
import type { RelayIdentity } from "./federation.js";
import { startBatchAnchorLoop } from "./anchoring.js";
import { registerCredentialRoutes } from "./credentials.js";
import { registerProxyTokenRoutes, createSubscriptionTables } from "./subscriptions.js";
import { registerA2ARoutes } from "./a2a-bridge.js";
import { createTaskRouter } from "./task-routing.js";
import { createDataSyncTables, registerDataSyncRoutes } from "./data-sync.js";
import { createAccountTables, createWithdrawalTables, creditAccount } from "./accounts.js";
import { createPairingTables, registerPairingRoutes } from "./pairing.js";
import { registerStateExportRoutes } from "./state-export.js";
import { registerTrustGraphRoutes } from "./trust-graph.js";
import { registerListingsRoutes } from "./listings.js";
import { registerProposalRoutes } from "./proposals.js";
import { registerKeyRotationRoutes } from "./key-rotation.js";
import { registerBudgetRoutes } from "./budget.js";
import { registerAgentRoutes } from "./agents.js";
import { createFederationCallbacks } from "./federation-callbacks.js";
import { registerTaskRoutes, type TaskQueueEntry } from "./tasks.js";
import { registerCommandRoutes, handleCommandResponse } from "./command-route.js";
import Stripe from "stripe";

// === Re-exports for backward compatibility (tests and sibling modules import from index) ===

export { parseTokenPayloadUnsafe, verifySignedTokenForDevice } from "./auth.js";
export type { ConnectedDevice } from "./websocket.js";

// === Config ===

/** x402 payment configuration — the relay's settlement layer. */
export interface X402Config {
  /** Relay operator's wallet address — receives platform fees. */
  payToAddress: string;
  /** CAIP-2 network identifier (e.g. "eip155:8453" for Base mainnet, "eip155:84532" for Base Sepolia). */
  network: string;
  /** x402 facilitator URL. Default: "https://x402.org/facilitator" (testnet). */
  facilitatorUrl?: string;
  /** Whether this is testnet. Default: true. */
  testnet?: boolean;
}

export interface SyncRelayConfig {
  dbPath?: string;
  apiToken?: string; // Legacy single token (still supported as admin/master token)
  corsOrigin?: string;
  enableDeviceAuth?: boolean; // When true, validates per-device tokens (default: true)
  /** x402 on-chain payment for task submission. Required in production. */
  x402: X402Config;
  /** When true, relay issues AgentReputationCredentials on verified receipts. Default: false (peer-issued). */
  issueCredentials?: boolean;
  /** When true, relay starts in emergency freeze mode — all write operations are suspended. */
  emergencyFreeze?: boolean;
  /** Max pending tasks per submitter. Default: 1000. */
  maxTasksPerSubmitter?: number;
  /** Federation configuration. Omit to disable federation. */
  federation?: {
    /** Display name for this relay in the federation. */
    displayName?: string;
    /** Public endpoint URL for this relay (how peers reach us). */
    endpointUrl?: string;
    /** Enable/disable federation entirely. Default: true when endpointUrl is set. */
    enabled?: boolean;
    /** Maximum number of active peers. Default: 50. */
    maxPeers?: number;
    /** Auto-accept incoming peering proposals. Default: false. */
    autoAcceptPeers?: boolean;
    /** Allowlist of relay IDs that can peer. Empty = allow any. */
    allowedPeers?: string[];
    /** Blocklist of relay IDs that cannot peer. Takes precedence over allowlist. */
    blockedPeers?: string[];
  };
  /** Platform fee rate for settlement (0–1). Default: 0.05 (5%). Protocol supports any value. */
  platformFeeRate?: number;
  /** Stripe Checkout configuration. Omit to disable Stripe deposits. */
  stripe?: {
    secretKey: string;
    webhookSecret: string;
    currency?: string; // default 'usd'
  };
}

export interface SyncRelay {
  app: Hono;
  close(): void;
  /** Connected WebSocket clients per motebitId. Exposed for testing. */
  connections: Map<string, ConnectedDevice[]>;
  /** Persistent relay identity. Stable across restarts. */
  relayIdentity: {
    relayMotebitId: string;
    publicKeyHex: string;
    did: string;
  };
  /** Database handle. Exposed for testing (plan store, audit sink, etc.). */
  moteDb: MotebitDatabase;
  /** Whether the relay is in emergency freeze mode (all writes suspended). */
  emergencyFreeze: boolean;
}

// === Factory ===

export async function createSyncRelay(config: SyncRelayConfig): Promise<SyncRelay> {
  const {
    dbPath = ":memory:",
    apiToken,
    corsOrigin = "*",
    enableDeviceAuth = true,
    x402: x402Config,
    issueCredentials = process.env.MOTEBIT_RELAY_ISSUE_CREDENTIALS === "true",
    federation: federationConfig,
    stripe: stripeConfig,
    platformFeeRate = parseFloat(process.env.MOTEBIT_PLATFORM_FEE_RATE ?? "0.05"),
  } = config;

  // Emergency freeze: runtime toggle for kill switch. When true, all state-mutating
  // operations (POST/PUT/PATCH/DELETE) return 503. Reads remain available.
  // Shared mutable object so budget.ts freeze/unfreeze routes can toggle the same state.
  const freezeState = {
    frozen: config.emergencyFreeze ?? false,
    reason: config.emergencyFreeze ? ("startup" as string | null) : null,
  };
  const getEmergencyFreeze = () => freezeState.frozen;
  const getFreezeReason = () => freezeState.reason;

  const stripeClient = stripeConfig ? new Stripe(stripeConfig.secretKey) : null;

  const moteDb: MotebitDatabase = await openMotebitDatabase(dbPath);
  const eventStore = new EventStore(moteDb.eventStore);
  const identityManager = new IdentityManager(moteDb.identityStorage, eventStore);

  // --- Tables from extracted modules (federation must precede relay schema for ALTER TABLE) ---
  createFederationTables(moteDb.db);
  createPairingTables(moteDb.db);
  createDataSyncTables(moteDb.db);
  createAccountTables(moteDb.db);
  createWithdrawalTables(moteDb.db);
  createSubscriptionTables(moteDb.db);

  // --- Schema: relay-owned tables, migrations, startup cleanup ---
  const { isTokenBlacklisted, isAgentRevoked } = createRelaySchema(moteDb.db);

  // --- Shared state ---
  const connections = new Map<string, ConnectedDevice[]>();

  const TASK_TTL_MS = 10 * 60 * 1000; // 10 minutes
  const MAX_TASK_QUEUE_SIZE = 100_000;
  const MAX_TASKS_PER_SUBMITTER = config.maxTasksPerSubmitter ?? 1_000;
  const taskQueue = new Map<string, TaskQueueEntry>();

  // --- Relay Identity: persistent Ed25519 keypair ---
  const relayIdentity: RelayIdentity = await initRelayIdentity(
    moteDb.db,
    process.env.MOTEBIT_RELAY_KEY_PASSPHRASE,
  );

  // --- Task routing & federation query cache ---
  const taskRouter = createTaskRouter({ db: moteDb.db, relayIdentity, federationConfig });
  const { cache: federationQueryCache, pruneInterval: federationQueryPruneInterval } =
    createFederationQueryCache();

  // --- Hono app & WebSocket ---
  const app = new Hono();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- hono utility functions, not bound methods
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  const logger = createLogger({ service: "relay" });

  // --- Middleware (rate limiting, CORS, security headers, auth, error handling, health) ---
  const { allLimiters, wsLimiter } = registerMiddleware({
    app,
    apiToken,
    corsOrigin,
    enableDeviceAuth,
    identityManager,
    getEmergencyFreeze,
    getFreezeReason,
    isTokenBlacklisted,
    isAgentRevoked,
    verifySignedTokenForDevice,
    parseTokenPayloadUnsafe,
  });

  // --- Cleanup interval (task expiry, limiter cleanup, stale allocations) ---
  // Stays in index.ts because it touches the local taskQueue map and allLimiters array.
  const taskCleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of taskQueue) {
      if (entry.expiresAt < now) {
        taskQueue.delete(id);
      }
    }
    // Evict oldest entries if queue exceeds hard cap (defensive against flooding)
    if (taskQueue.size > MAX_TASK_QUEUE_SIZE) {
      const entries = [...taskQueue.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      const toEvict = entries.slice(0, taskQueue.size - MAX_TASK_QUEUE_SIZE);
      for (const [id] of toEvict) {
        taskQueue.delete(id);
      }
      logger.warn("task_queue.eviction", { evicted: toEvict.length, remaining: taskQueue.size });
    }
    // Clean expired agent registrations
    const stmtClean = moteDb.db.prepare("DELETE FROM agent_registry WHERE expires_at < ?");
    stmtClean.run(now);
    // Clean expired rate limit entries
    for (const limiter of allLimiters) {
      limiter.cleanup();
    }
    // Expire pending proposals past their TTL
    try {
      moteDb.db
        .prepare(
          "UPDATE relay_proposals SET status = 'expired', updated_at = ? WHERE status = 'pending' AND expires_at < ?",
        )
        .run(now, now);
    } catch {
      // Best-effort cleanup
    }
    // Clean stale service listings not updated in 7 days
    try {
      const listingCutoff = now - 7 * 24 * 60 * 60 * 1000;
      moteDb.db
        .prepare("DELETE FROM relay_service_listings WHERE updated_at < ?")
        .run(listingCutoff);
    } catch {
      // Best-effort cleanup
    }
    // Release stale budget allocations locked > 1 hour with no settlement.
    // Return held funds to the delegator's virtual account.
    try {
      const staleAllocations = moteDb.db
        .prepare(
          "SELECT allocation_id, task_id, motebit_id, amount_locked FROM relay_allocations WHERE status = 'locked' AND created_at < ?",
        )
        .all(now - 3_600_000) as Array<{
        allocation_id: string;
        task_id: string;
        motebit_id: string;
        amount_locked: number;
      }>;

      if (staleAllocations.length > 0) {
        moteDb.db.exec("BEGIN");
        try {
          for (const alloc of staleAllocations) {
            const taskEntry = taskQueue.get(alloc.task_id);
            const delegatorId = taskEntry?.submitted_by ?? alloc.motebit_id;
            creditAccount(
              moteDb.db,
              delegatorId,
              alloc.amount_locked,
              "allocation_release",
              alloc.allocation_id,
              `Stale allocation release for task ${alloc.task_id}`,
            );
          }
          moteDb.db
            .prepare(
              "UPDATE relay_allocations SET status = 'released', released_at = ? WHERE status = 'locked' AND created_at < ?",
            )
            .run(now, now - 3_600_000);
          moteDb.db.exec("COMMIT");
        } catch {
          moteDb.db.exec("ROLLBACK");
        }
      }
    } catch {
      // Best-effort cleanup
    }
  }, 60_000);

  // --- WebSocket routes ---
  registerWebSocketRoutes({
    app,
    upgradeWebSocket,
    connections,
    taskQueue,
    eventStore,
    identityManager,
    db: moteDb.db,
    apiToken,
    enableDeviceAuth,
    wsLimiter,
    isTokenBlacklisted,
    isAgentRevoked,
    verifySignedTokenForDevice,
    parseTokenPayloadUnsafe,
    logger,
    onCommandResponse: handleCommandResponse,
  });

  // --- Sync routes (HTTP fallback, device registration, identity CRUD) ---
  registerSyncRoutes({ app, moteDb, eventStore, identityManager, connections });

  // --- Auth middleware for task/budget/admin routes (must run after registerMiddleware) ---
  registerAuthMiddleware({
    app,
    apiToken,
    corsOrigin,
    enableDeviceAuth,
    identityManager,
    getEmergencyFreeze,
    getFreezeReason,
    isTokenBlacklisted,
    isAgentRevoked,
    verifySignedTokenForDevice,
    parseTokenPayloadUnsafe,
  });

  // --- Federation routes ---
  const federationCallbacks = createFederationCallbacks({
    moteDb,
    identityManager,
    relayIdentity,
    connections,
    taskQueue,
    issueCredentials,
    maxTaskQueueSize: MAX_TASK_QUEUE_SIZE,
    maxTasksPerSubmitter: MAX_TASKS_PER_SUBMITTER,
    taskTtlMs: TASK_TTL_MS,
    platformFeeRate,
  });

  registerFederationRoutes({
    db: moteDb.db,
    app,
    relayIdentity,
    federationConfig,
    federationQueryCache,
    queryLocalAgents: (capability, motebitId, limit) =>
      taskRouter.queryLocalAgents(capability, motebitId, limit),
    onTaskForwarded: (v) => federationCallbacks.onTaskForwarded(v),
    onTaskResultReceived: (v) => federationCallbacks.onTaskResultReceived(v),
    onSettlementReceived: (v) => federationCallbacks.onSettlementReceived(v),
  });

  // --- Proxy token + balance routes ---
  registerProxyTokenRoutes(app, moteDb.db, relayIdentity);

  // --- Credential routes ---
  registerCredentialRoutes({
    db: moteDb.db,
    app,
    relayIdentity,
    identityManager,
    issueCredentials,
  });

  // --- Pairing routes ---
  registerPairingRoutes({
    db: moteDb.db,
    app,
    apiToken,
    identityManager,
    parseTokenPayloadUnsafe,
    verifySignedTokenForDevice,
    isTokenBlacklisted,
    isAgentRevoked,
  });

  // --- State export routes (read-only agent state queries) ---
  registerStateExportRoutes({ app, moteDb, eventStore, identityManager, redactSensitiveEvents });

  // --- Trust graph routes ---
  registerTrustGraphRoutes({ app, moteDb, taskRouter });

  // --- Listings & market routes ---
  registerListingsRoutes({ app, moteDb, taskRouter });

  // --- Collaborative proposal routes ---
  registerProposalRoutes({ app, moteDb, connections });

  // --- Key rotation, revocation & approval routes ---
  registerKeyRotationRoutes({ app, moteDb, relayIdentity });

  // --- Data sync routes (conversations, messages, plans, plan steps) ---
  registerDataSyncRoutes({ db: moteDb.db, app, connections });

  // --- A2A protocol bridge ---
  const a2aRelayUrl = federationConfig?.endpointUrl ?? "http://localhost:3000";
  registerA2ARoutes(app, moteDb.db, {
    relayIdentity,
    relayUrl: a2aRelayUrl,
    relayVersion: "0.5.2",
  });

  // --- Budget, accounts & admin routes (after auth middleware) ---
  registerBudgetRoutes({
    app,
    moteDb,
    relayIdentity,
    freezeState,
    stripeClient,
    stripeConfig: stripeConfig ?? null,
  });

  // --- Agent routes (registration, discovery, capabilities, settlements, ledger) ---
  registerAgentRoutes({
    app,
    moteDb,
    identityManager,
    eventStore,
    relayIdentity,
    connections,
    taskRouter,
    apiToken,
    federationConfig,
    federationQueryCache,
    parseTokenPayloadUnsafe,
    verifySignedTokenForDevice,
    isTokenBlacklisted,
    isAgentRevoked,
  });

  // --- Command endpoint (unified remote execution) ---
  registerCommandRoutes({ app, db: moteDb.db, connections, logger });

  // --- Federation background loops ---

  const heartbeatInterval = startHeartbeatLoop(moteDb.db, relayIdentity, 60_000, () =>
    getEmergencyFreeze(),
  );

  // Settlement retry loop callback touches taskQueue — stays in index.ts
  const settlementRetryInterval = startSettlementRetryLoop(
    moteDb.db,
    relayIdentity,
    30_000,
    (retry) => {
      try {
        const alloc = moteDb.db
          .prepare(
            "SELECT allocation_id, task_id, motebit_id, amount_locked FROM relay_allocations WHERE task_id = ? AND status = 'locked'",
          )
          .get(retry.task_id) as
          | { allocation_id: string; task_id: string; motebit_id: string; amount_locked: number }
          | undefined;
        if (!alloc) return;
        const taskEntry = taskQueue.get(retry.task_id);
        const delegatorId = taskEntry?.submitted_by ?? alloc.motebit_id;
        moteDb.db.exec("BEGIN");
        try {
          creditAccount(
            moteDb.db,
            delegatorId,
            alloc.amount_locked,
            "allocation_release",
            alloc.allocation_id,
            `Retry exhaustion refund for task ${retry.task_id}`,
          );
          moteDb.db
            .prepare(
              "UPDATE relay_allocations SET status = 'released', released_at = ? WHERE allocation_id = ?",
            )
            .run(Date.now(), alloc.allocation_id);
          moteDb.db.exec("COMMIT");
          logger.info("settlement.retry.refunded", {
            taskId: retry.task_id,
            allocationId: alloc.allocation_id,
            amount: alloc.amount_locked,
            delegator: delegatorId,
          });
        } catch {
          moteDb.db.exec("ROLLBACK");
        }
      } catch {
        /* Best-effort refund */
      }
    },
    () => getEmergencyFreeze(),
  );

  const batchAnchorInterval = startBatchAnchorLoop(moteDb.db, relayIdentity, {}, () =>
    getEmergencyFreeze(),
  );

  // --- Task routes (submission, polling, receipt settlement) ---
  await registerTaskRoutes({
    app,
    moteDb,
    identityManager,
    eventStore,
    relayIdentity,
    connections,
    taskQueue,
    taskRouter,
    issueCredentials,
    apiToken,
    enableDeviceAuth,
    maxTasksPerSubmitter: MAX_TASKS_PER_SUBMITTER,
    x402Config: x402Config,
    parseTokenPayloadUnsafe,
    verifySignedTokenForDevice,
    isTokenBlacklisted,
    isAgentRevoked,
    platformFeeRate,
  });

  // --- Close / cleanup ---
  function close(): void {
    for (const peers of connections.values()) {
      for (const peer of peers) {
        peer.ws.close();
      }
    }
    connections.clear();
    clearInterval(taskCleanupInterval);
    clearInterval(federationQueryPruneInterval);
    clearInterval(heartbeatInterval);
    clearInterval(settlementRetryInterval);
    clearInterval(batchAnchorInterval);
    moteDb.close();
  }

  // Inject WebSocket support into the underlying Node.js server
  const originalApp = app as Hono & { injectWebSocket?: typeof injectWebSocket };
  originalApp.injectWebSocket = injectWebSocket;

  return {
    app,
    close,
    connections,
    relayIdentity: {
      relayMotebitId: relayIdentity.relayMotebitId,
      publicKeyHex: relayIdentity.publicKeyHex,
      did: relayIdentity.did,
    },
    moteDb,
    get emergencyFreeze() {
      return getEmergencyFreeze();
    },
  };
}

// === Standalone boot ===

let app: Hono;

if (process.env.VITEST != null) {
  app = new Hono();
} else {
  if (process.env.NODE_ENV === "production" && !process.env.MOTEBIT_DB_PATH) {
    createLogger({ service: "relay" }).error("relay.fatal", {
      reason: "MOTEBIT_DB_PATH must be set in production (otherwise data is lost on restart)",
    });
    process.exit(1);
  }
  // x402 payment layer: required — every task settlement flows through x402
  if (!process.env.X402_PAY_TO_ADDRESS) {
    throw new Error("X402_PAY_TO_ADDRESS is required. Set it to the platform USDC wallet address.");
  }
  const x402Env: X402Config = {
    payToAddress: process.env.X402_PAY_TO_ADDRESS,
    network: process.env.X402_NETWORK ?? "eip155:84532",
    facilitatorUrl: process.env.X402_FACILITATOR_URL,
    testnet: process.env.X402_TESTNET !== "false",
  };

  const relay = await createSyncRelay({
    dbPath: process.env.MOTEBIT_DB_PATH,
    apiToken: process.env.MOTEBIT_API_TOKEN,
    corsOrigin: process.env.MOTEBIT_CORS_ORIGIN,
    enableDeviceAuth: process.env.MOTEBIT_ENABLE_DEVICE_AUTH !== "false",
    emergencyFreeze: process.env.MOTEBIT_EMERGENCY_FREEZE === "true",
    x402: x402Env,
    federation: process.env.MOTEBIT_FEDERATION_ENDPOINT_URL
      ? {
          endpointUrl: process.env.MOTEBIT_FEDERATION_ENDPOINT_URL,
          displayName: process.env.MOTEBIT_FEDERATION_DISPLAY_NAME,
          enabled: process.env.MOTEBIT_FEDERATION_ENABLED !== "false",
          maxPeers: process.env.MOTEBIT_FEDERATION_MAX_PEERS
            ? parseInt(process.env.MOTEBIT_FEDERATION_MAX_PEERS, 10)
            : undefined,
          autoAcceptPeers: process.env.MOTEBIT_FEDERATION_AUTO_ACCEPT === "true",
          allowedPeers: process.env.MOTEBIT_FEDERATION_ALLOWED_PEERS
            ? process.env.MOTEBIT_FEDERATION_ALLOWED_PEERS.split(",").map((s) => s.trim())
            : undefined,
          blockedPeers: process.env.MOTEBIT_FEDERATION_BLOCKED_PEERS
            ? process.env.MOTEBIT_FEDERATION_BLOCKED_PEERS.split(",").map((s) => s.trim())
            : undefined,
        }
      : undefined,
    stripe:
      process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET
        ? {
            secretKey: process.env.STRIPE_SECRET_KEY,
            webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
            currency: process.env.STRIPE_CURRENCY,
          }
        : undefined,
  });
  app = relay.app;

  const port = Number(process.env.PORT ?? 3000);
  const bootLogger = createLogger({ service: "relay" });
  bootLogger.info("relay.starting", {
    db: process.env.MOTEBIT_DB_PATH ?? ":memory:",
    deviceAuth: process.env.MOTEBIT_ENABLE_DEVICE_AUTH !== "false",
    federation: process.env.MOTEBIT_FEDERATION_ENDPOINT_URL ?? "disabled",
    keyEncryption: process.env.MOTEBIT_RELAY_KEY_PASSPHRASE ? "active" : "disabled",
  });
  const server = serve({ fetch: app.fetch, port }, (info) => {
    bootLogger.info("relay.listening", { port: info.port });
  });
  // Inject WebSocket support
  const injectWs = (app as Hono & { injectWebSocket?: (server: unknown) => void }).injectWebSocket;
  if (injectWs) injectWs(server);
}

export default app;
export { app };
