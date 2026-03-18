/**
 * Execution Ledger — builds signed GoalExecutionManifest per
 * motebit/execution-ledger@1.0 specification.
 *
 * Extracted from MotebitRuntime to keep the orchestrator focused on
 * lifecycle and messaging. All crypto is lazily imported so this
 * module stays browser-safe.
 */

import { EventType } from "@motebit/sdk";
import type {
  GoalExecutionManifest,
  ExecutionTimelineEntry,
  ExecutionStepSummary,
  DelegationReceiptSummary,
  ToolAuditEntry,
  PlanStoreAdapter,
  AuditLogSink,
} from "@motebit/sdk";
import type { EventStore } from "@motebit/event-log";

// === Canonical JSON ===

/** Deterministic JSON: sorted keys, no whitespace. Matches spec §5. */
export function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  const entries = sorted.map(
    (key) => JSON.stringify(key) + ":" + canonicalJson((obj as Record<string, unknown>)[key]),
  );
  return "{" + entries.join(",") + "}";
}

// === Hashing ===

export async function hashString(data: string): Promise<string> {
  const hashBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function computeTimelineHash(timeline: ExecutionTimelineEntry[]): Promise<string> {
  const lines = timeline.map((entry) => canonicalJson(entry));
  return hashString(lines.join("\n"));
}

// === Replay ===

export interface ReplayGoalDeps {
  motebitId: string;
  planStore: PlanStoreAdapter;
  events: EventStore;
  auditSink?: AuditLogSink;
}

/**
 * Replay a goal execution into a signed GoalExecutionManifest.
 * Pure function over the provided dependencies — no runtime state mutation.
 */
export async function replayGoal(
  deps: ReplayGoalDeps,
  goalId: string,
  privateKey?: Uint8Array,
): Promise<GoalExecutionManifest | null> {
  const { motebitId, planStore, events, auditSink } = deps;

  // 1. Get plan for goal
  const plan = planStore.getPlanForGoal(goalId);
  if (!plan) return null;

  const steps = planStore.getStepsForPlan(plan.plan_id);

  // 2. Query plan lifecycle events + delegation task events
  const planEventTypes = [
    EventType.PlanCreated,
    EventType.PlanStepStarted,
    EventType.PlanStepCompleted,
    EventType.PlanStepFailed,
    EventType.PlanStepDelegated,
    EventType.PlanCompleted,
    EventType.PlanFailed,
    EventType.GoalCreated,
    EventType.GoalExecuted,
    EventType.GoalCompleted,
    EventType.AgentTaskCompleted,
    EventType.AgentTaskFailed,
    EventType.ProposalCreated,
    EventType.ProposalAccepted,
    EventType.ProposalRejected,
    EventType.ProposalCountered,
    EventType.CollaborativeStepCompleted,
  ];
  const allEvents = await events.query({
    motebit_id: motebitId,
    event_types: planEventTypes,
  });

  // Filter to events related to this goal/plan
  const relevantEvents = allEvents.filter((e) => {
    const p = e.payload;
    return p.goal_id === goalId || p.plan_id === plan.plan_id;
  });

  // 3. Collect delegation task_ids from steps, then find matching receipt events
  const delegationTaskIds = new Set(
    steps.filter((s) => s.delegation_task_id).map((s) => s.delegation_task_id!),
  );
  const receiptEvents = allEvents.filter((e) => {
    if (e.event_type !== EventType.AgentTaskCompleted && e.event_type !== EventType.AgentTaskFailed)
      return false;
    const p = e.payload;
    return delegationTaskIds.has(p.task_id as string);
  });

  // 4. Query tool audit entries for this plan's run_id
  const toolEntries: ToolAuditEntry[] = [];
  if (auditSink?.queryByRunId != null) {
    toolEntries.push(...auditSink.queryByRunId(plan.plan_id));
  }

  // 5. Build timeline
  const timeline: ExecutionTimelineEntry[] = [];

  // Goal start
  const goalStartEvent = relevantEvents.find(
    (e) => e.event_type === EventType.GoalCreated || e.event_type === EventType.GoalExecuted,
  );
  if (goalStartEvent) {
    timeline.push({
      timestamp: goalStartEvent.timestamp,
      type: "goal_started",
      payload: { goal_id: goalId },
    });
  }

  // Plan lifecycle events — only emit recognized fields (no raw payload leak)
  for (const event of relevantEvents) {
    const p = event.payload;
    switch (event.event_type) {
      case EventType.PlanCreated:
        timeline.push({
          timestamp: event.timestamp,
          type: "plan_created",
          payload: { plan_id: p.plan_id, title: p.title, total_steps: p.total_steps },
        });
        break;
      case EventType.PlanStepStarted:
        timeline.push({
          timestamp: event.timestamp,
          type: "step_started",
          payload: {
            plan_id: p.plan_id,
            step_id: p.step_id,
            ordinal: p.ordinal,
            description: p.description,
          },
        });
        break;
      case EventType.PlanStepCompleted:
        timeline.push({
          timestamp: event.timestamp,
          type: "step_completed",
          payload: {
            plan_id: p.plan_id,
            step_id: p.step_id,
            ordinal: p.ordinal,
            tool_calls_made: p.tool_calls_made,
          },
        });
        break;
      case EventType.PlanStepFailed:
        timeline.push({
          timestamp: event.timestamp,
          type: "step_failed",
          payload: { plan_id: p.plan_id, step_id: p.step_id, ordinal: p.ordinal, error: p.error },
        });
        break;
      case EventType.PlanStepDelegated:
        timeline.push({
          timestamp: event.timestamp,
          type: "step_delegated",
          payload: {
            plan_id: p.plan_id,
            step_id: p.step_id,
            ordinal: p.ordinal,
            task_id: p.task_id,
            routing_choice: p.routing_choice,
          },
        });
        break;
      case EventType.PlanCompleted:
        timeline.push({
          timestamp: event.timestamp,
          type: "plan_completed",
          payload: { plan_id: p.plan_id },
        });
        break;
      case EventType.PlanFailed:
        timeline.push({
          timestamp: event.timestamp,
          type: "plan_failed",
          payload: { plan_id: p.plan_id, reason: p.reason },
        });
        break;
      case EventType.ProposalCreated:
        timeline.push({
          timestamp: event.timestamp,
          type: "proposal_created",
          payload: { plan_id: p.plan_id, proposal_id: p.proposal_id },
        });
        break;
      case EventType.ProposalAccepted:
        timeline.push({
          timestamp: event.timestamp,
          type: "proposal_accepted",
          payload: { plan_id: p.plan_id, proposal_id: p.proposal_id },
        });
        break;
      case EventType.ProposalRejected:
        timeline.push({
          timestamp: event.timestamp,
          type: "proposal_rejected",
          payload: { plan_id: p.plan_id, proposal_id: p.proposal_id },
        });
        break;
      case EventType.ProposalCountered:
        timeline.push({
          timestamp: event.timestamp,
          type: "proposal_countered",
          payload: { plan_id: p.plan_id, proposal_id: p.proposal_id },
        });
        break;
      case EventType.CollaborativeStepCompleted:
        timeline.push({
          timestamp: event.timestamp,
          type: "collaborative_step_completed",
          payload: { plan_id: p.plan_id, step_id: p.step_id },
        });
        break;
    }
  }

  // Tool audit entries — hash args for privacy, include both invocation and result
  for (const entry of toolEntries) {
    if (!entry.decision.allowed) continue;

    const argsHash = await hashString(JSON.stringify(entry.args, Object.keys(entry.args).sort()));

    timeline.push({
      timestamp: entry.timestamp,
      type: "tool_invoked",
      payload: { tool: entry.tool, args_hash: argsHash, call_id: entry.callId },
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

  // Goal completion
  const goalEndEvent = relevantEvents.find((e) => e.event_type === EventType.GoalCompleted);
  if (goalEndEvent) {
    timeline.push({
      timestamp: goalEndEvent.timestamp,
      type: "goal_completed",
      payload: { goal_id: goalId, status: plan.status },
    });
  }

  // Sort by timestamp, stable (preserving insertion order for same-timestamp entries)
  timeline.sort((a, b) => a.timestamp - b.timestamp);

  // 6. Build step summaries
  const stepSummaries: ExecutionStepSummary[] = steps.map((s) => {
    // Only count tools that fall within this step's time window
    const stepToolEntries = toolEntries.filter((t) => {
      if (s.started_at == null) return false;
      const end = s.completed_at ?? Infinity;
      return t.timestamp >= s.started_at && t.timestamp <= end;
    });
    const uniqueTools = [...new Set(stepToolEntries.map((t) => t.tool))];

    const summary: ExecutionStepSummary = {
      step_id: s.step_id,
      ordinal: s.ordinal,
      description: s.description,
      status: s.status,
      tools_used: uniqueTools,
      tool_calls: s.tool_calls_made,
      started_at: s.started_at,
      completed_at: s.completed_at,
    };

    if (s.delegation_task_id) {
      // Find matching receipt event to include receipt hash
      const receiptEvent = receiptEvents.find((e) => {
        const p = e.payload;
        return p.task_id === s.delegation_task_id;
      });
      const receiptPayload = receiptEvent?.payload;
      const receipt = receiptPayload?.receipt as Record<string, unknown> | undefined;

      // Extract routing provenance from the step_delegated timeline event
      const delegatedEvent = timeline.find(
        (e) => e.type === "step_delegated" && e.payload.step_id === s.step_id,
      );
      const routingChoice = delegatedEvent?.payload.routing_choice as
        | NonNullable<ExecutionStepSummary["delegation"]>["routing_choice"]
        | undefined;

      summary.delegation = {
        task_id: s.delegation_task_id,
        receipt_hash: receipt?.signature as string | undefined,
        routing_choice: routingChoice,
      };
    }

    return summary;
  });

  // 7. Extract delegation receipt summaries from event log
  const delegationReceipts: DelegationReceiptSummary[] = receiptEvents.map((e) => {
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

  // 8. Compute content hash (SHA-256 of canonical timeline)
  const contentHash = await computeTimelineHash(timeline);

  // 9. Map plan status
  const statusMap: Record<string, GoalExecutionManifest["status"]> = {
    completed: "completed",
    failed: "failed",
    paused: "paused",
    active: "active",
  };
  const manifestStatus = statusMap[plan.status] ?? "failed";

  // 10. Determine timing
  const startedAt = timeline[0]?.timestamp ?? plan.created_at;
  const completedAt = timeline[timeline.length - 1]?.timestamp ?? plan.updated_at;

  const manifest: GoalExecutionManifest = {
    spec: "motebit/execution-ledger@1.0",
    motebit_id: motebitId,
    goal_id: goalId,
    plan_id: plan.plan_id,
    started_at: startedAt,
    completed_at: completedAt,
    status: manifestStatus,
    timeline,
    steps: stepSummaries,
    delegation_receipts: delegationReceipts,
    content_hash: contentHash,
  };

  // 11. Sign if private key provided — sign raw 32-byte hash per spec §6
  if (privateKey) {
    const { sign, toBase64Url, hexToBytes } = await import("@motebit/crypto");
    const hashBytes = hexToBytes(contentHash);
    const sig = await sign(hashBytes, privateKey);
    manifest.signature = toBase64Url(sig);
  }

  return manifest;
}
