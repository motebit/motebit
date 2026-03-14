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
import type { AgentTask, MotebitId, NodeId, SyncPlan, SyncPlanStep } from "@motebit/sdk";
import type { WSContext } from "hono/ws";
/* eslint-disable no-restricted-imports -- Relay service generates its own keypair (not a user surface) */
import {
  verifySignedToken,
  verifyExecutionReceipt,
  hexPublicKeyToDidKey,
  generateKeypair,
  publicKeyToDidKey,
  issueReputationCredential,
  verifyVerifiableCredential,
  createPresentation,
  verifyKeySuccession,
} from "@motebit/crypto";
/* eslint-enable no-restricted-imports */
import type { VerifiableCredential, KeySuccessionRecord } from "@motebit/crypto";
import { graphRankCandidates, settleOnReceipt } from "@motebit/market";
import type { CandidateProfile, TaskRequirements } from "@motebit/market";
import type { CapabilityPrice, BudgetAllocation, AgentTrustRecord } from "@motebit/sdk";
import {
  PLATFORM_FEE_RATE,
  AgentTrustLevel,
  EventType,
  evaluateTrustTransition,
} from "@motebit/sdk";

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

// === Canonical JSON (deterministic serialization for execution ledger hashing) ===

function canonicalJsonApi(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map((item) => canonicalJsonApi(item)).join(",") + "]";
  }
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  const entries = sorted.map(
    (key) => JSON.stringify(key) + ":" + canonicalJsonApi((obj as Record<string, unknown>)[key]),
  );
  return "{" + entries.join(",") + "}";
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
}

// === Rate Limiter ===

class RateLimiter {
  private windows: Map<string, { count: number; resetAt: number }> = new Map();

  constructor(
    private maxRequests: number,
    private windowMs: number,
  ) {}

  check(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    const entry = this.windows.get(key);

    if (!entry || entry.resetAt <= now) {
      // New window
      const resetAt = now + this.windowMs;
      this.windows.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: this.maxRequests - 1, resetAt };
    }

    entry.count++;
    const allowed = entry.count <= this.maxRequests;
    const remaining = Math.max(0, this.maxRequests - entry.count);
    return { allowed, remaining, resetAt: entry.resetAt };
  }

  /** Remove expired entries to prevent memory growth. */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.windows) {
      if (entry.resetAt <= now) {
        this.windows.delete(key);
      }
    }
  }
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

export async function createSyncRelay(config: SyncRelayConfig): Promise<SyncRelay> {
  const {
    dbPath = ":memory:",
    apiToken,
    corsOrigin = "*",
    enableDeviceAuth = true,
    verifyDeviceSignature = true,
    x402: x402Config,
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

  // Create plan sync tables (relay-side storage)
  moteDb.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_plans (
        plan_id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        motebit_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        current_step_index INTEGER NOT NULL DEFAULT 0,
        total_steps INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sync_plans_motebit
        ON sync_plans (motebit_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS sync_plan_steps (
        step_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        motebit_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        description TEXT NOT NULL,
        prompt TEXT NOT NULL,
        depends_on TEXT NOT NULL DEFAULT '[]',
        optional INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        required_capabilities TEXT,
        delegation_task_id TEXT,
        result_summary TEXT,
        error_message TEXT,
        tool_calls_made INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER,
        completed_at INTEGER,
        retry_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sync_plan_steps_motebit
        ON sync_plan_steps (motebit_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sync_plan_steps_plan
        ON sync_plan_steps (plan_id, ordinal ASC);
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
  `);

  // Settlement ledger — x402 handles payment, this is the relay's accounting record
  moteDb.db.exec(`
      CREATE TABLE IF NOT EXISTS relay_settlements (
        settlement_id TEXT PRIMARY KEY,
        allocation_id TEXT NOT NULL UNIQUE,
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
        reason TEXT
      );
  `);

  // Add revoked column to agent_registry (column-exists check pattern)
  try {
    moteDb.db.exec("ALTER TABLE agent_registry ADD COLUMN revoked INTEGER DEFAULT 0");
  } catch {
    /* column may already exist */
  }

  // Startup cleanup: purge expired blacklist entries
  moteDb.db.prepare("DELETE FROM relay_token_blacklist WHERE expires_at < ?").run(Date.now());

  // Extend sync tables for collaborative fields (column-exists check pattern)
  try {
    moteDb.db.exec("ALTER TABLE sync_plan_steps ADD COLUMN assigned_motebit_id TEXT DEFAULT NULL");
  } catch {
    /* column may already exist */
  }
  try {
    moteDb.db.exec("ALTER TABLE sync_plans ADD COLUMN proposal_id TEXT DEFAULT NULL");
  } catch {
    /* column may already exist */
  }
  try {
    moteDb.db.exec("ALTER TABLE sync_plans ADD COLUMN collaborative INTEGER DEFAULT 0");
  } catch {
    /* column may already exist */
  }

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

  // In-memory agent task queue: task_id → { task, receipt?, expiresAt, submitted_by?, price_snapshot? }
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
  }, 60_000);

  // Rate limiter instances per endpoint category (per-relay for test isolation)
  const authLimiter = new RateLimiter(30, 60_000); // 30 req/min
  const readLimiter = new RateLimiter(60, 60_000); // 60 req/min
  const writeLimiter = new RateLimiter(30, 60_000); // 30 req/min
  const publicLimiter = new RateLimiter(20, 60_000); // 20 req/min
  const expensiveLimiter = new RateLimiter(10, 60_000); // 10 req/min
  const allLimiters = [authLimiter, readLimiter, writeLimiter, publicLimiter, expensiveLimiter];

  const app = new Hono();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- hono utility functions, not bound methods
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  // --- Middleware ---
  app.use("*", secureHeaders());
  app.use("*", cors({ origin: corsOrigin }));

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
    app.use("*", async (c, next) => {
      const isTaskPost = c.req.method === "POST" && /\/agent\/[^/]+\/task/.test(c.req.path);
      if (!isTaskPost) return next();
      const agentId = extractMotebitIdFromPath(c.req.path);
      currentPricing = agentId ? getAgentPricing(agentId) : null;
      if (!currentPricing) return next(); // Free — no x402
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Hono context type variance
      return x402Gate(c, next);
    });
  }

  // --- Rate Limiting ---

  function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
    return (
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      c.req.header("x-real-ip") ??
      "unknown"
    );
  }

  function isMasterToken(c: { req: { header: (name: string) => string | undefined } }): boolean {
    if (apiToken == null || apiToken === "") return false;
    const authHeader = c.req.header("authorization");
    return authHeader != null && authHeader === `Bearer ${apiToken}`;
  }

  function rateLimitMiddleware(limiter: RateLimiter) {
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

  // Read endpoints: discover, credentials, capabilities, listings (60 req/min)
  app.use("/api/v1/agents/discover", rateLimitMiddleware(readLimiter));
  app.use("/api/v1/agents/:motebitId/credentials", rateLimitMiddleware(readLimiter));
  app.use("/api/v1/agents/:motebitId/listing", rateLimitMiddleware(readLimiter));
  app.use("/agent/:motebitId/capabilities", rateLimitMiddleware(readLimiter));
  app.use("/agent/:motebitId/settlements", rateLimitMiddleware(readLimiter));

  // Write endpoints: task submission, result, ledger (30 req/min)
  app.use("/agent/:motebitId/task", rateLimitMiddleware(writeLimiter));
  app.use("/agent/:motebitId/task/:taskId/result", rateLimitMiddleware(writeLimiter));
  app.use("/agent/:motebitId/ledger", rateLimitMiddleware(writeLimiter));

  // Public endpoints: credential verification, credential status (20 req/min)
  app.use("/api/v1/credentials/verify", rateLimitMiddleware(publicLimiter));
  app.use("/api/v1/credentials/:credentialId/status", rateLimitMiddleware(publicLimiter));

  // Write endpoints: revocation (30 req/min)
  app.use("/api/v1/agents/:motebitId/revoke-tokens", rateLimitMiddleware(writeLimiter));
  app.use("/api/v1/agents/:motebitId/revoke-credential", rateLimitMiddleware(writeLimiter));
  app.use("/api/v1/agents/:motebitId/revoke", rateLimitMiddleware(writeLimiter));

  // Expensive endpoints: presentation bundling, bootstrap (10 req/min)
  app.use("/api/v1/agents/:motebitId/presentation", rateLimitMiddleware(expensiveLimiter));
  app.use("/api/v1/agents/bootstrap", rateLimitMiddleware(expensiveLimiter));

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
      const motebitId = asMotebitId(c.req.param("motebitId") as string);
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
              const entry = taskQueue.get(msg.task_id);
              let claimRejected = false;

              if (!entry || entry.task.motebit_id !== motebitId) {
                ws.send(
                  JSON.stringify({
                    type: "task_claim_rejected",
                    task_id: msg.task_id,
                    reason: "Task not found",
                  }),
                );
                claimRejected = true;
              } else if (entry.task.status !== AgentTaskStatus.Pending) {
                ws.send(
                  JSON.stringify({
                    type: "task_claim_rejected",
                    task_id: msg.task_id,
                    reason: "Task already claimed",
                  }),
                );
                claimRejected = true;
              } else {
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
                      ws.send(
                        JSON.stringify({
                          type: "task_claim_rejected",
                          task_id: msg.task_id,
                          reason: "Device lacks required capabilities",
                        }),
                      );
                      claimRejected = true;
                    }
                  }
                }
              }

              if (!claimRejected && entry) {
                entry.task.status = AgentTaskStatus.Claimed;
                entry.task.claimed_by = deviceId;
                ws.send(JSON.stringify({ type: "task_claimed", task_id: msg.task_id }));
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
    return c.json({ motebit_id: motebitId, events, after_clock: afterClock });
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
        c.req.path.match(/\/api\/v1\/credentials\/[^/]+\/status/)
      ) {
        await next();
        return;
      }
      const mw = bearerAuth({ token: apiToken });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
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
    const canonicalLines = timeline.map((entry) => canonicalJsonApi(entry));
    const hashBuf = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalLines.join("\n")),
    );
    const contentHash = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

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

  // --- Credentials: relay-issued reputation VC ---
  // Relay generates an ephemeral keypair on startup for signing credentials.
  // In production this should be a persisted relay identity.
  let relayKeypairPromise: Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> | null = null;
  function getRelayKeypair(): Promise<{ publicKey: Uint8Array; privateKey: Uint8Array }> {
    if (!relayKeypairPromise) {
      relayKeypairPromise = generateKeypair();
    }
    return relayKeypairPromise;
  }

  app.post("/api/v1/credentials/:motebitId/reputation", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));

    // Compute reputation from settlement records and latency stats
    const settlements = moteDb.db
      .prepare(
        `SELECT status, settled_at FROM relay_settlements
         WHERE motebit_id = ?
         ORDER BY settled_at DESC LIMIT 1000`,
      )
      .all(motebitId) as Array<{
      status: string;
      settled_at: number;
    }>;

    if (settlements.length === 0) {
      return c.json({ error: "No task history for this agent" }, 404);
    }

    const succeeded = settlements.filter((r) => r.status === "completed").length;
    const successRate = succeeded / settlements.length;
    const latencies = moteDb.db
      .prepare(
        `SELECT latency_ms FROM relay_latency_stats
         WHERE remote_motebit_id = ?
         ORDER BY recorded_at DESC LIMIT 1000`,
      )
      .all(motebitId) as Array<{ latency_ms: number }>;
    const avgLatency =
      latencies.length > 0 ? latencies.reduce((a, b) => a + b.latency_ms, 0) / latencies.length : 0;

    // Look up agent's public key for did:key subject
    const identity = await identityManager.load(motebitId);
    const devices = identity ? await identityManager.listDevices(motebitId) : [];
    const agentPubKeyHex = devices[0]?.public_key;
    const subjectDid = agentPubKeyHex
      ? hexPublicKeyToDidKey(agentPubKeyHex)
      : `did:motebit:${motebitId}`;

    const relayKeys = await getRelayKeypair();
    const vc = await issueReputationCredential(
      {
        success_rate: successRate,
        avg_latency_ms: avgLatency,
        task_count: settlements.length,
        trust_score: successRate, // Simple: trust = success rate for now
        availability: 1.0, // Relay can't measure this yet
        measured_at: Date.now(),
      },
      relayKeys.privateKey,
      relayKeys.publicKey,
      subjectDid,
    );

    return c.json({
      credential: vc,
      relay_did: publicKeyToDidKey(relayKeys.publicKey),
    });
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
  app.get("/api/v1/memory/:motebitId", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const [memories, edges] = await Promise.all([
      moteDb.memoryStorage.getAllNodes(motebitId),
      moteDb.memoryStorage.getAllEdges(motebitId),
    ]);
    return c.json({ motebit_id: motebitId, memories, edges });
  });

  // --- Memory: tombstone a node (ownership-verified, branded IDs) ---
  app.delete("/api/v1/memory/:motebitId/:nodeId", async (c) => {
    const motebitId: MotebitId = asMotebitId(c.req.param("motebitId"));
    const nodeId: NodeId = asNodeId(c.req.param("nodeId"));
    try {
      const deleted = moteDb.memoryStorage.tombstoneNodeOwned
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
    const id = asMotebitId(c.req.param("motebitId"));
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

    const verified = await verifySignedTokenForDevice(
      token,
      claims.mid,
      identityManager,
      "device:auth",
      isTokenBlacklisted,
      isAgentRevoked,
    );
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
    const motebitId = asMotebitId(c.req.param("motebitId"));
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
    const motebitId = asMotebitId(c.req.param("motebitId"));
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
    const motebitId = asMotebitId(c.req.param("motebitId"));
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
    const motebitId = asMotebitId(c.req.param("motebitId"));
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

  // === Plan Sync Helpers ===

  /** Step status ordinal for monotonicity enforcement. */
  const STEP_STATUS_ORDER: Record<string, number> = {
    pending: 0,
    running: 1,
    completed: 2,
    failed: 2,
    skipped: 2,
  };

  function upsertSyncPlan(plan: SyncPlan): void {
    moteDb.db
      .prepare(
        `INSERT INTO sync_plans (plan_id, goal_id, motebit_id, title, status, created_at, updated_at, current_step_index, total_steps, proposal_id, collaborative)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(plan_id) DO UPDATE SET
         status = CASE WHEN excluded.updated_at >= sync_plans.updated_at THEN excluded.status ELSE sync_plans.status END,
         title = CASE WHEN excluded.updated_at >= sync_plans.updated_at THEN excluded.title ELSE sync_plans.title END,
         updated_at = MAX(excluded.updated_at, sync_plans.updated_at),
         current_step_index = CASE WHEN excluded.updated_at >= sync_plans.updated_at THEN excluded.current_step_index ELSE sync_plans.current_step_index END,
         total_steps = MAX(excluded.total_steps, sync_plans.total_steps),
         proposal_id = CASE WHEN excluded.updated_at >= sync_plans.updated_at THEN excluded.proposal_id ELSE sync_plans.proposal_id END,
         collaborative = CASE WHEN excluded.updated_at >= sync_plans.updated_at THEN excluded.collaborative ELSE sync_plans.collaborative END`,
      )
      .run(
        plan.plan_id,
        plan.goal_id,
        plan.motebit_id,
        plan.title,
        plan.status,
        plan.created_at,
        plan.updated_at,
        plan.current_step_index,
        plan.total_steps,
        plan.proposal_id ?? null,
        plan.collaborative ? 1 : 0,
      );
  }

  function upsertSyncPlanStep(step: SyncPlanStep): void {
    // Check existing status for monotonicity
    const existing = moteDb.db
      .prepare(`SELECT status, updated_at FROM sync_plan_steps WHERE step_id = ?`)
      .get(step.step_id) as { status: string; updated_at: number } | undefined;

    if (existing) {
      const incomingOrder = STEP_STATUS_ORDER[step.status] ?? 0;
      const existingOrder = STEP_STATUS_ORDER[existing.status] ?? 0;
      // Never regress status
      if (incomingOrder < existingOrder) return;
      // Same tier: use updated_at
      if (incomingOrder === existingOrder && step.updated_at < existing.updated_at) return;
    }

    moteDb.db
      .prepare(
        `INSERT OR REPLACE INTO sync_plan_steps
       (step_id, plan_id, motebit_id, ordinal, description, prompt, depends_on, optional, status,
        required_capabilities, delegation_task_id, result_summary, error_message, tool_calls_made,
        started_at, completed_at, retry_count, updated_at, assigned_motebit_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        step.step_id,
        step.plan_id,
        step.motebit_id,
        step.ordinal,
        step.description,
        step.prompt,
        step.depends_on,
        step.optional ? 1 : 0,
        step.status,
        step.required_capabilities,
        step.delegation_task_id,
        step.result_summary,
        step.error_message,
        step.tool_calls_made,
        step.started_at,
        step.completed_at,
        step.retry_count,
        step.updated_at,
        step.assigned_motebit_id ?? null,
      );
  }

  // --- Plan Sync: push plans ---
  app.post("/sync/:motebitId/plans", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const body = await c.req.json<{ plans: SyncPlan[] }>();
    if (!Array.isArray(body.plans)) {
      throw new HTTPException(400, { message: "Missing or invalid 'plans' field (must be array)" });
    }
    for (const plan of body.plans) {
      upsertSyncPlan(plan);
    }

    // Fan out to WebSocket clients
    const senderDeviceId = c.req.header("x-device-id");
    const peers = connections.get(motebitId);
    if (peers) {
      for (const plan of body.plans) {
        const payload = JSON.stringify({ type: "plan", plan });
        for (const peer of peers) {
          if (peer.deviceId !== senderDeviceId) {
            peer.ws.send(payload);
          }
        }
      }
    }

    return c.json({ motebit_id: motebitId, accepted: body.plans.length });
  });

  // --- Plan Sync: pull plans ---
  app.get("/sync/:motebitId/plans", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const since = Number(c.req.query("since") ?? "0");
    const rows = moteDb.db
      .prepare(
        `SELECT * FROM sync_plans WHERE motebit_id = ? AND updated_at > ? ORDER BY updated_at ASC`,
      )
      .all(motebitId, since) as SyncPlan[];
    return c.json({ motebit_id: motebitId, plans: rows, since });
  });

  // --- Plan Sync: push steps ---
  app.post("/sync/:motebitId/plan-steps", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const body = await c.req.json<{ steps: SyncPlanStep[] }>();
    if (!Array.isArray(body.steps)) {
      throw new HTTPException(400, { message: "Missing or invalid 'steps' field (must be array)" });
    }
    for (const step of body.steps) {
      upsertSyncPlanStep(step);
    }

    // Fan out to WebSocket clients
    const senderDeviceId = c.req.header("x-device-id");
    const peers = connections.get(motebitId);
    if (peers) {
      for (const step of body.steps) {
        const payload = JSON.stringify({ type: "plan_step", step });
        for (const peer of peers) {
          if (peer.deviceId !== senderDeviceId) {
            peer.ws.send(payload);
          }
        }
      }
    }

    return c.json({ motebit_id: motebitId, accepted: body.steps.length });
  });

  // --- Plan Sync: pull steps ---
  app.get("/sync/:motebitId/plan-steps", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const since = Number(c.req.query("since") ?? "0");
    const rows = moteDb.db
      .prepare(
        `SELECT * FROM sync_plan_steps WHERE motebit_id = ? AND updated_at > ? ORDER BY updated_at ASC`,
      )
      .all(motebitId, since) as SyncPlanStep[];
    // SQLite stores boolean as integer — normalize for wire format
    const normalized = rows.map((r) => ({ ...r, optional: Boolean(r.optional) }));
    return c.json({ motebit_id: motebitId, steps: normalized, since });
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
  }

  // --- Shared: build CandidateProfile[] from relay DB ---

  function buildCandidateProfiles(
    capabilityFilter?: string,
    maxBudget?: number,
    limit = 20,
    callerMotebitId?: string,
  ): { profiles: CandidateProfile[]; requirements: TaskRequirements } {
    const now = Date.now();

    // Query service listings, optionally filtered by capability
    let listingRows: Array<Record<string, unknown>>;
    if (capabilityFilter) {
      listingRows = moteDb.db
        .prepare(
          `SELECT l.*, r.public_key, r.expires_at
           FROM relay_service_listings l
           LEFT JOIN agent_registry r ON l.motebit_id = r.motebit_id
           WHERE EXISTS (SELECT 1 FROM json_each(l.capabilities) WHERE value = ?)
           LIMIT ?`,
        )
        .all(capabilityFilter, limit) as Array<Record<string, unknown>>;
    } else {
      listingRows = moteDb.db
        .prepare(
          `SELECT l.*, r.public_key, r.expires_at
           FROM relay_service_listings l
           LEFT JOIN agent_registry r ON l.motebit_id = r.motebit_id
           LIMIT ?`,
        )
        .all(limit) as Array<Record<string, unknown>>;
    }

    // Batch-fetch latency stats for all candidates in one query
    const latencyStmt = moteDb.db.prepare(
      `SELECT latency_ms FROM relay_latency_stats
       WHERE remote_motebit_id = ?
       ORDER BY recorded_at DESC LIMIT 100`,
    );

    const profiles: CandidateProfile[] = listingRows.map((row) => {
      const mid = row.motebit_id as string;
      const isOnline =
        (row.expires_at as number | null) != null && (row.expires_at as number) > now;

      const latencyRows = latencyStmt.all(mid) as Array<{ latency_ms: number }>;
      let latencyStats: { avg_ms: number; p95_ms: number; sample_count: number } | null = null;
      if (latencyRows.length > 0) {
        const vals = latencyRows.map((r) => r.latency_ms);
        const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
        const sorted = [...vals].sort((a, b) => a - b);
        const p95Idx = Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1);
        latencyStats = { avg_ms: avg, p95_ms: sorted[p95Idx]!, sample_count: vals.length };
      }

      const capabilities = JSON.parse(row.capabilities as string) as string[];
      const pricing = JSON.parse(row.pricing as string) as CapabilityPrice[];

      // Fetch caller's trust record for this candidate (enables semiring routing).
      // Uses raw DB query (sync) to stay in the synchronous .map() context.
      let trust_record: AgentTrustRecord | null = null;
      if (callerMotebitId) {
        const trustRow = moteDb.db
          .prepare(`SELECT * FROM agent_trust WHERE motebit_id = ? AND remote_motebit_id = ?`)
          .get(callerMotebitId, mid) as Record<string, unknown> | undefined;
        if (trustRow) {
          trust_record = {
            motebit_id: asMotebitId(trustRow.motebit_id as string),
            remote_motebit_id: asMotebitId(trustRow.remote_motebit_id as string),
            trust_level: trustRow.trust_level as string as AgentTrustLevel,
            public_key: trustRow.public_key as string | undefined,
            first_seen_at: trustRow.first_seen_at as number,
            last_seen_at: trustRow.last_seen_at as number,
            interaction_count: trustRow.interaction_count as number,
            successful_tasks: (trustRow.successful_tasks as number | null) ?? 0,
            failed_tasks: (trustRow.failed_tasks as number | null) ?? 0,
            notes: trustRow.notes as string | undefined,
          };
        }
      }

      return {
        motebit_id: asMotebitId(mid),
        trust_record,
        listing: {
          listing_id: asListingId(row.listing_id as string),
          motebit_id: asMotebitId(mid),
          capabilities,
          pricing,
          sla: {
            max_latency_ms: row.sla_max_latency_ms as number,
            availability_guarantee: row.sla_availability as number,
          },
          description: row.description as string,
          updated_at: row.updated_at as number,
        },
        latency_stats: latencyStats,
        is_online: isOnline,
      } satisfies CandidateProfile;
    });

    const requirements: TaskRequirements = {
      required_capabilities: capabilityFilter ? [capabilityFilter] : [],
      max_budget: maxBudget,
    };

    return { profiles, requirements };
  }

  // --- Spatial presence broadcast helper ---

  /**
   * Send a WebSocket event to all connections for a specific motebit_id.
   * Used for spatial presence events (AR/VR delegation animations).
   */
  function broadcastToMotebit(targetMotebitId: string, message: Record<string, unknown>): void {
    const targetConnections = connections.get(targetMotebitId);
    if (targetConnections) {
      const data = JSON.stringify(message);
      for (const conn of targetConnections) {
        if (conn.ws.readyState === 1) {
          conn.ws.send(data);
        }
      }
    }
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

    // Capture the submitter identity for spatial presence events and receipt fan-out.
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

    taskQueue.set(taskId, {
      task,
      expiresAt: now + TASK_TTL_MS,
      submitted_by: submittedBy,
      price_snapshot: priceSnapshot,
    });

    const requiredCaps = task.required_capabilities ?? [];
    const payload = JSON.stringify({ type: "task_request", task });
    let routed = false;

    // Phase 1: Scored routing — find best service agents from listings
    if (requiredCaps.length > 0) {
      try {
        const { profiles, requirements } = buildCandidateProfiles(
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

        if (eligibleProfiles.length > 0) {
          // Apply gradient-informed precision to routing weights when provided
          const explorationWeight =
            typeof body.exploration_drive === "number"
              ? Math.max(0, Math.min(1, body.exploration_drive))
              : undefined;
          const ranked = graphRankCandidates(
            asMotebitId(callerMotebitId ?? motebitId),
            eligibleProfiles,
            {
              ...requirements,
              required_capabilities: requiredCaps,
            },
            {
              maxCandidates: 10,
              explorationWeight,
            },
          );
          const selected = ranked.filter((r) => r.selected && r.composite > 0);

          if (selected.length > 0) {
            const selectedIds = new Set(selected.map((s) => s.motebit_id as string));
            // Route to connected devices belonging to selected agents
            for (const [peerId, peers] of connections) {
              if (!selectedIds.has(peerId)) continue;
              for (const peer of peers) {
                peer.ws.send(payload);
              }
            }
            routed = true;
          }
        }
      } catch (err) {
        // Re-throw intentional HTTP errors (e.g. 402 insufficient budget)
        if (err instanceof HTTPException) throw err;
        // Scoring failed — fall through to broadcast
      }
    }

    // Phase 2: Broadcast fallback — original behavior
    if (!routed) {
      const peers = connections.get(motebitId);
      if (peers) {
        for (const peer of peers) {
          if (requiredCaps.length > 0 && peer.capabilities) {
            const hasAll = requiredCaps.every((c) => peer.capabilities!.includes(c));
            if (!hasAll) continue;
          }
          peer.ws.send(payload);
        }
      }
    }

    // Spatial presence events — notify both parties for AR/VR delegation animation.
    // delegation_departed → submitter's spatial app: "your motebit has left"
    // delegation_arrived  → worker's spatial app:    "a visitor motebit has arrived"
    if (submittedBy) {
      broadcastToMotebit(submittedBy, {
        type: "delegation_departed",
        task_id: taskId,
        target_motebit_id: motebitId,
        submitted_by: submittedBy,
      });
    }
    broadcastToMotebit(motebitId, {
      type: "delegation_arrived",
      task_id: taskId,
      source_motebit_id: submittedBy ?? null,
      prompt: body.prompt.slice(0, 100),
    });

    return c.json({ task_id: taskId, status: task.status }, 201);
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

    if (!entry || entry.task.motebit_id !== motebitId) {
      throw new HTTPException(404, { message: "Task not found" });
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
    if (!entry || entry.task.motebit_id !== motebitId) {
      throw new HTTPException(404, { message: "Task not found" });
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

    // Cryptographic verification: resolve executing agent's public key and verify Ed25519 signature.
    // Try agent_registry first (service agents), then fall back to device records (personal agents).
    let pubKeyHex: string | undefined;
    const regRow = moteDb.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(receipt.motebit_id) as { public_key: string } | undefined;
    if (regRow?.public_key) {
      pubKeyHex = regRow.public_key;
    } else {
      // Fall back to device-level key lookup — try exact device_id match first,
      // then any device with a key (covers cross-device delegation where device_id may differ)
      const devices = await identityManager.listDevices(asMotebitId(receipt.motebit_id as string));
      const device =
        (receipt.device_id ? devices.find((d) => d.device_id === receipt.device_id) : undefined) ??
        devices.find((d) => d.public_key);
      if (device?.public_key) {
        pubKeyHex = device.public_key;
      }
    }

    if (!pubKeyHex) {
      throw new HTTPException(403, {
        message: "Receipt verification failed: no public key found for executing agent",
      });
    }

    const receiptValid = await verifyExecutionReceipt(receipt, hexToBytes(pubKeyHex));
    if (!receiptValid) {
      throw new HTTPException(403, {
        message: "Receipt verification failed: invalid Ed25519 signature",
      });
    }

    entry.receipt = receipt;
    // Extend TTL so recovery polling has a full window after completion
    entry.expiresAt = Math.max(entry.expiresAt, Date.now() + TASK_TTL_MS);
    entry.task.status =
      receipt.status === "completed"
        ? AgentTaskStatus.Completed
        : receipt.status === "denied"
          ? AgentTaskStatus.Denied
          : AgentTaskStatus.Failed;

    // Update trust record: increment task counts and evaluate level transitions.
    // This is the feedback loop that feeds the semiring computation graph.
    {
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
            // Emit trust transition event for audit trail (sibling of runtime's bumpTrustFromReceipt)
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
          // First verified interaction — initialize at FirstContact
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

    // Record latency for routing intelligence
    if (receipt.completed_at && entry.task.submitted_at) {
      const elapsed = receipt.completed_at - entry.task.submitted_at;
      if (elapsed > 0 && receipt.motebit_id) {
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

    // Settlement audit: record the receipt settlement with platform fee.
    // x402 handles the actual on-chain money movement; this is the relay's ledger.
    //
    // Uses the price_snapshot captured at task submission time so the relay's
    // accounting matches what x402 actually charged. If the agent changed pricing
    // between submission and receipt delivery, we settle at the original price.
    {
      try {
        // Gross amount = what x402 charged the caller (unit_cost + platform fee).
        // Prefers the snapshot captured at submission time; falls back to current
        // listing price for tasks submitted before snapshotting was deployed.
        const fallbackUnitCost = getListingUnitCost(receipt.motebit_id as string);
        const grossAmount =
          entry.price_snapshot ??
          (fallbackUnitCost > 0 ? fallbackUnitCost / (1 - PLATFORM_FEE_RATE) : 0);

        const settlementId = asSettlementId(crypto.randomUUID());
        const allocationId = asAllocationId(`x402-${taskId}`);
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

        moteDb.db
          .prepare(
            `INSERT INTO relay_settlements
             (settlement_id, allocation_id, motebit_id, receipt_hash, ledger_hash, amount_settled, platform_fee, platform_fee_rate, status, settled_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            settlement.settlement_id,
            settlement.allocation_id,
            motebitId,
            settlement.receipt_hash,
            settlement.ledger_hash,
            settlement.amount_settled,
            settlement.platform_fee,
            settlement.platform_fee_rate,
            settlement.status,
            settlement.settled_at,
          );
      } catch {
        // Best-effort settlement audit — don't block receipt delivery on accounting errors
      }
    }

    // Issue a reputation credential for the executing agent on successful receipt
    let credential_id: string | null = null;
    if (receipt.status === "completed") {
      try {
        // Compute agent reputation stats from latency records + receipt data
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

        // Derive subject DID from the executing agent's public key
        const subjectDid = pubKeyHex
          ? hexPublicKeyToDidKey(pubKeyHex)
          : `did:motebit:${receipt.motebit_id as string}`;

        const relayKeys = await getRelayKeypair();
        const vc = await issueReputationCredential(
          {
            success_rate: 1.0, // This receipt succeeded
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

        // Store the credential
        credential_id = crypto.randomUUID();
        const credentialType =
          vc.type.find((t) => t !== "VerifiableCredential") ?? "VerifiableCredential";
        moteDb.db
          .prepare(
            `INSERT INTO relay_credentials (credential_id, subject_motebit_id, issuer_did, credential_type, credential_json, issued_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            credential_id,
            receipt.motebit_id as string,
            vc.issuer,
            credentialType,
            JSON.stringify(vc),
            Date.now(),
          );
      } catch {
        // Best-effort credential issuance — don't block receipt delivery
      }
    }

    // Fan out task_result to all connected devices
    const peers = connections.get(motebitId);
    if (peers) {
      const payload = JSON.stringify({ type: "task_result", task_id: taskId, receipt });
      for (const peer of peers) {
        peer.ws.send(payload);
      }
    }

    // Spatial presence events — notify both parties for AR/VR return animation.
    // delegation_returning         → submitter's spatial app: "your motebit is coming home"
    // delegation_visitor_departing → worker's spatial app:    "the visitor is leaving"
    const receiptStatus = receipt.status === "completed" ? "completed" : "failed";
    const taskSubmittedBy = entry.submitted_by ?? entry.task.submitted_by;
    if (taskSubmittedBy) {
      broadcastToMotebit(taskSubmittedBy, {
        type: "delegation_returning",
        task_id: taskId,
        target_motebit_id: motebitId,
        status: receiptStatus,
        receipt_verified: true, // We only reach this point after successful Ed25519 verification
      });
    }
    broadcastToMotebit(motebitId, {
      type: "delegation_visitor_departing",
      task_id: taskId,
      source_motebit_id: taskSubmittedBy ?? null,
    });

    return c.json({ status: entry.task.status, credential_id });
  });

  // GET /agent/:motebitId/settlements — settlement history for this agent
  // eslint-disable-next-line @typescript-eslint/require-await -- Hono handler, sync SQLite
  app.get("/agent/:motebitId/settlements", async (c) => {
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

  // === Credential Verification (public, no auth) ===

  app.post("/api/v1/credentials/verify", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new HTTPException(400, { message: "Invalid JSON body" });
    }
    const vc = body as VerifiableCredential;
    if (
      !vc ||
      !Array.isArray(vc["@context"]) ||
      !Array.isArray(vc.type) ||
      !vc.issuer ||
      !vc.credentialSubject ||
      !vc.proof
    ) {
      throw new HTTPException(400, {
        message:
          "Invalid credential: missing required fields (@context, type, issuer, credentialSubject, proof)",
      });
    }

    const valid = await verifyVerifiableCredential(vc);
    return c.json({
      valid,
      issuer: vc.issuer,
      subject: vc.credentialSubject.id,
    });
  });

  // === Agent Discovery Registry ===

  // Auth middleware for agent registry routes
  app.use("/api/v1/agents/*", async (c, next) => {
    // Bootstrap is unauthenticated — handled by its own rate limiter
    if (c.req.path === "/api/v1/agents/bootstrap") {
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

    const agents = rows.map((r) => {
      const pk = r.public_key as string;
      let agentDid: string | undefined;
      try {
        if (pk) agentDid = hexPublicKeyToDidKey(pk);
      } catch {
        // Non-fatal
      }
      return {
        motebit_id: r.motebit_id,
        public_key: pk,
        did: agentDid,
        endpoint_url: r.endpoint_url,
        capabilities: JSON.parse(r.capabilities as string) as string[],
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions -- DB row field is untyped
        metadata: r.metadata ? (JSON.parse(r.metadata as string) as Record<string, unknown>) : null,
      };
    });

    return c.json({ agents });
  });

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

  // POST /api/v1/agents/:motebitId/revoke-credential — revoke a verifiable credential
  app.post("/api/v1/agents/:motebitId/revoke-credential", async (c) => {
    const motebitId = c.req.param("motebitId");
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (callerMotebitId && callerMotebitId !== motebitId) {
      throw new HTTPException(403, { message: "Cannot revoke credentials for another agent" });
    }
    const body = await c.req.json<{ credential_id: string; reason?: string }>();
    if (!body.credential_id) {
      throw new HTTPException(400, { message: "credential_id is required" });
    }
    moteDb.db
      .prepare(
        "INSERT OR REPLACE INTO relay_revoked_credentials (credential_id, motebit_id, reason) VALUES (?, ?, ?)",
      )
      .run(body.credential_id, motebitId, body.reason ?? null);
    return c.json({ ok: true, credential_id: body.credential_id });
  });

  // POST /api/v1/agents/:motebitId/revoke — mark agent identity as revoked
  app.post("/api/v1/agents/:motebitId/revoke", (c) => {
    const motebitId = c.req.param("motebitId");
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (callerMotebitId && callerMotebitId !== motebitId) {
      throw new HTTPException(403, { message: "Cannot revoke another agent" });
    }
    moteDb.db.prepare("UPDATE agent_registry SET revoked = 1 WHERE motebit_id = ?").run(motebitId);
    return c.json({ ok: true, motebit_id: motebitId, revoked: true });
  });

  // GET /api/v1/credentials/:credentialId/status — public credential revocation status
  app.get("/api/v1/credentials/:credentialId/status", (c) => {
    const credentialId = c.req.param("credentialId");
    const row = moteDb.db
      .prepare("SELECT revoked_at, reason FROM relay_revoked_credentials WHERE credential_id = ?")
      .get(credentialId) as { revoked_at: string; reason: string | null } | undefined;
    if (!row) {
      return c.json({ revoked: false });
    }
    return c.json({ revoked: true, revoked_at: row.revoked_at, reason: row.reason ?? "" });
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
         (listing_id, motebit_id, capabilities, pricing, sla_max_latency_ms, sla_availability, description, pay_to_address, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        now,
      );

    return c.json({ listing_id: listingId, updated_at: now }, 200);
  });

  // GET /api/v1/agents/:motebitId/credentials — list credentials issued to/by agent
  app.get("/api/v1/agents/:motebitId/credentials", (c) => {
    const mid = asMotebitId(c.req.param("motebitId"));
    const typeFilter = c.req.query("type");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);

    let rows: Array<{
      credential_id: string;
      credential_type: string;
      credential_json: string;
      issued_at: number;
    }>;
    if (typeFilter) {
      rows = moteDb.db
        .prepare(
          "SELECT credential_id, credential_type, credential_json, issued_at FROM relay_credentials WHERE subject_motebit_id = ? AND credential_type = ? ORDER BY issued_at DESC LIMIT ?",
        )
        .all(mid, typeFilter, limit) as typeof rows;
    } else {
      rows = moteDb.db
        .prepare(
          "SELECT credential_id, credential_type, credential_json, issued_at FROM relay_credentials WHERE subject_motebit_id = ? ORDER BY issued_at DESC LIMIT ?",
        )
        .all(mid, limit) as typeof rows;
    }

    const credentials = rows.map((r) => ({
      credential_id: r.credential_id,
      credential_type: r.credential_type,
      credential: JSON.parse(r.credential_json) as VerifiableCredential,
      issued_at: r.issued_at,
    }));

    return c.json({ motebit_id: mid, credentials });
  });

  // POST /api/v1/agents/:motebitId/presentation — bundle credentials into a signed VP
  app.post("/api/v1/agents/:motebitId/presentation", async (c) => {
    const mid = asMotebitId(c.req.param("motebitId"));
    const typeFilter = c.req.query("type");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10) || 100, 500);

    let rows: Array<{
      credential_json: string;
    }>;
    if (typeFilter) {
      rows = moteDb.db
        .prepare(
          "SELECT credential_json FROM relay_credentials WHERE subject_motebit_id = ? AND credential_type = ? ORDER BY issued_at DESC LIMIT ?",
        )
        .all(mid, typeFilter, limit) as typeof rows;
    } else {
      rows = moteDb.db
        .prepare(
          "SELECT credential_json FROM relay_credentials WHERE subject_motebit_id = ? ORDER BY issued_at DESC LIMIT ?",
        )
        .all(mid, limit) as typeof rows;
    }

    if (rows.length === 0) {
      throw new HTTPException(404, { message: "No credentials found for this agent" });
    }

    const credentials = rows.map((r) => JSON.parse(r.credential_json) as VerifiableCredential);

    const relayKeys = await getRelayKeypair();
    const vp = await createPresentation(credentials, relayKeys.privateKey, relayKeys.publicKey);

    return c.json({
      presentation: vp,
      credential_count: credentials.length,
      relay_did: publicKeyToDidKey(relayKeys.publicKey),
    });
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

    const { profiles, requirements } = buildCandidateProfiles(
      capability ?? undefined,
      maxBudget,
      limit,
    );

    const explorationStr = c.req.query("exploration_drive");
    const explorationWeight =
      explorationStr != null ? Math.max(0, Math.min(1, parseFloat(explorationStr))) : undefined;
    const ranked = graphRankCandidates(
      asMotebitId("relay"), // public endpoint, no caller identity
      profiles,
      requirements,
      { explorationWeight },
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
  if (process.env.NODE_ENV === "production" && !process.env.MOTEBIT_DB_PATH) {
    // eslint-disable-next-line no-console
    console.error(
      "FATAL: MOTEBIT_DB_PATH must be set in production (otherwise data is lost on restart)",
    );
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
  });
  app = relay.app;

  const port = Number(process.env.PORT ?? 3000);
  // eslint-disable-next-line no-console
  console.log(
    `Motebit sync relay config: db=${process.env.MOTEBIT_DB_PATH ?? ":memory:"} deviceAuth=${process.env.MOTEBIT_ENABLE_DEVICE_AUTH !== "false"}`,
  );
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
