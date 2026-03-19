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
import type {
  EventLogEntry,
  ToolAuditEntry,
  SyncConversation,
  SyncConversationMessage,
  ExecutionReceipt,
} from "@motebit/sdk";
import {
  AgentTaskStatus,
  asMotebitId,
  asListingId,
  asNodeId,
  asConversationId,
  asPlanId,
  asAllocationId,
  asSettlementId,
  asGoalId,
} from "@motebit/sdk";
import type { AgentTask, MotebitId, NodeId } from "@motebit/sdk";
import type { WSContext } from "hono/ws";
/* eslint-disable no-restricted-imports -- Relay service generates its own keypair (not a user surface) */
import {
  verifySignedToken,
  verifyExecutionReceipt,
  hexPublicKeyToDidKey,
  issueReputationCredential,
  verifyKeySuccession,
  sign,
  verify,
  canonicalJson,
  bytesToHex,
  hexToBytes,
  hash as sha256Hash,
} from "@motebit/crypto";
/* eslint-enable no-restricted-imports */
import type { KeySuccessionRecord } from "@motebit/crypto";
import { createLogger } from "./logger.js";
import { SlidingWindowLimiter } from "./rate-limiter.js";
import {
  createFederationTables,
  initRelayIdentity,
  createFederationQueryCache,
  registerFederationRoutes,
  startHeartbeatLoop,
  startSettlementRetryLoop,
  insertRevocationEvent,
  cleanupRevocationEvents,
} from "./federation.js";
import type { RelayIdentity } from "./federation.js";
import { registerCredentialRoutes, getRelayKeypair } from "./credentials.js";
import { createTaskRouter, forwardTaskViaMcp, type ReceiptCandidate } from "./task-routing.js";
import {
  createDataSyncTables,
  registerDataSyncRoutes,
  upsertSyncConversation,
  upsertSyncMessage,
} from "./data-sync.js";
import {
  createAccountTables,
  createWithdrawalTables,
  getOrCreateAccount,
  getAccountBalance,
  getAccountBalanceDetailed,
  creditAccount,
  debitAccount,
  getTransactions,
  hasTransactionWithReference,
  requestWithdrawal,
  completeWithdrawal,
  signWithdrawalReceipt,
  failWithdrawal,
  getWithdrawals,
  getPendingWithdrawals,
  reconcileLedger,
  processStripeCheckout,
} from "./accounts.js";
import { createPairingTables, registerPairingRoutes } from "./pairing.js";
import {
  graphRankCandidates,
  explainedRankCandidates,
  settleOnReceipt,
  computeTrustClosure,
  findTrustedRoute,
  buildRoutingGraph,
} from "@motebit/market";
import type { CandidateProfile } from "@motebit/market";
import type { CapabilityPrice, BudgetAllocation, AgentTrustRecord } from "@motebit/sdk";
import {
  PLATFORM_FEE_RATE,
  AgentTrustLevel,
  EventType,
  evaluateTrustTransition,
  trustLevelToScore,
} from "@motebit/sdk";
import Stripe from "stripe";

/** Decode the payload half of a signed token without verifying the signature. */
function parseTokenPayloadUnsafe(
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
 *  When `expectedAudience` is provided, rejects tokens whose `aud` claim doesn't match
 *  (closes cross-endpoint replay vulnerability).
 *  Optional blacklistCheck callback rejects tokens whose jti appears in the token blacklist.
 *  Optional agentRevokedCheck callback rejects tokens for revoked agents.
 */
async function verifySignedTokenForDevice(
  token: string,
  motebitId: string,
  identityManager: IdentityManager,
  expectedAudience?: string,
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

  // Audience binding: reject tokens scoped to a different endpoint
  if (expectedAudience != null && payload.aud !== expectedAudience) return false;

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
  verifyDeviceSignature?: boolean; // When true, uses Ed25519 signed token verification (default: true)
  /** x402 on-chain payment for task submission. Required in production. */
  x402: X402Config;
  /** When true, relay issues AgentReputationCredentials on verified receipts. Default: false (peer-issued). */
  issueCredentials?: boolean;
  /** Federation configuration. Omit to disable federation. */
  federation?: {
    /** Display name for this relay in the federation. */
    displayName?: string;
    /** Public endpoint URL for this relay (how peers reach us). */
    endpointUrl?: string;
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
    verifyDeviceSignature = true,
    x402: x402Config,
    issueCredentials = process.env.MOTEBIT_RELAY_ISSUE_CREDENTIALS === "true",
    federation: federationConfig,
    stripe: stripeConfig,
  } = config;

  // Stripe Checkout — optional fiat on-ramp for virtual account deposits
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
  const taskQueue = new Map<
    string,
    {
      task: AgentTask;
      receipt?: ExecutionReceipt;
      expiresAt: number;
      submitted_by?: string;
      /** Gross amount x402 charged at submission time (from listing price). */
      price_snapshot?: number;
      /** x402 on-chain transaction hash captured from the payment settlement. */
      x402_tx_hash?: string;
      /** x402 network (CAIP-2) captured from the payment settlement. */
      x402_network?: string;
      /** When set, this task was forwarded from a peer relay and the result should be returned there. */
      origin_relay?: string;
      /** Set to true after receipt settlement completes — prevents double-settlement if receipt arrives via both MCP forward and late WebSocket reconnect. */
      settled?: boolean;
    }
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
  const authLimiter = new SlidingWindowLimiter(30, 60_000); // 30 req/min
  const readLimiter = new SlidingWindowLimiter(60, 60_000); // 60 req/min
  const writeLimiter = new SlidingWindowLimiter(30, 60_000); // 30 req/min
  const publicLimiter = new SlidingWindowLimiter(20, 60_000); // 20 req/min
  const expensiveLimiter = new SlidingWindowLimiter(10, 60_000); // 10 req/min
  const allLimiters = [authLimiter, readLimiter, writeLimiter, publicLimiter, expensiveLimiter];

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

  // Correlation ID middleware — generates or propagates X-Correlation-ID
  app.use("*", async (c, next) => {
    const correlationId = c.req.header("x-correlation-id") ?? crypto.randomUUID();
    c.set("correlationId" as never, correlationId as never);
    c.header("X-Correlation-ID", correlationId);
    await next();
  });

  // --- x402 Payment Layer ---
  // Task submission requires on-chain USDC payment via x402 when the agent has
  // a priced service listing. Free agents (no listing or zero cost) pass through.
  // The relay takes PLATFORM_FEE_RATE on every paid settlement.

  // Helper: extract motebitId from task URL path
  function extractMotebitIdFromPath(path: string): string | null {
    const match = path.match(/\/agent\/([^/]+)\/task/);
    return match ? match[1]! : null;
  }

  // Helper: look up agent's listing price (unit cost sum from pricing array).
  // Returns the cost regardless of pay_to_address — used for price snapshots.
  function getListingUnitCost(agentId: string): number {
    const row = moteDb.db
      .prepare(
        "SELECT pricing FROM relay_service_listings WHERE motebit_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(agentId) as { pricing: string } | undefined;
    if (!row) return 0;
    try {
      const pricing = JSON.parse(row.pricing) as CapabilityPrice[];
      return pricing.reduce((sum, p) => sum + (p.unit_cost ?? 0), 0);
    } catch {
      return 0;
    }
  }

  // Helper: look up agent pricing for x402 gate (requires pay_to_address AND positive price).
  function getAgentPricing(agentId: string): { unitCost: number; payTo: string } | null {
    const row = moteDb.db
      .prepare(
        "SELECT pricing, pay_to_address FROM relay_service_listings WHERE motebit_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(agentId) as { pricing: string; pay_to_address: string | null } | undefined;
    if (!row || !row.pay_to_address) return null;
    try {
      const pricing = JSON.parse(row.pricing) as CapabilityPrice[];
      const totalCost = pricing.reduce((sum, p) => sum + (p.unit_cost ?? 0), 0);
      if (totalCost <= 0) return null;
      return { unitCost: totalCost, payTo: row.pay_to_address };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Unified receipt ingestion pipeline
  // ---------------------------------------------------------------------------
  // ALL receipts — regardless of transport (HTTP POST, MCP forward, WebSocket,
  // federation) — flow through this single function. It handles:
  //   1. Idempotency (DB settlement check + in-memory settled flag)
  //   2. Ed25519 signature verification
  //   3. Trust record update (evaluateTrustTransition)
  //   4. Delegation edge caching (multi-hop routing intelligence)
  //   5. Multi-hop settlement (nested delegation_receipts)
  //   6. Latency recording
  //   7. Main settlement (settleOnReceipt) + virtual account credits
  //   8. Credential issuance (AgentReputationCredential)
  //   9. WebSocket fan-out
  //  10. Federation result forwarding
  //
  // Returns { verified: true } on success, { verified: false, reason } on failure.
  // Callers decide how to surface the failure (HTTP 403, log warning, etc.).
  async function handleReceiptIngestion(
    receipt: ExecutionReceipt,
    taskId: string,
    motebitId: string,
    entry: typeof taskQueue extends Map<string, infer V> ? V : never,
  ): Promise<
    | { verified: true; credential_id: string | null; already_settled?: boolean }
    | { verified: false; reason: string }
  > {
    // --- Idempotency: in-memory flag ---
    if (entry.settled) {
      logger.info("settlement.already_settled_memory", { correlationId: taskId });
      return { verified: true, credential_id: null, already_settled: true };
    }

    // --- Ed25519 verification ---
    let pubKeyHex: string | undefined;
    const regRow = moteDb.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(receipt.motebit_id) as { public_key: string } | undefined;
    if (regRow?.public_key) {
      pubKeyHex = regRow.public_key;
    } else {
      const devices = await identityManager.listDevices(asMotebitId(receipt.motebit_id as string));
      const device =
        (receipt.device_id != null
          ? devices.find((d) => d.device_id === receipt.device_id)
          : undefined) ?? devices.find((d) => d.public_key);
      if (device?.public_key) {
        pubKeyHex = device.public_key;
      }
    }

    if (!pubKeyHex) {
      const executingId = receipt.motebit_id as string;
      logger.error("receipt.verification_failed", {
        correlationId: taskId,
        executingAgentId: executingId,
        reason: "no public key found for executing agent",
      });
      return { verified: false, reason: `no public key on file for agent ${executingId}` };
    }

    const receiptValid = await verifyExecutionReceipt(receipt, hexToBytes(pubKeyHex));
    if (!receiptValid) {
      logger.error("receipt.verification_failed", {
        correlationId: taskId,
        reason: "invalid Ed25519 signature",
      });
      return { verified: false, reason: "invalid Ed25519 signature" };
    }

    logger.info("receipt.verified", {
      correlationId: taskId,
      status: receipt.status,
      motebitId: receipt.motebit_id as string,
    });

    // --- Idempotency: DB settlement check ---
    const existingSettlement = moteDb.db
      .prepare("SELECT settlement_id FROM relay_settlements WHERE task_id = ? AND motebit_id = ?")
      .get(taskId, motebitId) as { settlement_id: string } | undefined;
    if (existingSettlement) {
      entry.settled = true;
      logger.info("settlement.duplicate", { correlationId: taskId });
      return { verified: true, credential_id: null, already_settled: true };
    }

    // --- Trust record update ---
    const taskSubmitter = entry.submitted_by ?? entry.task.submitted_by;
    const isSelfDelegation =
      taskSubmitter != null && taskSubmitter === (receipt.motebit_id as string);
    if (isSelfDelegation) {
      logger.info("trust.self_delegation_skipped", {
        correlationId: taskId,
        motebitId,
        reason: "submitter === executor — no trust signal or credential issued",
      });
    }
    if (!isSelfDelegation) {
      try {
        const executingAgentId = receipt.motebit_id as string;
        const taskSucceeded = receipt.status === "completed";
        const taskFailed = receipt.status === "failed";
        const now = Date.now();

        const existing = await moteDb.agentTrustStore.getAgentTrust(motebitId, executingAgentId);

        if (existing) {
          const updated: AgentTrustRecord = {
            ...existing,
            last_seen_at: now,
            interaction_count: existing.interaction_count + 1,
            successful_tasks: (existing.successful_tasks ?? 0) + (taskSucceeded ? 1 : 0),
            failed_tasks: (existing.failed_tasks ?? 0) + (taskFailed ? 1 : 0),
          };
          const newLevel = evaluateTrustTransition(updated);
          if (newLevel != null) {
            const previousLevel = existing.trust_level;
            updated.trust_level = newLevel;
            try {
              const clock = await eventStore.getLatestClock(asMotebitId(motebitId));
              await eventStore.append({
                event_id: crypto.randomUUID(),
                motebit_id: asMotebitId(motebitId),
                timestamp: now,
                event_type: EventType.TrustLevelChanged,
                payload: {
                  remote_motebit_id: executingAgentId,
                  previous_level: previousLevel,
                  new_level: newLevel,
                  successful_tasks: updated.successful_tasks,
                  failed_tasks: updated.failed_tasks,
                  source: "relay_receipt_verification",
                },
                version_clock: clock + 1,
                tombstoned: false,
              });
            } catch {
              // Event emission is best-effort
            }
          }
          await moteDb.agentTrustStore.setAgentTrust(updated);
        } else {
          await moteDb.agentTrustStore.setAgentTrust({
            motebit_id: asMotebitId(motebitId),
            remote_motebit_id: asMotebitId(executingAgentId),
            trust_level: AgentTrustLevel.FirstContact,
            first_seen_at: now,
            last_seen_at: now,
            interaction_count: 1,
            successful_tasks: taskSucceeded ? 1 : 0,
            failed_tasks: taskFailed ? 1 : 0,
          });
        }
      } catch {
        // Trust update is best-effort — don't block receipt delivery
      }
    }

    // --- Delegation edge caching ---
    if (receipt.delegation_receipts && receipt.delegation_receipts.length > 0) {
      try {
        const insertEdge = moteDb.db.prepare(
          `INSERT INTO relay_delegation_edges
           (from_motebit_id, to_motebit_id, trust, cost, latency_ms, reliability, regulatory_risk, recorded_at, receipt_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );

        const walkReceipts = async (
          parentMotebitId: string,
          receipts: ExecutionReceipt[],
        ): Promise<void> => {
          for (const sub of receipts) {
            if (sub.signature) {
              let subPubKey: string | undefined;
              const subReg = moteDb.db
                .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
                .get(sub.motebit_id) as { public_key: string } | undefined;
              if (subReg?.public_key) {
                subPubKey = subReg.public_key;
              } else {
                const subDevices = await identityManager.listDevices(asMotebitId(sub.motebit_id));
                subPubKey = subDevices.find((d) => d.public_key)?.public_key;
              }
              if (subPubKey) {
                const subValid = await verifyExecutionReceipt(sub, hexToBytes(subPubKey));
                if (!subValid) {
                  logger.warn("delegation_receipt.signature_invalid", {
                    correlationId: taskId,
                    parentAgent: parentMotebitId,
                    delegatedAgent: sub.motebit_id,
                  });
                  continue;
                }
              }
            }

            const latency =
              sub.completed_at && sub.submitted_at ? sub.completed_at - sub.submitted_at : 5000;
            const reliability = sub.status === "completed" ? 0.9 : 0.3;
            const trustRow = moteDb.db
              .prepare(
                "SELECT trust_level FROM agent_trust WHERE motebit_id = ? AND remote_motebit_id = ?",
              )
              .get(motebitId, sub.motebit_id) as { trust_level: string } | undefined;
            const trust = trustRow
              ? trustLevelToScore(trustRow.trust_level as AgentTrustLevel)
              : 0.1;

            insertEdge.run(
              parentMotebitId,
              sub.motebit_id,
              trust,
              0,
              latency > 0 ? latency : 5000,
              reliability,
              0,
              Date.now(),
              sub.result_hash ?? null,
            );

            if (sub.delegation_receipts && sub.delegation_receipts.length > 0) {
              await walkReceipts(sub.motebit_id as string, sub.delegation_receipts);
            }
          }
        };

        await walkReceipts(receipt.motebit_id as string, receipt.delegation_receipts);
      } catch {
        // Best-effort edge caching
      }
    }

    // --- Multi-hop settlement ---
    const delegationReceipts = receipt.delegation_receipts ?? [];
    if (delegationReceipts.length > 0) {
      logger.info("multihop.settlement.start", {
        correlationId: taskId,
        count: delegationReceipts.length,
      });
      for (const sub of delegationReceipts) {
        const subRelayTaskId = (sub as unknown as Record<string, unknown>).relay_task_id;
        if (typeof subRelayTaskId !== "string" || subRelayTaskId === "") continue;

        try {
          const subEntry = taskQueue.get(subRelayTaskId);
          if (!subEntry) {
            logger.warn("multihop.settlement.task_not_found", {
              correlationId: taskId,
              subTaskId: subRelayTaskId,
              subAgent: sub.motebit_id,
            });
            continue;
          }

          let subPubKey: string | undefined;
          const subReg = moteDb.db
            .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
            .get(sub.motebit_id) as { public_key: string } | undefined;
          if (subReg?.public_key) subPubKey = subReg.public_key;
          else {
            const subDevices = await identityManager.listDevices(asMotebitId(sub.motebit_id));
            subPubKey = subDevices.find((d) => d.public_key)?.public_key;
          }
          if (!subPubKey) continue;

          const subValid = await verifyExecutionReceipt(sub, hexToBytes(subPubKey));
          if (!subValid) {
            logger.warn("multihop.settlement.sig_invalid", {
              correlationId: taskId,
              subTaskId: subRelayTaskId,
              subAgent: sub.motebit_id,
            });
            continue;
          }

          const subExisting = moteDb.db
            .prepare(
              "SELECT settlement_id FROM relay_settlements WHERE task_id = ? AND motebit_id = ?",
            )
            .get(subRelayTaskId, sub.motebit_id) as { settlement_id: string } | undefined;
          if (subExisting) continue;

          const subUnitCost = getListingUnitCost(sub.motebit_id as string);
          const subGross =
            subEntry.price_snapshot ??
            (subUnitCost > 0 ? subUnitCost / (1 - PLATFORM_FEE_RATE) : 0);
          if (subGross <= 0) continue;

          const subSettlementId = asSettlementId(crypto.randomUUID());
          const subAllocationId = asAllocationId(`x402-${subRelayTaskId}`);
          const subAllocation: BudgetAllocation = {
            allocation_id: subAllocationId,
            goal_id: asGoalId(subRelayTaskId),
            candidate_motebit_id: sub.motebit_id,
            amount_locked: subGross,
            currency: "USDC",
            created_at: sub.submitted_at ?? Date.now(),
            status: "settled",
          };

          const subSettlement = settleOnReceipt(subAllocation, sub, null, subSettlementId);

          try {
            moteDb.db.exec("BEGIN");
            moteDb.db
              .prepare(
                `INSERT OR IGNORE INTO relay_settlements
               (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, ledger_hash, amount_settled, platform_fee, platform_fee_rate, status, settled_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                subSettlement.settlement_id,
                subSettlement.allocation_id,
                subRelayTaskId,
                sub.motebit_id,
                subSettlement.receipt_hash,
                subSettlement.ledger_hash,
                subSettlement.amount_settled,
                subSettlement.platform_fee,
                subSettlement.platform_fee_rate,
                subSettlement.status,
                subSettlement.settled_at,
              );

            moteDb.db
              .prepare(
                "UPDATE relay_allocations SET status = 'settled', settled_at = ? WHERE task_id = ?",
              )
              .run(Date.now(), subRelayTaskId);

            if (subSettlement.amount_settled > 0) {
              creditAccount(
                moteDb.db,
                sub.motebit_id as string,
                subSettlement.amount_settled,
                "settlement_credit",
                subSettlement.settlement_id,
                `Payment for sub-delegated task ${subRelayTaskId}`,
              );
            }

            moteDb.db.exec("COMMIT");
            logger.info("multihop.settlement.created", {
              correlationId: taskId,
              subTaskId: subRelayTaskId,
              subAgent: sub.motebit_id,
              net: subSettlement.amount_settled,
              fee: subSettlement.platform_fee,
            });
          } catch (txnErr) {
            moteDb.db.exec("ROLLBACK");
            logger.warn("multihop.settlement.failed", {
              correlationId: taskId,
              subTaskId: subRelayTaskId,
              error: txnErr instanceof Error ? txnErr.message : String(txnErr),
            });
          }
        } catch (subErr: unknown) {
          logger.warn("multihop.settlement.sub_error", {
            correlationId: taskId,
            subRelayTaskId,
            error: subErr instanceof Error ? subErr.message : String(subErr),
          });
        }
      }
    }

    // --- Latency recording ---
    if (receipt.completed_at && entry.task.submitted_at) {
      const elapsed = receipt.completed_at - entry.task.submitted_at;
      if (elapsed > 0 && receipt.motebit_id != null) {
        try {
          moteDb.db
            .prepare(
              `INSERT INTO relay_latency_stats (motebit_id, remote_motebit_id, latency_ms, recorded_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(motebitId, receipt.motebit_id, elapsed, Date.now());
        } catch {
          // Best-effort latency recording
        }
      }
    }

    // --- Main settlement + credential issuance ---
    let credential_id: string | null = null;
    {
      try {
        const persistentAlloc = moteDb.db
          .prepare("SELECT * FROM relay_allocations WHERE task_id = ? AND status = 'locked'")
          .get(taskId) as
          | { allocation_id: string; amount_locked: number; motebit_id: string }
          | undefined;

        const fallbackUnitCost = getListingUnitCost(receipt.motebit_id as string);
        const grossAmount =
          persistentAlloc?.amount_locked ??
          entry.price_snapshot ??
          (fallbackUnitCost > 0 ? fallbackUnitCost / (1 - PLATFORM_FEE_RATE) : 0);

        const settlementId = asSettlementId(crypto.randomUUID());
        const allocationId = persistentAlloc
          ? asAllocationId(persistentAlloc.allocation_id)
          : asAllocationId(`x402-${taskId}`);
        const allocation: BudgetAllocation = {
          allocation_id: allocationId,
          goal_id: asGoalId(taskId),
          candidate_motebit_id: receipt.motebit_id,
          amount_locked: grossAmount,
          currency: "USDC",
          created_at: receipt.submitted_at ?? Date.now(),
          status: "settled",
        };

        const settlement = settleOnReceipt(allocation, receipt, null, settlementId);

        let credentialRow: {
          credential_id: string;
          subject: string;
          issuer: string;
          type: string;
          json: string;
          issued_at: number;
        } | null = null;

        if (issueCredentials && receipt.status === "completed" && !isSelfDelegation) {
          const latencyRows = moteDb.db
            .prepare(
              "SELECT latency_ms FROM relay_latency_stats WHERE remote_motebit_id = ? ORDER BY recorded_at DESC LIMIT 100",
            )
            .all(receipt.motebit_id as string) as Array<{ latency_ms: number }>;
          const avgLatency =
            latencyRows.length > 0
              ? latencyRows.reduce((a, r) => a + r.latency_ms, 0) / latencyRows.length
              : receipt.completed_at && receipt.submitted_at
                ? receipt.completed_at - receipt.submitted_at
                : 0;

          const subjectDid = pubKeyHex
            ? hexPublicKeyToDidKey(pubKeyHex)
            : `did:motebit:${receipt.motebit_id as string}`;

          const relayKeys = getRelayKeypair(relayIdentity);
          const vc = await issueReputationCredential(
            {
              success_rate: 1.0,
              avg_latency_ms: avgLatency,
              task_count: latencyRows.length + 1,
              trust_score: 1.0,
              availability: 1.0,
              measured_at: Date.now(),
            },
            relayKeys.privateKey,
            relayKeys.publicKey,
            subjectDid,
          );

          const credType =
            vc.type.find((t) => t !== "VerifiableCredential") ?? "VerifiableCredential";
          credentialRow = {
            credential_id: crypto.randomUUID(),
            subject: receipt.motebit_id as string,
            issuer: vc.issuer,
            type: credType,
            json: JSON.stringify(vc),
            issued_at: Date.now(),
          };
        }

        moteDb.db.exec("BEGIN");
        try {
          moteDb.db
            .prepare(
              `INSERT OR IGNORE INTO relay_settlements
               (settlement_id, allocation_id, task_id, motebit_id, receipt_hash, ledger_hash, amount_settled, platform_fee, platform_fee_rate, status, settled_at, x402_tx_hash, x402_network)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              settlement.settlement_id,
              settlement.allocation_id,
              taskId,
              motebitId,
              settlement.receipt_hash,
              settlement.ledger_hash,
              settlement.amount_settled,
              settlement.platform_fee,
              settlement.platform_fee_rate,
              settlement.status,
              settlement.settled_at,
              entry.x402_tx_hash ?? null,
              entry.x402_network ?? null,
            );

          if (persistentAlloc) {
            moteDb.db
              .prepare(
                "UPDATE relay_allocations SET status = 'settled', settled_at = ? WHERE task_id = ?",
              )
              .run(Date.now(), taskId);
          }

          {
            const workerMotebitId = receipt.motebit_id as string;

            if (settlement.status === "refunded") {
              const delegatorId = entry.submitted_by ?? entry.task.submitted_by ?? motebitId;
              creditAccount(
                moteDb.db,
                delegatorId,
                settlement.amount_settled + settlement.platform_fee,
                "allocation_release",
                settlement.settlement_id,
                `Refund for task ${taskId} (${receipt.status})`,
              );
            } else {
              if (settlement.amount_settled > 0) {
                creditAccount(
                  moteDb.db,
                  workerMotebitId,
                  settlement.amount_settled,
                  "settlement_credit",
                  settlement.settlement_id,
                  `Payment for task ${taskId}`,
                );
              }

              if (settlement.status === "partial" && persistentAlloc) {
                const grossSettled = settlement.amount_settled + settlement.platform_fee;
                const remainder = persistentAlloc.amount_locked - grossSettled;
                if (remainder > 0) {
                  const delegatorId = entry.submitted_by ?? entry.task.submitted_by ?? motebitId;
                  creditAccount(
                    moteDb.db,
                    delegatorId,
                    remainder,
                    "allocation_release",
                    settlement.settlement_id,
                    `Partial release for task ${taskId}`,
                  );
                }
              }
            }
          }

          if (credentialRow) {
            moteDb.db
              .prepare(
                `INSERT INTO relay_credentials (credential_id, subject_motebit_id, issuer_did, credential_type, credential_json, issued_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
              )
              .run(
                credentialRow.credential_id,
                credentialRow.subject,
                credentialRow.issuer,
                credentialRow.type,
                credentialRow.json,
                credentialRow.issued_at,
              );
            credential_id = credentialRow.credential_id;
          }

          moteDb.db.exec("COMMIT");
          logger.info("settlement.created", {
            correlationId: taskId,
            gross: settlement.amount_settled + settlement.platform_fee,
            fee: settlement.platform_fee,
            net: settlement.amount_settled,
            x402TxHash: entry.x402_tx_hash ?? null,
          });
          if (credentialRow) {
            logger.info("credential.issued", {
              correlationId: taskId,
              motebitId: credentialRow.subject,
              type: credentialRow.type,
            });
          }
        } catch (txnErr) {
          moteDb.db.exec("ROLLBACK");
          throw txnErr;
        }
      } catch (settlementErr) {
        logger.warn("settlement.failed", {
          correlationId: taskId,
          error: settlementErr instanceof Error ? settlementErr.message : String(settlementErr),
        });
        // Best-effort settlement — don't block receipt delivery on accounting errors
      }
    }

    // Mark settled in memory
    entry.settled = true;

    // --- WebSocket fan-out ---
    const peers = connections.get(motebitId);
    if (peers) {
      const payload = JSON.stringify({ type: "task_result", task_id: taskId, receipt });
      for (const peer of peers) {
        peer.ws.send(payload);
      }
    }

    // --- Federation result forwarding ---
    if (entry.origin_relay) {
      try {
        const originPeer = moteDb.db
          .prepare("SELECT endpoint_url, public_key FROM relay_peers WHERE peer_relay_id = ?")
          .get(entry.origin_relay) as { endpoint_url: string } | undefined;
        if (originPeer) {
          const resultBody = {
            task_id: taskId,
            origin_relay: relayIdentity.relayMotebitId,
            receipt,
            timestamp: Date.now(),
          };
          const resultBytes = new TextEncoder().encode(canonicalJson(resultBody));
          const resultSig = await sign(resultBytes, relayIdentity.privateKey);

          await fetch(`${originPeer.endpoint_url}/federation/v1/task/result`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Correlation-ID": taskId },
            body: JSON.stringify({ ...resultBody, signature: bytesToHex(resultSig) }),
            signal: AbortSignal.timeout(10000),
          });
        }
      } catch {
        // Best-effort federation result return — receipt is already stored locally
      }

      // Update trust for the originating relay
      try {
        const peerRow = moteDb.db
          .prepare(
            "SELECT trust_level, successful_forwards, failed_forwards FROM relay_peers WHERE peer_relay_id = ?",
          )
          .get(entry.origin_relay) as
          | { trust_level: string; successful_forwards: number; failed_forwards: number }
          | undefined;

        if (peerRow) {
          const isSuccess = receipt.status === "completed";
          const newSuccessful = peerRow.successful_forwards + (isSuccess ? 1 : 0);
          const newFailed = peerRow.failed_forwards + (isSuccess ? 0 : 1);

          const trustRecord: AgentTrustRecord = {
            motebit_id: asMotebitId(relayIdentity.relayMotebitId),
            remote_motebit_id: asMotebitId(entry.origin_relay),
            trust_level: peerRow.trust_level as AgentTrustLevel,
            first_seen_at: 0,
            last_seen_at: Date.now(),
            interaction_count: newSuccessful + newFailed,
            successful_tasks: newSuccessful,
            failed_tasks: newFailed,
          };

          const newLevel = evaluateTrustTransition(trustRecord);
          const trustLevel = newLevel ?? peerRow.trust_level;
          const trustScore = trustLevelToScore(trustLevel as AgentTrustLevel);

          moteDb.db
            .prepare(
              `UPDATE relay_peers SET
              successful_forwards = ?, failed_forwards = ?,
              trust_level = ?, trust_score = ?
              WHERE peer_relay_id = ?`,
            )
            .run(newSuccessful, newFailed, trustLevel, trustScore, entry.origin_relay);
        }
      } catch {
        // Best-effort trust update
      }
    }

    return { verified: true, credential_id };
  }

  // Capture x402 settlement proof so the task handler can link it to the task queue entry.
  // Same single-threaded pattern as currentPricing — set by hook, read by handler, no interleaving.
  let lastSettleTxHash: string | undefined;
  let lastSettleNetwork: string | undefined;

  {
    const { paymentMiddleware, x402ResourceServer } = await import("@x402/hono");
    const { ExactEvmScheme } = await import("@x402/evm/exact/server");
    const { HTTPFacilitatorClient } = await import("@x402/core/server");

    const facilitatorClient = new HTTPFacilitatorClient({
      url: x402Config.facilitatorUrl ?? "https://x402.org/facilitator",
    });

    const network = x402Config.network as `${string}:${string}`;
    const resourceServer = new x402ResourceServer(facilitatorClient).register(
      network,
      new ExactEvmScheme(),
    );

    resourceServer.onAfterSettle((ctx): Promise<void> => {
      lastSettleTxHash = ctx.result.transaction;
      lastSettleNetwork = ctx.result.network;
      return Promise.resolve();
    });

    // Single DB lookup per request. The wrapper sets currentPricing before
    // calling x402Gate; the price/payTo callbacks read it synchronously within
    // the same tick (x402 resolves route config before any await). Safe in
    // Node's single-threaded model — no interleaving between set and read.
    let currentPricing: { unitCost: number; payTo: string } | null = null;

    const x402Gate = paymentMiddleware(
      {
        "POST /agent/*/task": {
          accepts: {
            scheme: "exact",
            network,
            price: () => {
              if (!currentPricing) return "$0";
              const gross = currentPricing.unitCost / (1 - PLATFORM_FEE_RATE);
              return `$${gross.toFixed(6)}`;
            },
            payTo: () => {
              return currentPricing?.payTo ?? x402Config.payToAddress;
            },
          },
          description: "Submit a task to a motebit agent",
          mimeType: "application/json",
          unpaidResponseBody: (ctx) => {
            const agentId = extractMotebitIdFromPath(ctx.path);
            return {
              contentType: "application/json",
              body: {
                error: "payment_required",
                message: "Task submission requires USDC payment via x402",
                agent: agentId,
                estimated_cost: currentPricing?.unitCost ?? 0,
                platform_fee_rate: PLATFORM_FEE_RATE,
                network: x402Config.network,
              },
            };
          },
        },
      },
      resourceServer,
      { testnet: x402Config.testnet ?? true },
    );

    // Wrap x402: single getAgentPricing() call per request.
    // Free tasks (no listing / zero price) bypass payment gate entirely.
    // Virtual account bypass: if the delegator has sufficient virtual balance,
    // skip x402 — the task handler will debit the virtual account directly.
    app.use("*", async (c, next) => {
      const isTaskPost = c.req.method === "POST" && /\/agent\/[^/]+\/task/.test(c.req.path);
      if (!isTaskPost) return next();
      const agentId = extractMotebitIdFromPath(c.req.path);
      currentPricing = agentId ? getAgentPricing(agentId) : null;
      if (!currentPricing) return next(); // Free — no x402

      // Virtual account bypass: check if the delegator has sufficient virtual
      // balance to cover the cost. If so, skip x402 and let the handler debit
      // the virtual account directly.
      //
      // Step 1: Try the auth token (signed tokens contain the caller's motebit_id).
      // Step 2: If master token (no caller identity in token), peek at the body
      //         using arrayBuffer() which allows re-reading via a fresh Request.
      try {
        let delegatorId: string | undefined;
        const authHeader = c.req.header("authorization");
        if (authHeader?.startsWith("Bearer ")) {
          const token = authHeader.slice(7);
          const claims = parseTokenPayloadUnsafe(token);
          if (claims?.mid) {
            delegatorId = claims.mid;
          }
        }

        // If token didn't yield a delegator, peek at body for submitted_by
        if (!delegatorId) {
          const buf = await c.req.raw.arrayBuffer();
          const bodyText = new TextDecoder().decode(buf);
          // Reconstruct the request with the same body so x402 and handler can read it
          const newReq = new Request(c.req.raw.url, {
            method: c.req.raw.method,
            headers: c.req.raw.headers,
            body: bodyText,
          });
          // Replace the raw request on the context so downstream can re-read body
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any -- Hono internals: replacing raw request for body re-read
          (c.req as any).raw = newReq;
          const body = JSON.parse(bodyText) as { submitted_by?: string };
          delegatorId = body.submitted_by;
        }

        if (delegatorId) {
          const gross = currentPricing.unitCost / (1 - PLATFORM_FEE_RATE);
          const account = getAccountBalance(moteDb.db, delegatorId);
          if (account && account.balance >= gross) {
            return next();
          }
        }
      } catch {
        // Parse failed — fall through to x402
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
      return x402Gate(c, next);
    });
  }

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

  function rateLimitMiddleware(limiter: SlidingWindowLimiter) {
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

      if (verifyDeviceSignature && token.includes(".")) {
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
  app.get("/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));

  // --- WebSocket: bidirectional event stream ---
  app.get(
    "/ws/sync/:motebitId",
    upgradeWebSocket((c) => {
      // Route param is guaranteed by /ws/sync/:motebitId pattern; guard in onOpen for defense-in-depth
      const motebitId = asMotebitId(c.req.param("motebitId") as string);
      const url = new URL(c.req.url, "http://localhost");
      const deviceId = url.searchParams.get("device_id") ?? crypto.randomUUID();
      const token = url.searchParams.get("token");

      // Per-connection rate limit: max 100 messages per 10 seconds
      const WS_RATE_LIMIT = 100;
      const WS_RATE_WINDOW_MS = 10_000;
      let wsMessageCount = 0;
      let wsWindowStart = Date.now();

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
              // OK — master token
            } else if (verifyDeviceSignature && token.includes(".")) {
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
          // Per-connection rate limiting
          const now = Date.now();
          if (now - wsWindowStart > WS_RATE_WINDOW_MS) {
            wsMessageCount = 0;
            wsWindowStart = now;
          }
          wsMessageCount++;
          if (wsMessageCount > WS_RATE_LIMIT) {
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

  app.get("/api/v1/audit/:motebitId", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
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
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const plans = moteDb.planStore.listPlans(motebitId);
    const plansWithSteps = plans.map((plan) => ({
      ...plan,
      steps: moteDb.planStore.getStepsForPlan(plan.plan_id),
    }));
    return c.json({ motebit_id: motebitId, plans: plansWithSteps });
  });

  // --- Plans: get single plan with steps ---
  app.get("/api/v1/plans/:motebitId/:planId", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const planId = asPlanId(c.req.param("planId"));
    const plan = moteDb.planStore.getPlan(planId);
    if (!plan || plan.motebit_id !== motebitId) {
      throw new HTTPException(404, { message: "Plan not found" });
    }
    const steps = moteDb.planStore.getStepsForPlan(planId);
    return c.json({ motebit_id: motebitId, plan: { ...plan, steps } });
  });

  // --- Execution Ledger: replayable execution manifest for a goal ---
  // Server-side reconstruction from event log + tool audit. Same algorithm as
  // MotebitRuntime.replayGoal() but without Ed25519 signing (relay doesn't hold
  // the motebit's private key — signing happens device-side).
  app.get("/api/v1/execution/:motebitId/:goalId", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const goalId = c.req.param("goalId");

    // 1. Plan + steps
    const plan = moteDb.planStore.getPlanForGoal(goalId);
    if (!plan || plan.motebit_id !== motebitId) {
      throw new HTTPException(404, { message: "No plan found for goal" });
    }
    const steps = moteDb.planStore.getStepsForPlan(plan.plan_id);

    // 2. Query plan lifecycle + delegation events
    const planEventTypes = [
      "plan_created",
      "plan_step_started",
      "plan_step_completed",
      "plan_step_failed",
      "plan_step_delegated",
      "plan_completed",
      "plan_failed",
      "goal_created",
      "goal_executed",
      "goal_completed",
      "agent_task_completed",
      "agent_task_failed",
      "proposal_created",
      "proposal_accepted",
      "proposal_rejected",
      "proposal_countered",
      "collaborative_step_completed",
    ];
    const allEvents = await eventStore.query({ motebit_id: motebitId });
    const relevantEvents = allEvents.filter((e) => {
      if (!planEventTypes.includes(e.event_type)) return false;
      const p = e.payload;
      return p.goal_id === goalId || p.plan_id === plan.plan_id;
    });

    // 3. Delegation receipt metadata from task completion events
    const delegationTaskIds = new Set(
      steps.filter((s) => s.delegation_task_id).map((s) => s.delegation_task_id!),
    );
    const receiptEvents = allEvents.filter((e) => {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- EventType string enum values
      if (e.event_type !== "agent_task_completed" && e.event_type !== "agent_task_failed")
        return false;
      const p = e.payload;
      return delegationTaskIds.has(p.task_id as string);
    });

    // 4. Tool audit entries
    const toolEntries = moteDb.toolAuditSink.queryByRunId?.(plan.plan_id) ?? [];

    // 5. Build timeline — only emit recognized fields (no raw payload leak)
    type TimelineEntry = { timestamp: number; type: string; payload: Record<string, unknown> };
    const timeline: TimelineEntry[] = [];

    const goalStart = relevantEvents.find(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- EventType string enum values
      (e) => e.event_type === "goal_created" || e.event_type === "goal_executed",
    );
    if (goalStart) {
      timeline.push({
        timestamp: goalStart.timestamp,
        type: "goal_started",
        payload: { goal_id: goalId },
      });
    }

    const typeFieldMap: Record<string, { mapped: string; fields: string[] }> = {
      plan_created: { mapped: "plan_created", fields: ["plan_id", "title", "total_steps"] },
      plan_step_started: {
        mapped: "step_started",
        fields: ["plan_id", "step_id", "ordinal", "description"],
      },
      plan_step_completed: {
        mapped: "step_completed",
        fields: ["plan_id", "step_id", "ordinal", "tool_calls_made"],
      },
      plan_step_failed: {
        mapped: "step_failed",
        fields: ["plan_id", "step_id", "ordinal", "error"],
      },
      plan_step_delegated: {
        mapped: "step_delegated",
        fields: ["plan_id", "step_id", "ordinal", "task_id"],
      },
      plan_completed: { mapped: "plan_completed", fields: ["plan_id"] },
      plan_failed: { mapped: "plan_failed", fields: ["plan_id", "reason"] },
      proposal_created: { mapped: "proposal_created", fields: ["plan_id", "proposal_id"] },
      proposal_accepted: { mapped: "proposal_accepted", fields: ["plan_id", "proposal_id"] },
      proposal_rejected: { mapped: "proposal_rejected", fields: ["plan_id", "proposal_id"] },
      proposal_countered: { mapped: "proposal_countered", fields: ["plan_id", "proposal_id"] },
      collaborative_step_completed: {
        mapped: "collaborative_step_completed",
        fields: ["plan_id", "step_id"],
      },
    };

    for (const event of relevantEvents) {
      const mapping = typeFieldMap[event.event_type];
      if (!mapping) continue;
      const p = event.payload;
      const payload: Record<string, unknown> = {};
      for (const field of mapping.fields) {
        if (p[field] !== undefined) payload[field] = p[field];
      }
      timeline.push({ timestamp: event.timestamp, type: mapping.mapped, payload });
    }

    // Tool invocations
    for (const entry of toolEntries) {
      if (!entry.decision.allowed) continue;
      timeline.push({
        timestamp: entry.timestamp,
        type: "tool_invoked",
        payload: { tool: entry.tool, call_id: entry.callId },
      });
      if (entry.result) {
        timeline.push({
          timestamp: entry.timestamp + (entry.result.durationMs ?? 0),
          type: "tool_result",
          payload: {
            tool: entry.tool,
            ok: entry.result.ok,
            duration_ms: entry.result.durationMs,
            call_id: entry.callId,
          },
        });
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- EventType string enum values
    const goalEnd = relevantEvents.find((e) => e.event_type === "goal_completed");
    if (goalEnd) {
      timeline.push({
        timestamp: goalEnd.timestamp,
        type: "goal_completed",
        payload: { goal_id: goalId, status: plan.status },
      });
    }

    timeline.sort((a, b) => a.timestamp - b.timestamp);

    // 6. Step summaries
    const stepSummaries = steps.map((s) => {
      const stepToolEntries = toolEntries.filter((t) => {
        if (s.started_at == null) return false;
        const end = s.completed_at ?? Infinity;
        return t.timestamp >= s.started_at && t.timestamp <= end;
      });
      const summary: Record<string, unknown> = {
        step_id: s.step_id,
        ordinal: s.ordinal,
        description: s.description,
        status: s.status,
        tools_used: [...new Set(stepToolEntries.map((t) => t.tool))],
        tool_calls: s.tool_calls_made,
        started_at: s.started_at,
        completed_at: s.completed_at,
      };
      if (s.delegation_task_id) {
        const re = receiptEvents.find((e) => e.payload.task_id === s.delegation_task_id);
        const receipt = re
          ? (re.payload.receipt as Record<string, unknown> | undefined)
          : undefined;
        summary.delegation = { task_id: s.delegation_task_id, receipt_hash: receipt?.signature };
      }
      return summary;
    });

    // 7. Delegation receipt summaries
    const delegationReceipts = receiptEvents.map((e) => {
      const p = e.payload;
      const receipt = p.receipt as Record<string, unknown> | undefined;
      return {
        task_id: p.task_id as string,
        motebit_id: (receipt?.motebit_id ?? "") as string,
        device_id: (receipt?.device_id ?? "") as string,
        status: (p.status ?? "unknown") as string,
        completed_at: (receipt?.completed_at ?? e.timestamp) as number,
        tools_used: (p.tools_used ?? []) as string[],
        signature_prefix: (receipt?.signature ?? "") as string,
      };
    });

    // 8. Content hash (SHA-256 of canonical timeline)
    const canonicalLines = timeline.map((entry) => canonicalJson(entry));
    const hashBuf = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalLines.join("\n")),
    );
    const contentHash = bytesToHex(new Uint8Array(hashBuf));

    // 9. Status mapping
    const statusMap: Record<string, string> = {
      completed: "completed",
      failed: "failed",
      paused: "paused",
      active: "active",
    };

    return c.json({
      spec: "motebit/execution-ledger@1.0",
      motebit_id: motebitId,
      goal_id: goalId,
      plan_id: plan.plan_id,
      started_at: timeline[0]?.timestamp ?? plan.created_at,
      completed_at: timeline[timeline.length - 1]?.timestamp ?? plan.updated_at,
      status: statusMap[plan.status] ?? "failed",
      timeline,
      steps: stepSummaries,
      delegation_receipts: delegationReceipts,
      content_hash: contentHash,
    });
  });

  // --- Agent Trust: trust records for known agents ---
  app.get("/api/v1/agent-trust/:motebitId", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const records = await moteDb.agentTrustStore.listAgentTrust(motebitId);
    return c.json({ motebit_id: motebitId, records });
  });

  // --- Graph Query: trust closure for an agent ---
  app.get("/api/v1/agents/:motebitId/trust-closure", (c) => {
    const motebitId = c.req.param("motebitId");
    const { profiles } = taskRouter.buildCandidateProfiles(undefined, undefined, 100, motebitId);
    const closure = computeTrustClosure(asMotebitId(motebitId), profiles);
    const closureArray = Array.from(closure.entries())
      .map(([agent_id, trust]) => ({ agent_id, trust }))
      .sort((a, b) => b.trust - a.trust);
    return c.json({ motebit_id: motebitId, closure: closureArray });
  });

  // --- Graph Query: find trusted path between two agents ---
  app.get("/api/v1/agents/:motebitId/path-to/:targetId", (c) => {
    const motebitId = c.req.param("motebitId");
    const targetId = c.req.param("targetId");
    const { profiles } = taskRouter.buildCandidateProfiles(undefined, undefined, 100, motebitId);
    const route = findTrustedRoute(asMotebitId(motebitId), asMotebitId(targetId), profiles);
    if (!route) {
      throw new HTTPException(404, { message: "No trusted path found" });
    }
    return c.json({ source: motebitId, target: targetId, trust: route.trust, path: route.path });
  });

  // --- Graph Query: full routing graph for an agent ---
  app.get("/api/v1/agents/:motebitId/graph", (c) => {
    const motebitId = c.req.param("motebitId");
    const { profiles } = taskRouter.buildCandidateProfiles(undefined, undefined, 100, motebitId);
    const graph = buildRoutingGraph(asMotebitId(motebitId), profiles);
    const nodes = [...graph.nodes()];
    const edges = graph.edges().map((e) => ({ from: e.from, to: e.to, weight: e.weight }));
    return c.json({
      motebit_id: motebitId,
      nodes,
      edges,
      node_count: nodes.length,
      edge_count: edges.length,
    });
  });

  // --- Graph Query: routing explanation with full scoring detail ---
  app.get("/api/v1/agents/:motebitId/routing-explanation", (c) => {
    const motebitId = c.req.param("motebitId");
    const capability = c.req.query("capability");
    const limitStr = c.req.query("limit");
    const limit = Math.min(Math.max(parseInt(limitStr ?? "10", 10) || 10, 1), 100);
    const { profiles, requirements } = taskRouter.buildCandidateProfiles(
      capability ?? undefined,
      undefined,
      limit,
      motebitId,
    );
    const peerEdges = taskRouter.fetchPeerEdges();
    const ranked = explainedRankCandidates(asMotebitId(motebitId), profiles, requirements, {
      peerEdges,
    });
    return c.json({ motebit_id: motebitId, scores: ranked });
  });

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

  // --- Gradient: intelligence gradient snapshots ---
  app.get("/api/v1/gradient/:motebitId", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
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
      interaction_efficiency: number;
      tool_efficiency: number;
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

  // --- Credentials: extracted to credentials.ts ---
  registerCredentialRoutes({
    db: moteDb.db,
    app,
    relayIdentity,
    identityManager,
    issueCredentials,
  });

  // --- State: current state vector ---
  app.get("/api/v1/state/:motebitId", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
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
  // Sensitivity-filtered: only None and Personal memories are returned by default.
  // Medical, Financial, and Secret memories never cross the relay boundary in cleartext.
  // Use ?sensitivity=all for admin diagnostic access (still requires auth).
  app.get("/api/v1/memory/:motebitId", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const sensitivityParam = c.req.query("sensitivity");
    const [allMemories, edges] = await Promise.all([
      moteDb.memoryStorage.getAllNodes(motebitId),
      moteDb.memoryStorage.getAllEdges(motebitId),
    ]);
    const DISPLAY_ALLOWED = new Set(["none", "personal"]);
    const memories =
      sensitivityParam === "all"
        ? allMemories
        : allMemories.filter((m) => DISPLAY_ALLOWED.has(m.sensitivity ?? "none"));
    const redacted = allMemories.length - memories.length;
    return c.json({ motebit_id: motebitId, memories, edges, redacted });
  });

  // --- Memory: tombstone a node (ownership-verified, branded IDs) ---
  app.delete("/api/v1/memory/:motebitId/:nodeId", async (c) => {
    const motebitId: MotebitId = asMotebitId(c.req.param("motebitId"));
    const nodeId: NodeId = asNodeId(c.req.param("nodeId"));
    try {
      const deleted =
        moteDb.memoryStorage.tombstoneNodeOwned != null
          ? await moteDb.memoryStorage.tombstoneNodeOwned(nodeId, motebitId)
          : (await moteDb.memoryStorage.tombstoneNode(nodeId), true);
      if (!deleted) {
        return c.json({ motebit_id: motebitId, node_id: nodeId, deleted: false }, 404);
      }
      return c.json({ motebit_id: motebitId, node_id: nodeId, deleted: true });
    } catch {
      return c.json({ motebit_id: motebitId, node_id: nodeId, deleted: false }, 404);
    }
  });

  // --- Goals: list all goals ---
  app.get("/api/v1/goals/:motebitId", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const goals = moteDb.goalStore.list(motebitId);
    return c.json({ motebit_id: motebitId, goals });
  });

  // --- Conversations: list all (from sync relay storage) ---
  app.get("/api/v1/conversations/:motebitId", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const conversations = moteDb.db
      .prepare(`SELECT * FROM sync_conversations WHERE motebit_id = ? ORDER BY last_active_at DESC`)
      .all(motebitId) as Array<Record<string, unknown>>;
    return c.json({ motebit_id: motebitId, conversations });
  });

  // --- Conversations: list messages for a conversation ---
  app.get("/api/v1/conversations/:motebitId/:conversationId/messages", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const conversationId = asConversationId(c.req.param("conversationId"));
    const messages = moteDb.db
      .prepare(
        `SELECT * FROM sync_conversation_messages WHERE conversation_id = ? AND motebit_id = ? ORDER BY created_at ASC`,
      )
      .all(conversationId, motebitId) as Array<Record<string, unknown>>;
    return c.json({ motebit_id: motebitId, conversation_id: conversationId, messages });
  });

  // --- Devices: list registered devices ---
  app.get("/api/v1/devices/:motebitId", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const devices = await identityManager.listDevices(motebitId);
    return c.json({ motebit_id: motebitId, devices });
  });

  // --- Events: alias under /api/v1 prefix (admin dashboard uses this path) ---
  app.get("/api/v1/sync/:motebitId/pull", async (c) => {
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

  // === Data Sync Routes (conversations, messages, plans, plan steps) ===
  registerDataSyncRoutes({ db: moteDb.db, app, connections });

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
    expectedAudience?: string,
  ): Promise<Response | void> {
    const authHeader = c.req.header("authorization");
    if (authHeader == null || !authHeader.startsWith("Bearer ")) {
      throw new HTTPException(401, { message: "Missing authorization" });
    }
    const token = authHeader.slice(7);

    // Master token bypass
    if (apiToken != null && apiToken !== "" && token === apiToken) {
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
  }

  // --- Task submission with scored routing ---

  app.post("/agent/:motebitId/task", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const body = await c.req.json<{
      prompt: string;
      submitted_by?: string;
      wall_clock_ms?: number;
      required_capabilities?: string[];
      step_id?: string;
      /** Optional: requesting agent's exploration drive [0-1] from intelligence gradient. */
      exploration_drive?: number;
      /** Optional: agent IDs to exclude from routing (failed on previous attempts). */
      exclude_agents?: string[];
    }>();

    if (!body.prompt || typeof body.prompt !== "string" || body.prompt.trim() === "") {
      throw new HTTPException(400, { message: "Missing or empty 'prompt' field" });
    }
    if (body.required_capabilities != null && !Array.isArray(body.required_capabilities)) {
      throw new HTTPException(400, {
        message: "required_capabilities must be an array of strings",
      });
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
      required_capabilities: Array.isArray(body.required_capabilities)
        ? (body.required_capabilities.filter(
            (c): c is string => typeof c === "string",
          ) as AgentTask["required_capabilities"])
        : undefined,
      step_id: body.step_id,
    };

    // Capture the submitter identity for receipt fan-out and settlement.
    // Prefer callerMotebitId (from dualAuth signed token) over body.submitted_by.
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    const submittedBy = callerMotebitId ?? body.submitted_by;

    // Snapshot the listing price at submission time so the settlement audit
    // matches what x402 actually charged. If the agent updates pricing between
    // submission and receipt delivery, the snapshot ensures consistency.
    const unitCostAtSubmission = getListingUnitCost(motebitId);
    const priceSnapshot =
      unitCostAtSubmission > 0
        ? unitCostAtSubmission / (1 - PLATFORM_FEE_RATE) // gross = what x402 charged (unit_cost + platform fee)
        : undefined;

    // Capture x402 payment proof from the settlement hook (set during middleware).
    // Read-and-clear so the next request starts fresh.
    const x402TxHash = lastSettleTxHash;
    const x402Net = lastSettleNetwork;
    lastSettleTxHash = undefined;
    lastSettleNetwork = undefined;

    taskQueue.set(taskId, {
      task,
      expiresAt: now + TASK_TTL_MS,
      submitted_by: submittedBy,
      price_snapshot: priceSnapshot,
      x402_tx_hash: x402TxHash,
      x402_network: x402Net,
    });

    logger.info("task.submitted", {
      correlationId: taskId,
      taskId,
      motebitId,
      capabilities: task.required_capabilities ?? [],
    });

    // Persist budget allocation so settlement can verify the lock exists.
    // Prevents overdraft: callers cannot submit unbounded tasks without a price lock.
    //
    // Virtual account path: if the delegator has a virtual account with sufficient
    // balance, debit it directly (allocation_hold). If insufficient AND no x402
    // payment was made AND the agent requires payment (has pay_to_address), return 402.
    // x402 payments auto-deposit to the delegator's account first, then proceed with
    // allocation hold. Agents without pay_to_address are "free" — their price snapshot
    // is recorded for auditing but payment is not enforced.
    if (priceSnapshot != null && priceSnapshot > 0) {
      // Determine whether this agent requires payment (has pay_to_address in listing)
      const agentPricing = getAgentPricing(motebitId);
      const requiresPayment = agentPricing != null;

      try {
        const delegatorId = submittedBy ?? motebitId;

        // If x402 payment was made, auto-deposit to delegator's virtual account
        if (x402TxHash) {
          moteDb.db.exec("BEGIN");
          try {
            creditAccount(
              moteDb.db,
              delegatorId,
              priceSnapshot,
              "deposit",
              `x402-${taskId}`,
              `x402 payment for task ${taskId}`,
            );
            moteDb.db.exec("COMMIT");
          } catch (depositErr) {
            moteDb.db.exec("ROLLBACK");
            throw new Error("x402 auto-deposit failed", { cause: depositErr });
          }
        }

        // Try to hold funds from virtual account
        const account = getAccountBalance(moteDb.db, delegatorId);
        const virtualBalance = account?.balance ?? 0;

        if (virtualBalance >= priceSnapshot) {
          // Sufficient virtual balance — create allocation hold
          moteDb.db.exec("BEGIN");
          try {
            debitAccount(
              moteDb.db,
              delegatorId,
              priceSnapshot,
              "allocation_hold",
              `x402-${taskId}`,
              `Hold for task ${taskId} to ${motebitId}`,
            );
            moteDb.db
              .prepare(
                "INSERT OR IGNORE INTO relay_allocations (allocation_id, task_id, motebit_id, amount_locked, status, created_at) VALUES (?, ?, ?, ?, 'locked', ?)",
              )
              .run(`x402-${taskId}`, taskId, motebitId, priceSnapshot, now);
            moteDb.db.exec("COMMIT");
          } catch (holdErr) {
            moteDb.db.exec("ROLLBACK");
            throw new Error("Allocation hold failed", { cause: holdErr });
          }
        } else if (requiresPayment && !x402TxHash) {
          // Paid agent, no virtual balance, no x402 payment — 402
          throw new HTTPException(402, {
            message: "Insufficient funds — deposit to virtual account or pay via x402",
          });
        } else {
          // Either free agent (best-effort allocation) or x402 deposited (balance should be sufficient).
          // Persist allocation record for settlement audit.
          moteDb.db
            .prepare(
              "INSERT OR IGNORE INTO relay_allocations (allocation_id, task_id, motebit_id, amount_locked, status, created_at) VALUES (?, ?, ?, ?, 'locked', ?)",
            )
            .run(`x402-${taskId}`, taskId, motebitId, priceSnapshot, now);
        }
      } catch (err) {
        // Re-throw intentional HTTP errors (402)
        if (err instanceof HTTPException) throw err;
        // Best-effort allocation — don't block task submission on accounting errors
      }
    }

    const requiredCaps = task.required_capabilities ?? [];
    const payload = JSON.stringify({ type: "task_request", task });
    let routed = false;
    let federationAttempted = false;
    let routingChoice:
      | {
          selected_agent: string;
          composite_score: number;
          sub_scores: Record<string, number>;
          routing_paths: string[][];
          alternatives_considered: number;
        }
      | undefined;

    // Phase 1: Scored routing — find best service agents from listings
    if (requiredCaps.length > 0) {
      try {
        const { profiles, requirements } = taskRouter.buildCandidateProfiles(
          requiredCaps[0],
          undefined,
          20,
          callerMotebitId,
        );
        // Narrow to candidates matching ALL required capabilities (not just the first)
        const multiCapProfiles =
          requiredCaps.length > 1
            ? profiles.filter((p) =>
                requiredCaps.every((cap) => p.listing?.capabilities.includes(cap)),
              )
            : profiles;

        // Filter out excluded agents (failed on previous delegation attempts)
        const excludeSet = new Set(
          Array.isArray(body.exclude_agents)
            ? body.exclude_agents.filter((a): a is string => typeof a === "string")
            : [],
        );
        const eligibleProfiles =
          excludeSet.size > 0
            ? multiCapProfiles.filter((p) => !excludeSet.has(p.motebit_id as string))
            : multiCapProfiles;

        // Phase 4: Fetch federated candidates from active peer relays (best-effort, non-blocking)
        let federatedCandidates: { profile: CandidateProfile; _source_relay_endpoint: string }[] =
          [];
        const remoteAgentRelay = new Map<string, string>(); // remote agent motebit_id → peer relay endpoint_url
        try {
          federatedCandidates = await taskRouter.fetchFederatedCandidates(
            requiredCaps,
            callerMotebitId,
          );
          for (const fc of federatedCandidates) {
            // Filter out excluded agents from federated results too
            if (!excludeSet.has(fc.profile.motebit_id as string)) {
              remoteAgentRelay.set(fc.profile.motebit_id as string, fc._source_relay_endpoint);
            }
          }
        } catch {
          // Federation candidate fetch is best-effort — don't block local routing
        }

        // Merge local and federated candidates before ranking
        const federatedProfiles = federatedCandidates
          .filter((fc) => !excludeSet.has(fc.profile.motebit_id as string))
          .map((fc) => fc.profile);
        const allProfiles = [...eligibleProfiles, ...federatedProfiles];

        if (allProfiles.length > 0) {
          // Apply gradient-informed precision to routing weights when provided
          const explorationWeight =
            typeof body.exploration_drive === "number"
              ? Math.max(0, Math.min(1, body.exploration_drive))
              : undefined;
          const peerEdges = taskRouter.fetchPeerEdges();
          const ranked = explainedRankCandidates(
            asMotebitId(callerMotebitId ?? motebitId),
            allProfiles,
            {
              ...requirements,
              required_capabilities: requiredCaps,
            },
            {
              maxCandidates: 10,
              explorationWeight,
              peerEdges,
            },
          );
          const selected = ranked.filter((r) => r.selected && r.composite > 0);

          if (selected.length > 0) {
            // Capture routing provenance from the top-ranked agent for the response
            const topScore = selected[0]!;
            routingChoice = {
              selected_agent: topScore.motebit_id as string,
              composite_score: topScore.composite,
              sub_scores: topScore.sub_scores,
              routing_paths: topScore.routing_paths,
              alternatives_considered: topScore.alternatives_considered,
            };

            // Route to selected agents — local via WebSocket, remote via federation forward
            for (const sel of selected) {
              const selId = sel.motebit_id as string;
              if (remoteAgentRelay.has(selId)) {
                // Remote agent: forward task to peer relay
                const peerEndpoint = remoteAgentRelay.get(selId)!;
                federationAttempted = true;
                try {
                  const forwardBody = {
                    task_id: taskId,
                    origin_relay: relayIdentity.relayMotebitId,
                    target_agent: selId,
                    task_payload: {
                      prompt: body.prompt,
                      required_capabilities: requiredCaps,
                      submitted_by: submittedBy,
                      wall_clock_ms: body.wall_clock_ms,
                    },
                    routing_choice: routingChoice,
                    timestamp: Date.now(),
                  };
                  const forwardBytes = new TextEncoder().encode(canonicalJson(forwardBody));
                  const forwardSig = await sign(forwardBytes, relayIdentity.privateKey);

                  const resp = await fetch(`${peerEndpoint}/federation/v1/task/forward`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "X-Correlation-ID": taskId },
                    body: JSON.stringify({
                      ...forwardBody,
                      signature: bytesToHex(forwardSig),
                    }),
                    signal: AbortSignal.timeout(10000),
                  });

                  if (resp.ok) {
                    routed = true;
                    taskRouter.recordPeerForwardResult(peerEndpoint, true);
                    logger.info("task.forwarded", {
                      correlationId: taskId,
                      peerRelay: peerEndpoint,
                      targetAgent: selId,
                    });
                  } else {
                    taskRouter.recordPeerForwardResult(peerEndpoint, false);
                  }
                } catch (fwdErr) {
                  // Federation forward failed or timed out. Do NOT fall through to local
                  // broadcast — the peer relay may have accepted the task before the timeout
                  // fired, and broadcasting locally would cause double-execution.
                  // The task stays in Pending; if the peer did accept, its receipt will
                  // arrive via federation/v1/task/result.
                  taskRouter.recordPeerForwardResult(peerEndpoint, false);
                  logger.warn("task.forward_failed", {
                    correlationId: taskId,
                    peerRelay: peerEndpoint,
                    targetAgent: selId,
                    error: fwdErr instanceof Error ? fwdErr.message : String(fwdErr),
                  });
                }
              } else {
                // Local agent: route via WebSocket first, HTTP MCP fallback
                const localPeers = connections.get(selId);
                if (localPeers && localPeers.length > 0) {
                  for (const peer of localPeers) {
                    peer.ws.send(payload);
                  }
                  routed = true;
                } else {
                  // No WebSocket — try HTTP MCP forwarding via registered endpoint_url
                  const regRow = moteDb.db
                    .prepare(
                      "SELECT endpoint_url FROM agent_registry WHERE motebit_id = ? AND expires_at > ?",
                    )
                    .get(selId, Date.now()) as { endpoint_url: string } | undefined;
                  if (regRow?.endpoint_url?.trim()) {
                    void forwardTaskViaMcp(
                      regRow.endpoint_url,
                      taskId,
                      body.prompt,
                      selId,
                      taskQueue as Map<string, { task: { status: string }; receipt?: unknown }>,
                      logger,
                      apiToken,
                      async (receiptCandidate: ReceiptCandidate) => {
                        const mcpEntry = taskQueue.get(taskId);
                        if (!mcpEntry || mcpEntry.settled) return;
                        await handleReceiptIngestion(
                          receiptCandidate as unknown as ExecutionReceipt,
                          taskId,
                          mcpEntry.task.motebit_id,
                          mcpEntry,
                        );
                      },
                    );
                    // Mark as delivery-attempted, not delivery-completed.
                    // The async MCP call may still be in flight.
                    routed = true;
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        // Re-throw intentional HTTP errors (e.g. 402 insufficient budget)
        if (err instanceof HTTPException) throw err;
        // Scoring failed — fall through to broadcast
      }
    }

    // Phase 2: Broadcast fallback — original behavior.
    // Skip if a federation forward was attempted (even if it timed out) — the peer relay
    // may have accepted the task, and broadcasting locally would cause double-execution.
    if (!routed && !federationAttempted) {
      const peers = connections.get(motebitId);
      if (peers) {
        for (const peer of peers) {
          if (requiredCaps.length > 0 && peer.capabilities) {
            const hasAll = requiredCaps.every((c) => peer.capabilities!.includes(c));
            if (!hasAll) continue;
          }
          peer.ws.send(payload);
          routed = true;
        }
      }
    }

    // Phase 3: HTTP MCP fallback — when no WebSocket routed the task,
    // find a registered agent with matching capabilities and forward via HTTP.
    if (!routed && !federationAttempted && requiredCaps.length > 0) {
      const now = Date.now();
      const capFilter = requiredCaps[0]!;
      const httpCandidate = moteDb.db
        .prepare(
          `SELECT r.motebit_id, r.endpoint_url FROM agent_registry r
           WHERE r.expires_at > ? AND r.endpoint_url != ''
             AND EXISTS (SELECT 1 FROM json_each(r.capabilities) WHERE value = ?)
           LIMIT 1`,
        )
        .get(now, capFilter) as { motebit_id: string; endpoint_url: string } | undefined;
      if (httpCandidate?.endpoint_url?.trim()) {
        void forwardTaskViaMcp(
          httpCandidate.endpoint_url,
          taskId,
          body.prompt,
          httpCandidate.motebit_id,
          taskQueue as Map<string, { task: { status: string }; receipt?: unknown }>,
          logger,
          apiToken,
          async (receiptCandidate: ReceiptCandidate) => {
            const mcpEntry = taskQueue.get(taskId);
            if (!mcpEntry || mcpEntry.settled) return;
            await handleReceiptIngestion(
              receiptCandidate as unknown as ExecutionReceipt,
              taskId,
              mcpEntry.task.motebit_id,
              mcpEntry,
            );
          },
        );
        routed = true;
      }
    }

    return c.json(
      { task_id: taskId, status: task.status, routing_choice: routingChoice ?? null },
      201,
    );
  });

  // GET /agent/:motebitId/task/:taskId — poll task status
  app.get("/agent/:motebitId/task/:taskId", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
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
        const verified = await verifySignedTokenForDevice(
          token,
          motebitId,
          identityManager,
          "task:query",
          isTokenBlacklisted,
          isAgentRevoked,
        );
        if (!verified) {
          throw new HTTPException(403, { message: "Device not authorized" });
        }
      } else {
        throw new HTTPException(403, { message: "Invalid authorization" });
      }
    }

    const entry = taskQueue.get(taskId);

    if (!entry) {
      throw new HTTPException(404, {
        message: `Task not found — it may have expired (TTL ${Math.round(TASK_TTL_MS / 60_000)}min) or the task_id is invalid`,
      });
    }
    if (entry.task.motebit_id !== motebitId) {
      throw new HTTPException(404, {
        message: "Task not found — motebit_id in URL does not match the task's target agent",
      });
    }

    return c.json({ task: entry.task, receipt: entry.receipt ?? null });
  });

  // POST /agent/:motebitId/task/:taskId/result — device posts signed receipt
  app.post("/agent/:motebitId/task/:taskId/result", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
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
        const verified = await verifySignedTokenForDevice(
          token,
          motebitId,
          identityManager,
          "task:result",
          isTokenBlacklisted,
          isAgentRevoked,
        );
        if (!verified) {
          throw new HTTPException(403, { message: "Device not authorized" });
        }
      } else {
        throw new HTTPException(403, { message: "Invalid authorization" });
      }
    }

    const entry = taskQueue.get(taskId);
    if (!entry) {
      throw new HTTPException(404, {
        message: `Task not found — it may have expired (TTL ${Math.round(TASK_TTL_MS / 60_000)}min) or the task_id is invalid`,
      });
    }
    if (entry.task.motebit_id !== motebitId) {
      throw new HTTPException(404, {
        message: "Task not found — motebit_id in URL does not match the task's target agent",
      });
    }

    const receipt = await c.req.json<ExecutionReceipt>();

    // Structural validation: require essential receipt fields
    const validStatuses = ["completed", "failed", "denied"];
    if (
      typeof receipt.task_id !== "string" ||
      receipt.task_id === "" ||
      typeof receipt.motebit_id !== "string" ||
      receipt.motebit_id === "" ||
      typeof receipt.signature !== "string" ||
      receipt.signature === "" ||
      typeof receipt.status !== "string" ||
      !validStatuses.includes(receipt.status)
    ) {
      throw new HTTPException(400, {
        message:
          "Invalid receipt: must include non-empty task_id, motebit_id, signature, and valid status",
      });
    }

    // Reject stale receipts — completed_at must be within 1 hour of submitted_at
    if (receipt.completed_at && entry.task.submitted_at) {
      const elapsed = receipt.completed_at - entry.task.submitted_at;
      if (elapsed > 3_600_000 || elapsed < -60_000) {
        // 1 hour max, 1 min clock skew tolerance
        throw new HTTPException(400, {
          message: `Receipt timestamp outside acceptable window (elapsed=${Math.round(elapsed / 1000)}s, allowed=-60s to +3600s) — check agent clock synchronization`,
        });
      }
    }

    // Task-receipt binding (dual invariant):
    // 1. Primary: relay_task_id — cryptographic binding to the economic identity of the task.
    //    The relay_task_id is included in the signed receipt, so tampering breaks the signature.
    // 2. Secondary: prompt_hash — semantic binding to the task content.
    //    Guards against prompt collision when relay_task_id is absent (legacy receipts).
    const receiptRelayTaskId = (receipt as unknown as Record<string, unknown>).relay_task_id;
    if (typeof receiptRelayTaskId === "string" && receiptRelayTaskId !== "") {
      if (receiptRelayTaskId !== taskId) {
        throw new HTTPException(400, {
          message: `Receipt relay_task_id "${receiptRelayTaskId}" does not match task "${taskId}" — receipt is bound to a different economic contract`,
        });
      }
    } else if (
      receipt.prompt_hash &&
      typeof receipt.prompt_hash === "string" &&
      entry.task.prompt
    ) {
      // Soft check: log mismatch but don't reject legacy receipts without relay_task_id.
      // relay_task_id is the hard binding; prompt_hash is observability-only for legacy callers.
      const expectedHash = await sha256Hash(new TextEncoder().encode(entry.task.prompt));
      if (receipt.prompt_hash !== expectedHash) {
        logger.warn("receipt.prompt_hash_mismatch", {
          correlationId: taskId,
          reason:
            "receipt prompt_hash does not match task prompt — relay_task_id binding not present",
        });
      }
    }

    // Update task status and store receipt before settlement
    entry.receipt = receipt;
    entry.expiresAt = Math.max(entry.expiresAt, Date.now() + TASK_TTL_MS);
    entry.task.status =
      receipt.status === "completed"
        ? AgentTaskStatus.Completed
        : receipt.status === "denied"
          ? AgentTaskStatus.Denied
          : AgentTaskStatus.Failed;

    // Unified receipt ingestion: Ed25519 verification → settlement → trust → credentials
    const ingestionResult = await handleReceiptIngestion(receipt, taskId, motebitId, entry);
    if (!ingestionResult.verified) {
      throw new HTTPException(403, {
        message: `Receipt verification failed: ${ingestionResult.reason}`,
      });
    }

    if (ingestionResult.already_settled) {
      return c.json({ status: "already_settled" });
    }
    return c.json({ status: entry.task.status, credential_id: ingestionResult.credential_id });
  });

  // GET /agent/:motebitId/settlements — settlement history for this agent
  app.get("/agent/:motebitId/settlements", (c) => {
    const mid = asMotebitId(c.req.param("motebitId"));
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);

    const settlements = moteDb.db
      .prepare(
        `SELECT * FROM relay_settlements
         WHERE motebit_id = ?
         ORDER BY settled_at DESC
         LIMIT ?`,
      )
      .all(mid, limit) as Array<Record<string, unknown>>;

    const totals = moteDb.db
      .prepare(
        `SELECT
           COALESCE(SUM(amount_settled), 0) AS total_settled,
           COALESCE(SUM(platform_fee), 0) AS total_platform_fees,
           COUNT(*) AS settlement_count
         FROM relay_settlements
         WHERE motebit_id = ?`,
      )
      .get(mid) as { total_settled: number; total_platform_fees: number; settlement_count: number };

    return c.json({
      motebit_id: mid,
      summary: totals,
      settlements,
    });
  });

  // --- Virtual Account Endpoints ---

  // POST /api/v1/agents/:motebitId/deposit — credit virtual account
  app.post("/api/v1/agents/:motebitId/deposit", async (c) => {
    const motebitId = c.req.param("motebitId");
    const correlationId = c.get("correlationId" as never) as string;
    const body = await c.req.json<{
      amount: number;
      currency?: string;
      reference?: string;
      description?: string;
    }>();

    if (typeof body.amount !== "number" || body.amount <= 0) {
      throw new HTTPException(400, { message: "amount must be a positive number" });
    }

    // Idempotency: if a reference is provided and already used, return current balance
    if (body.reference) {
      if (hasTransactionWithReference(moteDb.db, motebitId, body.reference)) {
        const account = getOrCreateAccount(moteDb.db, motebitId);
        logger.info("account.deposit_idempotent", {
          correlationId,
          motebitId,
          reference: body.reference,
        });
        return c.json({
          motebit_id: motebitId,
          balance: account.balance,
          transaction_id: null,
          idempotent: true,
        });
      }
    }

    // Atomic deposit: credit + transaction in a single SQLite transaction
    let newBalance: number;
    const txnId = crypto.randomUUID();
    moteDb.db.exec("BEGIN");
    try {
      const account = getOrCreateAccount(moteDb.db, motebitId);
      newBalance = account.balance + body.amount;
      const now = Date.now();

      moteDb.db
        .prepare("UPDATE relay_accounts SET balance = ?, updated_at = ? WHERE motebit_id = ?")
        .run(newBalance, now, motebitId);

      moteDb.db
        .prepare(
          `INSERT INTO relay_transactions (transaction_id, motebit_id, type, amount, balance_after, reference_id, description, created_at)
           VALUES (?, ?, 'deposit', ?, ?, ?, ?, ?)`,
        )
        .run(
          txnId,
          motebitId,
          body.amount,
          newBalance,
          body.reference ?? null,
          body.description ?? null,
          now,
        );

      moteDb.db.exec("COMMIT");
    } catch (err) {
      moteDb.db.exec("ROLLBACK");
      throw new Error("Deposit failed", { cause: err });
    }

    logger.info("account.deposit", {
      correlationId,
      motebitId,
      amount: body.amount,
      balanceAfter: newBalance,
      reference: body.reference ?? null,
    });

    return c.json({
      motebit_id: motebitId,
      balance: newBalance,
      transaction_id: txnId,
    });
  });

  // GET /api/v1/agents/:motebitId/balance — query virtual account balance + recent transactions
  // Returns balance breakdown: balance (current), pending_withdrawals, pending_allocations
  app.get("/api/v1/agents/:motebitId/balance", (c) => {
    const motebitId = c.req.param("motebitId");
    const account = getAccountBalance(moteDb.db, motebitId);

    if (!account) {
      return c.json({
        motebit_id: motebitId,
        balance: 0,
        currency: "USD",
        pending_withdrawals: 0,
        pending_allocations: 0,
        transactions: [],
      });
    }

    const detailed = getAccountBalanceDetailed(moteDb.db, motebitId);
    const transactions = getTransactions(moteDb.db, motebitId, 50);

    return c.json({
      motebit_id: motebitId,
      balance: detailed.balance,
      currency: detailed.currency,
      pending_withdrawals: detailed.pending_withdrawals,
      pending_allocations: detailed.pending_allocations,
      transactions,
    });
  });

  // POST /api/v1/agents/:motebitId/withdraw — request withdrawal from virtual account
  // POST /api/v1/agents/:motebitId/withdraw — request withdrawal from virtual account
  // Supports idempotency via Idempotency-Key header or body.idempotency_key
  app.post("/api/v1/agents/:motebitId/withdraw", async (c) => {
    const motebitId = c.req.param("motebitId");
    const correlationId = c.get("correlationId" as never) as string;
    const body = await c.req.json<{
      amount: number;
      destination?: string;
      idempotency_key?: string;
    }>();

    if (typeof body.amount !== "number" || body.amount <= 0) {
      throw new HTTPException(400, { message: "amount must be a positive number" });
    }

    const idempotencyKey = body.idempotency_key ?? c.req.header("Idempotency-Key") ?? undefined;

    const result = requestWithdrawal(
      moteDb.db,
      motebitId,
      body.amount,
      body.destination ?? "pending",
      idempotencyKey,
    );

    if (result === null) {
      throw new HTTPException(402, { message: "Insufficient balance for withdrawal" });
    }

    // Idempotent replay — return existing withdrawal
    if ("existing" in result) {
      logger.info("withdrawal.endpoint.idempotent", {
        correlationId,
        motebitId,
        withdrawalId: result.existing.withdrawal_id,
        idempotencyKey,
      });
      return c.json({
        motebit_id: motebitId,
        withdrawal: result.existing,
        idempotent: true,
      });
    }

    logger.info("withdrawal.endpoint.requested", {
      correlationId,
      motebitId,
      withdrawalId: result.withdrawal_id,
      amount: body.amount,
      destination: result.destination,
      idempotencyKey: idempotencyKey ?? null,
    });

    return c.json({
      motebit_id: motebitId,
      withdrawal: result,
    });
  });

  // GET /api/v1/agents/:motebitId/withdrawals — list withdrawal history
  app.get("/api/v1/agents/:motebitId/withdrawals", (c) => {
    const motebitId = c.req.param("motebitId");
    const withdrawals = getWithdrawals(moteDb.db, motebitId, 50);
    return c.json({ motebit_id: motebitId, withdrawals });
  });

  // GET /api/v1/admin/withdrawals/pending — list all pending withdrawals (admin)
  app.get("/api/v1/admin/withdrawals/pending", (c) => {
    const withdrawals = getPendingWithdrawals(moteDb.db);
    return c.json({ withdrawals, count: withdrawals.length });
  });

  // POST /api/v1/admin/withdrawals/:withdrawalId/complete — mark withdrawal as completed (admin)
  // Signs a WithdrawalReceipt with the relay's Ed25519 key for independent verification.
  app.post("/api/v1/admin/withdrawals/:withdrawalId/complete", async (c) => {
    const withdrawalId = c.req.param("withdrawalId");
    const correlationId = c.get("correlationId" as never) as string;
    const body = await c.req.json<{ payout_reference: string }>();

    if (!body.payout_reference || typeof body.payout_reference !== "string") {
      throw new HTTPException(400, { message: "payout_reference is required" });
    }

    // Look up the withdrawal to get fields for signing
    const withdrawal = moteDb.db
      .prepare(
        "SELECT * FROM relay_withdrawals WHERE withdrawal_id = ? AND status IN ('pending', 'processing')",
      )
      .get(withdrawalId) as
      | { motebit_id: string; amount: number; currency: string; destination: string }
      | undefined;
    if (!withdrawal) {
      throw new HTTPException(404, {
        message: "Withdrawal not found or already completed/failed",
      });
    }

    // Sign the withdrawal receipt with the relay's Ed25519 key
    const completedAt = Date.now();
    const relayPublicKeyHex = bytesToHex(relayIdentity.publicKey);
    const signature = await signWithdrawalReceipt(
      {
        withdrawal_id: withdrawalId,
        motebit_id: withdrawal.motebit_id,
        amount: withdrawal.amount,
        currency: withdrawal.currency,
        destination: withdrawal.destination,
        payout_reference: body.payout_reference,
        completed_at: completedAt,
        relay_id: relayIdentity.relayMotebitId,
      },
      relayIdentity.privateKey,
    );

    const success = completeWithdrawal(
      moteDb.db,
      withdrawalId,
      body.payout_reference,
      signature,
      relayPublicKeyHex,
      completedAt,
    );
    if (!success) {
      throw new HTTPException(404, {
        message: "Withdrawal not found or already completed/failed",
      });
    }

    logger.info("withdrawal.admin.completed", {
      correlationId,
      withdrawalId,
      payoutReference: body.payout_reference,
      signed: true,
    });

    return c.json({
      withdrawal_id: withdrawalId,
      status: "completed",
      relay_signature: signature,
      relay_public_key: relayPublicKeyHex,
    });
  });

  // POST /api/v1/admin/withdrawals/:withdrawalId/fail — mark withdrawal as failed and refund (admin)
  app.post("/api/v1/admin/withdrawals/:withdrawalId/fail", async (c) => {
    const withdrawalId = c.req.param("withdrawalId");
    const correlationId = c.get("correlationId" as never) as string;
    const body = await c.req.json<{ reason: string }>();

    if (!body.reason || typeof body.reason !== "string") {
      throw new HTTPException(400, { message: "reason is required" });
    }

    const success = failWithdrawal(moteDb.db, withdrawalId, body.reason);
    if (!success) {
      throw new HTTPException(404, {
        message: "Withdrawal not found or already completed/failed",
      });
    }

    logger.info("withdrawal.admin.failed", {
      correlationId,
      withdrawalId,
      reason: body.reason,
    });

    return c.json({ withdrawal_id: withdrawalId, status: "failed", refunded: true });
  });

  // GET /api/v1/admin/reconciliation — verify ledger consistency (admin, expensive)
  app.get("/api/v1/admin/reconciliation", (c) => {
    const correlationId = c.get("correlationId" as never) as string;
    const result = reconcileLedger(moteDb.db);

    logger.info("admin.reconciliation", {
      correlationId,
      consistent: result.consistent,
      errorCount: result.errors.length,
    });

    return c.json(result);
  });

  // --- Stripe Checkout Endpoints ---

  // POST /api/v1/agents/:motebitId/checkout — create a Stripe Checkout Session for deposit
  app.post("/api/v1/agents/:motebitId/checkout", async (c) => {
    if (!stripeClient || !stripeConfig) {
      throw new HTTPException(501, { message: "Stripe is not configured on this relay" });
    }

    const motebitId = c.req.param("motebitId");
    const correlationId = c.get("correlationId" as never) as string;
    const body = await c.req.json<{ amount: number }>();

    if (typeof body.amount !== "number" || body.amount <= 0) {
      throw new HTTPException(400, { message: "amount must be a positive number (in dollars)" });
    }

    // Stripe minimum is $0.50
    if (body.amount < 0.5) {
      throw new HTTPException(400, { message: "Minimum deposit amount is $0.50" });
    }

    const baseUrl = new URL(c.req.url);
    const successUrl = `${baseUrl.origin}/api/v1/agents/${motebitId}/balance`;
    const cancelUrl = `${baseUrl.origin}/api/v1/agents/${motebitId}/balance`;

    const session = await stripeClient.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: stripeConfig.currency ?? "usd",
            product_data: {
              name: `Motebit Agent Deposit (${motebitId.slice(0, 8)}...)`,
            },
            unit_amount: Math.round(body.amount * 100), // cents
          },
          quantity: 1,
        },
      ],
      metadata: { motebit_id: motebitId, amount: String(body.amount) },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    logger.info("stripe.checkout.created", {
      correlationId,
      motebitId,
      sessionId: session.id,
      amount: body.amount,
    });

    return c.json({ checkout_url: session.url, session_id: session.id });
  });

  // POST /api/v1/stripe/webhook — handle Stripe webhook events (no auth — verified via signature)
  app.post("/api/v1/stripe/webhook", async (c) => {
    if (!stripeClient || !stripeConfig) {
      throw new HTTPException(501, { message: "Stripe is not configured on this relay" });
    }

    const sig = c.req.header("stripe-signature");
    if (!sig) {
      throw new HTTPException(400, { message: "Missing stripe-signature header" });
    }

    const rawBody = await c.req.text();
    let event: Stripe.Event;
    try {
      event = stripeClient.webhooks.constructEvent(rawBody, sig, stripeConfig.webhookSecret);
    } catch (err) {
      logger.info("stripe.webhook.signature_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw new HTTPException(400, { message: "Invalid webhook signature" });
    }

    logger.info("stripe.webhook.received", { type: event.type, id: event.id });

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const motebitId = session.metadata?.motebit_id;
      const amount = session.metadata?.amount ? parseFloat(session.metadata.amount) : 0;

      if (!motebitId || !amount || amount <= 0) {
        logger.info("stripe.webhook.invalid_metadata", {
          eventId: event.id,
          metadata: session.metadata,
        });
        return c.json({ received: true });
      }

      const paymentIntent =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id;

      const applied = processStripeCheckout(
        moteDb.db,
        session.id,
        motebitId,
        amount,
        paymentIntent ?? undefined,
      );

      logger.info("stripe.webhook.processed", {
        eventId: event.id,
        sessionId: session.id,
        motebitId,
        amount,
        applied,
      });
    }

    return c.json({ received: true });
  });

  // GET /agent/:motebitId/capabilities — public (no auth)
  app.get("/agent/:motebitId/capabilities", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
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

    let did: string | undefined;
    try {
      if (publicKey) did = hexPublicKeyToDidKey(publicKey);
    } catch {
      // Non-fatal — public key may be invalid hex
    }

    return c.json({
      motebit_id: motebitId,
      public_key: publicKey,
      did,
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
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const receipt = await c.req.json<ExecutionReceipt>();

    if (receipt.motebit_id !== motebitId) {
      return c.json({ valid: false, reason: "motebit_id mismatch" });
    }

    // Resolve public key: agent_registry (service agents) > device records (personal agents)
    let pubKeyHex: string | undefined;
    const regRow = moteDb.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(motebitId as string) as { public_key: string } | undefined;
    if (regRow?.public_key) {
      pubKeyHex = regRow.public_key;
    } else {
      const devices = await identityManager.listDevices(motebitId);
      const device =
        (receipt.device_id != null
          ? devices.find((d) => d.device_id === receipt.device_id)
          : undefined) ?? devices.find((d) => d.public_key);
      if (device?.public_key) pubKeyHex = device.public_key;
    }

    if (!pubKeyHex) {
      return c.json({ valid: false, reason: "No public key on file for this agent" });
    }

    const pubKeyBytes = hexToBytes(pubKeyHex);
    const valid = await verifyExecutionReceipt(receipt, pubKeyBytes);
    return c.json({ valid });
  });

  // === Execution Ledger: submit and retrieve signed manifests ===

  // POST /agent/:motebitId/ledger — submit a signed execution ledger
  app.post("/agent/:motebitId/ledger", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    let body: Record<string, unknown>;
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON body" });
    }

    // Validate required fields from the execution ledger spec
    if (body.spec !== "motebit/execution-ledger@1.0") {
      throw new HTTPException(400, {
        message: "Invalid spec: must be motebit/execution-ledger@1.0",
      });
    }
    if (body.motebit_id !== motebitId) {
      throw new HTTPException(400, { message: "motebit_id in body does not match URL" });
    }
    if (typeof body.goal_id !== "string" || body.goal_id === "") {
      throw new HTTPException(400, { message: "Missing or invalid goal_id" });
    }
    if (typeof body.content_hash !== "string" || body.content_hash === "") {
      throw new HTTPException(400, { message: "Missing or invalid content_hash" });
    }

    const ledgerId = crypto.randomUUID();
    const now = Date.now();
    const goalId = body.goal_id;
    const planId = typeof body.plan_id === "string" ? body.plan_id : null;
    const contentHash = body.content_hash;

    moteDb.db
      .prepare(
        `INSERT OR REPLACE INTO relay_execution_ledgers
         (ledger_id, motebit_id, goal_id, plan_id, manifest_json, content_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ledgerId, motebitId, goalId, planId, JSON.stringify(body), contentHash, now);

    return c.json({ ledger_id: ledgerId, content_hash: contentHash, created_at: now }, 201);
  });

  // GET /agent/:motebitId/ledger/:goalId — retrieve signed execution ledger
  app.get("/agent/:motebitId/ledger/:goalId", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const goalId = c.req.param("goalId");

    const row = moteDb.db
      .prepare(
        `SELECT manifest_json FROM relay_execution_ledgers WHERE motebit_id = ? AND goal_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(motebitId, goalId) as { manifest_json: string } | undefined;

    if (!row) {
      throw new HTTPException(404, { message: "No execution ledger found for this goal" });
    }

    return c.json(JSON.parse(row.manifest_json) as Record<string, unknown>);
  });

  // === Agent Discovery Registry ===

  // Auth middleware for agent registry routes
  app.use("/api/v1/agents/*", async (c, next) => {
    // Bootstrap is unauthenticated — handled by its own rate limiter
    if (c.req.path === "/api/v1/agents/bootstrap") {
      await next();
      return;
    }

    // Succession chain is publicly readable — any third party can verify key lineage
    if (c.req.path.endsWith("/succession") && c.req.method === "GET") {
      await next();
      return;
    }

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

    // Determine expected audience from route path
    const path = c.req.path;
    let agentAudience: string;
    if (path.includes("/listing")) {
      agentAudience = "market:listing";
    } else if (path.includes("/credentials")) {
      agentAudience = "credentials";
    } else if (path.includes("/presentation")) {
      agentAudience = "credentials:present";
    } else {
      // register, heartbeat, deregister, discover, agent info
      agentAudience = "admin:query";
    }

    const valid = await verifySignedTokenForDevice(
      token,
      claims.mid,
      identityManager,
      agentAudience,
      isTokenBlacklisted,
      isAgentRevoked,
    );
    if (!valid) {
      throw new HTTPException(401, { message: "Token verification failed" });
    }

    // Store caller identity for route handlers
    c.set("callerMotebitId" as never, claims.mid as never);
    await next();
  });

  // POST /api/v1/agents/bootstrap — unauthenticated (rate-limited) one-call identity + device registration
  // Allows a CLI motebit to register with the relay without a master token.
  // Idempotent for same motebit_id + same public_key. Rejects attempts to re-register with a different key.
  app.post("/api/v1/agents/bootstrap", async (c) => {
    const body = await c.req.json<{
      motebit_id: string;
      device_id?: string;
      public_key: string;
    }>();

    if (!body.motebit_id || typeof body.motebit_id !== "string" || body.motebit_id.trim() === "") {
      throw new HTTPException(400, { message: "Missing or empty 'motebit_id' field" });
    }
    if (!body.public_key || typeof body.public_key !== "string") {
      throw new HTTPException(400, { message: "Missing 'public_key' field" });
    }
    if (!/^[0-9a-f]{64}$/i.test(body.public_key)) {
      throw new HTTPException(400, {
        message: "Invalid 'public_key' — must be 64-char hex string (32 bytes Ed25519 public key)",
      });
    }

    const motebitId = body.motebit_id.trim();

    // Check if identity already exists
    const existing = await identityManager.load(motebitId);
    if (existing) {
      // Identity exists — check for public key conflict (hijack prevention)
      const devices = await identityManager.listDevices(motebitId);
      const existingKey = devices.find((d) => d.public_key)?.public_key;
      if (existingKey && existingKey.toLowerCase() !== body.public_key.toLowerCase()) {
        throw new HTTPException(409, {
          message:
            "Identity already registered with a different public key — re-registration rejected",
        });
      }
      // Same key (or no key yet) — idempotent: register/refresh device and return
      const device = await identityManager.registerDevice(
        motebitId,
        body.device_id ?? "bootstrap-device",
        body.public_key,
      );
      return c.json(
        {
          motebit_id: motebitId,
          device_id: device.device_id,
          registered: false, // identity already existed
        },
        200,
      );
    }

    // New identity — save directly with the caller-provided motebit_id (self-sovereign: no server-assigned UUID)
    await moteDb.identityStorage.save({
      motebit_id: motebitId,
      owner_id: motebitId, // Self-sovereign: the agent is its own owner
      created_at: Date.now(),
      version_clock: 0,
    });
    const device = await identityManager.registerDevice(
      motebitId,
      body.device_id ?? "bootstrap-device",
      body.public_key,
    );

    return c.json(
      {
        motebit_id: motebitId,
        device_id: device.device_id,
        registered: true,
      },
      201,
    );
  });

  // Auth middleware for proposal routes
  app.use("/api/v1/proposals/*", async (c, next) => {
    const authHeader = c.req.header("authorization");
    if (authHeader == null || !authHeader.startsWith("Bearer ")) {
      throw new HTTPException(401, { message: "Missing auth token" });
    }
    const token = authHeader.slice(7);

    if (apiToken != null && apiToken !== "" && token === apiToken) {
      await next();
      return;
    }

    const claims = parseTokenPayloadUnsafe(token);
    if (!claims?.mid) {
      throw new HTTPException(401, { message: "Invalid token" });
    }
    const valid = await verifySignedTokenForDevice(
      token,
      claims.mid,
      identityManager,
      "proposal",
      isTokenBlacklisted,
      isAgentRevoked,
    );
    if (!valid) {
      throw new HTTPException(401, { message: "Token verification failed" });
    }

    c.set("callerMotebitId" as never, claims.mid as never);
    await next();
  });

  app.use("/api/v1/proposals", async (c, next) => {
    const authHeader = c.req.header("authorization");
    if (authHeader == null || !authHeader.startsWith("Bearer ")) {
      throw new HTTPException(401, { message: "Missing auth token" });
    }
    const token = authHeader.slice(7);

    if (apiToken != null && apiToken !== "" && token === apiToken) {
      await next();
      return;
    }

    const claims = parseTokenPayloadUnsafe(token);
    if (!claims?.mid) {
      throw new HTTPException(401, { message: "Invalid token" });
    }
    const valid = await verifySignedTokenForDevice(
      token,
      claims.mid,
      identityManager,
      "proposal",
      isTokenBlacklisted,
      isAgentRevoked,
    );
    if (!valid) {
      throw new HTTPException(401, { message: "Token verification failed" });
    }

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
      public_key?: string;
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

    // Resolve public key: request body > device records > empty
    let publicKey = "";
    if (
      body.public_key &&
      typeof body.public_key === "string" &&
      /^[0-9a-f]{64}$/i.test(body.public_key)
    ) {
      publicKey = body.public_key;
    } else {
      const devices = await identityManager.listDevices(motebitId);
      const deviceWithKey = devices.find((d) => d.public_key);
      publicKey = deviceWithKey ? deviceWithKey.public_key : "";
    }

    // --- Succession chain validation on re-registration ---
    // If the agent already has a stored public key and the new key differs,
    // require a valid succession record proving key lineage.
    const existingAgent = moteDb.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(motebitId) as { public_key: string } | undefined;

    if (
      existingAgent &&
      existingAgent.public_key &&
      publicKey &&
      existingAgent.public_key !== publicKey
    ) {
      const succession = (body as Record<string, unknown>).succession as
        | KeySuccessionRecord
        | undefined;
      if (!succession) {
        throw new HTTPException(400, {
          message: "Public key differs from stored key — succession record required",
        });
      }

      // Verify the succession record signatures
      const successionValid = await verifyKeySuccession(succession);
      if (!successionValid) {
        throw new HTTPException(400, { message: "Invalid key succession signatures" });
      }

      // Verify the old key in the succession record matches the stored key
      if (succession.old_public_key !== existingAgent.public_key) {
        throw new HTTPException(400, {
          message: "Succession old_public_key does not match stored public key",
        });
      }

      // Verify the new key in the succession record matches the registering key
      if (succession.new_public_key !== publicKey) {
        throw new HTTPException(400, {
          message: "Succession new_public_key does not match registering public key",
        });
      }

      // Store the succession record for chain auditability
      moteDb.db
        .prepare(
          `INSERT INTO relay_key_successions (motebit_id, old_public_key, new_public_key, timestamp, reason, old_key_signature, new_key_signature)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          motebitId,
          succession.old_public_key,
          succession.new_public_key,
          succession.timestamp,
          succession.reason ?? null,
          succession.old_key_signature,
          succession.new_key_signature,
        );

      logger.info("agent.key.succession_on_register", {
        motebitId,
        oldKey: existingAgent.public_key.slice(0, 16) + "...",
        newKey: publicKey.slice(0, 16) + "...",
      });

      // Emit key rotation event for federation propagation
      try {
        await insertRevocationEvent(moteDb.db, relayIdentity, "key_rotated", motebitId, {
          newPublicKey: publicKey,
        });
      } catch {
        /* best-effort */
      }
    }

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

    // Auto-create a default service listing if one doesn't exist.
    // Registration populates agent_registry (for discovery); routing reads from
    // relay_service_listings. Without this, registered agents are discoverable
    // but never routed to — the scored routing loop finds zero candidates.
    if (body.capabilities.length > 0) {
      const existingListing = moteDb.db
        .prepare("SELECT listing_id FROM relay_service_listings WHERE motebit_id = ?")
        .get(motebitId) as { listing_id: string } | undefined;
      if (!existingListing) {
        const listingId = `ls-${crypto.randomUUID()}`;
        moteDb.db
          .prepare(
            `INSERT INTO relay_service_listings
             (listing_id, motebit_id, capabilities, pricing, sla_max_latency_ms, sla_availability, description, updated_at)
             VALUES (?, ?, ?, '[]', 30000, 0.95, ?, ?)`,
          )
          .run(
            listingId,
            motebitId,
            JSON.stringify(body.capabilities),
            body.metadata?.name ?? body.capabilities.join(", "),
            now,
          );
      }
    }

    return c.json({ registered: true, motebit_id: motebitId, expires_at: expiresAt });
  });

  // POST /api/v1/agents/heartbeat — refresh TTL
  app.post("/api/v1/agents/heartbeat", async (c) => {
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    // Fall back to body.motebit_id for master-token callers (services use API token, not signed tokens)
    let motebitId = callerMotebitId;
    if (!motebitId) {
      try {
        const body = await c.req.json<{ motebit_id?: string }>();
        motebitId = body.motebit_id;
      } catch {
        // No body — that's fine if callerMotebitId was set
      }
    }
    if (!motebitId) {
      throw new HTTPException(400, { message: "Cannot determine motebit_id from token or body" });
    }

    const now = Date.now();
    const expiresAt = now + 15 * 60 * 1000;

    const result = moteDb.db
      .prepare(
        `
      UPDATE agent_registry SET last_heartbeat = ?, expires_at = ? WHERE motebit_id = ?
    `,
      )
      .run(now, expiresAt, motebitId);

    if (result.changes === 0) {
      throw new HTTPException(404, { message: "Agent not registered" });
    }

    return c.json({ ok: true });
  });

  // GET /api/v1/agents/discover — find agents (with optional federation forwarding)
  app.get("/api/v1/agents/discover", async (c) => {
    const capability = c.req.query("capability");
    const motebitId = c.req.query("motebit_id");
    const limitParam = Number(c.req.query("limit") ?? "20");
    const limit = Math.min(Math.max(1, limitParam), 100);

    // Local results (existing behavior, unchanged)
    const localAgents = taskRouter.queryLocalAgents(
      capability ?? undefined,
      motebitId ?? undefined,
      limit,
    );

    // Add source_relay metadata to local results
    const localResults = localAgents.map((a) => ({
      ...a,
      source_relay: relayIdentity.relayMotebitId,
      relay_name: federationConfig?.displayName ?? null,
      hop_distance: 0,
    }));

    // Check for active peers — if none, return local only (backward compatible)
    const activePeerCount = (
      moteDb.db.prepare("SELECT COUNT(*) as cnt FROM relay_peers WHERE state = 'active'").get() as {
        cnt: number;
      }
    ).cnt;

    if (activePeerCount === 0) {
      return c.json({ agents: localResults });
    }

    // Forward to active peers
    const queryId = crypto.randomUUID();
    federationQueryCache.set(queryId, Date.now());
    const visited = [relayIdentity.relayMotebitId];

    const peers = moteDb.db
      .prepare("SELECT peer_relay_id, endpoint_url FROM relay_peers WHERE state = 'active'")
      .all() as Array<{ peer_relay_id: string; endpoint_url: string }>;

    const forwardPromises = peers.map(async (peer) => {
      try {
        const resp = await fetch(`${peer.endpoint_url}/federation/v1/discover`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Correlation-ID": queryId },
          body: JSON.stringify({
            query: { capability, motebit_id: motebitId, limit },
            hop_count: 0,
            max_hops: 3,
            visited,
            query_id: queryId,
            origin_relay: relayIdentity.relayMotebitId,
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return [];
        const data = (await resp.json()) as { agents: Array<Record<string, unknown>> };
        return data.agents ?? [];
      } catch {
        return [];
      }
    });

    const peerResults = (await Promise.allSettled(forwardPromises))
      .filter(
        (r): r is PromiseFulfilledResult<Array<Record<string, unknown>>> =>
          r.status === "fulfilled",
      )
      .flatMap((r) => r.value);

    // Merge: dedup by motebit_id, prefer lowest hop_distance
    const merged = new Map<string, Record<string, unknown>>();
    for (const agent of [...localResults, ...peerResults]) {
      const id = agent.motebit_id as string;
      const existing = merged.get(id);
      if (!existing || (agent.hop_distance as number) < (existing.hop_distance as number)) {
        merged.set(id, agent);
      }
    }

    // Trim to limit
    const final = [...merged.values()].slice(0, limit);
    return c.json({ agents: final });
  });

  // Phase 3-5 endpoints (discover, task/forward, task/result, settlement) are now
  // registered by registerFederationRoutes above via callbacks.

  // Heartbeat sender — probes active/suspended peers every 60s.
  // Suspends at 3 missed, removes at 5.
  const heartbeatInterval = startHeartbeatLoop(moteDb.db, relayIdentity);

  // Settlement retry loop — retries failed settlement forwards every 30s with exponential backoff.
  const settlementRetryInterval = startSettlementRetryLoop(moteDb.db, relayIdentity);

  // GET /api/v1/agents/:motebitId — get specific agent
  app.get("/api/v1/agents/:motebitId", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
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
      // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- DB row field is untyped
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

  // POST /api/v1/agents/:motebitId/rotate-key — submit a key succession record
  app.post("/api/v1/agents/:motebitId/rotate-key", async (c) => {
    const motebitId = c.req.param("motebitId");

    const body = await c.req.json<KeySuccessionRecord>();

    // Validate required fields
    if (
      !body.old_public_key ||
      !body.new_public_key ||
      !body.timestamp ||
      !body.old_key_signature ||
      !body.new_key_signature
    ) {
      throw new HTTPException(400, { message: "Missing required fields in key succession record" });
    }

    // Verify both signatures
    const valid = await verifyKeySuccession(body);
    if (!valid) {
      throw new HTTPException(400, { message: "Invalid key succession signatures" });
    }

    // Verify old_public_key matches the stored key in agent_registry (if registered)
    const storedAgent = moteDb.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(motebitId) as { public_key: string } | undefined;

    if (storedAgent && storedAgent.public_key && storedAgent.public_key !== body.old_public_key) {
      throw new HTTPException(400, {
        message: "Succession old_public_key does not match stored public key",
      });
    }

    // Store the succession record
    moteDb.db
      .prepare(
        `INSERT INTO relay_key_successions (motebit_id, old_public_key, new_public_key, timestamp, reason, old_key_signature, new_key_signature)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        motebitId,
        body.old_public_key,
        body.new_public_key,
        body.timestamp,
        body.reason ?? null,
        body.old_key_signature,
        body.new_key_signature,
      );

    // Update the agent registry's public key if the agent is registered
    moteDb.db
      .prepare(`UPDATE agent_registry SET public_key = ? WHERE motebit_id = ?`)
      .run(body.new_public_key, motebitId);

    return c.json({ ok: true, motebit_id: motebitId });
  });

  // GET /api/v1/agents/:motebitId/succession — query full key succession chain
  app.get("/api/v1/agents/:motebitId/succession", (c) => {
    const motebitId = c.req.param("motebitId");
    const correlationId = c.req.header("x-correlation-id") ?? crypto.randomUUID();

    // Retrieve the full succession chain ordered by timestamp
    const chain = moteDb.db
      .prepare(
        `SELECT old_public_key, new_public_key, timestamp, reason, old_key_signature, new_key_signature
         FROM relay_key_successions
         WHERE motebit_id = ?
         ORDER BY timestamp ASC`,
      )
      .all(motebitId) as Array<{
      old_public_key: string;
      new_public_key: string;
      timestamp: number;
      reason: string | null;
      old_key_signature: string;
      new_key_signature: string;
    }>;

    // Look up the current public key from agent_registry
    const agent = moteDb.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(motebitId) as { public_key: string } | undefined;

    logger.info("agent.succession.query", {
      correlationId,
      motebitId,
      chainLength: chain.length,
    });

    return c.json({
      motebit_id: motebitId,
      chain: chain.map((r) => ({
        old_public_key: r.old_public_key,
        new_public_key: r.new_public_key,
        timestamp: r.timestamp,
        reason: r.reason,
        old_key_signature: r.old_key_signature,
        new_key_signature: r.new_key_signature,
      })),
      current_public_key: agent?.public_key ?? null,
    });
  });

  // === Revocation Endpoints ===

  // POST /api/v1/agents/:motebitId/revoke-tokens — blacklist specific token JTIs
  app.post("/api/v1/agents/:motebitId/revoke-tokens", async (c) => {
    const motebitId = c.req.param("motebitId");
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (callerMotebitId && callerMotebitId !== motebitId) {
      throw new HTTPException(403, { message: "Cannot revoke tokens for another agent" });
    }
    const body = await c.req.json<{ jtis: string[] }>();
    if (!Array.isArray(body.jtis) || body.jtis.length === 0) {
      throw new HTTPException(400, { message: "jtis must be a non-empty array" });
    }
    const expiresAt = Date.now() + 6 * 60 * 1000; // 6 min (covers 5 min token lifetime + buffer)
    const stmt = moteDb.db.prepare(
      "INSERT OR IGNORE INTO relay_token_blacklist (jti, motebit_id, expires_at) VALUES (?, ?, ?)",
    );
    for (const jti of body.jtis) {
      stmt.run(jti, motebitId, expiresAt);
    }
    return c.json({ ok: true, revoked: body.jtis.length });
  });

  // POST /api/v1/agents/:motebitId/revoke — mark agent identity as revoked
  app.post("/api/v1/agents/:motebitId/revoke", async (c) => {
    const motebitId = c.req.param("motebitId");
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (callerMotebitId && callerMotebitId !== motebitId) {
      throw new HTTPException(403, { message: "Cannot revoke another agent" });
    }
    moteDb.db.prepare("UPDATE agent_registry SET revoked = 1 WHERE motebit_id = ?").run(motebitId);
    // Emit revocation event for federation propagation
    try {
      await insertRevocationEvent(moteDb.db, relayIdentity, "agent_revoked", motebitId);
    } catch {
      /* best-effort — revocation still succeeded locally */
    }
    return c.json({ ok: true, motebit_id: motebitId, revoked: true });
  });

  // === Multi-Party Approval Quorum ===

  // Approval votes table
  moteDb.db.exec(`
    CREATE TABLE IF NOT EXISTS relay_approval_votes (
      vote_id TEXT PRIMARY KEY,
      approval_id TEXT NOT NULL,
      approver_id TEXT NOT NULL,
      approved INTEGER NOT NULL,
      signature TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_approval_votes_approval ON relay_approval_votes(approval_id);
  `);

  // Approval metadata table — stores quorum config so relay is authoritative
  moteDb.db.exec(`
    CREATE TABLE IF NOT EXISTS relay_approval_metadata (
      approval_id TEXT PRIMARY KEY,
      motebit_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      args_hash TEXT NOT NULL,
      quorum_required INTEGER NOT NULL DEFAULT 1,
      quorum_approvers TEXT NOT NULL DEFAULT '[]',
      quorum_hash TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  // Migration: add quorum_hash column if missing
  try {
    moteDb.db.exec(
      "ALTER TABLE relay_approval_metadata ADD COLUMN quorum_hash TEXT NOT NULL DEFAULT ''",
    );
  } catch {
    /* column may already exist */
  }

  /**
   * Compute a deterministic quorum hash from config.
   * Normalizes approver list (sorted) so ["A","B"] === ["B","A"].
   * Computed once at creation, persisted, never recomputed.
   */
  async function computeQuorumHash(required: number, approvers: string[]): Promise<string> {
    const normalized = [...approvers].sort();
    const canonical = canonicalJson({ quorum_required: required, quorum_approvers: normalized });
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    return bytesToHex(new Uint8Array(buf));
  }

  // POST /api/v1/agents/:motebitId/approvals — register an approval request with quorum metadata.
  // Immutable after creation: resubmitting the same approval_id with different config is rejected.
  // Identical resubmission is idempotent (safe for retries).
  app.post("/api/v1/agents/:motebitId/approvals", async (c) => {
    const motebitId = c.req.param("motebitId");
    const body = await c.req.json<{
      approval_id: string;
      tool_name: string;
      args_hash: string;
      quorum_required: number;
      quorum_approvers: string[];
    }>();
    if (!body.approval_id || !body.tool_name || !body.args_hash) {
      throw new HTTPException(400, {
        message: "approval_id, tool_name, and args_hash are required",
      });
    }

    const quorumRequired = body.quorum_required ?? 1;
    const quorumApprovers = JSON.stringify(body.quorum_approvers ?? []);

    // Check for existing approval — immutable after creation
    const existing = moteDb.db
      .prepare(
        "SELECT motebit_id, tool_name, args_hash, quorum_required, quorum_approvers, quorum_hash FROM relay_approval_metadata WHERE approval_id = ?",
      )
      .get(body.approval_id) as
      | {
          motebit_id: string;
          tool_name: string;
          args_hash: string;
          quorum_required: number;
          quorum_approvers: string;
          quorum_hash: string;
        }
      | undefined;

    if (existing != null) {
      // Idempotent: identical resubmission is accepted (safe for retries)
      if (
        existing.motebit_id === motebitId &&
        existing.tool_name === body.tool_name &&
        existing.args_hash === body.args_hash &&
        existing.quorum_required === quorumRequired &&
        existing.quorum_approvers === quorumApprovers
      ) {
        return c.json({
          ok: true,
          approval_id: body.approval_id,
          quorum_hash: existing.quorum_hash,
          idempotent: true,
        });
      }
      // Different config → reject (immutability guarantee)
      throw new HTTPException(409, {
        message:
          "Approval already exists with different configuration — approval metadata is immutable after creation",
      });
    }

    const qHash = await computeQuorumHash(quorumRequired, body.quorum_approvers ?? []);

    moteDb.db
      .prepare(
        "INSERT INTO relay_approval_metadata (approval_id, motebit_id, tool_name, args_hash, quorum_required, quorum_approvers, quorum_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        body.approval_id,
        motebitId,
        body.tool_name,
        body.args_hash,
        quorumRequired,
        quorumApprovers,
        qHash,
      );

    return c.json({ ok: true, approval_id: body.approval_id, quorum_hash: qHash });
  });

  // POST /api/v1/agents/:motebitId/approvals/:approvalId/vote — submit an Ed25519-signed vote
  app.post("/api/v1/agents/:motebitId/approvals/:approvalId/vote", async (c) => {
    const motebitId = c.req.param("motebitId");
    const approvalId = c.req.param("approvalId");
    const body = await c.req.json<{
      approver_id: string;
      approved: boolean;
      signature: string;
    }>();

    if (!body.approver_id || body.approved == null || !body.signature) {
      throw new HTTPException(400, {
        message: "approver_id, approved, and signature are required",
      });
    }

    // 1. Load approval metadata — relay is authoritative
    const approval = moteDb.db
      .prepare("SELECT * FROM relay_approval_metadata WHERE approval_id = ?")
      .get(approvalId) as
      | {
          approval_id: string;
          motebit_id: string;
          tool_name: string;
          args_hash: string;
          quorum_required: number;
          quorum_approvers: string;
          quorum_hash: string;
          status: string;
        }
      | undefined;
    if (!approval) {
      throw new HTTPException(404, { message: "Approval not found" });
    }

    // 1b. Reject legacy approvals missing quorum_hash (pre-migration rows)
    if (!approval.quorum_hash) {
      throw new HTTPException(500, {
        message: "Approval missing quorum_hash — created before migration. Re-register to fix.",
      });
    }

    // 2. Terminal state — deny is permanent, no further votes accepted
    if (approval.status === "denied") {
      throw new HTTPException(409, {
        message: "Approval already denied — no further votes accepted",
      });
    }
    if (approval.status === "approved") {
      throw new HTTPException(409, {
        message: "Approval already met quorum — no further votes needed",
      });
    }

    // 3. Validate motebitId matches (path param must match stored approval)
    if (approval.motebit_id !== motebitId) {
      throw new HTTPException(403, { message: "Approval does not belong to this agent" });
    }

    // 4. Approver authorization — must be in the quorum approvers list
    const authorizedApprovers = JSON.parse(approval.quorum_approvers) as string[];
    if (authorizedApprovers.length > 0 && !authorizedApprovers.includes(body.approver_id)) {
      throw new HTTPException(403, { message: "Approver is not authorized for this quorum" });
    }

    // 5. Verify Ed25519 signature — canonical JSON with domain separation.
    // Bound to agent, approval, args hash, action, AND quorum definition.
    // quorum_hash is persisted at creation (computed once, normalized, never recomputed).
    // This cryptographically binds the vote to the exact quorum definition.
    const encoder = new TextEncoder();
    const votePayload = canonicalJson({
      type: "approval_vote",
      motebit_id: motebitId,
      approval_id: approvalId,
      args_hash: approval.args_hash,
      quorum_hash: approval.quorum_hash,
      approver_id: body.approver_id,
      decision: body.approved ? "approve" : "deny",
    });

    const approverAgent = moteDb.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(body.approver_id) as { public_key: string } | undefined;
    if (!approverAgent) {
      throw new HTTPException(404, { message: "Approver agent not found" });
    }

    const valid = await verify(
      hexToBytes(body.signature),
      encoder.encode(votePayload),
      hexToBytes(approverAgent.public_key),
    );
    if (!valid) {
      throw new HTTPException(403, { message: "Vote signature verification failed" });
    }

    // 6. Duplicate vote check
    const existing = moteDb.db
      .prepare("SELECT 1 FROM relay_approval_votes WHERE approval_id = ? AND approver_id = ?")
      .get(approvalId, body.approver_id) as Record<string, unknown> | undefined;
    if (existing != null) {
      return c.json({ ok: true, duplicate: true, approval_id: approvalId });
    }

    // 7. Record vote
    const voteId = `vote-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    moteDb.db
      .prepare(
        "INSERT INTO relay_approval_votes (vote_id, approval_id, approver_id, approved, signature) VALUES (?, ?, ?, ?, ?)",
      )
      .run(voteId, approvalId, body.approver_id, body.approved ? 1 : 0, body.signature);

    // 8. Deny = terminal state — mark approval as denied, reject all future votes
    if (!body.approved) {
      moteDb.db
        .prepare("UPDATE relay_approval_metadata SET status = 'denied' WHERE approval_id = ?")
        .run(approvalId);
      return c.json({
        ok: true,
        approval_id: approvalId,
        vote_id: voteId,
        status: "denied",
        reason: "Deny vote received — approval terminated (fail-closed)",
      });
    }

    // 9. Count approved votes and check quorum
    const approvedCount = (
      moteDb.db
        .prepare(
          "SELECT COUNT(*) as cnt FROM relay_approval_votes WHERE approval_id = ? AND approved = 1",
        )
        .get(approvalId) as { cnt: number }
    ).cnt;

    const quorumMet = approvedCount >= approval.quorum_required;
    if (quorumMet) {
      moteDb.db
        .prepare("UPDATE relay_approval_metadata SET status = 'approved' WHERE approval_id = ?")
        .run(approvalId);
    }

    return c.json({
      ok: true,
      approval_id: approvalId,
      vote_id: voteId,
      approved_count: approvedCount,
      quorum_required: approval.quorum_required,
      quorum_met: quorumMet,
      status: quorumMet ? "approved" : "pending",
    });
  });

  // GET /api/v1/agents/:motebitId/approvals/:approvalId — quorum progress status
  app.get("/api/v1/agents/:motebitId/approvals/:approvalId", (c) => {
    const motebitId = c.req.param("motebitId");
    const approvalId = c.req.param("approvalId");

    const approval = moteDb.db
      .prepare("SELECT * FROM relay_approval_metadata WHERE approval_id = ? AND motebit_id = ?")
      .get(approvalId, motebitId) as
      | {
          quorum_required: number;
          quorum_approvers: string;
          quorum_hash: string;
          status: string;
        }
      | undefined;

    const votes = moteDb.db
      .prepare(
        "SELECT approver_id, approved, created_at FROM relay_approval_votes WHERE approval_id = ?",
      )
      .all(approvalId) as Array<{ approver_id: string; approved: number; created_at: number }>;

    const approvedVotes = votes.filter((v) => v.approved === 1).map((v) => v.approver_id);
    const deniedVotes = votes.filter((v) => v.approved === 0).map((v) => v.approver_id);

    return c.json({
      approval_id: approvalId,
      status: approval?.status ?? "unknown",
      quorum_required: approval?.quorum_required ?? 1,
      quorum_hash: approval?.quorum_hash,
      approved_by: approvedVotes,
      denied_by: deniedVotes,
      total_votes: votes.length,
      quorum_met: approval != null && approvedVotes.length >= approval.quorum_required,
    });
  });

  // === Market Endpoints ===

  // POST /api/v1/agents/:motebitId/listing — register/update service listing
  app.post("/api/v1/agents/:motebitId/listing", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (callerMotebitId && callerMotebitId !== motebitId) {
      throw new HTTPException(403, { message: "Cannot modify another agent's listing" });
    }
    const body = await c.req.json<{
      capabilities?: string[];
      pricing?: Array<{ capability: string; unit_cost: number; currency: string; per: string }>;
      sla?: { max_latency_ms?: number; availability_guarantee?: number };
      description?: string;
      /** Wallet address for x402 payment settlement (e.g. "0x..." for EVM). */
      pay_to_address?: string;
      /** Self-declared regulatory risk score [0, ∞). 0 = no risk, higher = more risk. */
      regulatory_risk?: number;
    }>();

    const now = Date.now();

    // One listing per agent — delete any existing listing before insert.
    // This prevents duplicate rows (listing_id is always fresh UUID, so
    // INSERT OR REPLACE on PK would accumulate rows per agent).
    moteDb.db.prepare("DELETE FROM relay_service_listings WHERE motebit_id = ?").run(motebitId);

    const listingId = asListingId(`ls-${crypto.randomUUID()}`);
    moteDb.db
      .prepare(
        `INSERT INTO relay_service_listings
         (listing_id, motebit_id, capabilities, pricing, sla_max_latency_ms, sla_availability, description, pay_to_address, regulatory_risk, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        listingId,
        motebitId,
        JSON.stringify(body.capabilities ?? []),
        JSON.stringify(body.pricing ?? []),
        body.sla?.max_latency_ms ?? 5000,
        body.sla?.availability_guarantee ?? 0.99,
        body.description ?? "",
        body.pay_to_address ?? null,
        body.regulatory_risk ?? null,
        now,
      );

    return c.json({ listing_id: listingId, updated_at: now }, 200);
  });

  // GET /api/v1/agents/:motebitId/listing — get service listing
  app.get("/api/v1/agents/:motebitId/listing", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));

    const row = moteDb.db
      .prepare(`SELECT * FROM relay_service_listings WHERE motebit_id = ?`)
      .get(motebitId) as Record<string, unknown> | undefined;

    if (!row) {
      throw new HTTPException(404, { message: "No service listing found" });
    }

    return c.json({
      listing_id: row.listing_id,
      motebit_id: row.motebit_id,
      capabilities: JSON.parse(row.capabilities as string) as string[],
      pricing: JSON.parse(row.pricing as string) as unknown[],
      sla: {
        max_latency_ms: row.sla_max_latency_ms,
        availability_guarantee: row.sla_availability,
      },
      description: row.description,
      updated_at: row.updated_at,
    });
  });

  // GET /api/v1/market/revenue — platform settlement fee revenue (authenticated)
  app.get("/api/v1/market/revenue", (c) => {
    const days = Math.min(parseInt(c.req.query("days") ?? "30", 10) || 30, 365);
    const since = Date.now() - days * 86_400_000;

    const totals = moteDb.db
      .prepare(
        `SELECT
           COUNT(*) AS settlement_count,
           COALESCE(SUM(amount_settled), 0) AS total_settled,
           COALESCE(SUM(platform_fee), 0) AS total_platform_fees,
           COALESCE(SUM(amount_settled + platform_fee), 0) AS total_gross_volume
         FROM relay_settlements
         WHERE settled_at >= ?`,
      )
      .get(since) as {
      settlement_count: number;
      total_settled: number;
      total_platform_fees: number;
      total_gross_volume: number;
    };

    // Daily breakdown for charting
    const daily = moteDb.db
      .prepare(
        `SELECT
           (settled_at / 86400000) AS day_epoch,
           COUNT(*) AS count,
           COALESCE(SUM(platform_fee), 0) AS fees,
           COALESCE(SUM(amount_settled + platform_fee), 0) AS volume
         FROM relay_settlements
         WHERE settled_at >= ?
         GROUP BY day_epoch
         ORDER BY day_epoch`,
      )
      .all(since) as Array<{
      day_epoch: number;
      count: number;
      fees: number;
      volume: number;
    }>;

    return c.json({
      period_days: days,
      ...totals,
      daily: daily.map((d) => ({
        date: new Date(d.day_epoch * 86_400_000).toISOString().slice(0, 10),
        settlement_count: d.count,
        platform_fees: d.fees,
        gross_volume: d.volume,
      })),
    });
  });

  // GET /api/v1/market/candidates — scored candidate list for capability query
  app.get("/api/v1/market/candidates", (c) => {
    const capability = c.req.query("capability");
    const maxBudgetStr = c.req.query("max_budget");
    const limitStr = c.req.query("limit");
    const limit = Math.min(Math.max(parseInt(limitStr ?? "20", 10) || 20, 1), 100);
    const maxBudget = maxBudgetStr ? parseFloat(maxBudgetStr) : undefined;

    const { profiles, requirements } = taskRouter.buildCandidateProfiles(
      capability ?? undefined,
      maxBudget,
      limit,
    );

    const explorationStr = c.req.query("exploration_drive");
    const explorationWeight =
      explorationStr != null ? Math.max(0, Math.min(1, parseFloat(explorationStr))) : undefined;
    const peerEdges = taskRouter.fetchPeerEdges();
    const ranked = graphRankCandidates(
      asMotebitId("relay"), // public endpoint, no caller identity
      profiles,
      requirements,
      { explorationWeight, peerEdges },
    );

    return c.json({
      candidates: ranked.map((score) => {
        const profile = profiles.find((p) => p.motebit_id === score.motebit_id);
        return {
          motebit_id: score.motebit_id,
          composite: score.composite,
          sub_scores: score.sub_scores,
          selected: score.selected,
          capabilities: profile?.listing?.capabilities ?? [],
          pricing: profile?.listing?.pricing ?? [],
          sla: profile?.listing?.sla ?? null,
          description: profile?.listing?.description ?? "",
          is_online: profile?.is_online ?? false,
          latency_stats: profile?.latency_stats ?? null,
        };
      }),
    });
  });

  // === Collaborative Plan Proposals ===

  // POST /api/v1/proposals — submit proposal
  app.post("/api/v1/proposals", async (c) => {
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    const body = await c.req.json<{
      proposal_id: string;
      plan_id: string;
      initiator_motebit_id?: string;
      participants: Array<{ motebit_id: string; assigned_steps: number[] }>;
      plan_snapshot?: unknown;
      expires_in_ms?: number;
    }>();

    const initiatorId = callerMotebitId ?? body.initiator_motebit_id;
    if (!initiatorId) {
      throw new HTTPException(400, { message: "Missing initiator_motebit_id" });
    }
    if (!body.proposal_id || !body.plan_id || !Array.isArray(body.participants)) {
      throw new HTTPException(400, { message: "Missing required fields" });
    }

    const now = Date.now();
    const expiresAt = now + (body.expires_in_ms ?? 10 * 60 * 1000); // 10 min default

    moteDb.db
      .prepare(
        `INSERT INTO relay_proposals (proposal_id, plan_id, initiator_motebit_id, status, plan_snapshot, created_at, expires_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(
        body.proposal_id,
        body.plan_id,
        initiatorId,
        JSON.stringify(body.plan_snapshot ?? null),
        now,
        expiresAt,
        now,
      );

    for (const p of body.participants) {
      moteDb.db
        .prepare(
          `INSERT INTO relay_proposal_participants (proposal_id, motebit_id, assigned_steps)
         VALUES (?, ?, ?)`,
        )
        .run(body.proposal_id, p.motebit_id, JSON.stringify(p.assigned_steps));
    }

    // Fan out to all participant motebits
    for (const p of body.participants) {
      const peers = connections.get(p.motebit_id);
      if (peers) {
        const payload = JSON.stringify({
          type: "proposal",
          proposal_id: body.proposal_id,
          plan_id: body.plan_id,
          initiator_motebit_id: initiatorId,
          assigned_steps: p.assigned_steps,
        });
        for (const peer of peers) {
          peer.ws.send(payload);
        }
      }
    }

    return c.json({ proposal_id: body.proposal_id, status: "pending", expires_at: expiresAt }, 201);
  });

  // GET /api/v1/proposals/:proposalId — get proposal state
  app.get("/api/v1/proposals/:proposalId", (c) => {
    const proposalId = c.req.param("proposalId");
    const proposal = moteDb.db
      .prepare("SELECT * FROM relay_proposals WHERE proposal_id = ?")
      .get(proposalId) as Record<string, unknown> | undefined;
    if (!proposal) {
      throw new HTTPException(404, { message: "Proposal not found" });
    }

    const participants = moteDb.db
      .prepare("SELECT * FROM relay_proposal_participants WHERE proposal_id = ?")
      .all(proposalId) as Array<Record<string, unknown>>;

    return c.json({
      proposal_id: proposal.proposal_id,
      plan_id: proposal.plan_id,
      initiator_motebit_id: proposal.initiator_motebit_id,
      status: proposal.status,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/strict-boolean-expressions -- JSON.parse returns any; DB row field is untyped
      plan_snapshot: proposal.plan_snapshot ? JSON.parse(proposal.plan_snapshot as string) : null,
      created_at: proposal.created_at,
      expires_at: proposal.expires_at,
      updated_at: proposal.updated_at,
      participants: participants.map((p) => ({
        motebit_id: p.motebit_id,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- JSON.parse returns any
        assigned_steps: JSON.parse(p.assigned_steps as string),
        response: p.response ?? null,
        responded_at: p.responded_at ?? null,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/strict-boolean-expressions -- JSON.parse returns any; DB row field is untyped
        counter_steps: p.counter_steps ? JSON.parse(p.counter_steps as string) : null,
      })),
    });
  });

  // POST /api/v1/proposals/:proposalId/respond — participant responds
  app.post("/api/v1/proposals/:proposalId/respond", async (c) => {
    const proposalId = c.req.param("proposalId");
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    const body = await c.req.json<{
      responder_motebit_id?: string;
      response: string;
      counter_steps?: unknown;
      signature?: string;
    }>();

    const responderId = callerMotebitId ?? body.responder_motebit_id;
    if (!responderId || !body.response) {
      throw new HTTPException(400, { message: "Missing required fields" });
    }

    const proposal = moteDb.db
      .prepare("SELECT * FROM relay_proposals WHERE proposal_id = ?")
      .get(proposalId) as Record<string, unknown> | undefined;
    if (!proposal) {
      throw new HTTPException(404, { message: "Proposal not found" });
    }
    if (proposal.status !== "pending") {
      throw new HTTPException(409, {
        message: `Proposal is ${proposal.status as string}, cannot respond`,
      });
    }

    const now = Date.now();
    moteDb.db
      .prepare(
        `UPDATE relay_proposal_participants SET response = ?, counter_steps = ?, responded_at = ?, signature = ? WHERE proposal_id = ? AND motebit_id = ?`,
      )
      .run(
        body.response,
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- request body field may be any
        body.counter_steps ? JSON.stringify(body.counter_steps) : null,
        now,
        body.signature ?? null,
        proposalId,
        responderId,
      );

    // Check if all participants have responded
    const allParticipants = moteDb.db
      .prepare("SELECT * FROM relay_proposal_participants WHERE proposal_id = ?")
      .all(proposalId) as Array<Record<string, unknown>>;

    const allResponded = allParticipants.every((p) => p.response != null);
    const allAccepted = allParticipants.every((p) => p.response === "accept");
    const anyRejected = allParticipants.some((p) => p.response === "reject");
    const anyCountered = allParticipants.some((p) => p.response === "counter");

    let newStatus = "pending";
    if (anyRejected) newStatus = "rejected";
    else if (allAccepted) newStatus = "accepted";
    else if (anyCountered && allResponded) newStatus = "countered";

    if (newStatus !== "pending") {
      moteDb.db
        .prepare("UPDATE relay_proposals SET status = ?, updated_at = ? WHERE proposal_id = ?")
        .run(newStatus, now, proposalId);
    }

    // Fan out response to initiator
    const initiatorPeers = connections.get(proposal.initiator_motebit_id as string);
    if (initiatorPeers) {
      const payload = JSON.stringify({
        type: "proposal_response",
        proposal_id: proposalId,
        responder_motebit_id: responderId,
        response: body.response,
        counter_steps: body.counter_steps ?? null,
      });
      for (const peer of initiatorPeers) {
        peer.ws.send(payload);
      }
    }

    // If all accepted, fan out finalized to all participants
    if (newStatus === "accepted") {
      for (const p of allParticipants) {
        const peers = connections.get(p.motebit_id as string);
        if (peers) {
          const payload = JSON.stringify({
            type: "proposal_finalized",
            proposal_id: proposalId,
            plan_id: proposal.plan_id,
            status: "accepted",
          });
          for (const peer of peers) {
            peer.ws.send(payload);
          }
        }
      }
    }

    return c.json({ status: newStatus, all_responded: allResponded });
  });

  // POST /api/v1/proposals/:proposalId/withdraw — initiator withdraws
  app.post("/api/v1/proposals/:proposalId/withdraw", (c) => {
    const proposalId = c.req.param("proposalId");
    const proposal = moteDb.db
      .prepare("SELECT * FROM relay_proposals WHERE proposal_id = ?")
      .get(proposalId) as Record<string, unknown> | undefined;
    if (!proposal) {
      throw new HTTPException(404, { message: "Proposal not found" });
    }
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (callerMotebitId && callerMotebitId !== proposal.initiator_motebit_id) {
      throw new HTTPException(403, { message: "Only the initiator can withdraw a proposal" });
    }
    if (proposal.status !== "pending") {
      throw new HTTPException(409, {
        message: `Proposal is ${proposal.status as string}, cannot withdraw`,
      });
    }

    const now = Date.now();
    moteDb.db
      .prepare(
        "UPDATE relay_proposals SET status = 'withdrawn', updated_at = ? WHERE proposal_id = ?",
      )
      .run(now, proposalId);

    return c.json({ status: "withdrawn" });
  });

  // GET /api/v1/proposals — list proposals
  app.get("/api/v1/proposals", (c) => {
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    const status = c.req.query("status");
    const limitStr = c.req.query("limit");
    const limit = Math.min(Math.max(parseInt(limitStr ?? "50", 10) || 50, 1), 200);

    // Always scope to caller's proposals (initiator or participant)
    const scopeId = callerMotebitId ?? c.req.query("motebit_id");
    if (!scopeId) {
      throw new HTTPException(400, { message: "Missing caller identity" });
    }

    let sql =
      "SELECT * FROM relay_proposals WHERE (initiator_motebit_id = ? OR proposal_id IN (SELECT proposal_id FROM relay_proposal_participants WHERE motebit_id = ?))";
    const params: unknown[] = [scopeId, scopeId];

    if (status) {
      sql += " AND status = ?";
      params.push(status);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);

    const proposals = moteDb.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    return c.json({
      proposals: proposals.map((p) => ({
        proposal_id: p.proposal_id,
        plan_id: p.plan_id,
        initiator_motebit_id: p.initiator_motebit_id,
        status: p.status,
        created_at: p.created_at,
        expires_at: p.expires_at,
        updated_at: p.updated_at,
      })),
    });
  });

  // POST /api/v1/proposals/:proposalId/step-result — post step completion
  app.post("/api/v1/proposals/:proposalId/step-result", async (c) => {
    const proposalId = c.req.param("proposalId");
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    const body = await c.req.json<{
      step_id: string;
      motebit_id?: string;
      status: string;
      result_summary?: string;
      receipt?: unknown;
    }>();

    const motebitId = callerMotebitId ?? body.motebit_id;
    if (!motebitId || !body.step_id || !body.status) {
      throw new HTTPException(400, { message: "Missing required fields" });
    }

    // Verify caller is a participant in this proposal
    const stepProposal = moteDb.db
      .prepare("SELECT initiator_motebit_id FROM relay_proposals WHERE proposal_id = ?")
      .get(proposalId) as { initiator_motebit_id: string } | undefined;
    if (!stepProposal) {
      throw new HTTPException(404, { message: "Proposal not found" });
    }
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- .get() returns any
    const isParticipant = moteDb.db
      .prepare("SELECT 1 FROM relay_proposal_participants WHERE proposal_id = ? AND motebit_id = ?")
      .get(proposalId, motebitId);
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- isParticipant is any from .get()
    if (!isParticipant && motebitId !== stepProposal.initiator_motebit_id) {
      throw new HTTPException(403, { message: "Caller is not a participant in this proposal" });
    }

    const now = Date.now();
    moteDb.db
      .prepare(
        `INSERT OR REPLACE INTO relay_collaborative_step_results (proposal_id, step_id, motebit_id, status, result_summary, receipt, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        proposalId,
        body.step_id,
        motebitId,
        body.status,
        body.result_summary ?? null,
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- request body field may be any
        body.receipt ? JSON.stringify(body.receipt) : null,
        now,
      );

    // Fan out step result to all participants
    const participants = moteDb.db
      .prepare("SELECT motebit_id FROM relay_proposal_participants WHERE proposal_id = ?")
      .all(proposalId) as Array<{ motebit_id: string }>;

    const proposal = moteDb.db
      .prepare("SELECT initiator_motebit_id FROM relay_proposals WHERE proposal_id = ?")
      .get(proposalId) as { initiator_motebit_id: string } | undefined;

    const recipientIds = new Set(participants.map((p) => p.motebit_id));
    if (proposal) recipientIds.add(proposal.initiator_motebit_id);

    for (const recipientId of recipientIds) {
      const peers = connections.get(recipientId);
      if (peers) {
        const payload = JSON.stringify({
          type: "collaborative_step_result",
          proposal_id: proposalId,
          step_id: body.step_id,
          motebit_id: motebitId,
          status: body.status,
          result_summary: body.result_summary ?? null,
        });
        for (const peer of peers) {
          peer.ws.send(payload);
        }
      }
    }

    return c.json({ status: "recorded" });
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
    x402: x402Env,
    federation: process.env.MOTEBIT_FEDERATION_ENDPOINT_URL
      ? {
          endpointUrl: process.env.MOTEBIT_FEDERATION_ENDPOINT_URL,
          displayName: process.env.MOTEBIT_FEDERATION_DISPLAY_NAME,
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
