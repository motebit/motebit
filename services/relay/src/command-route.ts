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
 * The subset of `UNATTENDED_RUNTIME_COMMANDS` that can change
 * something. See the 404 copy.
 */
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

/**
 * Verbs the relay delivers to EVERY unattended runtime, not the first
 * that answers.
 *
 * A halt is written to the halt store of the machine that receives it,
 * and that store is local — nothing replicates it. So first-wins
 * delivery to a sovereign with a daemon on a laptop and a worker on a
 * VPS stopped one of them and answered with that one's acknowledgement,
 * which reads as "stopped" for a motebit that is still working. The
 * act is idempotent and machine-local, so the delivery that matches
 * what the person asked for is to all of them.
 *
 * `approvals` is mutating too and is deliberately NOT here: deciding an
 * approval twice, once per queue, is not the same act repeated — it is
 * two different decisions on two different records, which is why that
 * command refuses a many-machine motebit instead.
 *
 * `halt-status` is here for the read half of the same reason. It reads
 * this machine's halt store, so one machine's answer is one machine's
 * answer — but unlike a queue, the two compose: showing what each
 * runtime has stopped IS the complete picture, so gathering both beats
 * refusing the question. Refusing it left the person who had just
 * halted a two-machine motebit with no way to see what had stopped.
 */
const BROADCAST_UNATTENDED_COMMANDS = new Set(["halt", "resume", "halt-status"]);

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

/** What is missing, named as the thing the question needed. */
function noPeerReason(command: string): string {
  return command === "runs"
    ? "No runtime that keeps a run ledger is connected"
    : "No unattended runtime is connected";
}

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
  {
    resolve: (result: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
    /**
     * Whether this request was aimed at every machine. Only a broadcast
     * reports per-machine; first-wins reached exactly one runtime and
     * says so by handing that runtime's answer back unchanged.
     */
    broadcast: boolean;
    /**
     * The machines the request was AIMED at, in send order — not the
     * ones it reached. Counting only successful sends made a target
     * whose socket threw disappear from the report, so a halt to two
     * machines where one socket was dead-but-unreaped came back as a
     * plain "Stopped." with no sign of the machine still working.
     */
    targets: string[];
    /** Aimed at, but the send threw. Reported, never dropped. */
    unreached: string[];
    /** Answers received so far, attributed to the machine that sent them. */
    answers: Array<{ from: string | null; result: unknown }>;
    /** Set once the first answer lands, to bound the wait for the rest. */
    graceTimer?: ReturnType<typeof setTimeout>;
  }
>();

/**
 * The one bucket every peer that declared no device id falls into.
 *
 * The relay invents an id per connection for those, so treating each as
 * its own machine would broadcast twice into what is far more often one
 * host's two processes — and they share a replay store.
 */
const UNDECLARED_MACHINE = "__undeclared__";

/**
 * How long a broadcast waits for the other machines after the first
 * answer. Short: the alternative is resolving on a race whose winner is
 * systematically the machine with the least to do.
 */
const BROADCAST_GRACE_MS = 3_000;

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
  pending.answers.push({ from: from ?? null, result });

  // A single delivery is a single answer; nothing to gather.
  if (!pending.broadcast) {
    finishCommand(commandId);
    return;
  }
  const expected = pending.targets.length - pending.unreached.length;

  // A broadcast is NOT a race. Resolving on the first reply hands back
  // whichever machine had least to do: a `resume` returns "Nothing is
  // halted." from the machine that was never halted, reporting a
  // success as a no-op, while the machine that actually lifted the halt
  // is still awaiting its store. So every answer is gathered, bounded
  // by a short grace after the first so one slow runtime cannot hold
  // the request open.
  if (pending.answers.length >= expected) {
    finishCommand(commandId);
    return;
  }
  pending.graceTimer ??= setTimeout(() => finishCommand(commandId), BROADCAST_GRACE_MS);
}

function finishCommand(commandId: string): void {
  const pending = pendingCommands.get(commandId);
  if (!pending) return;
  clearTimeout(pending.timer);
  if (pending.graceTimer != null) clearTimeout(pending.graceTimer);
  pendingCommands.delete(commandId);
  pending.resolve(
    pending.broadcast
      ? combineAnswers(pending.targets, pending.unreached, pending.answers)
      : // First-wins delivered to exactly ONE runtime, whatever it had
        // to walk past to get there. Wrapping that in a per-machine
        // report invented a second target the command never addressed —
        // and for `approve`/`deny` it read as one decision fanned out to
        // two queues, the thing this routing refuses to do.
        pending.answers[0]?.result,
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
function machineLabel(id: string | null): string {
  return id == null || id === UNDECLARED_MACHINE ? "an unidentified runtime" : id;
}

/**
 * One answer from several machines, without pretending it was one.
 *
 * Every machine the request was AIMED at gets a line — answered,
 * silent, or never reached — because the whole point is that a reader
 * must not take one machine's "Stopped." for the motebit's. An answer
 * this cannot parse is shown as that machine's answer rather than
 * replacing the report: the first version returned the unparseable one
 * alone, which threw away the acknowledgement from the machine that
 * did stop and left the reader with no evidence of it at all — the
 * inverse of the invariant the function exists for.
 */
function combineAnswers(
  targets: string[],
  unreached: string[],
  answers: Array<{ from: string | null; result: unknown }>,
): unknown {
  if (targets.length <= 1) return answers[0]?.result;

  const answered = new Set(answers.map((a) => a.from).filter((f): f is string => f != null));
  const lines: string[] = [];
  const details: string[] = [];

  answers.forEach((a, i) => {
    const reply = asReply(a.result);
    const who = machineLabel(a.from ?? (answers.length === 1 ? null : `answer ${i + 1}`));
    if (reply == null) {
      lines.push(`  ${who}: answered in a shape this relay could not read`);
      return;
    }
    lines.push(`  ${who}: ${reply.summary}`);
    if (reply.detail != null && reply.detail !== "") details.push(`${who}:\n${reply.detail}`);
  });

  // Silence and a dead socket are different facts and both are the
  // reader's business: an unanswered halt is the one case that must not
  // read as "stopped".
  for (const t of targets) {
    if (unreached.includes(t)) {
      lines.push(`  ${machineLabel(t)}: not reached — its connection was already gone`);
    } else if (!answered.has(t) && answers.every((a) => a.from != null)) {
      lines.push(`  ${machineLabel(t)}: no answer yet — what it stopped is unknown`);
    }
  }
  // When answers carry no machine id (an older surface), fall back to
  // counting rather than naming.
  const anonymousSilent = targets.length - unreached.length - answers.length;
  if (anonymousSilent > 0 && answers.some((a) => a.from == null)) {
    lines.push(
      `  ${anonymousSilent} runtime(s) did not answer in time — what they stopped is unknown`,
    );
  }

  return {
    summary: `Sent to ${targets.length} runtimes; ${answers.length} answered.`,
    detail: [lines.join("\n"), ...details].join("\n\n"),
    data: {
      sent_to: targets.length,
      answered: answers.length,
      unreached,
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
      // An answer already in hand is not a timeout. A broadcast arms a
      // grace window on the first reply, and a reply landing near the
      // ceiling armed one that outlived this timer — so a machine's
      // acknowledged halt was deleted and reported to its owner as "the
      // agent did not respond". Report what came back; the composed
      // answer already names the machines that stayed silent.
      const held = pendingCommands.get(commandId);
      if (held != null && held.answers.length > 0) {
        finishCommand(commandId);
        return;
      }
      if (held?.graceTimer != null) clearTimeout(held.graceTimer);
      pendingCommands.delete(commandId);
      reject(new Error("Command timed out"));
    }, COMMAND_TIMEOUT_MS);

    pendingCommands.set(commandId, {
      resolve,
      timer,
      broadcast: BROADCAST_UNATTENDED_COMMANDS.has(command),
      targets: [],
      unreached: [],
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
      // database, so either can answer for both. (They also share one
      // replay store, which is why a broadcast sends to one process per
      // machine and not to every connection.) Two DEVICES is a
      // different fact: a worker running on
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

    // Broadcast for the verbs that must reach every MACHINE; first-wins
    // for everything else, where a second delivery is a second act.
    //
    // Per machine, not per connection. `motebit run` and `motebit serve`
    // on one host are two peers sharing one device id, one database and
    // — by construction — one replay store, and the envelope carries a
    // single signature. Sending it to both means the second process
    // rejects its own motebit's halt as a replay, and that rejection
    // was a candidate for the answer the person read. The replay guard
    // names this sibling-delivery case as the hole it closes; the
    // relay's job is not to manufacture it. One process per machine is
    // also the right granularity on its own terms: the halt store they
    // would both write is the same file.
    const broadcast = BROADCAST_UNATTENDED_COMMANDS.has(command);
    const targets: ConnectedDevice[] = [];
    if (broadcast) {
      const seen = new Set<string>();
      for (const peer of candidates) {
        // An undeclared peer cannot be grouped, so it is left in the one
        // "unknown machine" bucket rather than treated as its own: two
        // undeclared connections are far more often one host's two
        // processes than two hosts.
        const key = peer.deviceIdDeclared === true ? peer.deviceId : UNDECLARED_MACHINE;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push(peer);
      }
    } else {
      targets.push(...candidates);
    }

    const aimedAt: string[] = [];
    const unreached: string[] = [];
    for (const peer of targets) {
      const label = peer.deviceIdDeclared === true ? peer.deviceId : UNDECLARED_MACHINE;
      try {
        peer.ws.send(payload);
        // Under first-wins only the peer that ACCEPTED was ever a
        // target; the dead sockets walked past on the way are not
        // machines the command was aimed at.
        if (!broadcast) {
          aimedAt.length = 0;
          unreached.length = 0;
          aimedAt.push(label);
          break;
        }
        aimedAt.push(label);
      } catch {
        if (broadcast) aimedAt.push(label);
        // A dead-but-unreaped socket. Recorded, not skipped: under
        // broadcast this machine is one the halt did NOT reach and the
        // reader has to be told, and under first-wins the next peer is
        // the one that answers.
        // Under first-wins a dead socket is one walked past, not a
        // machine left unreached; the loop simply tries the next peer.
        if (broadcast) unreached.push(label);
      }
    }
    const pending = pendingCommands.get(commandId);
    if (pending != null) {
      pending.targets = aimedAt;
      pending.unreached = unreached;
    }

    if (aimedAt.length === 0 || aimedAt.length === unreached.length) {
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
