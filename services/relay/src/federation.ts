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
  parseFederationMessage,
  signAdjudicatorVote,
  signFederationMessage,
  signHorizonWitnessRequestBody,
  verifyFederationMessage,
  verifyHorizonWitnessRequestSignature,
  verifyWitnessOmissionDispute,
  type FederationMessageEnvelope,
  type FederationMessageKind,
  type FederationMessageRefusal,
  type SignedFederationMessage,
} from "@motebit/crypto";
import type { DisputeOutcome, VoteRequest } from "@motebit/protocol";
import {
  VoteRequestSchema,
  WitnessOmissionDisputeSchema,
  WitnessSolicitationRequestSchema,
} from "@motebit/wire-schemas";
import { persistWitnessOmissionDispute, resolveHorizonCertBySignature } from "./horizon.js";
// Every signed federation message — handshake, heartbeat, removal, and the
// work kinds (discover, task forward/result, settlement forward) — is a v2
// signed message for ONE recipient by key (relay-federation@1.5 §3.5): one
// producer and one verifier in @motebit/crypto (`signFederationMessage` /
// `verifyFederationMessage`), reached for the work kinds only through
// `signFederationRequest` / `verifyFederationRequest` below.
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

  // v2 signed-message replay store (relay-federation@1.5 §3.5): one row per
  // (sender, nonce) a verified v2 message carried, written in the same
  // transaction as the write the message authorized, kept until the
  // message's freshness window has passed (pruned on insert).
  db.exec(`
      CREATE TABLE IF NOT EXISTS relay_federation_nonces (
        sender_relay_id TEXT NOT NULL,
        nonce           TEXT NOT NULL,
        expires_at      INTEGER NOT NULL,
        PRIMARY KEY (sender_relay_id, nonce)
      );
  `);

  // Migration: Phase 5 trust tracking columns + Phase 6 protocol version
  for (const col of [
    "ALTER TABLE relay_peers ADD COLUMN trust_level TEXT NOT NULL DEFAULT 'first_contact'",
    "ALTER TABLE relay_peers ADD COLUMN successful_forwards INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE relay_peers ADD COLUMN failed_forwards INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE relay_peers ADD COLUMN peer_protocol_version TEXT",
    // The protocol this relay ran the peer's handshake under, written at a
    // completed confirm. `peer_protocol_version` is only the proposer's
    // claim, and the CLI proposer sends none — so this is the v2 evidence the
    // identity-authority census (Q6) reads.
    "ALTER TABLE relay_peers ADD COLUMN handshake_protocol_version TEXT",
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

// === Federation signed messages v2 (relay-federation@1.5 §3.5) ===

/** How long a recorded v2 nonce is kept: twice the ±5-minute window, past any accepted ts. */
const FEDERATION_NONCE_RETENTION_MS = 2 * 300_000;

/** True when `(sender, nonce)` is already recorded — a replay. Read-only. */
function federationNonceSeen(db: DatabaseDriver, sender: string, nonce: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM relay_federation_nonces WHERE sender_relay_id = ? AND nonce = ?")
      .get(sender, nonce) !== undefined
  );
}

/**
 * Record a verified v2 message's nonce. Call INSIDE the transaction of the
 * write the message authorizes; returns false when the nonce was already
 * recorded (a concurrent replay), and the caller must then throw so the
 * write rolls back.
 */
function consumeFederationNonce(
  db: DatabaseDriver,
  sender: string,
  nonce: string,
  ts: number,
): boolean {
  db.prepare("DELETE FROM relay_federation_nonces WHERE expires_at < ?").run(Date.now());
  return (
    db
      .prepare(
        "INSERT OR IGNORE INTO relay_federation_nonces (sender_relay_id, nonce, expires_at) VALUES (?, ?, ?)",
      )
      .run(sender, nonce, Math.max(ts, Date.now()) + FEDERATION_NONCE_RETENTION_MS).changes === 1
  );
}

/** HTTP status for a refused v2 message: a bad signature is 403, every shape/binding fault 400. */
function federationRefusalStatus(reason: FederationMessageRefusal): 400 | 403 {
  return reason === "bad_signature" ? 403 : 400;
}

/**
 * §3.5's checks that come BEFORE the sender's key is looked up, in the spec's
 * order: the recipient KEY = this relay's own key (relay ids are not
 * self-certifying, so a message minted for an identity that claimed this
 * relay's id under another key is refused first), the kind this route serves,
 * then the recipient id = this relay. A message for another relay is refused
 * (400) the same whether or not this relay knows its sender; only then is an
 * unknown sender a 403.
 */
function refuseBeforeLookup(
  env: FederationMessageEnvelope,
  kind: FederationMessageKind,
  self: RelayIdentity,
  label: string,
): void {
  const reason: FederationMessageRefusal | null =
    env.recipient_public_key !== self.publicKeyHex.toLowerCase()
      ? "wrong_recipient_key"
      : env.kind !== kind
        ? "kind_mismatch"
        : env.recipient !== self.relayMotebitId
          ? "wrong_recipient"
          : null;
  if (reason !== null) throw new HTTPException(400, { message: `${label} refused: ${reason}` });
}

/** The body a v2 `heartbeat` commits to. */
function heartbeatBody(agentCount: number, revocations: RevocationEvent[] | undefined) {
  return { agent_count: agentCount, revocations: revocations ?? [] };
}

/** The body a v2 `peer-remove` commits to. */
const PEER_REMOVE_BODY = { action: "remove" } as const;

/**
 * The body a v2 `peer-challenge` (§3.1 step 2) commits to: the proposer's
 * nonce it answers, the nonce this relay issued for the confirm, and the
 * endpoint this relay recorded for the proposer. The proposer's KEY is the
 * envelope's `recipient_public_key` (§3.5), so the proposer sees the
 * handshake is bound to its key, not only its id.
 */
function peerChallengeBody(requestNonce: string, nonce: string, proposerEndpointUrl: string) {
  return {
    request_nonce: requestNonce,
    nonce,
    proposer_endpoint_url: proposerEndpointUrl,
  };
}

/**
 * The body a v2 `peer-confirm` (§3.1 step 3) commits to: the nonce the
 * recipient issued and the sender's endpoint being confirmed. The recipient's
 * KEY is the envelope's `recipient_public_key` (§3.5), checked against the
 * verifying relay's own key before anything else (cold reviews R2, round 3).
 */
function peerConfirmBody(nonce: string, endpointUrl: string) {
  return { nonce, endpoint_url: endpointUrl };
}

/** An endpoint in comparable form: parsed, without a trailing slash; null when not a URL. */
function endpointKey(url: string): string | null {
  try {
    return new URL(url).href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

// === Peer Row Authority ===
//
// relay-federation@1.5 §3.1, "Peer row authority". Every write to a peer's
// `relay_peers` row goes through `writePeerRow`, which asks
// `peerRowTransition` first. For a relay_id that was ever confirmed
// (`peered_at` set) an unauthenticated request writes nothing; this relay's
// own observation may only move the row away from `active`; and the key,
// the endpoint and a move to `active`/`pending` follow only a message
// verified under the row's CURRENT stored key. The public key is never
// rewritten by any request (re-keying is the operator deleting the row).
// A relay_id never confirmed has NO row: a propose records only a pending
// handshake beside the table, and a row is born only from a confirm verified
// under the key it records; a never-confirmed row an earlier build wrote is
// inert (it pins no key and nothing updates it) until a verified confirm
// replaces it. Every write is a compare-and-set
// against the row as read, so a write decided before an await never lands
// on a row that changed during it.

/** The `relay_peers` columns the authority rule reads and the guarded writer writes. */
export interface PeerRow {
  peer_relay_id: string;
  public_key: string;
  endpoint_url: string;
  display_name: string | null;
  state: string;
  nonce: string | null;
  peered_at: number | null;
  last_heartbeat_at: number | null;
  missed_heartbeats: number;
  agent_count: number;
  peer_protocol_version: string | null;
  handshake_protocol_version: string | null;
}

/** What a write rests on. */
export type PeerWriteAuthority =
  /** No proof under the row's key: a propose, a confirm that did not verify. */
  | "unauthenticated"
  /** This relay's own observation of the peer (an outbound heartbeat that failed). */
  | "observed"
  /** A message verified under the row's current stored key. */
  | "peer-key";

export type PeerRowWrite =
  { op: "insert"; row: PeerRow } | { op: "update"; row: PeerRow } | { op: "delete" };

const PEER_ROW_COLUMNS =
  "peer_relay_id, public_key, endpoint_url, display_name, state, nonce, peered_at, last_heartbeat_at, missed_heartbeats, agent_count, peer_protocol_version, handshake_protocol_version";

/** The peer's row as it is now, in the shape the guard compares against. */
export function readPeerRow(db: DatabaseDriver, peerRelayId: string): PeerRow | undefined {
  return db
    .prepare(`SELECT ${PEER_ROW_COLUMNS} FROM relay_peers WHERE peer_relay_id = ?`)
    .get(peerRelayId) as PeerRow | undefined;
}

/**
 * The authority rule, pure: `null` when `write` may move `before`, else the
 * reason it may not.
 */
export function peerRowTransition(
  before: PeerRow | undefined,
  write: PeerRowWrite,
  authority: PeerWriteAuthority,
): string | null {
  // A row is born only from a confirm verified under the key it records
  // (§3.1): a propose writes no row, so a relay_id never confirmed has none.
  if (write.op === "insert") {
    if (before !== undefined) return "the row exists";
    if (write.row.peered_at == null || authority !== "peer-key")
      return "a peer's row is written only by a confirm verified under its key";
    return null;
  }
  if (before === undefined) return "no row";
  // Never confirmed (a row an earlier build wrote at propose): it confers no
  // authority — nothing moves it, and only a verified confirm replaces it
  // (delete, then insert, in one transaction).
  if (before.peered_at == null)
    return write.op === "delete" && authority === "peer-key"
      ? null
      : "a never-confirmed row is inert: only a verified confirm replaces it";
  if (write.op === "update") {
    if (write.row.peer_relay_id !== before.peer_relay_id) return "peer_relay_id is fixed";
    if (write.row.public_key !== before.public_key) return "a peer's public_key is never rewritten";
    if (write.row.peered_at == null) return "a confirmed row stays confirmed";
  }
  if (write.op === "delete") return "a confirmed peer's row is deleted only by its operator";
  if (authority === "unauthenticated")
    return "an unauthenticated request never writes a confirmed peer's row";
  if (authority === "peer-key") return null;
  // observed: never the endpoint, never the confirmation, never toward active.
  const next = write.row;
  if (next.endpoint_url !== before.endpoint_url)
    return "the endpoint moves only under the peer's key";
  if (next.peered_at !== before.peered_at) return "peered_at moves only under the peer's key";
  if (next.state !== before.state && (next.state === "active" || next.state === "pending"))
    return "a move to active or pending needs the peer's key";
  return null;
}

/**
 * The one writer of a peer's row. Refused by `peerRowTransition`, or the row
 * no longer what `before` read, ⇒ nothing is written and `false`.
 */
export function writePeerRow(
  db: DatabaseDriver,
  before: PeerRow | undefined,
  write: PeerRowWrite,
  authority: PeerWriteAuthority,
): boolean {
  const refused = peerRowTransition(before, write, authority);
  if (refused !== null) {
    logger.warn("federation.peer.write_refused", {
      peerId: write.op === "delete" ? before?.peer_relay_id : write.row.peer_relay_id,
      op: write.op,
      authority,
      reason: refused,
    });
    return false;
  }
  if (write.op === "insert") {
    const r = write.row;
    return (
      db
        .prepare(
          `INSERT INTO relay_peers (peer_relay_id, public_key, endpoint_url, display_name, state, nonce, peered_at, last_heartbeat_at, missed_heartbeats, agent_count, peer_protocol_version, handshake_protocol_version, trust_score)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.5)
           ON CONFLICT(peer_relay_id) DO NOTHING`,
        )
        .run(
          r.peer_relay_id,
          r.public_key,
          r.endpoint_url,
          r.display_name,
          r.state,
          r.nonce,
          r.peered_at,
          r.last_heartbeat_at,
          r.missed_heartbeats,
          r.agent_count,
          r.peer_protocol_version,
          r.handshake_protocol_version,
        ).changes > 0
    );
  }
  const b = before!;
  const asRead = [
    b.peer_relay_id,
    b.public_key,
    b.endpoint_url,
    b.state,
    b.nonce,
    b.peered_at,
    b.last_heartbeat_at,
    b.missed_heartbeats,
  ];
  const AS_READ = `peer_relay_id = ? AND public_key = ? AND endpoint_url = ? AND state = ?
       AND nonce IS ? AND peered_at IS ? AND last_heartbeat_at IS ? AND missed_heartbeats = ?`;
  if (write.op === "delete") {
    return db.prepare(`DELETE FROM relay_peers WHERE ${AS_READ}`).run(...asRead).changes > 0;
  }
  const r = write.row;
  return (
    db
      .prepare(
        `UPDATE relay_peers SET endpoint_url = ?, display_name = ?, state = ?, nonce = ?,
           peered_at = ?, last_heartbeat_at = ?, missed_heartbeats = ?, agent_count = ?,
           peer_protocol_version = ?, handshake_protocol_version = ?
         WHERE ${AS_READ}`,
      )
      .run(
        r.endpoint_url,
        r.display_name,
        r.state,
        r.nonce,
        r.peered_at,
        r.last_heartbeat_at,
        r.missed_heartbeats,
        r.agent_count,
        r.peer_protocol_version,
        r.handshake_protocol_version,
        ...asRead,
      ).changes > 0
  );
}

/**
 * A handshake pending its confirm (§3.1) is held by NO table: the nonce a
 * propose answers with IS the handshake — 16 random bytes and a 16-byte
 * HMAC, under a key this relay process holds, over (relay_id, the proposed
 * key, the proposed endpoint, those random bytes, the issuing window). A
 * confirm presents the key and endpoint again; the nonce verifies only for
 * exactly what its propose named, in the window it was issued or the next.
 *
 * Nothing is stored, so nothing can be evicted or exhausted: any number of
 * proposes naming a relay_id — under any key, including the id's real
 * (public) one — leave every other proposer's nonce valid (cold review round
 * 3, F3/F4; the slot table it replaces let 8 proposes evict a confirmed
 * peer's in-flight re-handshake, and the per-id limit let 30 lock a
 * never-peered relay out). A propose is unauthenticated, so it writes no row
 * either: a relay_id never confirmed has no row at all, and a confirmed
 * peer's row moves only when a confirm verifies under its stored key.
 */
const HANDSHAKE_WINDOW_MS = 5 * 60 * 1000;
/** Cosmetic propose fields (display name, spec version) kept by nonce; evicting one costs only those. */
const HANDSHAKE_COSMETICS_MAX = 4096;

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
    .prepare(`SELECT ${PEER_ROW_COLUMNS} FROM relay_peers WHERE state IN ('active', 'suspended')`)
    .all() as PeerRow[];

  if (peers.length === 0) return;

  const agentCount = (
    db.prepare(`SELECT COUNT(*) as cnt FROM agent_registry WHERE ${ON_SHELF_PREDICATE}`).get() as {
      cnt: number;
    }
  ).cnt;

  const results = await Promise.allSettled(
    peers.map(async (peer) => {
      // Collect revocation events since this peer's last heartbeat
      const lastHb =
        (
          db
            .prepare("SELECT last_heartbeat_at FROM relay_peers WHERE peer_relay_id = ?")
            .get(peer.peer_relay_id) as { last_heartbeat_at: number | null } | undefined
        )?.last_heartbeat_at ?? 0;
      // The wire form is what the peer hashes, so commit to the JSON round
      // trip (an absent optional field and an `undefined` one must agree).
      const revocations = JSON.parse(
        JSON.stringify(getRevocationEventsSince(db, lastHb)),
      ) as RevocationEvent[];

      // One v2 `heartbeat` per peer (relay-federation@1.5 §3.2): the message
      // names its recipient and a single-use nonce, so it is good at this
      // peer, once, and nowhere else.
      // Addressed by the key this relay verified the peer under (its row's),
      // not by id alone: a row whose id a stranger holds here under its own
      // key yields heartbeats only that stranger's key accepts (round 3, F2).
      const message = await signFederationMessage({
        kind: "heartbeat",
        sender: relayIdentity.relayMotebitId,
        recipient: peer.peer_relay_id,
        recipientPublicKey: peer.public_key,
        body: heartbeatBody(agentCount, revocations),
        privateKey: relayIdentity.privateKey,
      });
      const resp = await peerFetch(`${peer.endpoint_url}/federation/v1/peer/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          agent_count: agentCount,
          ...(revocations.length > 0 ? { revocations } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok)
        return { peerId: peer.peer_relay_id, ok: false, missed: peer.missed_heartbeats };
      // Delivered only when the peer's signed `heartbeat-ack` answers THIS
      // request's nonce under the peer's stored key — a bare 2xx is not
      // liveness (§3.2; the v1 response was never verified).
      const ack = (await resp.json().catch(() => null)) as {
        message?: unknown;
        agent_count?: unknown;
      } | null;
      const ackCount = typeof ack?.agent_count === "number" ? ack.agent_count : -1;
      const verdict = await verifyFederationMessage(ack?.message, {
        kind: "heartbeat-ack",
        self: relayIdentity.relayMotebitId,
        selfPublicKeyHex: relayIdentity.publicKeyHex,
        expectedSender: peer.peer_relay_id,
        senderPublicKeyHex: peer.public_key,
        body: { request_nonce: message.envelope.nonce, agent_count: ackCount },
      });
      if (!verdict.ok) {
        logger.warn("federation.heartbeat.ack_refused", {
          peerId: peer.peer_relay_id,
          reason: verdict.reason,
        });
      }
      return { peerId: peer.peer_relay_id, ok: verdict.ok, missed: peer.missed_heartbeats };
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const peer = peers[i]!;
    const result = results[i]!;
    const succeeded = result.status === "fulfilled" && result.value.ok;

    // Each write is against the row as read before the sends: a row that
    // changed while this tick awaited its peers (a confirm, an inbound
    // heartbeat, a remove) is left as it now is (§3.1, peer row authority).
    if (succeeded) {
      // Hysteresis: decrement missed count by 1 rather than resetting to 0.
      // A suspended peer (3 misses) needs 3 consecutive successes to reactivate,
      // preventing rapid suspended↔active oscillation on flaky connections.
      // The ack verified under the stored key, so this is the peer's word.
      const newMissed = Math.max(0, peer.missed_heartbeats - 1);
      const newState = newMissed === 0 ? "active" : peer.state;
      writePeerRow(
        db,
        peer,
        {
          op: "update",
          row: {
            ...peer,
            missed_heartbeats: newMissed,
            state: newState,
            last_heartbeat_at: Date.now(),
          },
        },
        "peer-key",
      );
    } else {
      const newMissed = peer.missed_heartbeats + 1;
      const newState =
        newMissed >= HEARTBEAT_REMOVE_THRESHOLD
          ? "removed"
          : newMissed >= HEARTBEAT_SUSPEND_THRESHOLD
            ? "suspended"
            : peer.state;
      writePeerRow(
        db,
        peer,
        { op: "update", row: { ...peer, missed_heartbeats: newMissed, state: newState } },
        "observed",
      );
      if (newState !== peer.state) {
        logger.warn(`federation.peer.${newState}`, { peerId: peer.peer_relay_id });
      } else {
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
      // The stored fields; a row written before the v2 envelope also carries
      // a `timestamp`, which is dropped (the envelope's `ts` is the clock now).
      const { timestamp: _legacyTs, ...settlementBody } = JSON.parse(retry.payload_json) as Record<
        string,
        unknown
      >;
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

      // Re-signed on every attempt (fresh nonce and `ts`), for this one peer.
      const signed = await signFederationRequest(
        db,
        relayIdentity,
        "settlement-forward",
        retry.peer_relay_id,
        settlementBody,
      );

      // Re-claimed after the signing await, in the same turn as the send.
      if (!beginForwardSend(db, retry.settlement_id)) continue;
      const resp = await peerFetch(`${peerInfo.endpoint_url}/federation/v1/settlement/forward`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Correlation-ID": retry.task_id },
        body: JSON.stringify(signed),
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
// re-signed from the task's archived answer at each attempt (a fresh v2
// `task-result` message for the origin's key: new nonce, new `ts`); the origin's door decides it
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
    const signed = await signFederationRequest(
      db,
      relayIdentity,
      "task-result",
      row.peer_relay_id,
      {
        task_id: taskId,
        origin_relay: relayIdentity.relayMotebitId,
        receipt,
        ...(key !== null ? { agent_public_key: key } : {}),
      },
    );
    const resp = await peerFetch(`${peer.endpoint_url}/federation/v1/task/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Correlation-ID": taskId },
      body: JSON.stringify(signed),
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

// === Work messages: signed for ONE recipient (relay-federation@1.5 §3.5) ===
//
// Every signed federation message names the relay it is for, and a relay acts
// only on messages addressed to its own key. The four work kinds — discover,
// task/forward, task/result, settlement/forward — used to be signed over a body
// that named no recipient (`verifyPeerSignature`): a body one relay signed for
// a second verified at ANY relay that peers the signer, inside the ±5 min
// window, and only incidental task state stopped it. They now ride the SAME v2
// envelope as the control kinds (one producer, one verifier in @motebit/crypto):
// the request is the kind's own fields plus `message`, a v2 signed message
// whose `body_sha256` commits to those fields and whose `recipient_public_key`
// the receiving relay compares to its OWN key before any lookup.

/** The work kinds, by the route that serves each. */
export const FEDERATION_WORK_ROUTES = {
  discover: "/federation/v1/discover",
  "task-forward": "/federation/v1/task/forward",
  "task-result": "/federation/v1/task/result",
  "settlement-forward": "/federation/v1/settlement/forward",
} as const satisfies Partial<Record<FederationMessageKind, string>>;

export type FederationWorkKind = keyof typeof FEDERATION_WORK_ROUTES;

/**
 * The body field that names a work message's sender — the relay that signed
 * THIS hop. The envelope's `sender` must equal it, so the field a handler reads
 * as "who sent this" is the key that signed it.
 */
const WORK_SENDER_FIELD: Record<FederationWorkKind, "sender_relay" | "origin_relay"> = {
  discover: "sender_relay",
  "task-forward": "origin_relay",
  "task-result": "origin_relay",
  "settlement-forward": "origin_relay",
};

/**
 * Sign a work request for ONE peer: `body` (the kind's own fields) plus
 * `message`, a v2 `kind` message from this relay to `recipient`, by id AND by
 * the key this relay holds for it in `relay_peers`. A relay that holds no key
 * for the recipient has nothing to sign (throws). The only producer of work
 * requests; every sender (discover fan-out and re-forward, task forward,
 * result delivery, settlement forward and its retry) goes through it.
 */
export async function signFederationRequest<T extends Record<string, unknown>>(
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
  kind: FederationWorkKind,
  recipient: string,
  body: T,
): Promise<T & { message: SignedFederationMessage }> {
  if ("message" in body) throw new Error(`a ${kind} body must not carry \`message\``);
  if (body[WORK_SENDER_FIELD[kind]] !== relayIdentity.relayMotebitId)
    throw new Error(`a ${kind} body must name this relay as ${WORK_SENDER_FIELD[kind]}`);
  const peer = db
    .prepare("SELECT public_key FROM relay_peers WHERE peer_relay_id = ?")
    .get(recipient) as { public_key: string } | undefined;
  if (peer === undefined) throw new Error(`no key on record for peer relay ${recipient}`);
  const message = await signFederationMessage({
    kind,
    sender: relayIdentity.relayMotebitId,
    recipient,
    recipientPublicKey: peer.public_key,
    body,
    privateKey: relayIdentity.privateKey,
  });
  return { ...body, message };
}

/**
 * Verify an inbound work request of `kind` at this relay. The only verifier of
 * work requests. In order: a request without `message` is v1 and refused by
 * name (no downgrade path); the envelope must parse; then — before any lookup
 * — the recipient KEY must be this relay's own key, the kind the route's, the
 * recipient id this relay's (`refuseBeforeLookup`); the body's sender field
 * must be the envelope's sender; the sender must be a peer in an allowed
 * state; then freshness, the body digest and the signature
 * (`verifyFederationMessage`); then the nonce is consumed (a replay is 409).
 *
 * The nonce is consumed before the handler's write, not inside it: every
 * sender re-signs on every attempt (fresh nonce), so a request whose write
 * then fails is retried as a new message, never as this one.
 *
 * Returns the verified sender and its key.
 */
async function verifyFederationRequest(
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
  kind: FederationWorkKind,
  request: Record<string, unknown>,
  allowedStates: readonly string[],
): Promise<{ sender: string; senderPublicKey: string }> {
  const label = `federation ${kind}`;
  const { message, ...body } = request;
  if (message === undefined) {
    throw new HTTPException(400, {
      message: `${label} v1 is refused (relay-federation@1.5 §3.5): send the request's fields with \`message\`, a v2 \`${kind}\` signed message naming this relay as recipient by key`,
    });
  }
  const parsed = parseFederationMessage(message);
  if (parsed === null)
    throw new HTTPException(400, { message: `malformed v2 ${kind} message (§3.5)` });
  refuseBeforeLookup(parsed.envelope, kind, relayIdentity, label);
  const sender = parsed.envelope.sender;
  if (body[WORK_SENDER_FIELD[kind]] !== sender)
    throw new HTTPException(400, {
      message: `${label} refused: ${WORK_SENDER_FIELD[kind]} is not the message's sender`,
    });
  const peer = db
    .prepare("SELECT public_key, state FROM relay_peers WHERE peer_relay_id = ?")
    .get(sender) as { public_key: string; state: string } | undefined;
  if (peer === undefined || !allowedStates.includes(peer.state))
    throw new HTTPException(403, { message: "Unknown or inactive peer relay" });
  const verdict = await verifyFederationMessage(message, {
    kind,
    self: relayIdentity.relayMotebitId,
    selfPublicKeyHex: relayIdentity.publicKeyHex,
    expectedSender: sender,
    senderPublicKeyHex: peer.public_key,
    body,
  });
  if (!verdict.ok)
    throw new HTTPException(federationRefusalStatus(verdict.reason), {
      message: `${label} refused: ${verdict.reason}`,
    });
  if (!consumeFederationNonce(db, sender, verdict.envelope.nonce, verdict.envelope.ts))
    throw new HTTPException(409, { message: `${label} refused: replayed nonce` });
  return { sender, senderPublicKey: peer.public_key };
}

/**
 * Sign an outbound `/federation/v1/discover` hop for ONE peer: stamp
 * `sender_relay` (THIS relay — the immediate forwarder, distinct from the
 * multi-hop `origin_relay`) and sign it as a `discover` work request to
 * `recipient`. All three discover senders — the originating task-routing
 * query (`task-routing.ts`), the marketplace discover fan-out (`agents.ts`),
 * and the fan-out re-forward (the discover handler below) — route through
 * this helper, so every hop is signed for exactly the peer it is sent to.
 * relay-federation@1.5 §3.5, §4.1.1.
 */
export async function signDiscoverBody<T extends Record<string, unknown>>(
  db: DatabaseDriver,
  relayIdentity: RelayIdentity,
  recipient: string,
  body: T,
): Promise<T & { sender_relay: string; message: SignedFederationMessage }> {
  return signFederationRequest(db, relayIdentity, "discover", recipient, {
    ...body,
    sender_relay: relayIdentity.relayMotebitId,
  });
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

  /** @spec motebit/relay-federation@1.5 */
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

  // Pending handshakes (§3.1) are nonces this relay can recognise, never
  // rows or slots: see HANDSHAKE_WINDOW_MS. The key lives in memory — a
  // restart costs only a re-propose, as the in-memory table it replaces did.
  const handshakeKey = randomBytes(32);
  const handshakeCosmetics = new Map<
    string,
    { display_name: string | null; peer_protocol_version: string | null }
  >();

  function handshakeTag(
    relayId: string,
    publicKey: string,
    endpointUrl: string,
    rand: string,
    window: number,
  ): Buffer {
    return createHmac("sha256", handshakeKey)
      .update(
        JSON.stringify([
          "motebit-peer-handshake",
          relayId,
          publicKey.toLowerCase(),
          endpointUrl,
          rand,
          window,
        ]),
      )
      .digest()
      .subarray(0, 16);
  }

  /** The nonce a propose answers with: the handshake itself (32 bytes, hex). */
  function issueHandshake(relayId: string, publicKey: string, endpointUrl: string): string {
    const rand = randomBytes(16).toString("hex");
    const window = Math.floor(Date.now() / HANDSHAKE_WINDOW_MS);
    return rand + handshakeTag(relayId, publicKey, endpointUrl, rand, window).toString("hex");
  }

  /** True iff `nonce` was issued by this relay for exactly (relayId, key, endpoint), this window or the last. */
  function handshakeValid(
    relayId: string,
    publicKey: string,
    endpointUrl: string,
    nonce: string,
  ): boolean {
    if (!/^[0-9a-f]{64}$/.test(nonce)) return false;
    const rand = nonce.slice(0, 32);
    const tag = Buffer.from(nonce.slice(32), "hex");
    const window = Math.floor(Date.now() / HANDSHAKE_WINDOW_MS);
    return [window, window - 1].some((w) =>
      timingSafeEqual(tag, handshakeTag(relayId, publicKey, endpointUrl, rand, w)),
    );
  }

  /**
   * The removed-record cooldown (§3.1): a removed peer re-handshakes only
   * five minutes after its last verified heartbeat or confirm. Checked at
   * propose and again at confirm, since a nonce outlives the propose that
   * issued it. `last_heartbeat_at` moves only under the peer's key, so no
   * caller can extend it.
   */
  function checkRemovedCooldown(peer: PeerRow | undefined): void {
    if (
      peer &&
      peer.state === "removed" &&
      peer.last_heartbeat_at != null &&
      peer.last_heartbeat_at !== 0
    ) {
      const cooldownMs = 5 * 60 * 1000;
      const elapsed = Date.now() - peer.last_heartbeat_at;
      if (elapsed < cooldownMs) {
        const retryAfter = Math.ceil((cooldownMs - elapsed) / 1000);
        throw new HTTPException(429, {
          message: `Removed peer must wait ${retryAfter}s before re-peering`,
        });
      }
    }
  }

  /** @spec motebit/relay-federation@1.5 */
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
    // Self-propose is refused (relay-federation@1.5 §3.1, G1): its answer was
    // this relay's signature over `{own_id}:{caller_nonce}:{suite}` — exactly
    // the step-3 confirm bytes — so any caller could mint a confirm "from"
    // this relay for a nonce of its choosing and complete a handshake at a
    // third relay with its own endpoint. Refused before anything is signed or
    // stored; the confirm is minted only on the operator's authority.
    if (relay_id === relayIdentity.relayMotebitId) {
      throw new HTTPException(400, {
        message:
          "self-propose is refused (relay-federation@1.5 §3.1): a propose may not name this relay's own id. A relay's confirm signature is minted only by its operator — POST /api/v1/admin/federation/peer-confirm-signature (master token) with { nonce, recipient, recipient_public_key }",
      });
    }
    if (!endpoint_url) throw new HTTPException(400, { message: "endpoint_url is required" });
    if (!nonce) throw new HTTPException(400, { message: "nonce is required" });
    // The challenge proves control of the proposed KEY; it says nothing about
    // whether the endpoint is a safe destination for this relay to contact.
    // Persist only globally-routable peer endpoints.
    const peerVerdict = await checkOutboundUrl(endpoint_url, deps.outboundPolicy);
    if (!peerVerdict.ok) {
      throw new HTTPException(400, { message: `endpoint_url refused: ${peerVerdict.reason}` });
    }

    checkFederationEnabled();
    checkVersionCompatibility(spec_version);

    checkPeerPolicy(relay_id);
    const existing = readPeerRow(db, relay_id);
    // Only a confirmed row is a peer (§3.1). A never-confirmed row an earlier
    // build wrote at propose confers no authority: it pins no key, holds no
    // id, and runs no cooldown — a verified confirm replaces it.
    const peer = existing?.peered_at != null ? existing : undefined;
    // A propose writes nothing and stores nothing (the nonce is the
    // handshake), so it spends no per-peer slot for any relay_id: an
    // unauthenticated caller naming a relay_id — under any key, the id's real
    // one included — must not be able to rate-limit the real relay out of
    // peering or recovering (§3.1; round 3, F4). The per-IP limiter applies.
    checkMaxPeers();

    // A known peer's key is never replaced by a propose (relay-federation@1.5
    // §3.1; identity-authority I1 applied to peers). The propose proves
    // nothing about who holds the row's key. Refused in every state of a
    // confirmed row, before anything is signed or recorded. Re-keying a peer
    // is an operator act that first deletes the row; there is no route for it.
    if (peer && peer.public_key.toLowerCase() !== public_key.toLowerCase()) {
      throw new HTTPException(409, {
        message:
          "public_key differs from the key on record for this relay_id (relay-federation@1.5 §3.1): a propose may not replace a known peer's key. Re-peer under the recorded key; re-keying a peer requires its operator to delete the row first",
      });
    }
    // Active: nothing to recover.
    if (peer && peer.state === "active") {
      throw new HTTPException(409, { message: `Peer already exists in ${peer.state} state` });
    }
    // Cooldown: removed peers must wait 5 minutes before re-peering.
    // Prevents rapid removed→pending oscillation when the root cause persists.
    checkRemovedCooldown(peer);

    if (!/^[0-9a-f]{64}$/i.test(public_key))
      throw new HTTPException(400, { message: "public_key must be 64 hex characters" });
    const ourNonce = issueHandshake(relay_id, public_key, endpoint_url);

    // Step 2 as a v2 `peer-challenge` (§3.1, §3.5): from this relay to the
    // ONE proposer — by id and by the key the propose named — answering its
    // nonce, naming the nonce it must confirm and the endpoint recorded for
    // it, so the proposer's tooling can see, before it mints anything, that
    // the nonce came from this relay's key for its own endpoint and its own
    // key. Proves this relay holds the key it advertises.
    let challenge: Awaited<ReturnType<typeof signFederationMessage>>;
    try {
      challenge = await signFederationMessage({
        kind: "peer-challenge",
        sender: relayIdentity.relayMotebitId,
        recipient: relay_id,
        recipientPublicKey: public_key,
        body: peerChallengeBody(nonce, ourNonce, endpoint_url),
        privateKey: relayIdentity.privateKey,
      });
    } catch {
      throw new HTTPException(400, {
        message: "malformed propose: relay_id, public_key, nonce, endpoint_url",
      });
    }

    // The propose is unauthenticated: it stores nothing that carries
    // authority (§3.1). The row — its key, its endpoint, the move to active —
    // is written when a confirm verifies under the key this nonce names.
    // Only the cosmetic fields are kept, by nonce, and losing them is free.
    if (handshakeCosmetics.size >= HANDSHAKE_COSMETICS_MAX) {
      const oldest = handshakeCosmetics.keys().next().value;
      if (oldest !== undefined) handshakeCosmetics.delete(oldest);
    }
    handshakeCosmetics.set(ourNonce, {
      display_name: display_name ?? null,
      peer_protocol_version: spec_version ?? null,
    });

    return c.json({
      relay_id: relayIdentity.relayMotebitId,
      public_key: relayIdentity.publicKeyHex,
      endpoint_url: federationConfig?.endpointUrl ?? "self",
      display_name: federationConfig?.displayName ?? null,
      nonce: ourNonce,
      challenge,
      spec_version: RELAY_SPEC_VERSION,
    });
  });

  /** @spec motebit/relay-federation@1.5 */
  app.post("/federation/v1/peer/confirm", async (c) => {
    const body = await c.req.json<{
      message?: unknown;
      nonce?: unknown;
      public_key?: unknown;
      endpoint_url?: unknown;
      relay_id?: unknown;
      challenge_response?: unknown;
    }>();
    checkFederationEnabled();
    // v1 (`{relay_id}:{nonce}:{suite}`, naming no recipient and no endpoint)
    // is refused by name before any lookup, counter or row (D4: a confirm
    // minted for one relay was accepted at another, at the endpoint of
    // whoever obtained it — cold review F1). It changes nothing.
    if (body.message === undefined) {
      throw new HTTPException(400, {
        message:
          "federation peer confirm v1 ({relay_id}:{nonce}:{suite}) is refused (relay-federation@1.5 §3.1): send { message, nonce, public_key, endpoint_url } where message is a v2 `peer-confirm` signed message (§3.5) naming this relay as recipient by id and by public key, over the nonce this relay issued and the endpoint being confirmed — minted by the confirming relay's operator (POST /api/v1/admin/federation/peer-confirm-signature)",
      });
    }
    const parsed = parseFederationMessage(body.message);
    if (parsed === null)
      throw new HTTPException(400, { message: "malformed v2 peer-confirm message (§3.5)" });
    refuseBeforeLookup(parsed.envelope, "peer-confirm", relayIdentity, "Confirm");
    const relay_id = parsed.envelope.sender;
    if (body.relay_id !== undefined && body.relay_id !== relay_id)
      throw new HTTPException(400, { message: "relay_id is not the confirm's sender" });
    if (typeof body.nonce !== "string" || body.nonce === "")
      throw new HTTPException(400, {
        message: "nonce is required: the nonce this relay issued in its propose response",
      });
    if (
      typeof body.public_key !== "string" ||
      !/^[0-9a-f]{64}$/i.test(body.public_key) ||
      typeof body.endpoint_url !== "string" ||
      body.endpoint_url === ""
    )
      throw new HTTPException(400, {
        message:
          "public_key and endpoint_url are required: the key and endpoint the propose named, as it named them (relay-federation@1.5 §3.1)",
      });
    const answering = {
      nonce: body.nonce,
      key: body.public_key.toLowerCase(),
      endpoint: body.endpoint_url,
    };

    checkPeerPolicy(relay_id);

    const existing = readPeerRow(db, relay_id);
    const peer = existing?.peered_at != null ? existing : undefined;
    // The handshake this confirm answers: a nonce this relay issued for
    // exactly this relay_id, key and endpoint. For a confirmed peer it must
    // name the key on record (a key the row does not hold confers nothing,
    // whoever proposed it).
    if (
      (peer !== undefined && answering.key !== peer.public_key.toLowerCase()) ||
      !handshakeValid(relay_id, answering.key, answering.endpoint, answering.nonce)
    )
      throw new HTTPException(403, {
        message: "Confirm refused: no pending handshake for that relay_id, key, endpoint and nonce",
      });
    // A nonce outlives its propose: the removed-peer cooldown holds here too.
    checkRemovedCooldown(peer);

    // Verify under the key the handshake names: the sender confirms THIS
    // relay's nonce, for the endpoint THAT propose named, to THIS relay by id
    // and by key (the envelope, checked against this relay's own key).
    const verdict = await verifyFederationMessage(body.message, {
      kind: "peer-confirm",
      self: relayIdentity.relayMotebitId,
      selfPublicKeyHex: relayIdentity.publicKeyHex,
      expectedSender: relay_id,
      senderPublicKeyHex: answering.key,
      body: peerConfirmBody(answering.nonce, answering.endpoint),
    });
    if (!verdict.ok) {
      // No row is written — the failed confirm proves nothing (§3.1).
      throw new HTTPException(federationRefusalStatus(verdict.reason), {
        message: `Confirm refused: ${verdict.reason}`,
      });
    }
    const env = verdict.envelope;
    if (federationNonceSeen(db, relay_id, env.nonce))
      throw new HTTPException(409, { message: "Confirm refused: replayed nonce" });
    // Counted only once the signature verified, for every relay_id: an
    // unverified confirm never spends the real relay's slot (§3.1).
    checkPeerLimit(relay_id);
    const cosmetic = handshakeCosmetics.get(answering.nonce);
    const answered = {
      public_key: answering.key,
      endpoint_url: answering.endpoint,
      display_name: cosmetic?.display_name ?? null,
      peer_protocol_version:
        cosmetic === undefined
          ? (peer?.peer_protocol_version ?? null)
          : cosmetic.peer_protocol_version,
    };

    const now = Date.now();
    const confirmedRow = (base: PeerRow): PeerRow => ({
      ...base,
      endpoint_url: answered.endpoint_url,
      display_name: answered.display_name ?? base.display_name,
      peer_protocol_version: answered.peer_protocol_version,
      state: "active",
      peered_at: now,
      last_heartbeat_at: now,
      missed_heartbeats: 0,
      nonce: null,
      handshake_protocol_version: RELAY_SPEC_VERSION,
    });
    db.transaction(() => {
      if (!consumeFederationNonce(db, relay_id, env.nonce, env.ts))
        throw new HTTPException(409, { message: "Confirm refused: replayed nonce" });
      // A confirmed peer's row moves under its own key; otherwise the row is
      // born here — replacing a never-confirmed row an earlier build left.
      const written = peer
        ? writePeerRow(db, peer, { op: "update", row: confirmedRow(peer) }, "peer-key")
        : (existing === undefined || writePeerRow(db, existing, { op: "delete" }, "peer-key")) &&
          writePeerRow(
            db,
            undefined,
            {
              op: "insert",
              row: confirmedRow({
                peer_relay_id: relay_id,
                public_key: answered.public_key,
                endpoint_url: answered.endpoint_url,
                display_name: null,
                state: "active",
                nonce: null,
                peered_at: now,
                last_heartbeat_at: now,
                missed_heartbeats: 0,
                agent_count: 0,
                peer_protocol_version: null,
                handshake_protocol_version: null,
              }),
            },
            "peer-key",
          );
      // Thrown inside the transaction, so the nonce is not spent on a write
      // that did not land.
      if (!written) {
        throw new HTTPException(409, {
          message:
            "peer row changed during confirm (relay-federation@1.5 §3.1); retry the handshake",
        });
      }
    });
    handshakeCosmetics.delete(answering.nonce);

    logger.info("federation.peer.active", { peerId: relay_id });

    return c.json({ status: "active", peered_at: now });
  });

  /** @spec motebit/relay-federation@1.5 */
  app.post("/federation/v1/peer/heartbeat", async (c) => {
    const body = await c.req.json<{
      message?: unknown;
      agent_count?: number;
      revocations?: RevocationEvent[];
      relay_id?: string;
      signature?: string;
    }>();
    const { message, agent_count, revocations } = body;
    // v1 (`{relay_id}|{timestamp}|{suite}`, no recipient, no nonce) is refused
    // by name before any lookup, counter or rate-limit slot (D4: a replayed
    // v1 heartbeat moved a suspended peer to active and spent the peer's
    // rate limit). It changes nothing.
    if (message === undefined) {
      throw new HTTPException(400, {
        message:
          "federation heartbeat v1 is refused (relay-federation@1.5 §3.2): send { message, agent_count, revocations? } where message is a v2 `heartbeat` signed message (§3.5) naming this relay as recipient",
      });
    }
    const parsed = parseFederationMessage(message);
    if (parsed === null)
      throw new HTTPException(400, { message: "malformed v2 heartbeat message (§3.5)" });
    if (typeof agent_count !== "number" || !Number.isSafeInteger(agent_count) || agent_count < 0)
      throw new HTTPException(400, { message: "agent_count is required" });
    if (revocations !== undefined && !Array.isArray(revocations))
      throw new HTTPException(400, { message: "revocations must be an array" });
    refuseBeforeLookup(parsed.envelope, "heartbeat", relayIdentity, "Heartbeat");
    const relay_id = parsed.envelope.sender;

    const peer = readPeerRow(db, relay_id);
    if (!peer || (peer.state !== "active" && peer.state !== "suspended"))
      throw new HTTPException(403, { message: "Heartbeat refused: unknown peer" });

    const verdict = await verifyFederationMessage(message, {
      kind: "heartbeat",
      self: relayIdentity.relayMotebitId,
      selfPublicKeyHex: relayIdentity.publicKeyHex,
      senderPublicKeyHex: peer.public_key,
      body: heartbeatBody(agent_count, revocations),
    });
    if (!verdict.ok) {
      throw new HTTPException(federationRefusalStatus(verdict.reason), {
        message: `Heartbeat refused: ${verdict.reason}`,
      });
    }
    const env = verdict.envelope;
    if (federationNonceSeen(db, relay_id, env.nonce))
      throw new HTTPException(409, { message: "Heartbeat refused: replayed nonce" });
    // Counted only once the signature verified: an unverified or replayed
    // request never spends the peer's slot.
    checkPeerLimit(relay_id);

    // Hysteresis: decrement rather than reset, matching the sending side.
    const newMissed = Math.max(0, peer.missed_heartbeats - 1);
    const newState = newMissed === 0 ? "active" : peer.state;
    db.transaction(() => {
      if (!consumeFederationNonce(db, relay_id, env.nonce, env.ts))
        throw new HTTPException(409, { message: "Heartbeat refused: replayed nonce" });
      const written = writePeerRow(
        db,
        peer,
        {
          op: "update",
          row: {
            ...peer,
            last_heartbeat_at: Date.now(),
            missed_heartbeats: newMissed,
            agent_count,
            state: newState,
          },
        },
        "peer-key",
      );
      // The row changed while the signature was verified: refused, and the
      // nonce is not consumed (the transaction rolls back).
      if (!written)
        throw new HTTPException(409, { message: "Heartbeat refused: peer row changed; retry" });
    });

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

    const localAgentCount = (
      db
        .prepare(`SELECT COUNT(*) as cnt FROM agent_registry WHERE ${ON_SHELF_PREDICATE}`)
        .get() as {
        cnt: number;
      }
    ).cnt;
    // The ack answers exactly this request: it commits to the request's nonce
    // and names its sender as recipient (§3.2) — never the request's bytes.
    const ack = await signFederationMessage({
      kind: "heartbeat-ack",
      sender: relayIdentity.relayMotebitId,
      recipient: relay_id,
      recipientPublicKey: peer.public_key,
      body: { request_nonce: env.nonce, agent_count: localAgentCount },
      privateKey: relayIdentity.privateKey,
    });

    return c.json({ message: ack, agent_count: localAgentCount });
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
  /** @spec motebit/relay-federation@1.5 */
  app.post("/federation/v1/horizon/witness", async (c) => {
    const rawBody = (await c.req.json()) as unknown;
    const parsed = WitnessSolicitationRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: `WitnessSolicitationRequest schema rejected: ${parsed.error.message}`,
      });
    }
    const request = parsed.data;
    checkPeerLimit(request.issuer_id);

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
  /** @spec motebit/relay-federation@1.5 */
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
  /** @spec motebit/relay-federation@1.5 */
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
    checkPeerLimit(request.requester_id);

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

  /** @spec motebit/relay-federation@1.5 */
  app.post("/federation/v1/peer/remove", async (c) => {
    const body = await c.req.json<{ message?: unknown; relay_id?: string; signature?: string }>();
    // v1 (a signature over the bare relay_id — one signature removed the
    // signer at every relay, forever) is refused by name; it changes nothing.
    if (body.message === undefined) {
      throw new HTTPException(400, {
        message:
          "federation peer-remove v1 (signature over the bare relay_id) is refused (relay-federation@1.5 §3.3): send { message } where message is a v2 `peer-remove` signed message (§3.5) naming this relay as recipient",
      });
    }
    const parsed = parseFederationMessage(body.message);
    if (parsed === null)
      throw new HTTPException(400, { message: "malformed v2 peer-remove message (§3.5)" });
    refuseBeforeLookup(parsed.envelope, "peer-remove", relayIdentity, "Removal");
    const relay_id = parsed.envelope.sender;

    // A never-confirmed row (an earlier build wrote one at propose) is no
    // peer: its key was never proven, so a removal signed under it proves
    // nothing, and the row is inert — refused, nothing written (§3.3; cold
    // review R1: such a removal used to park the row `removed` under a
    // stranger's key, and the key pin then refused the real relay forever).
    const peer = readPeerRow(db, relay_id);
    if (!peer || peer.peered_at == null)
      throw new HTTPException(403, { message: "Removal refused: unknown peer" });

    const verdict = await verifyFederationMessage(body.message, {
      kind: "peer-remove",
      self: relayIdentity.relayMotebitId,
      selfPublicKeyHex: relayIdentity.publicKeyHex,
      senderPublicKeyHex: peer.public_key,
      body: PEER_REMOVE_BODY,
    });
    if (!verdict.ok) {
      throw new HTTPException(federationRefusalStatus(verdict.reason), {
        message: `Removal refused: ${verdict.reason}`,
      });
    }
    const env = verdict.envelope;
    if (federationNonceSeen(db, relay_id, env.nonce))
      throw new HTTPException(409, { message: "Removal refused: replayed nonce" });
    checkPeerLimit(relay_id);

    db.transaction(() => {
      if (!consumeFederationNonce(db, relay_id, env.nonce, env.ts))
        throw new HTTPException(409, { message: "Removal refused: replayed nonce" });
      if (!writePeerRow(db, peer, { op: "update", row: { ...peer, state: "removed" } }, "peer-key"))
        throw new HTTPException(409, { message: "Removal refused: peer row changed; retry" });
    });
    return c.json({ status: "removed" });
  });

  // Admin signing for federation peer removal — consumed by
  // `motebit federation peer-remove <peer-url>` (apps/cli).
  //
  // Mints a v2 `peer-remove` message (relay-federation@1.5 §3.3) for ONE
  // recipient, named by the key THIS relay verified it under: the confirmed
  // peer row this relay holds at `endpoint_url` (or for `recipient`). Never by
  // what the counterparty's `/identity` says — relay ids are not
  // self-certifying, so an identity claiming another peer's id would have had
  // this relay mint a removal good at THAT peer (cold review round 3, F1). No
  // confirmed row, no key, nothing minted. It removes this relay at that peer
  // only, once, within five minutes. Behind master-token admin auth
  // (services/relay/CLAUDE.md rule 5) because only the operator decides to
  // leave a peer.
  /** @internal */
  app.get("/api/v1/admin/federation/peer-removal-signature", async (c) => {
    const endpoint = c.req.query("endpoint_url");
    const recipient = c.req.query("recipient");
    if (!endpoint && !recipient) {
      throw new HTTPException(400, {
        message:
          "endpoint_url (or recipient) is required: the confirmed peer this removal is for (relay-federation@1.5 §3.3)",
      });
    }
    const wanted = endpoint ? endpointKey(endpoint) : null;
    if (endpoint && wanted === null)
      throw new HTTPException(400, { message: "endpoint_url is not a URL" });
    const rows = (
      db
        .prepare(`SELECT ${PEER_ROW_COLUMNS} FROM relay_peers WHERE peered_at IS NOT NULL`)
        .all() as PeerRow[]
    ).filter(
      (r) =>
        (wanted === null || endpointKey(r.endpoint_url) === wanted) &&
        (!recipient || r.peer_relay_id === recipient),
    );
    if (rows.length !== 1) {
      throw new HTTPException(rows.length === 0 ? 404 : 409, {
        message:
          rows.length === 0
            ? "this relay holds no confirmed peer there: a removal names its recipient by the key this relay verified it under (relay-federation@1.5 §3.3), so it mints only for a peer it holds"
            : "more than one confirmed peer matches; name the recipient as well",
      });
    }
    const row = rows[0]!;
    const message = await signFederationMessage({
      kind: "peer-remove",
      sender: relayIdentity.relayMotebitId,
      recipient: row.peer_relay_id,
      recipientPublicKey: row.public_key,
      body: PEER_REMOVE_BODY,
      privateKey: relayIdentity.privateKey,
    });
    return c.json({
      relay_id: relayIdentity.relayMotebitId,
      recipient: row.peer_relay_id,
      recipient_public_key: row.public_key.toLowerCase(),
      endpoint_url: row.endpoint_url,
      message,
    });
  });

  // Admin signing for the peering handshake's step 3 — consumed by
  // `motebit federation peer` (apps/cli). Mints a v2 `peer-confirm`
  // (relay-federation@1.5 §3.1, §3.5) from this relay to the ONE relay that
  // issued `nonce` (`recipient` by id, `recipient_public_key` by key — the
  // counterparty the operator proposed to, whose challenge the tooling
  // verified), confirming THIS relay's own federation endpoint. A relay
  // verifies a confirm against its OWN key, so a confirm minted for an
  // identity that claimed a relay's id under another key is refused there
  // (cold review R2). It never signs a bare
  // nonce: a confirm minted for one counterparty is refused at every other
  // relay, and confirms no endpoint but this relay's (cold review F1 — the
  // 1.4 bytes let a counterparty that returned another relay's nonce carry
  // this relay's confirm there, at its own endpoint).
  /** @internal */
  app.post("/api/v1/admin/federation/peer-confirm-signature", async (c) => {
    type MintBody = {
      nonce?: unknown;
      recipient?: unknown;
      recipient_public_key?: unknown;
      endpoint_url?: unknown;
    };
    const body: MintBody = await c.req.json<MintBody>().catch(() => ({}));
    if (typeof body.nonce !== "string" || !/^[0-9a-f]{64}$/i.test(body.nonce)) {
      throw new HTTPException(400, {
        message: "nonce is required: the 32-byte hex nonce the peer's propose response returned",
      });
    }
    if (
      typeof body.recipient !== "string" ||
      body.recipient === "" ||
      body.recipient === relayIdentity.relayMotebitId
    ) {
      throw new HTTPException(400, {
        message:
          "recipient is required: the relay_motebit_id of the ONE relay this relay proposed to — the relay that issued the nonce (relay-federation@1.5 §3.1)",
      });
    }
    // The recipient by key as well as id: relay ids are not self-certifying,
    // so the key is what names the relay the operator meant — the one whose
    // `peer-challenge` the tooling verified (cold review R2).
    if (
      typeof body.recipient_public_key !== "string" ||
      !/^[0-9a-f]{64}$/i.test(body.recipient_public_key) ||
      body.recipient_public_key.toLowerCase() === relayIdentity.publicKeyHex.toLowerCase()
    ) {
      throw new HTTPException(400, {
        message:
          "recipient_public_key is required: the hex Ed25519 public key of the ONE relay this relay proposed to — the key its peer-challenge verified under (relay-federation@1.5 §3.1)",
      });
    }
    const own = federationConfig?.endpointUrl;
    const ownKey = own === undefined ? null : endpointKey(own);
    if (own === undefined || ownKey === null) {
      throw new HTTPException(400, {
        message:
          "this relay has no federation endpoint configured (federation.endpointUrl); a confirm names the endpoint it confirms",
      });
    }
    // The endpoint signed is the one the propose named, in its own spelling,
    // and it must be this relay's.
    let endpoint = own;
    if (body.endpoint_url !== undefined) {
      if (typeof body.endpoint_url !== "string" || endpointKey(body.endpoint_url) !== ownKey) {
        throw new HTTPException(400, {
          message: `endpoint_url is not this relay's federation endpoint (${own}): a confirm names only this relay's own endpoint — propose with it`,
        });
      }
      endpoint = body.endpoint_url;
    }
    const message = await signFederationMessage({
      kind: "peer-confirm",
      sender: relayIdentity.relayMotebitId,
      recipient: body.recipient,
      recipientPublicKey: body.recipient_public_key,
      body: peerConfirmBody(body.nonce, endpoint),
      privateKey: relayIdentity.privateKey,
    });
    return c.json({
      relay_id: relayIdentity.relayMotebitId,
      public_key: relayIdentity.publicKeyHex.toLowerCase(),
      nonce: body.nonce,
      endpoint_url: endpoint,
      recipient_public_key: body.recipient_public_key.toLowerCase(),
      message,
    });
  });

  /** @spec motebit/relay-federation@1.5 */
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

  /** @spec motebit/relay-federation@1.5 */
  app.post("/federation/v1/discover", async (c) => {
    const body = await c.req.json<{
      query: { capability?: string; motebit_id?: string; limit?: number };
      hop_count: number;
      max_hops: number;
      visited: string[];
      query_id: string;
      origin_relay: string;
      // Per-hop sender authentication (relay-federation@1.5 §3.5, §4.1.1):
      // the immediate forwarder and its v2 `discover` message for THIS relay.
      // Absent only on an unsigned request, accepted only under the
      // operator's `requireDiscoverSignature: false` opt-out.
      sender_relay?: string;
      message?: unknown;
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
    // multi-hop origin_relay — discovery is multi-hop (A→B→D), and only the
    // direct neighbor's key is held here. A request with a v2 `discover`
    // message (or a legacy `signature`, refused by name as v1) is verified as
    // a work request for THIS relay's key; an unsigned one is accepted only
    // under the operator's `requireDiscoverSignature: false` opt-out, and then
    // rate-limited on the self-asserted origin (logged so the gap is
    // observable).
    let verifiedSender: string | null = null;
    if (body.message !== undefined || body.signature !== undefined) {
      verifiedSender = (
        await verifyFederationRequest(db, relayIdentity, "discover", body, ["active"])
      ).sender;
    } else if (requireDiscoverSignature) {
      throw new HTTPException(403, { message: "Unsigned discovery request rejected" });
    }
    if (verifiedSender == null) {
      logger.warn("federation.discover.unsigned", {
        origin_relay: body.origin_relay,
        query_id: body.query_id,
      });
    }
    checkPeerLimit(verifiedSender ?? body.origin_relay);

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
          const forwardBody = await signDiscoverBody(db, relayIdentity, peer.peer_relay_id, {
            query: body.query,
            hop_count: body.hop_count + 1,
            max_hops: body.max_hops,
            visited,
            query_id: body.query_id,
            origin_relay: body.origin_relay,
          });
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

  /** @spec motebit/relay-federation@1.5 */
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
      message?: unknown;
    }>();

    if (!body.task_id || !body.origin_relay || !body.target_agent || !body.task_payload?.prompt) {
      throw new HTTPException(400, { message: "Missing required fields" });
    }

    checkFederationEnabled();

    // Federation owns: the v2 `task-forward` message — for THIS relay's key,
    // from `origin_relay`, an active peer — then the per-peer rate limit,
    // counted only once the signature verified.
    const { sender } = await verifyFederationRequest(db, relayIdentity, "task-forward", body, [
      "active",
    ]);
    checkPeerLimit(sender);

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

  /** @spec motebit/relay-federation@1.5 */
  app.post("/federation/v1/task/result", async (c) => {
    const body = await c.req.json<{
      task_id: string;
      origin_relay: string;
      receipt: ExecutionReceipt;
      agent_public_key?: string;
      message?: unknown;
    }>();

    if (!body.task_id || !body.origin_relay || body.receipt == null) {
      throw new HTTPException(400, { message: "Missing required fields" });
    }

    // Federation owns: the v2 `task-result` message — for THIS relay's key,
    // from `origin_relay` (the executor), an active or suspended peer.
    const { sender } = await verifyFederationRequest(db, relayIdentity, "task-result", body, [
      "active",
      "suspended",
    ]);
    checkPeerLimit(sender);

    // Validate nested ExecutionReceipt against the wire schema before any
    // downstream processing. Fail-closed on malformed bodies.
    const parsedReceipt = ExecutionReceiptSchema.safeParse(body.receipt);
    if (!parsedReceipt.success) {
      return c.json({ error: parsedReceipt.error.flatten() }, 400);
    }

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

  /** @spec motebit/relay-federation@1.5 */
  app.post("/federation/v1/settlement/forward", async (c) => {
    const body = await c.req.json<{
      task_id: string;
      settlement_id: string;
      origin_relay: string;
      gross_amount: number;
      receipt_hash: string;
      message?: unknown;
      x402_tx_hash?: string;
      x402_network?: string;
    }>();

    if (!body.task_id || !body.settlement_id || !body.origin_relay || body.gross_amount == null) {
      throw new HTTPException(400, { message: "Missing required fields" });
    }

    // Federation owns: the v2 `settlement-forward` message — for THIS relay's
    // key, from `origin_relay`, an active or suspended peer — before any
    // settlement row is read or written.
    const { sender } = await verifyFederationRequest(
      db,
      relayIdentity,
      "settlement-forward",
      body,
      ["active", "suspended"],
    );
    checkPeerLimit(sender);

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

  /** @spec motebit/relay-federation@1.5 */
  app.get("/federation/v1/settlements", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
    const rows = db
      .prepare("SELECT * FROM relay_federation_settlements ORDER BY settled_at DESC LIMIT ?")
      .all(limit);
    return c.json({ settlements: rows });
  });

  // ── Phase 5: Settlement Proof (§7.6.6) ──

  /** @spec motebit/relay-federation@1.5 */
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
