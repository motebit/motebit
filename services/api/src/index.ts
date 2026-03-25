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
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { EventStore } from "@motebit/event-log";
import { IdentityManager } from "@motebit/core-identity";
import { openMotebitDatabase } from "@motebit/persistence";
import type { MotebitDatabase } from "@motebit/persistence";
import type { EventLogEntry, SyncConversation, SyncConversationMessage } from "@motebit/sdk";
import { AgentTaskStatus, asMotebitId } from "@motebit/sdk";
import type { AgentTask } from "@motebit/sdk";
import type { WSContext } from "hono/ws";
/* eslint-disable no-restricted-imports -- Relay service generates its own keypair (not a user surface) */
import {
  verifySignedToken,
  verifyExecutionReceipt,
  hexPublicKeyToDidKey,
  issueReputationCredential,
  sign,
  canonicalJson,
  bytesToHex,
  hexToBytes,
} from "@motebit/crypto";
/* eslint-enable no-restricted-imports */
import { createLogger } from "./logger.js";
import { FixedWindowLimiter } from "./rate-limiter.js";
import {
  createFederationTables,
  initRelayIdentity,
  createFederationQueryCache,
  registerFederationRoutes,
  startHeartbeatLoop,
  startSettlementRetryLoop,
  cleanupRevocationEvents,
} from "./federation.js";
import type { RelayIdentity } from "./federation.js";
import { startBatchAnchorLoop } from "./anchoring.js";
import { registerCredentialRoutes, getRelayKeypair } from "./credentials.js";
import { registerA2ARoutes } from "./a2a-bridge.js";
import { createTaskRouter } from "./task-routing.js";
import {
  createDataSyncTables,
  registerDataSyncRoutes,
  upsertSyncConversation,
  upsertSyncMessage,
} from "./data-sync.js";
import { createAccountTables, createWithdrawalTables, creditAccount } from "./accounts.js";
import { createPairingTables, registerPairingRoutes } from "./pairing.js";
import { registerStateExportRoutes } from "./state-export.js";
import { registerTrustGraphRoutes } from "./trust-graph.js";
import { registerListingsRoutes } from "./listings.js";
import { registerProposalRoutes } from "./proposals.js";
import { registerKeyRotationRoutes } from "./key-rotation.js";
import { registerBudgetRoutes } from "./budget.js";
import { registerAgentRoutes } from "./agents.js";
import { registerTaskRoutes, type TaskQueueEntry } from "./tasks.js";
import type { AgentTrustRecord } from "@motebit/sdk";
import {
  PLATFORM_FEE_RATE,
  AgentTrustLevel,
  EventType,
  evaluateTrustTransition,
  trustLevelToScore,
} from "@motebit/sdk";
import Stripe from "stripe";

/** Decode the payload half of a signed token without verifying the signature. */
export function parseTokenPayloadUnsafe(
  token: string,
): { mid: string; did: string; iat: number; exp: number; jti?: string } | null {
  const dotIdx = token.indexOf(".");
  if (dotIdx === -1) return null;
  try {
    const padded = token.slice(0, dotIdx).replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(padded);
    return JSON.parse(json) as { mid: string; did: string; iat: number; exp: number; jti?: string };
  } catch {
    return null;
  }
}

/** Verify a signed token against a specific device's public key. O(1) lookup by did.
 *  Rejects tokens whose `aud` claim doesn't match `expectedAudience` (cross-endpoint replay prevention).
 *  Optional blacklistCheck callback rejects tokens whose jti appears in the token blacklist.
 *  Optional agentRevokedCheck callback rejects tokens for revoked agents.
 */
export async function verifySignedTokenForDevice(
  token: string,
  motebitId: string,
  identityManager: IdentityManager,
  expectedAudience: string,
  blacklistCheck?: (jti: string, motebitId: string) => boolean,
  agentRevokedCheck?: (motebitId: string) => boolean,
): Promise<boolean> {
  const claims = parseTokenPayloadUnsafe(token);
  if (!claims || claims.mid !== motebitId || !claims.did) return false;

  // Check if the agent's identity has been revoked
  if (agentRevokedCheck && agentRevokedCheck(motebitId)) return false;

  // Check if this specific token's jti has been blacklisted
  if (blacklistCheck && claims.jti && blacklistCheck(claims.jti, motebitId)) return false;

  const device = await identityManager.loadDeviceById(claims.did, motebitId);
  if (!device || !device.public_key) return false;

  const pubKeyBytes = hexToBytes(device.public_key);
  const payload = await verifySignedToken(token, pubKeyBytes);
  if (payload === null || payload.mid !== motebitId) return false;

  // Audience binding: reject tokens missing aud or scoped to a different endpoint
  if (payload.aud !== expectedAudience) return false;

  return true;
}

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
  /** Stripe Checkout configuration. Omit to disable Stripe deposits. */
  stripe?: {
    secretKey: string;
    webhookSecret: string;
    currency?: string; // default 'usd'
  };
}

export interface ConnectedDevice {
  ws: WSContext;
  deviceId: string;
  capabilities?: string[];
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

// === Pairing Code Generator ===

// Pairing constants and code generation moved to pairing.ts

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
  } = config;

  // Stripe Checkout — optional fiat on-ramp for virtual account deposits
  // Emergency freeze: runtime toggle for kill switch. When true, all state-mutating
  // operations (POST/PUT/PATCH/DELETE) return 503. Reads remain available.
  // Shared mutable object so budget.ts freeze/unfreeze routes can toggle the same state.
  const freezeState = {
    frozen: config.emergencyFreeze ?? false,
    reason: config.emergencyFreeze ? ("startup" as string | null) : null,
  };
  // Local aliases for backward compatibility within index.ts closures
  const getEmergencyFreeze = () => freezeState.frozen;
  const getFreezeReason = () => freezeState.reason;

  const stripeClient = stripeConfig ? new Stripe(stripeConfig.secretKey) : null;

  const moteDb: MotebitDatabase = await openMotebitDatabase(dbPath);
  const eventStore = new EventStore(moteDb.eventStore);
  const identityManager = new IdentityManager(moteDb.identityStorage, eventStore);

  // Pairing sessions table
  createPairingTables(moteDb.db);

  // Create conversation + plan sync tables (extracted to data-sync.ts)
  createDataSyncTables(moteDb.db);

  // Virtual account tables (deposit/withdrawal/settlement balances)
  createAccountTables(moteDb.db);
  createWithdrawalTables(moteDb.db);

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

  // Federation tables (relay_identity, relay_peers, relay_federation_settlements)
  createFederationTables(moteDb.db);

  // Migration: add x402 payment proof columns to relay_federation_settlements
  {
    const cols = moteDb.db
      .prepare("PRAGMA table_info(relay_federation_settlements)")
      .all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("x402_tx_hash")) {
      moteDb.db.exec("ALTER TABLE relay_federation_settlements ADD COLUMN x402_tx_hash TEXT");
    }
    if (!colNames.has("x402_network")) {
      moteDb.db.exec("ALTER TABLE relay_federation_settlements ADD COLUMN x402_network TEXT");
    }
  }

  // Create market relay tables (service listings + latency stats for routing)
  moteDb.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_service_listings (
        listing_id    TEXT PRIMARY KEY,
        motebit_id    TEXT NOT NULL,
        capabilities  TEXT NOT NULL DEFAULT '[]',
        pricing       TEXT NOT NULL DEFAULT '[]',
        sla_max_latency_ms INTEGER NOT NULL DEFAULT 5000,
        sla_availability REAL NOT NULL DEFAULT 0.99,
        description   TEXT NOT NULL DEFAULT '',
        pay_to_address TEXT,
        regulatory_risk REAL,
        updated_at    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_relay_listings_motebit ON relay_service_listings(motebit_id);

      CREATE TABLE IF NOT EXISTS relay_latency_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        motebit_id TEXT NOT NULL,
        remote_motebit_id TEXT NOT NULL,
        latency_ms REAL NOT NULL,
        recorded_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_relay_latency_pair ON relay_latency_stats(motebit_id, remote_motebit_id);

      CREATE TABLE IF NOT EXISTS relay_delegation_edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_motebit_id TEXT NOT NULL,
        to_motebit_id TEXT NOT NULL,
        trust REAL NOT NULL DEFAULT 0.1,
        cost REAL NOT NULL DEFAULT 0,
        latency_ms REAL NOT NULL DEFAULT 5000,
        reliability REAL NOT NULL DEFAULT 0.5,
        regulatory_risk REAL NOT NULL DEFAULT 0,
        recorded_at INTEGER NOT NULL,
        receipt_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_delegation_edges_from ON relay_delegation_edges(from_motebit_id);
  `);

  // Settlement ledger — x402 handles payment, this is the relay's accounting record
  moteDb.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_settlements (
        settlement_id TEXT PRIMARY KEY,
        allocation_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL DEFAULT '',
        motebit_id TEXT NOT NULL DEFAULT '',
        receipt_hash TEXT NOT NULL DEFAULT '',
        ledger_hash TEXT,
        amount_settled REAL NOT NULL,
        platform_fee REAL NOT NULL DEFAULT 0,
        platform_fee_rate REAL NOT NULL DEFAULT 0.05,
        status TEXT NOT NULL,
        settled_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_relay_settlements_alloc ON relay_settlements(allocation_id);
      CREATE INDEX IF NOT EXISTS idx_relay_settlements_motebit ON relay_settlements(motebit_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_settlements_dedup ON relay_settlements(task_id, motebit_id);
  `);

  // Migration: add x402 payment proof columns (safe on existing DBs — ALTER TABLE IF NOT EXISTS not
  // supported by SQLite, so we check pragma table_info instead).
  {
    const cols = moteDb.db.prepare("PRAGMA table_info(relay_settlements)").all() as Array<{
      name: string;
    }>;
    const colNames = new Set(cols.map((c) => c.name));
    if (!colNames.has("x402_tx_hash")) {
      moteDb.db.exec("ALTER TABLE relay_settlements ADD COLUMN x402_tx_hash TEXT");
    }
    if (!colNames.has("x402_network")) {
      moteDb.db.exec("ALTER TABLE relay_settlements ADD COLUMN x402_network TEXT");
    }
  }

  // Budget allocation tracking — prevents overdraft by recording locked funds at task submission
  moteDb.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_allocations (
        allocation_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE,
        motebit_id TEXT NOT NULL,
        amount_locked REAL NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USDC',
        status TEXT NOT NULL DEFAULT 'locked',
        created_at INTEGER NOT NULL,
        settled_at INTEGER,
        released_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_allocations_task ON relay_allocations(task_id);
      CREATE INDEX IF NOT EXISTS idx_allocations_status ON relay_allocations(status) WHERE status = 'locked';
  `);

  // Collaborative plan proposal tables
  moteDb.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_proposals (
        proposal_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        initiator_motebit_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        plan_snapshot TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_relay_proposals_initiator ON relay_proposals(initiator_motebit_id);

      CREATE TABLE IF NOT EXISTS relay_proposal_participants (
        proposal_id TEXT NOT NULL,
        motebit_id TEXT NOT NULL,
        assigned_steps TEXT NOT NULL DEFAULT '[]',
        response TEXT,
        counter_steps TEXT,
        responded_at INTEGER,
        signature TEXT,
        PRIMARY KEY (proposal_id, motebit_id)
      );

      CREATE TABLE IF NOT EXISTS relay_collaborative_step_results (
        proposal_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        motebit_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result_summary TEXT,
        receipt TEXT,
        completed_at INTEGER NOT NULL,
        PRIMARY KEY (proposal_id, step_id)
      );
  `);

  // Verifiable credential storage
  moteDb.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_credentials (
        credential_id TEXT PRIMARY KEY,
        subject_motebit_id TEXT NOT NULL,
        issuer_did TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        credential_json TEXT NOT NULL,
        issued_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_relay_creds_subject ON relay_credentials(subject_motebit_id);
  `);

  // Signed execution ledger storage (agents submit signed manifests)
  moteDb.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_execution_ledgers (
        ledger_id TEXT PRIMARY KEY,
        motebit_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        plan_id TEXT,
        manifest_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_relay_ledgers_motebit ON relay_execution_ledgers(motebit_id);
      CREATE INDEX IF NOT EXISTS idx_relay_ledgers_goal ON relay_execution_ledgers(goal_id);
  `);

  // Key succession records (key rotation history)
  moteDb.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_key_successions (
        id INTEGER PRIMARY KEY,
        motebit_id TEXT NOT NULL,
        old_public_key TEXT NOT NULL,
        new_public_key TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        reason TEXT,
        old_key_signature TEXT NOT NULL,
        new_key_signature TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_relay_key_successions_motebit ON relay_key_successions(motebit_id);
  `);

  // Token blacklist for revocation (jti-based)
  moteDb.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_token_blacklist (
        jti TEXT PRIMARY KEY,
        motebit_id TEXT NOT NULL,
        revoked_at TEXT DEFAULT (datetime('now')),
        expires_at INTEGER NOT NULL
      );
  `);

  // Revoked credentials
  moteDb.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_revoked_credentials (
        credential_id TEXT PRIMARY KEY,
        motebit_id TEXT NOT NULL,
        revoked_at TEXT DEFAULT (datetime('now')),
        reason TEXT,
        revoked_by TEXT
      );
  `);

  // Migration: add revoked_by column if missing
  try {
    moteDb.db.exec("ALTER TABLE relay_revoked_credentials ADD COLUMN revoked_by TEXT");
  } catch {
    /* column may already exist */
  }

  // Add revoked column to agent_registry (column-exists check pattern)
  try {
    moteDb.db.exec("ALTER TABLE agent_registry ADD COLUMN revoked INTEGER DEFAULT 0");
  } catch {
    /* column may already exist */
  }

  // Startup cleanup: purge expired blacklist entries
  moteDb.db.prepare("DELETE FROM relay_token_blacklist WHERE expires_at < ?").run(Date.now());

  // Startup cleanup: purge revocation events older than 7 days
  cleanupRevocationEvents(moteDb.db);

  // --- Revocation callback helpers ---

  function isTokenBlacklisted(jti: string, _motebitId: string): boolean {
    const row = moteDb.db.prepare("SELECT 1 FROM relay_token_blacklist WHERE jti = ?").get(jti) as
      | Record<string, unknown>
      | undefined;
    return row !== undefined;
  }
  function isAgentRevoked(motebitId: string): boolean {
    const row = moteDb.db
      .prepare("SELECT revoked FROM agent_registry WHERE motebit_id = ?")
      .get(motebitId) as { revoked: number } | undefined;
    return row?.revoked === 1;
  }

  // Track connected WebSocket clients per motebitId with device identity
  const connections = new Map<string, ConnectedDevice[]>();

  // In-memory agent task queue: task_id → { task, receipt?, expiresAt, submitted_by?, price_snapshot?, origin_relay? }
  const TASK_TTL_MS = 10 * 60 * 1000; // 10 minutes
  const MAX_TASK_QUEUE_SIZE = 100_000; // Hard cap prevents memory exhaustion from task flooding
  const MAX_TASKS_PER_SUBMITTER = config.maxTasksPerSubmitter ?? 1_000; // Per-agent cap prevents fair-share starvation
  const taskQueue = new Map<string, TaskQueueEntry>();

  // Periodic cleanup of expired tasks and agent registrations
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
            // Look up the task submitter (delegator) to credit the right account
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

  // Rate limiter instances per endpoint category (per-relay for test isolation)
  const authLimiter = new FixedWindowLimiter(30, 60_000); // 30 req/min
  const readLimiter = new FixedWindowLimiter(60, 60_000); // 60 req/min
  const writeLimiter = new FixedWindowLimiter(30, 60_000); // 30 req/min
  const publicLimiter = new FixedWindowLimiter(20, 60_000); // 20 req/min
  const expensiveLimiter = new FixedWindowLimiter(10, 60_000); // 10 req/min
  const wsLimiter = new FixedWindowLimiter(100, 10_000); // 100 msg/10s per connection
  const allLimiters = [
    authLimiter,
    readLimiter,
    writeLimiter,
    publicLimiter,
    expensiveLimiter,
    wsLimiter,
  ];

  // --- Relay Identity: persistent Ed25519 keypair ---
  const relayIdentity: RelayIdentity = await initRelayIdentity(
    moteDb.db,
    process.env.MOTEBIT_RELAY_KEY_PASSPHRASE,
  );

  // Task routing helpers (extracted to task-routing.ts)
  const taskRouter = createTaskRouter({ db: moteDb.db, relayIdentity, federationConfig });

  // Federation query deduplication — prevents forwarding loops and replay
  const { cache: federationQueryCache, pruneInterval: federationQueryPruneInterval } =
    createFederationQueryCache();

  const app = new Hono();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- hono utility functions, not bound methods
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  const logger = createLogger({ service: "relay" });

  // --- Middleware ---
  app.use("*", secureHeaders());
  app.use("*", cors({ origin: corsOrigin }));

  // Emergency freeze: block all state-mutating operations
  app.use("*", async (c, next) => {
    if (!getEmergencyFreeze()) return next();

    // Allow reads
    if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") {
      return next();
    }

    // Allow health check and admin freeze toggle (must be reachable while frozen)
    if (
      c.req.path === "/health" ||
      c.req.path === "/api/v1/admin/freeze" ||
      c.req.path === "/api/v1/admin/unfreeze"
    ) {
      return next();
    }

    throw new HTTPException(503, {
      message: "Relay is in emergency freeze mode — all write operations are suspended",
    });
  });

  // Correlation ID middleware — generates or propagates X-Correlation-ID
  app.use("*", async (c, next) => {
    const correlationId = c.req.header("x-correlation-id") ?? crypto.randomUUID();
    c.set("correlationId" as never, correlationId as never);
    c.header("X-Correlation-ID", correlationId);
    await next();
  });

  // --- Rate Limiting ---

  /**
   * Extract client IP. Uses the rightmost non-private IP from x-forwarded-for
   * to resist spoofing — the rightmost entry is set by the closest trusted proxy.
   * Falls back to x-real-ip or "unknown" for direct connections.
   */
  function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const ips = xff.split(",").map((ip) => ip.trim());
      // Rightmost IP is set by the trusted reverse proxy (Vercel/Cloudflare)
      return ips[ips.length - 1] ?? "unknown";
    }
    return c.req.header("x-real-ip") ?? "unknown";
  }

  function isMasterToken(c: { req: { header: (name: string) => string | undefined } }): boolean {
    if (apiToken == null || apiToken === "") return false;
    const authHeader = c.req.header("authorization");
    return authHeader != null && authHeader === `Bearer ${apiToken}`;
  }

  function rateLimitMiddleware(limiter: FixedWindowLimiter) {
    return async (
      c: Parameters<Parameters<typeof app.use>[1]>[0],
      next: () => Promise<void>,
    ): Promise<Response | void> => {
      // Master token bypasses rate limiting
      if (isMasterToken(c)) {
        await next();
        return;
      }

      const ip = getClientIp(c);
      const { allowed, remaining, resetAt } = limiter.check(ip);
      const retryAfterSeconds = Math.ceil((resetAt - Date.now()) / 1000);

      c.header("X-RateLimit-Remaining", String(remaining));
      c.header("X-RateLimit-Reset", String(Math.ceil(resetAt / 1000)));

      if (!allowed) {
        c.header("Retry-After", String(retryAfterSeconds));
        return c.json({ error: "Rate limit exceeded", retry_after: retryAfterSeconds }, 429);
      }

      await next();
    };
  }

  // Auth endpoints: register, heartbeat (30 req/min)
  app.use("/api/v1/agents/register", rateLimitMiddleware(authLimiter));
  app.use("/api/v1/agents/heartbeat", rateLimitMiddleware(authLimiter));
  app.use("/api/v1/agents/deregister", rateLimitMiddleware(authLimiter));
  app.use("/api/v1/agents/:motebitId/rotate-key", rateLimitMiddleware(writeLimiter));
  app.use("/api/v1/agents/:motebitId/succession", rateLimitMiddleware(readLimiter));

  // Credential submission: write-rate (peers push collected credentials for relay indexing)
  app.use("/api/v1/agents/:motebitId/credentials/submit", rateLimitMiddleware(writeLimiter));

  // Read endpoints: discover, credentials, capabilities, listings (60 req/min)
  app.use("/api/v1/agents/discover", rateLimitMiddleware(readLimiter));
  app.use("/api/v1/agents/:motebitId/credentials", rateLimitMiddleware(readLimiter));
  app.use("/api/v1/agents/:motebitId/listing", rateLimitMiddleware(readLimiter));
  app.use("/agent/:motebitId/capabilities", rateLimitMiddleware(readLimiter));
  app.use("/agent/:motebitId/settlements", rateLimitMiddleware(readLimiter));
  app.use("/api/v1/agents/:motebitId/trust-closure", rateLimitMiddleware(readLimiter));
  app.use("/api/v1/agents/:motebitId/path-to/*", rateLimitMiddleware(readLimiter));
  app.use("/api/v1/agents/:motebitId/graph", rateLimitMiddleware(readLimiter));
  app.use("/api/v1/agents/:motebitId/routing-explanation", rateLimitMiddleware(readLimiter));

  // Virtual account endpoints (write: deposit/withdraw, read: balance/withdrawals)
  app.use("/api/v1/agents/:motebitId/deposit", rateLimitMiddleware(writeLimiter));
  app.use("/api/v1/agents/:motebitId/withdraw", rateLimitMiddleware(writeLimiter));
  app.use("/api/v1/agents/:motebitId/balance", rateLimitMiddleware(readLimiter));
  app.use("/api/v1/agents/:motebitId/withdrawals", rateLimitMiddleware(readLimiter));
  app.use("/api/v1/agents/:motebitId/checkout", rateLimitMiddleware(writeLimiter));
  app.use("/api/v1/stripe/webhook", rateLimitMiddleware(publicLimiter));
  app.use("/api/v1/admin/withdrawals/*", rateLimitMiddleware(writeLimiter));
  app.use("/api/v1/admin/reconciliation", rateLimitMiddleware(expensiveLimiter));
  app.use("/api/v1/admin/freeze", rateLimitMiddleware(writeLimiter));
  app.use("/api/v1/admin/unfreeze", rateLimitMiddleware(writeLimiter));

  // Write endpoints: task submission, result, ledger (30 req/min)
  app.use("/agent/:motebitId/task", rateLimitMiddleware(writeLimiter));
  app.use("/agent/:motebitId/task/:taskId/result", rateLimitMiddleware(writeLimiter));
  app.use("/agent/:motebitId/ledger", rateLimitMiddleware(writeLimiter));

  // Public endpoints: credential verification, credential status (20 req/min)
  app.use("/api/v1/credentials/verify", rateLimitMiddleware(publicLimiter));
  app.use("/api/v1/credentials/:credentialId/status", rateLimitMiddleware(publicLimiter));
  app.use("/api/v1/credentials/batch-status", rateLimitMiddleware(readLimiter));

  // Write endpoints: revocation (30 req/min)
  app.use("/api/v1/agents/:motebitId/revoke-tokens", rateLimitMiddleware(writeLimiter));
  app.use("/api/v1/agents/:motebitId/revoke-credential", rateLimitMiddleware(writeLimiter));
  app.use("/api/v1/agents/:motebitId/revoke", rateLimitMiddleware(writeLimiter));

  // Approval quorum endpoints (write tier for votes, read tier for status)
  app.use(
    "/api/v1/agents/:motebitId/approvals/:approvalId/vote",
    rateLimitMiddleware(writeLimiter),
  );
  app.use("/api/v1/agents/:motebitId/approvals/:approvalId", rateLimitMiddleware(readLimiter));

  // Expensive endpoints: presentation bundling, bootstrap (10 req/min)
  app.use("/api/v1/agents/:motebitId/presentation", rateLimitMiddleware(expensiveLimiter));
  app.use("/api/v1/agents/bootstrap", rateLimitMiddleware(expensiveLimiter));

  // Federation peering endpoints (30 req/min per IP — write tier)
  // POST handlers also enforce per-peer rate limiting (30 req/min per relay_id) in federation.ts
  app.use("/federation/v1/peer/*", rateLimitMiddleware(writeLimiter));

  // Federation discovery (60 req/min per IP — read tier, plus per-peer in federation.ts)
  app.use("/federation/v1/discover", rateLimitMiddleware(readLimiter));

  // Federation task routing (30 req/min per IP — write tier, plus per-peer in federation.ts)
  app.use("/federation/v1/task/*", rateLimitMiddleware(writeLimiter));

  // Federation settlement endpoints (Phase 5, plus per-peer in federation.ts)
  app.use("/federation/v1/settlement/*", rateLimitMiddleware(writeLimiter));
  app.use("/federation/v1/settlements", rateLimitMiddleware(readLimiter));

  if (apiToken != null && apiToken !== "") {
    app.use("/identity/*", bearerAuth({ token: apiToken }));
    app.use("/identity", bearerAuth({ token: apiToken }));
    // Device registration is protected by the master token
    app.use("/device/*", bearerAuth({ token: apiToken }));
    // Admin query endpoints — interior state is not public surface
    app.use("/api/v1/state/*", bearerAuth({ token: apiToken }));
    app.use("/api/v1/memory/*", bearerAuth({ token: apiToken }));
    app.use("/api/v1/audit/*", bearerAuth({ token: apiToken }));
    app.use("/api/v1/goals/*", bearerAuth({ token: apiToken }));
    app.use("/api/v1/conversations/*", bearerAuth({ token: apiToken }));
    app.use("/api/v1/plans/*", bearerAuth({ token: apiToken }));
    app.use("/api/v1/agent-trust/*", bearerAuth({ token: apiToken }));
    app.use("/api/v1/gradient/*", bearerAuth({ token: apiToken }));
    app.use("/api/v1/sync/*", bearerAuth({ token: apiToken }));
    app.use("/api/v1/execution/*", bearerAuth({ token: apiToken }));
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

      if (token.includes(".")) {
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
    console.error(err);
    return c.json({ error: "Internal server error", status: 500 }, 500);
  });

  // --- Health (public, no auth) ---
  app.get("/health", (c) =>
    c.json({
      status: getEmergencyFreeze() ? "frozen" : "ok",
      frozen: getEmergencyFreeze(),
      ...(getEmergencyFreeze() && getFreezeReason() ? { freeze_reason: getFreezeReason() } : {}),
      timestamp: Date.now(),
    }),
  );

  // --- WebSocket: bidirectional event stream ---
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
                upsertSyncConversation(moteDb.db, conv);
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
                upsertSyncMessage(moteDb.db, m);
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

  // --- Sync: sensitivity redaction for outbound events ---
  // Memory-formed events with medical/financial/secret sensitivity must not have
  // their content transmitted in cleartext through the relay. The node_id is
  // preserved so the device knows a memory exists; content is stripped.
  const SYNC_SAFE_SENSITIVITY = new Set(["none", "personal"]);
  function redactSensitiveEvents(events: EventLogEntry[]): EventLogEntry[] {
    return events.map((e) => {
      if (e.event_type !== EventType.MemoryFormed) return e;
      const payload = e.payload as Record<string, unknown> | undefined;
      if (!payload) return e;
      const sensitivity = (payload.sensitivity as string) ?? "none";
      if (SYNC_SAFE_SENSITIVITY.has(sensitivity)) return e;
      // Redact: strip content, preserve node_id and metadata
      return {
        ...e,
        payload: {
          ...payload,
          content: "[REDACTED]",
          redacted: true,
          redacted_sensitivity: sensitivity,
        },
      };
    });
  }

  // --- Sync: push events (HTTP fallback) ---
  app.post("/sync/:motebitId/push", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const body = await c.req.json<{ events: EventLogEntry[] }>();
    if (!Array.isArray(body.events)) {
      throw new HTTPException(400, {
        message: "Missing or invalid 'events' field (must be array)",
      });
    }
    let accepted = 0;
    let duplicates = 0;
    for (const event of body.events) {
      // Receipt idempotency: if this event carries a receipt, check for replay
      const receipt = event.payload?.receipt as Record<string, unknown> | undefined;
      if (receipt && typeof receipt.signature === "string" && receipt.signature !== "") {
        const existing = await eventStore.query({ motebit_id: event.motebit_id });
        const isDuplicate = existing.some((e) => {
          const r = e.payload?.receipt as Record<string, unknown> | undefined;
          return r && r.signature === receipt.signature;
        });
        if (isDuplicate) {
          duplicates++;
          continue;
        }
      }
      await eventStore.append(event);
      accepted++;
    }

    // Fan out to WebSocket clients, skipping the sender device.
    // Redact sensitive memory content before fan-out.
    const senderDeviceId = c.req.header("x-device-id");
    const peers = connections.get(motebitId);
    if (peers) {
      const safeEvents = redactSensitiveEvents(body.events);
      for (const event of safeEvents) {
        const payload = JSON.stringify({ type: "event", event });
        for (const peer of peers) {
          if (peer.deviceId !== senderDeviceId) {
            peer.ws.send(payload);
          }
        }
      }
    }

    if (duplicates > 0 && accepted === 0) {
      return c.json({ motebit_id: motebitId, accepted: 0, duplicate: true });
    }
    return c.json({ motebit_id: motebitId, accepted, duplicates });
  });

  // --- Sync: pull events (HTTP fallback) ---
  app.get("/sync/:motebitId/pull", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const afterClock = Number(c.req.query("after_clock") ?? "0");
    const events = await eventStore.query({
      motebit_id: motebitId,
      after_version_clock: afterClock,
    });
    return c.json({
      motebit_id: motebitId,
      events: redactSensitiveEvents(events),
      after_clock: afterClock,
    });
  });

  // --- Sync: latest clock ---
  app.get("/sync/:motebitId/clock", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
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
      if (
        c.req.path.startsWith("/api/v1/agents") ||
        c.req.path.startsWith("/api/v1/credentials/verify") ||
        c.req.path.startsWith("/api/v1/credentials/batch-status") ||
        c.req.path.match(/\/api\/v1\/credentials\/[^/]+\/status/) ||
        c.req.path.startsWith("/api/v1/stripe/")
      ) {
        await next();
        return;
      }
      const mw = bearerAuth({ token: apiToken });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance between middleware and handler signatures
      return mw(c as never, next);
    });
  }

  // --- Federation: all 11 endpoints (identity, peering, discovery, task forwarding, settlement) ---
  // Protocol logic (peer validation, signature verification, loop prevention) lives in federation.ts.
  // Business logic (task queue, WebSocket fan-out, trust, credentials) provided via callbacks.
  registerFederationRoutes({
    db: moteDb.db,
    app,
    relayIdentity,
    federationConfig,
    federationQueryCache,
    queryLocalAgents: (capability, motebitId, limit) =>
      taskRouter.queryLocalAgents(capability, motebitId, limit),

    onTaskForwarded(verified) {
      // Idempotency: reject duplicate task_id to prevent double-execution
      // when the origin relay retries after a timeout.
      if (taskQueue.has(verified.taskId)) {
        return { status: "duplicate" as const, task_id: verified.taskId };
      }

      // Global queue capacity check (sibling of direct task submission path)
      if (taskQueue.size >= MAX_TASK_QUEUE_SIZE) {
        return { status: "rejected" as const, reason: "queue_full" };
      }

      // Per-submitter fairness (sibling of direct task submission path)
      const federatedSubmitter = verified.payload.submitted_by ?? `relay:${verified.originRelay}`;
      let submitterCount = 0;
      for (const entry of taskQueue.values()) {
        if (entry.submitted_by === federatedSubmitter) submitterCount++;
        if (submitterCount >= MAX_TASKS_PER_SUBMITTER) {
          logger.warn("task.per_submitter_limit_federation", {
            correlationId: verified.taskId,
            submittedBy: federatedSubmitter,
            originRelay: verified.originRelay,
            limit: MAX_TASKS_PER_SUBMITTER,
          });
          return { status: "rejected" as const, reason: "per_submitter_limit" };
        }
      }

      const task: AgentTask = {
        task_id: verified.taskId,
        motebit_id: asMotebitId(verified.targetAgent),
        prompt: verified.payload.prompt,
        submitted_at: Date.now(),
        submitted_by: verified.payload.submitted_by ?? `relay:${verified.originRelay}`,
        wall_clock_ms: verified.payload.wall_clock_ms,
        status: AgentTaskStatus.Pending,
        required_capabilities: verified.payload
          .required_capabilities as AgentTask["required_capabilities"],
      };

      taskQueue.set(verified.taskId, {
        task,
        expiresAt: Date.now() + TASK_TTL_MS,
        submitted_by: task.submitted_by,
        origin_relay: verified.originRelay,
      });

      const agentPeers = connections.get(verified.targetAgent);
      if (agentPeers && agentPeers.length > 0) {
        const payload = JSON.stringify({ type: "task_request", task });
        for (const p of agentPeers) p.ws.send(payload);
        return { status: "routed" as const };
      }
      return { status: "pending" as const };
    },

    async onTaskResultReceived(verified) {
      const entry = taskQueue.get(verified.taskId);
      if (!entry) throw new HTTPException(404, { message: "Task not found or expired" });

      // Verify executing agent's Ed25519 receipt signature (sibling of direct receipt path).
      // Without this, a malicious peer relay could forge or tamper with receipts.
      if (verified.receipt.signature) {
        let pubKeyHex: string | undefined;
        const regRow = moteDb.db
          .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
          .get(verified.receipt.motebit_id) as { public_key: string } | undefined;
        if (regRow?.public_key) {
          pubKeyHex = regRow.public_key;
        } else {
          const devices = await identityManager.listDevices(
            asMotebitId(verified.receipt.motebit_id),
          );
          const device = devices.find((d) => d.public_key);
          if (device?.public_key) pubKeyHex = device.public_key;
        }
        if (pubKeyHex) {
          const sigValid = await verifyExecutionReceipt(verified.receipt, hexToBytes(pubKeyHex));
          if (!sigValid) {
            logger.error("federation.receipt_signature_invalid", {
              correlationId: verified.taskId,
              executingAgent: verified.receipt.motebit_id,
              originRelay: verified.originRelay,
            });
            throw new HTTPException(403, {
              message: "Federated receipt signature verification failed",
            });
          }
        } else {
          logger.warn("federation.receipt_key_missing", {
            correlationId: verified.taskId,
            executingAgent: verified.receipt.motebit_id,
          });
        }
      }

      // Update task
      entry.receipt = verified.receipt;
      entry.expiresAt = Math.max(entry.expiresAt, Date.now() + TASK_TTL_MS);
      entry.task.status =
        verified.receipt.status === "completed"
          ? AgentTaskStatus.Completed
          : verified.receipt.status === "denied"
            ? AgentTaskStatus.Denied
            : AgentTaskStatus.Failed;

      // Fan out to submitter
      const submittedBy = entry.submitted_by ?? entry.task.submitted_by;
      if (submittedBy) {
        const peers = connections.get(submittedBy);
        if (peers) {
          const msg = JSON.stringify({
            type: "task_result",
            task_id: verified.taskId,
            receipt: verified.receipt,
          });
          for (const p of peers) p.ws.send(msg);
        }
      }

      // Trust update via evaluateTrustTransition
      try {
        const peerRow = moteDb.db
          .prepare(
            "SELECT trust_level, successful_forwards, failed_forwards FROM relay_peers WHERE peer_relay_id = ?",
          )
          .get(verified.originRelay) as
          | { trust_level: AgentTrustLevel; successful_forwards: number; failed_forwards: number }
          | undefined;

        if (peerRow) {
          const isSuccess = verified.receipt.status === "completed";
          const newSuccessful = peerRow.successful_forwards + (isSuccess ? 1 : 0);
          const newFailed = peerRow.failed_forwards + (isSuccess ? 0 : 1);

          const trustRecord: AgentTrustRecord = {
            motebit_id: asMotebitId(relayIdentity.relayMotebitId),
            remote_motebit_id: asMotebitId(verified.originRelay),
            trust_level: peerRow.trust_level,
            first_seen_at: 0,
            last_seen_at: Date.now(),
            interaction_count: newSuccessful + newFailed,
            successful_tasks: newSuccessful,
            failed_tasks: newFailed,
          };

          const newLevel = evaluateTrustTransition(trustRecord);
          const trustLevel = newLevel ?? peerRow.trust_level;
          const trustScore = trustLevelToScore(trustLevel);

          moteDb.db
            .prepare(
              "UPDATE relay_peers SET successful_forwards = ?, failed_forwards = ?, trust_level = ?, trust_score = ? WHERE peer_relay_id = ?",
            )
            .run(newSuccessful, newFailed, trustLevel, trustScore, verified.originRelay);

          // Issue credential on trust level transition (only when relay credential issuance is enabled)
          if (issueCredentials && newLevel != null && newLevel !== peerRow.trust_level) {
            try {
              const relayKeys = getRelayKeypair(relayIdentity);
              const peerDid = hexPublicKeyToDidKey(
                (
                  moteDb.db
                    .prepare("SELECT public_key FROM relay_peers WHERE peer_relay_id = ?")
                    .get(verified.originRelay) as { public_key: string }
                ).public_key,
              );
              const vc = await issueReputationCredential(
                {
                  success_rate: newSuccessful / Math.max(1, newSuccessful + newFailed),
                  avg_latency_ms: 0,
                  task_count: newSuccessful + newFailed,
                  trust_score: trustScore,
                  availability: 1.0,
                  measured_at: Date.now(),
                },
                relayKeys.privateKey,
                relayKeys.publicKey,
                peerDid,
              );
              const credentialType =
                vc.type.find((t) => t !== "VerifiableCredential") ?? "VerifiableCredential";
              moteDb.db
                .prepare(
                  "INSERT INTO relay_credentials (credential_id, subject_motebit_id, issuer_did, credential_type, credential_json, issued_at) VALUES (?, ?, ?, ?, ?, ?)",
                )
                .run(
                  crypto.randomUUID(),
                  verified.originRelay,
                  vc.issuer,
                  credentialType,
                  JSON.stringify(vc),
                  Date.now(),
                );
            } catch {
              /* best-effort */
            }
          }
        }
      } catch {
        /* best-effort trust update */
      }

      // Settlement forwarding
      try {
        if (entry.price_snapshot != null && entry.price_snapshot > 0) {
          const grossAmount = entry.price_snapshot;
          const feeAmount = grossAmount * PLATFORM_FEE_RATE;
          const netAmount = grossAmount - feeAmount;
          const receiptHash = verified.receipt.result_hash ?? verified.receipt.signature ?? "";
          const settlementId = crypto.randomUUID();

          moteDb.db
            .prepare(
              `INSERT OR IGNORE INTO relay_federation_settlements (settlement_id, task_id, upstream_relay_id, downstream_relay_id, agent_id, gross_amount, fee_amount, net_amount, fee_rate, settled_at, receipt_hash, x402_tx_hash, x402_network) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              settlementId,
              verified.taskId,
              relayIdentity.relayMotebitId,
              verified.originRelay,
              null,
              grossAmount,
              feeAmount,
              netAmount,
              PLATFORM_FEE_RATE,
              Date.now(),
              receiptHash,
              entry.x402_tx_hash ?? null,
              entry.x402_network ?? null,
            );

          const peerInfo = moteDb.db
            .prepare("SELECT endpoint_url FROM relay_peers WHERE peer_relay_id = ?")
            .get(verified.originRelay) as { endpoint_url: string } | undefined;
          if (peerInfo) {
            const settlementBody = {
              task_id: verified.taskId,
              settlement_id: settlementId,
              origin_relay: relayIdentity.relayMotebitId,
              gross_amount: netAmount,
              receipt_hash: receiptHash,
              timestamp: Date.now(),
              x402_tx_hash: entry.x402_tx_hash ?? undefined,
              x402_network: entry.x402_network ?? undefined,
            };
            const settlementSig = await sign(
              new TextEncoder().encode(canonicalJson(settlementBody)),
              relayIdentity.privateKey,
            );
            try {
              const resp = await fetch(
                `${peerInfo.endpoint_url}/federation/v1/settlement/forward`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "X-Correlation-ID": verified.taskId,
                  },
                  body: JSON.stringify({ ...settlementBody, signature: bytesToHex(settlementSig) }),
                  signal: AbortSignal.timeout(10000),
                },
              );
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            } catch {
              // Settlement forward failed — queue for retry instead of dropping
              moteDb.db
                .prepare(
                  `INSERT INTO relay_settlement_retries (retry_id, settlement_id, task_id, peer_relay_id, payload_json, attempts, max_attempts, next_retry_at, status, created_at) VALUES (?, ?, ?, ?, ?, 0, 5, ?, 'pending', ?)`,
                )
                .run(
                  crypto.randomUUID(),
                  settlementId,
                  verified.taskId,
                  verified.originRelay,
                  JSON.stringify(settlementBody),
                  Date.now() + 30000,
                  Date.now(),
                );
            }
          }
        }
      } catch {
        /* best-effort settlement */
      }
    },

    onSettlementReceived(verified) {
      const feeAmount = verified.grossAmount * PLATFORM_FEE_RATE;
      const netAmount = verified.grossAmount - feeAmount;
      moteDb.db
        .prepare(
          `INSERT OR IGNORE INTO relay_federation_settlements (settlement_id, task_id, upstream_relay_id, downstream_relay_id, agent_id, gross_amount, fee_amount, net_amount, fee_rate, settled_at, receipt_hash, x402_tx_hash, x402_network) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          verified.settlementId,
          verified.taskId,
          verified.originRelay,
          null,
          null,
          verified.grossAmount,
          feeAmount,
          netAmount,
          PLATFORM_FEE_RATE,
          Date.now(),
          verified.receiptHash,
          verified.x402TxHash ?? null,
          verified.x402Network ?? null,
        );
      return { feeAmount, netAmount };
    },
  });

  // --- Credentials: extracted to credentials.ts ---
  registerCredentialRoutes({
    db: moteDb.db,
    app,
    relayIdentity,
    identityManager,
    issueCredentials,
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
    const id = asMotebitId(c.req.param("motebitId"));
    const identity = await identityManager.load(id);
    if (!identity) {
      return c.json({ error: "identity not found" }, 404);
    }
    return c.json(identity);
  });

  // --- Pairing routes (extracted to pairing.ts) ---
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

  // === State Export Routes (read-only agent state queries) ===
  registerStateExportRoutes({ app, moteDb, eventStore, identityManager, redactSensitiveEvents });

  // === Trust Graph Routes (trust records, closure, paths, routing graph) ===
  registerTrustGraphRoutes({ app, moteDb, taskRouter });

  // === Listings & Market Routes ===
  registerListingsRoutes({ app, moteDb, taskRouter });

  // === Collaborative Proposal Routes ===
  registerProposalRoutes({ app, moteDb, connections });

  // === Key Rotation, Revocation & Approval Routes ===
  registerKeyRotationRoutes({ app, moteDb, relayIdentity });

  // === Data Sync Routes (conversations, messages, plans, plan steps) ===
  registerDataSyncRoutes({ db: moteDb.db, app, connections });

  // === A2A Protocol Bridge ===
  // Exposes motebit agents as A2A-compatible agents for cross-framework discovery.
  const a2aRelayUrl = federationConfig?.endpointUrl ?? "http://localhost:3000";
  registerA2ARoutes(app, moteDb.db, {
    relayIdentity,
    relayUrl: a2aRelayUrl,
    relayVersion: "0.5.2",
  });

  // === Agent Protocol Endpoints ===

  /**
   * dualAuth — accepts either the master API token OR a valid Ed25519 signed device token.
   * Used by task submission so agents can delegate to each other without knowing the master token.
   * Sets c.set("callerMotebitId") on the context when a signed device token is used.
   * @param expectedAudience — audience claim to enforce on signed tokens (cross-endpoint replay prevention)
   */
  async function dualAuth(
    c: Parameters<Parameters<typeof app.use>[1]>[0],
    next: () => Promise<void>,
    expectedAudience: string,
  ): Promise<Response | void> {
    const authHeader = c.req.header("authorization");
    if (authHeader == null || !authHeader.startsWith("Bearer ")) {
      throw new HTTPException(401, { message: "Missing authorization" });
    }
    const token = authHeader.slice(7);

    // Master token bypass — log for audit trail (distinguishes admin from agent auth)
    if (apiToken != null && apiToken !== "" && token === apiToken) {
      logger.info("auth.master_token", {
        correlationId: c.req.header("x-correlation-id") ?? "none",
        method: c.req.method,
        path: new URL(c.req.url, "http://localhost").pathname,
        ip: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown",
      });
      await next();
      return;
    }

    // Signed device token path
    const claims = parseTokenPayloadUnsafe(token);
    if (!claims?.mid) {
      throw new HTTPException(401, { message: "Invalid token" });
    }
    const valid = await verifySignedTokenForDevice(
      token,
      claims.mid,
      identityManager,
      expectedAudience,
      isTokenBlacklisted,
      isAgentRevoked,
    );
    if (!valid) {
      throw new HTTPException(401, { message: "Token verification failed" });
    }

    c.set("callerMotebitId" as never, claims.mid as never);
    await next();
  }

  // POST /agent/:motebitId/task — submit a task (master token or signed device token)
  if (apiToken != null && apiToken !== "") {
    app.use("/agent/*/task", async (c, next) => {
      // Only apply auth to POST (submit) requests, not to /result sub-routes
      if (c.req.method === "POST" && !c.req.url.includes("/result")) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
        return dualAuth(c, next, "task:submit");
      }
      await next();
    });

    // Auth middleware for ledger and settlement routes — master token required
    app.use("/agent/*/ledger", bearerAuth({ token: apiToken }));
    app.use("/agent/*/ledger/*", bearerAuth({ token: apiToken }));
    app.use("/agent/*/settlements", bearerAuth({ token: apiToken }));

    // Auth middleware for virtual account routes — master token or signed device token
    app.use("/api/v1/agents/*/deposit", async (c, next) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
      return dualAuth(c, next, "account:deposit");
    });
    app.use("/api/v1/agents/*/balance", async (c, next) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
      return dualAuth(c, next, "account:balance");
    });
    app.use("/api/v1/agents/*/withdraw", async (c, next) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
      return dualAuth(c, next, "account:withdraw");
    });
    app.use("/api/v1/agents/*/withdrawals", async (c, next) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
      return dualAuth(c, next, "account:withdrawals");
    });
    app.use("/api/v1/agents/*/checkout", async (c, next) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
      return dualAuth(c, next, "account:checkout");
    });
    // Note: /api/v1/stripe/webhook has NO auth middleware — Stripe calls it directly.
    // Verification is done via the webhook signature.
    // Admin withdrawal management — master token only
    app.use("/api/v1/admin/withdrawals/*", bearerAuth({ token: apiToken }));
    // Admin reconciliation — master token only
    app.use("/api/v1/admin/reconciliation", bearerAuth({ token: apiToken }));
    // Admin emergency freeze — master token only
    app.use("/api/v1/admin/freeze", bearerAuth({ token: apiToken }));
    app.use("/api/v1/admin/unfreeze", bearerAuth({ token: apiToken }));
  }

  // === Budget, Accounts & Admin Routes (after auth middleware) ===
  registerBudgetRoutes({
    app,
    moteDb,
    relayIdentity,
    freezeState,
    stripeClient,
    stripeConfig: stripeConfig ?? null,
  });

  // === Agent Routes (registration, discovery, capabilities, settlements, ledger) ===
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

  // --- Federation background loops ---

  const heartbeatInterval = startHeartbeatLoop(moteDb.db, relayIdentity, 60_000, () =>
    getEmergencyFreeze(),
  );

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

  // === Task Routes (submission, polling, receipt settlement) ===
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
