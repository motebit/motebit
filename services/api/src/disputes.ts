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
import { sign, canonicalJson, bytesToHex } from "@motebit/encryption";
import type {
  DisputeState,
  DisputeOutcome,
  DisputeCategory,
  DisputeFundAction,
} from "@motebit/protocol";
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

function generateDisputeId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `dsp-${ts}-${rand}`;
}

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

export async function registerDisputeRoutes(deps: DisputeDeps): Promise<void> {
  const { db, app, relayIdentity } = deps;

  // ── POST /api/v1/allocations/:allocationId/dispute (§4) ──
  // Open a dispute, lock funds.
  app.post("/api/v1/allocations/:allocationId/dispute", async (c) => {
    const allocationId = c.req.param("allocationId");
    const body = await c.req.json<{
      task_id: string;
      filed_by: string;
      respondent: string;
      category: DisputeCategory;
      description: string;
      evidence_refs: string[];
    }>();

    // Validate required fields (§4.4)
    if (!body.task_id || !allocationId) {
      throw new HTTPException(400, { message: "task_id and allocation_id are required" });
    }
    if (!body.evidence_refs || body.evidence_refs.length === 0) {
      throw new HTTPException(400, { message: "At least one evidence reference is required" });
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
        .get(body.task_id) as
        | { settlement_id: string; task_id: string; motebit_id: string }
        | undefined;

      if (!p2pSettlement) {
        throw new HTTPException(404, { message: "Allocation not found" });
      }
      isP2pDispute = true;
    }

    // Check filing party is a direct party to the task (§4.3)
    // (The filing party should be either the delegator or worker)

    // Rate limit: max active disputes per agent (§9.2)
    const activeCount = db
      .prepare(
        "SELECT COUNT(*) as cnt FROM relay_disputes WHERE filed_by = ? AND state NOT IN ('final', 'expired')",
      )
      .get(body.filed_by) as { cnt: number };

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

    const disputeId = generateDisputeId();
    const filedAt = Date.now();
    const evidenceDeadline = filedAt + EVIDENCE_WINDOW_MS;
    const amountLocked = isP2pDispute ? 0 : allocation!.amount_locked;
    const filingFee = Math.floor(amountLocked * FILING_FEE_RATE);

    db.prepare(
      `INSERT INTO relay_disputes
       (dispute_id, task_id, allocation_id, filed_by, respondent, category, description, state, amount_locked, filing_fee, filed_at, evidence_deadline)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'opened', ?, ?, ?, ?)`,
    ).run(
      disputeId,
      body.task_id,
      allocationId,
      body.filed_by,
      body.respondent,
      body.category,
      body.description,
      amountLocked,
      filingFee,
      filedAt,
      evidenceDeadline,
    );

    // Transition to evidence state immediately (dispute has initial evidence)
    db.prepare("UPDATE relay_disputes SET state = 'evidence' WHERE dispute_id = ?").run(disputeId);

    logger.info("dispute.opened", {
      disputeId,
      taskId: body.task_id,
      allocationId,
      filedBy: body.filed_by,
      category: body.category,
      amountLocked,
      isP2pDispute,
    });

    return c.json({
      ok: true,
      dispute_id: disputeId,
      state: "evidence" as DisputeState,
      evidence_deadline: evidenceDeadline,
      amount_locked: amountLocked,
      filing_fee: filingFee,
      p2p_dispute: isP2pDispute,
    });
  });

  // ── POST /api/v1/disputes/:disputeId/evidence (§5) ──
  // Submit evidence in an open dispute.
  app.post("/api/v1/disputes/:disputeId/evidence", async (c) => {
    const disputeId = c.req.param("disputeId");
    const body = await c.req.json<{
      submitted_by: string;
      evidence_type: string;
      evidence_data: Record<string, unknown>;
      description: string;
    }>();

    const dispute = getDispute(db, disputeId);
    if (!dispute) throw new HTTPException(404, { message: "Dispute not found" });
    if (dispute.state !== "evidence" && dispute.state !== "opened") {
      throw new HTTPException(400, {
        message: `Cannot submit evidence in state: ${dispute.state}`,
      });
    }

    // Check evidence window (§5.3)
    if (Date.now() > (dispute.evidence_deadline as number)) {
      throw new HTTPException(400, { message: "Evidence window has closed" });
    }

    // Check party is involved (§5.4: equal access)
    if (body.submitted_by !== dispute.filed_by && body.submitted_by !== dispute.respondent) {
      throw new HTTPException(403, { message: "Only dispute parties can submit evidence" });
    }

    // Check max evidence per party (§5.5)
    const evidenceCount = db
      .prepare(
        "SELECT COUNT(*) as cnt FROM relay_dispute_evidence WHERE dispute_id = ? AND submitted_by = ?",
      )
      .get(disputeId, body.submitted_by) as { cnt: number };

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
      body.submitted_by,
      body.evidence_type,
      JSON.stringify(body.evidence_data),
      body.description,
      Date.now(),
    );

    logger.info("dispute.evidence_submitted", {
      disputeId,
      evidenceId,
      submittedBy: body.submitted_by,
      evidenceType: body.evidence_type,
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
      throw new HTTPException(400, { message: `Cannot resolve in state: ${dispute.state}` });
    }

    // Rationale required (§6.5)
    if (!body.rationale) {
      throw new HTTPException(400, { message: "Rationale is required" });
    }

    const splitRatio =
      body.split_ratio ??
      (body.resolution === "upheld" ? 0 : body.resolution === "overturned" ? 1 : 0.5);
    const resolvedAt = Date.now();

    // Sign the resolution
    const resolutionPayload = {
      dispute_id: disputeId,
      resolution: body.resolution,
      rationale: body.rationale,
      fund_action: body.fund_action,
      split_ratio: splitRatio,
      adjudicator: relayIdentity.relayMotebitId,
      adjudicator_votes: [],
      resolved_at: resolvedAt,
    };
    const canonical = canonicalJson(resolutionPayload);
    const sig = await sign(new TextEncoder().encode(canonical), relayIdentity.privateKey);
    const signatureHex = bytesToHex(sig);

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
  // File appeal against a resolution.
  app.post("/api/v1/disputes/:disputeId/appeal", async (c) => {
    const disputeId = c.req.param("disputeId");
    const body = await c.req.json<{
      appealed_by: string;
      reason: string;
      additional_evidence?: string[];
    }>();

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

    // Check appealer is a party
    if (body.appealed_by !== dispute.filed_by && body.appealed_by !== dispute.respondent) {
      throw new HTTPException(403, { message: "Only dispute parties can appeal" });
    }

    // Check no prior appeal (§8.4: one appeal per dispute)
    if (dispute.appealed_at) {
      throw new HTTPException(409, { message: "Dispute has already been appealed" });
    }

    const appealedAt = Date.now();
    db.prepare(
      "UPDATE relay_disputes SET state = 'appealed', appealed_at = ? WHERE dispute_id = ?",
    ).run(appealedAt, disputeId);

    logger.info("dispute.appealed", {
      disputeId,
      appealedBy: body.appealed_by,
      reason: body.reason,
    });

    return c.json({
      ok: true,
      dispute_id: disputeId,
      state: "appealed" as DisputeState,
      appealed_at: appealedAt,
    });
  });

  // ── GET /api/v1/disputes/:disputeId ──
  // Query dispute status.
  app.get("/api/v1/disputes/:disputeId", async (c) => {
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
      dispute.resolved_at &&
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
  app.get("/api/v1/admin/disputes", async (c) => {
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
