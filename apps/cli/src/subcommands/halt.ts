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
import type { HaltRequest } from "@motebit/sdk";
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
  } catch {
    // The halt row is already durable; the event log is the audit trail,
    // not the enforcement. Never let its failure make a stop look like
    // it did not happen.
  }
}

/** How long a local `halt` waits for a running daemon to acknowledge. */
const ACK_WAIT_MS = 3_000;
const ACK_POLL_MS = 150;

function describe(halt: HaltRequest): string {
  const scope =
    halt.goal_id == null ? "all unattended execution" : `goal ${halt.goal_id.slice(0, 8)}`;
  const state =
    halt.lifted_at != null
      ? "lifted"
      : halt.acknowledged_at != null
        ? "stopped"
        : "stop requested (not acknowledged)";
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
      console.error(
        err.status === 504
          ? `Delivered, no answer yet: ${err.message}\nThe runtime received this command and did not reply in time. It may well have stopped — check \`motebit halt-status --remote\` rather than assuming either way.`
          : err.kind === "http" || err.kind === "network"
            ? `Not delivered: ${err.message}\nThe runtime did not answer, so nothing has been stopped remotely. A halt written locally (\`motebit halt\` without --remote) is in force on this machine regardless.`
            : `Command failed: ${err.message}`,
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
      acknowledged_at: null,
      acknowledgement: null,
      lifted_at: null,
    };
    moteDb.haltStore.request(halt);
    await logHaltEvent(moteDb, motebitId, EventType.HaltRequested, halt);
    const scope = goalId == null ? "all unattended execution" : `goal ${goalId.slice(0, 8)}`;
    console.log(`Stop requested for ${scope} (${halt.halt_id.slice(0, 8)}).`);

    // In force immediately; waiting only to learn whether something was
    // actually running and has now stopped.
    const deadline = Date.now() + ACK_WAIT_MS;
    let acknowledged: HaltRequest | null = null;
    while (Date.now() < deadline) {
      const current = moteDb.haltStore.get(halt.halt_id);
      if (current?.acknowledged_at != null) {
        acknowledged = current;
        break;
      }
      await new Promise((r) => setTimeout(r, ACK_POLL_MS));
    }

    if (acknowledged != null) {
      console.log(`Stopped: ${acknowledged.acknowledgement ?? "acknowledged"}`);
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
    if (target === "all") {
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
    const match = active.find((h) => h.halt_id === target || h.halt_id.startsWith(target));
    if (!match) {
      console.error(`Error: no halt in force matching "${target}".`);
      console.error(active.map(describe).join("\n"));
      process.exit(1);
    }
    moteDb.haltStore.lift(match.halt_id);
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
      const waiting = active.filter((h) => h.acknowledged_at == null).length;
      console.log(
        waiting > 0
          ? `Stop requested — ${waiting} of ${active.length} not yet acknowledged.`
          : `Stopped — ${active.length} halt(s) in force.`,
      );
      for (const h of active) console.log(describe(h));
    }
    const past = recent.filter((h) => !active.some((a) => a.halt_id === h.halt_id));
    if (past.length > 0) {
      console.log("\nRecent:");
      for (const h of past) console.log(describe(h));
    }
  } finally {
    moteDb.close();
  }
}
