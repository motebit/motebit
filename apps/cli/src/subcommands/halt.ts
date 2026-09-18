/**
 * `motebit halt` / `motebit resume` — withdrawing the standing
 * permission to act unattended, and giving it back.
 *
 * Two reaches, and the difference between them is the whole point.
 *
 * **Local** (the default) writes the halt into this machine's durable
 * state. It is in force from the instant it is written — nothing new
 * starts — but this process is not the thing doing the work, so it
 * cannot say the work has stopped. It waits briefly for the daemon to
 * acknowledge and reports honestly either way.
 *
 * **`--remote`** sends a signed command to the runtime over the relay.
 * The response IS the acknowledgement: the runtime stopped and said
 * what stopping entailed. If the runtime is not connected the command
 * fails, and the honest reading of that failure is "not delivered" —
 * never "stopped".
 */

import { openMotebitDatabase } from "@motebit/persistence";
import type { HaltAcknowledgement, HaltRequest } from "@motebit/sdk";
import { EventType } from "@motebit/sdk";
import { EventStore } from "@motebit/event-log";
import { RelayClient, RelayClientError } from "@motebit/relay-client";

import type { CliConfig } from "../args.js";
import { loadFullConfig } from "../config.js";
import { loadActiveSigningKey } from "../identity.js";
import { secureErase } from "@motebit/encryption";
import { getDbPath } from "../runtime-factory.js";
import { requireMotebitId, getRelayUrl } from "./_helpers.js";

/**
 * The scope travels structurally, never inside the free-text reason.
 * A `goal <id> <reason>` grammar read `--reason "goal cleanup done"` as
 * a halt of a goal named "cleanup" — halting nothing while reporting a
 * stop, the one failure a stop command must never have.
 */
function haltArgs(goalId: string | undefined, reason: string | undefined): string | undefined {
  if (goalId == null) return reason !== undefined && reason !== "" ? reason : undefined;
  return JSON.stringify({ goal_id: goalId, ...(reason ? { reason } : {}) });
}

/**
 * Append a halt event to the local log. The CLI writes the halt row
 * directly (it is a one-shot process, not the runtime), so without this
 * the request and the lift would leave no audit trail — only the
 * daemon's acknowledgement would be recorded, and the history could not
 * say who asked or who gave the permission back.
 */
async function logHaltEvent(
  moteDb: Awaited<ReturnType<typeof openMotebitDatabase>>,
  motebitId: string,
  eventType: EventType,
  halt: HaltRequest,
): Promise<void> {
  try {
    const events = new EventStore(moteDb.eventStore);
    await events.appendWithClock({
      event_id: crypto.randomUUID(),
      motebit_id: motebitId,
      timestamp: Date.now(),
      event_type: eventType,
      payload: {
        halt_id: halt.halt_id,
        scope: halt.goal_id ?? "all",
        origin: halt.origin,
        requested_at: halt.requested_at,
        ...(halt.reason != null ? { reason: halt.reason } : {}),
        ...(halt.lifted_at != null ? { lifted_at: halt.lifted_at } : {}),
      },
      tombstoned: false,
    });
  } catch (err: unknown) {
    // The halt row is already durable; the event log is the audit trail,
    // not the enforcement. Never let its failure make a stop look like
    // it did not happen — but never let it pass in silence either.
    //
    // This command is the ONLY producer of `halt_requested` and
    // `halt_lifted` on the local path; the runtime emits only
    // `halt_acknowledged` there. So a persistently failing append — a
    // busy database, a full disk — leaves a history with stops in it
    // and no record of who asked or who gave the permission back, and
    // nothing anywhere says so. The runtime's twin warns; so does this.
    console.error(
      `Warning: the halt is recorded and in force, but its audit event could not be written: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * The relay's own explanation for a refusal, or "" when it gave none.
 * Its body is JSON with the reason under `message`; a proxy in front of
 * it may answer plain text.
 */
function relayReason(body: string | undefined): string {
  if (body == null || body.trim() === "") return "";
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    for (const key of ["message", "summary", "error"]) {
      const v = parsed[key];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
    return "";
  } catch {
    const trimmed = body.trim();
    return trimmed.length <= 400 ? trimmed : "";
  }
}

/** How long a local `halt` waits for a running daemon to acknowledge. */
const ACK_WAIT_MS = 3_000;
const ACK_POLL_MS = 150;

/**
 * One line per halt.
 *
 * The state word is "acknowledged", never "stopped". An acknowledgement
 * says a process answered for itself; it does not say that process had
 * anything to stop — the worker answers a goal-scoped halt with
 * "nothing here runs under that goal", which counted under the word
 * "stopped" read as the goal having stopped while it kept firing.
 * Each process also answers only for itself, and this command cannot
 * enumerate the processes that exist, so it reports how many have
 * answered rather than implying that is all of them.
 */
function describe(halt: HaltRequest, acks: HaltAcknowledgement[]): string {
  const scope =
    halt.goal_id == null ? "all unattended execution" : `goal ${halt.goal_id.slice(0, 8)}`;
  const state =
    halt.lifted_at != null
      ? "lifted"
      : acks.length > 0
        ? `${acks.length} process(es) acknowledged`
        : "stop requested (no process has acknowledged)";
  const reason = halt.reason != null && halt.reason !== "" ? ` · ${halt.reason}` : "";
  return `  ${halt.halt_id.slice(0, 8)}  ${scope.padEnd(26)}${state}  (${halt.origin})${reason}`;
}

async function sendRemote(config: CliConfig, command: string, args?: string): Promise<void> {
  const full = loadFullConfig();
  const motebitId = requireMotebitId(full);
  const relayUrl = getRelayUrl(config);
  const active = await loadActiveSigningKey(full, {
    promptLabel: "Passphrase (to sign the command): ",
  });
  const deviceId = full.device_id;
  if (deviceId == null || deviceId === "") {
    secureErase(active.privateKey);
    console.error(
      "Error: no device_id in config — the relay needs transport auth for this route. Run `motebit register` first.",
    );
    process.exit(1);
  }
  // Two credentials, two jobs. `deviceKey` mints the short-lived
  // audience-bound bearer the `/api/v1/agents/*` middleware requires;
  // without it the relay refuses before it ever examines the envelope,
  // and the failure reads as "not delivered". The envelope itself,
  // signed with the same key below, is the end-to-end authorization.
  const client = new RelayClient({
    baseUrl: relayUrl,
    auth: { deviceKey: { motebitId, deviceId, privateKey: active.privateKey } },
  });
  try {
    const result = await client.sendAgentCommand({
      motebitId,
      command,
      ...(args !== undefined ? { args } : {}),
      identityPrivateKey: active.privateKey,
    });
    console.log(result.summary);
    if (result.detail != null && result.detail !== "") console.log(result.detail);
  } catch (err: unknown) {
    if (err instanceof RelayClientError) {
      // Name the failure for what it is. A command that did not arrive
      // did not stop anything, and saying otherwise is the one thing a
      // halt surface must never do.
      // 504 is the one http status that means DELIVERED — the runtime
      // had the command and did not answer inside the window, which is
      // exactly when a halt is most likely to have been applied (the
      // stopper racing a slow abort). Calling that "not delivered" would
      // tell someone their motebit is still running when it has stopped.
      // `err.message` is only `POST <path> → <status>`. The relay's own
      // reason lives in `body`, and on a 404 it is frequently the only
      // actionable sentence there is — "runtimes on 2 different
      // machines, run this on the machine you mean". Printing the
      // status line alone threw it away, which is the same defect the
      // phone's handler was fixed for in this branch.
      const reason = relayReason(err.body);
      const detail = reason !== "" ? `${err.message} — ${reason}` : err.message;
      console.error(
        err.status === 504
          ? // 504 covers two shapes now: one runtime that did not answer,
            // and a multi-machine broadcast where some machine was silent
            // or never reached. The composed detail names each machine,
            // so the sentence after it must not assert "the runtime
            // received this command" — on a partial, one machine
            // demonstrably did not.
            `Not confirmed: ${detail}\nSome runtime did not answer, so at least one machine may still be running. The detail above names each one; a halt written locally (\`motebit halt\` without --remote) is in force on this machine regardless.`
          : err.kind === "http" || err.kind === "network"
            ? `Not delivered: ${detail}\nThe runtime did not answer, so nothing has been stopped remotely. A halt written locally (\`motebit halt\` without --remote) is in force on this machine regardless.`
            : `Command failed: ${detail}`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    secureErase(active.privateKey);
  }
}

export async function handleHalt(config: CliConfig): Promise<void> {
  // positionals: ["halt", ("goal", "<goal_id>")?]
  const isGoalScoped = config.positionals[1] === "goal";
  const goalArg = isGoalScoped ? config.positionals[2] : undefined;
  if (isGoalScoped && (goalArg == null || goalArg === "")) {
    console.error('Usage: motebit halt [goal <goal_id>] [--reason "..."] [--remote]');
    process.exit(1);
  }
  const reason = config.reason;
  // `--remote` targets a runtime that may be on another machine, whose
  // goals this database knows nothing about. Resolving locally would
  // refuse a goal that exists THERE. The id travels as given, and the
  // remote store's own validation refuses one that matches nothing —
  // which is where that check belongs.
  if (config.remote) {
    await sendRemote(config, "halt", haltArgs(goalArg, reason));
    return;
  }

  const motebitId = requireMotebitId(loadFullConfig());
  const moteDb = await openMotebitDatabase(getDbPath(config.dbPath));

  // Locally, resolve the id BEFORE anything is recorded. Every other
  // goal-targeting command accepts the 8-char prefix `motebit goal list`
  // prints, and the scope check downstream is an exact match — so an
  // unresolved prefix would write a halt that matches no goal, report a
  // stop, and let the goal keep firing.
  let goalId: string | undefined;
  if (goalArg != null) {
    const match = moteDb.goalStore
      .list(motebitId)
      .find((g) => g.goal_id === goalArg || g.goal_id.startsWith(goalArg));
    if (!match) {
      moteDb.close();
      console.error(
        `Error: no goal matching "${goalArg}". Nothing has been halted — run \`motebit goal list\` to see the ids.`,
      );
      process.exit(1);
    }
    goalId = match.goal_id;
  }

  try {
    const halt: HaltRequest = {
      halt_id: crypto.randomUUID(),
      motebit_id: motebitId,
      goal_id: goalId ?? null,
      requested_at: Date.now(),
      origin: "local",
      reason: reason ?? null,
      lifted_at: null,
    };
    try {
      moteDb.haltStore.request(halt);
    } catch (err: unknown) {
      // The store refuses a scope that cannot match, and a busy
      // database throws here too. Letting it escape printed
      // "Fatal error: Error: refusing to record a halt scoped to..."
      // from the top-level catch — a stack-trace register on the one
      // command where the person most needs a plain sentence about
      // whether anything stopped. `cmdHalt` already converts this.
      console.error(`Nothing was halted: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    await logHaltEvent(moteDb, motebitId, EventType.HaltRequested, halt);
    const scope = goalId == null ? "all unattended execution" : `goal ${goalId.slice(0, 8)}`;
    console.log(`Stop requested for ${scope} (${halt.halt_id.slice(0, 8)}).`);

    // In force immediately; waiting only to learn whether something was
    // actually running and has now stopped.
    // Who has stopped, by name — never a bare "Stopped". More than one
    // process can run unattended work for this motebit, and this command
    // is not one of them, so it cannot know the full set. Reporting the
    // first acknowledgement as if it spoke for all of them is exactly
    // what let one process keep working under the word "Stopped".
    const deadline = Date.now() + ACK_WAIT_MS;
    let acks = moteDb.haltStore.acknowledgements(halt.halt_id);
    while (Date.now() < deadline && acks.length === 0) {
      await new Promise((r) => setTimeout(r, ACK_POLL_MS));
      acks = moteDb.haltStore.acknowledgements(halt.halt_id);
    }

    if (acks.length > 0) {
      console.log(
        `Acknowledged by ${acks.length} process(es):\n${acks.map((a) => `  ${a.executor_id}: ${a.acknowledgement}`).join("\n")}`,
      );
      console.log(
        "Any other process running unattended work for this motebit stops on its own next check.",
      );
    } else {
      console.log(
        "In force from now — nothing new starts. No running daemon acknowledged within " +
          `${ACK_WAIT_MS / 1000}s; a daemon that is running will acknowledge on its next tick (up to 60s), ` +
          "and one that is not running has nothing to stop.",
      );
    }
    console.log(`Give the permission back with: motebit resume ${halt.halt_id.slice(0, 8)}`);
  } finally {
    moteDb.close();
  }
}

export async function handleResume(config: CliConfig): Promise<void> {
  const target = config.positionals[1] ?? "all";
  if (config.remote) {
    await sendRemote(config, "resume", target);
    return;
  }
  const motebitId = requireMotebitId(loadFullConfig());
  const moteDb = await openMotebitDatabase(getDbPath(config.dbPath));
  try {
    const active = moteDb.haltStore.listActive(motebitId);
    if (active.length === 0) {
      console.log("Nothing is halted.");
      return;
    }
    // Case-insensitive, like the command layer's twin. Both surfaces
    // document `resume [<halt_id>|all]`, and they disagreed on "All":
    // the phone lifted every halt, the terminal exited 1 saying no halt
    // matched. One grammar, one answer.
    if (target.toLowerCase() === "all") {
      let lifted = 0;
      for (const h of active) {
        if (!moteDb.haltStore.lift(h.halt_id)) continue;
        lifted++;
        await logHaltEvent(
          moteDb,
          motebitId,
          EventType.HaltLifted,
          moteDb.haltStore.get(h.halt_id) ?? h,
        );
      }
      console.log(`Resumed — ${lifted} halt(s) lifted.`);
      return;
    }
    // An ambiguous prefix is refused, not resolved arbitrarily —
    // repeated `halt` calls each write a row, so several active halts
    // sharing a short prefix is ordinary, and lifting whichever came
    // first would hand back permission the person did not name.
    const exact = active.find((h) => h.halt_id === target);
    const prefixed = active.filter((h) => h.halt_id.startsWith(target));
    if (exact == null && prefixed.length > 1) {
      console.error(
        `Error: "${target}" matches ${prefixed.length} halts in force — name one exactly.`,
      );
      console.error(
        prefixed.map((h) => describe(h, moteDb.haltStore.acknowledgements(h.halt_id))).join("\n"),
      );
      process.exit(1);
    }
    const match = exact ?? prefixed[0];
    if (!match) {
      console.error(`Error: no halt in force matching "${target}".`);
      console.error(
        active.map((h) => describe(h, moteDb.haltStore.acknowledgements(h.halt_id))).join("\n"),
      );
      process.exit(1);
    }
    // Read the return value: `lift` refuses a halt already lifted, and
    // printing "Resumed" regardless would report giving permission back
    // that this command did not give. The runtime's `cmdResume` reads it.
    const lifted = moteDb.haltStore.lift(match.halt_id);
    if (!lifted) {
      console.log(`Halt ${match.halt_id.slice(0, 8)} was already lifted — nothing changed.`);
      return;
    }
    await logHaltEvent(
      moteDb,
      motebitId,
      EventType.HaltLifted,
      moteDb.haltStore.get(match.halt_id) ?? match,
    );
    console.log(
      `Resumed ${match.goal_id == null ? "unattended execution" : `goal ${match.goal_id.slice(0, 8)}`} (${match.halt_id.slice(0, 8)}).`,
    );
  } finally {
    moteDb.close();
  }
}

/** `motebit halt-status` — what is stopped, and whether it has acknowledged. */
export async function handleHaltStatus(config: CliConfig): Promise<void> {
  if (config.remote) {
    await sendRemote(config, "halt-status");
    return;
  }
  const motebitId = requireMotebitId(loadFullConfig());
  const moteDb = await openMotebitDatabase(getDbPath(config.dbPath));
  try {
    const active = moteDb.haltStore.listActive(motebitId);
    const recent = moteDb.haltStore.listRecent(motebitId, 10);
    if (active.length === 0) {
      console.log("Running — nothing is halted.");
    } else {
      const withAcks = active.map((h) => ({
        halt: h,
        acks: moteDb.haltStore.acknowledgements(h.halt_id),
      }));
      const silent = withAcks.filter((e) => e.acks.length === 0).length;
      const stopped = withAcks.reduce((n, e) => n + e.acks.length, 0);
      // A goal-scoped halt stops one goal, not the motebit.
      const wide = active.some((h) => h.goal_id == null);
      const scopeWord = wide
        ? "unattended execution"
        : `${active.length} goal(s) — the rest of the interior is still running`;
      console.log(
        silent > 0
          ? `Stop requested for ${scopeWord} — ${silent} of ${active.length} with no acknowledgement yet.`
          : `Stop requested for ${scopeWord} — ${stopped} process(es) acknowledged. What each stopped is listed below; a process that has not acknowledged is still running.`,
      );
      for (const e of withAcks) console.log(describe(e.halt, e.acks));
    }
    const past = recent.filter((h) => !active.some((a) => a.halt_id === h.halt_id));
    if (past.length > 0) {
      console.log("\nRecent:");
      for (const h of past) console.log(describe(h, moteDb.haltStore.acknowledgements(h.halt_id)));
    }
  } finally {
    moteDb.close();
  }
}
