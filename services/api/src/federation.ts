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
import {
  sign,
  verify,
  generateKeypair,
  publicKeyToDidKey,
  canonicalJson,
  bytesToHex,
  hexToBytes,
} from "@motebit/encryption";
// Federation handshake and heartbeat messages sign under the
// concat-ed25519-hex suite. The primitive call lives in
// @motebit/crypto's suite-dispatch; this service reaches through
// @motebit/encryption's sign/verify helpers (which delegate to the
// dispatcher). The `suite` literal below is the stable contract between
// services and the registry in @motebit/protocol.
const FEDERATION_SUITE = "motebit-concat-ed25519-hex-v1" as const;
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import type { ExecutionReceipt } from "@motebit/sdk";
import type { DatabaseDriver } from "@motebit/persistence";
import { createLogger } from "./logger.js";
import { FederationError } from "./errors.js";
import { FixedWindowLimiter } from "./rate-limiter.js";
import {
  createAnchoringTables,
  getSettlementProof,
  isSettlementPendingBatch,
} from "./anchoring.js";
import { createCredentialAnchoringTables } from "./credential-anchoring.js";
import { nextRetryDelay, DEFAULT_RETRY_POLICY } from "./retry-policy.js";
import type { RetryPolicy } from "./retry-policy.js";

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
  /** Enable/disable federation entirely. Default: true when endpointUrl is set. */
  enabled?: boolean;
  /** Maximum number of active peers. Default: 50. */
  maxPeers?: number;
  /** Auto-accept incoming peering proposals. Default: false (require manual confirm). */
  autoAcceptPeers?: boolean;
  /** Allowlist of relay IDs that can peer. Empty = allow any. */
  allowedPeers?: string[];
  /** Blocklist of relay IDs that cannot peer. Takes precedence over allowlist. */
  blockedPeers?: string[];
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

/** Revocation event propagated via federation heartbeat. */
export interface RevocationEvent {
  type: "agent_revoked" | "key_rotated" | "credential_revoked";
  motebit_id: string;
  credential_id?: string;
  new_public_key?: string;
  timestamp: number;
  signature: string;
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

// Re-export for test consumers that import from federation.ts
export { bytesToHex, hexToBytes };
/** @deprecated Use FixedWindowLimiter directly. Alias kept for test import compatibility. */
export { FixedWindowLimiter as PeerRateLimiter };

// === Database ===

/** Create federation-related tables (relay_identity, relay_peers, relay_federation_settlements). */
export function createFederationTables(db: DatabaseDriver): void {
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

  // Migration: Phase 5 trust tracking columns + Phase 6 protocol version
  for (const col of [
    "ALTER TABLE relay_peers ADD COLUMN trust_level TEXT NOT NULL DEFAULT 'first_contact'",
    "ALTER TABLE relay_peers ADD COLUMN successful_forwards INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE relay_peers ADD COLUMN failed_forwards INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE relay_peers ADD COLUMN peer_protocol_version TEXT",
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
      gross_amount INTEGER NOT NULL,
      fee_amount INTEGER NOT NULL,
      net_amount INTEGER NOT NULL,
      fee_rate REAL NOT NULL,
      settled_at INTEGER NOT NULL,
      receipt_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fed_settlements_task ON relay_federation_settlements(task_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_fed_settlements_dedup ON relay_federation_settlements(task_id, upstream_relay_id);
  `);

  // Revocation events for federation propagation
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_revocation_events (
      event_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      motebit_id TEXT NOT NULL,
      credential_id TEXT,
      new_public_key TEXT,
      timestamp INTEGER NOT NULL,
      signature TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_revocation_events_ts ON relay_revocation_events(timestamp);
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

  // Merkle batch anchoring tables (§7.6)
  createAnchoringTables(db);

  // Credential anchor batching tables (credential-anchor-v1.md)
  createCredentialAnchoringTables(db);
}

// === Revocation Event Helpers ===

const REVOCATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Module-level submitter for onchain revocation anchoring.
// Set once at relay startup via setRevocationAnchorSubmitter().
let revocationAnchorSubmitter:
  | {
      submitRevocation(publicKeyHex: string, timestamp: number): Promise<{ txHash: string }>;
      isAvailable(): Promise<boolean>;
    }
  | undefined;

/** Configure the onchain revocation anchor submitter. Called once at relay startup. */
export function setRevocationAnchorSubmitter(submitter: typeof revocationAnchorSubmitter): void {
  revocationAnchorSubmitter = submitter;
}

/** Insert a revocation event — called when an agent is revoked, key is rotated, or credential is revoked. */
export async function insertRevocationEvent(
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
  type: RevocationEvent["type"],
  motebitId: string,
  opts?: { credentialId?: string; newPublicKey?: string; revokedPublicKey?: string },
): Promise<RevocationEvent> {
  const timestamp = Date.now();
  const encoder = new TextEncoder();
  const payload = `revocation:${type}:${motebitId}:${timestamp}`;
  const sig = await sign(encoder.encode(payload), relayIdentity.privateKey);
  const signatureHex = bytesToHex(sig);
  const eventId = `rev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  db.prepare(
    "INSERT INTO relay_revocation_events (event_id, type, motebit_id, credential_id, new_public_key, timestamp, signature) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    eventId,
    type,
    motebitId,
    opts?.credentialId ?? null,
    opts?.newPublicKey ?? null,
    timestamp,
    signatureHex,
  );

  // Fire-and-forget onchain revocation anchor for key-level events.
  // Revocations are rare and urgent — anchor immediately, no batching.
  if (revocationAnchorSubmitter && opts?.revokedPublicKey) {
    anchorRevocationOnChain(opts.revokedPublicKey, timestamp).catch((err) => {
      logger.error("revocation.anchor_failed", {
        motebitId,
        type,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return {
    type,
    motebit_id: motebitId,
    credential_id: opts?.credentialId,
    new_public_key: opts?.newPublicKey,
    timestamp,
    signature: signatureHex,
  };
}

/** Anchor a revocation event onchain via the configured submitter. */
async function anchorRevocationOnChain(
  revokedPublicKeyHex: string,
  timestamp: number,
): Promise<void> {
  if (!revocationAnchorSubmitter) return;
  const available = await revocationAnchorSubmitter.isAvailable();
  if (!available) {
    logger.warn("revocation.anchor_submitter_unavailable", {
      publicKey: revokedPublicKeyHex.slice(0, 16) + "...",
    });
    return;
  }
  const { txHash } = await revocationAnchorSubmitter.submitRevocation(
    revokedPublicKeyHex,
    timestamp,
  );
  logger.info("revocation.anchored_onchain", {
    publicKey: revokedPublicKeyHex.slice(0, 16) + "...",
    txHash,
    timestamp,
  });
}

/** Query revocation events since a given timestamp. */
export function getRevocationEventsSince(db: DatabaseDriver, sinceTs: number): RevocationEvent[] {
  return db
    .prepare(
      "SELECT type, motebit_id, credential_id, new_public_key, timestamp, signature FROM relay_revocation_events WHERE timestamp > ? ORDER BY timestamp ASC",
    )
    .all(sinceTs) as RevocationEvent[];
}

/** Clean up revocation events older than TTL (7 days). */
export function cleanupRevocationEvents(db: DatabaseDriver): number {
  const cutoff = Date.now() - REVOCATION_TTL_MS;
  const result = db.prepare("DELETE FROM relay_revocation_events WHERE timestamp < ?").run(cutoff);
  return (result as { changes: number }).changes;
}

/** Process incoming revocation events from a peer relay. */
export async function processIncomingRevocations(
  db: DatabaseDriver,
  events: RevocationEvent[],
  peerPublicKey: Uint8Array,
): Promise<{ processed: number; rejected: number }> {
  const encoder = new TextEncoder();
  let processed = 0;
  let rejected = 0;

  for (const event of events) {
    // Verify peer signature
    const payload = `revocation:${event.type}:${event.motebit_id}:${event.timestamp}`;
    const valid = await verify(hexToBytes(event.signature), encoder.encode(payload), peerPublicKey);
    if (!valid) {
      rejected++;
      logger.warn("federation.revocation.invalid_signature", {
        type: event.type,
        motebitId: event.motebit_id,
      });
      continue;
    }

    switch (event.type) {
      case "agent_revoked": {
        // Mark agent as revoked in local cache if it exists
        try {
          db.prepare("UPDATE agent_registry SET revoked = 1 WHERE motebit_id = ?").run(
            event.motebit_id,
          );
        } catch {
          /* agent may not exist locally */
        }
        processed++;
        break;
      }
      case "key_rotated": {
        // Update pinned public key if we have this agent
        if (event.new_public_key) {
          try {
            db.prepare("UPDATE agent_registry SET public_key = ? WHERE motebit_id = ?").run(
              event.new_public_key,
              event.motebit_id,
            );
          } catch {
            /* agent may not exist locally */
          }
        }
        processed++;
        break;
      }
      case "credential_revoked": {
        // Store credential revocation
        if (event.credential_id) {
          db.prepare(
            "INSERT OR IGNORE INTO relay_revoked_credentials (credential_id, motebit_id, reason, revoked_by) VALUES (?, ?, 'Revoked via federation', 'federation')",
          ).run(event.credential_id, event.motebit_id);
        }
        processed++;
        break;
      }
      default:
        // Unknown event type — safely ignore
        break;
    }
  }

  return { processed, rejected };
}

// === Private Key Encryption (AES-256-GCM) ===

// Relay key encryption uses 600K iterations — same strength as user-facing identity files.
// The relay private key is long-lived, signs all federation messages, issues credentials,
// and settles budget. One-time cost at startup is acceptable for this threat model.
// Operator PIN (runtime/operator.ts) uses 100K because rate-limiting is the primary defense
// and PIN entry is frequent.
const PBKDF2_ITERATIONS = 600_000;
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

/** Check if a stored value is in encrypted format (`{salt}:{iv}:{ciphertext+tag}` hex) vs plaintext hex. */
export function isEncryptedFormat(value: string): boolean {
  const parts = value.split(":");
  return parts.length === 3 && parts.every((p) => p.length > 0 && p.length % 2 === 0);
}

// === Relay Identity ===

/**
 * Load existing relay identity from DB or generate a new one.
 *
 * When `passphrase` is provided (production mode), the private key is encrypted at rest
 * using AES-256-GCM with a PBKDF2-derived key. Without a passphrase (dev mode), the
 * private key is stored as plaintext hex for backward compatibility.
 */
export async function initRelayIdentity(
  db: DatabaseDriver,
  passphrase?: string,
): Promise<RelayIdentity> {
  const existing = db.prepare("SELECT * FROM relay_identity LIMIT 1").get() as
    | { relay_motebit_id: string; public_key: string; private_key_hex: string; did: string }
    | undefined;

  if (existing) {
    let privHex: string;
    if (isEncryptedFormat(existing.private_key_hex)) {
      if (!passphrase) {
        throw new Error(
          "Relay private key is encrypted but no passphrase provided (set MOTEBIT_RELAY_KEY_PASSPHRASE)",
        );
      }
      try {
        privHex = decryptPrivateKey(existing.private_key_hex, passphrase);
      } catch (err: unknown) {
        throw new Error(
          "Failed to decrypt relay private key — check MOTEBIT_RELAY_KEY_PASSPHRASE. The passphrase may be incorrect or the key file may be corrupted.",
          { cause: err },
        );
      }
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

  let storedPriv: string;
  if (passphrase) {
    try {
      storedPriv = encryptPrivateKey(privHex, passphrase);
    } catch (err: unknown) {
      throw new Error(
        "Failed to encrypt relay private key — MOTEBIT_RELAY_KEY_PASSPHRASE may contain invalid characters or a crypto error occurred.",
        { cause: err },
      );
    }
  } else {
    storedPriv = privHex;
  }

  // INSERT OR IGNORE: if another process inserted between our SELECT and INSERT,
  // this silently no-ops and we re-query to get the winner's identity.
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO relay_identity (relay_motebit_id, public_key, private_key_hex, did, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    )
    .run(relayMotebitId, pubHex, storedPriv, did, Date.now());

  if (result.changes === 0) {
    // Another process won the race — load their identity
    return initRelayIdentity(db, passphrase);
  }

  return {
    relayMotebitId,
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    publicKeyHex: pubHex,
    did,
  };
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
export async function sendHeartbeats(
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
): Promise<void> {
  const peers = db
    .prepare(
      "SELECT peer_relay_id, endpoint_url, missed_heartbeats, state FROM relay_peers WHERE state IN ('active', 'suspended')",
    )
    .all() as Array<{
    peer_relay_id: string;
    endpoint_url: string;
    missed_heartbeats: number;
    state: string;
  }>;

  if (peers.length === 0) return;

  const encoder = new TextEncoder();
  const timestamp = Date.now();
  const agentCount = (
    db.prepare("SELECT COUNT(*) as cnt FROM agent_registry").get() as { cnt: number }
  ).cnt;
  // Heartbeat signing payload format (FEDERATION_SUITE = motebit-concat-ed25519-hex-v1):
  //   `{relay_id}|{timestamp}|{suite}`  — UTF-8 concatenation, Ed25519 sign, hex encode
  const message = encoder.encode(
    `${relayIdentity.relayMotebitId}|${timestamp}|${FEDERATION_SUITE}`,
  );
  const signature = await sign(message, relayIdentity.privateKey);
  const signatureHex = bytesToHex(signature);

  const results = await Promise.allSettled(
    peers.map(async (peer) => {
      // Collect revocation events since this peer's last heartbeat
      const lastHb =
        (
          db
            .prepare("SELECT last_heartbeat_at FROM relay_peers WHERE peer_relay_id = ?")
            .get(peer.peer_relay_id) as { last_heartbeat_at: number | null } | undefined
        )?.last_heartbeat_at ?? 0;
      const revocations = getRevocationEventsSince(db, lastHb);

      const resp = await fetch(`${peer.endpoint_url}/federation/v1/peer/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          relay_id: relayIdentity.relayMotebitId,
          timestamp,
          agent_count: agentCount,
          signature: signatureHex,
          ...(revocations.length > 0 ? { revocations } : {}),
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
      // Hysteresis: decrement missed count by 1 rather than resetting to 0.
      // A suspended peer (3 misses) needs 3 consecutive successes to reactivate,
      // preventing rapid suspended↔active oscillation on flaky connections.
      const newMissed = Math.max(0, peer.missed_heartbeats - 1);
      const newState = newMissed === 0 ? "active" : peer.state;
      db.prepare(
        "UPDATE relay_peers SET missed_heartbeats = ?, state = ?, last_heartbeat_at = ? WHERE peer_relay_id = ?",
      ).run(newMissed, newState, Date.now(), peer.peer_relay_id);
    } else {
      const newMissed = peer.missed_heartbeats + 1;
      if (newMissed >= HEARTBEAT_REMOVE_THRESHOLD) {
        db.prepare(
          "UPDATE relay_peers SET missed_heartbeats = ?, state = 'removed' WHERE peer_relay_id = ?",
        ).run(newMissed, peer.peer_relay_id);
        logger.warn("federation.peer.suspended", { peerId: peer.peer_relay_id });
      } else if (newMissed >= HEARTBEAT_SUSPEND_THRESHOLD) {
        db.prepare(
          "UPDATE relay_peers SET missed_heartbeats = ?, state = 'suspended' WHERE peer_relay_id = ?",
        ).run(newMissed, peer.peer_relay_id);
        logger.warn("federation.peer.suspended", { peerId: peer.peer_relay_id });
      } else {
        db.prepare("UPDATE relay_peers SET missed_heartbeats = ? WHERE peer_relay_id = ?").run(
          newMissed,
          peer.peer_relay_id,
        );
        logger.warn("federation.heartbeat.missed", {
          peerId: peer.peer_relay_id,
          missed: newMissed,
        });
      }
    }
  }
}

// === Settlement Retry Queue ===

/**
 * Single tick: process pending settlement retries.
 * Exported for direct testing — the interval wrapper is `startSettlementRetryLoop`.
 *
 * Uses exponential backoff with jitter (see retry-policy.ts) to space retries:
 *   Attempt 0:    5s  +/- 1s
 *   Attempt 1:   10s  +/- 2s
 *   Attempt 2:   20s  +/- 4s
 *   Attempt 3:   40s  +/- 8s
 *   Attempt 4:   80s  +/- 16s
 *   Attempt 5:  160s  +/- 32s
 *   Attempt 6:  320s  +/- 64s
 *   Attempt 7:  640s  +/- 128s (capped at maxDelayMs=1h)
 *
 * After max retries (default 8): auto-refund via onRetryExhausted callback.
 */
export async function processSettlementRetries(
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
  onRetryExhausted?: (retry: {
    retry_id: string;
    settlement_id: string;
    task_id: string;
    peer_relay_id: string;
    payload_json: string;
  }) => void,
  retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<void> {
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
      // Fresh timestamp on each retry so the receiver accepts it (±5min drift check)
      settlementBody.timestamp = Date.now();
      const peerInfo = db
        .prepare("SELECT endpoint_url FROM relay_peers WHERE peer_relay_id = ?")
        .get(retry.peer_relay_id) as { endpoint_url: string } | undefined;

      if (!peerInfo) {
        // Peer no longer exists — mark failed
        db.prepare(
          "UPDATE relay_settlement_retries SET status = 'failed', last_error = ? WHERE retry_id = ?",
        ).run("Peer relay no longer exists", retry.retry_id);
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
        db.prepare(
          "UPDATE relay_settlement_retries SET status = 'completed' WHERE retry_id = ?",
        ).run(retry.retry_id);
      } else {
        throw new FederationError(
          "FEDERATION_FORWARD_FAILED",
          `HTTP ${resp.status}: ${resp.statusText}`,
        );
      }
    } catch (err: unknown) {
      const newAttempts = retry.attempts + 1;
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (newAttempts >= retry.max_attempts) {
        db.prepare(
          "UPDATE relay_settlement_retries SET status = 'failed', attempts = ?, last_error = ? WHERE retry_id = ?",
        ).run(newAttempts, errorMsg, retry.retry_id);
        // Auto-refund on exhaustion
        if (onRetryExhausted) {
          try {
            onRetryExhausted(retry);
          } catch (refundErr) {
            logger.warn("settlement.retry.refund_failed", {
              retryId: retry.retry_id,
              taskId: retry.task_id,
              error: refundErr instanceof Error ? refundErr.message : String(refundErr),
            });
          }
        }
      } else {
        const backoffMs = nextRetryDelay(newAttempts - 1, retryPolicy);
        const nextRetry = Date.now() + backoffMs;
        logger.info("settlement.retry.scheduled", {
          retryId: retry.retry_id,
          taskId: retry.task_id,
          attempt: newAttempts,
          maxAttempts: retry.max_attempts,
          backoffMs,
          nextRetryAt: nextRetry,
        });
        db.prepare(
          "UPDATE relay_settlement_retries SET attempts = ?, next_retry_at = ?, last_error = ? WHERE retry_id = ?",
        ).run(newAttempts, nextRetry, errorMsg, retry.retry_id);
      }
    }
  }
}

/** Start the settlement retry loop. Returns the interval handle for cleanup. */
export function startSettlementRetryLoop(
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
  intervalMs = 30_000,
  onRetryExhausted?: (retry: {
    retry_id: string;
    settlement_id: string;
    task_id: string;
    peer_relay_id: string;
    payload_json: string;
  }) => void,
  /** Optional guard — when it returns true, the loop iteration is skipped. */
  isFrozen?: () => boolean,
  /** Override default retry policy (backoff timing, max retries, jitter). */
  retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (isFrozen?.()) return;
    void processSettlementRetries(db, relayIdentity, onRetryExhausted, retryPolicy);
  }, intervalMs);
}

/** Start the heartbeat sender loop. Returns the interval handle for cleanup. */
export function startHeartbeatLoop(
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
  intervalMs = 60_000,
  /** Optional guard — when it returns true, the loop iteration is skipped. */
  isFrozen?: () => boolean,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (isFrozen?.()) return;
    void sendHeartbeats(db, relayIdentity);
  }, intervalMs);
}

// === Peer Signature Verification ===

/**
 * Look up an active peer and verify its Ed25519 signature over a payload.
 * Returns the peer's public key on success, throws HTTPException on failure.
 */
/** Maximum acceptable clock drift for federation request timestamps (±5 minutes). */
const FEDERATION_TIMESTAMP_DRIFT_MS = 300_000;

async function verifyPeerSignature(
  db: DatabaseDriver,
  peerId: string,
  signatureHex: string,
  payloadBytes: Uint8Array,
  allowedStates = ["active"],
  /** If provided, reject requests with timestamps outside ±5min drift. */
  timestamp?: number,
): Promise<string> {
  // Timestamp drift check — prevents replay attacks
  if (timestamp != null) {
    const drift = Math.abs(Date.now() - timestamp);
    if (drift > FEDERATION_TIMESTAMP_DRIFT_MS) {
      throw new HTTPException(400, {
        message: "Request timestamp outside acceptable drift (±5min)",
      });
    }
  }

  const stateList = allowedStates.map(() => "?").join(", ");
  const peer = db
    .prepare(
      `SELECT public_key FROM relay_peers WHERE peer_relay_id = ? AND state IN (${stateList})`,
    )
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

// === Federation Routes ===

export interface FederationDeps {
  db: DatabaseDriver;
  app: Hono;
  relayIdentity: RelayIdentity;
  federationConfig?: FederationConfig;
  federationQueryCache: Map<string, number>;

  /** Optional: returns circuit breaker state for a peer endpoint (observability). */
  getCircuitBreakerState?: (peerEndpoint: string) => {
    state: "closed" | "open" | "half_open";
    failures: number;
    successes: number;
    lastFailureAt: number;
    lastStateChangeAt: number;
  };

  /** Return local agents matching a query. Used by federated discovery. */
  queryLocalAgents(
    capability?: string,
    motebitId?: string,
    limit?: number,
    federatedOnly?: boolean,
  ): AgentInfo[];

  /** Called when a verified forwarded task arrives from a peer. */
  onTaskForwarded(task: VerifiedForwardedTask):
    | Promise<{
        status: "routed" | "pending" | "duplicate" | "rejected";
        task_id?: string;
        reason?: string;
      }>
    | {
        status: "routed" | "pending" | "duplicate" | "rejected";
        task_id?: string;
        reason?: string;
      };

  /** Called when a verified task result arrives from a peer. */
  onTaskResultReceived(result: VerifiedTaskResult): Promise<void>;

  /** Called when a verified settlement arrives from a peer. */
  onSettlementReceived(
    settlement: VerifiedSettlement,
  ): Promise<{ feeAmount: number; netAmount: number }> | { feeAmount: number; netAmount: number };
}

/** Register all 11 federation endpoints on the Hono app. */
export function registerFederationRoutes(deps: FederationDeps): void {
  const { db, app, relayIdentity, federationConfig, federationQueryCache } = deps;

  // Per-peer rate limiter: 30 requests per minute per relay_id.
  // Unlike the per-IP limiter in index.ts, this keys on the peer's relay_id
  // from the request body so one misbehaving peer cannot exhaust the quota
  // for all other peers.
  const peerLimiter = new FixedWindowLimiter(30, 60_000);

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

  // ── Federation governance enforcement ──

  // Resolve effective federation enabled state: explicit config wins,
  // otherwise enabled when endpointUrl is set.
  const federationEnabled =
    federationConfig?.enabled !== undefined
      ? federationConfig.enabled
      : federationConfig?.endpointUrl != null;

  const maxPeers = federationConfig?.maxPeers ?? 50;

  /** Throw 403 if federation is explicitly disabled. */
  function checkFederationEnabled(): void {
    if (!federationEnabled) {
      throw new HTTPException(403, { message: "Federation is disabled on this relay" });
    }
  }

  /** Throw 403 if the peer is blocked or not in the allowlist. */
  function checkPeerPolicy(relayId: string): void {
    if (federationConfig?.blockedPeers?.includes(relayId)) {
      throw new HTTPException(403, { message: "Peer is blocked" });
    }
    if (
      federationConfig?.allowedPeers &&
      federationConfig.allowedPeers.length > 0 &&
      !federationConfig.allowedPeers.includes(relayId)
    ) {
      throw new HTTPException(403, { message: "Peer is not in allowlist" });
    }
  }

  /** Extract major version from spec string like "motebit/relay-federation@1.0" → 1. */
  function parseMajorVersion(spec: string): number | null {
    const match = spec.match(/@(\d+)\./);
    return match ? parseInt(match[1]!, 10) : null;
  }

  const RELAY_SPEC_VERSION = "motebit/relay-federation@1.0";

  /**
   * Throw 403 if peer's protocol version is incompatible.
   * Per spec §11: relays with incompatible major versions MUST reject peering.
   */
  function checkVersionCompatibility(peerSpecVersion: string | undefined): void {
    if (!peerSpecVersion) return; // Pre-version peers accepted (all are v1.0)
    const ourMajor = parseMajorVersion(RELAY_SPEC_VERSION);
    const peerMajor = parseMajorVersion(peerSpecVersion);
    if (ourMajor != null && peerMajor != null && ourMajor !== peerMajor) {
      throw new HTTPException(403, {
        message: `Incompatible federation protocol version: peer=${peerSpecVersion}, local=${RELAY_SPEC_VERSION}`,
      });
    }
  }

  /** Throw 503 if the maximum number of active peers has been reached. */
  function checkMaxPeers(): void {
    const count = (
      db.prepare("SELECT COUNT(*) as cnt FROM relay_peers WHERE state = 'active'").get() as {
        cnt: number;
      }
    ).cnt;
    if (count >= maxPeers) {
      throw new HTTPException(503, { message: "Maximum peer limit reached" });
    }
  }

  // ── Phase 1: Identity ──

  app.get("/federation/v1/identity", (c) => {
    return c.json({
      spec: RELAY_SPEC_VERSION,
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
      spec_version?: string;
    }>();

    const { relay_id, public_key, endpoint_url, display_name, nonce, spec_version } = body;
    if (!relay_id || !public_key)
      throw new HTTPException(400, { message: "relay_id and public_key are required" });
    if (!endpoint_url) throw new HTTPException(400, { message: "endpoint_url is required" });
    if (!nonce) throw new HTTPException(400, { message: "nonce is required" });

    checkFederationEnabled();
    checkPeerPolicy(relay_id);
    checkVersionCompatibility(spec_version);
    checkPeerLimit(relay_id);
    checkMaxPeers();

    const existing = db
      .prepare("SELECT state, last_heartbeat_at FROM relay_peers WHERE peer_relay_id = ?")
      .get(relay_id) as { state: string; last_heartbeat_at: number | null } | undefined;
    if (existing && (existing.state === "active" || existing.state === "pending")) {
      throw new HTTPException(409, { message: `Peer already exists in ${existing.state} state` });
    }
    // Cooldown: removed peers must wait 5 minutes before re-peering.
    // Prevents rapid removed→pending oscillation when the root cause persists.
    if (
      existing &&
      existing.state === "removed" &&
      existing.last_heartbeat_at != null &&
      existing.last_heartbeat_at !== 0
    ) {
      const cooldownMs = 5 * 60 * 1000;
      const elapsed = Date.now() - existing.last_heartbeat_at;
      if (elapsed < cooldownMs) {
        const retryAfter = Math.ceil((cooldownMs - elapsed) / 1000);
        throw new HTTPException(429, {
          message: `Removed peer must wait ${retryAfter}s before re-peering`,
        });
      }
    }

    const ourNonceBytes = new Uint8Array(32);
    crypto.getRandomValues(ourNonceBytes);
    const ourNonce = bytesToHex(ourNonceBytes);

    // Sign relay_id + nonce + suite together so the challenge is bound
    // to this specific peer and to the cryptosuite. Prevents replay and
    // cross-suite confusion.
    const challengeMsg = new TextEncoder().encode(`${relay_id}:${nonce}:${FEDERATION_SUITE}`);
    const challengeSig = await sign(challengeMsg, relayIdentity.privateKey);

    db.prepare(
      `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, nonce, missed_heartbeats, agent_count, trust_score, peer_protocol_version)
       VALUES (?, ?, ?, ?, 'pending', ?, 0, 0, 0.5, ?)
       ON CONFLICT(peer_relay_id) DO UPDATE SET
         public_key = excluded.public_key, endpoint_url = excluded.endpoint_url,
         display_name = excluded.display_name, state = 'pending',
         nonce = excluded.nonce, missed_heartbeats = 0,
         peer_protocol_version = excluded.peer_protocol_version
         WHERE relay_peers.state NOT IN ('active', 'pending')`,
    ).run(relay_id, public_key, endpoint_url, display_name ?? null, ourNonce, spec_version ?? null);

    return c.json({
      relay_id: relayIdentity.relayMotebitId,
      public_key: relayIdentity.publicKeyHex,
      endpoint_url: federationConfig?.endpointUrl ?? "self",
      display_name: federationConfig?.displayName ?? null,
      nonce: ourNonce,
      challenge: bytesToHex(challengeSig),
      spec_version: RELAY_SPEC_VERSION,
    });
  });

  app.post("/federation/v1/peer/confirm", async (c) => {
    const body = await c.req.json<{ relay_id?: string; challenge_response?: string }>();
    const { relay_id, challenge_response } = body;
    if (!relay_id || !challenge_response) {
      throw new HTTPException(400, { message: "relay_id and challenge_response are required" });
    }

    checkFederationEnabled();
    checkPeerPolicy(relay_id);
    checkPeerLimit(relay_id);

    const peer = db
      .prepare("SELECT * FROM relay_peers WHERE peer_relay_id = ? AND state = 'pending'")
      .get(relay_id) as
      | { peer_relay_id: string; public_key: string; nonce: string | null }
      | undefined;
    if (!peer) throw new HTTPException(404, { message: "No pending peer found for this relay_id" });
    if (!peer.nonce) throw new HTTPException(400, { message: "No nonce stored for this peer" });

    // Verify: the peer signed their own relay_id + our nonce + suite
    // (bound to this specific relationship and cryptosuite).
    const confirmMsg = new TextEncoder().encode(`${relay_id}:${peer.nonce}:${FEDERATION_SUITE}`);
    const valid = await verify(
      hexToBytes(challenge_response),
      confirmMsg,
      hexToBytes(peer.public_key),
    );
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
      relay_id?: string;
      timestamp?: number;
      agent_count?: number;
      signature?: string;
      revocations?: RevocationEvent[];
    }>();
    const { relay_id, timestamp, agent_count, signature: sig, revocations } = body;
    if (!relay_id || timestamp == null || agent_count == null || !sig) {
      throw new HTTPException(400, {
        message: "relay_id, timestamp, agent_count, and signature are required",
      });
    }

    checkPeerLimit(relay_id);

    const peer = db
      .prepare(
        "SELECT * FROM relay_peers WHERE peer_relay_id = ? AND state IN ('active', 'suspended')",
      )
      .get(relay_id) as
      | { peer_relay_id: string; public_key: string; state: string; missed_heartbeats: number }
      | undefined;
    if (!peer) throw new HTTPException(404, { message: "No active or suspended peer found" });

    const encoder = new TextEncoder();
    const drift = Math.abs(Date.now() - timestamp);
    if (drift > 300_000) {
      // ±5 minutes
      throw new HTTPException(400, {
        message: "Heartbeat timestamp outside acceptable drift (±5min)",
      });
    }

    const valid = await verify(
      hexToBytes(sig),
      encoder.encode(`${relay_id}|${timestamp}|${FEDERATION_SUITE}`),
      hexToBytes(peer.public_key),
    );
    if (!valid)
      throw new HTTPException(403, { message: "Heartbeat signature verification failed" });

    const now = Date.now();
    // Hysteresis: decrement rather than reset, matching the sending side.
    const newMissed = Math.max(0, peer.missed_heartbeats - 1);
    const newState = newMissed === 0 ? "active" : peer.state;
    db.prepare(
      `UPDATE relay_peers SET last_heartbeat_at = ?, missed_heartbeats = ?, agent_count = ?, state = ? WHERE peer_relay_id = ?`,
    ).run(now, newMissed, agent_count, newState, relay_id);

    // Process incoming revocation events (best-effort)
    if (revocations && Array.isArray(revocations) && revocations.length > 0) {
      try {
        const peerPubKey = hexToBytes(peer.public_key);
        const result = await processIncomingRevocations(db, revocations, peerPubKey);
        if (result.rejected > 0) {
          logger.warn("federation.revocation.rejected", {
            peerId: relay_id,
            rejected: result.rejected,
          });
        }
        if (result.processed > 0) {
          logger.info("federation.revocation.processed", {
            peerId: relay_id,
            processed: result.processed,
          });
        }
      } catch (err) {
        logger.warn("federation.revocation.error", {
          peerId: relay_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const ourTimestamp = Date.now();
    const localAgentCount = (
      db.prepare("SELECT COUNT(*) as cnt FROM agent_registry").get() as { cnt: number }
    ).cnt;
    const responseSig = await sign(
      encoder.encode(`${relayIdentity.relayMotebitId}|${ourTimestamp}|${FEDERATION_SUITE}`),
      relayIdentity.privateKey,
    );

    return c.json({
      relay_id: relayIdentity.relayMotebitId,
      timestamp: ourTimestamp,
      agent_count: localAgentCount,
      signature: bytesToHex(responseSig),
    });
  });

  app.post("/federation/v1/peer/remove", async (c) => {
    const body = await c.req.json<{ relay_id?: string; signature?: string }>();
    const { relay_id, signature: sig } = body;
    if (!relay_id || !sig)
      throw new HTTPException(400, { message: "relay_id and signature are required" });

    checkPeerLimit(relay_id);

    const peer = db.prepare("SELECT * FROM relay_peers WHERE peer_relay_id = ?").get(relay_id) as
      | { peer_relay_id: string; public_key: string }
      | undefined;
    if (!peer) throw new HTTPException(404, { message: "Peer not found" });

    const valid = await verify(
      hexToBytes(sig),
      new TextEncoder().encode(relay_id),
      hexToBytes(peer.public_key),
    );
    if (!valid) throw new HTTPException(403, { message: "Removal signature verification failed" });

    db.prepare("UPDATE relay_peers SET state = 'removed' WHERE peer_relay_id = ?").run(relay_id);
    return c.json({ status: "removed" });
  });

  app.get("/federation/v1/peers", (c) => {
    const rows = db
      .prepare(
        `SELECT peer_relay_id, public_key, endpoint_url, display_name, state,
                peered_at, last_heartbeat_at, missed_heartbeats, agent_count, trust_score,
                successful_forwards, failed_forwards
         FROM relay_peers`,
      )
      .all() as Array<Record<string, unknown>>;

    // Enrich with circuit breaker state when available
    const enriched = rows.map((row) => {
      const endpoint = row.endpoint_url as string;
      const cbState = deps.getCircuitBreakerState?.(endpoint);
      return {
        ...row,
        circuit_breaker: cbState ?? null,
      };
    });

    return c.json({ peers: enriched });
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

    // Silent no-op when federation is disabled — return empty results, don't error
    if (!federationEnabled) {
      return c.json({ agents: [] });
    }

    checkPeerLimit(body.origin_relay);

    // Dedup
    if (federationQueryCache.has(body.query_id)) return c.json({ agents: [] });
    federationQueryCache.set(body.query_id, Date.now());

    // Loop prevention
    const visitedSet = new Set(body.visited);
    if (visitedSet.has(relayIdentity.relayMotebitId)) return c.json({ agents: [] });

    // Local results — exclude agents that opted out of federation visibility
    const localAgents = deps.queryLocalAgents(
      body.query.capability,
      body.query.motebit_id,
      body.query.limit ?? 20,
      true, // federatedOnly: respect federation_visible opt-out
    );
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
            headers: {
              "Content-Type": "application/json",
              "X-Correlation-ID": body.query_id,
            },
            body: JSON.stringify({
              query: body.query,
              hop_count: body.hop_count + 1,
              max_hops: body.max_hops,
              visited,
              query_id: body.query_id,
              origin_relay: body.origin_relay,
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
      task_id: string;
      origin_relay: string;
      target_agent: string;
      task_payload: {
        prompt: string;
        required_capabilities?: string[];
        submitted_by?: string;
        wall_clock_ms?: number;
      };
      routing_choice?: Record<string, unknown>;
      timestamp?: number;
      signature: string;
    }>();

    if (!body.task_id || !body.origin_relay || !body.target_agent || !body.task_payload?.prompt) {
      throw new HTTPException(400, { message: "Missing required fields" });
    }

    checkFederationEnabled();
    checkPeerLimit(body.origin_relay);

    // Federation owns: peer validation + signature verification + timestamp drift check
    const { signature, ...payload } = body;
    await verifyPeerSignature(
      db,
      body.origin_relay,
      signature,
      new TextEncoder().encode(canonicalJson(payload)),
      ["active"],
      body.timestamp,
    );

    // Check target agent exists locally. No `expires_at > now` filter —
    // liveness is checked by the wake-on-delegation hook in
    // `forwardTaskViaMcp` downstream, not by this existence gate. Gating
    // peer-forwards on a 15-min heartbeat window was punishing peers for
    // agent sleep, which they can't control.
    const agent = db
      .prepare("SELECT 1 FROM agent_registry WHERE motebit_id = ?")
      .get(body.target_agent);
    if (agent == null)
      throw new HTTPException(404, { message: "Target agent not found on this relay" });

    // Relay owns: task queuing and WebSocket routing
    const result = await deps.onTaskForwarded({
      taskId: body.task_id,
      originRelay: body.origin_relay,
      targetAgent: body.target_agent,
      payload: body.task_payload,
      routingChoice: body.routing_choice,
    });

    if (result.status === "duplicate") {
      return c.json({ task_id: body.task_id, status: "duplicate" }, 409);
    }
    if (result.status === "rejected") {
      return c.json({ task_id: body.task_id, status: "rejected", reason: result.reason }, 429);
    }

    return c.json(
      { task_id: body.task_id, status: result.status },
      result.status === "pending" ? 202 : 200,
    );
  });

  app.post("/federation/v1/task/result", async (c) => {
    const body = await c.req.json<{
      task_id: string;
      origin_relay: string;
      receipt: ExecutionReceipt;
      timestamp?: number;
      signature: string;
    }>();

    if (!body.task_id || !body.origin_relay || body.receipt == null) {
      throw new HTTPException(400, { message: "Missing required fields" });
    }

    checkPeerLimit(body.origin_relay);

    // Federation owns: peer validation + signature verification + timestamp drift check
    const { signature, ...payload } = body;
    await verifyPeerSignature(
      db,
      body.origin_relay,
      signature,
      new TextEncoder().encode(canonicalJson(payload)),
      ["active", "suspended"],
      body.timestamp,
    );

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
      task_id: string;
      settlement_id: string;
      origin_relay: string;
      gross_amount: number;
      receipt_hash: string;
      timestamp?: number;
      signature: string;
      x402_tx_hash?: string;
      x402_network?: string;
    }>();

    if (!body.task_id || !body.settlement_id || !body.origin_relay || body.gross_amount == null) {
      throw new HTTPException(400, { message: "Missing required fields" });
    }

    checkPeerLimit(body.origin_relay);

    // Federation owns: peer validation + signature verification + timestamp drift check
    const { signature, ...payload } = body;
    await verifyPeerSignature(
      db,
      body.origin_relay,
      signature,
      new TextEncoder().encode(canonicalJson(payload)),
      ["active", "suspended"],
      body.timestamp,
    );

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

    return c.json({
      status: "settled",
      fee_amount: result.feeAmount,
      net_amount: result.netAmount,
    });
  });

  app.get("/federation/v1/settlements", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
    const rows = db
      .prepare("SELECT * FROM relay_federation_settlements ORDER BY settled_at DESC LIMIT ?")
      .all(limit);
    return c.json({ settlements: rows });
  });

  // ── Phase 5: Settlement Proof (§7.6.6) ──

  app.get("/federation/v1/settlement/proof", async (c) => {
    const settlementId = c.req.query("settlement_id");
    if (!settlementId) {
      throw new HTTPException(400, { message: "settlement_id query parameter required" });
    }

    // Check if settlement exists but is not yet batched → 202 with retry hint
    if (isSettlementPendingBatch(db, settlementId)) {
      return c.json({ status: "pending", message: "Settlement not yet batched" }, 202, {
        "Retry-After": "60",
      });
    }

    const proof = await getSettlementProof(db, settlementId);
    if (!proof) {
      throw new HTTPException(404, { message: "Settlement not found or not batched" });
    }

    return c.json(proof);
  });
}
