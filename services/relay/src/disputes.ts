/**
 * Dispute module — dispute resolution for agent delegations.
 *
 * Implements motebit/dispute@1.0:
 *   POST /api/v1/allocations/:allocationId/dispute — open dispute, lock funds (§4)
 *   POST /api/v1/disputes/:disputeId/evidence      — submit evidence (§5)
 *   POST /api/v1/disputes/:disputeId/resolve        — operator resolution (§6)
 *   POST /api/v1/disputes/:disputeId/appeal         — file appeal (§8)
 *   GET  /api/v1/disputes/:disputeId                — query status
 *   GET  /api/v1/admin/disputes                     — admin panel view
 */
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  canonicalJson,
  hexToBytes,
  sign,
  signDisputeResolution,
  toBase64Url,
  verifyDisputeAppeal,
  verifyDisputeEvidence,
  verifyDisputeRequest,
} from "@motebit/encryption";
import { verifyAdjudicatorVote } from "@motebit/crypto";
import type {
  AdjudicatorVote,
  DisputeEvidence,
  DisputeRequest,
  DisputeState,
  DisputeOutcome,
  DisputeFundAction,
  VoteRequest,
} from "@motebit/protocol";
import {
  AdjudicatorVoteSchema,
  DisputeAppealSchema,
  DisputeEvidenceSchema,
  DisputeRequestSchema,
} from "@motebit/wire-schemas";
import type { DatabaseDriver } from "@motebit/persistence";
import type { RelayIdentity } from "./federation.js";
import { creditAccount as creditAccountCanonical } from "./accounts.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ service: "relay", module: "disputes" });

// === Constants (§4.5, §5.5, §6.6, §8.5, §9.4 Convention) ===

/** Evidence window: 48 hours from dispute opening. */
const EVIDENCE_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Appeal window: 24 hours after resolution. */
const APPEAL_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Maximum evidence submissions per party per dispute. */
const MAX_EVIDENCE_PER_PARTY = 10;
/** Maximum active disputes per agent (§9.2). */
const MAX_ACTIVE_DISPUTES_PER_AGENT = 3;
/** Opened disputes expire after 1 hour without evidence (§3.2). */
const OPENED_EXPIRE_MS = 60 * 60 * 1000;
/** Filing fee: 1% of disputed allocation amount (§9.4). */
const FILING_FEE_RATE = 0.01;
/**
 * Per-request timeout for outbound vote-request fan-out
 * (`spec/relay-federation-v1.md` §16.3). Per-request timeout IS the
 * fan-out deadline since the orchestrator uses `Promise.allSettled` over
 * a parallel fan-out — no aggregation across attempts.
 */
const FEDERATION_VOTE_REQUEST_TIMEOUT_MS = 10_000;
/**
 * Federation adjudication minimum quorum from `spec/dispute-v1.md` §6.2:
 * "minimum 3-peer quorum from the federation graph." Combined with §6.5
 * (no self-adjudication when defendant), this means ≥3 OTHER active
 * peers; orchestrator returns 503 `insufficient_federation_peers` below
 * this floor. See §6.6 for the operator-note derivation.
 */
const FEDERATION_QUORUM_MIN = 3;

// === Database ===

export function createDisputeTables(db: DatabaseDriver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_disputes (
      dispute_id        TEXT PRIMARY KEY,
      task_id           TEXT NOT NULL,
      allocation_id     TEXT NOT NULL,
      filed_by          TEXT NOT NULL,
      respondent        TEXT NOT NULL,
      category          TEXT NOT NULL,
      description       TEXT NOT NULL,
      state             TEXT NOT NULL DEFAULT 'opened',
      amount_locked     INTEGER NOT NULL DEFAULT 0,
      filing_fee        INTEGER NOT NULL DEFAULT 0,
      filed_at          INTEGER NOT NULL,
      evidence_deadline INTEGER NOT NULL,
      body_json         TEXT NOT NULL DEFAULT '',
      resolution        TEXT,
      rationale         TEXT,
      fund_action       TEXT,
      split_ratio       REAL,
      adjudicator       TEXT,
      resolved_at       INTEGER,
      appealed_at       INTEGER,
      final_at          INTEGER,
      expired_at        INTEGER,
      created_at        INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_disputes_state
      ON relay_disputes(state) WHERE state NOT IN ('final', 'expired');
    CREATE INDEX IF NOT EXISTS idx_disputes_filed_by
      ON relay_disputes(filed_by);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_dispute_evidence (
      evidence_id       TEXT PRIMARY KEY,
      dispute_id        TEXT NOT NULL,
      submitted_by      TEXT NOT NULL,
      evidence_type     TEXT NOT NULL,
      evidence_data     TEXT NOT NULL,
      description       TEXT NOT NULL,
      submitted_at      INTEGER NOT NULL,
      FOREIGN KEY (dispute_id) REFERENCES relay_disputes(dispute_id)
    );
    CREATE INDEX IF NOT EXISTS idx_dispute_evidence_dispute
      ON relay_dispute_evidence(dispute_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_dispute_resolutions (
      resolution_id     TEXT PRIMARY KEY,
      dispute_id        TEXT NOT NULL UNIQUE,
      resolution        TEXT NOT NULL,
      rationale         TEXT NOT NULL,
      fund_action       TEXT NOT NULL,
      split_ratio       REAL NOT NULL,
      adjudicator       TEXT NOT NULL,
      adjudicator_votes TEXT,
      resolved_at       INTEGER NOT NULL,
      signature         TEXT NOT NULL,
      is_appeal         INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (dispute_id) REFERENCES relay_disputes(dispute_id)
    );
  `);
}

// === Helpers ===

function getDispute(db: DatabaseDriver, disputeId: string) {
  return db.prepare("SELECT * FROM relay_disputes WHERE dispute_id = ?").get(disputeId) as
    | Record<string, unknown>
    | undefined;
}

// === Dispute Deps ===

export interface DisputeDeps {
  db: DatabaseDriver;
  app: Hono;
  relayIdentity: RelayIdentity;
  /**
   * Optional fetch implementation override for the §6.2 federation
   * orchestrator's outbound vote-request fan-out. Defaults to
   * `globalThis.fetch`. Tests inject a mock that routes to in-process
   * Hono apps; production uses the global.
   */
  fetchImpl?: typeof fetch;
  /**
   * Optional override for the per-request timeout
   * (`FEDERATION_VOTE_REQUEST_TIMEOUT_MS`). Tests use small values to
   * exercise timeout paths without real-time waits.
   */
  voteRequestTimeoutMs?: number;
}

// === §6.2 Concurrency + recovery state ===
//
// Per-dispute advisory lock. JS is single-threaded, but the orchestrator
// awaits async I/O (peer fan-out), so two concurrent /resolve calls on
// the same dispute would interleave between awaits. The lock collapses
// concurrent calls to the same in-flight promise — second caller awaits
// the first caller's result.
//
// Cross-process concurrency (e.g., multi-relay-process deployment) is
// covered by the `relay_dispute_resolutions.dispute_id UNIQUE` constraint
// at the DB level — that's the cross-process backstop. The advisory lock
// is the in-process collapse, mirroring `advanceRelayHorizon` in
// horizon.ts.
const resolveLocks = new Map<string, Promise<ResolveData>>();

/** Test-only: reset the in-process advisory lock map. */
export function _resetResolveLocksForTests(): void {
  resolveLocks.clear();
}

/** Internal: data returned by the lock-wrapped resolve flow. */
interface ResolveData {
  resolution: DisputeOutcome;
  rationale: string;
  fund_action: DisputeFundAction;
  split_ratio: number;
  adjudicator_votes: AdjudicatorVote[];
  resolved_at: number;
}

// === §6.2 Federation Orchestrator ===
//
// Replaces the prior 409 self-adjudication guard with the federation
// fan-out path described in `spec/relay-federation-v1.md` §16.1.
//
// Sync v1 trade: single Promise.allSettled fan-out collapses per-peer
// fan-out timeout into the spec timeout — a peer hiccup at fan-out
// time becomes a permanently-lost vote even though the §6.6 72h
// adjudication window would technically permit retrying. Async
// retry-within-72h is a future arc; see
// memory/section_6_2_orchestrator_async_deferral.md.
//
// Fund-action mapping: federation v1 always emits `fund_action: "split"`
// with `split_ratio` encoding the verdict (1.0 upheld, 0.0 overturned,
// 0.5 split). Verdict semantics live in `resolution`; financial
// mechanics in `(fund_action, split_ratio)`. Granular release_to_worker
// / refund_to_delegator parity is a future arc; see
// memory/dispute_v1_fund_action_federation_parity_followup.md and
// `spec/dispute-v1.md` §7.2.

interface PeerRow {
  peer_relay_id: string;
  public_key: string;
  endpoint_url: string;
}

interface FederationResolutionResult {
  resolution: DisputeOutcome;
  rationale: string;
  fund_action: DisputeFundAction;
  split_ratio: number;
  adjudicator_votes: AdjudicatorVote[];
}

/**
 * Fetch a single peer's `AdjudicatorVote`. Returns `null` on any
 * failure (timeout, fetch error, non-200, schema fail, signature
 * mismatch, suite mismatch, round mismatch). The §6.5 + §8.3
 * independent-review property is preserved by under-counting: failed
 * peers do not contribute synthesized votes (a leader cannot
 * manufacture quorum from absent peers).
 */
async function fetchPeerVote(
  peer: PeerRow,
  signedRequest: VoteRequest,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  disputeId: string,
): Promise<AdjudicatorVote | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${peer.endpoint_url}/federation/v1/disputes/${signedRequest.dispute_id}/vote-request`;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signedRequest),
      signal: controller.signal,
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      logger.warn("federation.orchestrator.peer_response_error", {
        disputeId,
        peerId: peer.peer_relay_id,
        status: res.status,
        body: bodyText.slice(0, 200),
      });
      return null;
    }
    const body = (await res.json()) as unknown;
    const parsed = AdjudicatorVoteSchema.safeParse(body);
    if (!parsed.success) {
      logger.warn("federation.orchestrator.peer_response_malformed", {
        disputeId,
        peerId: peer.peer_relay_id,
        error: parsed.error.message.slice(0, 200),
      });
      return null;
    }
    const vote = parsed.data;
    if (vote.dispute_id !== signedRequest.dispute_id || vote.round !== signedRequest.round) {
      logger.warn("federation.orchestrator.peer_response_binding_mismatch", {
        disputeId,
        peerId: peer.peer_relay_id,
        expectedDispute: signedRequest.dispute_id,
        gotDispute: vote.dispute_id,
        expectedRound: signedRequest.round,
        gotRound: vote.round,
      });
      return null;
    }
    if (vote.peer_id !== peer.peer_relay_id) {
      logger.warn("federation.orchestrator.peer_response_id_mismatch", {
        disputeId,
        peerId: peer.peer_relay_id,
        gotPeerId: vote.peer_id,
      });
      return null;
    }
    const valid = await verifyAdjudicatorVote(vote, hexToBytes(peer.public_key));
    if (!valid) {
      logger.warn("federation.orchestrator.peer_signature_invalid", {
        kind: "signature_invalid",
        disputeId,
        peerId: peer.peer_relay_id,
      });
      return null;
    }
    return vote;
  } catch (err) {
    logger.warn("federation.orchestrator.peer_fetch_failed", {
      disputeId,
      peerId: peer.peer_relay_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Aggregate valid peer votes into a `FederationResolutionResult`.
 *
 * §6.4: Majority wins; ties resolve to `split`.
 * §6.6: If valid count < FEDERATION_QUORUM_MIN OR no majority, the
 *       resolution defaults to `split` with `split_ratio: 0.5` per the
 *       72h timeout convention.
 * §7.2: Federation v1 always emits `fund_action: "split"` with
 *       `split_ratio` encoding the verdict (1.0/0.0/0.5).
 */
function aggregateVotes(
  validVotes: AdjudicatorVote[],
  attemptedPeers: number,
): FederationResolutionResult {
  if (validVotes.length < FEDERATION_QUORUM_MIN) {
    return {
      resolution: "split",
      rationale: `federation quorum not met within 72h adjudication window (${validVotes.length} valid vote(s) of ${attemptedPeers} peer(s) attempted; minimum ${FEDERATION_QUORUM_MIN} required per §6.2 + §6.6)`,
      fund_action: "split",
      split_ratio: 0.5,
      adjudicator_votes: validVotes,
    };
  }
  const counts: Record<DisputeOutcome, number> = { upheld: 0, overturned: 0, split: 0 };
  for (const v of validVotes) counts[v.vote]++;
  const max = Math.max(counts.upheld, counts.overturned, counts.split);
  const winners = (Object.keys(counts) as DisputeOutcome[]).filter((k) => counts[k] === max);
  const resolution: DisputeOutcome = winners.length === 1 ? winners[0]! : "split";
  const split_ratio = resolution === "upheld" ? 1.0 : resolution === "overturned" ? 0.0 : 0.5;
  return {
    resolution,
    rationale: `federation adjudication: ${counts.upheld} upheld, ${counts.overturned} overturned, ${counts.split} split (${validVotes.length} valid of ${attemptedPeers} attempted)`,
    fund_action: "split",
    split_ratio,
    adjudicator_votes: validVotes,
  };
}

/**
 * Run the §6.2 federation adjudication orchestrator for a dispute the
 * local relay is a party to. Throws `HTTPException(503, ...)` when the
 * mesh is too small or the dispute body cannot be retrieved. Otherwise
 * returns the federation-derived `FederationResolutionResult` for the
 * caller to sign + persist.
 *
 * @spec motebit/relay-federation@1.2 §16.1
 * @spec motebit/dispute@1.0 §6.2 + §6.6 + §7.2
 */
export async function orchestrateFederationResolution(
  dispute: { dispute_id: string; body_json: string },
  round: number,
  deps: {
    db: DatabaseDriver;
    relayIdentity: RelayIdentity;
    fetchImpl?: typeof fetch;
    voteRequestTimeoutMs?: number;
  },
): Promise<FederationResolutionResult> {
  const { db, relayIdentity } = deps;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = deps.voteRequestTimeoutMs ?? FEDERATION_VOTE_REQUEST_TIMEOUT_MS;

  // 1. Enumerate active peers (excluding self per §6.5)
  const peers = db
    .prepare(
      `SELECT peer_relay_id, public_key, endpoint_url
       FROM relay_peers
       WHERE state IN ('active', 'suspended') AND peer_relay_id != ?`,
    )
    .all(relayIdentity.relayMotebitId) as PeerRow[];

  if (peers.length < FEDERATION_QUORUM_MIN) {
    throw new HTTPException(503, {
      message: JSON.stringify({
        error_code: "insufficient_federation_peers",
        message: `Federation adjudication requires ≥${FEDERATION_QUORUM_MIN} OTHER active peers (spec/dispute-v1.md §6.2 + §6.5 + §6.6). Active peer count: ${peers.length}.`,
      }),
    });
  }

  // 2. Pull dispute body (defensive guard for the unreachable empty case;
  //    legacy disputes pre-migration-18 would hit this)
  if (!dispute.body_json) {
    throw new HTTPException(503, {
      message: JSON.stringify({
        error_code: "legacy_dispute_no_signed_body",
        message:
          "Dispute predates the §6.2 body_json migration; federation adjudication unavailable for this dispute.",
      }),
    });
  }
  let parsedDisputeRequest: DisputeRequest;
  try {
    parsedDisputeRequest = JSON.parse(dispute.body_json) as DisputeRequest;
  } catch (err) {
    throw new HTTPException(500, {
      message: `Failed to parse dispute body_json: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 3. Pull evidence_bundle from the relay_dispute_evidence table
  const evidenceRows = db
    .prepare("SELECT evidence_data FROM relay_dispute_evidence WHERE dispute_id = ?")
    .all(dispute.dispute_id) as Array<{ evidence_data: string }>;
  const evidence_bundle: DisputeEvidence[] = evidenceRows.map(
    (r) => JSON.parse(r.evidence_data) as DisputeEvidence,
  );

  // 4. Construct + sign the VoteRequest
  const requestBody: Omit<VoteRequest, "signature"> = {
    dispute_id: dispute.dispute_id,
    round,
    dispute_request: parsedDisputeRequest,
    evidence_bundle,
    requester_id: relayIdentity.relayMotebitId,
    requested_at: Date.now(),
    suite: "motebit-jcs-ed25519-b64-v1",
  };
  const sigBytes = await sign(
    new TextEncoder().encode(canonicalJson(requestBody)),
    relayIdentity.privateKey,
  );
  // VoteRequest suite is `motebit-jcs-ed25519-b64-v1` per the spec
  // (`spec/relay-federation-v1.md` §16.2 + `spec/dispute-v1.md` §6.4
  // signing recipe). Signature MUST be base64url-encoded — the peer's
  // gate-4 verify uses `fromBase64Url(signature)`. Hex encoding is for
  // `motebit-concat-ed25519-hex-v1` (federation peering / heartbeat),
  // a different suite entirely.
  const signedRequest: VoteRequest = { ...requestBody, signature: toBase64Url(sigBytes) };

  // 5. Parallel fan-out with per-request timeout (§16.3 default 10s)
  logger.info("federation.orchestrator.fanout_started", {
    disputeId: dispute.dispute_id,
    round,
    peerCount: peers.length,
    timeoutMs,
  });
  const settled = await Promise.allSettled(
    peers.map((peer) =>
      fetchPeerVote(peer, signedRequest, fetchImpl, timeoutMs, dispute.dispute_id),
    ),
  );
  const validVotes: AdjudicatorVote[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value !== null) {
      validVotes.push(result.value);
    }
  }

  // 6. Persist each valid vote (PK on (dispute_id, round, peer_id);
  //    upsert covers re-orchestration of the same round)
  const insertVote = db.prepare(
    `INSERT INTO relay_dispute_votes
       (dispute_id, round, peer_id, vote, rationale, suite, signature, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dispute_id, round, peer_id) DO UPDATE SET
       vote = excluded.vote,
       rationale = excluded.rationale,
       suite = excluded.suite,
       signature = excluded.signature,
       received_at = excluded.received_at`,
  );
  const receivedAt = Date.now();
  for (const vote of validVotes) {
    insertVote.run(
      vote.dispute_id,
      vote.round,
      vote.peer_id,
      vote.vote,
      vote.rationale,
      vote.suite,
      vote.signature,
      receivedAt,
    );
  }

  // 7. Aggregate
  const result = aggregateVotes(validVotes, peers.length);

  logger.info("federation.orchestrator.aggregated", {
    disputeId: dispute.dispute_id,
    round,
    peerCount: peers.length,
    validVoteCount: validVotes.length,
    resolution: result.resolution,
    splitRatio: result.split_ratio,
  });

  return result;
}

// === Route Registration ===

export function registerDisputeRoutes(deps: DisputeDeps): void {
  const { db, app, relayIdentity } = deps;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const voteRequestTimeoutMs = deps.voteRequestTimeoutMs ?? FEDERATION_VOTE_REQUEST_TIMEOUT_MS;

  // ── POST /api/v1/allocations/:allocationId/dispute (§4) ──
  // Open a dispute, lock funds. The body MUST be a signed `DisputeRequest`
  // wire artifact per spec/dispute-v1.md §4.2 — the relay verifies the
  // signature against the filer's registered public key before accepting.
  // The unsigned-construction-input shape is gone; without the signature
  // binding the relay could not enforce foundation law §4.4 ("filing
  // party must be a direct party to the task").
  /** @spec motebit/dispute@1.0 */
  app.post("/api/v1/allocations/:allocationId/dispute", async (c) => {
    const allocationId = c.req.param("allocationId");
    const rawBody: unknown = await c.req.json().catch(() => null);
    const parsed = DisputeRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const req = parsed.data;

    // Path/body consistency. The path is the canonical address; the body
    // must agree or the relay rejects (prevents replay across allocations).
    if (req.allocation_id !== allocationId) {
      throw new HTTPException(400, {
        message: "DisputeRequest.allocation_id does not match path parameter",
      });
    }

    // Verify the signature against the filer's registered public key.
    // No public key on file = no signature can be verified = filing
    // rejected (foundation law §4.4 + §10).
    const filerRow = db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(req.filed_by) as { public_key: string } | undefined;
    if (!filerRow?.public_key) {
      throw new HTTPException(401, {
        message: "Filing party is not registered; cannot verify DisputeRequest signature",
      });
    }
    const filerPubKey = hexToBytes(filerRow.public_key);
    const sigValid = await verifyDisputeRequest(req, filerPubKey);
    if (!sigValid) {
      throw new HTTPException(401, {
        message: "DisputeRequest signature verification failed",
      });
    }

    // Replay defense — dispute_id is client-generated (UUIDv7 per §4.2);
    // the relay rejects collisions so a replay of the same signed body
    // cannot create a second dispute row.
    const existing = getDispute(db, req.dispute_id);
    if (existing) {
      throw new HTTPException(409, { message: "Dispute with this dispute_id already exists" });
    }

    // Check allocation exists — or if p2p, check settlement exists
    const allocation = db
      .prepare(
        "SELECT allocation_id, task_id, motebit_id, amount_locked, status FROM relay_allocations WHERE allocation_id = ?",
      )
      .get(allocationId) as
      | {
          allocation_id: string;
          task_id: string;
          motebit_id: string;
          amount_locked: number;
          status: string;
        }
      | undefined;

    // For p2p tasks: no allocation exists, but a p2p settlement does.
    // Create a trust-layer dispute (amount_locked = 0, no fund movement).
    let isP2pDispute = false;
    if (!allocation) {
      const p2pSettlement = db
        .prepare(
          "SELECT settlement_id, task_id, motebit_id FROM relay_settlements WHERE task_id = ? AND settlement_mode = 'p2p'",
        )
        .get(req.task_id) as
        | { settlement_id: string; task_id: string; motebit_id: string }
        | undefined;

      if (!p2pSettlement) {
        throw new HTTPException(404, { message: "Allocation not found" });
      }
      isP2pDispute = true;
    }

    // Rate limit: max active disputes per agent (§9.2)
    const activeCount = db
      .prepare(
        "SELECT COUNT(*) as cnt FROM relay_disputes WHERE filed_by = ? AND state NOT IN ('final', 'expired')",
      )
      .get(req.filed_by) as { cnt: number };

    if (activeCount.cnt >= MAX_ACTIVE_DISPUTES_PER_AGENT) {
      throw new HTTPException(429, {
        message: `Maximum ${MAX_ACTIVE_DISPUTES_PER_AGENT} active disputes per agent`,
      });
    }

    // Transition allocation to disputed (§7.1) — skip for p2p (no allocation)
    if (!isP2pDispute) {
      db.prepare("UPDATE relay_allocations SET status = 'disputed' WHERE allocation_id = ?").run(
        allocationId,
      );
    }

    const evidenceDeadline = req.filed_at + EVIDENCE_WINDOW_MS;
    const amountLocked = isP2pDispute ? 0 : allocation!.amount_locked;
    const filingFee = Math.floor(amountLocked * FILING_FEE_RATE);

    db.prepare(
      `INSERT INTO relay_disputes
       (dispute_id, task_id, allocation_id, filed_by, respondent, category, description, state, amount_locked, filing_fee, filed_at, evidence_deadline, body_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'opened', ?, ?, ?, ?, ?)`,
    ).run(
      req.dispute_id,
      req.task_id,
      allocationId,
      req.filed_by,
      req.respondent,
      req.category,
      req.description,
      amountLocked,
      filingFee,
      req.filed_at,
      evidenceDeadline,
      // Phase 6.2: persist the verified DisputeRequest body so the
      // §6.2 federation orchestrator can hand the original signed
      // artifact to peers verbatim (spec §16.2). Mirrors the
      // relay_horizon_certs.cert_json convention from migration 16.
      JSON.stringify(req),
    );

    // Transition to evidence state immediately (dispute has initial evidence)
    db.prepare("UPDATE relay_disputes SET state = 'evidence' WHERE dispute_id = ?").run(
      req.dispute_id,
    );

    logger.info("dispute.opened", {
      disputeId: req.dispute_id,
      taskId: req.task_id,
      allocationId,
      filedBy: req.filed_by,
      category: req.category,
      amountLocked,
      isP2pDispute,
    });

    return c.json({
      ok: true,
      dispute_id: req.dispute_id,
      state: "evidence" as DisputeState,
      evidence_deadline: evidenceDeadline,
      amount_locked: amountLocked,
      filing_fee: filingFee,
      p2p_dispute: isP2pDispute,
    });
  });

  // ── POST /api/v1/disputes/:disputeId/evidence (§5) ──
  // Submit evidence in an open dispute. The body MUST be a signed
  // `DisputeEvidence` wire artifact per spec §5.2 — verified against the
  // submitter's registered public key (foundation law §5.4: evidence
  // must be cryptographically verifiable; unsigned/tampered rejected).
  /** @spec motebit/dispute@1.0 */
  app.post("/api/v1/disputes/:disputeId/evidence", async (c) => {
    const disputeId = c.req.param("disputeId");
    const rawBody: unknown = await c.req.json().catch(() => null);
    const parsed = DisputeEvidenceSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const ev = parsed.data;

    if (ev.dispute_id !== disputeId) {
      throw new HTTPException(400, {
        message: "DisputeEvidence.dispute_id does not match path parameter",
      });
    }

    const dispute = getDispute(db, disputeId);
    if (!dispute) throw new HTTPException(404, { message: "Dispute not found" });
    if (dispute.state !== "evidence" && dispute.state !== "opened") {
      throw new HTTPException(400, {
        message: `Cannot submit evidence in state: ${String(dispute.state)}`,
      });
    }

    // Check evidence window (§5.3)
    if (Date.now() > (dispute.evidence_deadline as number)) {
      throw new HTTPException(400, { message: "Evidence window has closed" });
    }

    // Check party is involved (§5.4: equal access). Done before signature
    // verification so an unrelated third party doesn't even reach the
    // public-key lookup.
    if (ev.submitted_by !== dispute.filed_by && ev.submitted_by !== dispute.respondent) {
      throw new HTTPException(403, { message: "Only dispute parties can submit evidence" });
    }

    const submitterRow = db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(ev.submitted_by) as { public_key: string } | undefined;
    if (!submitterRow?.public_key) {
      throw new HTTPException(401, {
        message: "Submitting party is not registered; cannot verify DisputeEvidence signature",
      });
    }
    const sigValid = await verifyDisputeEvidence(ev, hexToBytes(submitterRow.public_key));
    if (!sigValid) {
      throw new HTTPException(401, {
        message: "DisputeEvidence signature verification failed",
      });
    }

    // Check max evidence per party (§5.5)
    const evidenceCount = db
      .prepare(
        "SELECT COUNT(*) as cnt FROM relay_dispute_evidence WHERE dispute_id = ? AND submitted_by = ?",
      )
      .get(disputeId, ev.submitted_by) as { cnt: number };

    if (evidenceCount.cnt >= MAX_EVIDENCE_PER_PARTY) {
      throw new HTTPException(429, {
        message: `Maximum ${MAX_EVIDENCE_PER_PARTY} evidence submissions per party`,
      });
    }

    const evidenceId = `evi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    db.prepare(
      "INSERT INTO relay_dispute_evidence (evidence_id, dispute_id, submitted_by, evidence_type, evidence_data, description, submitted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      evidenceId,
      disputeId,
      ev.submitted_by,
      ev.evidence_type,
      JSON.stringify(ev.evidence_data),
      ev.description,
      ev.submitted_at,
    );

    logger.info("dispute.evidence_submitted", {
      disputeId,
      evidenceId,
      submittedBy: ev.submitted_by,
      evidenceType: ev.evidence_type,
    });

    return c.json({ ok: true, evidence_id: evidenceId });
  });

  // ── POST /api/v1/disputes/:disputeId/resolve (§6) ──
  // Operator resolution (single-relay adjudication) OR federation
  // adjudication entry point (§6.2).
  //
  // Concurrency + crash-recovery shape:
  //
  //   1. Cached-resolution check first. If a resolution row already
  //      exists for this dispute, return it (re-call after successful
  //      resolve is idempotent; UNIQUE constraint on resolutions blocks
  //      duplicate inserts but the cached path returns the same answer).
  //   2. Per-dispute advisory lock collapses concurrent /resolve calls
  //      to one in-flight promise. Second caller awaits the first
  //      caller's result.
  //   3. State-machine path: evidence → arbitration before fan-out.
  //      Crash between arbitration-transition and resolution-insert
  //      leaves dispute in `arbitration`; re-resolve detects existing
  //      votes (round-scoped) and either aggregates from them (≥
  //      FEDERATION_QUORUM_MIN persisted votes) or completes the
  //      fan-out. Mid-orchestration crash recovery without re-fanning-
  //      out wasted bandwidth.
  //   4. Final state transition `arbitration → resolved` + fund-action
  //      stays in the existing BEGIN/COMMIT block — that's the cross-
  //      process atomicity guarantee.
  /** @spec motebit/dispute@1.0 */
  app.post("/api/v1/disputes/:disputeId/resolve", async (c) => {
    const disputeId = c.req.param("disputeId");
    const body = await c.req.json<{
      resolution: DisputeOutcome;
      rationale: string;
      fund_action: DisputeFundAction;
      split_ratio?: number;
    }>();

    const dispute = getDispute(db, disputeId);
    if (!dispute) throw new HTTPException(404, { message: "Dispute not found" });

    // 1. Cached-resolution check — return existing resolution if present.
    //    Handles re-call after successful resolve + the second-caller-on-
    //    crash-recovery case (first caller completed; second caller sees
    //    the persisted resolution).
    const existing = db
      .prepare(
        "SELECT resolution, rationale, fund_action, split_ratio, adjudicator_votes, resolved_at FROM relay_dispute_resolutions WHERE dispute_id = ?",
      )
      .get(disputeId) as
      | {
          resolution: DisputeOutcome;
          rationale: string;
          fund_action: DisputeFundAction;
          split_ratio: number;
          adjudicator_votes: string;
          resolved_at: number;
        }
      | undefined;
    if (existing) {
      return c.json({
        ok: true,
        dispute_id: disputeId,
        state: "resolved" as DisputeState,
        resolution: existing.resolution,
        fund_action: existing.fund_action,
        split_ratio: existing.split_ratio,
        resolved_at: existing.resolved_at,
        adjudicator_votes: JSON.parse(existing.adjudicator_votes) as AdjudicatorVote[],
      });
    }

    if (dispute.state !== "evidence" && dispute.state !== "arbitration") {
      throw new HTTPException(400, {
        message: `Cannot resolve in state: ${String(dispute.state)}`,
      });
    }

    // 2. Per-dispute advisory lock. Collapse concurrent calls.
    const inFlight = resolveLocks.get(disputeId);
    if (inFlight) {
      const data = await inFlight;
      return c.json({
        ok: true,
        dispute_id: disputeId,
        state: "resolved" as DisputeState,
        ...data,
      });
    }

    const isFederationPath =
      dispute.filed_by === relayIdentity.relayMotebitId ||
      dispute.respondent === relayIdentity.relayMotebitId;

    const resolvePromise = (async (): Promise<ResolveData> => {
      let resolutionOutcome: DisputeOutcome;
      let resolutionRationale: string;
      let resolutionFundAction: DisputeFundAction;
      let splitRatio: number;
      let adjudicatorVotes: AdjudicatorVote[];

      if (isFederationPath) {
        // 3. State-machine: evidence → arbitration before fan-out.
        //    Idempotent: WHERE state = 'evidence' guards against
        //    re-running the transition on recovery.
        if (dispute.state === "evidence") {
          db.prepare(
            "UPDATE relay_disputes SET state = 'arbitration' WHERE dispute_id = ? AND state = 'evidence'",
          ).run(disputeId);
        }

        // Recovery: check for persisted votes from a prior crashed
        // orchestration. If we have ≥ quorum already, aggregate from
        // them rather than re-fanning-out (saves bandwidth + preserves
        // the votes peers signed pre-crash).
        const round = 1;
        const persistedVoteRows = db
          .prepare(
            "SELECT dispute_id, round, peer_id, vote, rationale, suite, signature FROM relay_dispute_votes WHERE dispute_id = ? AND round = ?",
          )
          .all(disputeId, round) as Array<{
          dispute_id: string;
          round: number;
          peer_id: string;
          vote: string;
          rationale: string;
          suite: string;
          signature: string;
        }>;

        if (persistedVoteRows.length >= FEDERATION_QUORUM_MIN) {
          // Recovered from mid-orchestration crash: aggregate from
          // persisted votes (peers' signatures preserved verbatim).
          logger.info("dispute.resolve.recovery_aggregation", {
            disputeId,
            round,
            persistedVoteCount: persistedVoteRows.length,
          });
          const reconstructedVotes: AdjudicatorVote[] = persistedVoteRows.map((row) => ({
            dispute_id: row.dispute_id,
            round: row.round,
            peer_id: row.peer_id,
            vote: row.vote as DisputeOutcome,
            rationale: row.rationale,
            suite: row.suite as "motebit-jcs-ed25519-b64-v1",
            signature: row.signature,
          }));
          const recovered = aggregateVotes(reconstructedVotes, persistedVoteRows.length);
          resolutionOutcome = recovered.resolution;
          resolutionRationale = recovered.rationale;
          resolutionFundAction = recovered.fund_action;
          splitRatio = recovered.split_ratio;
          adjudicatorVotes = recovered.adjudicator_votes;
        } else {
          // Fresh fan-out (or partial recovery; orchestrator's ON
          // CONFLICT DO UPDATE handles re-runs idempotently).
          // Round=1 for original adjudication; §8.3 appeals re-run with
          // round=2 (commit 4).
          const federationResult = await orchestrateFederationResolution(
            {
              dispute_id: disputeId,
              body_json: (dispute.body_json as string | null) ?? "",
            },
            round,
            { db, relayIdentity, fetchImpl, voteRequestTimeoutMs },
          );
          resolutionOutcome = federationResult.resolution;
          resolutionRationale = federationResult.rationale;
          resolutionFundAction = federationResult.fund_action;
          splitRatio = federationResult.split_ratio;
          adjudicatorVotes = federationResult.adjudicator_votes;
        }
      } else {
        // Single-relay adjudication: operator's body is the resolution.
        // Rationale required (§6.5).
        if (!body.rationale) {
          throw new HTTPException(400, { message: "Rationale is required" });
        }
        resolutionOutcome = body.resolution;
        resolutionRationale = body.rationale;
        resolutionFundAction = body.fund_action;
        splitRatio =
          body.split_ratio ??
          (body.resolution === "upheld" ? 0 : body.resolution === "overturned" ? 1 : 0.5);
        adjudicatorVotes = [];
      }

      const resolvedAt = Date.now();

      // Sign the resolution through `@motebit/encryption`'s signer.
      const signedResolution = await signDisputeResolution(
        {
          dispute_id: disputeId,
          resolution: resolutionOutcome,
          rationale: resolutionRationale,
          fund_action: resolutionFundAction,
          split_ratio: splitRatio,
          adjudicator: relayIdentity.relayMotebitId,
          adjudicator_votes: adjudicatorVotes,
          resolved_at: resolvedAt,
        },
        relayIdentity.privateKey,
      );
      const signatureHex = signedResolution.signature;

      const resolutionId = `res-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      // 4. Atomic terminal transition: resolution insert + state update +
      //    fund-action all in one txn. If anything fails, the dispute
      //    stays in `arbitration` and a re-resolve recovers cleanly.
      db.exec("BEGIN");
      try {
        db.prepare(
          `INSERT INTO relay_dispute_resolutions
             (resolution_id, dispute_id, resolution, rationale, fund_action, split_ratio, adjudicator, adjudicator_votes, resolved_at, signature)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          resolutionId,
          disputeId,
          resolutionOutcome,
          resolutionRationale,
          resolutionFundAction,
          splitRatio,
          relayIdentity.relayMotebitId,
          JSON.stringify(adjudicatorVotes),
          resolvedAt,
          signatureHex,
        );
        db.prepare(
          "UPDATE relay_disputes SET state = 'resolved', resolution = ?, rationale = ?, fund_action = ?, split_ratio = ?, adjudicator = ?, resolved_at = ? WHERE dispute_id = ?",
        ).run(
          resolutionOutcome,
          resolutionRationale,
          resolutionFundAction,
          splitRatio,
          relayIdentity.relayMotebitId,
          resolvedAt,
          disputeId,
        );
        executeFundAction(db, dispute, resolutionFundAction, splitRatio);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw new HTTPException(500, {
          message: `Dispute resolution failed — funds not moved: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      logger.info("dispute.resolved", {
        disputeId,
        resolution: resolutionOutcome,
        fundAction: resolutionFundAction,
        splitRatio,
        isFederation: isFederationPath,
        voteCount: adjudicatorVotes.length,
      });

      return {
        resolution: resolutionOutcome,
        rationale: resolutionRationale,
        fund_action: resolutionFundAction,
        split_ratio: splitRatio,
        adjudicator_votes: adjudicatorVotes,
        resolved_at: resolvedAt,
      };
    })();

    resolveLocks.set(disputeId, resolvePromise);
    try {
      const data = await resolvePromise;
      return c.json({
        ok: true,
        dispute_id: disputeId,
        state: "resolved" as DisputeState,
        resolution: data.resolution,
        fund_action: data.fund_action,
        split_ratio: data.split_ratio,
        resolved_at: data.resolved_at,
        adjudicator_votes: data.adjudicator_votes,
      });
    } finally {
      resolveLocks.delete(disputeId);
    }
  });

  // ── POST /api/v1/disputes/:disputeId/appeal (§8) ──
  // File appeal against a resolution. The body MUST be a signed
  // `DisputeAppeal` wire artifact per spec §8.2 — verified against the
  // appealing party's registered public key.
  /** @spec motebit/dispute@1.0 */
  app.post("/api/v1/disputes/:disputeId/appeal", async (c) => {
    const disputeId = c.req.param("disputeId");
    const rawBody: unknown = await c.req.json().catch(() => null);
    const parsed = DisputeAppealSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }
    const ap = parsed.data;

    if (ap.dispute_id !== disputeId) {
      throw new HTTPException(400, {
        message: "DisputeAppeal.dispute_id does not match path parameter",
      });
    }

    const dispute = getDispute(db, disputeId);
    if (!dispute) throw new HTTPException(404, { message: "Dispute not found" });
    if (dispute.state !== "resolved") {
      throw new HTTPException(400, { message: "Can only appeal a resolved dispute" });
    }

    // Check appeal window (§8.5)
    const resolvedAt = dispute.resolved_at as number;
    if (Date.now() > resolvedAt + APPEAL_WINDOW_MS) {
      throw new HTTPException(400, { message: "Appeal window has expired" });
    }

    // Check appealer is a party (party-membership check before signature
    // verification — strangers don't even reach the keystore).
    if (ap.appealed_by !== dispute.filed_by && ap.appealed_by !== dispute.respondent) {
      throw new HTTPException(403, { message: "Only dispute parties can appeal" });
    }

    // Check no prior appeal (§8.4: one appeal per dispute)
    if (dispute.appealed_at != null) {
      throw new HTTPException(409, { message: "Dispute has already been appealed" });
    }

    const appealerRow = db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(ap.appealed_by) as { public_key: string } | undefined;
    if (!appealerRow?.public_key) {
      throw new HTTPException(401, {
        message: "Appealing party is not registered; cannot verify DisputeAppeal signature",
      });
    }
    const sigValid = await verifyDisputeAppeal(ap, hexToBytes(appealerRow.public_key));
    if (!sigValid) {
      throw new HTTPException(401, {
        message: "DisputeAppeal signature verification failed",
      });
    }

    db.prepare(
      "UPDATE relay_disputes SET state = 'appealed', appealed_at = ? WHERE dispute_id = ?",
    ).run(ap.appealed_at, disputeId);

    logger.info("dispute.appealed", {
      disputeId,
      appealedBy: ap.appealed_by,
      reason: ap.reason,
    });

    return c.json({
      ok: true,
      dispute_id: disputeId,
      state: "appealed" as DisputeState,
      appealed_at: ap.appealed_at,
    });
  });

  // ── GET /api/v1/disputes/:disputeId ──
  // Query dispute status.
  /** @spec motebit/dispute@1.0 */
  app.get("/api/v1/disputes/:disputeId", (c) => {
    const disputeId = c.req.param("disputeId");
    const dispute = getDispute(db, disputeId);
    if (!dispute) throw new HTTPException(404, { message: "Dispute not found" });

    // Check for expired opened disputes (§3.2)
    if (
      dispute.state === "opened" &&
      Date.now() > (dispute.filed_at as number) + OPENED_EXPIRE_MS
    ) {
      db.prepare(
        "UPDATE relay_disputes SET state = 'expired', expired_at = ? WHERE dispute_id = ?",
      ).run(Date.now(), disputeId);
      dispute.state = "expired";
      dispute.expired_at = Date.now();
    }

    // Check for resolved→final transition (§3.3: auto-final after appeal window)
    if (
      dispute.state === "resolved" &&
      dispute.resolved_at != null &&
      Date.now() > (dispute.resolved_at as number) + APPEAL_WINDOW_MS
    ) {
      db.prepare(
        "UPDATE relay_disputes SET state = 'final', final_at = ? WHERE dispute_id = ?",
      ).run(Date.now(), disputeId);
      dispute.state = "final";
      dispute.final_at = Date.now();
    }

    // Fetch evidence
    const evidence = db
      .prepare(
        "SELECT * FROM relay_dispute_evidence WHERE dispute_id = ? ORDER BY submitted_at ASC",
      )
      .all(disputeId);

    // Fetch resolution
    const resolution = db
      .prepare("SELECT * FROM relay_dispute_resolutions WHERE dispute_id = ?")
      .get(disputeId);

    return c.json({
      ...dispute,
      evidence,
      resolution: resolution ?? null,
    });
  });

  // ── GET /api/v1/admin/disputes ──
  // Admin panel view — all disputes with stats.
  /** @internal */
  app.get("/api/v1/admin/disputes", (c) => {
    const disputes = db
      .prepare("SELECT * FROM relay_disputes ORDER BY filed_at DESC LIMIT 100")
      .all() as Array<Record<string, unknown>>;

    const stats = {
      total: disputes.length,
      opened: disputes.filter((d) => d.state === "opened").length,
      evidence: disputes.filter((d) => d.state === "evidence").length,
      arbitration: disputes.filter((d) => d.state === "arbitration").length,
      resolved: disputes.filter((d) => d.state === "resolved").length,
      appealed: disputes.filter((d) => d.state === "appealed").length,
      final: disputes.filter((d) => d.state === "final").length,
      expired: disputes.filter((d) => d.state === "expired").length,
      total_amount_locked: disputes.reduce(
        (sum, d) =>
          sum +
          ((d.state !== "final" && d.state !== "expired" ? (d.amount_locked as number) : 0) || 0),
        0,
      ),
    };

    return c.json({ disputes, stats });
  });
}

// === Fund Handling (§7) ===

function executeFundAction(
  db: DatabaseDriver,
  dispute: Record<string, unknown>,
  fundAction: DisputeFundAction,
  splitRatio: number,
): void {
  const amountLocked = dispute.amount_locked as number;
  if (amountLocked === 0) {
    logger.info("dispute.fund_action_noop", {
      disputeId: dispute.dispute_id as string,
      fundAction,
      reason: "amount_locked is 0 (p2p or zero-value dispute)",
    });
    return;
  }
  const filedBy = dispute.filed_by as string;
  const respondent = dispute.respondent as string;
  const disputeId = dispute.dispute_id as string;

  switch (fundAction) {
    case "refund_to_delegator": {
      creditAccountCanonical(
        db,
        filedBy,
        amountLocked,
        "settlement_credit",
        disputeId,
        `Dispute refund: ${disputeId}`,
      );
      break;
    }
    case "release_to_worker": {
      creditAccountCanonical(
        db,
        respondent,
        amountLocked,
        "settlement_credit",
        disputeId,
        `Dispute release: ${disputeId}`,
      );
      break;
    }
    case "split": {
      const workerAmount = Math.floor(amountLocked * splitRatio);
      const delegatorAmount = amountLocked - workerAmount;
      if (workerAmount > 0) {
        creditAccountCanonical(
          db,
          respondent,
          workerAmount,
          "settlement_credit",
          disputeId,
          `Dispute split (worker): ${disputeId}`,
        );
      }
      if (delegatorAmount > 0) {
        creditAccountCanonical(
          db,
          filedBy,
          delegatorAmount,
          "settlement_credit",
          disputeId,
          `Dispute split (delegator): ${disputeId}`,
        );
      }
      break;
    }
  }
}
