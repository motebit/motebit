/**
 * State Export routes — read-only agent state queries for admin/dashboard.
 *
 * Pure reads: state vector, memory graph, goals, conversations, devices,
 * audit trail, plans, gradient history, execution ledger reconstruction.
 */

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { MotebitDatabase } from "@motebit/persistence";
import type { EventStore } from "@motebit/event-log";
import type { IdentityManager } from "@motebit/core-identity";
import type { EventLogEntry, ToolAuditEntry } from "@motebit/sdk";
import { asMotebitId, asNodeId, asConversationId, asPlanId } from "@motebit/sdk";
import { canonicalJson, bytesToHex } from "@motebit/encryption";

export interface StateExportDeps {
  app: Hono;
  moteDb: MotebitDatabase;
  eventStore: EventStore;
  identityManager: IdentityManager;
  /** Redact sensitive events before returning to callers. */
  redactSensitiveEvents: (events: EventLogEntry[]) => EventLogEntry[];
}

export function registerStateExportRoutes(deps: StateExportDeps): void {
  const { app, moteDb, eventStore, identityManager, redactSensitiveEvents } = deps;

  // --- State vector snapshot ---
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

  // --- Memory graph ---
  app.get("/api/v1/memory/:motebitId", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const sensitivityParam = c.req.query("sensitivity");
    const [allMemories, edges] = await Promise.all([
      moteDb.memoryStorage.getAllNodes(motebitId),
      moteDb.memoryStorage.getAllEdges(motebitId),
    ]);
    const DISPLAY_ALLOWED = new Set(["none", "personal"]);
    const memories =
      sensitivityParam === "all"
        ? allMemories
        : allMemories.filter((m) => DISPLAY_ALLOWED.has(m.sensitivity ?? "none"));
    const redacted = allMemories.length - memories.length;
    return c.json({ motebit_id: motebitId, memories, edges, redacted });
  });

  // --- Memory tombstone ---
  app.delete("/api/v1/memory/:motebitId/:nodeId", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const nodeId = asNodeId(c.req.param("nodeId"));
    try {
      const deleted =
        moteDb.memoryStorage.tombstoneNodeOwned != null
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

  // --- Goals ---
  app.get("/api/v1/goals/:motebitId", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const goals = moteDb.goalStore.list(motebitId);
    return c.json({ motebit_id: motebitId, goals });
  });

  // --- Conversations ---
  app.get("/api/v1/conversations/:motebitId", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const conversations = moteDb.db
      .prepare(`SELECT * FROM sync_conversations WHERE motebit_id = ? ORDER BY last_active_at DESC`)
      .all(motebitId) as Array<Record<string, unknown>>;
    return c.json({ motebit_id: motebitId, conversations });
  });

  // --- Conversation messages ---
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

  // --- Devices ---
  app.get("/api/v1/devices/:motebitId", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const devices = await identityManager.listDevices(motebitId);
    return c.json({ motebit_id: motebitId, devices });
  });

  // --- Tool audit trail ---
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

  // --- Plans ---
  app.get("/api/v1/plans/:motebitId", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const plans = moteDb.planStore.listPlans(motebitId);
    const plansWithSteps = plans.map((plan) => ({
      ...plan,
      steps: moteDb.planStore.getStepsForPlan(plan.plan_id),
    }));
    return c.json({ motebit_id: motebitId, plans: plansWithSteps });
  });

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

  // --- Intelligence gradient history ---
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

  // --- Admin sync pull (alias for /sync/:motebitId/pull under master auth) ---
  app.get("/api/v1/sync/:motebitId/pull", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const afterClock = Number(c.req.query("after_clock") ?? "0");
    const events = await eventStore.query({
      motebit_id: motebitId,
      after_version_clock: afterClock,
    });
    return c.json({
      motebit_id: motebitId,
      events: redactSensitiveEvents(events),
      after_clock: afterClock,
    });
  });

  // --- Execution ledger reconstruction ---
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
    const canonicalLines = timeline.map((entry) => canonicalJson(entry));
    const hashBuf = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalLines.join("\n")),
    );
    const contentHash = bytesToHex(new Uint8Array(hashBuf));

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
}
