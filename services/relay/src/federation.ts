/**
 * Federation module — relay identity, peering, discovery, task forwarding, settlement.
 *
 * Owns the federation protocol: peer validation, Ed25519 signature verification,
 * discovery forwarding with loop prevention/dedup. Delegates business logic to
 * the relay via callbacks.
 *
 * All 11 federation endpoints registered here.
 */
import { beginForwardSend, forwardOf, markForwardDelivered } from "./allocation-escrow.js";
import { assertNotFrozen, isEmergencyFrozenAbort } from "./freeze.js";
import { EmergencyFrozenError } from "./errors.js";
import type { Hono } from "hono";
import { checkOutboundUrl } from "@motebit/sdk";
import type { OutboundUrlOptions } from "@motebit/sdk";
import { HTTPException } from "hono/http-exception";
import {
  sign,
  verify,
  generateKeypair,
  publicKeyToDidKey,
  canonicalJson,
  bytesToHex,
  fromBase64Url,
  hexToBytes,
} from "@motebit/encryption";
import {
  signAdjudicatorVote,
  signHorizonWitnessRequestBody,
  verifyHorizonWitnessRequestSignature,
  verifyWitnessOmissionDispute,
} from "@motebit/crypto";
import type { DisputeOutcome, VoteRequest } from "@motebit/protocol";
import {
  VoteRequestSchema,
  WitnessOmissionDisputeSchema,
  WitnessSolicitationRequestSchema,
} from "@motebit/wire-schemas";
import { persistWitnessOmissionDispute, resolveHorizonCertBySignature } from "./horizon.js";
// Federation handshake and heartbeat messages sign under the
// concat-ed25519-hex suite. The primitive call lives in
// @motebit/crypto's suite-dispatch; this service reaches through
// @motebit/encryption's sign/verify helpers (which delegate to the
// dispatcher). The `suite` literal below is the stable contract between
// services and the registry in @motebit/protocol.
const FEDERATION_SUITE = "motebit-concat-ed25519-hex-v1" as const;

/** How long a propose's nonce stays redeemable by a confirm. */
const PEER_HANDSHAKE_NONCE_TTL_MS = 10 * 60 * 1000;

/**
 * The peering handshake's wire version (spec/relay-federation-v1.md §3).
 * v1 — a confirm signed the bare `relay_id:nonce:suite` that every relay's
 * public `/peer/propose` also signed for any caller — is retired: that made
 * every relay a signing oracle for its own confirm. A request without
 * `handshake_version: "v2"` is refused 400 by name.
 */
export const FEDERATION_HANDSHAKE_VERSION = "v2" as const;

/**
 * The CONFIRM message: the prover relay's proof, to ONE verifier relay, that
 * it holds its key and wants to be reached at `endpointUrl`. Role-bound by its
 * prefix (no other signer in this relay signs a string with this prefix) and
 * bound to BOTH parties; `endpointUrl` is last, so the colon-free fields
 * before it parse unambiguously. Produced only by the operator-authenticated
 * `POST /api/v1/admin/federation/peer-confirm-signature`.
 */
export function federationConfirmMessage(
  proverRelayId: string,
  verifierRelayId: string,
  nonce: string,
  endpointUrl: string,
): string {
  return `motebit-federation-confirm:v2:${proverRelayId}:${verifierRelayId}:${nonce}:${FEDERATION_SUITE}:${endpointUrl}`;
}

/**
 * The PROPOSE response's `challenge`: the responder's proof, to the proposer,
 * that it holds the key it answered with. Its own prefix — never verifiable
 * as a confirm, whatever nonce the (unauthenticated) proposer chose.
 */
export function federationProposeMessage(
  responderRelayId: string,
  proposerRelayId: string,
  proposerNonce: string,
): string {
  return `motebit-federation-propose:v2:${responderRelayId}:${proposerRelayId}:${FEDERATION_SUITE}:${proposerNonce}`;
}
import { ON_SHELF, ON_SHELF_PREDICATE } from "./registry-delist.js";

/**
 * Wire-reported relay-federation spec version. Single source of truth for the
 * `spec` field in `/federation/v1/identity` and `spec_version` in peering
 * payloads. MUST match the H1 of `spec/relay-federation-v1.md` — enforced by
 * `RELAY_SPEC_VERSION matches spec doc H1` in `federation-e2e.test.ts`.
 *
 * When bumping the spec doc:
 * 1. Update `spec/relay-federation-v1.md` H1 + `**Version:**` line
 * 2. Update this constant
 * 3. Update consumer assertions (`federation-e2e.test.ts`, `scripts/test-federation-live.mjs`)
 * 4. Update `@spec` jsdoc annotations on each endpoint that changed
 */
export const RELAY_SPEC_VERSION = "motebit/relay-federation@1.5";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { ExecutionReceipt } from "@motebit/sdk";
import type { DatabaseDriver } from "@motebit/persistence";
import { createLogger } from "./logger.js";
import { anchorSubmitPacerFor } from "./anchor-submit-pacing.js";
import { submitRecordedAnchor, type AnchorBroadcastHooks } from "./anchor-broadcasts.js";
import { superviseInterval, type LoopSupervisor } from "./loop-supervisor.js";
import { FederationError } from "./errors.js";
import { FixedWindowLimiter } from "./rate-limiter.js";
import { getClientIp } from "./middleware.js";
import {
  createAnchoringTables,
  getSettlementProof,
  isSettlementPendingBatch,
} from "./anchoring.js";
import { createCredentialAnchoringTables } from "./credential-anchoring.js";
import { enrichWithHardwareAttestation, enrichWithLatencyStats } from "./agents.js";
import { nextRetryDelay, DEFAULT_RETRY_POLICY } from "./retry-policy.js";
import type { RetryPolicy } from "./retry-policy.js";
import { ExecutionReceiptSchema } from "@motebit/wire-schemas";

const logger = createLogger({ service: "relay", module: "federation" });

// === Types ===

export interface RelayIdentity {
  relayMotebitId: string;
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  publicKeyHex: string;
  did: string;
}

/**
 * The relay's transport to PEER RELAYS — every call one relay makes to
 * another (`/federation/v1/discover` fan-out and re-forward, `/task/forward`,
 * `/task/result` delivery, `/settlement/forward` and its retries,
 * `/peer/heartbeat`; and, through their own `fetchImpl` seams, the dispute
 * vote fan-out and horizon witness solicitation). Injected through
 * `SyncRelayConfig.federationPeerFetch`; omitted, it is the global `fetch`,
 * resolved at call time. Tests inject an in-process peer network
 * (`TEST_RELAY_NETWORK`), so a relay test whose peer is a registry row at a
 * fake endpoint never dials it.
 */
export type PeerFetch = typeof fetch;

/** The production peer transport: the global `fetch`, looked up per call. */
export const defaultPeerFetch: PeerFetch = (input, init) => globalThis.fetch(input, init);

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
  /**
   * Per-request timeout for outbound `POST /federation/v1/horizon/witness`
   * solicitations during a horizon advance (phase 4b-3). Default 10s
   * (`DEFAULT_WITNESS_SOLICITATION_TIMEOUT_MS` in horizon.ts).
   * Per-request timeout IS the overall solicitation deadline since the
   * orchestrator uses `Promise.allSettled` over a parallel fan-out.
   */
  witnessSolicitationTimeoutMs?: number;
  /**
   * Periodic interval for the revocation-events horizon advance loop.
   * Default 1h (`DEFAULT_REVOCATION_HORIZON_INTERVAL_MS` in horizon.ts).
   * Operational tuning knob, not a doctrinal commitment — anywhere from
   * minutes-to-hours is fine given the 7d TTL on revocation events.
   */
  revocationHorizonIntervalMs?: number;
  /**
   * Require a valid per-hop sender signature on inbound
   * `POST /federation/v1/discover` requests (relay-federation@1.3 §4.1 + §10.2).
   * Default: true since 1.4 (the 2026-07-21 sunset, #188) — an unsigned inbound
   * discover rejects (403). Set false ONLY to keep accepting unsigned discovers
   * from a peer still on < 1.3 — an explicit, owned fail-open for your own mesh
   * (cold-audit P0-3b). A PRESENT-but-invalid signature is ALWAYS rejected
   * regardless of this flag.
   */
  requireDiscoverSignature?: boolean;
  /**
   * Federation requests per minute per SOURCE (client IP), counted before
   * anything about the request is authenticated. Default 300. The per-peer
   * limit (30/min) counts a request only after its signature verified.
   */
  sourceRateLimitPerMinute?: number;
}

/**
 * Default for {@link FederationConfig.requireDiscoverSignature}, extracted to a
 * named const so the sunset forcing-test (#188) can assert it.
 *
 * **SUNSET EXECUTED 2026-07-21 (#188) — strict is the default.** The tolerant
 * pre-sunset default was a P0 fail-open (cold-audit finding P0-3b): an unsigned
 * inbound discover was accepted during the relay-federation@1.3 rollout window,
 * to spare an unknown, un-upgraded self-hosted peer a hard 403. The window
 * closed on schedule (announced in spec `relay-federation-v1.md` §4.1.1 +
 * `docs/operator/self-host.md`): an unsigned inbound discover now rejects (403).
 * An operator who still needs tolerant sets `requireDiscoverSignature: false`
 * explicitly — a named, owned decision, no longer a silent default. The flip is
 * enforced by the dated test in
 * `services/relay/src/__tests__/federation-discover-sunset.test.ts`.
 */
export const DEFAULT_REQUIRE_DISCOVER_SIGNATURE = true;

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
  /**
   * Cross-operator federated P2P proof (off-ramp arc § federated P2P). When
   * present, the delegator paid the worker + both operator fee legs onchain in
   * one atomic tx; the executor relay settles `settlement_mode='p2p'` (no
   * relay-custody credit) and verifies the worker + its own fee leg. Carried
   * inside the SIGNED forward body, so it is integrity-protected peer-to-peer.
   */
  paymentProof?: {
    tx_hash: string;
    chain: string;
    network: string;
    to_address: string;
    amount_micro: number;
    fee_to_address: string;
    fee_amount_micro: number;
    b_fee_to_address?: string;
    b_fee_amount_micro?: number;
  };
}

/** Verified task result from a peer relay. Signature already checked. */
export interface VerifiedTaskResult {
  taskId: string;
  originRelay: string;
  receipt: ExecutionReceipt;
  /**
   * The executing worker's public key (hex), as held by the executor relay's
   * agent_registry. The worker is registered on the executor relay, not the
   * origin — so the origin needs this to verify the worker's inner receipt
   * signature (and, for sovereign ids, the key→motebit_id binding). Absent when
   * the executor relay had no key on file.
   */
  agentPublicKey?: string;
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

  // A propose writes NOTHING: its nonce is self-authenticating (an HMAC this
  // relay minted over the proposer's id and key), so an unauthenticated
  // propose has no power over a row or over another party's handshake. A
  // nonce is recorded here only when a confirm that verified redeems it —
  // single use, kept until it would have expired anyway.
  db.exec(`
      CREATE TABLE IF NOT EXISTS relay_peer_handshake_nonces (
        nonce         TEXT PRIMARY KEY,
        peer_relay_id TEXT NOT NULL,
        expires_at    INTEGER NOT NULL
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
      receipt_hash TEXT NOT NULL,
      -- The verbatim canonical bytes of the signed FederationSettlementRecord
      -- this relay booked (canonicalJson of the record), written at settlement
      -- time by federation-callbacks.ts. The Merkle anchor leaf is SHA-256 of
      -- THESE bytes (RFC 6962 section 2.1 leaf tag under v2), so a peer holding
      -- the record reproduces it — the section 9.1 verbatim-artifact convergence.
      -- NULL for any pre-PR6 row (skipped by the anchor loop, which requires it).
      -- Migration v29 adds this to existing prod DBs; a fresh DB gets it here.
      record_json TEXT,
      -- Allocation escrow (allocation-escrow.ts, migration v55): a SENT forward
      -- (downstream_relay_id set) is stamped with the origin allocation whose
      -- escrow it moved, and carries an explicit lifecycle — 'pending' until the
      -- peer acknowledges ('delivered') or retries are exhausted ('failed', the
      -- gross returned to escrow). Inbound (final-hop) rows: allocation_id NULL.
      allocation_id TEXT,
      status TEXT NOT NULL DEFAULT 'delivered'
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

/**
 * Revocation-events retention TTL — 7 days. Phase 4b-3 promotes this
 * from the implicit constant of `cleanupRevocationEvents` (removed) to
 * the cutoff passed into `advanceRevocationHorizon` (horizon.ts), and
 * to the declared `horizon_advance_period_days: 7` in commit 5's
 * operator retention manifest projection.
 */
export const REVOCATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Module-level submitter for onchain revocation anchoring.
// Set once at relay startup via setRevocationAnchorSubmitter().
let revocationAnchorSubmitter:
  | {
      submitRevocation(
        publicKeyHex: string,
        timestamp: number,
        hooks?: AnchorBroadcastHooks,
      ): Promise<{ txHash: string }>;
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
  opts?: {
    credentialId?: string;
    newPublicKey?: string;
    revokedPublicKey?: string;
    /**
     * Effective revocation time (epoch ms) — the moment the key ceased to be
     * authoritative. This is what the on-chain memo carries and what verifiers
     * honor: a receipt dated at/after it fails binding. MUST be ≤ the recording
     * time; a future, non-finite, or non-positive value is clamped to the
     * recording time so a revocation can only ever be backdated, never
     * forward-dated. Defaults to the recording time. A caller that knows the
     * true compromise moment narrows the verifier's `[true compromise, recorded
     * revocation)` poison window: a governance revoke passes a backdated
     * `compromised_at`, and a succession-driven rotation passes the
     * guardian-attested succession `timestamp`. See `credential-anchor-v1.md`
     * §10.2.
     */
    effectiveAt?: number;
  },
): Promise<RevocationEvent> {
  // Recording time: the federation-sync ordering key (`getRevocationEventsSince`
  // filters on it) and the signed-payload component peers reverify. Never
  // backdated — a `timestamp` below a peer's sync cursor would silently drop the
  // event from propagation, and changing the signed payload would break the
  // federation signature contract.
  const recordedAt = Date.now();
  // Effective time: only the on-chain memo (and thus the verifier) sees this.
  const effectiveAt =
    opts?.effectiveAt != null &&
    Number.isFinite(opts.effectiveAt) &&
    opts.effectiveAt > 0 &&
    opts.effectiveAt <= recordedAt
      ? opts.effectiveAt
      : recordedAt;
  const encoder = new TextEncoder();
  const payload = `revocation:${type}:${motebitId}:${recordedAt}`;
  const sig = await sign(encoder.encode(payload), relayIdentity.privateKey);
  const signatureHex = bytesToHex(sig);
  const eventId = `rev-${recordedAt}-${Math.random().toString(36).slice(2, 8)}`;

  db.prepare(
    "INSERT INTO relay_revocation_events (event_id, type, motebit_id, credential_id, new_public_key, timestamp, signature) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    eventId,
    type,
    motebitId,
    opts?.credentialId ?? null,
    opts?.newPublicKey ?? null,
    recordedAt,
    signatureHex,
  );

  // Fire-and-forget onchain revocation anchor for key-level events.
  // Revocations are rare and urgent — anchor immediately, no batching.
  // The memo carries the EFFECTIVE time, not the recording time.
  if (revocationAnchorSubmitter && opts?.revokedPublicKey) {
    anchorRevocationOnChain(db, opts.revokedPublicKey, effectiveAt).catch((err) => {
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
    timestamp: recordedAt,
    signature: signatureHex,
  };
}

/** Anchor a revocation event onchain via the configured submitter. */
async function anchorRevocationOnChain(
  db: DatabaseDriver,
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
  // Serialized with the other anchoring streams and feeding their shared
  // backoff, but never deferred by it: a revocation is a one-shot urgent write
  // with no backlog to retry it from (anchor-submit-pacing.ts).
  const submitter = revocationAnchorSubmitter;
  const { txHash } = await anchorSubmitPacerFor(submitter).submit(
    "revocation",
    revokedPublicKeyHex.slice(0, 16),
    // Sign → record → send → confirm that signature (anchor-broadcasts.ts).
    () =>
      submitRecordedAnchor(
        db,
        submitter,
        "revocation",
        `${revokedPublicKeyHex}:${timestamp}`,
        (hooks) => submitter.submitRevocation(revokedPublicKeyHex, timestamp, hooks),
      ),
    { gate: false },
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

// `cleanupRevocationEvents` was removed in phase 4b-3 (commit 4) — the
// informal sync purge is replaced by `advanceRevocationHorizon` in
// horizon.ts, which signs an `append_only_horizon` cert (self-witnessed
// or co-witnessed via federation fan-out) and persists it before
// truncating. The 7d TTL stays as `REVOCATION_TTL_MS` (above) and
// surfaces as the declared `horizon_advance_period_days: 7` in commit
// 5's manifest projection.

/**
 * Process incoming revocation events from a peer relay.
 *
 * A peer signature establishes AUTHORSHIP of the statement. It does not
 * establish AUTHORITY over the identity the statement names, and the two must
 * not be conflated here, because peering is not an authorization:
 * `/federation/v1/peer/propose` followed by `/federation/v1/peer/confirm` are
 * two unauthenticated calls, and `autoAcceptPeers` is not consulted by either
 * (see `federation-independent-operators.test.ts` — "two independent
 * operators, no shared admin token"). So "this event carries a valid peer
 * signature" is a property anyone who can reach this relay can produce for
 * themselves, and it cannot be the thing that authorizes a write.
 *
 * Every row in `agent_registry` was written by a door with a NAMED authorized
 * principal. The principal is not always the identity's current key, and the
 * invariant is authorization rather than current-key possession: registration
 * and bootstrap admit on a key the identity already holds (behind
 * `refusePublicDeviceRegistration`) and `/rotate-key` proves possession of the
 * current key, but guardian recovery is authorized by the identity's own
 * designated guardian, operator moderation by the operator under a signed
 * append-only `relay_agent_revocations` record, and the migration accept by a
 * verified migration token plus a credential bundle checked against the
 * presented key. A peer is none of those principals, and carries nothing that
 * would make it one. `services/relay/CLAUDE.md` rule 21 requires every door
 * that writes `agent_registry.public_key` to answer to the shared rule or to
 * say what roots its authority instead. This door's answer is that it has
 * none, so it writes nothing there.
 *
 * Refusing costs no working behaviour. `agent_registry` holds only identities
 * registered HERE — remote agents are never cached into it, and
 * `federation_visible` is an opt-out on local rows — while the outbound feed
 * (`insertRevocationEvent`) is only ever minted about this relay's own
 * identities. An inbound event therefore describes the SENDER's identity, and
 * could only match a local row by naming an identity that is not the sender's.
 * That match is the defect, not a feature: nothing emits it, and migration
 * departure deliberately does not (`migration.ts` marks the row revoked
 * locally and mints no event).
 *
 * `credential_revoked` is refused for the same reason, and the reasoning that
 * once spared it was wrong: "the table is federation-native" describes storage
 * provenance and "the write only denies" describes blast direction. Neither is
 * a grant of authority. This relay already has an authority model for that
 * act, stated and enforced on its own door — `POST
 * /api/v1/agents/:motebitId/revoke-credential` answers 403 "Only the
 * credential subject or issuer can revoke", checked against
 * `relay_credentials.issuer_did`. A peer is neither, `credential_id` is not
 * covered by the signature verified above, and nothing in the event asserts
 * that the sender speaks for either principal. The table also has no foreign
 * key and the write is `INSERT OR IGNORE`, so a named id need not exist: an
 * unrefused event can poison an identifier before it is ever issued.
 *
 * Refusing it has a real cost, stated rather than glossed: a credential
 * legitimately revoked on a peer no longer becomes revoked here, so this
 * direction now fails OPEN on honest revocations in exchange for closing an
 * unauthorized write. Restoring it needs the issuer's or subject's OWN signed
 * revocation carried in the event and verified against that identity's key —
 * the same shape as the unsigned `new_public_key` field, and the same
 * federation wire increment.
 *
 * What remains applicable from an inbound feed is therefore nothing: with all
 * three branches grounded, this handler can act with authority on no event the
 * current wire format can carry. That is the honest state of the feature, and
 * naming it is better than keeping a door open to look busy.
 *
 * The scoping precedent is already in this file. `POST
 * /federation/v1/horizon/witness` refuses a request whose `cert_body.subject`
 * is not the soliciting `issuer_id` — "stops a relay from soliciting witnesses
 * for a cert it doesn't own" — and `/horizon/dispute` refuses a cert this
 * relay did not issue. A peer may speak about itself. This door had simply
 * drifted from a rule its siblings already kept.
 *
 * `refused` counts two shapes, not one. For `agent_revoked` and `key_rotated`
 * it is the cross-authority case: an event naming an identity this relay
 * holds. For `credential_revoked` it is EVERY event, whatever the subject's
 * locality, because the authority a peer lacks there is over the credential
 * rather than over the registry row. An `agent_revoked` or `key_rotated` event
 * about an identity we do not hold is still `processed` with no local effect,
 * exactly as before, so an honest peer's feed stays quiet on those two.
 */
export async function processIncomingRevocations(
  db: DatabaseDriver,
  events: RevocationEvent[],
  peerPublicKey: Uint8Array,
): Promise<{ processed: number; rejected: number; refused: number }> {
  const encoder = new TextEncoder();
  let processed = 0;
  let rejected = 0;
  let refused = 0;

  /** True when this relay is the identity's home — the rows a peer may not touch. */
  const heldLocally = (motebitId: string): boolean =>
    db.prepare("SELECT 1 FROM agent_registry WHERE motebit_id = ?").get(motebitId) !== undefined;

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
        // A peer does not get to de-list an identity this relay is the home
        // of: `revoked = 1` removes it from discovery (`discovery.ts`) and
        // 403s its migration, and the admin door that legitimately sets it
        // writes a signed, append-only `relay_agent_revocations` record —
        // which this path never did, so a peer write also bypassed the
        // moderation history the relay is obliged to keep (rule 6).
        if (heldLocally(event.motebit_id)) {
          refused++;
          logger.warn("federation.revocation.refused_local_identity", {
            type: event.type,
            motebitId: event.motebit_id,
          });
          break;
        }
        processed++;
        break;
      }
      case "key_rotated": {
        // `new_public_key` is not covered by the signature verified above, so
        // even a peer entitled to speak about this identity would not have
        // authenticated the key it names. The field binding is a wire change
        // and is tracked separately; it is not what makes this safe. What
        // makes it safe is that the key of an identity this relay holds moves
        // only through a door with a named authorized principal — `/rotate-key`
        // proving possession of the CURRENT key, or the identity's designated
        // guardian on the recovery path, which is deliberately an exception to
        // current-key possession (a recovery exists precisely because that key
        // is gone). A peer is neither principal.
        if (heldLocally(event.motebit_id)) {
          refused++;
          logger.warn("federation.revocation.refused_local_identity", {
            type: event.type,
            motebitId: event.motebit_id,
          });
          break;
        }
        processed++;
        break;
      }
      case "credential_revoked": {
        // Unlike the two above, this is refused whether or not the subject is
        // an identity this relay holds. The local door's rule is "subject or
        // issuer" and a peer can be neither; and because the table takes an
        // arbitrary id with no existence check, an unrefused event could also
        // deny a credential that has not been issued yet. Consumers that would
        // have honoured it: the hardware-attestation projection in
        // `agents.ts` (dropping a revoked credential's score) and the
        // credential-submission check in `credentials.ts`.
        refused++;
        logger.warn("federation.revocation.refused_unauthorized_credential", {
          type: event.type,
          motebitId: event.motebit_id,
        });
        break;
      }
      default:
        // Unknown event type — safely ignore
        break;
    }
  }

  return { processed, rejected, refused };
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
  logger?: { info(message: string, context?: Record<string, unknown>): void },
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
      // Migrate plaintext → encrypted in place once a passphrase is configured.
      // Re-encrypts the SAME private key (identity preserved — minting a new key
      // would invalidate every signature and the transparency-anchor chain) and
      // persists it, so the next boot takes the encrypted decrypt path above.
      // Idempotent: after this runs, `isEncryptedFormat` is true on reload.
      // Without this branch, setting MOTEBIT_RELAY_KEY_PASSPHRASE on an existing
      // plaintext key is a silent no-op — the key stays plaintext at rest.
      if (passphrase) {
        const encrypted = encryptPrivateKey(privHex, passphrase);
        db.prepare("UPDATE relay_identity SET private_key_hex = ? WHERE relay_motebit_id = ?").run(
          encrypted,
          existing.relay_motebit_id,
        );
        logger?.info("relay.key.migrated_to_encrypted", {
          relay_motebit_id: existing.relay_motebit_id,
        });
      }
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

export function createFederationQueryCache(supervisor?: LoopSupervisor): {
  cache: Map<string, number>;
  pruneInterval: ReturnType<typeof setInterval>;
} {
  const cache = new Map<string, number>();
  const pruneInterval = superviseInterval(
    supervisor,
    "federation-query-cache-prune",
    FEDERATION_QUERY_TTL_MS,
    () => {
      const cutoff = Date.now() - FEDERATION_QUERY_TTL_MS;
      for (const [id, ts] of cache) {
        if (ts < cutoff) cache.delete(id);
      }
    },
  );
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
  peerFetch: PeerFetch = defaultPeerFetch,
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
    db.prepare(`SELECT COUNT(*) as cnt FROM agent_registry WHERE ${ON_SHELF_PREDICATE}`).get() as {
      cnt: number;
    }
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

      const resp = await peerFetch(`${peer.endpoint_url}/federation/v1/peer/heartbeat`, {
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
  peerFetch: PeerFetch = defaultPeerFetch,
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

  const frozen = (err: unknown): boolean =>
    err instanceof EmergencyFrozenError || isEmergencyFrozenAbort(err);

  for (const retry of pending) {
    try {
      // The freeze is checked per SEND, not per pass (a pass in flight when
      // the freeze lands must not keep sending): the forward lifecycle's send
      // claim refuses while frozen, and the pass stops with every remaining
      // retry left exactly as it was.
      if (!beginForwardSend(db, retry.settlement_id)) {
        // Delivered by another path, or failed and refunded: never re-sent.
        const status = forwardOf(db, retry.settlement_id)?.status;
        db.prepare(
          "UPDATE relay_settlement_retries SET status = ?, last_error = ? WHERE retry_id = ? AND status = 'pending'",
        ).run(
          status === "delivered" ? "completed" : "failed",
          `forward is ${status ?? "absent"}; not re-sent`,
          retry.retry_id,
        );
        continue;
      }
      const settlementBody = JSON.parse(retry.payload_json) as Record<string, unknown>;
      // Fresh timestamp on each retry so the receiver accepts it (±5min drift check)
      settlementBody.timestamp = Date.now();
      const peerInfo = db
        .prepare("SELECT endpoint_url FROM relay_peers WHERE peer_relay_id = ?")
        .get(retry.peer_relay_id) as { endpoint_url: string } | undefined;

      if (!peerInfo) {
        // Peer no longer exists — the forward can never be delivered: mark the
        // retry failed and hand it to the exhaustion path, which turns the
        // forward `failed` and refunds the escrow (it used to stop here, the
        // forward counted as moved forever). Synchronous from the send claim
        // above, so no freeze can land between it and the refund.
        db.prepare(
          "UPDATE relay_settlement_retries SET status = 'failed', last_error = ? WHERE retry_id = ?",
        ).run("Peer relay no longer exists", retry.retry_id);
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
        continue;
      }

      const sigBytes = new TextEncoder().encode(canonicalJson(settlementBody));
      const sig = await sign(sigBytes, relayIdentity.privateKey);

      // Re-claimed after the signing await, in the same turn as the send.
      if (!beginForwardSend(db, retry.settlement_id)) continue;
      const resp = await peerFetch(`${peerInfo.endpoint_url}/federation/v1/settlement/forward`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Correlation-ID": retry.task_id },
        body: JSON.stringify({ ...settlementBody, signature: bytesToHex(sig) }),
        signal: AbortSignal.timeout(10_000),
      });

      if (resp.ok) {
        // The peer acknowledged: the retry completes and the forward's
        // lifecycle moves `pending → delivered` in one transaction.
        db.exec("BEGIN");
        try {
          db.prepare(
            "UPDATE relay_settlement_retries SET status = 'completed' WHERE retry_id = ?",
          ).run(retry.retry_id);
          markForwardDelivered(db, retry.settlement_id);
          db.exec("COMMIT");
        } catch (err) {
          // Never count an acknowledged delivery as a failed attempt (that
          // path can end in a refund of money the peer holds): the retry stays
          // pending and is re-delivered — the peer dedupes on (task, origin).
          db.exec("ROLLBACK");
          logger.error("settlement.retry.ack_record_failed", {
            retryId: retry.retry_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        throw new FederationError(
          "FEDERATION_FORWARD_FAILED",
          `HTTP ${resp.status}: ${resp.statusText}`,
        );
      }
    } catch (err: unknown) {
      if (frozen(err)) {
        logger.warn("settlement.retry.frozen", {
          retryId: retry.retry_id,
          taskId: retry.task_id,
          reason: "emergency freeze — this and every later retry left pending for after unfreeze",
        });
        return;
      }
      const newAttempts = retry.attempts + 1;
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (newAttempts >= retry.max_attempts) {
        // Exhaustion fails the retry AND returns + refunds the forward. A
        // freeze that landed during the failed send's await must leave both
        // undone (a failed retry whose refund the freeze refused would strand
        // the forward `pending` forever): checked in the same synchronous turn
        // as the two writes.
        try {
          assertNotFrozen(db);
        } catch {
          logger.warn("settlement.retry.frozen", {
            retryId: retry.retry_id,
            taskId: retry.task_id,
            reason: "emergency freeze — exhaustion deferred until after unfreeze",
          });
          return;
        }
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

// ── Federation result delivery (#890 round 10) ──────────────────────────
//
// The executor relay returns a forwarded task's answer to its origin by
// `POST /federation/v1/task/result`; the origin settles the task ONLY on it.
// A single best-effort send left an origin that was down at that moment
// waiting for a retry that never came. The delivery is an outbox row
// (`relay_result_deliveries`, migration v53) written before the first send
// and retried — bounded, with backoff — until the origin acknowledges (2xx),
// refuses definitively (4xx other than 429: it holds another answer, or the
// task is gone there), or the attempts run out. The body is rebuilt and
// re-signed from the task's archived answer at each attempt (a fresh
// timestamp passes the origin's drift check); the origin's door decides it
// again (`admitReceipt`), so a redelivery is a repeat there, never a second
// settlement.

/** Record that `taskId`'s answer is owed to `peerRelayId` (idempotent). */
export function enqueueResultDelivery(
  db: DatabaseDriver,
  taskId: string,
  peerRelayId: string,
  now: number = Date.now(),
): void {
  db.prepare(
    `INSERT OR IGNORE INTO relay_result_deliveries
       (task_id, peer_relay_id, attempts, next_attempt_at, status, created_at)
     VALUES (?, ?, 0, ?, 'pending', ?)`,
  ).run(taskId, peerRelayId, now, now);
}

/** The answer a delivery carries: the archived answer, else the queue's (pre-archive). */
function deliverableAnswer(db: DatabaseDriver, taskId: string): ExecutionReceipt | null {
  const archived = db
    .prepare("SELECT receipt_json FROM relay_task_answers WHERE task_id = ?")
    .get(taskId) as { receipt_json: string } | undefined;
  if (archived != null) return JSON.parse(archived.receipt_json) as ExecutionReceipt;
  const queued = db
    .prepare("SELECT receipt FROM relay_task_queue WHERE task_id = ?")
    .get(taskId) as { receipt: string | null } | undefined;
  return queued?.receipt != null ? (JSON.parse(queued.receipt) as ExecutionReceipt) : null;
}

/**
 * One delivery attempt of `taskId`'s pending result. Returns the row's status
 * after the attempt (`pending` when it will be retried).
 */
export async function attemptResultDelivery(
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
  taskId: string,
  /** The worker's key the origin verifies the receipt with (`verificationKeyFor`). */
  agentKeyFor: (motebitId: string) => string | null,
  retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
  transport: {
    /** The relay's shutdown: aborts the fetch; the delivery stays pending, the attempt uncounted. */
    signal?: AbortSignal;
    /** The peer transport (`PeerFetch`); omitted, the global `fetch`. */
    peerFetch?: PeerFetch;
  } = {},
): Promise<"pending" | "delivered" | "refused" | "exhausted" | "none"> {
  const { signal, peerFetch = defaultPeerFetch } = transport;
  const row = db
    .prepare("SELECT * FROM relay_result_deliveries WHERE task_id = ? AND status = 'pending'")
    .get(taskId) as
    { task_id: string; peer_relay_id: string; attempts: number; max_attempts: number } | undefined;
  if (row == null) return "none";
  const finish = (status: "delivered" | "refused" | "exhausted", error: string | null) => {
    db.prepare(
      `UPDATE relay_result_deliveries SET status = ?, attempts = attempts + 1, last_error = ?,
         delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END
       WHERE task_id = ? AND status = 'pending'`,
    ).run(status, error, status, Date.now(), taskId);
    logger.info(`federation.result_delivery_${status}`, {
      correlationId: taskId,
      peer: row.peer_relay_id,
      attempts: row.attempts + 1,
      ...(error != null ? { error } : {}),
    });
    return status;
  };
  const peer = db
    .prepare("SELECT endpoint_url FROM relay_peers WHERE peer_relay_id = ?")
    .get(row.peer_relay_id) as { endpoint_url: string } | undefined;
  if (peer == null) return finish("refused", "origin relay is no longer a peer");
  const receipt = deliverableAnswer(db, taskId);
  if (receipt == null) return finish("refused", "no answer to deliver");
  let error: string;
  try {
    const key = agentKeyFor(receipt.motebit_id);
    const resultBody = {
      task_id: taskId,
      origin_relay: relayIdentity.relayMotebitId,
      receipt,
      ...(key !== null ? { agent_public_key: key } : {}),
      timestamp: Date.now(),
    };
    const sig = await sign(
      new TextEncoder().encode(canonicalJson(resultBody)),
      relayIdentity.privateKey,
    );
    const resp = await peerFetch(`${peer.endpoint_url}/federation/v1/task/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Correlation-ID": taskId },
      body: JSON.stringify({ ...resultBody, signature: bytesToHex(sig) }),
      signal:
        signal != null
          ? AbortSignal.any([AbortSignal.timeout(10_000), signal])
          : AbortSignal.timeout(10_000),
    });
    if (resp.ok) return finish("delivered", null);
    // A definitive refusal (the origin holds another answer, the task is gone
    // there, the result is not its executor's) — retrying changes nothing.
    if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
      return finish("refused", `HTTP ${resp.status}`);
    }
    error = `HTTP ${resp.status}`;
  } catch (err: unknown) {
    // Aborted by the relay's shutdown, not refused by the origin: the row is
    // left exactly as it was, retried after the restart.
    if (signal?.aborted === true) return "pending";
    error = err instanceof Error ? err.message : String(err);
  }
  const attempts = row.attempts + 1;
  if (attempts >= row.max_attempts) return finish("exhausted", error);
  const next = Date.now() + nextRetryDelay(attempts - 1, retryPolicy);
  db.prepare(
    `UPDATE relay_result_deliveries SET attempts = ?, next_attempt_at = ?, last_error = ?
     WHERE task_id = ? AND status = 'pending'`,
  ).run(attempts, next, error, taskId);
  logger.info("federation.result_delivery_scheduled", {
    correlationId: taskId,
    peer: row.peer_relay_id,
    attempt: attempts,
    nextAttemptAt: next,
    error,
  });
  return "pending";
}

/** Retry every due pending result delivery (the supervised recovery loop). */
export async function processResultDeliveries(
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
  agentKeyFor: (motebitId: string) => string | null,
  now: number = Date.now(),
  /** Checked before each delivery (the freeze, the shutdown); `signal` aborts the one in flight. */
  ctl: { signal?: AbortSignal; shouldStop?: () => boolean; peerFetch?: PeerFetch } = {},
): Promise<number> {
  const due = db
    .prepare(
      "SELECT task_id FROM relay_result_deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 200",
    )
    .all(now) as Array<{ task_id: string }>;
  let delivered = 0;
  for (const d of due) {
    if (ctl.shouldStop?.() === true || ctl.signal?.aborted === true) break;
    const status = await attemptResultDelivery(
      db,
      relayIdentity,
      d.task_id,
      agentKeyFor,
      DEFAULT_RETRY_POLICY,
      {
        ...(ctl.signal !== undefined ? { signal: ctl.signal } : {}),
        ...(ctl.peerFetch !== undefined ? { peerFetch: ctl.peerFetch } : {}),
      },
    );
    if (status === "delivered") delivered++;
  }
  return delivered;
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
  /** Optional loop supervisor for liveness/error observability. */
  supervisor?: LoopSupervisor,
  /** The peer transport (`PeerFetch`); omitted, the global `fetch`. */
  peerFetch?: PeerFetch,
): ReturnType<typeof setInterval> {
  return superviseInterval(
    supervisor,
    "settlement-retry",
    intervalMs,
    () => processSettlementRetries(db, relayIdentity, onRetryExhausted, retryPolicy, peerFetch),
    { isFrozen },
  );
}

/** Start the heartbeat sender loop. Returns the interval handle for cleanup. */
export function startHeartbeatLoop(
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
  intervalMs = 60_000,
  /** Optional guard — when it returns true, the loop iteration is skipped. */
  isFrozen?: () => boolean,
  /** Optional loop supervisor for liveness/error observability. */
  supervisor?: LoopSupervisor,
  /** The peer transport (`PeerFetch`); omitted, the global `fetch`. */
  peerFetch?: PeerFetch,
): ReturnType<typeof setInterval> {
  return superviseInterval(
    supervisor,
    "federation-heartbeat",
    intervalMs,
    () => sendHeartbeats(db, relayIdentity, peerFetch),
    { ...(isFrozen ? { isFrozen } : {}) },
  );
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
  /**
   * Replay-protection timestamp (epoch ms). REQUIRED — a request without it is
   * rejected (400). Typed optional only so existing call sites that pass a
   * possibly-`undefined` `body.timestamp` typecheck; presence is enforced at
   * runtime. Every federation sender stamps `timestamp: Date.now()` on the
   * signed body (task/forward, task/result, settlement/forward, discover), so
   * this rejects only malformed or replayed requests, never legitimate traffic.
   */
  timestamp?: number,
): Promise<string> {
  // Timestamp freshness — fail-closed. A MISSING timestamp was the audit's
  // latent fail-open (the drift check was skipped, leaving the replay window
  // open), so absence now rejects rather than skips.
  if (timestamp == null || !Number.isFinite(timestamp)) {
    throw new HTTPException(400, { message: "Federation request timestamp required" });
  }
  const drift = Math.abs(Date.now() - timestamp);
  if (drift > FEDERATION_TIMESTAMP_DRIFT_MS) {
    throw new HTTPException(400, {
      message: "Request timestamp outside acceptable drift (±5min)",
    });
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

/**
 * Attach per-hop sender authentication to an outbound `/federation/v1/discover`
 * request: stamp `sender_relay` (THIS relay — the immediate forwarder, distinct
 * from the multi-hop `origin_relay`) and a fresh `timestamp`, then sign the
 * RFC 8785 (JCS) canonical JSON of the whole body (sans `signature`) and attach
 * the hex signature. All three discover senders — the originating task-routing
 * query (`task-routing.ts`), the marketplace discover fan-out (`agents.ts` —
 * the missed third sender the 1.4 strict default exposed), and the fan-out
 * re-forward (the discover handler below) — route through this single helper
 * so the signed bytes can never diverge from what `verifyDiscoverSender`
 * recomputes on the receiver. relay-federation@1.3 §4.1 + §10.2; strict by
 * default since 1.4 (§4.1.1 sunset 2026-07-21).
 */
export async function signDiscoverBody<T extends Record<string, unknown>>(
  body: T,
  relayIdentity: RelayIdentity,
): Promise<T & { sender_relay: string; timestamp: number; signature: string }> {
  const signed = {
    ...body,
    sender_relay: relayIdentity.relayMotebitId,
    timestamp: Date.now(),
  };
  const sig = await sign(new TextEncoder().encode(canonicalJson(signed)), relayIdentity.privateKey);
  return { ...signed, signature: bytesToHex(sig) };
}

/**
 * Authenticate the IMMEDIATE sender of an inbound `/federation/v1/discover`
 * request. Discovery is multi-hop (A→B→D), so the receiver verifies its DIRECT
 * neighbor (`sender_relay`, an active peer whose key it holds), NOT the
 * multi-hop `origin_relay` (whose key the receiver may not have — it could be
 * two hops away). Returns the verified sender id, or `null` when no signature
 * is present AND `requireSignature` is false (the tolerant-reader rollout
 * window — the caller logs the unsigned request). A PRESENT signature is always
 * verified strictly: `sender_relay` + `timestamp` required, ±5min drift, and an
 * active-peer Ed25519 check — throwing 400/403 on any failure.
 */
async function verifyDiscoverSender(
  db: DatabaseDriver,
  body: { sender_relay?: string; timestamp?: number; signature?: string } & Record<string, unknown>,
  requireSignature: boolean,
): Promise<string | null> {
  if (body.signature == null) {
    if (requireSignature) {
      throw new HTTPException(403, { message: "Unsigned discovery request rejected" });
    }
    return null;
  }
  if (typeof body.sender_relay !== "string") {
    throw new HTTPException(400, { message: "Signed discovery request missing sender_relay" });
  }
  if (typeof body.timestamp !== "number") {
    throw new HTTPException(400, { message: "Signed discovery request missing timestamp" });
  }
  const { signature, ...payload } = body;
  return verifyPeerSignature(
    db,
    body.sender_relay,
    signature,
    new TextEncoder().encode(canonicalJson(payload)),
    ["active"],
    body.timestamp,
  );
}

// === Per-Peer Rate Limiter ===

// === Federation Routes ===

export interface FederationDeps {
  db: DatabaseDriver;
  app: Hono;
  relayIdentity: RelayIdentity;
  /** Outbound URL law for persisted peer endpoints (`buildOutboundPolicy`). */
  outboundPolicy?: OutboundUrlOptions;
  federationConfig?: FederationConfig;
  federationQueryCache: Map<string, number>;
  /** The peer transport (`PeerFetch`); omitted, the global `fetch`. */
  peerFetch?: PeerFetch;

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

  /**
   * Optional: operator-configured vote callback for the §16
   * `/federation/v1/disputes/:disputeId/vote-request` endpoint
   * (`spec/relay-federation-v1.md` §16.2).
   *
   * When undefined, the relay reports `vote_policy_configured: false`
   * in its public identity (§2.4) and 501-`policy_not_configured`s
   * every incoming vote-request. Mandate-callback semantics: there is
   * no built-in default that produces binding votes — operators MUST
   * wire policy explicitly to participate as §6.2 adjudicators.
   *
   * The callback receives a verified VoteRequest (signature already
   * checked) and returns the vote outcome + per-peer rationale. Sync
   * v1: the callback runs inside the request lifecycle, so an
   * implementation that forwards to a human-review queue should return
   * a deterministic placeholder (e.g., `split` with rationale "under
   * operator review") rather than blocking the response.
   */
  voteCallback?: (req: VoteRequest) =>
    | Promise<{ vote: DisputeOutcome; rationale: string }>
    | {
        vote: DisputeOutcome;
        rationale: string;
      };
}

/** Register all 11 federation endpoints on the Hono app. */
export function registerFederationRoutes(deps: FederationDeps): void {
  const { db, app, relayIdentity, federationConfig, federationQueryCache } = deps;
  const peerFetch = deps.peerFetch ?? defaultPeerFetch;

  // Two limiters, never one. Every federation request is first counted
  // against its SOURCE (before anything about it is authenticated); a request
  // is counted against a relay_id only AFTER its signature verified under that
  // peer's key. Keyed on the CLAIMED id, 30 junk requests naming a peer made
  // that peer's own signed heartbeat 429 — missed heartbeats, then suspension.
  const peerLimiter = new FixedWindowLimiter(30, 60_000);
  const sourceLimiter = new FixedWindowLimiter(
    federationConfig?.sourceRateLimitPerMinute ?? 300,
    60_000,
  );
  app.use("/federation/v1/*", async (c, next) => {
    const source = getClientIp(c);
    const { allowed, resetAt } = sourceLimiter.check(source);
    if (!allowed) {
      const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
      throw new HTTPException(429, {
        message: `Federation rate limit exceeded for this source, retry after ${retryAfter}s`,
      });
    }
    await next();
  });

  // A propose's nonce is self-authenticating: `<ts>.<rand>.<mac>`, the mac an
  // HMAC under a per-process key over the proposer's id and key. A confirm
  // redeems it once (relay_peer_handshake_nonces); a restart invalidates the
  // outstanding ones (the proposer proposes again).
  const handshakeNonceKey = randomBytes(32);
  const nonceMac = (relayId: string, publicKey: string, ts: string, r: string): string =>
    createHmac("sha256", handshakeNonceKey)
      .update(`motebit-federation-nonce:v2|${relayId}|${publicKey.toLowerCase()}|${ts}|${r}`)
      .digest("hex");
  function mintHandshakeNonce(relayId: string, publicKey: string): string {
    const ts = String(Date.now());
    const r = bytesToHex(randomBytes(16));
    return `${ts}.${r}.${nonceMac(relayId, publicKey, ts, r)}`;
  }
  /** Expiry of a nonce this relay minted for (relayId, publicKey), else null. */
  function handshakeNonceExpiry(nonce: string, relayId: string, publicKey: string): number | null {
    const parts = nonce.split(".");
    if (parts.length !== 3) return null;
    const [ts, r, mac] = parts as [string, string, string];
    if (!/^\d{1,16}$/.test(ts) || !/^[0-9a-f]{32}$/.test(r) || !/^[0-9a-f]{64}$/.test(mac)) {
      return null;
    }
    const expected = Buffer.from(nonceMac(relayId, publicKey, ts, r), "hex");
    if (!timingSafeEqual(expected, Buffer.from(mac, "hex"))) return null;
    const issued = Number(ts);
    const now = Date.now();
    if (issued > now + 60_000 || now - issued > PEER_HANDSHAKE_NONCE_TTL_MS) return null;
    return issued + PEER_HANDSHAKE_NONCE_TTL_MS;
  }

  /** v1 is retired: refuse by name, never by a signature that merely fails. */
  function requireHandshakeV2(version: unknown): void {
    if (version !== FEDERATION_HANDSHAKE_VERSION) {
      throw new HTTPException(400, {
        message: `federation handshake ${typeof version === "string" ? version : "v1"} is not supported: this relay speaks handshake_version "${FEDERATION_HANDSHAKE_VERSION}" (spec/relay-federation-v1.md §3) — the confirm signature is minted by the proving relay's operator at POST /api/v1/admin/federation/peer-confirm-signature`,
      });
    }
  }

  /** Relay ids are colon-free, so the signed handshake messages parse one way. */
  function requireRelayIdShape(id: string, field: string): void {
    if (id.length > 256 || /[:\s]/.test(id)) {
      throw new HTTPException(400, { message: `${field} must be colon- and whitespace-free` });
    }
  }

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
  const requireDiscoverSignature =
    federationConfig?.requireDiscoverSignature ?? DEFAULT_REQUIRE_DISCOVER_SIGNATURE;

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

  /** @spec motebit/relay-federation@1.4 */
  app.get("/federation/v1/identity", (c) => {
    return c.json({
      spec: RELAY_SPEC_VERSION,
      relay_motebit_id: relayIdentity.relayMotebitId,
      public_key: relayIdentity.publicKeyHex,
      did: relayIdentity.did,
      // §2.4 capability flag: true iff this relay has wired an
      // operator vote callback for the §16 vote-request endpoint.
      // Peers without configured policy are not eligible §6.2
      // adjudicators per §16.2 (501 `policy_not_configured` on
      // incoming vote-requests); leaders MAY pre-filter them out
      // of quorum enumeration.
      vote_policy_configured: deps.voteCallback !== undefined,
    });
  });

  // ── Phase 2: Peering Protocol ──

  /** @spec motebit/relay-federation@1.5 */
  app.post("/federation/v1/peer/propose", async (c) => {
    const body = await c.req.json<{
      handshake_version?: unknown;
      relay_id?: string;
      public_key?: string;
      endpoint_url?: string;
      display_name?: string;
      nonce?: string;
      spec_version?: string;
    }>();
    checkFederationEnabled();
    requireHandshakeV2(body.handshake_version);

    const { relay_id, public_key, endpoint_url, nonce, spec_version } = body;
    if (!relay_id || !public_key)
      throw new HTTPException(400, { message: "relay_id and public_key are required" });
    if (!endpoint_url) throw new HTTPException(400, { message: "endpoint_url is required" });
    if (!nonce) throw new HTTPException(400, { message: "nonce is required" });
    requireRelayIdShape(relay_id, "relay_id");
    if (relay_id === relayIdentity.relayMotebitId) {
      // A relay never answers a proposal from itself: a self-propose was the
      // v1 confirm oracle.
      throw new HTTPException(400, { message: "a relay does not peer with itself" });
    }
    const peerVerdict = await checkOutboundUrl(endpoint_url, deps.outboundPolicy);
    if (!peerVerdict.ok) {
      throw new HTTPException(400, { message: `endpoint_url refused: ${peerVerdict.reason}` });
    }

    checkVersionCompatibility(spec_version);
    checkPeerPolicy(relay_id);
    // Early answers only — a propose writes nothing, so every one of these is
    // checked again, authoritatively, at confirm.
    checkEstablishedPeer(relay_id, public_key);

    const ourNonce = mintHandshakeNonce(relay_id, public_key);
    const challengeSig = await sign(
      new TextEncoder().encode(
        federationProposeMessage(relayIdentity.relayMotebitId, relay_id, nonce),
      ),
      relayIdentity.privateKey,
    );

    return c.json({
      handshake_version: FEDERATION_HANDSHAKE_VERSION,
      relay_id: relayIdentity.relayMotebitId,
      public_key: relayIdentity.publicKeyHex,
      endpoint_url: federationConfig?.endpointUrl ?? "self",
      display_name: federationConfig?.displayName ?? null,
      nonce: ourNonce,
      challenge: bytesToHex(challengeSig),
      spec_version: RELAY_SPEC_VERSION,
    });
  });

  /**
   * The row an id is bound by, if any. ESTABLISHED = it once completed a
   * confirm (`active`, `suspended`, `removed`, or a `pending` row with
   * `peered_at`, which only an earlier build left): its key is fixed and
   * changes only by succession or operator action. A `pending` row with no
   * `peered_at` is a v1 proposal that never confirmed — it binds nothing.
   * Throws 409 (another key), 429 (removed cooldown), 503 (peer cap).
   */
  function checkEstablishedPeer(
    relayId: string,
    publicKey: string,
  ): { state: string; public_key: string } | null {
    const existing = db
      .prepare(
        "SELECT state, last_heartbeat_at, public_key, peered_at FROM relay_peers WHERE peer_relay_id = ?",
      )
      .get(relayId) as
      | {
          state: string;
          last_heartbeat_at: number | null;
          public_key: string;
          peered_at: number | null;
        }
      | undefined;
    const established =
      existing != null && (existing.state !== "pending" || existing.peered_at != null)
        ? existing
        : null;
    if (established && established.public_key.toLowerCase() !== publicKey.toLowerCase()) {
      logger.warn("federation.peer.key_change_refused", { peerId: relayId });
      throw new HTTPException(409, {
        message:
          "relay_id is bound to a different public_key; a peer key changes only by key succession or operator action",
      });
    }
    // Cooldown: removed peers must wait 5 minutes before re-peering.
    if (
      established?.state === "removed" &&
      established.last_heartbeat_at != null &&
      established.last_heartbeat_at !== 0
    ) {
      const cooldownMs = 5 * 60 * 1000;
      const elapsed = Date.now() - established.last_heartbeat_at;
      if (elapsed < cooldownMs) {
        const retryAfter = Math.ceil((cooldownMs - elapsed) / 1000);
        throw new HTTPException(429, {
          message: `Removed peer must wait ${retryAfter}s before re-peering`,
        });
      }
    }
    if (established?.state !== "active") checkMaxPeers();
    return established;
  }

  /** @spec motebit/relay-federation@1.5 */
  app.post("/federation/v1/peer/confirm", async (c) => {
    const body = await c.req.json<{
      handshake_version?: unknown;
      relay_id?: string;
      public_key?: string;
      endpoint_url?: string;
      display_name?: string | null;
      nonce?: string;
      spec_version?: string | null;
      challenge_response?: string;
    }>();
    checkFederationEnabled();
    requireHandshakeV2(body.handshake_version);
    const { relay_id, public_key, endpoint_url, nonce, challenge_response } = body;
    if (!relay_id || !public_key || !endpoint_url || !nonce || !challenge_response) {
      throw new HTTPException(400, {
        message: "relay_id, public_key, endpoint_url, nonce and challenge_response are required",
      });
    }
    requireRelayIdShape(relay_id, "relay_id");
    if (relay_id === relayIdentity.relayMotebitId) {
      throw new HTTPException(400, { message: "a relay does not peer with itself" });
    }
    const displayName = typeof body.display_name === "string" ? body.display_name : null;
    const specVersion = typeof body.spec_version === "string" ? body.spec_version : null;

    checkVersionCompatibility(specVersion ?? undefined);
    checkPeerPolicy(relay_id);
    const peerVerdict = await checkOutboundUrl(endpoint_url, deps.outboundPolicy);
    if (!peerVerdict.ok) {
      throw new HTTPException(400, { message: `endpoint_url refused: ${peerVerdict.reason}` });
    }

    const expiresAt = handshakeNonceExpiry(nonce, relay_id, public_key);
    if (expiresAt == null) {
      throw new HTTPException(403, {
        message: "nonce was not issued by this relay for this relay_id and public_key, or expired",
      });
    }
    const established = checkEstablishedPeer(relay_id, public_key);
    // An established id verifies under its STORED key — never the body's.
    const key = established ? established.public_key : public_key;

    let signature: Uint8Array;
    try {
      signature = hexToBytes(challenge_response);
    } catch {
      throw new HTTPException(403, { message: "Challenge response verification failed" });
    }
    const valid = await verify(
      signature,
      new TextEncoder().encode(
        federationConfirmMessage(relay_id, relayIdentity.relayMotebitId, nonce, endpoint_url),
      ),
      hexToBytes(key),
    );
    if (!valid) {
      throw new HTTPException(403, { message: "Challenge response verification failed" });
    }
    // Counted against the peer only now that its key signed.
    checkPeerLimit(relay_id);

    const now = Date.now();
    db.transaction(() => {
      db.prepare("DELETE FROM relay_peer_handshake_nonces WHERE expires_at <= ?").run(now);
      const redeemed = db
        .prepare(
          "INSERT OR IGNORE INTO relay_peer_handshake_nonces (nonce, peer_relay_id, expires_at) VALUES (?, ?, ?)",
        )
        .run(nonce, relay_id, expiresAt);
      if (redeemed.changes !== 1) {
        throw new HTTPException(403, { message: "nonce already redeemed" });
      }
      if (established) {
        db.prepare(
          `UPDATE relay_peers SET state = 'active', endpoint_url = ?, display_name = ?,
             peer_protocol_version = ?, missed_heartbeats = 0, nonce = NULL,
             peered_at = ?, last_heartbeat_at = ?
           WHERE peer_relay_id = ? AND public_key = ?`,
        ).run(endpoint_url, displayName, specVersion, now, now, relay_id, established.public_key);
        return;
      }
      // A new peer, or over a v1 proposal that never confirmed (binds nothing).
      const written = db
        .prepare(
          `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, nonce, missed_heartbeats, agent_count, trust_score, peer_protocol_version, peered_at, last_heartbeat_at)
           VALUES (?, ?, ?, ?, 'active', NULL, 0, 0, 0.5, ?, ?, ?)
           ON CONFLICT(peer_relay_id) DO UPDATE SET
             public_key = excluded.public_key, endpoint_url = excluded.endpoint_url,
             display_name = excluded.display_name, state = 'active', nonce = NULL,
             missed_heartbeats = 0, peer_protocol_version = excluded.peer_protocol_version,
             peered_at = excluded.peered_at, last_heartbeat_at = excluded.last_heartbeat_at
           WHERE relay_peers.state = 'pending' AND relay_peers.peered_at IS NULL`,
        )
        .run(relay_id, public_key, endpoint_url, displayName, specVersion, now, now);
      if (written.changes !== 1) {
        throw new HTTPException(409, { message: "relay_id was established concurrently" });
      }
    });

    logger.info("federation.peer.active", { peerId: relay_id });
    return c.json({
      status: "active",
      peered_at: now,
      handshake_version: FEDERATION_HANDSHAKE_VERSION,
    });
  });

  /** @spec motebit/relay-federation@1.5 */
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
    // Counted against the peer only once its signature verified — junk
    // heartbeats naming a peer never spend that peer's quota.
    checkPeerLimit(relay_id);

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
        // A peer claiming authority over an identity this relay is the home of
        // is not a malformed feed — it is a peer asserting something it cannot
        // be entitled to assert. Named at warn with the peer that sent it, so
        // the attempt is visible rather than silently absorbed into a count.
        if (result.refused > 0) {
          logger.warn("federation.revocation.refused", {
            peerId: relay_id,
            refused: result.refused,
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
      db
        .prepare(`SELECT COUNT(*) as cnt FROM agent_registry WHERE ${ON_SHELF_PREDICATE}`)
        .get() as {
        cnt: number;
      }
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

  // Phase 4b-3 — federation co-witness solicitation. Issuer relay POSTs
  // a `WitnessSolicitationRequest` carrying the unsigned cert body
  // (sans `witnessed_by`, sans top-level signature) and an
  // `issuer_signature` over `canonicalJson(cert_body)`. We verify the
  // issuer signature, sign the same canonical bytes with our own
  // federation key, and return a `WitnessSolicitationResponse`.
  //
  // Fail-closed gates (in order):
  //   1. Schema validation via `WitnessSolicitationRequestSchema`.
  //   2. Issuer must be a known peer in `relay_peers` (state IN active/suspended).
  //   3. `issuer_id` must equal the id projected from `cert_body.subject`
  //      (per session-3 sub-decision: subject↔issuer binding).
  //   4. Issuer signature verifies under `motebit-jcs-ed25519-b64-v1`
  //      against `canonicalJson(cert_body)`.
  //
  // The peer's signature commits to the body WITHOUT `witnessed_by[]`
  // — witnesses are portable across compositions of the same body. The
  // issuer's eventual final cert.signature binds the assembled witness
  // array.
  /** @spec motebit/relay-federation@1.4 */
  app.post("/federation/v1/horizon/witness", async (c) => {
    const rawBody = (await c.req.json()) as unknown;
    const parsed = WitnessSolicitationRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: `WitnessSolicitationRequest schema rejected: ${parsed.error.message}`,
      });
    }
    const request = parsed.data;

    const peer = db
      .prepare(
        "SELECT public_key FROM relay_peers WHERE peer_relay_id = ? AND state IN ('active', 'suspended')",
      )
      .get(request.issuer_id) as { public_key: string } | undefined;
    if (peer === undefined) {
      throw new HTTPException(403, {
        message: "issuer is not a known active/suspended peer",
      });
    }

    // Subject↔issuer binding (session-3 sub-decision: stops a relay
    // from soliciting witnesses for a cert it doesn't own).
    const subject = request.cert_body.subject;
    const projectedSubjectId =
      subject.kind === "motebit" ? subject.motebit_id : subject.operator_id;
    if (projectedSubjectId !== request.issuer_id) {
      throw new HTTPException(400, {
        message: `issuer_id (${request.issuer_id}) does not match cert_body.subject (${projectedSubjectId})`,
      });
    }

    const issuerPubKey = hexToBytes(peer.public_key);
    const issuerSignatureValid = await verifyHorizonWitnessRequestSignature(
      request.cert_body,
      request.issuer_signature,
      issuerPubKey,
    );
    if (!issuerSignatureValid) {
      throw new HTTPException(403, {
        message: "issuer_signature does not verify against issuer pubkey",
      });
    }
    checkPeerLimit(request.issuer_id);

    // All gates passed — sign as witness over the same canonical bytes
    // the issuer signed (session-3 sub-decision: issuer-signature
    // payload IS witness-signature payload). The same primitive
    // produces both — drift-impossible.
    const witnessSignature = await signHorizonWitnessRequestBody(
      request.cert_body,
      relayIdentity.privateKey,
    );

    logger.info("federation.horizon.witness.signed", {
      issuerId: request.issuer_id,
      storeId: request.cert_body.store_id,
      horizonTs: request.cert_body.horizon_ts,
    });

    return c.json({
      motebit_id: relayIdentity.relayMotebitId,
      signature: witnessSignature,
    });
  });

  // Phase 4b-3 — witness-omission dispute filing. Disputant peer POSTs
  // a `WitnessOmissionDispute` claiming wrongful omission from a cert's
  // `witnessed_by[]`. We resolve the cert from `relay_horizon_certs`
  // by `cert_signature` (commit 4 scope: only disputes against THIS
  // relay's own certs are handled — disputes against peer-issued certs
  // would require federation forwarding, out of scope), hand to
  // `verifyWitnessOmissionDispute` from `@motebit/crypto`, persist
  // with state.
  //
  // Cert remains TERMINAL per retention-policy.md decision 5 — a
  // sustained dispute is a reputation hit on the issuer, not a cert
  // invalidation.
  /** @spec motebit/relay-federation@1.4 */
  app.post("/federation/v1/horizon/dispute", async (c) => {
    const rawBody = (await c.req.json()) as unknown;
    const parsed = WitnessOmissionDisputeSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: `WitnessOmissionDispute schema rejected: ${parsed.error.message}`,
      });
    }
    const dispute = parsed.data;
    const disputeJson = canonicalJson(dispute);

    const cert = resolveHorizonCertBySignature(db, dispute.cert_signature);
    if (cert === null) {
      persistWitnessOmissionDispute(
        db,
        dispute,
        disputeJson,
        "rejected",
        "cert_not_found_in_local_store",
      );
      throw new HTTPException(404, {
        message: "cert referenced by dispute.cert_signature not found in local store",
      });
    }

    // Defensive guard: explicit check that this relay actually issued
    // the cert. Today `relay_horizon_certs` only contains certs we
    // signed in `advanceRelayHorizon`, so cert.subject.operator_id
    // always equals our motebit_id — but the assumption is encoded
    // only in `persistHorizonCert`'s call site. A future code path
    // that lands a peer's cert in the local store (e.g. adjudicator
    // forwarding) would silently verify the dispute with the wrong
    // issuer pubkey and return a misleading error. Make the implicit
    // invariant explicit at the verification site, fail-closed by
    // construction. Same shape as the empty-anchor sanity check in
    // `@motebit/crypto::verifyDeletionCertificate`.
    const certIssuerId =
      cert.subject.kind === "operator"
        ? cert.subject.operator_id
        : (cert.subject.motebit_id as string);
    if (cert.subject.kind !== "operator" || certIssuerId !== relayIdentity.relayMotebitId) {
      persistWitnessOmissionDispute(
        db,
        dispute,
        disputeJson,
        "rejected",
        `cert_not_issued_by_this_relay (cert.subject=${certIssuerId}, this_relay=${relayIdentity.relayMotebitId})`,
      );
      throw new HTTPException(404, {
        message:
          "this relay did not issue the disputed cert; adjudicator forwarding for peer-issued certs is not yet supported",
      });
    }

    // Disputant must be a known peer (we resolve their pubkey for
    // dispute-signature verification).
    const disputantRow = db
      .prepare(
        "SELECT public_key FROM relay_peers WHERE peer_relay_id = ? AND state IN ('active', 'suspended')",
      )
      .get(dispute.disputant_motebit_id) as { public_key: string } | undefined;
    if (disputantRow === undefined) {
      persistWitnessOmissionDispute(db, dispute, disputeJson, "rejected", "disputant_unknown_peer");
      throw new HTTPException(403, {
        message: "disputant_motebit_id is not a known active/suspended peer",
      });
    }

    // Cert was issued by THIS relay (resolved from our local store), so
    // the issuer pubkey is our own federation pubkey.
    const result = await verifyWitnessOmissionDispute(dispute, {
      cert,
      issuerPublicKey: relayIdentity.publicKey,
      disputantPublicKey: hexToBytes(disputantRow.public_key),
      now: Date.now(),
    });

    if (!result.valid) {
      persistWitnessOmissionDispute(db, dispute, disputeJson, "rejected", result.errors.join("; "));
      throw new HTTPException(400, {
        message: `dispute verification failed: ${result.errors.join("; ")}`,
      });
    }

    persistWitnessOmissionDispute(db, dispute, disputeJson, "verified");
    logger.info("federation.horizon.dispute.verified", {
      disputeId: dispute.dispute_id,
      certIssuer: dispute.cert_issuer,
      certSignature: dispute.cert_signature.slice(0, 16),
      disputantId: dispute.disputant_motebit_id,
      evidenceKind: dispute.evidence.kind,
    });

    return c.json({
      status: "verified",
      dispute_id: dispute.dispute_id,
      message:
        "dispute verified and persisted; cert remains terminal per retention-policy.md decision 5",
    });
  });

  /**
   * Peer-side vote-request handler for §6.2 federation adjudication
   * (`spec/relay-federation-v1.md` §16.2). Receives a `VoteRequest`
   * from a leader relay, runs the six-gate ladder fail-closed, calls
   * the operator's vote callback, signs an `AdjudicatorVote`, returns.
   *
   * Sync v1: the callback runs inside the request lifecycle. Operators
   * who need human review must return a deterministic placeholder
   * (e.g., `split` "under operator review") rather than block. See
   * `memory/section_6_2_orchestrator_async_deferral.md`.
   *
   * Stateless responder: this peer does NOT persist its own vote.
   * Only the leader persists (PK on `(dispute_id, round, peer_id)` in
   * `relay_dispute_votes`). Peer-side audit persistence is a future arc.
   *
   * Error response shape: `{error_code, message}` per §16.2 — leaders
   * MUST switch on `error_code`, not `message`. The rest of §3–15
   * still uses plain `{message}`; aligning is a follow-up arc.
   */
  /** @spec motebit/relay-federation@1.4 */
  app.post("/federation/v1/disputes/:disputeId/vote-request", async (c) => {
    const disputeIdParam = c.req.param("disputeId");

    // Gate 1 — Schema validation (400 schema_invalid)
    const rawBody = (await c.req.json()) as unknown;
    const parsed = VoteRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          error_code: "schema_invalid",
          message: `VoteRequest schema rejected: ${parsed.error.message}`,
        },
        400,
      );
    }
    const request: VoteRequest = parsed.data;

    // URL-param consistency: dispute_id in the URL must match the body
    if (request.dispute_id !== disputeIdParam) {
      return c.json(
        {
          error_code: "schema_invalid",
          message: `URL :disputeId (${disputeIdParam}) does not match body.dispute_id (${request.dispute_id})`,
        },
        400,
      );
    }

    checkFederationEnabled();

    // Gate 2 — Known peer (403 unknown_peer)
    const peer = db
      .prepare(
        "SELECT public_key FROM relay_peers WHERE peer_relay_id = ? AND state IN ('active', 'suspended')",
      )
      .get(request.requester_id) as { public_key: string } | undefined;
    if (peer === undefined) {
      return c.json(
        {
          error_code: "unknown_peer",
          message: "requester is not a known active/suspended peer",
        },
        403,
      );
    }

    // Gate 3 — Requester-id binding is enforced by gate 2 (lookup is keyed
    // on body.requester_id; the resolved peer row is by definition for
    // that id). The doctrinal spec text frames this as a separate gate
    // because conceptually `body.requester_id` could mismatch a
    // header-asserted id; in this v1 there is no header-asserted id, so
    // the binding collapses into gate 2's lookup. Keeping the spec text
    // forward-compatible with future header-asserted-identity additions
    // (e.g., authenticated transport bound to peer mTLS) without
    // requiring a code change here today.

    // Gate 4 — Signature verify (403 signature_invalid)
    // VoteRequest suite is `motebit-jcs-ed25519-b64-v1`; signature is
    // base64url-encoded (peer.public_key remains hex per the suite's
    // public-key encoding rule).
    const { signature, ...bodyForVerify } = request;
    const canonical = canonicalJson(bodyForVerify);
    const valid = await verify(
      fromBase64Url(signature),
      new TextEncoder().encode(canonical),
      hexToBytes(peer.public_key),
    );
    if (!valid) {
      logger.warn("federation.vote_request.signature_invalid", {
        kind: "signature_invalid",
        peerId: request.requester_id,
        disputeId: request.dispute_id,
      });
      return c.json(
        {
          error_code: "signature_invalid",
          message: "VoteRequest signature verification failed",
        },
        403,
      );
    }
    // Counted against the peer only once its signature verified.
    checkPeerLimit(request.requester_id);

    // Gate 5 — Freshness (400 request_stale). 60s window mirrors the
    // tighter convention §16.2 names: vote-requests are short-lived and
    // have no legitimate reason to delay >60s.
    const FEDERATION_VOTE_REQUEST_MAX_AGE_MS = 60_000;
    const ageMs = Math.abs(Date.now() - request.requested_at);
    if (ageMs > FEDERATION_VOTE_REQUEST_MAX_AGE_MS) {
      return c.json(
        {
          error_code: "request_stale",
          message: `VoteRequest age ${ageMs}ms exceeds max ${FEDERATION_VOTE_REQUEST_MAX_AGE_MS}ms`,
        },
        400,
      );
    }

    // Gate 6 — Operator policy configured (501 policy_not_configured).
    // 501 Not Implemented, NOT 503: the missing callback is a deliberate
    // operator-configuration gap, not a transient outage. Retry-with-
    // backoff is wasted effort.
    if (deps.voteCallback === undefined) {
      return c.json(
        {
          error_code: "policy_not_configured",
          message:
            "operator vote callback not configured; this relay is not an eligible §6.2 adjudicator",
        },
        501,
      );
    }

    // All gates passed. Call the operator policy.
    const policyResult = await deps.voteCallback(request);
    const voteOutcome: DisputeOutcome = policyResult.vote;
    const voteRationale = policyResult.rationale;

    // Sign the AdjudicatorVote via @motebit/crypto (no inline sign;
    // protocol-primitive-placement rule). The primitive owns suite +
    // signature; we provide everything else.
    const signedVote = await signAdjudicatorVote(
      {
        dispute_id: request.dispute_id,
        round: request.round,
        peer_id: relayIdentity.relayMotebitId,
        vote: voteOutcome,
        rationale: voteRationale,
      },
      relayIdentity.privateKey,
    );

    logger.info("federation.vote_request.signed", {
      disputeId: request.dispute_id,
      round: request.round,
      requesterId: request.requester_id,
      vote: voteOutcome,
    });

    return c.json(signedVote);
  });

  /** @spec motebit/relay-federation@1.4 */
  app.post("/federation/v1/peer/remove", async (c) => {
    const body = await c.req.json<{ relay_id?: string; signature?: string }>();
    const { relay_id, signature: sig } = body;
    if (!relay_id || !sig)
      throw new HTTPException(400, { message: "relay_id and signature are required" });

    const peer = db.prepare("SELECT * FROM relay_peers WHERE peer_relay_id = ?").get(relay_id) as
      { peer_relay_id: string; public_key: string } | undefined;
    if (!peer) throw new HTTPException(404, { message: "Peer not found" });

    const valid = await verify(
      hexToBytes(sig),
      new TextEncoder().encode(relay_id),
      hexToBytes(peer.public_key),
    );
    if (!valid) throw new HTTPException(403, { message: "Removal signature verification failed" });
    checkPeerLimit(relay_id);

    db.prepare("UPDATE relay_peers SET state = 'removed' WHERE peer_relay_id = ?").run(relay_id);
    return c.json({ status: "removed" });
  });

  // Admin signing oracle for federation peer removal — consumed by
  // `motebit federation peer-remove <peer-url>` (apps/cli).
  //
  // Returns this relay's signature over its own relay_motebit_id raw UTF-8
  // bytes, the artifact a peer's POST /federation/v1/peer/remove requires
  // (sibling to lines above — same encoding, same key).
  //
  // Behind master-token admin auth (services/relay/CLAUDE.md rule 5), NOT a
  // public self-mode oracle (the v1 /peer/propose self-mode WAS one for the
  // confirm, and is gone). /peer/remove takes a signature over the
  // BARE relay_id (no nonce, no suite-binding), so a public self-mode would
  // create a replayable artifact: any HTTP caller could fetch this and POST
  // it to every known peer, federation-DoS'ing the relay. Auth required.
  // Admin confirm-signature mint — the ONLY producer of this relay's v2
  // confirm (`federationConfirmMessage`). Behind the master token
  // (`/api/v1/admin/federation/*`): the operator decides which relay this
  // relay proves itself to, over which of that relay's nonces, at which
  // endpoint. Returns the complete `/peer/confirm` body to POST to the
  // verifier. Consumed by `motebit federation peer` (apps/cli).
  /** @internal */
  app.post("/api/v1/admin/federation/peer-confirm-signature", async (c) => {
    const body = await c.req.json<{
      verifier_relay_id?: unknown;
      nonce?: unknown;
      endpoint_url?: unknown;
    }>();
    const verifier = body.verifier_relay_id;
    const nonce = body.nonce;
    if (
      typeof verifier !== "string" ||
      verifier === "" ||
      typeof nonce !== "string" ||
      nonce === ""
    ) {
      throw new HTTPException(400, { message: "verifier_relay_id and nonce are required" });
    }
    requireRelayIdShape(verifier, "verifier_relay_id");
    if (verifier === relayIdentity.relayMotebitId) {
      throw new HTTPException(400, { message: "a relay does not peer with itself" });
    }
    const endpoint =
      typeof body.endpoint_url === "string" && body.endpoint_url !== ""
        ? body.endpoint_url
        : federationConfig?.endpointUrl;
    if (!endpoint) {
      throw new HTTPException(400, {
        message: "endpoint_url is required (no federation endpointUrl is configured)",
      });
    }
    const sig = await sign(
      new TextEncoder().encode(
        federationConfirmMessage(relayIdentity.relayMotebitId, verifier, nonce, endpoint),
      ),
      relayIdentity.privateKey,
    );
    return c.json({
      handshake_version: FEDERATION_HANDSHAKE_VERSION,
      relay_id: relayIdentity.relayMotebitId,
      public_key: relayIdentity.publicKeyHex,
      endpoint_url: endpoint,
      display_name: federationConfig?.displayName ?? null,
      spec_version: RELAY_SPEC_VERSION,
      nonce,
      challenge_response: bytesToHex(sig),
    });
  });

  /** @internal */
  app.get("/api/v1/admin/federation/peer-removal-signature", async (c) => {
    const sig = await sign(
      new TextEncoder().encode(relayIdentity.relayMotebitId),
      relayIdentity.privateKey,
    );
    return c.json({
      relay_id: relayIdentity.relayMotebitId,
      signature: bytesToHex(sig),
    });
  });

  /** @spec motebit/relay-federation@1.4 */
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

  /** @spec motebit/relay-federation@1.4 */
  app.post("/federation/v1/discover", async (c) => {
    const body = await c.req.json<{
      query: { capability?: string; motebit_id?: string; limit?: number };
      hop_count: number;
      max_hops: number;
      visited: string[];
      query_id: string;
      origin_relay: string;
      // Per-hop sender authentication (relay-federation@1.3 §4.1). Optional on
      // the wire during the tolerant-reader rollout; verified strictly when
      // present, required once `requireDiscoverSignature` is flipped on.
      sender_relay?: string;
      timestamp?: number;
      signature?: string;
    }>();

    if (!body.query_id || body.max_hops > 3) {
      throw new HTTPException(400, { message: "Invalid federation query" });
    }

    // Silent no-op when federation is disabled — return empty results, don't error
    if (!federationEnabled) {
      return c.json({ agents: [] });
    }

    // Per-hop sender auth: verify the IMMEDIATE forwarder (sender_relay), not the
    // multi-hop origin_relay. Rate-limit on the verified sender when we have it,
    // falling back to the self-asserted origin only during the unsigned rollout
    // window (logged so the gap is observable).
    const verifiedSender = await verifyDiscoverSender(db, body, requireDiscoverSignature);
    if (verifiedSender == null) {
      logger.warn("federation.discover.unsigned", {
        origin_relay: body.origin_relay,
        query_id: body.query_id,
      });
    }
    // Only a VERIFIED sender is counted per peer; an unsigned discover (allowed
    // only under requireDiscoverSignature=false) is bounded by the source limit.
    if (verifiedSender) checkPeerLimit(verifiedSender);

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
    // Enrich local agents with hardware_attestation from this relay's
    // credential store so the originating relay can render the badge for
    // agents discovered across federation. Without this, HA only flows
    // through the public-facing /api/v1/agents/discover for the relay
    // that holds the credential — federation-discovered peers always
    // appear as unattested even when the originating relay had verified
    // them. See docs/doctrine/self-attesting-system.md + the HA badge
    // ship 2 review note that flagged this gap.
    if (body.hop_count >= body.max_hops) {
      return c.json({
        agents: enrichWithLatencyStats(enrichWithHardwareAttestation(results, db), db),
      });
    }

    // Forward to active peers
    const visited = [...body.visited, relayIdentity.relayMotebitId];
    const peers = db
      .prepare("SELECT peer_relay_id, endpoint_url FROM relay_peers WHERE state = 'active'")
      .all() as Array<{ peer_relay_id: string; endpoint_url: string }>;

    const forwardPromises = peers
      .filter((p) => !visitedSet.has(p.peer_relay_id))
      .map(async (peer) => {
        try {
          // Re-sign at each hop: THIS relay becomes the sender_relay for the
          // next leg (origin_relay carries through unchanged for dedup/merge).
          const forwardBody = await signDiscoverBody(
            {
              query: body.query,
              hop_count: body.hop_count + 1,
              max_hops: body.max_hops,
              visited,
              query_id: body.query_id,
              origin_relay: body.origin_relay,
            },
            relayIdentity,
          );
          const resp = await peerFetch(`${peer.endpoint_url}/federation/v1/discover`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Correlation-ID": body.query_id,
            },
            body: JSON.stringify(forwardBody),
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

    // Enrich the merged set with hardware_attestation + latency_stats
    // from THIS relay's stores. The federation-passthrough rule preserves
    // any peer-provided values already attached to peer-of-peer agents
    // (their store is more authoritative for agents we've never directly
    // transacted with) — we only fill in for agents that arrived without
    // the field AND about which we hold local data.
    const withHa = enrichWithHardwareAttestation(
      [...merged.values()] as Array<Record<string, unknown> & { motebit_id: string }>,
      db,
    );
    const enriched = enrichWithLatencyStats(withHa, db);
    return c.json({ agents: enriched });
  });

  // ── Phase 4: Task Forwarding ──

  /** @spec motebit/relay-federation@1.4 */
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
      payment_proof?: {
        tx_hash: string;
        chain: string;
        network: string;
        to_address: string;
        amount_micro: number;
        fee_to_address: string;
        fee_amount_micro: number;
        b_fee_to_address?: string;
        b_fee_amount_micro?: number;
      };
      timestamp?: number;
      signature: string;
    }>();

    if (!body.task_id || !body.origin_relay || !body.target_agent || !body.task_payload?.prompt) {
      throw new HTTPException(400, { message: "Missing required fields" });
    }

    checkFederationEnabled();
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
    // Counted against the peer only once its signature verified.
    checkPeerLimit(body.origin_relay);

    // Check target agent exists locally. No `expires_at > now` filter —
    // liveness is checked by the wake-on-delegation hook in
    // `forwardTaskViaMcp` downstream, not by this existence gate. Gating
    // peer-forwards on a 15-min heartbeat window was punishing peers for
    // agent sleep, which they can't control.
    // A delisted agent (departed, lapsed, revoked) is not serving: 404, the
    // same answer a peer got when the row used to be deleted.
    const agent = db
      .prepare(`SELECT 1 FROM agent_registry WHERE motebit_id = ?${ON_SHELF}`)
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
      ...(body.payment_proof ? { paymentProof: body.payment_proof } : {}),
    });

    if (result.status === "duplicate") {
      return c.json({ task_id: body.task_id, status: "duplicate" }, 409);
    }
    if (result.status === "rejected") {
      // A proof already bound to another task here (#918), or a task id
      // that already means something here (#890 r7), is a conflict, not a
      // rate limit: retrying it later changes nothing.
      const rejectedStatus =
        result.reason === "p2p_proof_already_admitted" || result.reason === "task_id_in_use"
          ? 409
          : 429;
      return c.json(
        { task_id: body.task_id, status: "rejected", reason: result.reason },
        rejectedStatus,
      );
    }

    return c.json(
      { task_id: body.task_id, status: result.status },
      result.status === "pending" ? 202 : 200,
    );
  });

  /** @spec motebit/relay-federation@1.4 */
  app.post("/federation/v1/task/result", async (c) => {
    const body = await c.req.json<{
      task_id: string;
      origin_relay: string;
      receipt: ExecutionReceipt;
      agent_public_key?: string;
      timestamp?: number;
      signature: string;
    }>();

    if (!body.task_id || !body.origin_relay || body.receipt == null) {
      throw new HTTPException(400, { message: "Missing required fields" });
    }

    // Validate nested ExecutionReceipt against the wire schema before any
    // downstream processing. Fail-closed on malformed bodies.
    const parsedReceipt = ExecutionReceiptSchema.safeParse(body.receipt);
    if (!parsedReceipt.success) {
      return c.json({ error: parsedReceipt.error.flatten() }, 400);
    }

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
    // Counted against the peer only once its signature verified.
    checkPeerLimit(body.origin_relay);

    // Relay owns: task queue update, WebSocket fan-out, trust update, credential issuance, settlement
    await deps.onTaskResultReceived({
      taskId: body.task_id,
      originRelay: body.origin_relay,
      receipt: body.receipt,
      agentPublicKey: body.agent_public_key,
    });

    return c.json({ status: "accepted" });
  });

  // ── Phase 5: Settlement ──

  /** @spec motebit/relay-federation@1.4 */
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
    // Counted against the peer only once its signature verified.
    checkPeerLimit(body.origin_relay);

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

  /** @spec motebit/relay-federation@1.4 */
  app.get("/federation/v1/settlements", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
    const rows = db
      .prepare("SELECT * FROM relay_federation_settlements ORDER BY settled_at DESC LIMIT ?")
      .all(limit);
    return c.json({ settlements: rows });
  });

  // ── Phase 5: Settlement Proof (§7.6.6) ──

  /** @spec motebit/relay-federation@1.4 */
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

    // Returns `{ proof, record }` — the typed FederationSettlementAnchorProof
    // plus the signed FederationSettlementRecord the leaf commits, so a peer
    // self-verifies offline with `verifyFederationSettlementAnchor(record, proof)`
    // (§7.6.6, the §9.1 convergence).
    const result = await getSettlementProof(db, settlementId);
    if (!result) {
      throw new HTTPException(404, { message: "Settlement not found or not batched" });
    }

    return c.json(result);
  });
}
