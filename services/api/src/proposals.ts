/**
 * Collaborative Plan Proposal routes — multi-agent negotiation protocol.
 */

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { MotebitDatabase } from "@motebit/persistence";
import type { ConnectedDevice } from "./index.js";

export interface ProposalsDeps {
  app: Hono;
  moteDb: MotebitDatabase;
  connections: Map<string, ConnectedDevice[]>;
}

export function registerProposalRoutes(deps: ProposalsDeps): void {
  const { app, moteDb, connections } = deps;

  /**
   * @experimental
   * @since 1.0.0
   * @stabilizes_by 2026-07-31
   * @replacement <none — pin in spec or remove>
   * @reason proposals.ts is a multi-agent negotiation protocol; no spec covers proposal-message shapes today. By stabilizes_by, land motebit/proposals@1.0 (or fold into plan-lifecycle-v1) and promote to @spec, or remove the surface.
   */
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
    const expiresAt = now + (body.expires_in_ms ?? 10 * 60 * 1000);

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
          `INSERT INTO relay_proposal_participants (proposal_id, motebit_id, assigned_steps) VALUES (?, ?, ?)`,
        )
        .run(body.proposal_id, p.motebit_id, JSON.stringify(p.assigned_steps));
    }

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

  /**
   * @experimental
   * @since 1.0.0
   * @stabilizes_by 2026-07-31
   * @replacement <none — pin in spec or remove>
   * @reason proposals.ts is a multi-agent negotiation protocol; no spec covers proposal-message shapes today. By stabilizes_by, land motebit/proposals@1.0 (or fold into plan-lifecycle-v1) and promote to @spec, or remove the surface.
   */
  app.get("/api/v1/proposals/:proposalId", (c) => {
    const proposalId = c.req.param("proposalId");
    const proposal = moteDb.db
      .prepare("SELECT * FROM relay_proposals WHERE proposal_id = ?")
      .get(proposalId) as Record<string, unknown> | undefined;
    if (!proposal) throw new HTTPException(404, { message: "Proposal not found" });

    const participants = moteDb.db
      .prepare("SELECT * FROM relay_proposal_participants WHERE proposal_id = ?")
      .all(proposalId) as Array<Record<string, unknown>>;

    return c.json({
      proposal_id: proposal.proposal_id,
      plan_id: proposal.plan_id,
      initiator_motebit_id: proposal.initiator_motebit_id,
      status: proposal.status,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/strict-boolean-expressions
      plan_snapshot: proposal.plan_snapshot ? JSON.parse(proposal.plan_snapshot as string) : null,
      created_at: proposal.created_at,
      expires_at: proposal.expires_at,
      updated_at: proposal.updated_at,
      participants: participants.map((p) => ({
        motebit_id: p.motebit_id,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        assigned_steps: JSON.parse(p.assigned_steps as string),
        response: p.response ?? null,
        responded_at: p.responded_at ?? null,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/strict-boolean-expressions
        counter_steps: p.counter_steps ? JSON.parse(p.counter_steps as string) : null,
      })),
    });
  });

  /**
   * @experimental
   * @since 1.0.0
   * @stabilizes_by 2026-07-31
   * @replacement <none — pin in spec or remove>
   * @reason proposals.ts is a multi-agent negotiation protocol; no spec covers proposal-message shapes today. By stabilizes_by, land motebit/proposals@1.0 (or fold into plan-lifecycle-v1) and promote to @spec, or remove the surface.
   */
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
    if (!responderId || !body.response)
      throw new HTTPException(400, { message: "Missing required fields" });

    const proposal = moteDb.db
      .prepare("SELECT * FROM relay_proposals WHERE proposal_id = ?")
      .get(proposalId) as Record<string, unknown> | undefined;
    if (!proposal) throw new HTTPException(404, { message: "Proposal not found" });
    if (proposal.status !== "pending")
      throw new HTTPException(409, {
        message: `Proposal is ${proposal.status as string}, cannot respond`,
      });

    const now = Date.now();
    moteDb.db
      .prepare(
        `UPDATE relay_proposal_participants SET response = ?, counter_steps = ?, responded_at = ?, signature = ? WHERE proposal_id = ? AND motebit_id = ?`,
      )
      .run(
        body.response,
        body.counter_steps != null ? JSON.stringify(body.counter_steps) : null,
        now,
        body.signature ?? null,
        proposalId,
        responderId,
      );

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

  /**
   * @experimental
   * @since 1.0.0
   * @stabilizes_by 2026-07-31
   * @replacement <none — pin in spec or remove>
   * @reason proposals.ts is a multi-agent negotiation protocol; no spec covers proposal-message shapes today. By stabilizes_by, land motebit/proposals@1.0 (or fold into plan-lifecycle-v1) and promote to @spec, or remove the surface.
   */
  app.post("/api/v1/proposals/:proposalId/withdraw", (c) => {
    const proposalId = c.req.param("proposalId");
    const proposal = moteDb.db
      .prepare("SELECT * FROM relay_proposals WHERE proposal_id = ?")
      .get(proposalId) as Record<string, unknown> | undefined;
    if (!proposal) throw new HTTPException(404, { message: "Proposal not found" });
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (callerMotebitId && callerMotebitId !== proposal.initiator_motebit_id)
      throw new HTTPException(403, { message: "Only the initiator can withdraw a proposal" });
    if (proposal.status !== "pending")
      throw new HTTPException(409, {
        message: `Proposal is ${proposal.status as string}, cannot withdraw`,
      });

    moteDb.db
      .prepare(
        "UPDATE relay_proposals SET status = 'withdrawn', updated_at = ? WHERE proposal_id = ?",
      )
      .run(Date.now(), proposalId);
    return c.json({ status: "withdrawn" });
  });

  /**
   * @experimental
   * @since 1.0.0
   * @stabilizes_by 2026-07-31
   * @replacement <none — pin in spec or remove>
   * @reason proposals.ts is a multi-agent negotiation protocol; no spec covers proposal-message shapes today. By stabilizes_by, land motebit/proposals@1.0 (or fold into plan-lifecycle-v1) and promote to @spec, or remove the surface.
   */
  app.get("/api/v1/proposals", (c) => {
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    const status = c.req.query("status");
    const limitStr = c.req.query("limit");
    const limit = Math.min(Math.max(parseInt(limitStr ?? "50", 10) || 50, 1), 200);

    const scopeId = callerMotebitId ?? c.req.query("motebit_id");
    if (!scopeId) throw new HTTPException(400, { message: "Missing caller identity" });

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

  /**
   * @experimental
   * @since 1.0.0
   * @stabilizes_by 2026-07-31
   * @replacement <none — pin in spec or remove>
   * @reason proposals.ts is a multi-agent negotiation protocol; no spec covers proposal-message shapes today. By stabilizes_by, land motebit/proposals@1.0 (or fold into plan-lifecycle-v1) and promote to @spec, or remove the surface.
   */
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
    if (!motebitId || !body.step_id || !body.status)
      throw new HTTPException(400, { message: "Missing required fields" });

    const stepProposal = moteDb.db
      .prepare("SELECT initiator_motebit_id FROM relay_proposals WHERE proposal_id = ?")
      .get(proposalId) as { initiator_motebit_id: string } | undefined;
    if (!stepProposal) throw new HTTPException(404, { message: "Proposal not found" });
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    const isParticipant = moteDb.db
      .prepare("SELECT 1 FROM relay_proposal_participants WHERE proposal_id = ? AND motebit_id = ?")
      .get(proposalId, motebitId);
    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (!isParticipant && motebitId !== stepProposal.initiator_motebit_id)
      throw new HTTPException(403, { message: "Caller is not a participant in this proposal" });

    const now = Date.now();
    moteDb.db
      .prepare(
        `INSERT OR REPLACE INTO relay_collaborative_step_results (proposal_id, step_id, motebit_id, status, result_summary, receipt, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        proposalId,
        body.step_id,
        motebitId,
        body.status,
        body.result_summary ?? null,
        body.receipt != null ? JSON.stringify(body.receipt) : null,
        now,
      );

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
}
