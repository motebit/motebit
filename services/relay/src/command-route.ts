/**
 * Command endpoint — unified remote execution interface.
 *
 * POST /api/v1/agents/:motebitId/command
 *   { command: "state", args?: "...", envelope: SignedRequestEnvelope }
 *   → CommandResult
 *
 * Remote ingress is signed (`signed-request-envelope@1.0`, audience
 * `agent-command/{motebit_id}`): the agent's OWN identity signs the
 * command, the relay verifies at ingress against the registered
 * public key as defense in depth, and forwards the envelope VERBATIM
 * so every consuming surface re-verifies fail-closed — the relay is a
 * convenience layer, never the trust root (Rule 6;
 * `docs/doctrine/daemon-desktop-unification.md` increment 4).
 * Unsigned requests are rejected 401 — this path has no advertised
 * senders, so there is no tolerant-reader window.
 *
 * Two execution paths:
 * 1. Relay-side (balance, deposits, discover, proposals) — answered from relay DB
 * 2. Runtime-side (state, memories, audit, etc.) — forwarded to connected agent via WebSocket
 *
 * Runtime-side commands use a request/response correlation over WebSocket:
 * relay sends { type: "command_request", id, command, args, envelope }
 * agent responds { type: "command_response", id, result }
 * relay returns result to HTTP caller with 30s timeout.
 */

import { verifyAgentCommandEnvelope } from "@motebit/crypto";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ConnectedDevice } from "./websocket.js";
import type { DatabaseDriver } from "@motebit/persistence";
import type { createLogger } from "./logger.js";

/** Commands the relay can answer from its own database. */
const RELAY_SIDE_COMMANDS = new Set(["balance", "deposits", "discover", "proposals"]);

/**
 * Commands that only an UNATTENDED runtime can meaningfully serve.
 *
 * Every surface of a motebit holds an open socket and handles
 * `command_request` — the phone, the web app, the desktop app, and the
 * daemon. For a read that is harmless: any of them can report state. For
 * these it is not. A halt sent to the phone that sent it would be
 * answered "this surface cannot be halted" while the daemon kept
 * running, and an approval decision sent to a surface with no queue
 * would be answered "no pending approval matching …" — both
 * indistinguishable from a genuine refusal, on exactly the commands
 * where a false negative is most costly.
 *
 * So these are routed to a peer announcing `background` (the capability
 * the CLI daemon announces and a phone does not). If no such peer is
 * connected the request fails as undelivered, which is the honest
 * answer: nothing was stopped and nothing was decided.
 */
const UNATTENDED_RUNTIME_COMMANDS = new Set(["halt", "resume", "halt-status", "approvals"]);

/** Commands that require the agent's runtime (forwarded via WebSocket). */
const RUNTIME_SIDE_COMMANDS = new Set([
  "state",
  "model",
  "tools",
  "memories",
  "graph",
  "curious",
  "forget",
  "audit",
  "gradient",
  "reflect",
  "summarize",
  "approvals",
  "conversations",
  // Mutating. Safe to forward because the envelope is signed by the
  // agent's OWN identity key — the caller already holds sovereign
  // authority, so what these add is reach, not privilege. The relay
  // still never decides: it forwards the envelope verbatim and the
  // runtime re-verifies fail-closed before acting.
  "halt",
  "resume",
  "halt-status",
]);

/** Informational commands that need no runtime or relay. */
const INFO_COMMANDS: Record<string, string> = {
  withdraw: "Withdrawals require the CLI for secure signing. Run: motebit withdraw",
  delegate:
    "Delegation happens transparently during conversation when connected to a relay. " +
    "To delegate manually, use the CLI: motebit delegate",
  propose: "Collaborative proposals require the CLI. Run: motebit propose",
};

/** Pending command requests waiting for WebSocket response. */
const pendingCommands = new Map<
  string,
  { resolve: (result: unknown) => void; timer: ReturnType<typeof setTimeout> }
>();

const COMMAND_TIMEOUT_MS = 30_000;

export interface CommandRouteDeps {
  app: Hono;
  db: DatabaseDriver;
  connections: Map<string, ConnectedDevice[]>;
  logger: ReturnType<typeof createLogger>;
}

export function registerCommandRoutes(deps: CommandRouteDeps): void {
  const { app, db, connections } = deps;

  /** @internal */
  app.post("/api/v1/agents/:motebitId/command", async (c) => {
    const motebitId = c.req.param("motebitId");
    const body: Record<string, unknown> = await c.req.json();

    if (typeof body.command !== "string" || body.command === "") {
      throw new HTTPException(400, { message: "Missing 'command' field" });
    }

    const command = body.command;
    const args = typeof body.args === "string" ? body.args : undefined;

    // --- Signed-request-envelope verification (fail-closed ingress) ---
    // Defense in depth: the relay rejects what it can already see is
    // invalid, but the consuming surface's own verification is the
    // invariant — the envelope is forwarded verbatim below.
    const registered = db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(motebitId) as { public_key: string } | undefined;
    if (!registered || registered.public_key === "") {
      throw new HTTPException(401, {
        message: "Unknown agent identity — no registered public key to verify the command against",
      });
    }
    const verdict = await verifyAgentCommandEnvelope({
      envelope: body.envelope,
      command,
      args,
      motebitId,
      identityPublicKey: registered.public_key,
    });
    if (!verdict.ok) {
      throw new HTTPException(401, { message: verdict.reason });
    }

    // --- Informational commands (no runtime or relay needed) ---
    if (command in INFO_COMMANDS) {
      return c.json({ summary: INFO_COMMANDS[command] });
    }

    // --- Relay-side commands (answered from DB) ---
    if (RELAY_SIDE_COMMANDS.has(command)) {
      try {
        const result = executeRelaySideCommand(db, motebitId, command);
        return c.json(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new HTTPException(500, { message: `Command failed: ${msg}` });
      }
    }

    // --- Runtime-side commands (forward to connected agent) ---
    if (RUNTIME_SIDE_COMMANDS.has(command)) {
      const peers = connections.get(motebitId);
      if (!peers || peers.length === 0) {
        return c.json({ summary: "Agent not connected." }, 404);
      }

      try {
        const result = await forwardCommandToAgent(peers, command, args, body.envelope);
        return c.json(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "Command timed out") {
          return c.json({ summary: "Agent did not respond in time." }, 504);
        }
        throw new HTTPException(500, { message: `Command failed: ${msg}` });
      }
    }

    // --- MCP (surface-specific, not supported remotely) ---
    if (command === "mcp") {
      return c.json({
        summary: "MCP server listing is surface-specific and not available remotely.",
      });
    }

    throw new HTTPException(400, { message: `Unknown command: ${command}` });
  });

  // --- Handle command_response messages from WebSocket ---
  // This is called from the WebSocket onMessage handler in websocket.ts
  /** @internal */
  app.get("/__internal/noop", (c) => c.text("ok")); // placeholder to keep Hono happy
}

/**
 * Called by the WebSocket message handler when an agent sends a command_response.
 * Resolves the pending Promise so the HTTP handler can return the result.
 */
export function handleCommandResponse(commandId: string, result: unknown): void {
  const pending = pendingCommands.get(commandId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingCommands.delete(commandId);
  pending.resolve(result);
}

// --- WebSocket forwarding ---

async function forwardCommandToAgent(
  peers: ConnectedDevice[],
  command: string,
  args: string | undefined,
  // Forwarded VERBATIM — the consuming surface re-verifies fail-closed.
  envelope: unknown,
): Promise<unknown> {
  const commandId = crypto.randomUUID();
  const payload = JSON.stringify({
    type: "command_request",
    id: commandId,
    command,
    args,
    envelope,
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(commandId);
      reject(new Error("Command timed out"));
    }, COMMAND_TIMEOUT_MS);

    pendingCommands.set(commandId, { resolve, timer });

    // For most commands any connected surface can answer. For the
    // unattended-runtime set, only a peer that actually runs unattended
    // work can — see UNATTENDED_RUNTIME_COMMANDS.
    const candidates = UNATTENDED_RUNTIME_COMMANDS.has(command)
      ? peers.filter((p) => p.capabilities?.includes("background") === true)
      : peers;

    if (candidates.length === 0) {
      clearTimeout(timer);
      pendingCommands.delete(commandId);
      reject(
        new Error(
          UNATTENDED_RUNTIME_COMMANDS.has(command)
            ? "No unattended runtime is connected — nothing was delivered, so nothing was stopped or decided"
            : "No reachable device",
        ),
      );
      return;
    }

    const sent = candidates.some((peer) => {
      try {
        peer.ws.send(payload);
        return true;
      } catch {
        return false;
      }
    });

    if (!sent) {
      clearTimeout(timer);
      pendingCommands.delete(commandId);
      reject(new Error("No reachable device"));
    }
  });
}

// --- Relay-side command execution ---

interface CommandResult {
  summary: string;
  detail?: string;
  data?: Record<string, unknown>;
}

function executeRelaySideCommand(
  db: DatabaseDriver,
  motebitId: string,
  command: string,
): CommandResult {
  switch (command) {
    case "balance": {
      const row = db
        .prepare(
          "SELECT balance, pending_allocations, currency FROM virtual_accounts WHERE motebit_id = ?",
        )
        .get(motebitId) as
        { balance: number; pending_allocations: number; currency: string } | undefined;
      if (!row) return { summary: "No account found." };
      return {
        summary: `Balance: ${row.balance} ${row.currency ?? "USDC"}. Pending: ${row.pending_allocations ?? 0}`,
        data: { balance: row.balance, pending: row.pending_allocations, currency: row.currency },
      };
    }

    case "deposits": {
      const rows = db
        .prepare(
          "SELECT amount, created_at, type FROM ledger_entries WHERE motebit_id = ? AND type = 'deposit' ORDER BY created_at DESC LIMIT 10",
        )
        .all(motebitId) as Array<{ amount: number; created_at: string; type: string }>;
      if (rows.length === 0) return { summary: "No deposits yet." };
      const lines = rows.map(
        (d) => `${new Date(d.created_at).toLocaleDateString()} — ${d.amount} USDC`,
      );
      return {
        summary: `${rows.length} recent deposits`,
        detail: lines.join("\n"),
        data: { deposits: rows },
      };
    }

    case "discover": {
      const rows = db
        .prepare(
          "SELECT motebit_id, capabilities FROM agent_listings WHERE active = 1 ORDER BY last_seen DESC LIMIT 15",
        )
        .all() as Array<{ motebit_id: string; capabilities: string }>;
      if (rows.length === 0) return { summary: "No agents found on relay." };
      const agents = rows.map((r) => ({
        motebit_id: r.motebit_id,
        capabilities: r.capabilities ? (JSON.parse(r.capabilities) as string[]) : [],
      }));
      const lines = agents.map(
        (a) => `${a.motebit_id.slice(0, 8)}... — ${a.capabilities.join(", ") || "no caps"}`,
      );
      return {
        summary: `${agents.length} agents discovered`,
        detail: lines.join("\n"),
        data: { agents },
      };
    }

    case "proposals": {
      const rows = db
        .prepare(
          "SELECT proposal_id, status, goal, created_at FROM relay_proposals WHERE initiator_id = ? ORDER BY created_at DESC LIMIT 10",
        )
        .all(motebitId) as Array<{
        proposal_id: string;
        status: string;
        goal: string;
        created_at: number;
      }>;
      if (rows.length === 0) return { summary: "No active proposals." };
      const lines = rows.map(
        (p) => `${p.proposal_id.slice(0, 8)}... [${p.status}] — ${(p.goal ?? "").slice(0, 60)}`,
      );
      return {
        summary: `${rows.length} proposals`,
        detail: lines.join("\n"),
        data: { proposals: rows },
      };
    }

    default:
      return { summary: `Unknown relay command: ${command}` };
  }
}
