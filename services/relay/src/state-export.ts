/**
 * State Export routes — read-only agent state queries for admin/dashboard.
 *
 * Pure reads: state vector, memory graph, goals, conversations, devices,
 * audit trail, plans, gradient history, execution ledger reconstruction.
 *
 * Layered content-provenance on `/api/v1/execution/:motebitId/:goalId` —
 * the reconstructive ledger is wrapped in a relay-asserted
 * `ContentArtifactManifest` transported via the
 * `X-Motebit-Content-Manifest` HTTP header (C2PA-shape sidecar). The
 * inner `motebit/execution-ledger@1.0` body is unchanged — the spec's
 * §6 explicitly omits the agent-signature field for relay-reconstructed
 * ledgers because the relay does not hold the agent's private key.
 * The outer manifest attests "this is what the relay assembled from
 * its event log at time T," signed by `relayIdentity`. Each party
 * signs only what they witnessed (zero-trust witness-composition);
 * verifier composes against pinned public keys.
 */

import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { MotebitDatabase } from "@motebit/persistence";
import type { EventStore } from "@motebit/event-log";
import type { IdentityManager } from "@motebit/core-identity";
import type { EventLogEntry, ToolAuditEntry } from "@motebit/sdk";
import { asMotebitId, asNodeId, asConversationId, asPlanId } from "@motebit/sdk";
import { canonicalJson, bytesToHex, toBase64Url } from "@motebit/encryption";
import { signContentArtifact } from "@motebit/crypto";
import { propagateMemoryDeletion } from "./deletion-propagation.js";
import type {
  ContentArtifactType,
  SettlementSummaryPeer,
  SettlementSummaryUnattributed,
} from "@motebit/protocol";
import type { RelayIdentity } from "./federation.js";
import { getStoredReceiptJson } from "./receipts-store.js";

/**
 * Self-identification claim embedded in the outer
 * `ContentArtifactManifest.claim_generator` field. Mirrors the relay
 * version string used by `transparency.ts` so a verifier reading the
 * manifest sees the same producing-software identifier the operator-
 * transparency declaration advertises.
 */
const MOTEBIT_RELAY_CLAIM_GENERATOR = "motebit-relay/0.5.2";

export interface StateExportDeps {
  app: Hono;
  moteDb: MotebitDatabase;
  eventStore: EventStore;
  identityManager: IdentityManager;
  /**
   * The relay's signing identity. Used to sign the outer content-
   * artifact manifest on `/api/v1/execution/:motebitId/:goalId` so a
   * third party can verify the relay-assembled reconstruction without
   * trusting the relay's word — only the relay's pinned public key.
   */
  relayIdentity: RelayIdentity;
  /** Redact sensitive events before returning to callers. */
  redactSensitiveEvents: (events: EventLogEntry[]) => EventLogEntry[];
}

export function registerStateExportRoutes(deps: StateExportDeps): void {
  const { app, moteDb, eventStore, identityManager, relayIdentity, redactSensitiveEvents } = deps;

  /**
   * Sign a relay-asserted export body and emit it with the outer
   * `ContentArtifactManifest` in the `X-Motebit-Content-Manifest`
   * header. Single canonical emit path for every state-export GET —
   * the drift gate `check-state-export-signed` requires every
   * `app.get(...)` registration in this file to terminate through
   * this helper. Witness-composition: relay attests "this is what I
   * assembled at time T" via `relayIdentity`; verifier hashes the
   * received bytes and verifies the signature against the manifest's
   * declared key.
   *
   * Body serialization is JCS-canonical so the bytes are
   * deterministic across implementations — no recanonicalization
   * required at verify time.
   */
  async function emitSignedExport(
    c: Context,
    artifactType: ContentArtifactType,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const bodyJson = canonicalJson(body);
    const bodyBytes = new TextEncoder().encode(bodyJson);
    const manifest = await signContentArtifact(bodyBytes, {
      artifactType,
      producer: relayIdentity.did,
      producerPublicKey: relayIdentity.publicKey,
      producerPrivateKey: relayIdentity.privateKey,
      claimGenerator: MOTEBIT_RELAY_CLAIM_GENERATOR,
    });
    c.header(
      "X-Motebit-Content-Manifest",
      toBase64Url(new TextEncoder().encode(canonicalJson(manifest))),
    );
    return c.body(bodyJson, 200, { "Content-Type": "application/json" });
  }

  // --- State vector snapshot ---
  /** @internal */
  app.get("/api/v1/state/:motebitId", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const json = moteDb.stateSnapshot.loadState(motebitId);
    let state: Record<string, unknown> | null = null;
    if (json != null && json !== "") {
      try {
        state = JSON.parse(json) as Record<string, unknown>;
      } catch {
        state = null;
      }
    }
    return emitSignedExport(c, "state-snapshot", { motebit_id: motebitId, state });
  });

  // --- Memory graph ---
  /** @internal */
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
    return emitSignedExport(c, "memory-export", {
      motebit_id: motebitId,
      memories,
      edges,
      redacted,
    });
  });

  // --- Memory tombstone ---
  /** @internal */
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
      // Converge with the sync-path deletion propagation: erase the
      // stored memory_formed content for the node too — a tombstoned
      // projection whose formation event still carries the content is
      // not deletion.
      const { redactedEvents } = await propagateMemoryDeletion(
        { eventStore, moteDb },
        motebitId,
        nodeId,
      );
      return c.json({
        motebit_id: motebitId,
        node_id: nodeId,
        deleted: true,
        redacted_events: redactedEvents,
      });
    } catch {
      return c.json({ motebit_id: motebitId, node_id: nodeId, deleted: false }, 404);
    }
  });

  // --- Goals ---
  /** @internal */
  app.get("/api/v1/goals/:motebitId", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const goals = moteDb.goalStore.list(motebitId);
    return emitSignedExport(c, "goal-list", { motebit_id: motebitId, goals });
  });

  // --- Conversations ---
  /** @internal */
  app.get("/api/v1/conversations/:motebitId", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const conversations = moteDb.db
      .prepare(`SELECT * FROM sync_conversations WHERE motebit_id = ? ORDER BY last_active_at DESC`)
      .all(motebitId) as Array<Record<string, unknown>>;
    return emitSignedExport(c, "conversation-list", {
      motebit_id: motebitId,
      conversations,
    });
  });

  // --- Conversation messages ---
  /** @internal */
  app.get("/api/v1/conversations/:motebitId/:conversationId/messages", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const conversationId = asConversationId(c.req.param("conversationId"));
    const messages = moteDb.db
      .prepare(
        `SELECT * FROM sync_conversation_messages WHERE conversation_id = ? AND motebit_id = ? ORDER BY created_at ASC`,
      )
      .all(conversationId, motebitId) as Array<Record<string, unknown>>;
    return emitSignedExport(c, "conversation-messages", {
      motebit_id: motebitId,
      conversation_id: conversationId,
      messages,
    });
  });

  // --- Devices ---
  /** @internal */
  app.get("/api/v1/devices/:motebitId", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const devices = await identityManager.listDevices(motebitId);
    return emitSignedExport(c, "device-list", { motebit_id: motebitId, devices });
  });

  // --- Tool audit trail ---
  /** @internal */
  app.get("/api/v1/audit/:motebitId", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const turnId = c.req.query("turn_id");
    let entries: ToolAuditEntry[] = [];
    if (moteDb.toolAuditSink != null) {
      entries =
        turnId != null && turnId !== ""
          ? moteDb.toolAuditSink.query(turnId)
          : moteDb.toolAuditSink.getAll();
    }
    return emitSignedExport(c, "audit-trail", { motebit_id: motebitId, entries });
  });

  // --- Plans ---
  /** @internal */
  app.get("/api/v1/plans/:motebitId", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const plans = moteDb.planStore.listPlans(motebitId);
    const plansWithSteps = plans.map((plan) => ({
      ...plan,
      steps: moteDb.planStore.getStepsForPlan(plan.plan_id),
    }));
    return emitSignedExport(c, "plan-list", { motebit_id: motebitId, plans: plansWithSteps });
  });

  /** @internal */
  app.get("/api/v1/plans/:motebitId/:planId", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const planId = asPlanId(c.req.param("planId"));
    const plan = moteDb.planStore.getPlan(planId);
    if (!plan || plan.motebit_id !== motebitId) {
      throw new HTTPException(404, { message: "Plan not found" });
    }
    const steps = moteDb.planStore.getStepsForPlan(planId);
    return emitSignedExport(c, "plan-detail", {
      motebit_id: motebitId,
      plan: { ...plan, steps },
    });
  });

  // --- Intelligence gradient history ---
  /** @internal */
  app.get("/api/v1/gradient/:motebitId", async (c) => {
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
    return emitSignedExport(c, "gradient-history", {
      motebit_id: motebitId,
      current: snapshots[0] ?? null,
      history: snapshots,
    });
  });

  // --- Per-peer settlement summary — the money side of the first-person
  //     trust graph (docs/doctrine/agents-as-first-person-trust-graph.md §6) ---
  //
  // UNLIKE the other routes in this file (master-token admin/dashboard
  // reads), this is the caller's OWN economic history. It is gated by the
  // `account:balance` audience via `dualAuth` (see middleware.ts) and
  // own-id-checked below so a device token minted for one motebit cannot
  // read another's money graph. A master token (callerMotebitId unset)
  // bypasses for the operator console, exactly like the balance route.
  //
  // The body is a materialized projection over the signed `relay_settlements`
  // ledger — never a denormalized balance. Receipts / settlement rows stay
  // source of truth (docs/doctrine/receipts-unified.md). Emitted signed via
  // `emitSignedExport` so a verifier checks it against the relay's pinned key
  // offline (@motebit/state-export-client), making it dispute-grade.
  /** @internal */
  app.get("/api/v1/agents/:motebitId/settlements", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const callerMotebitId = c.get("callerMotebitId" as never) as string | undefined;
    if (callerMotebitId != null && callerMotebitId !== "" && callerMotebitId !== motebitId) {
      throw new HTTPException(403, {
        message:
          "settlement history is first-person: a device token may read only its own motebit's history",
      });
    }

    // Attributable settlements between the caller and each counterparty,
    // both directions. `completed` rows only; a p2p row whose onchain
    // leg-check FAILED is dropped (the claimed payment never landed — honest
    // history, not recorded intent). Self-settlements excluded (not a
    // relationship). On an earned row a null/'' `delegator_id` means the
    // payer is unknown ⇒ the unattributed bucket, never a phantom peer.
    const rows = moteDb.db
      .prepare(
        `SELECT delegator_id AS peer_id, amount_settled, platform_fee, settlement_mode, settled_at, 'earned' AS direction
           FROM relay_settlements
          WHERE motebit_id = ? AND status = 'completed'
            AND COALESCE(payment_verification_status, 'verified') != 'failed'
            AND COALESCE(delegator_id, '') != motebit_id
         UNION ALL
         SELECT motebit_id AS peer_id, amount_settled, platform_fee, settlement_mode, settled_at, 'paid' AS direction
           FROM relay_settlements
          WHERE delegator_id = ? AND status = 'completed'
            AND COALESCE(payment_verification_status, 'verified') != 'failed'
            AND motebit_id != delegator_id`,
      )
      .all(motebitId, motebitId) as Array<{
      peer_id: string | null;
      amount_settled: number;
      platform_fee: number;
      settlement_mode: string | null;
      settled_at: number;
      direction: "earned" | "paid";
    }>;

    const peers = new Map<string, SettlementSummaryPeer>();
    const unattributed: SettlementSummaryUnattributed = {
      earned_micro: 0,
      fee_micro: 0,
      settled_count: 0,
    };

    for (const r of rows) {
      const isP2p = (r.settlement_mode ?? "relay") === "p2p";
      if (r.direction === "earned" && (r.peer_id == null || r.peer_id === "")) {
        unattributed.earned_micro += r.amount_settled;
        unattributed.fee_micro += r.platform_fee;
        unattributed.settled_count += 1;
        continue;
      }
      const peerId = r.peer_id as string;
      let p = peers.get(peerId);
      if (p == null) {
        p = {
          peer_id: peerId,
          earned_micro: 0,
          paid_micro: 0,
          net_micro: 0,
          fee_micro: 0,
          settled_count: 0,
          p2p_count: 0,
          first_at: r.settled_at,
          last_at: r.settled_at,
        };
        peers.set(peerId, p);
      }
      if (r.direction === "earned") {
        p.earned_micro += r.amount_settled;
      } else {
        // The caller funded this leg; the platform fee on it is the caller's
        // coordination cost with this peer (never the peer's fee).
        p.paid_micro += r.amount_settled;
        p.fee_micro += r.platform_fee;
      }
      p.settled_count += 1;
      if (isP2p) p.p2p_count += 1;
      if (r.settled_at < p.first_at) p.first_at = r.settled_at;
      if (r.settled_at > p.last_at) p.last_at = r.settled_at;
    }
    for (const p of peers.values()) p.net_micro = p.earned_micro - p.paid_micro;

    const peerList = [...peers.values()].sort((a, b) => b.last_at - a.last_at);
    return emitSignedExport(c, "settlement-summary", {
      motebit_id: motebitId,
      peers: peerList,
      unattributed,
    });
  });

  // --- Admin sync pull (alias for /sync/:motebitId/pull under master auth) ---
  /** @internal */
  app.get("/api/v1/sync/:motebitId/pull", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const afterClock = Number(c.req.query("after_clock") ?? "0");
    const events = await eventStore.query({
      motebit_id: motebitId,
      after_version_clock: afterClock,
    });
    return emitSignedExport(c, "sync-pull", {
      motebit_id: motebitId,
      events: redactSensitiveEvents(events),
      after_clock: afterClock,
    });
  });

  // --- Execution ledger reconstruction ---
  /** @internal */
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

    // 7a. Inner signed receipts (v1.1 — additive per spec
    // `spec/execution-ledger-v1.md` §4.3). The byte-identical canonical
    // JSON of each delegated motebit's signed ExecutionReceipt — sourced
    // from `relay_receipts.receipt_json` (per `services/relay/CLAUDE.md`
    // Rule 11). Closes the operator-trust gap: a verifier holding these
    // bytes can independently verify each inner Ed25519 signature against
    // the producing motebit's public key, without trusting the relay's
    // word that "motebit X did this work." Ordering corresponds 1:1 with
    // `delegationReceipts` by `task_id`.
    //
    // Archive lookup key is `(delegate_motebit_id, task_id)` per
    // `services/relay/src/receipts-store.ts` — the DELEGATE's motebit
    // signed the receipt, not the goal-owner. Using the goal-owner's
    // motebitId here would miss every cross-motebit delegation.
    //
    // Producing v1.1 only when at least one inner receipt is archived
    // keeps the reconstruction graceful on relays that don't yet have
    // the archive populated — the v1.0 envelope still works for them.
    const signedReceipts: string[] = [];
    for (const summary of delegationReceipts) {
      if (summary.motebit_id === "") continue;
      const archived = getStoredReceiptJson(moteDb.db, summary.motebit_id, summary.task_id);
      if (archived !== null) signedReceipts.push(archived);
    }

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

    // Inner artifact — `motebit/execution-ledger@1.0` body when no inner
    // receipts are archived, otherwise `motebit/execution-ledger@1.1`
    // (additive per spec §4.3). Per spec §6, the agent-signature field
    // is omitted for relay-reconstructed ledgers (the relay does not
    // hold the agent's private key); the outer relay-asserted manifest
    // emitted by `emitSignedExport` attests to bundle assembly, never
    // to the agent's actions. v1.1's `signed_receipts` lets verifiers
    // check inner motebit signatures independently.
    const bumpToV1_1 = signedReceipts.length > 0;
    const body: Record<string, unknown> = {
      spec: bumpToV1_1 ? "motebit/execution-ledger@1.1" : "motebit/execution-ledger@1.0",
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
    };
    if (bumpToV1_1) body.signed_receipts = signedReceipts;
    return emitSignedExport(c, "execution-ledger", body);
  });
}
