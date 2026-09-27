/**
 * One presenter per admission, on the relay's own recovery path (#811 v2).
 *
 * A queued task can reach its worker by three doors besides a WebSocket
 * frame: the relay's MCP forward to a registered endpoint, a federation
 * forward to a peer relay, or the submitter presenting it directly under a
 * dispatch token it chose up front (`presenter: "submitter"`). Reconnect
 * recovery (`websocket.ts`, `finalizeConnection`) re-sends every Pending,
 * receipt-less task to a socket of the task's motebit that connects — and it
 * never asked whether one of those doors had already presented the task. The
 * worker's admission ledger guards only `motebit_task`; a WebSocket
 * `task_request` never consults it, so the same task executed twice.
 * (`docs/doctrine/task-admission.md`: one admission ⇒ one presenter ⇒ one
 * execution.)
 *
 * The mark is exactly "a presenter already exists". It is set synchronously
 * at the moment a door is taken — before any await — so a socket that
 * connects while the forward is in flight is not handed a second copy.
 * Recovery skips a marked entry.
 *
 * A relay forward's mark (MCP or federation) is held only while that forward
 * is in flight (#811 v3). When the forward settles without handing the task
 * on for good — an MCP forward that did not store a receipt, a federation
 * forward the peer did not accept, any refused, reset or timed-out
 * connection — the mark is released (`releasePresentation`), and the sockets
 * whose recovery it held back are handed the task then: exactly what
 * recovery would have done without the mark. Keeping it after an ambiguous
 * failure ("the tools/call was sent, then the connection died") stranded
 * tasks that main executes and settles through recovery; the one-presenter
 * rule never makes a task worse off than main. The accepted residual, shared
 * with main: a worker that ran the task but whose answer was lost runs it
 * again when recovery hands it over. Only the submitter's chosen mark and an
 * accepted federation forward's mark outlive the request.
 *
 * A mark is PROCESS-scoped. It records the boot id of the relay instance that
 * set it, and every check treats a mark from another boot as absent: after a
 * restart the relay no longer holds the forward it marked, so recovery
 * behaves exactly as main does and re-sends the task. (Persisting a mark
 * across boots stranded an in-flight task until its TTL — a task main
 * completed.) The mark is still written into the entry's `task_json`,
 * because the production queue is SQLite-backed with no in-memory copy: a
 * mark kept anywhere else would not be seen by recovery's read of the same
 * process.
 *
 * The incidental dispatch token (handed to a submitter because nothing
 * routed) is deliberately NOT a mark: the relay cannot see whether that
 * submitter presents, and the runtime's own delegation client
 * (`packages/runtime/src/relay-delegation.ts`) never does — it polls, and its
 * task reaches the worker only through recovery. Marking it would turn that
 * one execution into none.
 */

import { AgentTaskStatus } from "@motebit/sdk";
import type { TaskQueueEntry } from "./tasks.js";
import type { ConnectedDevice } from "./websocket.js";
import { sendToEach } from "./ws-send.js";

/** Which door presented the task. */
export type PresentedVia = "mcp" | "submitter" | "federation";

/** Persisted on a queue entry: a presenter other than recovery exists. */
export interface TaskPresentation {
  via: PresentedVia;
  /** Wall clock, for the record. */
  at: number;
  /**
   * Connection sequence at mark time (`nextConnectionSeq`). A socket
   * registered after it is one whose recovery this mark held back.
   */
  seq: number;
  /** Identity of this mark, so a stale release never clears a newer one. */
  id: string;
  /** Boot id of the relay instance that set it; any other boot ignores it. */
  boot: string;
}

let connectionSeq = 0;

/**
 * A process-monotonic sequence shared by socket registration and marks, so
 * "registered after this mark" is exact (wall-clock milliseconds tie).
 */
export function nextConnectionSeq(): number {
  connectionSeq += 1;
  return connectionSeq;
}

/**
 * Record that `via` presented `taskId`. Synchronous — call it before the
 * first await of the door it names. Returns the mark (for a later release),
 * or null when the entry is gone.
 */
export function markPresented(
  queue: Map<string, TaskQueueEntry>,
  taskId: string,
  via: PresentedVia,
  bootId: string,
): TaskPresentation | null {
  const entry = queue.get(taskId);
  if (entry == null) return null;
  const mark: TaskPresentation = {
    via,
    at: Date.now(),
    seq: nextConnectionSeq(),
    id: crypto.randomUUID(),
    boot: bootId,
  };
  entry.presented = mark;
  queue.set(taskId, entry);
  return mark;
}

/**
 * Whether `entry` carries a mark set by THIS relay instance. A mark from
 * another boot (a restart, or a mark with no boot id) is absent.
 */
export function presentedInThisBoot(entry: TaskQueueEntry, bootId: string): boolean {
  return entry.presented != null && entry.presented.boot === bootId;
}

/**
 * Whether reconnect recovery may hand this entry to a newly connected socket
 * of its motebit: still Pending, no receipt, and no other presenter in this
 * boot.
 */
export function recoverableOnReconnect(entry: TaskQueueEntry, bootId: string): boolean {
  return (
    entry.task.status === AgentTaskStatus.Pending &&
    !entry.receipt &&
    !presentedInThisBoot(entry, bootId)
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

/**
 * The door named by `mark` is no longer presenting the task (its forward
 * settled without handing it on for good). Clear the mark — only if it is
 * still this one — and
 * hand the task to every OPEN socket of its motebit that registered while
 * the mark held recovery back. Returns how many sockets took it.
 */
export function releasePresentation(
  queue: Map<string, TaskQueueEntry>,
  connections: Map<string, ConnectedDevice[]>,
  taskId: string,
  mark: TaskPresentation,
): number {
  const entry = queue.get(taskId);
  if (entry?.presented?.id !== mark.id) return 0;
  entry.presented = undefined;
  queue.set(taskId, entry);
  if (!recoverableOnReconnect(entry, mark.boot)) return 0;
  return sendToEach(
    connections.get(entry.task.motebit_id),
    JSON.stringify({ type: "task_request", task: entry.task }),
    (peer) => (peer.connectionSeq ?? 0) > mark.seq,
  );
}
