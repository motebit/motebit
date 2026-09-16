/** System commands: state, model, tools, approvals, conversations, summarize, trust, welcome. */

import type { MotebitRuntime } from "../index.js";
import type { CommandResult } from "./types.js";

export function cmdState(runtime: MotebitRuntime): CommandResult {
  const state = runtime.getState();
  const entries = Object.entries(state).filter(([, v]) => typeof v === "number") as [
    string,
    number,
  ][];
  const summary = `State vector — ${entries.length} dimensions`;
  const detail = entries.map(([k, v]) => `${k}: ${v.toFixed(3)}`).join("\n");
  return { summary, detail, data: { state } };
}

export function cmdModel(runtime: MotebitRuntime): CommandResult {
  const model = runtime.currentModel;
  return { summary: model ? `Current model: ${model}` : "No model connected." };
}

export function cmdTools(runtime: MotebitRuntime): CommandResult {
  const tools = runtime.getToolRegistry().list();
  if (tools.length === 0) return { summary: "No tools registered." };
  const names = tools.map((t) => t.name);
  return {
    summary: `${tools.length} tools registered: ${names.join(", ")}`,
    data: { tools: names },
  };
}

/**
 * `approvals` / `approvals approve <id>` / `approvals deny <id> [reason]`
 *
 * The consent surface. This is what a person somewhere else is shown
 * before they decide, and what carries their decision back — so two
 * things matter more than they would in a read-only command.
 *
 * **It must show the real action.** A tool name is not a decision; the
 * destination, the path, the amount are. The queue stores a preview of
 * the arguments alongside a hash over all of them, and both are
 * surfaced — but note precisely what the hash buys: the remote surface
 * holds neither the full arguments nor the un-redacted preview, so it
 * cannot recompute anything. The hash lets a LATER LOCAL check, on the
 * machine that holds the arguments, detect a preview that diverged from
 * what would execute. It is carried forward, not verified here.
 *
 * **It must not leak while doing so.** This output crosses the relay,
 * which is not a sovereign party, so argument text goes through the
 * same credential-class redaction the runtime applies to cloud egress:
 * a person sees the destination, the relay does not see an API key.
 * Full arguments never leave the machine — `motebit approvals show`
 * reads them locally.
 *
 * Deciding here does not execute anything. It writes the verdict into
 * the same queue a terminal decision writes to; the daemon's scheduler
 * picks it up on its next tick, through the same policy gate, and a
 * halt in force outranks it.
 */
export function cmdApprovals(runtime: MotebitRuntime, args?: string): CommandResult {
  const store = runtime.approvals;
  const raw = (args ?? "").trim();
  const verb = /^(approve|deny)\s+(\S+)\s*(.*)$/i.exec(raw);

  if (verb) {
    const decision = verb[1]!.toLowerCase() === "approve" ? "approved" : "denied";
    const idPrefix = verb[2]!;
    const reason = (verb[3] ?? "").trim();
    if (store?.listPending == null || store.resolve == null) {
      return {
        summary: "This surface cannot decide approvals — its approval store is read-only.",
      };
    }
    const pending = store.listPending(runtime.motebitId);
    const match = pending.find(
      (a) => a.approval_id === idPrefix || a.approval_id.startsWith(idPrefix),
    );
    if (!match) {
      return {
        summary: `No pending approval matching "${idPrefix}".`,
        detail:
          pending.length === 0
            ? "The queue is empty."
            : `Pending: ${pending.map((a) => `${a.approval_id.slice(0, 8)} (${a.tool_name})`).join(", ")}`,
      };
    }
    if (Date.now() > match.expires_at) {
      // Sweep, then refuse. The TTL bounds the decision, not the
      // daemon's sweep — and a remote surface is used precisely when the
      // daemon may be down, so nothing else has flipped this row. Left
      // unswept it keeps appearing in `/pending` and every `/approve` is
      // refused, which reads as the command being broken rather than the
      // approval being over. The local CLI already sweeps here.
      store.expireStale?.(Date.now());
      return {
        summary: `Approval ${match.approval_id.slice(0, 8)} expired at ${new Date(match.expires_at).toISOString()} and can no longer be decided.`,
      };
    }
    // The trailing text is a DENIAL reason. Passing it on an approve
    // would write it to `denied_reason`, producing a row that is
    // `approved` with a denial attached — and the recovery drain reads
    // that field into the ApprovalApproved audit event.
    store.resolve(
      match.approval_id,
      decision,
      decision === "denied" && reason !== "" ? reason : undefined,
    );
    return {
      summary: `${decision === "approved" ? "Approved" : "Denied"}: ${match.tool_name} (${match.approval_id.slice(0, 8)}).`,
      detail:
        decision === "approved"
          ? "The daemon executes it on its next tick, through the same policy gate. A halt in force outranks this."
          : "Nothing will run.",
      data: { approval_id: match.approval_id, decision, tool_name: match.tool_name },
    };
  }

  // ── List ──
  // A surface with no readable queue must say so, never report an empty
  // one. The two are opposite answers to "is anything waiting on me",
  // and the relay's compatibility fallback can deliver this command to
  // a surface that is not the daemon — which would then answer "No
  // pending approvals" while the daemon held a real one. The decide
  // path above already refuses honestly; this one used to agree with
  // whatever the caller feared least.
  if (store?.listPending == null && !runtime.hasPendingApproval) {
    return {
      summary: "This surface cannot list approvals — it has no readable approval queue.",
      detail:
        "That is not the same as an empty queue. Ask the process that runs unattended work (`motebit run`), which owns the queue this would have read.",
    };
  }
  // Sweep before listing, for the same reason the decide path does.
  // `listPending` selects on status, not on expiry, so without this the
  // phone reports "3 approval(s) waiting on you" for rows whose TTL
  // lapsed while the daemon was down — and then refuses every one of
  // them, which reads as a broken command rather than an expired
  // approval. Fixing only the decide path fixed the half nobody sees
  // first.
  store?.expireStale?.(Date.now());
  const pending = store?.listPending?.(runtime.motebitId) ?? [];
  if (pending.length === 0) {
    // Fall back to the live in-turn approval (a surface with no queue).
    if (!runtime.hasPendingApproval) return { summary: "No pending approvals." };
    const info = runtime.pendingApprovalInfo;
    if (!info) return { summary: "No pending approvals." };
    // `data` is serialized whole and returned through the relay, so the
    // raw argument object must not ride along beside a redacted string.
    // The redacted text IS the payload.
    const redactedArgs = runtime.redactForRemoteDisclosure(JSON.stringify(info.args, null, 2));
    return {
      summary: `Pending approval: ${info.toolName}`,
      detail: `Args: ${redactedArgs}`,
      data: { toolName: info.toolName, args_preview: redactedArgs },
    };
  }

  const rows = pending.map((a) => ({
    approval_id: a.approval_id,
    tool_name: a.tool_name,
    risk_level: a.risk_level,
    goal_id: a.goal_id,
    created_at: a.created_at,
    expires_at: a.expires_at,
    /** Credential-class values masked — this crosses the relay. */
    args_preview: runtime.redactForRemoteDisclosure(a.args_preview),
    /** Over the FULL arguments, so a truncated preview is still checkable. */
    args_hash: a.args_hash,
    /**
     * Measured, not inferred. Producers store previews at different
     * widths (500 chars in the scheduler, 200 elsewhere), so a
     * length-threshold guess reports most truncated previews as
     * complete — the phone would then see a preview cut off before the
     * destination with nothing saying so. `null` means the full
     * arguments were not persisted (pre-#43 rows), which is unknown
     * rather than false.
     */
    args_truncated: a.args_json != null ? a.args_json.length > a.args_preview.length : null,
  }));
  const detail = rows
    .map(
      (r) =>
        `${r.approval_id.slice(0, 8)}  ${r.tool_name}  R${r.risk_level}\n` +
        `  ${r.args_preview}${r.args_truncated === true ? " …(truncated; full args stay on the machine)" : r.args_truncated === null ? " …(this preview may be incomplete — full args were not persisted)" : ""}\n` +
        `  expires ${new Date(r.expires_at).toISOString()}`,
    )
    .join("\n");
  return {
    summary: `${rows.length} approval(s) waiting on you.`,
    detail: `${detail}\n\nDecide with: approvals approve <id> | approvals deny <id> [reason]`,
    data: { approvals: rows },
  };
}

export function cmdConversations(runtime: MotebitRuntime): CommandResult {
  const convs = runtime.listConversations();
  if (convs.length === 0) return { summary: "No previous conversations." };
  const recent = convs.slice(0, 10).map((c) => {
    const title = c.title ?? `Untitled (${new Date(c.startedAt).toLocaleDateString()})`;
    return `${title} (${c.messageCount} messages)`;
  });
  return {
    summary: `${convs.length} conversations`,
    detail: recent.join("\n"),
    data: { conversations: convs },
  };
}

export async function cmdSummarize(runtime: MotebitRuntime): Promise<CommandResult> {
  const result = await runtime.summarizeCurrentConversation();
  return { summary: result ?? "Nothing to summarize yet." };
}

/**
 * `/trust` — what motebit holds for this identity, at a glance. Phase 1
 * of the trust-accumulation visibility arc: a single calm summary that
 * makes the thesis ("persistent identity + accumulated trust") legible
 * by counting the dimensions a user can already verify exist.
 *
 * Five dimensions today, all surface-agnostic. Three cover the
 * **accumulation pillar** (what motebit holds), two cover the
 * **governance + network pillars** (the thesis's other two legs the
 * Phase 1 ship explicitly named as next):
 *
 *   - **memories** — `runtime.memory.exportAll().nodes`. The semantic-
 *     memory graph; nodes accumulate as the user converses and
 *     memories are tagged. Decay applies at retrieval, not at count.
 *   - **conversations** — `runtime.listConversations()`. Every prior
 *     dialog the runtime has persisted.
 *   - **signed receipts** — `runtime.getRecentReceipts()`. The
 *     in-memory ring buffer of ToolInvocationReceipts the runtime has
 *     produced this session and prior (capped at the runtime's
 *     configured ring size — "what motebit can still show," not
 *     "lifetime ever produced").
 *   - **signed deletions** — audit-log rows whose action is a
 *     deletion (`delete_memory`, `delete_conversation`, `flush_record`).
 *     Each carries a signed `DeletionCertificate` per the retention
 *     policy doctrine — the count makes the governance boundary
 *     concrete: every forget operation came with cryptographic proof.
 *   - **federation peers** — `runtime.listTrustedAgents()`. The
 *     agents this motebit has trust records for. The count shows
 *     federation reach without exposing peer identities themselves.
 *
 * Web-only surface state (cookies for the cloud browser, per the
 * cookies arc shipped 2026-05-12) is layered ON TOP of this shared
 * summary by the web slash-command surface — same pattern as
 * `/sensitivity` and `/vision` decorating shared state with web-
 * specific affordances. The shared command stays surface-agnostic.
 *
 * Future dimensions: credentials accumulated, skills installed.
 * Each compounds the visibility; each waits for a clean runtime
 * accessor to surface. The pattern is additive — a new line per
 * dimension, never a re-shape of the existing ones.
 */
export async function cmdTrust(runtime: MotebitRuntime): Promise<CommandResult> {
  const conversations = runtime.listConversations();
  const receipts = runtime.getRecentReceipts();
  // `exportAll` is the public MemoryGraph aggregator; it routes
  // through the storage adapter with the runtime's bound motebitId,
  // so the trust summary is automatically scoped to this identity
  // (sovereign-floor invariant — no cross-motebit leak).
  const { nodes: memoryNodes } = await runtime.memory.exportAll();

  // Governance pillar — count signed deletion certificates from the
  // audit log. Per `docs/doctrine/retention-policy.md`, every
  // user_request deletion produces a signed certificate (mutable_pruning
  // for delete_memory, consolidation_flush for flush_record). Querying
  // with a generous limit; the audit log accrues slowly relative to
  // memory turns, so 10k captures every realistic accumulation. A user
  // who has accumulated more is a use case the audit panel covers.
  const auditRecords = await runtime.auditLog.query(runtime.motebitId, {
    limit: 10000,
  });
  const deletionRecords = auditRecords.filter(
    (r) => r.action.startsWith("delete_") || r.action === "flush_record",
  );
  const deletionCount = deletionRecords.length;

  // Network pillar — federation peers this motebit has accumulated
  // trust records for. `listTrustedAgents` returns the canonical
  // peer-trust view; count is the federation-reach signal without
  // surfacing peer identities at the summary level.
  const peers = await runtime.listTrustedAgents();
  const peerCount = peers.length;

  const memoryCount = memoryNodes.length;
  const conversationCount = conversations.length;
  const receiptCount = receipts.length;

  if (
    memoryCount === 0 &&
    conversationCount === 0 &&
    receiptCount === 0 &&
    deletionCount === 0 &&
    peerCount === 0
  ) {
    return {
      summary:
        "Motebit hasn't accumulated state yet. Trust builds as you converse, share, and act — come back after a few sessions.",
      data: {
        trust: {
          memories: 0,
          conversations: 0,
          receipts: 0,
          deletions: 0,
          peers: 0,
        },
      },
    };
  }

  const memoryLine = `${memoryCount} ${memoryCount === 1 ? "memory" : "memories"}`;
  const convoLine = `${conversationCount} ${conversationCount === 1 ? "conversation" : "conversations"}`;
  const receiptLine = `${receiptCount} signed ${receiptCount === 1 ? "receipt" : "receipts"}`;

  let summary = `Motebit holds ${memoryLine}, ${convoLine}, and ${receiptLine} for you.`;
  if (deletionCount > 0) {
    // Governance pillar surfaced in-line: every deletion came with a
    // signed certificate. Sovereignty made concrete.
    summary += ` ${deletionCount} signed ${deletionCount === 1 ? "deletion" : "deletions"} on the audit trail.`;
  }
  if (peerCount > 0) {
    // Network pillar surfaced in-line: federation reach.
    summary += ` ${peerCount} federation ${peerCount === 1 ? "peer" : "peers"} known.`;
  }

  const detailLines: string[] = [];
  if (memoryCount > 0) {
    // Sensitivity distribution — the governance signal at the memory
    // surface. A user looking at the trust summary should see what
    // kinds of memories motebit holds, not just the count.
    const bySensitivity = new Map<string, number>();
    for (const node of memoryNodes) {
      const tier = node.sensitivity ?? "none";
      bySensitivity.set(tier, (bySensitivity.get(tier) ?? 0) + 1);
    }
    const tierLine = [...bySensitivity.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tier, count]) => `${count} ${tier}`)
      .join(", ");
    detailLines.push(`Memory sensitivity: ${tierLine}`);
  }
  if (receiptCount > 0) {
    // Recent receipt tool names — the audit signal. The user sees
    // what motebit has been signing for them recently.
    const toolNames = receipts.slice(-5).map((r) => r.tool_name);
    detailLines.push(`Recent receipts: ${toolNames.join(", ")}`);
  }
  if (deletionCount > 0) {
    // Deletion-action breakdown — what KINDS of forget operations the
    // user has driven. delete_memory (specific node), delete_conversation
    // (whole conversation), flush_record (consolidation-cycle compaction).
    const byAction = new Map<string, number>();
    for (const r of deletionRecords) {
      byAction.set(r.action, (byAction.get(r.action) ?? 0) + 1);
    }
    const actionLine = [...byAction.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([action, count]) => `${count} ${action}`)
      .join(", ");
    detailLines.push(`Deletion breakdown: ${actionLine}`);
  }

  return {
    summary,
    detail: detailLines.length > 0 ? detailLines.join("\n") : undefined,
    data: {
      trust: {
        memories: memoryCount,
        conversations: conversationCount,
        receipts: receiptCount,
        deletions: deletionCount,
        peers: peerCount,
      },
    },
  };
}

/**
 * `/welcome` — Phase 1 of the onboarding arc.
 *
 * The thesis (sovereign identity + accumulated trust + governance at
 * the boundary) is now visible at multiple surfaces, but it's
 * discoverable only by typing slash commands the user doesn't yet know
 * exist. Onboarding is the forcing function for outside-observer
 * testability: walk a fresh user through the thesis in one calm
 * message instead of requiring them to grep for what motebit IS.
 *
 * Shape: a single multi-line summary the surface renders as a chat
 * message. Names the three pillars in order, points to existing
 * universal slash commands as concrete affordances, ends with an
 * invitation. Calm-software register — no banner, no modal, no auto-
 * trigger. The user types `/welcome` (or arrives via a `/help` link
 * the surfaces will wire in Phase 2) and gets the tour.
 *
 * Universal set only — `/trust`, `/memories`, `/forget`, `/help` work
 * across web/desktop/mobile/CLI. Surface-specific suggestions
 * (`/cookies` on web, `/computer` on web+desktop, etc.) are layered by
 * each surface's slash handler if needed — same overlay pattern
 * `/trust` uses for the web cookies dimension.
 *
 * Phase 2 (deferred): auto-fire `/welcome` on first-conversation
 * (composes with the existing `contextPack.firstConversation` flag the
 * AI prompt already reads). Today's ship is the on-demand discovery
 * affordance — once it lands, auto-trigger is precision tuning.
 *
 * Doctrine: `docs/doctrine/runtime-invariants-over-prompt-rules.md`
 * § trust-accumulation visibility arc — onboarding makes the
 * architecture's accumulated state legible at first encounter rather
 * than only on the third slash command the user thinks to type.
 */
export function cmdWelcome(_runtime: MotebitRuntime): CommandResult {
  const summary = "Welcome. You're talking to a motebit — a sovereign agent.";
  const detail = [
    "I have my own cryptographic identity (Ed25519 keypair). I'm yours, not someone else's:",
    "every conversation, every memory, every signed action stays inside the boundary",
    "you control. I accumulate state across our conversations and across devices —",
    "memory, trust, governance — all of it sovereign.",
    "",
    "A few things you can ask me:",
    "",
    "  /trust       — what I'm holding for you (memories, conversations, signed",
    "                 receipts, signed deletions, federation peers)",
    "  /memories    — the specific things I remember about you",
    "  /forget <id> — clear a memory; each deletion produces a signed certificate",
    "  /help        — the full list of what's available",
    "",
    "I notice, I remember, I wonder. Tell me something, or ask me anything.",
  ].join("\n");

  return { summary, detail };
}
