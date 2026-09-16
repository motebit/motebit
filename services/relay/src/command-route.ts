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
 * So these are routed to a peer announcing `unattended_runtime` — the
 * capability a surface announces only when it has actually wired the
 * durable halt and approval stores. `background` is not that signal:
 * the desktop app announces it and wires neither, so a halt routed by
 * `background` could be answered "this surface cannot be halted" while
 * the daemon kept running. If no such peer is connected the request
 * fails as undelivered, which is the honest answer: nothing was stopped
 * and nothing was decided.
 */
/** The subset of the above that can change something. See the 404 copy. */
const MUTATING_UNATTENDED_COMMANDS = new Set(["halt", "resume", "approvals"]);

/**
 * The subset whose answer is a per-machine DATABASE, not a per-motebit
 * fact — so which runtime answers changes what the answer is.
 *
 * `halt` and `resume` are the same act wherever they land, so the relay
 * may pick. An approval queue and a run ledger are local records: a
 * laptop's ledger answered from a VPS is a different, and wrong, answer.
 * Keyed by that property rather than by "is unattended", which is why
 * adding `runs` to the unattended set silently made this say "each with
 * its own approval queue" about a question with no queue in it.
 */
const PER_MACHINE_DATABASE_COMMANDS = new Set(["approvals", "runs"]);

const UNATTENDED_RUNTIME_COMMANDS = new Set([
  "halt",
  "resume",
  "halt-status",
  "approvals",
  // The run ledger lives only where goals actually fire, so a `runs`
  // question answered by any other surface would say "no runs recorded"
  // about a motebit that had been working all night — the false empty
  // this routing exists to prevent.
  "runs",
]);

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
  // Read-only, and forwarded for the same reason the others are: the
  // answer lives on the machine that did the work, and the consent root
  // asking from elsewhere is the point.
  "runs",
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
        // A typed rejection already says what happened and with what
        // status — re-wrapping it as a 500 would turn "nothing was
        // delivered" into "the relay broke", and a consent surface
        // cannot tell those apart.
        if (err instanceof HTTPException) throw err;
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
    const unattended = peers.filter((p) => p.capabilities?.includes("unattended_runtime") === true);
    let candidates: ConnectedDevice[];
    let emptyReason: string;

    if (!UNATTENDED_RUNTIME_COMMANDS.has(command)) {
      candidates = peers;
      emptyReason = "No reachable device";
    } else if (unattended.length > 0) {
      // One machine may announce this twice — `motebit run` and
      // `motebit serve` are two executors sharing one device id and one
      // database, so either can answer for both and first-wins is
      // harmless. Two DEVICES is a different fact: a worker running on
      // another machine has its own database, so it would answer
      // `/pending` with "No pending approvals" while the laptop daemon
      // held a real one — a false empty, which is the answer this whole
      // block exists to prevent. Refuse rather than pick.
      //
      // Only peers that DECLARED an id can be grouped. The relay invents
      // one per connection for peers that did not, so counting those
      // would read one machine's two processes as two machines — and a
      // reconnect racing a not-yet-observed close as a third — refusing
      // every remote halt in exactly the configuration this arc is for.
      // Undeclared means unknown, and unknown falls back to delivering
      // rather than to refusing: a first-wins answer from a peer that
      // shares the database is right, and this is the same machine in
      // every deployment that exists today.
      const declared = unattended.filter((p) => p.deviceIdDeclared === true);
      const devices = new Set(declared.map((p) => p.deviceId));
      const allDeclared = declared.length === unattended.length;
      // ...and the refusal belongs to `approvals` ALONE, because the
      // reasoning above is about queues.
      //
      // A halt delivered to either machine is truthful: the
      // acknowledgement is per executor and says what THAT executor
      // stopped, and the halt is durable state the other machine's
      // executor honors on its own next tick. Refusing it bought
      // nothing and cost everything — a sovereign running the daemon on
      // a laptop and the worker on a VPS got 404 "run this command on
      // the machine you mean" for every remote halt, which is unusable
      // advice for someone away from both machines. That is precisely
      // the situation this arc exists for, so the guard was breaking
      // the feature to protect a different one.
      const manyMachines =
        PER_MACHINE_DATABASE_COMMANDS.has(command) && allDeclared && devices.size > 1;
      candidates = manyMachines ? [] : unattended;
      emptyReason = manyMachines
        ? `This motebit has unattended runtimes on ${devices.size} different machines, each with its own records, so the relay cannot choose one — run this command on the machine you mean, or stop the runtime you do not`
        : "No unattended runtime is connected";
    } else if (command !== "approvals") {
      // Everything but `approvals` gets no fallback: a daemon too old to
      // announce the capability is too old to honor a halt or to hold a
      // run ledger, and "not delivered" is the truth there.
      candidates = [];
      emptyReason = "No unattended runtime is connected";
    } else {
      // The relay auto-deploys on merge; installed CLIs update on their
      // own schedule. Every daemon older than this change announces
      // `background` and not `unattended_runtime`, so filtering strictly
      // would 404 the phone's `/pending`, `/approve` and `/deny` against
      // a perfectly healthy daemon from the moment this ships.
      //
      // The fallback is only safe while it is UNAMBIGUOUS. The desktop
      // app announces exactly the same five capabilities as the daemon,
      // so with both connected there is no signal here that tells them
      // apart — and sending `/approve ap-1234` to the desktop app gets
      // back "no pending approval matching ap-1234", which a person
      // cannot distinguish from the daemon genuinely refusing. A false
      // refusal on the consent vocabulary is worse than an undelivered
      // one, so more than one legacy candidate is refused rather than
      // guessed between.
      //
      // REMOVE the fallback once the halt-capable CLI is the published
      // minimum — tracked with the arc, not left to rot here.
      const legacy = peers.filter((p) => p.capabilities?.includes("background") === true);
      candidates = legacy.length === 1 ? legacy : [];
      emptyReason =
        legacy.length > 1
          ? "More than one connected surface could answer and none announces unattended_runtime, so the relay cannot tell the daemon from a desktop app — update the daemon (npm i -g motebit@latest) and reconnect"
          : "No unattended runtime is connected";
    }

    if (candidates.length === 0) {
      clearTimeout(timer);
      pendingCommands.delete(commandId);
      // 404, not 500: "nothing was delivered" is the honest reading a
      // consent surface must be able to show, and clients distinguish
      // not-connected from server fault by status.
      reject(
        new HTTPException(404, {
          message: !UNATTENDED_RUNTIME_COMMANDS.has(command)
            ? emptyReason
            : MUTATING_UNATTENDED_COMMANDS.has(command)
              ? // Only a verb that could have CHANGED something gets the
                // reassurance that nothing was changed. Saying "nothing
                // was stopped or decided" about a read-only question
                // answers something nobody asked, and implies an attempt
                // that was never made.
                `${emptyReason} — nothing was delivered, so nothing was stopped or decided`
              : `${emptyReason} — nothing was delivered, so this is not a report that nothing happened`,
        }),
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
      // 404, like the no-candidate path above, and for the same reason.
      // Every send throwing means the socket is dead but not yet reaped
      // — the ordinary case moments after a daemon dies — so nothing
      // was delivered. A plain Error falls through to a 500, and both
      // clients special-case only 401/404/503/504, so the phone showed
      // a bare "500:" for a halt that demonstrably did not land: the
      // relay looking broken instead of the command looking undelivered.
      reject(
        new HTTPException(404, {
          // Split like its sibling above: only a verb that could have
          // CHANGED something gets told nothing was changed. The other
          // branch was corrected for this and this one was left saying
          // it, which answers a question a reader never asked.
          message: !UNATTENDED_RUNTIME_COMMANDS.has(command)
            ? "No reachable device"
            : MUTATING_UNATTENDED_COMMANDS.has(command)
              ? "The runtime's connection is gone — nothing was delivered, so nothing was stopped or decided"
              : "The runtime's connection is gone — nothing was delivered, so this is not a report that nothing happened",
        }),
      );
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
