/**
 * Who presents a queued task to its worker — the one rule (#811).
 *
 * A dispatch site hands a `task_request` frame to a worker's sockets, holds
 * the task for reconnect recovery, or takes a fallback door that adds a
 * presenter (the relay's MCP forward, the push wake, the submitter's
 * incidental dispatch token). Reconnect recovery (`websocket.ts`,
 * `finalizeConnection`) hands every Pending, receipt-less entry to any socket
 * of `task.motebit_id` (the URL agent) that registers.
 *
 * Every rule here is main's rule, and `__tests__/presentation-matrix.probe.ts`
 * holds it to that cell by cell. Earlier builds of #811 added presenters or
 * held recovery back — a forward at a swallowed send (v1), a mark that made
 * recovery skip a task another door had presented (v2, v3) — and each lost to
 * main in some cell: a second presenter runs the task twice when the first
 * one's answer is lost, and a held-back recovery strands the task when the
 * door it waited on fails and the device it held back has left. Which of
 * those happens is decided after the door is taken, so no rule that adds or
 * withholds a presenter is never-worse-than-main. What remains is main's
 * behaviour, made explicit: `mainWouldRecover` at every dispatch site, and
 * `recoverableOnReconnect` as recovery's own predicate.
 */

import { AgentTaskStatus } from "@motebit/sdk";
import type { TaskQueueEntry } from "./tasks.js";
import type { ConnectedDevice } from "./websocket.js";
import { sendToEach } from "./ws-send.js";

/**
 * Whether reconnect recovery hands this entry to a newly registered socket of
 * its motebit: still Pending (never granted — task-claim.ts), no receipt,
 * and not visibly expired. A granted task (a body's claim, the relay's MCP
 * forward, the submitter's chosen presentation) is never presented again.
 */
export function recoverableOnReconnect(entry: TaskQueueEntry): boolean {
  return (
    entry.task.status === AgentTaskStatus.Pending &&
    !entry.receipt &&
    entry.expired_unclaimed == null
  );
}

/**
 * What handing a `task_request` frame to a worker's registered sockets did.
 * `registered` counts the sockets main would have sent the frame to (every
 * entry in `connections` that `include` admits); `delivered` counts those
 * that were OPEN and took it (`sendToEach`).
 */
export interface SocketSend {
  registered: number;
  delivered: number;
}

/**
 * THE presenter rule at a dispatch site (#811 v4): add a presenter only where
 * main has none.
 *
 * A dispatch site chooses between three doors: a frame to the worker's
 * socket, holding the task for reconnect recovery, or a fallback that adds a
 * presenter (an MCP forward, and after it the push wake and the submitter's
 * incidental dispatch token). Main took the fallback exactly when the
 * worker had NO registered socket: a frame to a registered but CLOSING or
 * CLOSED socket was swallowed and still counted routed, so main took no
 * other door and left the task to reconnect recovery.
 *
 * Recovery is a presenter of the TASK, not of the worker the site picked: it
 * hands every Pending, receipt-less entry to any socket of `task.motebit_id`
 * (the URL agent) that registers. When the picked worker IS the URL agent
 * (the #854 cell), recovery reaches that worker; when it is not (a pinned
 * worker, a ranked worker, both submitted to the delegator's own URL, as the
 * runtime's delegation client does), recovery reaches the URL agent, whose
 * daemon runs a task it has the capabilities for. Either way main has a
 * presenter, and an added forward is a second one: when the forward's worker
 * runs the task and the answer is lost, recovery runs it again (two
 * executions where main had one), and keeping the task from recovery
 * instead strands a task main completes. Neither is never-worse-than-main,
 * and which one happens is decided after the forward is sent — so the only
 * rule that is never worse than main is main's own: hold.
 *
 * So: true exactly when main left the task to recovery (registered sockets,
 * none took the frame). The site then HOLDS — counted routed, as main
 * counted it: no MCP forward, no push wake, no incidental token. The
 * presentation-matrix probe (`__tests__/presentation-matrix.probe.ts`) is
 * the proof, cell by cell against main; a rule that consults the worker
 * against the URL agent instead goes red there.
 */
export function mainWouldRecover(send: SocketSend): boolean {
  return send.registered > 0 && send.delivered === 0;
}

/** Which door a dispatch site's socket send leaves it at. */
export type SocketRoute = "delivered" | "held_for_recovery" | "no_socket";

/**
 * Hand `payload` to the OPEN sockets among `peers` that `include` admits,
 * and name the door that leaves the site at: `delivered` (an OPEN socket
 * took it), `held_for_recovery` (`mainWouldRecover`: do what main did), or
 * `no_socket` (main took its fallback here, and so may the site). Every
 * dispatch site that decides between a socket, recovery and a fallback
 * consults this, so the rule lives in one place.
 */
export function routeToSockets(
  peers: Iterable<ConnectedDevice> | undefined,
  payload: string,
  include?: (peer: ConnectedDevice) => boolean,
): SocketRoute {
  const eligible = peers == null ? [] : [...peers].filter((p) => include == null || include(p));
  const send: SocketSend = {
    registered: eligible.length,
    delivered: sendToEach(eligible, payload),
  };
  if (send.delivered > 0) return "delivered";
  return mainWouldRecover(send) ? "held_for_recovery" : "no_socket";
}
