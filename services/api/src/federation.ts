/**
 * Federation module — relay identity, peering, discovery, task forwarding, settlement.
 *
 * Owns the federation protocol: peer validation, Ed25519 signature verification,
 * discovery forwarding with loop prevention/dedup. Delegates business logic to
 * the relay via callbacks.
 *
 * All 11 federation endpoints registered here.
 */
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sign, verify, generateKeypair, publicKeyToDidKey, canonicalJson } from "@motebit/crypto";
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import type { ExecutionReceipt } from "@motebit/sdk";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "federation" });

// === Types ===

export interface RelayIdentity {
  relayMotebitId: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  publicKeyHex: string;
  did: string;
}

export interface FederationConfig {
  displayName?: string;
  endpointUrl?: string;
}

export interface AgentInfo {
  motebit_id: string;
  public_key: string;
  did?: string;
  endpoint_url: string;
  capabilities: string[];
  metadata: Record<string, unknown> | null;
}

/** Verified task forwarded from a peer relay. Signature already checked. */
export interface VerifiedForwardedTask {
  taskId: string;
  originRelay: string;
  targetAgent: string;
  payload: {
    prompt: string;
    required_capabilities?: string[];
    submitted_by?: string;
    wall_clock_ms?: number;
  };
  routingChoice?: Record<string, unknown>;
}

/** Verified task result from a peer relay. Signature already checked. */
export interface VerifiedTaskResult {
  taskId: string;
  originRelay: string;
  receipt: ExecutionReceipt;
}

/** Verified settlement from a peer relay. Signature already checked. */
export interface VerifiedSettlement {
  taskId: string;
  settlementId: string;
  originRelay: string;
  grossAmount: number;
  receiptHash: string;
  /** x402 on-chain transaction hash proving payment actually happened. */
  x402TxHash?: string;
  /** x402 network identifier (CAIP-2) for the payment chain. */
  x402Network?: string;
}

// === Helpers ===

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// === Database ===

/** Create federation-related tables (relay_identity, relay_peers, relay_federation_settlements). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any better-sqlite3 db
export function createFederationTables(db: any): void {
  // Relay identity — persistent Ed25519 keypair for credential signing, federation, verification.
  // Private key is encrypted at rest via AES-256-GCM when MOTEBIT_RELAY_KEY_PASSPHRASE is set.
  db.exec(`
      CREATE TABLE IF NOT EXISTS relay_identity (
        relay_motebit_id TEXT PRIMARY KEY,
        public_key       TEXT NOT NULL,
        private_key_hex  TEXT NOT NULL,
        did              TEXT NOT NULL,
        created_at       INTEGER NOT NULL
      );
  `);

  db.exec(`
      CREATE TABLE IF NOT EXISTS relay_peers (
        peer_relay_id     TEXT PRIMARY KEY,
        public_key        TEXT NOT NULL,
        endpoint_url      TEXT NOT NULL,
        display_name      TEXT,
        state             TEXT NOT NULL DEFAULT 'pending',
        peered_at         INTEGER,
        last_heartbeat_at INTEGER,
        missed_heartbeats INTEGER NOT NULL DEFAULT 0,
        agent_count       INTEGER NOT NULL DEFAULT 0,
        trust_score       REAL NOT NULL DEFAULT 0.5,
        nonce             TEXT
      );
  `);

  // Migration: Phase 5 trust tracking columns
  for (const col of [
    "ALTER TABLE relay_peers ADD COLUMN trust_level TEXT NOT NULL DEFAULT 'first_contact'",
    "ALTER TABLE relay_peers ADD COLUMN successful_forwards INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE relay_peers ADD COLUMN failed_forwards INTEGER NOT NULL DEFAULT 0",
  ]) {
    try {
      db.exec(col);
    } catch {
      /* column already exists */
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_federation_settlements (
      settlement_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      upstream_relay_id TEXT NOT NULL,
      downstream_relay_id TEXT,
      agent_id TEXT,
      gross_amount REAL NOT NULL,
      fee_amount REAL NOT NULL,
      net_amount REAL NOT NULL,
      fee_rate REAL NOT NULL,
      settled_at INTEGER NOT NULL,
      receipt_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fed_settlements_task ON relay_federation_settlements(task_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fed_settlements_dedup ON relay_federation_settlements(task_id, upstream_relay_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_settlement_retries (
      retry_id TEXT PRIMARY KEY,
      settlement_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      peer_relay_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      next_retry_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      last_error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_settlement_retries_next ON relay_settlement_retries(next_retry_at) WHERE status = 'pending';
  `);
}

// === Private Key Encryption (AES-256-GCM) ===

const PBKDF2_ITERATIONS = 100_000;
const AUTH_TAG_BYTES = 16;

/** Derive a 256-bit AES key from a passphrase and salt using PBKDF2. */
export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, 32, "sha256");
}

/** Encrypt a hex-encoded private key with AES-256-GCM. Returns `{salt}:{iv}:{ciphertext+authTag}` in hex. */
export function encryptPrivateKey(privHex: string, passphrase: string): string {
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(privHex, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${salt.toString("hex")}:${iv.toString("hex")}:${Buffer.concat([encrypted, authTag]).toString("hex")}`;
}

/** Decrypt an encrypted private key string (`{salt}:{iv}:{ciphertext+authTag}`). Returns the hex-encoded private key. */
export function decryptPrivateKey(encrypted: string, passphrase: string): string {
  const parts = encrypted.split(":");
  if (parts.length !== 3) throw new Error("Invalid encrypted key format");
  const salt = Buffer.from(parts[0]!, "hex");
  const iv = Buffer.from(parts[1]!, "hex");
  const combined = Buffer.from(parts[2]!, "hex");
  const ciphertext = combined.subarray(0, combined.length - AUTH_TAG_BYTES);
  const authTag = combined.subarray(combined.length - AUTH_TAG_BYTES);
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

/** Check if a stored value is in encrypted format (contains `:` separators) vs plaintext hex. */
export function isEncryptedFormat(value: string): boolean {
  return value.includes(":");
}

// === Relay Identity ===

/**
 * Load existing relay identity from DB or generate a new one.
 *
 * When `passphrase` is provided (production mode), the private key is encrypted at rest
 * using AES-256-GCM with a PBKDF2-derived key. Without a passphrase (dev mode), the
 * private key is stored as plaintext hex for backward compatibility.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any better-sqlite3 db
export async function initRelayIdentity(db: any, passphrase?: string): Promise<RelayIdentity> {
  const existing = db.prepare("SELECT * FROM relay_identity LIMIT 1").get() as
    | { relay_motebit_id: string; public_key: string; private_key_hex: string; did: string }
    | undefined;

  if (existing) {
    let privHex: string;
    if (isEncryptedFormat(existing.private_key_hex)) {
      if (!passphrase) {
        throw new Error("Relay private key is encrypted but no passphrase provided (set MOTEBIT_RELAY_KEY_PASSPHRASE)");
      }
      privHex = decryptPrivateKey(existing.private_key_hex, passphrase);
    } else {
      privHex = existing.private_key_hex;
    }
    return {
      relayMotebitId: existing.relay_motebit_id,
      publicKey: hexToBytes(existing.public_key),
      privateKey: hexToBytes(privHex),
      publicKeyHex: existing.public_key,
      did: existing.did,
    };
  }

  // First boot — generate and persist (race-safe: INSERT OR IGNORE + re-query)
  const keypair = await generateKeypair();
  const pubHex = bytesToHex(keypair.publicKey);
  const privHex = bytesToHex(keypair.privateKey);
  const did = publicKeyToDidKey(keypair.publicKey);
  const relayMotebitId = `relay-${crypto.randomUUID()}`;

  const storedPriv = passphrase ? encryptPrivateKey(privHex, passphrase) : privHex;

  // INSERT OR IGNORE: if another process inserted between our SELECT and INSERT,
  // this silently no-ops and we re-query to get the winner's identity.
  const result = db.prepare(
    `INSERT OR IGNORE INTO relay_identity (relay_motebit_id, public_key, private_key_hex, did, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(relayMotebitId, pubHex, storedPriv, did, Date.now());

  if (result.changes === 0) {
    // Another process won the race — load their identity
    return initRelayIdentity(db, passphrase);
  }

  return { relayMotebitId, publicKey: keypair.publicKey, privateKey: keypair.privateKey, publicKeyHex: pubHex, did };
}

// === Federation Query Dedup ===

const FEDERATION_QUERY_TTL_MS = 30_000;

export function createFederationQueryCache(): {
  cache: Map<string, number>;
  pruneInterval: ReturnType<typeof setInterval>;
} {
  const cache = new Map<string, number>();
  const pruneInterval = setInterval(() => {
    const cutoff = Date.now() - FEDERATION_QUERY_TTL_MS;
    for (const [id, ts] of cache) {
      if (ts < cutoff) cache.delete(id);
    }
  }, FEDERATION_QUERY_TTL_MS);
  return { cache, pruneInterval };
}

// === Heartbeat Sender ===

const HEARTBEAT_SUSPEND_THRESHOLD = 3;
const HEARTBEAT_REMOVE_THRESHOLD = 5;

/**
 * Single tick: send heartbeats to all active/suspended peers.
 * Exported for direct testing — the interval wrapper is `startHeartbeatLoop`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any better-sqlite3 db
export async function sendHeartbeats(db: any, relayIdentity: RelayIdentity): Promise<void> {
  const peers = db
    .prepare("SELECT peer_relay_id, endpoint_url, missed_heartbeats, state FROM relay_peers WHERE state IN ('active', 'suspended')")
    .all() as Array<{ peer_relay_id: string; endpoint_url: string; missed_heartbeats: number; state: string }>;

  if (peers.length === 0) return;

  const encoder = new TextEncoder();
  const timestamp = Date.now();
  const agentCount = (db.prepare("SELECT COUNT(*) as cnt FROM agent_registry").get() as { cnt: number }).cnt;
  const message = encoder.encode(`${relayIdentity.relayMotebitId}${timestamp}`);
  const signature = await sign(message, relayIdentity.privateKey);
  const signatureHex = bytesToHex(signature);

  const results = await Promise.allSettled(
    peers.map(async (peer) => {
      const resp = await fetch(`${peer.endpoint_url}/federation/v1/peer/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          relay_id: relayIdentity.relayMotebitId,
          timestamp,
          agent_count: agentCount,
          signature: signatureHex,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      return { peerId: peer.peer_relay_id, ok: resp.ok, missed: peer.missed_heartbeats };
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const peer = peers[i]!;
    const result = results[i]!;
    const succeeded = result.status === "fulfilled" && result.value.ok;

    if (succeeded) {
      // Reset missed count, reactivate if suspended
      db.prepare("UPDATE relay_peers SET missed_heartbeats = 0, state = 'active', last_heartbeat_at = ? WHERE peer_relay_id = ?")
        .run(Date.now(), peer.peer_relay_id);
    } else {
      const newMissed = peer.missed_heartbeats + 1;
      if (newMissed >= HEARTBEAT_REMOVE_THRESHOLD) {
        db.prepare("UPDATE relay_peers SET missed_heartbeats = ?, state = 'removed' WHERE peer_relay_id = ?")
          .run(newMissed, peer.peer_relay_id);
        logger.warn("federation.peer.suspended", { peerId: peer.peer_relay_id });
      } else if (newMissed >= HEARTBEAT_SUSPEND_THRESHOLD) {
        db.prepare("UPDATE relay_peers SET missed_heartbeats = ?, state = 'suspended' WHERE peer_relay_id = ?")
          .run(newMissed, peer.peer_relay_id);
        logger.warn("federation.peer.suspended", { peerId: peer.peer_relay_id });
      } else {
        db.prepare("UPDATE relay_peers SET missed_heartbeats = ? WHERE peer_relay_id = ?")
          .run(newMissed, peer.peer_relay_id);
        logger.warn("federation.heartbeat.missed", { peerId: peer.peer_relay_id, missed: newMissed });
      }
    }
  }
}

// === Settlement Retry Queue ===

/** Exponential backoff intervals: 30s, 2min, 8min, 32min, 2h */
const RETRY_BACKOFF_MS = [30_000, 120_000, 480_000, 1_920_000, 7_200_000];

/**
 * Single tick: process pending settlement retries.
 * Exported for direct testing — the interval wrapper is `startSettlementRetryLoop`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any better-sqlite3 db
export async function processSettlementRetries(db: any, relayIdentity: RelayIdentity): Promise<void> {
  const now = Date.now();
  const pending = db
    .prepare(
      "SELECT * FROM relay_settlement_retries WHERE status = 'pending' AND next_retry_at <= ? AND attempts < max_attempts",
    )
    .all(now) as Array<{
      retry_id: string;
      settlement_id: string;
      task_id: string;
      peer_relay_id: string;
      payload_json: string;
      attempts: number;
      max_attempts: number;
      next_retry_at: number;
      status: string;
      last_error: string | null;
      created_at: number;
    }>;

  if (pending.length === 0) return;

  for (const retry of pending) {
    try {
      const settlementBody = JSON.parse(retry.payload_json) as Record<string, unknown>;
      const peerInfo = db
        .prepare("SELECT endpoint_url FROM relay_peers WHERE peer_relay_id = ?")
        .get(retry.peer_relay_id) as { endpoint_url: string } | undefined;

      if (!peerInfo) {
        // Peer no longer exists — mark failed
        db.prepare("UPDATE relay_settlement_retries SET status = 'failed', last_error = ? WHERE retry_id = ?")
          .run("Peer relay no longer exists", retry.retry_id);
        continue;
      }

      const sigBytes = new TextEncoder().encode(canonicalJson(settlementBody));
      const sig = await sign(sigBytes, relayIdentity.privateKey);

      const resp = await fetch(`${peerInfo.endpoint_url}/federation/v1/settlement/forward`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Correlation-ID": retry.task_id },
        body: JSON.stringify({ ...settlementBody, signature: bytesToHex(sig) }),
        signal: AbortSignal.timeout(10_000),
      });

      if (resp.ok) {
        db.prepare("UPDATE relay_settlement_retries SET status = 'completed' WHERE retry_id = ?")
          .run(retry.retry_id);
      } else {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
      }
    } catch (err: unknown) {
      const newAttempts = retry.attempts + 1;
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (newAttempts >= retry.max_attempts) {
        db.prepare("UPDATE relay_settlement_retries SET status = 'failed', attempts = ?, last_error = ? WHERE retry_id = ?")
          .run(newAttempts, errorMsg, retry.retry_id);
      } else {
        const backoffMs = RETRY_BACKOFF_MS[Math.min(newAttempts - 1, RETRY_BACKOFF_MS.length - 1)]!;
        const nextRetry = Date.now() + backoffMs;
        db.prepare("UPDATE relay_settlement_retries SET attempts = ?, next_retry_at = ?, last_error = ? WHERE retry_id = ?")
          .run(newAttempts, nextRetry, errorMsg, retry.retry_id);
      }
    }
  }
}

/** Start the settlement retry loop. Returns the interval handle for cleanup. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function startSettlementRetryLoop(
  db: any,
  relayIdentity: RelayIdentity,
  intervalMs = 30_000,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    void processSettlementRetries(db, relayIdentity);
  }, intervalMs);
}

/** Start the heartbeat sender loop. Returns the interval handle for cleanup. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function startHeartbeatLoop(
  db: any,
  relayIdentity: RelayIdentity,
  intervalMs = 60_000,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    void sendHeartbeats(db, relayIdentity);
  }, intervalMs);
}

// === Peer Signature Verification ===

/**
 * Look up an active peer and verify its Ed25519 signature over a payload.
 * Returns the peer's public key on success, throws HTTPException on failure.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any better-sqlite3 db
async function verifyPeerSignature(
  db: any,
  peerId: string,
  signatureHex: string,
  payloadBytes: Uint8Array,
  allowedStates = ["active"],
): Promise<string> {
  const stateList = allowedStates.map(() => "?").join(", ");
  const peer = db
    .prepare(`SELECT public_key FROM relay_peers WHERE peer_relay_id = ? AND state IN (${stateList})`)
    .get(peerId, ...allowedStates) as { public_key: string } | undefined;
  if (!peer) {
    throw new HTTPException(403, { message: "Unknown or inactive peer relay" });
  }

  const valid = await verify(hexToBytes(signatureHex), payloadBytes, hexToBytes(peer.public_key));
  if (!valid) {
    throw new HTTPException(403, { message: "Invalid federation signature" });
  }
  return peer.public_key;
}

// === Per-Peer Rate Limiter ===

/**
 * Per-peer sliding window rate limiter for federation endpoints.
 * Keys on the relay_id from the request body, isolating each peer's
 * quota so one misbehaving peer cannot exhaust the limit for others.
 */
export class PeerRateLimiter {
  private windows: Map<string, { count: number; resetAt: number }> = new Map();

  constructor(
    private maxRequests: number,
    private windowMs: number,
  ) {}

  check(peerId: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    const entry = this.windows.get(peerId);

    if (!entry || entry.resetAt <= now) {
      const resetAt = now + this.windowMs;
      this.windows.set(peerId, { count: 1, resetAt });
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

// === Federation Routes ===

export interface FederationDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts any better-sqlite3 db
  db: any;
  app: Hono;
  relayIdentity: RelayIdentity;
  federationConfig?: FederationConfig;
  federationQueryCache: Map<string, number>;

  /** Return local agents matching a query. Used by federated discovery. */
  queryLocalAgents(capability?: string, motebitId?: string, limit?: number): AgentInfo[];

  /** Called when a verified forwarded task arrives from a peer. */
  onTaskForwarded(task: VerifiedForwardedTask): Promise<{ status: "routed" | "pending" }>;

  /** Called when a verified task result arrives from a peer. */
  onTaskResultReceived(result: VerifiedTaskResult): Promise<void>;

  /** Called when a verified settlement arrives from a peer. */
  onSettlementReceived(settlement: VerifiedSettlement): Promise<{ feeAmount: number; netAmount: number }>;
}

/** Register all 11 federation endpoints on the Hono app. */
export function registerFederationRoutes(deps: FederationDeps): void {
  const { db, app, relayIdentity, federationConfig, federationQueryCache } = deps;

  // Per-peer rate limiter: 30 requests per minute per relay_id.
  // Unlike the per-IP limiter in index.ts, this keys on the peer's relay_id
  // from the request body so one misbehaving peer cannot exhaust the quota
  // for all other peers.
  const peerLimiter = new PeerRateLimiter(30, 60_000);

  /** Check per-peer rate limit; throws HTTPException 429 if exceeded. */
  function checkPeerLimit(relayId: string): void {
    const { allowed, resetAt } = peerLimiter.check(relayId);
    if (!allowed) {
      const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
      throw new HTTPException(429, {
        message: `Per-peer rate limit exceeded (peer: ${relayId}), retry after ${retryAfter}s`,
      });
    }
  }

  // ── Phase 1: Identity ──

  // eslint-disable-next-line @typescript-eslint/require-await -- Hono handler, sync data
  app.get("/federation/v1/identity", async (c) => {
    return c.json({
      spec: "motebit/relay-federation@1.0",
      relay_motebit_id: relayIdentity.relayMotebitId,
      public_key: relayIdentity.publicKeyHex,
      did: relayIdentity.did,
    });
  });

  // ── Phase 2: Peering Protocol ──

  app.post("/federation/v1/peer/propose", async (c) => {
    const body = await c.req.json<{
      relay_id?: string;
      public_key?: string;
      endpoint_url?: string;
      display_name?: string;
      nonce?: string;
    }>();

    const { relay_id, public_key, endpoint_url, display_name, nonce } = body;
    if (!relay_id || !public_key) throw new HTTPException(400, { message: "relay_id and public_key are required" });
    if (!endpoint_url) throw new HTTPException(400, { message: "endpoint_url is required" });
    if (!nonce) throw new HTTPException(400, { message: "nonce is required" });

    checkPeerLimit(relay_id);

    const existing = db
      .prepare("SELECT state FROM relay_peers WHERE peer_relay_id = ?")
      .get(relay_id) as { state: string } | undefined;
    if (existing && (existing.state === "active" || existing.state === "pending")) {
      throw new HTTPException(409, { message: `Peer already exists in ${existing.state} state` });
    }

    const ourNonceBytes = new Uint8Array(32);
    crypto.getRandomValues(ourNonceBytes);
    const ourNonce = bytesToHex(ourNonceBytes);

    // Sign relay_id + nonce together so the challenge is bound to this specific peer.
    // Prevents replay: a signature from one peering attempt can't be reused for another.
    const challengeMsg = new TextEncoder().encode(`${relay_id}:${nonce}`);
    const challengeSig = await sign(challengeMsg, relayIdentity.privateKey);

    db.prepare(
      `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, nonce, missed_heartbeats, agent_count, trust_score)
       VALUES (?, ?, ?, ?, 'pending', ?, 0, 0, 0.5)
       ON CONFLICT(peer_relay_id) DO UPDATE SET
         public_key = excluded.public_key, endpoint_url = excluded.endpoint_url,
         display_name = excluded.display_name, state = 'pending',
         nonce = excluded.nonce, missed_heartbeats = 0
         WHERE relay_peers.state NOT IN ('active', 'pending')`,
    ).run(relay_id, public_key, endpoint_url, display_name ?? null, ourNonce);

    return c.json({
      relay_id: relayIdentity.relayMotebitId,
      public_key: relayIdentity.publicKeyHex,
      endpoint_url: federationConfig?.endpointUrl ?? "self",
      display_name: federationConfig?.displayName ?? null,
      nonce: ourNonce,
      challenge: bytesToHex(challengeSig),
    });
  });

  app.post("/federation/v1/peer/confirm", async (c) => {
    const body = await c.req.json<{ relay_id?: string; challenge_response?: string }>();
    const { relay_id, challenge_response } = body;
    if (!relay_id || !challenge_response) {
      throw new HTTPException(400, { message: "relay_id and challenge_response are required" });
    }

    checkPeerLimit(relay_id);

    const peer = db
      .prepare("SELECT * FROM relay_peers WHERE peer_relay_id = ? AND state = 'pending'")
      .get(relay_id) as { peer_relay_id: string; public_key: string; nonce: string | null } | undefined;
    if (!peer) throw new HTTPException(404, { message: "No pending peer found for this relay_id" });
    if (!peer.nonce) throw new HTTPException(400, { message: "No nonce stored for this peer" });

    // Verify: the peer signed their own relay_id + our nonce (bound to this specific relationship)
    const confirmMsg = new TextEncoder().encode(`${relay_id}:${peer.nonce}`);
    const valid = await verify(hexToBytes(challenge_response), confirmMsg, hexToBytes(peer.public_key));
    if (!valid) {
      db.prepare("DELETE FROM relay_peers WHERE peer_relay_id = ?").run(relay_id);
      throw new HTTPException(403, { message: "Challenge response verification failed" });
    }

    const now = Date.now();
    db.prepare(
      `UPDATE relay_peers SET state = 'active', peered_at = ?, last_heartbeat_at = ?, nonce = NULL WHERE peer_relay_id = ?`,
    ).run(now, now, relay_id);

    logger.info("federation.peer.active", { peerId: relay_id });

    return c.json({ status: "active", peered_at: now });
  });

  app.post("/federation/v1/peer/heartbeat", async (c) => {
    const body = await c.req.json<{
      relay_id?: string; timestamp?: number; agent_count?: number; signature?: string;
    }>();
    const { relay_id, timestamp, agent_count, signature: sig } = body;
    if (!relay_id || timestamp == null || agent_count == null || !sig) {
      throw new HTTPException(400, { message: "relay_id, timestamp, agent_count, and signature are required" });
    }

    checkPeerLimit(relay_id);

    const peer = db
      .prepare("SELECT * FROM relay_peers WHERE peer_relay_id = ? AND state IN ('active', 'suspended')")
      .get(relay_id) as { peer_relay_id: string; public_key: string; state: string } | undefined;
    if (!peer) throw new HTTPException(404, { message: "No active or suspended peer found" });

    const encoder = new TextEncoder();
    const drift = Math.abs(Date.now() - timestamp);
    if (drift > 300_000) { // ±5 minutes
      throw new HTTPException(400, { message: "Heartbeat timestamp outside acceptable drift (±5min)" });
    }

    const valid = await verify(hexToBytes(sig), encoder.encode(`${relay_id}${timestamp}`), hexToBytes(peer.public_key));
    if (!valid) throw new HTTPException(403, { message: "Heartbeat signature verification failed" });

    const now = Date.now();
    db.prepare(
      `UPDATE relay_peers SET last_heartbeat_at = ?, missed_heartbeats = 0, agent_count = ?, state = ? WHERE peer_relay_id = ?`,
    ).run(now, agent_count, peer.state === "suspended" ? "active" : peer.state, relay_id);

    const ourTimestamp = Date.now();
    const localAgentCount = (db.prepare("SELECT COUNT(*) as cnt FROM agent_registry").get() as { cnt: number }).cnt;
    const responseSig = await sign(encoder.encode(`${relayIdentity.relayMotebitId}${ourTimestamp}`), relayIdentity.privateKey);

    return c.json({
      relay_id: relayIdentity.relayMotebitId, timestamp: ourTimestamp,
      agent_count: localAgentCount, signature: bytesToHex(responseSig),
    });
  });

  app.post("/federation/v1/peer/remove", async (c) => {
    const body = await c.req.json<{ relay_id?: string; signature?: string }>();
    const { relay_id, signature: sig } = body;
    if (!relay_id || !sig) throw new HTTPException(400, { message: "relay_id and signature are required" });

    checkPeerLimit(relay_id);

    const peer = db
      .prepare("SELECT * FROM relay_peers WHERE peer_relay_id = ?")
      .get(relay_id) as { peer_relay_id: string; public_key: string } | undefined;
    if (!peer) throw new HTTPException(404, { message: "Peer not found" });

    const valid = await verify(hexToBytes(sig), new TextEncoder().encode(relay_id), hexToBytes(peer.public_key));
    if (!valid) throw new HTTPException(403, { message: "Removal signature verification failed" });

    db.prepare("UPDATE relay_peers SET state = 'removed' WHERE peer_relay_id = ?").run(relay_id);
    return c.json({ status: "removed" });
  });

  // eslint-disable-next-line @typescript-eslint/require-await -- Hono handler, sync data
  app.get("/federation/v1/peers", async (c) => {
    const rows = db
      .prepare(
        `SELECT peer_relay_id, public_key, endpoint_url, display_name, state,
                peered_at, last_heartbeat_at, missed_heartbeats, agent_count, trust_score
         FROM relay_peers`,
      )
      .all();
    return c.json({ peers: rows });
  });

  // ── Phase 3: Federated Discovery ──

  app.post("/federation/v1/discover", async (c) => {
    const body = await c.req.json<{
      query: { capability?: string; motebit_id?: string; limit?: number };
      hop_count: number;
      max_hops: number;
      visited: string[];
      query_id: string;
      origin_relay: string;
    }>();

    if (!body.query_id || body.max_hops > 3) {
      throw new HTTPException(400, { message: "Invalid federation query" });
    }

    checkPeerLimit(body.origin_relay);

    // Dedup
    if (federationQueryCache.has(body.query_id)) return c.json({ agents: [] });
    federationQueryCache.set(body.query_id, Date.now());

    // Loop prevention
    const visitedSet = new Set(body.visited);
    if (visitedSet.has(relayIdentity.relayMotebitId)) return c.json({ agents: [] });

    // Local results
    const localAgents = deps.queryLocalAgents(body.query.capability, body.query.motebit_id, body.query.limit ?? 20);
    const results = localAgents.map((a) => ({
      ...a,
      source_relay: relayIdentity.relayMotebitId,
      relay_name: federationConfig?.displayName ?? null,
      hop_distance: body.hop_count + 1,
    }));

    // hop_count is 0-based: 0 = direct peer, 1 = peer-of-peer, etc.
    // At hop_count >= max_hops, we've reached the limit — return local only, no forwarding.
    if (body.hop_count >= body.max_hops) return c.json({ agents: results });

    // Forward to active peers
    const visited = [...body.visited, relayIdentity.relayMotebitId];
    const peers = db
      .prepare("SELECT peer_relay_id, endpoint_url FROM relay_peers WHERE state = 'active'")
      .all() as Array<{ peer_relay_id: string; endpoint_url: string }>;

    const forwardPromises = peers
      .filter((p) => !visitedSet.has(p.peer_relay_id))
      .map(async (peer) => {
        try {
          const resp = await fetch(`${peer.endpoint_url}/federation/v1/discover`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Correlation-ID": body.query_id as string },
            body: JSON.stringify({
              query: body.query, hop_count: body.hop_count + 1, max_hops: body.max_hops,
              visited, query_id: body.query_id, origin_relay: body.origin_relay,
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
      .filter((r): r is PromiseFulfilledResult<Array<Record<string, unknown>>> => r.status === "fulfilled")
      .flatMap((r) => r.value);

    // Merge — prefer lowest hop_distance
    const merged = new Map<string, Record<string, unknown>>();
    for (const agent of [...results, ...peerResults]) {
      const id = agent.motebit_id as string;
      const prev = merged.get(id);
      if (!prev || (agent.hop_distance as number) < (prev.hop_distance as number)) {
        merged.set(id, agent);
      }
    }

    return c.json({ agents: [...merged.values()] });
  });

  // ── Phase 4: Task Forwarding ──

  app.post("/federation/v1/task/forward", async (c) => {
    const body = await c.req.json<{
      task_id: string; origin_relay: string; target_agent: string;
      task_payload: { prompt: string; required_capabilities?: string[]; submitted_by?: string; wall_clock_ms?: number };
      routing_choice?: Record<string, unknown>; signature: string;
    }>();

    if (!body.task_id || !body.origin_relay || !body.target_agent || !body.task_payload?.prompt) {
      throw new HTTPException(400, { message: "Missing required fields" });
    }

    checkPeerLimit(body.origin_relay);

    // Federation owns: peer validation + signature verification
    const { signature, ...payload } = body;
    await verifyPeerSignature(db, body.origin_relay, signature, new TextEncoder().encode(canonicalJson(payload)));

    // Check target agent exists locally
    const agent = db
      .prepare("SELECT 1 FROM agent_registry WHERE motebit_id = ? AND expires_at > ?")
      .get(body.target_agent, Date.now());
    if (!agent) throw new HTTPException(404, { message: "Target agent not found on this relay" });

    // Relay owns: task queuing and WebSocket routing
    const result = await deps.onTaskForwarded({
      taskId: body.task_id,
      originRelay: body.origin_relay,
      targetAgent: body.target_agent,
      payload: body.task_payload,
      routingChoice: body.routing_choice,
    });

    return c.json({ task_id: body.task_id, status: result.status }, result.status === "pending" ? 202 : 200);
  });

  app.post("/federation/v1/task/result", async (c) => {
    const body = await c.req.json<{
      task_id: string; origin_relay: string; receipt: ExecutionReceipt; signature: string;
    }>();

    if (!body.task_id || !body.origin_relay || !body.receipt) {
      throw new HTTPException(400, { message: "Missing required fields" });
    }

    checkPeerLimit(body.origin_relay);

    // Federation owns: peer validation + signature verification
    const { signature, ...payload } = body;
    await verifyPeerSignature(db, body.origin_relay, signature, new TextEncoder().encode(canonicalJson(payload)), ["active", "suspended"]);

    // Relay owns: task queue update, WebSocket fan-out, trust update, credential issuance, settlement
    await deps.onTaskResultReceived({
      taskId: body.task_id,
      originRelay: body.origin_relay,
      receipt: body.receipt,
    });

    return c.json({ status: "accepted" });
  });

  // ── Phase 5: Settlement ──

  app.post("/federation/v1/settlement/forward", async (c) => {
    const body = await c.req.json<{
      task_id: string; settlement_id: string; origin_relay: string;
      gross_amount: number; receipt_hash: string; signature: string;
      x402_tx_hash?: string; x402_network?: string;
    }>();

    if (!body.task_id || !body.settlement_id || !body.origin_relay || body.gross_amount == null) {
      throw new HTTPException(400, { message: "Missing required fields" });
    }

    checkPeerLimit(body.origin_relay);

    // Federation owns: peer validation + signature verification
    const { signature, ...payload } = body;
    await verifyPeerSignature(db, body.origin_relay, signature, new TextEncoder().encode(canonicalJson(payload)), ["active", "suspended"]);

    // Relay owns: fee calculation and recording
    const result = await deps.onSettlementReceived({
      taskId: body.task_id,
      settlementId: body.settlement_id,
      originRelay: body.origin_relay,
      grossAmount: body.gross_amount,
      receiptHash: body.receipt_hash,
      x402TxHash: body.x402_tx_hash,
      x402Network: body.x402_network,
    });

    return c.json({ status: "settled", fee_amount: result.feeAmount, net_amount: result.netAmount });
  });

  // eslint-disable-next-line @typescript-eslint/require-await -- Hono handler, sync data
  app.get("/federation/v1/settlements", async (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
    const rows = db
      .prepare("SELECT * FROM relay_federation_settlements ORDER BY settled_at DESC LIMIT ?")
      .all(limit);
    return c.json({ settlements: rows });
  });
}
