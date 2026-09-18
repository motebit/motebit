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
 * Verbs the relay delivers to EVERY machine, not the first that answers.
 *
 * A halt is written to the halt store of the machine that receives it,
 * and that store is local — nothing replicates it. So first-wins
 * delivery to a sovereign with a daemon on a laptop and a worker on a
 * VPS stopped one of them and answered with that one's acknowledgement,
 * which reads as "stopped" for a motebit that is still working. The act
 * is idempotent and machine-local, so the delivery that matches what
 * the person asked for is to all of them.
 *
 * `approvals` is mutating too and is deliberately NOT here: deciding an
 * approval twice, once per queue, is not one act repeated — it is two
 * decisions on two records, which is why that command refuses a
 * many-machine motebit instead.
 */
const BROADCAST_UNATTENDED_COMMANDS = new Set(["halt", "resume"]);

/**
 * The one bucket every peer that declared no device id falls into.
 *
 * The relay invents an id per connection for those, so treating each as
 * its own machine would broadcast twice into what is far more often one
 * host's two processes — and those two share a replay store, so the
 * second would reject its own motebit's halt as a replay.
 */
const UNDECLARED_MACHINE = "__undeclared__";

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
 * `halt-status` reads a local store too and is deliberately NOT here.
 * It would be the same reasoning, and it is the wrong PR for it: on a
 * two-machine motebit `halt` still delivers to one of them, so refusing
 * the status leaves a phone able to stop the motebit and unable to see
 * what stopped — strictly worse than the false negative it replaces,
 * and a change to an already-shipped verb from an increment that only
 * adds a read. The multi-machine story is one problem, delivery and
 * status together, and it belongs to issue #681 behind the harness.
 * This set gains exactly one member here: `runs`, this increment's own.
 */
const PER_MACHINE_DATABASE_COMMANDS = new Set(["approvals", "runs"]);

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

/** Pending command requests waiting for WebSocket response. */
const pendingCommands = new Map<
  string,
  {
    resolve: (result: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
    /**
     * The machines this request was AIMED at. Empty for first-wins,
     * where exactly one peer was ever addressed.
     */
    targets: string[];
    /** Aimed at, but no socket on that machine was open. */
    unreached: string[];
    /**
     * How many connections beyond the first declared no device id and
     * were therefore folded into one delivery. They MIGHT be separate
     * hosts, so a fold makes `acknowledged` unprovable.
     */
    collapsedUndeclared: number;
    /** Shorthand for `collapsedUndeclared > 0`, read on every answer. */
    wasFolded: boolean;
    /** Answers received so far, in arrival order. */
    answers: Array<{ from: string; result: unknown }>;
    /** Armed on the first answer, to bound the wait for the rest. */
  }
>();

/**
 * A broadcast has ONE deadline, and it is the one the request already
 * had: `COMMAND_TIMEOUT_MS`.
 *
 * There was a grace window here — wait N seconds after the first answer,
 * then call the rest silent — and it was wrong twice. At 3s it armed on
 * the machine with nothing to stop and reported the machine actually
 * aborting work as silent. At 12s it was still under-measured, because
 * `honorHalts()` awaits a nested loop over pending halts × registered
 * stoppers, each under its own 10s ceiling, so a machine returning from
 * a restart with two un-acknowledged halts answers at ~20s. Nothing
 * bound the relay's constant to the runtime's, so any change to either
 * silently re-opened the gap.
 *
 * The lesson is not "measure it better". The relay CANNOT compute this
 * bound: it depends on interior work the relay has no view of, by
 * design. So it stops guessing. It waits for every machine it reached,
 * and when the request's own deadline arrives it COMPOSES what it has —
 * naming who answered and who did not — instead of rejecting. Timing
 * out with answers in hand was its own defect: the CLI renders a 504 as
 * "Delivered, no answer yet", asserting delivery about machines the
 * relay knew it never reached.
 *
 * Cost: a broadcast with a wedged machine takes the full timeout rather
 * than the grace. The common case — every machine answers — still
 * resolves as soon as the slowest one does.
 */

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
export function handleCommandResponse(commandId: string, result: unknown, from?: string): void {
  const pending = pendingCommands.get(commandId);
  if (!pending) return;
  // An answer with no machine id came from a peer that declared none,
  // which is exactly the bucket a broadcast aims its one undeclared
  // delivery at — so it is attributable after all, to that bucket.
  pending.answers.push({ from: from ?? UNDECLARED_MACHINE, result });

  // First-wins addressed one peer, nothing was left unreached, and no
  // undeclared connections were folded: one answer settles it.
  //
  // The fold has to be in this condition. Two undeclared peers collapse
  // to ONE bucket, so a broadcast to them looked like a single target
  // and took this path — handing back that one machine's raw
  // `acknowledged: true` while a possible second host was never
  // reached, which is the very claim the fold makes unprovable.
  if (pending.targets.length <= 1 && pending.unreached.length === 0 && !pending.wasFolded) {
    finishCommand(commandId);
    return;
  }
  // A broadcast is NOT a race — gather every machine's answer. There is
  // no grace window: the relay cannot compute one, so it waits for the
  // machines it reached and composes at the request's own deadline. See
  // the note on the single deadline above.
  // Count MACHINES, not answers. A runtime replying twice, or a host
  // whose second process landed in the undeclared bucket, satisfied a
  // quorum counted on the raw array — closing the request before a real
  // target had been heard from. An answer from a machine this request
  // never aimed at is not evidence about this request at all.
  settleIfAllHeard(commandId);
}

/**
 * Settle once every machine the request actually REACHED has been heard
 * from. Counts machines, not answers: a runtime replying twice, or a
 * host whose second process landed in the undeclared bucket, satisfied
 * a quorum counted on the raw array and closed the request before a
 * real target had answered. An answer from a machine this request never
 * aimed at is not evidence about this request at all.
 */
function settleIfAllHeard(commandId: string): void {
  const pending = pendingCommands.get(commandId);
  if (pending == null) return;
  const reached = pending.targets.filter((t) => !pending.unreached.includes(t));
  const heardFrom = new Set(pending.answers.map((a) => a.from).filter((f) => reached.includes(f)));
  if (heardFrom.size >= reached.length) finishCommand(commandId);
}

function finishCommand(commandId: string): void {
  const pending = pendingCommands.get(commandId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingCommands.delete(commandId);
  pending.resolve(
    pending.targets.length <= 1 && pending.unreached.length === 0 && !pending.wasFolded
      ? pending.answers[0]?.result
      : composeAnswers(pending),
  );
}

/** A `{ summary, detail? }` reply, as far as this needs to read it. */
function asReply(value: unknown): { summary: string; detail?: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as { summary?: unknown; detail?: unknown };
  if (typeof r.summary !== "string") return null;
  return { summary: r.summary, ...(typeof r.detail === "string" ? { detail: r.detail } : {}) };
}

/** How a machine is named to the person reading the answer. */
function machineLabel(id: string): string {
  return id === UNDECLARED_MACHINE ? "an unidentified runtime" : id;
}

/**
 * One answer from several machines, without pretending it was one.
 *
 * Every machine the request was aimed at gets a line — answered,
 * unreachable, or silent — and each is NAMED, because "1 runtime did
 * not answer" tells a sovereign with a laptop and a VPS the one thing
 * they cannot act on: something is still running and they do not know
 * where. An answer this cannot parse is shown as that machine's answer
 * rather than replacing the report.
 */
function composeAnswers(pending: {
  targets: string[];
  unreached: string[];
  collapsedUndeclared: number;
  wasFolded?: boolean;
  answers: Array<{ from: string; result: unknown }>;
}): unknown {
  const { targets, unreached, collapsedUndeclared, answers } = pending;
  const lines: string[] = [];
  const details: string[] = [];
  const answered = new Set(answers.map((a) => a.from));

  for (const a of answers) {
    const who = machineLabel(a.from);
    const reply = asReply(a.result);
    if (reply == null) {
      lines.push(`  ${who}: answered in a shape this relay could not read`);
      continue;
    }
    lines.push(`  ${who}: ${reply.summary}`);
    if (reply.detail != null && reply.detail !== "") details.push(`${who}:\n${reply.detail}`);
  }

  // Unreachable and silent are different facts and both are the
  // reader's business: an unanswered halt is the one case that must not
  // be taken for a stop.
  for (const t of targets) {
    if (unreached.includes(t)) {
      lines.push(`  ${machineLabel(t)}: not reached — its connection was already gone`);
      continue;
    }
    if (answered.has(t)) continue;
    lines.push(
      `  ${machineLabel(t)}: no answer in time — what it did is unknown, and silence is not a stop`,
    );
  }
  if (collapsedUndeclared > 0) {
    lines.push(
      `  ${collapsedUndeclared} further connection(s) declared no machine id and were folded into the one above — if any is a different host, it was not reached`,
    );
  }

  // The relay does NOT synthesize a verdict about the interior.
  //
  // An earlier version AND-ed `data.acknowledged` across machines and
  // called that "stricter". It was not stricter, it was a category
  // error, and two normal paths proved it. `cmdResume` never emits
  // `acknowledged` at all — it reports `lifted` — so every successful
  // multi-machine resume published `acknowledged: false`. And a
  // goal-scoped halt can only be honoured by the one machine that owns
  // the goal; the others truthfully answer they have nothing to stop,
  // so the conjunction was false about a goal that WAS stopped.
  //
  // The relay knows what it sent and what came back. It does not know
  // what a goal is, which machine owns one, or what `resume` means —
  // and it sells coordination precisely because it is not the authority
  // on the interior. So the composed payload carries TRANSPORT facts,
  // and each machine's own `data` verbatim beside its id. A consumer
  // asking "did my motebit stop" reads those, or asks `halt-status`,
  // which is the command whose job that is.
  //
  // A composed reply therefore has no `acknowledged` key: absent is the
  // fail-closed reading, and the single-machine path still passes the
  // runtime's own reply through untouched, so the documented contract
  // holds where it can be held.

  // A halt id is written per machine, so there is no single one to lift.
  const haltIds = answers
    .map((a) => (a.result as { data?: { halt_id?: unknown } } | null)?.data?.halt_id)
    .filter((h): h is string => typeof h === "string");
  const note =
    haltIds.length > 1
      ? "\n\nEach machine wrote its own halt, so the ids above are machine-local — `resume all` lifts them everywhere; `resume <id>` reaches only the machine that wrote it."
      : "";

  const reachedCount = targets.length - unreached.length;
  const heardCount = new Set(answers.map((a) => a.from)).size;

  return {
    // The summary counts machines REACHED, not machines that exist.
    // "Sent to 2 runtimes" above a detail line reading "dev-1: not
    // reached" is a first sentence contradicting the report it
    // introduces, and the CLI prints the summary first.
    summary:
      unreached.length > 0
        ? `Reached ${reachedCount} of ${targets.length} machines; ${heardCount} answered.`
        : `Sent to ${targets.length} ${targets.length === 1 ? "machine" : "machines"}; ${heardCount} answered.`,
    detail: [lines.join("\n"), ...details].join("\n\n") + note,
    data: {
      sent_to: targets.length,
      reached: reachedCount,
      answered: heardCount,
      // Rendered, not raw: `__undeclared__` is this relay's internal
      // bucket key, and a consumer reading the structured field should
      // see what the prose beside it says.
      unreached: unreached.map(machineLabel),
      // Each machine's own answer, verbatim and attributed. The verdict
      // about the interior lives here, per machine, where the runtime
      // put it — never re-derived by the relay.
      answers: answers.map((a) => ({ from: a.from, result: a.result })),
    },
  };
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
      // A broadcast with targets is not a timeout — it is a partial
      // report, and the composed form already names which machines were
      // silent. Rejecting threw those answers away and let the CLI print
      // "Delivered, no answer yet" about a machine never reached.
      const held = pendingCommands.get(commandId);
      // Compose only what there is something to compose. NOTHING heard
      // is a timeout, and must stay one.
      //
      // Routing every expired broadcast here resolved a single-machine
      // request — every deployment that exists today — with
      // `answers[0]` of an empty array: `undefined`, serialized as a
      // 200 with an empty body. The CLI's carefully written 504 branch
      // ("Delivered, no answer yet — it may well have stopped") was
      // replaced by a JSON parse error, and the phone by "The runtime
      // did not recognise \"halt\" — update it": a confident wrong
      // diagnosis on the one verb this arc exists to protect. The same
      // applies to a multi-machine request where every machine stayed
      // silent — an honest prose report at HTTP 200 still tells a
      // script that the halt succeeded.
      if (held != null && held.answers.length > 0) {
        finishCommand(commandId);
        return;
      }
      pendingCommands.delete(commandId);
      reject(new Error("Command timed out"));
    }, COMMAND_TIMEOUT_MS);

    pendingCommands.set(commandId, {
      resolve,
      timer,
      targets: [],
      unreached: [],
      collapsedUndeclared: 0,
      wasFolded: false,
      answers: [],
    });

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
      const manyMachines =
        PER_MACHINE_DATABASE_COMMANDS.has(command) && allDeclared && devices.size > 1;
      candidates = manyMachines ? [] : unattended;
      emptyReason = manyMachines
        ? `This motebit has unattended runtimes on ${devices.size} different machines, each with its own records, so the relay cannot choose one — run this command on the machine you mean, or stop the runtime you do not`
        : noPeerReason(command);
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

    // Broadcast reaches every MACHINE; first-wins reaches one peer.
    //
    // Per machine, not per connection: `motebit run` and `motebit serve`
    // on one host are two peers sharing a device id, a database and one
    // replay guard, and the envelope carries a single signature — so a
    // second frame to the same host is rejected as a replay by its own
    // motebit. Within a machine, every connection is a candidate for
    // that machine's one delivery, because which of its sockets is
    // alive is a different question from how many deliveries it should
    // get.
    const broadcast = BROADCAST_UNATTENDED_COMMANDS.has(command);
    if (broadcast) {
      const byMachine = new Map<string, ConnectedDevice[]>();
      for (const peer of candidates) {
        const key = peer.deviceIdDeclared === true ? peer.deviceId : UNDECLARED_MACHINE;
        const bucket = byMachine.get(key);
        if (bucket == null) byMachine.set(key, [peer]);
        else bucket.push(peer);
      }

      // Every machine the command was AIMED at is a target, including
      // one whose only socket turns out to be shut.
      //
      // Counting only successful sends made an unreachable machine
      // vanish: with a laptop whose connection was closed-but-unreaped
      // and a live VPS, `targets` held one machine, the composed path
      // was skipped, and the caller got the VPS's raw `acknowledged:
      // true` with no sign that a second machine existed and was never
      // reached. That is one machine's acknowledgement standing in for
      // the motebit's — the defect this change exists to close, coming
      // back through the accounting.
      //
      // And the list is complete BEFORE the first send, assigned rather
      // than derived afterwards, so an answer arriving during the loop
      // cannot read it as empty and settle first-wins. The previous
      // version held only because every reply path crosses an `await`,
      // which is a property of today's transport and not an invariant.
      const pending = pendingCommands.get(commandId);
      const aimedAt = [...byMachine.keys()];
      if (pending != null) {
        pending.targets = aimedAt;
        // Two undeclared connections might be two hosts. They are folded
        // into one delivery because they might equally be one host's two
        // processes sharing a replay store, and delivering twice into
        // that store is the worse error — but the fold makes
        // `acknowledged` unprovable, so it is recorded and reported.
        pending.collapsedUndeclared = Math.max(
          0,
          (byMachine.get(UNDECLARED_MACHINE)?.length ?? 0) - 1,
        );
        pending.wasFolded = pending.collapsedUndeclared > 0;
      }

      const unreached: string[] = [];
      for (const [key, machinePeers] of byMachine) {
        const ok = machinePeers.some((peer) => {
          if (peer.ws.readyState !== 1) return false;
          try {
            peer.ws.send(payload);
            return true;
          } catch {
            return false;
          }
        });
        if (!ok) unreached.push(key);
      }
      if (pending != null) {
        pending.unreached = unreached;
        // `targets` is complete before the first send; `unreached` can
        // only be known after it. So the quorum is re-evaluated here:
        // an answer that arrived DURING the loop computed `reached`
        // against an empty `unreached`, missed the threshold, and
        // nothing re-checked — leaving the request to stall for the
        // whole timeout instead of composing at once. No transport does
        // that today; the invariant should not depend on it.
        if (pending.answers.length > 0) settleIfAllHeard(commandId);
      }
      if (unreached.length === aimedAt.length) {
        clearTimeout(timer);
        pendingCommands.delete(commandId);
        reject(
          new HTTPException(404, {
            message:
              "The runtime's connection is gone — nothing was delivered, so nothing was stopped or decided",
          }),
        );
      }
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
