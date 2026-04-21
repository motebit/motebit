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
  hexToBytes,
  signDisputeResolution,
  verifyDisputeAppeal,
  verifyDisputeEvidence,
  verifyDisputeRequest,
} from "@motebit/encryption";
import type { DisputeState, DisputeOutcome, DisputeFundAction } from "@motebit/protocol";
import {
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
}

// === Route Registration ===

export function registerDisputeRoutes(deps: DisputeDeps): void {
  const { db, app, relayIdentity } = deps;

  // ── POST /api/v1/allocations/:allocationId/dispute (§4) ──
  // Open a dispute, lock funds. The body MUST be a signed `DisputeRequest`
  // wire artifact per spec/dispute-v1.md §4.2 — the relay verifies the
  // signature against the filer's registered public key before accepting.
  // The unsigned-construction-input shape is gone; without the signature
  // binding the relay could not enforce foundation law §4.4 ("filing
  // party must be a direct party to the task").
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
       (dispute_id, task_id, allocation_id, filed_by, respondent, category, description, state, amount_locked, filing_fee, filed_at, evidence_deadline)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'opened', ?, ?, ?, ?)`,
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
  // Operator resolution (single-relay adjudication).
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
    if (dispute.state !== "evidence" && dispute.state !== "arbitration") {
      throw new HTTPException(400, {
        message: `Cannot resolve in state: ${String(dispute.state)}`,
      });
    }

    // Foundation law §6.5: "A relay must not self-adjudicate when it
    // is the defendant." The same logic applies when the relay is the
    // filing party — no entity may judge its own case (§6.2). Refuse
    // to sign a single-relay resolution in either direction; the
    // dispute must go to federation adjudication per §6.3. Federation
    // orchestration is not yet implemented — without federation peers,
    // the agent's onchain credential anchors and settlement proofs
    // stand as independent evidence (§6.3, §10).
    if (
      dispute.filed_by === relayIdentity.relayMotebitId ||
      dispute.respondent === relayIdentity.relayMotebitId
    ) {
      throw new HTTPException(409, {
        message:
          "Relay is a party to this dispute; federation adjudication required (spec/dispute-v1.md §6.3, §6.5). " +
          "This relay has no federation peers configured — the dispute remains unresolved here; " +
          "the agent's onchain credential anchors and settlement proofs stand as independent evidence.",
      });
    }

    // Rationale required (§6.5)
    if (!body.rationale) {
      throw new HTTPException(400, { message: "Rationale is required" });
    }

    const splitRatio =
      body.split_ratio ??
      (body.resolution === "upheld" ? 0 : body.resolution === "overturned" ? 1 : 0.5);
    const resolvedAt = Date.now();

    // Sign the resolution through `@motebit/encryption`'s signer — the
    // protocol-primitive-placement rule says the sign recipe lives in
    // the package layer, not inline here. `adjudicator_votes: []` is
    // correct for single-relay (§6.4); federation orchestration fills
    // this array when it lands.
    const signedResolution = await signDisputeResolution(
      {
        dispute_id: disputeId,
        resolution: body.resolution,
        rationale: body.rationale,
        fund_action: body.fund_action,
        split_ratio: splitRatio,
        adjudicator: relayIdentity.relayMotebitId,
        adjudicator_votes: [],
        resolved_at: resolvedAt,
      },
      relayIdentity.privateKey,
    );
    const signatureHex = signedResolution.signature;

    const resolutionId = `res-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    db.prepare(
      `INSERT INTO relay_dispute_resolutions
       (resolution_id, dispute_id, resolution, rationale, fund_action, split_ratio, adjudicator, adjudicator_votes, resolved_at, signature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      resolutionId,
      disputeId,
      body.resolution,
      body.rationale,
      body.fund_action,
      splitRatio,
      relayIdentity.relayMotebitId,
      "[]",
      resolvedAt,
      signatureHex,
    );

    // Atomic: state transition + fund movement in one transaction.
    // If fund execution fails, the dispute must NOT be marked resolved.
    db.exec("BEGIN");
    try {
      db.prepare(
        "UPDATE relay_disputes SET state = 'resolved', resolution = ?, rationale = ?, fund_action = ?, split_ratio = ?, adjudicator = ?, resolved_at = ? WHERE dispute_id = ?",
      ).run(
        body.resolution,
        body.rationale,
        body.fund_action,
        splitRatio,
        relayIdentity.relayMotebitId,
        resolvedAt,
        disputeId,
      );

      // Execute fund action (§7.2) — must succeed or rollback
      executeFundAction(db, dispute, body.fund_action, splitRatio);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new HTTPException(500, {
        message: `Dispute resolution failed — funds not moved: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    logger.info("dispute.resolved", {
      disputeId,
      resolution: body.resolution,
      fundAction: body.fund_action,
      splitRatio,
    });

    return c.json({
      ok: true,
      dispute_id: disputeId,
      state: "resolved" as DisputeState,
      resolution: body.resolution,
      fund_action: body.fund_action,
      split_ratio: splitRatio,
      resolved_at: resolvedAt,
    });
  });

  // ── POST /api/v1/disputes/:disputeId/appeal (§8) ──
  // File appeal against a resolution. The body MUST be a signed
  // `DisputeAppeal` wire artifact per spec §8.2 — verified against the
  // appealing party's registered public key.
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
