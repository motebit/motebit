/**
 * Data sync routes and table definitions for conversations, messages, plans, and plan steps.
 * Extracted from index.ts — zero behavior changes.
 */

import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type {
  SyncConversation,
  SyncConversationMessage,
  SyncPlan,
  SyncPlanStep,
} from "@motebit/sdk";
import { asMotebitId } from "@motebit/sdk";
import type { ConnectedDevice } from "./index.js";

export interface DataSyncDeps {
  db: any;
  app: Hono;
  connections: Map<string, ConnectedDevice[]>;
}

/**
 * Create all data-sync tables (conversations, messages, plans, plan steps)
 * and apply schema migrations for collaborative fields.
 */
export function createDataSyncTables(db: any): void {
  // Create conversation sync tables (relay-side storage)
  db.exec(`
      CREATE TABLE IF NOT EXISTS sync_conversations (
        conversation_id TEXT PRIMARY KEY,
        motebit_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        title TEXT,
        summary TEXT,
        message_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sync_conv_motebit
        ON sync_conversations (motebit_id, last_active_at DESC);

      CREATE TABLE IF NOT EXISTS sync_conversation_messages (
        message_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        motebit_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        tool_call_id TEXT,
        created_at INTEGER NOT NULL,
        token_estimate INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sync_conv_messages
        ON sync_conversation_messages (conversation_id, created_at ASC);
  `);

  // Create plan sync tables (relay-side storage)
  db.exec(`
      CREATE TABLE IF NOT EXISTS sync_plans (
        plan_id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        motebit_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        current_step_index INTEGER NOT NULL DEFAULT 0,
        total_steps INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sync_plans_motebit
        ON sync_plans (motebit_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS sync_plan_steps (
        step_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        motebit_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        description TEXT NOT NULL,
        prompt TEXT NOT NULL,
        depends_on TEXT NOT NULL DEFAULT '[]',
        optional INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        required_capabilities TEXT,
        delegation_task_id TEXT,
        result_summary TEXT,
        error_message TEXT,
        tool_calls_made INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER,
        completed_at INTEGER,
        retry_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sync_plan_steps_motebit
        ON sync_plan_steps (motebit_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sync_plan_steps_plan
        ON sync_plan_steps (plan_id, ordinal ASC);
  `);

  // Extend sync tables for collaborative fields (column-exists check pattern)
  try {
    db.exec("ALTER TABLE sync_plan_steps ADD COLUMN assigned_motebit_id TEXT DEFAULT NULL");
  } catch {
    /* column may already exist */
  }
  try {
    db.exec("ALTER TABLE sync_plans ADD COLUMN proposal_id TEXT DEFAULT NULL");
  } catch {
    /* column may already exist */
  }
  try {
    db.exec("ALTER TABLE sync_plans ADD COLUMN collaborative INTEGER DEFAULT 0");
  } catch {
    /* column may already exist */
  }
}

// === Conversation Sync Helpers ===

export function upsertSyncConversation(db: any, conv: SyncConversation): void {
  db
    .prepare(
      `INSERT INTO sync_conversations (conversation_id, motebit_id, started_at, last_active_at, title, summary, message_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         last_active_at = MAX(excluded.last_active_at, sync_conversations.last_active_at),
         title = CASE WHEN excluded.last_active_at >= sync_conversations.last_active_at THEN excluded.title ELSE sync_conversations.title END,
         summary = CASE WHEN excluded.last_active_at >= sync_conversations.last_active_at THEN excluded.summary ELSE sync_conversations.summary END,
         message_count = MAX(excluded.message_count, sync_conversations.message_count)`,
    )
    .run(
      conv.conversation_id,
      conv.motebit_id,
      conv.started_at,
      conv.last_active_at,
      conv.title,
      conv.summary,
      conv.message_count,
    );
}

export function upsertSyncMessage(db: any, msg: SyncConversationMessage): void {
  db
    .prepare(
      `INSERT OR IGNORE INTO sync_conversation_messages
       (message_id, conversation_id, motebit_id, role, content, tool_calls, tool_call_id, created_at, token_estimate)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      msg.message_id,
      msg.conversation_id,
      msg.motebit_id,
      msg.role,
      msg.content,
      msg.tool_calls,
      msg.tool_call_id,
      msg.created_at,
      msg.token_estimate,
    );
}

// === Plan Sync Helpers ===

/** Step status ordinal for monotonicity enforcement. */
const STEP_STATUS_ORDER: Record<string, number> = {
  pending: 0,
  running: 1,
  completed: 2,
  failed: 2,
  skipped: 2,
};

function upsertSyncPlan(db: any, plan: SyncPlan): void {
  db
    .prepare(
      `INSERT INTO sync_plans (plan_id, goal_id, motebit_id, title, status, created_at, updated_at, current_step_index, total_steps, proposal_id, collaborative)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(plan_id) DO UPDATE SET
         status = CASE WHEN excluded.updated_at >= sync_plans.updated_at THEN excluded.status ELSE sync_plans.status END,
         title = CASE WHEN excluded.updated_at >= sync_plans.updated_at THEN excluded.title ELSE sync_plans.title END,
         updated_at = MAX(excluded.updated_at, sync_plans.updated_at),
         current_step_index = CASE WHEN excluded.updated_at >= sync_plans.updated_at THEN excluded.current_step_index ELSE sync_plans.current_step_index END,
         total_steps = MAX(excluded.total_steps, sync_plans.total_steps),
         proposal_id = CASE WHEN excluded.updated_at >= sync_plans.updated_at THEN excluded.proposal_id ELSE sync_plans.proposal_id END,
         collaborative = CASE WHEN excluded.updated_at >= sync_plans.updated_at THEN excluded.collaborative ELSE sync_plans.collaborative END`,
    )
    .run(
      plan.plan_id,
      plan.goal_id,
      plan.motebit_id,
      plan.title,
      plan.status,
      plan.created_at,
      plan.updated_at,
      plan.current_step_index,
      plan.total_steps,
      plan.proposal_id ?? null,
      plan.collaborative ? 1 : 0,
    );
}

function upsertSyncPlanStep(db: any, step: SyncPlanStep): void {
  // Check existing status for monotonicity
  const existing = db
    .prepare(`SELECT status, updated_at FROM sync_plan_steps WHERE step_id = ?`)
    .get(step.step_id) as { status: string; updated_at: number } | undefined;

  if (existing) {
    const incomingOrder = STEP_STATUS_ORDER[step.status] ?? 0;
    const existingOrder = STEP_STATUS_ORDER[existing.status] ?? 0;
    // Never regress status
    if (incomingOrder < existingOrder) return;
    // Same tier: use updated_at
    if (incomingOrder === existingOrder && step.updated_at < existing.updated_at) return;
  }

  db
    .prepare(
      `INSERT OR REPLACE INTO sync_plan_steps
       (step_id, plan_id, motebit_id, ordinal, description, prompt, depends_on, optional, status,
        required_capabilities, delegation_task_id, result_summary, error_message, tool_calls_made,
        started_at, completed_at, retry_count, updated_at, assigned_motebit_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      step.step_id,
      step.plan_id,
      step.motebit_id,
      step.ordinal,
      step.description,
      step.prompt,
      step.depends_on,
      step.optional ? 1 : 0,
      step.status,
      step.required_capabilities,
      step.delegation_task_id,
      step.result_summary,
      step.error_message,
      step.tool_calls_made,
      step.started_at,
      step.completed_at,
      step.retry_count,
      step.updated_at,
      step.assigned_motebit_id ?? null,
    );
}

/**
 * Register all data-sync HTTP routes (conversations, messages, plans, plan steps).
 */
export function registerDataSyncRoutes(deps: DataSyncDeps): void {
  const { db, app, connections } = deps;

  // --- Conversation Sync: push conversations ---
  app.post("/sync/:motebitId/conversations", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const body = await c.req.json<{ conversations: SyncConversation[] }>();
    if (!Array.isArray(body.conversations)) {
      throw new HTTPException(400, {
        message: "Missing or invalid 'conversations' field (must be array)",
      });
    }
    for (const conv of body.conversations) {
      upsertSyncConversation(db, conv);
    }

    // Fan out to WebSocket clients, skipping the sender device
    const senderDeviceId = c.req.header("x-device-id");
    const peers = connections.get(motebitId);
    if (peers) {
      for (const conv of body.conversations) {
        const payload = JSON.stringify({ type: "conversation", conversation: conv });
        for (const peer of peers) {
          if (peer.deviceId !== senderDeviceId) {
            peer.ws.send(payload);
          }
        }
      }
    }

    return c.json({ motebit_id: motebitId, accepted: body.conversations.length });
  });

  // --- Conversation Sync: pull conversations ---
  app.get("/sync/:motebitId/conversations", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const since = Number(c.req.query("since") ?? "0");
    const rows = db
      .prepare(
        `SELECT * FROM sync_conversations WHERE motebit_id = ? AND last_active_at > ? ORDER BY last_active_at ASC`,
      )
      .all(motebitId, since) as SyncConversation[];
    return c.json({ motebit_id: motebitId, conversations: rows, since });
  });

  // --- Conversation Sync: push messages ---
  app.post("/sync/:motebitId/messages", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const body = await c.req.json<{ messages: SyncConversationMessage[] }>();
    if (!Array.isArray(body.messages)) {
      throw new HTTPException(400, {
        message: "Missing or invalid 'messages' field (must be array)",
      });
    }
    for (const msg of body.messages) {
      upsertSyncMessage(db, msg);
    }

    // Fan out to WebSocket clients, skipping the sender device
    const senderDeviceId = c.req.header("x-device-id");
    const peers = connections.get(motebitId);
    if (peers) {
      for (const msg of body.messages) {
        const payload = JSON.stringify({ type: "conversation_message", message: msg });
        for (const peer of peers) {
          if (peer.deviceId !== senderDeviceId) {
            peer.ws.send(payload);
          }
        }
      }
    }

    return c.json({ motebit_id: motebitId, accepted: body.messages.length });
  });

  // --- Conversation Sync: pull messages ---
  app.get("/sync/:motebitId/messages", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const conversationId = c.req.query("conversation_id");
    const since = Number(c.req.query("since") ?? "0");
    if (conversationId == null || conversationId === "") {
      throw new HTTPException(400, { message: "Missing 'conversation_id' query parameter" });
    }
    const rows = db
      .prepare(
        `SELECT * FROM sync_conversation_messages WHERE conversation_id = ? AND motebit_id = ? AND created_at > ? ORDER BY created_at ASC`,
      )
      .all(conversationId, motebitId, since) as SyncConversationMessage[];
    return c.json({
      motebit_id: motebitId,
      conversation_id: conversationId,
      messages: rows,
      since,
    });
  });

  // --- Plan Sync: push plans ---
  app.post("/sync/:motebitId/plans", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const body = await c.req.json<{ plans: SyncPlan[] }>();
    if (!Array.isArray(body.plans)) {
      throw new HTTPException(400, { message: "Missing or invalid 'plans' field (must be array)" });
    }
    for (const plan of body.plans) {
      upsertSyncPlan(db, plan);
    }

    // Fan out to WebSocket clients
    const senderDeviceId = c.req.header("x-device-id");
    const peers = connections.get(motebitId);
    if (peers) {
      for (const plan of body.plans) {
        const payload = JSON.stringify({ type: "plan", plan });
        for (const peer of peers) {
          if (peer.deviceId !== senderDeviceId) {
            peer.ws.send(payload);
          }
        }
      }
    }

    return c.json({ motebit_id: motebitId, accepted: body.plans.length });
  });

  // --- Plan Sync: pull plans ---
  app.get("/sync/:motebitId/plans", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const since = Number(c.req.query("since") ?? "0");
    const rows = db
      .prepare(
        `SELECT * FROM sync_plans WHERE motebit_id = ? AND updated_at > ? ORDER BY updated_at ASC`,
      )
      .all(motebitId, since) as SyncPlan[];
    return c.json({ motebit_id: motebitId, plans: rows, since });
  });

  // --- Plan Sync: push steps ---
  app.post("/sync/:motebitId/plan-steps", async (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const body = await c.req.json<{ steps: SyncPlanStep[] }>();
    if (!Array.isArray(body.steps)) {
      throw new HTTPException(400, { message: "Missing or invalid 'steps' field (must be array)" });
    }
    for (const step of body.steps) {
      upsertSyncPlanStep(db, step);
    }

    // Fan out to WebSocket clients
    const senderDeviceId = c.req.header("x-device-id");
    const peers = connections.get(motebitId);
    if (peers) {
      for (const step of body.steps) {
        const payload = JSON.stringify({ type: "plan_step", step });
        for (const peer of peers) {
          if (peer.deviceId !== senderDeviceId) {
            peer.ws.send(payload);
          }
        }
      }
    }

    return c.json({ motebit_id: motebitId, accepted: body.steps.length });
  });

  // --- Plan Sync: pull steps ---
  app.get("/sync/:motebitId/plan-steps", (c) => {
    const motebitId = asMotebitId(c.req.param("motebitId"));
    const since = Number(c.req.query("since") ?? "0");
    const rows = db
      .prepare(
        `SELECT * FROM sync_plan_steps WHERE motebit_id = ? AND updated_at > ? ORDER BY updated_at ASC`,
      )
      .all(motebitId, since) as SyncPlanStep[];
    // SQLite stores boolean as integer — normalize for wire format
    const normalized = rows.map((r) => ({ ...r, optional: Boolean(r.optional) }));
    return c.json({ motebit_id: motebitId, steps: normalized, since });
  });
}
