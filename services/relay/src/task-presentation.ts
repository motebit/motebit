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
 * A door that turns out NOT to have presented releases its mark
 * (`releasePresentation`), and the sockets whose recovery the mark held back
 * are handed the task then — exactly what recovery would have done without
 * the mark.
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
 * The door named by `mark` did NOT present the task (the forward never
 * reached the worker). Clear the mark — only if it is still this one — and
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
