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

/** The subset of the above that can CHANGE something. See the 404 copy. */
const MUTATING_UNATTENDED_COMMANDS = new Set(["halt", "resume", "approvals"]);

/**
 * The subset whose answer is a per-machine DATABASE, not a per-motebit
 * fact — so which runtime answers changes what the answer is.
 *
 * A halt or a resume is the same act wherever it lands. An approval
 * queue and a run ledger are local records: a laptop's ledger answered
 * from a VPS is a different, and wrong, answer. Keyed by that property
 * rather than by "is unattended", which is why adding `runs` to the set
 * above without this said "each with its own approval queue" about a
 * question with no queue in it.
 *
 * `halt-status` reads a local store too and is NOT here, because it is
 * not refused: it is ASKED OF EVERY MACHINE and the answers composed —
 * see `COMPOSED_ACROSS_MACHINES`. Refusing it would leave a sovereign
 * away from both machines unable to see what is stopped, which is the
 * one question the verb exists for. `approvals` and `runs` stay refused
 * until someone needs them composed; that is a decision per verb, not a
 * property of the machinery.
 */
const PER_MACHINE_DATABASE_COMMANDS = new Set(["approvals", "runs"]);

/**
 * Verbs the relay REFUSES rather than deliver to one machine of several.
 *
 * A halt is written to the halt store of the machine that receives it,
 * and that store is local — nothing replicates it. So first-wins
 * delivery to a sovereign with a daemon on a laptop and a worker on a
 * VPS stops one of them and answers with that one's acknowledgement,
 * which reads as "stopped" for a motebit that is still working. That is
 * the worst thing this vocabulary can do, so it is refused instead:
 * saying "I cannot do this from here" is survivable, saying "stopped"
 * about a motebit that is running is not.
 *
 * REACHING every machine is the right answer and is NOT what this is.
 * It was built (issue #681) and withdrawn after five review rounds: a
 * broadcast has to gather answers instead of racing them, name the
 * machines that stayed silent, decline to synthesize a verdict the
 * relay is not the authority on, and carry a status that a partial
 * result cannot be mistaken for success — and each round found another
 * face of that I had not seen. The whole story also needs `halt-status`
 * composed (#687), or a sovereign can stop their motebit and not see
 * what stopped.
 *
 * It costs nothing today: no motebit has unattended runtimes on two
 * machines until the installer ships (#685). That is exactly why the
 * refusal is affordable and why the broadcast is worth building whole,
 * once, against the multi-runtime harness rather than under review
 * pressure.
 */
const REFUSE_ON_MANY_MACHINES = new Set(["halt", "resume"]);

/**
 * Reads asked of EVERY machine, with the answers composed rather than
 * raced.
 *
 * `halt-status` is the command whose job is answering "did my motebit
 * stop", and the halt store it reads is per machine. Delivered
 * first-wins it answered from whichever machine the relay picked, so
 * "Running — nothing is halted" could be said about a motebit whose
 * other machine was stopped, or a stop reported for a motebit still
 * working elsewhere (issue #687).
 *
 * A read goes first on purpose. Asking twice is harmless and a local
 * query answers in milliseconds, so the machinery a many-machine HALT
 * needs (#681) — one delivery per machine, attributed answers, a status
 * a partial cannot wear — is proven here on a verb that cannot hurt
 * anyone, and the act then reuses it. Built the other way round, that
 * machinery's failure modes were discovered with a halt in flight.
 */
const COMPOSED_ACROSS_MACHINES = new Set(["halt-status"]);

/**
 * The capability a command's answer actually depends on.
 *
 * `runs` needs the RECORD, not the ability to act. `motebit serve`
 * announces `unattended_runtime` truthfully — it runs unattended work
 * and can be stopped — but the work it runs is relay-dispatched tasks,
 * not goal runs, so on its own machine its database holds no run rows
 * and it answered "No runs recorded yet" about a motebit that had
 * worked all night. The many-machine refusal only catches that when
 * every peer declared a device id; routing by the record catches it
 * always.
 */
function requiredCapability(command: string): string {
  return command === "runs" ? "run_ledger" : "unattended_runtime";
}

/**
 * What is missing, named as the thing the question needed — and how to
 * fix it when the cause is a version skew rather than an absence.
 *
 * The relay auto-deploys on merge and installed CLIs update on their
 * own schedule, so for a while every connected daemon runs unattended
 * work and announces no `run_ledger`. `runs` gets no legacy fallback on
 * purpose — guessing a peer for a question whose answer IS that peer's
 * database is the false empty this routing exists to stop — but a 404
 * that names neither the cause nor the remedy leaves a person staring
 * at a healthy daemon.
 */
function noPeerReason(command: string): string {
  return command === "runs"
    ? "No runtime that keeps a run ledger is connected — a daemon older than this feature runs unattended work but does not announce one, so update it (npm i -g motebit@latest) and reconnect"
    : "No unattended runtime is connected";
}

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
  "runs",
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

/**
 * What became of the question on ONE machine. Transport facts only —
 * nothing here is a statement about the interior.
 *
 * - `answered`  — the machine replied and its reply carries a record.
 * - `no_record` — the machine replied WITHOUT one: it refused the frame
 *   (a replayed envelope, a key it could not verify against) or has no
 *   store to read. An answer on the wire and a report of nothing, so it
 *   cannot count toward a complete picture.
 * - `silent`    — delivered, and nothing came back before the deadline.
 * - `unreached` — no socket on that machine was open; nothing was sent.
 */
type MachineOutcome = "answered" | "no_record" | "silent" | "unreached";

interface MachineLine {
  deviceId: string;
  outcome: MachineOutcome;
  /** The machine's own reply, verbatim. Present iff it replied. */
  result?: unknown;
}

/**
 * A composed reply and whether it is the whole picture.
 *
 * A class, not a field sniffed off the body: a first-wins reply is the
 * runtime's own JSON passed through untouched, so anything keyed on the
 * body's shape could be worn by a single machine's answer.
 */
class ComposedReply {
  constructor(
    readonly body: CommandResult,
    readonly partial: boolean,
  ) {}
}

/** Pending command requests waiting for WebSocket response. */
const pendingCommands = new Map<
  string,
  | { kind: "first"; resolve: (result: unknown) => void; timer: ReturnType<typeof setTimeout> }
  | {
      kind: "composed";
      resolve: (result: ComposedReply) => void;
      timer: ReturnType<typeof setTimeout>;
      /**
       * One line per MACHINE the question was aimed at, keyed by device
       * id. Keyed, not pushed to: counting answers rather than machines
       * let a runtime replying twice satisfy a quorum and close the
       * request before the other machine had been heard from.
       */
      machines: Map<string, MachineLine>;
    }
>();

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/**
 * The one deadline. A composed request has no second, shorter "grace"
 * after the first answer: the relay cannot compute how long a machine's
 * interior takes, two guesses at it were both wrong (#681), and nothing
 * would bind the relay's constant to the runtime's. So it waits for
 * every machine it reached and composes at the request's own deadline.
 * Overridable only through relay config, which production never sets.
 */
let commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;

export interface CommandRouteDeps {
  app: Hono;
  db: DatabaseDriver;
  connections: Map<string, ConnectedDevice[]>;
  logger: ReturnType<typeof createLogger>;
  /** Test seam; production uses the default. */
  commandTimeoutMs?: number;
}

export function registerCommandRoutes(deps: CommandRouteDeps): void {
  const { app, db, connections } = deps;
  // Module-scoped because the deadline belongs to the forwarding
  // helpers, which the route closes over. One relay per process, so a
  // single value is honest; the override exists for tests alone.
  commandTimeoutMs = deps.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

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
        if (result instanceof ComposedReply) {
          // A PARTIAL picture is not a success, and must not be a 2xx.
          // Honest prose at HTTP 200 still lets
          // `motebit halt-status --remote && <next step>` proceed on
          // half an answer, and leaves every other consumer to remember
          // to compare counts. Fail closed at the transport: a caller
          // that forgets gets an error, and the body still carries the
          // per-machine truth, so nothing is lost by the status.
          return result.partial ? c.json(result.body, 504) : c.json(result.body);
        }
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
 *
 * `from` is the device id of the CONNECTION the answer arrived on —
 * supplied by the socket handler, never read out of the answer. A
 * machine cannot name itself into another machine's line.
 */
export function handleCommandResponse(commandId: string, result: unknown, from?: string): void {
  const pending = pendingCommands.get(commandId);
  if (!pending) return;
  if (pending.kind === "first") {
    clearTimeout(pending.timer);
    pendingCommands.delete(commandId);
    pending.resolve(result);
    return;
  }

  // An answer counts once, and only from a machine this question was
  // delivered to and has not yet heard from. A stranger's answer is not
  // evidence about this request at all; a repeat must not overwrite the
  // first, or the last writer would get to say what a machine reported.
  const line = from != null ? pending.machines.get(from) : undefined;
  if (line == null || line.outcome !== "silent") return;
  line.outcome = carriesRecord(result) ? "answered" : "no_record";
  line.result = result;

  const stillWaiting = [...pending.machines.values()].some((m) => m.outcome === "silent");
  if (!stillWaiting) settleComposed(commandId);
}

/**
 * Did the machine report, or only reply?
 *
 * Every command in the composed set answers with structured `data` —
 * that IS its record — while a refusal from the frame handler (replay,
 * no key, bad envelope) and a surface with no store answer with prose
 * alone. Reading for `data` is a fact about the reply's shape, not a
 * judgement about the interior: the relay still never opens it.
 */
function carriesRecord(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const data = (result as { data?: unknown }).data;
  return typeof data === "object" && data !== null;
}

function settleComposed(commandId: string): void {
  const pending = pendingCommands.get(commandId);
  if (pending == null || pending.kind !== "composed") return;
  clearTimeout(pending.timer);
  pendingCommands.delete(commandId);
  pending.resolve(composeMachines([...pending.machines.values()]));
}

/**
 * One answer from several machines, without pretending it was one.
 *
 * Every machine the question was aimed at gets a line and is NAMED,
 * because "1 runtime did not answer" tells a sovereign with a laptop
 * and a VPS the one thing they cannot act on: something may still be
 * running and they do not know where.
 *
 * The relay does NOT add the answers up. It knows what it sent and what
 * came back; it does not know what a goal is or which machine owns one,
 * and an earlier attempt to AND a field across machines was false about
 * two ordinary cases (#681). It sells coordination precisely because it
 * is not the authority on the interior. So the body carries transport
 * facts, and each machine's own reply verbatim beside its id — and the
 * only verdict here is about the PICTURE: whether it is whole.
 */
function composeMachines(machines: MachineLine[]): ComposedReply {
  const lines: string[] = [];
  const details: string[] = [];
  for (const m of machines) {
    if (m.outcome === "unreached") {
      lines.push(`${m.deviceId}: not reached — its connection was already gone`);
      continue;
    }
    if (m.outcome === "silent") {
      lines.push(
        `${m.deviceId}: no answer in time — what is halted there is unknown, and silence is neither a stop nor a run`,
      );
      continue;
    }
    const reply = m.result as { summary?: unknown; detail?: unknown } | null;
    const summary =
      typeof reply?.summary === "string" && reply.summary !== ""
        ? reply.summary
        : "answered in a shape this relay could not read";
    lines.push(
      m.outcome === "no_record"
        ? `${m.deviceId}: did not report — ${summary}`
        : `${m.deviceId}: ${summary}`,
    );
    if (typeof reply?.detail === "string" && reply.detail !== "") {
      details.push(`${m.deviceId}:\n${reply.detail}`);
    }
  }

  const asked = machines.length;
  const answered = machines.filter((m) => m.outcome === "answered").length;
  const partial = answered < asked;
  return new ComposedReply(
    {
      summary: partial
        ? `Asked ${asked} machines; ${answered} reported. This is NOT the whole picture — the rest are named below.`
        : `Asked ${asked} machines; all ${asked} reported. Each machine's own answer is below — the relay does not add them up.`,
      detail: [lines.join("\n"), ...details].join("\n\n"),
      data: {
        // The marker a surface reads a non-2xx body by. See
        // `readComposedCommandResult` in `@motebit/runtime`.
        composed: true,
        // One field, so no consumer has to compare counts to learn it.
        partial,
        asked,
        answered,
        machines: machines.map((m) => ({
          device_id: m.deviceId,
          outcome: m.outcome,
          ...(m.result !== undefined ? { result: m.result } : {}),
        })),
      },
    },
    partial,
  );
}

/**
 * The machines a composed question goes to, or `null` when this request
 * is not one.
 *
 * Only when there is more than one machine, and only when every
 * unattended peer DECLARED its device id. One machine keeps the
 * runtime's own reply, untouched — every deployment that exists today.
 * And an undeclared id is one the relay invented per connection, so
 * grouping by it would read one host's two processes as two machines,
 * deliver the single-use envelope to both, and publish the second's
 * replay refusal as a machine that did not report. Unknown falls back
 * to delivering first-wins, as it does for every other verb here.
 */
function machinesToAsk(
  peers: ConnectedDevice[],
  command: string,
): Map<string, ConnectedDevice[]> | null {
  if (!COMPOSED_ACROSS_MACHINES.has(command)) return null;
  const needed = requiredCapability(command);
  const unattended = peers.filter((p) => p.capabilities?.includes(needed) === true);
  if (unattended.some((p) => p.deviceIdDeclared !== true)) return null;
  const byMachine = new Map<string, ConnectedDevice[]>();
  for (const p of unattended) {
    byMachine.set(p.deviceId, [...(byMachine.get(p.deviceId) ?? []), p]);
  }
  return byMachine.size > 1 ? byMachine : null;
}

/**
 * Send to the first OPEN socket of a group. See the note on closed
 * sockets in `forwardCommandToAgent`: a closed one swallows the frame
 * without throwing, so it has to be asked.
 */
function sendToOne(group: ConnectedDevice[], payload: string): boolean {
  return group.some((peer) => {
    if (peer.ws.readyState !== 1) return false;
    try {
      peer.ws.send(payload);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Ask every machine once, and compose what comes back.
 *
 * ONE delivery per machine, not per connection: `motebit run` and
 * `motebit serve` on a host share a device id, a database and a replay
 * guard, and the envelope is single-use — a second frame to the same
 * machine is refused as a replay by its own motebit.
 */
function askEveryMachine(
  byMachine: Map<string, ConnectedDevice[]>,
  commandId: string,
  payload: string,
): Promise<ComposedReply> {
  return new Promise((resolve, reject) => {
    const machines = new Map<string, MachineLine>();
    // Registered BEFORE anything is sent: a machine may answer inside
    // `send`, and an answer that finds no pending request is dropped.
    const timer = setTimeout(() => settleComposed(commandId), commandTimeoutMs);
    pendingCommands.set(commandId, { kind: "composed", resolve, timer, machines });
    // Every line exists, and is WAITING, before the first send — for the
    // same reason. A machine answering inside `send` must find the
    // others still owed an answer, or it would settle a request whose
    // other machines had not been asked yet.
    for (const deviceId of byMachine.keys()) {
      machines.set(deviceId, { deviceId, outcome: "silent" });
    }
    for (const [deviceId, group] of byMachine) {
      const line = machines.get(deviceId);
      if (line != null && !sendToOne(group, payload)) line.outcome = "unreached";
    }

    const lines = [...machines.values()];
    if (lines.every((m) => m.outcome === "unreached")) {
      clearTimeout(timer);
      pendingCommands.delete(commandId);
      // 404, like the single-machine path: nothing was delivered, and a
      // composed 504 would say "asked" about machines never reached.
      reject(
        new HTTPException(404, {
          message: `No connection to any of this motebit's ${lines.length} machines is open (${lines.map((m) => m.deviceId).join(", ")}) — nothing was delivered, so this is not a report that nothing happened`,
        }),
      );
      return;
    }
    // Everything reachable may already have answered, inside `send`.
    if (pendingCommands.has(commandId) && !lines.some((m) => m.outcome === "silent")) {
      settleComposed(commandId);
    }
  });
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

  const byMachine = machinesToAsk(peers, command);
  if (byMachine != null) return askEveryMachine(byMachine, commandId, payload);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(commandId);
      reject(new Error("Command timed out"));
    }, commandTimeoutMs);

    pendingCommands.set(commandId, { kind: "first", resolve, timer });

    // For most commands any connected surface can answer. For the
    // unattended-runtime set, only a peer that actually runs unattended
    // work can — see UNATTENDED_RUNTIME_COMMANDS.
    const needed = requiredCapability(command);
    const unattended = peers.filter((p) => p.capabilities?.includes(needed) === true);
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
      // ...and the refusal belongs to the commands whose answer IS a
      // per-machine record, because the reasoning above is about local
      // databases, not about being unattended.
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
      const perMachineRecord = PER_MACHINE_DATABASE_COMMANDS.has(command);
      const wouldStopOne = REFUSE_ON_MANY_MACHINES.has(command);
      const manyMachines = (perMachineRecord || wouldStopOne) && allDeclared && devices.size > 1;
      candidates = manyMachines ? [] : unattended;
      emptyReason = !manyMachines
        ? noPeerReason(command)
        : wouldStopOne
          ? // Different sentence from the records one: nothing here is
            // about which database answers. Delivering to one machine
            // would STOP one and leave the other working, under the
            // stopped one's acknowledgement — a record that says the
            // motebit stopped while it is still running.
            `This motebit has unattended runtimes on ${devices.size} different machines, and a halt is written where it lands — delivering to one would stop that machine and answer as though the motebit had stopped, while the other kept working. Run this on each machine, or stop the runtime you do not want. Reaching every machine at once is tracked in issue #681`
          : `This motebit has unattended runtimes on ${devices.size} different machines, each with its own records, so the relay cannot choose one — run this command on the machine you mean, or stop the runtime you do not`;
    } else if (command !== "approvals") {
      // Everything but `approvals` gets no fallback: a daemon too old to
      // announce the capability is too old to honor a halt or to hold a
      // run ledger, and "not delivered" is the truth there.
      candidates = [];
      emptyReason = noPeerReason(command);
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

    // A CLOSED socket does not throw — it swallows.
    //
    // `ws@8` only throws from `send` while CONNECTING; on CLOSING or
    // CLOSED it calls `sendAfterClose` and returns silently, with no
    // callback to surface an error. So a try/catch counted a stale
    // connection as a delivery, `some` short-circuited, the live
    // process beside it on the same machine was never tried, and the
    // halt was lost — the caller learning nothing until a 30-second
    // timeout answered "the agent did not respond", about a runtime
    // that was connected and willing the whole time. That is the
    // ordinary case moments after a process restarts, and it is the
    // worst possible verb to lose.
    //
    // Every other send site in this relay already asks. The catch stays
    // for the CONNECTING case, which does throw.
    const sent = candidates.some((peer) => {
      if (peer.ws.readyState !== 1) return false;
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
          // Split like its sibling above.
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
