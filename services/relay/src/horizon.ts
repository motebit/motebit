/**
 * Relay-side horizon advance — phase 4b-3 federation co-witness
 * solicitation + per-store ledger truncation.
 *
 * Composes existing protocol primitives from `@motebit/crypto` and
 * `@motebit/encryption` into the relay's `advanceRelayHorizon`
 * orchestrator + five per-ledger truncate adapters. No new protocol
 * shapes — this file is service-level composition (relay rule 1: never
 * inline protocol plumbing; consume the package layer).
 *
 * The five operational ledgers under relay retention coverage:
 *
 *   - `relay_execution_ledgers`   — created_at      (single timestamp)
 *   - `relay_settlements`         — settled_at      (NULL for pending — guarded)
 *   - `relay_credential_anchor_batches` — anchored_at (NULL for unanchored — guarded)
 *   - `relay_revocation_events`   — timestamp       (replaces cleanupRevocationEvents)
 *   - `relay_disputes`            — COALESCE(final_at, expired_at)
 *                                   (lifecycle-terminal columns; pre-terminal disputes
 *                                    are NEVER truncated mid-flight)
 *
 * Path A quorum (retention-policy.md decision 9 + 4b-3 sub-notes):
 *   - Verifier hard floor: `witnessed_by.length ≥ 1` when
 *     `federation_graph_anchor.leaf_count ≥ 1`. Self-witnessed when no peers.
 *   - Soft accountability: `WitnessOmissionDispute` filed within 24h
 *     of `cert.issued_at`; existing `DisputeResolution` adjudicates.
 *
 * Two operational sharpenings folded in (session-3 design check):
 *
 *   1. **In-process advisory lock.** `advanceLocks: Map<storeId, Promise<...>>`
 *      collapses parallel calls for the same store to a single in-flight
 *      attempt. Cross-process is a deployment-misconfig concern (single
 *      relay process per DB is the supported topology).
 *
 *   2. **Re-snapshot on retry.** Each retry is a fully fresh attempt:
 *      fresh peer snapshot, fresh `federation_graph_anchor`, fresh
 *      `issued_at`, fresh signature, fresh fan-out. Late responses from
 *      attempt N would fail signature verification against attempt N+1's
 *      cert body anyway. Retry only fires when attempt N got zero
 *      responses (≥1 = success per Path A).
 */

import type { DatabaseDriver } from "@motebit/persistence";
import type {
  DeletionCertificate,
  FederationGraphAnchor,
  HorizonSubject,
  HorizonWitness,
  HorizonWitnessRequestBody,
  WitnessSolicitationRequest,
  WitnessSolicitationResponse,
} from "@motebit/protocol";
import { EMPTY_FEDERATION_GRAPH_ANCHOR } from "@motebit/protocol";
import {
  canonicalizeHorizonWitnessRequestBody,
  fromBase64Url,
  hexToBytes,
  signHorizonCertAsIssuer,
  signHorizonWitnessRequestBody,
  verifyBySuite,
  verifyHorizonWitnessRequestSignature,
} from "@motebit/crypto";
import { buildMerkleTree } from "@motebit/encryption";
import { WitnessSolicitationResponseSchema } from "@motebit/wire-schemas";

import type { RelayIdentity } from "./federation.js";
import { REVOCATION_TTL_MS } from "./federation.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "horizon" });

// ── Constants ────────────────────────────────────────────────────────

const HORIZON_CERT_SUITE = "motebit-jcs-ed25519-b64-v1" as const;

/**
 * Default per-request witness solicitation timeout. Configurable via
 * `FederationConfig.witnessSolicitationTimeoutMs`. Per-request timeout
 * IS the overall solicitation deadline since the orchestrator uses
 * `Promise.allSettled` over a parallel fan-out (handoff: session-1
 * locked decision).
 */
export const DEFAULT_WITNESS_SOLICITATION_TIMEOUT_MS = 10_000;

/**
 * Retry policy on quorum failure (Path A: zero peers responded with a
 * valid witness signature). Three attempts, exponential backoff.
 */
const MAX_HORIZON_ADVANCE_ATTEMPTS = 3;
const HORIZON_RETRY_BACKOFF_MS = [1_000, 3_000, 9_000] as const;

/**
 * 5-min freshness floor on `last_heartbeat_at` for the peer snapshot.
 * Mirrors `HEARTBEAT_REMOVE_THRESHOLD = 5` × `60s` heartbeat suspension
 * threshold in `federation.ts` — peers more than 5 min stale are
 * structurally unreachable and shouldn't be solicited.
 */
const PEER_FRESHNESS_FLOOR_MS = 5 * 60 * 1_000;

// ── Types ────────────────────────────────────────────────────────────

export interface HorizonAdvanceContext {
  readonly relayIdentity: RelayIdentity;
  /**
   * Per-request timeout for the witness solicitation HTTP fan-out.
   * Defaults to `DEFAULT_WITNESS_SOLICITATION_TIMEOUT_MS`.
   */
  readonly witnessSolicitationTimeoutMs?: number;
  /**
   * Optional fetch override for tests (in-memory peer simulation).
   * Defaults to global `fetch`.
   */
  readonly fetchImpl?: typeof fetch;
  /**
   * Test-only backoff schedule between retry attempts. Production uses
   * `HORIZON_RETRY_BACKOFF_MS` (1s/3s/9s) — exposed here so retry-path
   * tests don't have to choreograph fake-timers across an awaited
   * cert-signing pipeline. Underscore prefix marks internal-only.
   */
  readonly _retryBackoffMsForTests?: readonly number[];
}

export interface HorizonAdvanceResult {
  readonly cert: Extract<DeletionCertificate, { kind: "append_only_horizon" }>;
  readonly truncatedCount: number;
  readonly attemptsUsed: number;
  readonly witnessCount: number;
  readonly selfWitnessed: boolean;
}

export type TruncateAdapter = (db: DatabaseDriver, horizonTs: number) => number;

// ── Per-store truncate adapters ──────────────────────────────────────
//
// Each adapter is a single DELETE keyed off the ledger's natural
// retention timestamp column. NULL guards on lifecycle-incomplete rows
// (settlements, anchor batches, disputes) — truncating mid-flight
// records would lose audit data still under federation/chain pending.
//
// Five adapters; the registry below dispatches by `storeId`. Adding a
// new ledger means adding an entry here AND a CREATE TABLE upstream
// (relay-side store registration is the relay's manifest projection,
// landed in commit 5 with drift gate #68).

export function truncateExecutionLedgersBeforeHorizon(
  db: DatabaseDriver,
  horizonTs: number,
): number {
  const result = db
    .prepare("DELETE FROM relay_execution_ledgers WHERE created_at < ?")
    .run(horizonTs);
  return (result as { changes: number }).changes;
}

export function truncateSettlementsBeforeHorizon(db: DatabaseDriver, horizonTs: number): number {
  // NULL guard: pending settlements (settled_at IS NULL) are never
  // truncated — the cert horizon describes settled-and-final history,
  // not work-in-progress.
  const result = db
    .prepare("DELETE FROM relay_settlements WHERE settled_at IS NOT NULL AND settled_at < ?")
    .run(horizonTs);
  return (result as { changes: number }).changes;
}

export function truncateCredentialAnchorBatchesBeforeHorizon(
  db: DatabaseDriver,
  horizonTs: number,
): number {
  // NULL guard: unanchored batches (anchored_at IS NULL) are still
  // pending chain confirmation; truncating them would lose evidence
  // mid-flight.
  const result = db
    .prepare(
      "DELETE FROM relay_credential_anchor_batches WHERE anchored_at IS NOT NULL AND anchored_at < ?",
    )
    .run(horizonTs);
  return (result as { changes: number }).changes;
}

export function truncateRevocationEventsBeforeHorizon(
  db: DatabaseDriver,
  horizonTs: number,
): number {
  const result = db
    .prepare("DELETE FROM relay_revocation_events WHERE timestamp < ?")
    .run(horizonTs);
  return (result as { changes: number }).changes;
}

export function truncateDisputesBeforeHorizon(db: DatabaseDriver, horizonTs: number): number {
  // Lifecycle-terminal column: a dispute is truncatable only after it
  // reaches a terminal state (final_at OR expired_at non-null).
  // Open / evidence / arbitration / resolved / appealed states are
  // mid-flight and never get truncated by a horizon advance.
  const result = db
    .prepare(
      `DELETE FROM relay_disputes
       WHERE COALESCE(final_at, expired_at) IS NOT NULL
         AND COALESCE(final_at, expired_at) < ?`,
    )
    .run(horizonTs);
  return (result as { changes: number }).changes;
}

/**
 * Stable storeId → truncate-adapter dispatch table. The store ids
 * match `RETENTION_MANIFEST_CONTENT.stores[].store_id` once commit 5
 * lands — same string keys, single source of truth.
 */
export const STORE_TRUNCATE_REGISTRY: Readonly<Record<string, TruncateAdapter>> = Object.freeze({
  relay_execution_ledgers: truncateExecutionLedgersBeforeHorizon,
  relay_settlements: truncateSettlementsBeforeHorizon,
  relay_credential_anchor_batches: truncateCredentialAnchorBatchesBeforeHorizon,
  relay_revocation_events: truncateRevocationEventsBeforeHorizon,
  relay_disputes: truncateDisputesBeforeHorizon,
});

// ── Peer snapshot ────────────────────────────────────────────────────

interface PeerRow {
  peer_relay_id: string;
  public_key: string;
  endpoint_url: string;
}

/**
 * Snapshot the relay's federation peer set as it stood at `horizonTs`.
 * Filter mirrors the heartbeat suspension threshold (handoff procedural
 * edge #2): peered before the horizon, currently active or suspended,
 * and last heartbeat within 5 min of the horizon (or never set, meaning
 * recently peered without a heartbeat round yet).
 */
function snapshotPeers(db: DatabaseDriver, horizonTs: number): PeerRow[] {
  const freshnessFloor = horizonTs - PEER_FRESHNESS_FLOOR_MS;
  return db
    .prepare(
      `SELECT peer_relay_id, public_key, endpoint_url
         FROM relay_peers
        WHERE peered_at <= ?
          AND state IN ('active', 'suspended')
          AND (last_heartbeat_at IS NULL OR last_heartbeat_at >= ?)`,
    )
    .all(horizonTs, freshnessFloor) as PeerRow[];
}

// ── Federation graph anchor ──────────────────────────────────────────

/**
 * Build the cert's `federation_graph_anchor` from the snapshotted
 * peer set. Empty peer set yields the canonical
 * `EMPTY_FEDERATION_GRAPH_ANCHOR` self-witnessed encoding (the
 * verifier in `@motebit/crypto` admits empty `witnessed_by[]` only
 * when paired with this anchor — empty-anchor sanity check from
 * commit 2).
 *
 * Leaf canonicalization (mirrors `relay-federation-v1.md` §7.6 +
 * `credential-anchor-v1.md` §3): hex-encoded peer pubkey bytes,
 * lowercase, sorted ascending.
 */
async function computeFederationGraphAnchor(
  peerPubkeysHex: string[],
): Promise<FederationGraphAnchor> {
  if (peerPubkeysHex.length === 0) {
    return EMPTY_FEDERATION_GRAPH_ANCHOR;
  }
  const sortedLeaves = [...peerPubkeysHex].map((k) => k.toLowerCase()).sort();
  const tree = await buildMerkleTree(sortedLeaves);
  return {
    algo: "merkle-sha256-v1",
    merkle_root: tree.root,
    leaf_count: sortedLeaves.length,
  };
}

// ── Solicitation fan-out ─────────────────────────────────────────────

interface SolicitationOutcome {
  readonly peerId: string;
  readonly witness: HorizonWitness | null;
  readonly error?: string;
}

/**
 * Solicit a single peer for a witness signature. Returns the parsed
 * `HorizonWitness` on success, or `null` with an error string on any
 * failure path (timeout, non-2xx, malformed body, schema rejection,
 * signature mismatch). Never throws — failures are aggregated for the
 * orchestrator's hard-floor decision.
 */
async function solicitFromPeer(
  peer: PeerRow,
  request: WitnessSolicitationRequest,
  canonicalRequestBytes: Uint8Array,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<SolicitationOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(`${peer.endpoint_url}/federation/v1/horizon/witness`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    if (!resp.ok) {
      return { peerId: peer.peer_relay_id, witness: null, error: `http ${resp.status}` };
    }
    const body = (await resp.json()) as unknown;
    const parsed = WitnessSolicitationResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { peerId: peer.peer_relay_id, witness: null, error: "schema_rejected" };
    }
    const response: WitnessSolicitationResponse = parsed.data;
    if (response.motebit_id !== peer.peer_relay_id) {
      return {
        peerId: peer.peer_relay_id,
        witness: null,
        error: "motebit_id_mismatch",
      };
    }
    let sigBytes: Uint8Array;
    try {
      sigBytes = fromBase64Url(response.signature);
    } catch {
      return { peerId: peer.peer_relay_id, witness: null, error: "signature_decode_failed" };
    }
    const peerPubKey = hexToBytes(peer.public_key);
    const valid = await verifyBySuite(
      HORIZON_CERT_SUITE,
      canonicalRequestBytes,
      sigBytes,
      peerPubKey,
    );
    if (!valid) {
      return { peerId: peer.peer_relay_id, witness: null, error: "signature_invalid" };
    }
    const witness: HorizonWitness = {
      motebit_id: response.motebit_id as never,
      signature: response.signature,
      ...(response.inclusion_proof !== undefined
        ? { inclusion_proof: response.inclusion_proof }
        : {}),
    };
    return { peerId: peer.peer_relay_id, witness };
  } catch (err) {
    return {
      peerId: peer.peer_relay_id,
      witness: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Cert persistence ─────────────────────────────────────────────────

/**
 * Persist a signed horizon cert to `relay_horizon_certs`. The cert's
 * own `signature` field is the natural primary key — globally unique,
 * cheap dispute-by-signature lookup. The full cert JSON is preserved
 * byte-identical so the audit reverification path can reconstruct
 * canonical bytes (same discipline as `relay_receipts.receipt_json`,
 * relay rule 11).
 */
function persistHorizonCert(
  db: DatabaseDriver,
  cert: Extract<DeletionCertificate, { kind: "append_only_horizon" }>,
): void {
  db.prepare(
    `INSERT INTO relay_horizon_certs
       (cert_signature, store_id, horizon_ts, issued_at, witness_count, cert_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    cert.signature,
    cert.store_id,
    cert.horizon_ts,
    cert.issued_at,
    cert.witnessed_by.length,
    JSON.stringify(cert),
  );
}

// ── Concurrency guard ────────────────────────────────────────────────

/**
 * In-process advisory lock — collapses parallel `advanceRelayHorizon`
 * calls for the same `storeId` to a single in-flight attempt. Second
 * caller awaits the first's resolved promise rather than racing the
 * truncation. Single relay process per DB is the supported topology
 * (rule 13: native better-sqlite3, no split-brain across processes).
 */
const advanceLocks = new Map<string, Promise<HorizonAdvanceResult>>();

/**
 * Test-only: reset the in-process advisory lock map. Production
 * callers should never invoke this — the map is auto-cleaned via
 * `try/finally` in `advanceRelayHorizon`. Tests that abort an
 * in-flight attempt (e.g. timeout assertions) need to clear stale
 * entries between cases to avoid lock-leak across `it` blocks.
 */
export function _resetHorizonAdvanceLocksForTests(): void {
  advanceLocks.clear();
}

// ── Single attempt (one snapshot, one cert, one fan-out) ─────────────

async function singleHorizonAttempt(
  db: DatabaseDriver,
  storeId: string,
  horizonTs: number,
  ctx: HorizonAdvanceContext,
): Promise<{
  cert: Extract<DeletionCertificate, { kind: "append_only_horizon" }> | null;
  failureReason?: string;
}> {
  const peers = snapshotPeers(db, horizonTs);
  const anchor = await computeFederationGraphAnchor(peers.map((p) => p.public_key));

  const subject: HorizonSubject = {
    kind: "operator",
    operator_id: ctx.relayIdentity.relayMotebitId,
  };

  // Fresh `issued_at` per attempt — re-snapshot semantics. The cert's
  // claim "anchored peer set at horizon, signed at issued_at" stays
  // structurally honest because both reflect THIS attempt's state.
  const issuedAt = Date.now();
  const requestBody: HorizonWitnessRequestBody = {
    kind: "append_only_horizon",
    subject,
    store_id: storeId,
    horizon_ts: horizonTs,
    issued_at: issuedAt,
    federation_graph_anchor: anchor,
    suite: HORIZON_CERT_SUITE,
  };

  // Self-witnessed shortcut: no peers → no fan-out, no retry pressure,
  // sign cert directly with empty witnessed_by[].
  if (peers.length === 0) {
    const cert = await signHorizonCertAsIssuer(
      {
        kind: "append_only_horizon",
        subject,
        store_id: storeId,
        horizon_ts: horizonTs,
        witnessed_by: [],
        federation_graph_anchor: anchor,
        issued_at: issuedAt,
      },
      ctx.relayIdentity.privateKey,
    );
    return { cert };
  }

  // With-peers path: sign solicitation body, fan out, collect.
  const issuerSignature = await signHorizonWitnessRequestBody(
    requestBody,
    ctx.relayIdentity.privateKey,
  );
  const request: WitnessSolicitationRequest = {
    cert_body: requestBody,
    issuer_id: ctx.relayIdentity.relayMotebitId,
    issuer_signature: issuerSignature,
  };

  // Recompute canonical bytes ONCE for response verification (session-3
  // sub-decision: issuer-signature payload IS witness-signature payload).
  // Same primitive `signHorizonWitnessRequestBody` uses internally —
  // drift-impossible since both routes go through this function.
  const canonicalRequestBytes = canonicalizeHorizonWitnessRequestBody(requestBody);

  const fetchImpl = ctx.fetchImpl ?? fetch;
  const timeoutMs = ctx.witnessSolicitationTimeoutMs ?? DEFAULT_WITNESS_SOLICITATION_TIMEOUT_MS;

  const outcomes = await Promise.allSettled(
    peers.map((peer) =>
      solicitFromPeer(peer, request, canonicalRequestBytes, timeoutMs, fetchImpl),
    ),
  );

  const witnesses: HorizonWitness[] = [];
  for (const o of outcomes) {
    if (o.status === "fulfilled" && o.value.witness !== null) {
      witnesses.push(o.value.witness);
    } else if (o.status === "fulfilled" && o.value.error) {
      logger.warn("horizon.witness.solicit_failed", {
        peerId: o.value.peerId,
        error: o.value.error,
      });
    }
  }

  // Path A hard floor: ≥1 valid witness when peer count ≥ 1.
  if (witnesses.length === 0) {
    return { cert: null, failureReason: "no_valid_witnesses" };
  }

  const cert = await signHorizonCertAsIssuer(
    {
      kind: "append_only_horizon",
      subject,
      store_id: storeId,
      horizon_ts: horizonTs,
      witnessed_by: witnesses,
      federation_graph_anchor: anchor,
      issued_at: issuedAt,
    },
    ctx.relayIdentity.privateKey,
  );
  return { cert };
}

// ── Public orchestrator ──────────────────────────────────────────────

/**
 * Advance the horizon for a relay-side store: build the cert (with
 * federation co-witness fan-out if peers exist), persist, truncate
 * the ledger prefix.
 *
 * Concurrency: parallel calls for the same `storeId` collapse to one
 * in-flight attempt via the in-process advisory lock — second caller
 * awaits the first's resolved result.
 *
 * Retry: on quorum failure (zero valid witnesses despite ≥1 peer),
 * re-snapshot + retry up to 3 attempts with exponential backoff
 * (1s/3s/9s). Each retry is a fresh attempt — fresh peer snapshot,
 * fresh anchor, fresh `issued_at`, fresh signatures.
 */
export async function advanceRelayHorizon(
  db: DatabaseDriver,
  storeId: string,
  horizonTs: number,
  ctx: HorizonAdvanceContext,
): Promise<HorizonAdvanceResult> {
  const inFlight = advanceLocks.get(storeId);
  if (inFlight !== undefined) {
    return inFlight;
  }

  const work = (async (): Promise<HorizonAdvanceResult> => {
    let lastFailure: string | undefined;
    for (let attempt = 1; attempt <= MAX_HORIZON_ADVANCE_ATTEMPTS; attempt++) {
      const result = await singleHorizonAttempt(db, storeId, horizonTs, ctx);
      if (result.cert !== null) {
        const cert = result.cert;
        const adapter = STORE_TRUNCATE_REGISTRY[storeId];
        if (adapter === undefined) {
          throw new Error(
            `advanceRelayHorizon: no truncate adapter registered for store_id "${storeId}"`,
          );
        }
        // Sign-then-persist-then-truncate (same load-bearing order as
        // EventStore.advanceHorizon in @motebit/event-log phase 4b-2):
        // truncation BEFORE the cert exists would leave a window where
        // entries are gone but no signed attestation references them.
        persistHorizonCert(db, cert);
        const truncatedCount = adapter(db, horizonTs);
        logger.info("horizon.advance.committed", {
          storeId,
          horizonTs,
          attemptsUsed: attempt,
          witnessCount: cert.witnessed_by.length,
          truncatedCount,
        });
        return {
          cert,
          truncatedCount,
          attemptsUsed: attempt,
          witnessCount: cert.witnessed_by.length,
          selfWitnessed: cert.witnessed_by.length === 0,
        };
      }
      lastFailure = result.failureReason;
      logger.warn("horizon.advance.attempt_failed", {
        storeId,
        attempt,
        reason: lastFailure,
      });
      if (attempt < MAX_HORIZON_ADVANCE_ATTEMPTS) {
        const schedule = ctx._retryBackoffMsForTests ?? HORIZON_RETRY_BACKOFF_MS;
        const backoff = schedule[attempt - 1] ?? schedule[schedule.length - 1] ?? 9_000;
        await new Promise((res) => setTimeout(res, backoff));
      }
    }
    throw new Error(
      `advanceRelayHorizon: ${MAX_HORIZON_ADVANCE_ATTEMPTS} attempts failed (last: ${lastFailure ?? "unknown"})`,
    );
  })();

  advanceLocks.set(storeId, work);
  try {
    return await work;
  } finally {
    advanceLocks.delete(storeId);
  }
}

// ── Witness-omission dispute persistence (peer-side handler use) ─────

/**
 * Persist a verified `WitnessOmissionDispute` to
 * `relay_witness_omission_disputes`. Called by the
 * `POST /federation/v1/horizon/dispute` handler after
 * `verifyWitnessOmissionDispute` returns valid. Rejected disputes
 * persist with `state='rejected'` + `rejection_reason` for audit.
 */
export function persistWitnessOmissionDispute(
  db: DatabaseDriver,
  dispute: {
    dispute_id: string;
    cert_issuer: string;
    cert_signature: string;
    disputant_motebit_id: string;
    filed_at: number;
  },
  fullDisputeJson: string,
  state: "verified" | "rejected",
  rejectionReason?: string,
): void {
  db.prepare(
    `INSERT INTO relay_witness_omission_disputes
       (dispute_id, cert_issuer, cert_signature, disputant_motebit_id, filed_at,
        dispute_json, state, verified_at, rejection_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dispute_id) DO NOTHING`,
  ).run(
    dispute.dispute_id,
    dispute.cert_issuer,
    dispute.cert_signature,
    dispute.disputant_motebit_id,
    dispute.filed_at,
    fullDisputeJson,
    state,
    state === "verified" ? Date.now() : null,
    rejectionReason ?? null,
  );
}

/**
 * Resolve a horizon cert from `relay_horizon_certs` by its signature.
 * Used by the dispute handler to look up the cert a dispute references
 * before handing to `verifyWitnessOmissionDispute`. Returns `null` if
 * the cert isn't in this relay's local store (the dispute references a
 * cert this relay didn't issue).
 */
export function resolveHorizonCertBySignature(
  db: DatabaseDriver,
  certSignature: string,
): Extract<DeletionCertificate, { kind: "append_only_horizon" }> | null {
  const row = db
    .prepare("SELECT cert_json FROM relay_horizon_certs WHERE cert_signature = ?")
    .get(certSignature) as { cert_json: string } | undefined;
  if (row === undefined) return null;
  try {
    return JSON.parse(row.cert_json) as Extract<
      DeletionCertificate,
      { kind: "append_only_horizon" }
    >;
  } catch {
    return null;
  }
}

// ── Revocation-events horizon (replaces cleanupRevocationEvents) ─────
//
// Phase 4b-3 replaces the old informal sync purge of
// `relay_revocation_events` (TTL = 7d, no signed cert) with a signed
// horizon advance under Path A quorum. The 7d TTL stays as
// `REVOCATION_TTL_MS` (federation.ts, single source of truth) and
// surfaces as the declared `horizon_advance_period_days: 7` in commit
// 5's manifest projection. The horizon timestamp passed to
// `advanceRelayHorizon` is the cutoff: anything older than 7d is
// truncated under a co-witnessed (or self-witnessed if no peers)
// signed `append_only_horizon` cert.

/**
 * Default revocation horizon advance interval. Hourly cadence — much
 * faster than the 7d TTL, so any one missed cycle is bounded by the
 * next interval tick (≤ 1h backlog vs the 7d retention floor). Override
 * via `FederationConfig.revocationHorizonIntervalMs`. Operational
 * tuning knob, not a doctrinal commitment.
 */
export const DEFAULT_REVOCATION_HORIZON_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Sign + persist + truncate the revocation-events horizon. Self-
 * witnessed when this relay has no federation peers; co-witnessed via
 * fan-out solicitation when peers exist.
 *
 * The horizon timestamp is `now - REVOCATION_TTL_MS` — everything
 * older than 7 days. Returns the full `HorizonAdvanceResult` so
 * callers (loop / one-shot / tests) can inspect cert + truncate count
 * + retry attempts used.
 */
export async function advanceRevocationHorizon(
  db: DatabaseDriver,
  ctx: HorizonAdvanceContext,
): Promise<HorizonAdvanceResult> {
  const horizonTs = Date.now() - REVOCATION_TTL_MS;
  return advanceRelayHorizon(db, "relay_revocation_events", horizonTs, ctx);
}

/**
 * Start the periodic revocation-horizon-advance loop. Mirrors
 * `startHeartbeatLoop` shape — interval handle returned for cleanup,
 * optional `isFrozen` guard for test/maintenance pauses, fire-and-
 * forget per-tick (errors logged via `logger.error`, never thrown out
 * of the loop body so one bad tick doesn't kill the interval).
 */
export function startRevocationHorizonLoop(
  db: DatabaseDriver,
  ctx: HorizonAdvanceContext,
  intervalMs = DEFAULT_REVOCATION_HORIZON_INTERVAL_MS,
  isFrozen?: () => boolean,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (isFrozen?.()) return;
    void advanceRevocationHorizon(db, ctx).catch((err: unknown) => {
      logger.error("horizon.revocation.loop_tick_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);
}

// Re-exports for federation.ts peer-side handler convenience.
export { fromBase64Url, hexToBytes, verifyHorizonWitnessRequestSignature };
