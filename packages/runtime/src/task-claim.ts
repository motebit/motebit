/**
 * One task, one body — the serving body's half of the relay's task claim.
 *
 * An identity serves from several bodies at once (the CLI daemon, the
 * desktop app, a browser tab, a phone), and the relay hands a broadcast
 * `task_request` to every one of them. Its claim is atomic: one body is
 * answered `task_claimed`, the rest `task_claim_rejected`. So a body must
 * WAIT for the grant before it executes, and drop the task on a rejection —
 * claiming and then running at once makes every body run it.
 *
 * Every surface that serves tasks over the relay socket routes its
 * `task_request` frames through one `TaskClaimCoordinator`:
 *
 *   - `offer(taskId, run)` sends `task_claim` (asking for a lease) and calls
 *     `run` only on the grant. A task already being claimed or run here is a
 *     duplicate (reconnect recovery can present a still-Pending task again)
 *     and is ignored.
 *   - `handleFrame(frame)` takes every relay frame; it consumes the claim
 *     answers for tasks it is claiming.
 *   - While `run` is pending the coordinator renews the lease
 *     (`task_claim_renew`) at a third of the granted `lease_ms`, through the
 *     current `send` — so a body whose socket is rebuilt mid-task keeps it.
 *     The lease is a liveness signal, never a re-dispatch timer: a granted
 *     claim means the task may have started, so the relay never hands it to
 *     another body. A body that dies stops renewing and the relay marks the
 *     task UNDETERMINED for its delegator; only this body's own result (or
 *     renewal) resolves it.
 *
 * A grant that never arrives (the frame lost with a socket) drops the claim
 * after `grantTimeoutMs`; if the relay did grant it, the task is held by this
 * body unrun and goes undetermined when the lease lapses — never re-run
 * elsewhere.
 */

/** The relay frames this protocol reads. */
export interface TaskClaimFrame {
  type?: unknown;
  task_id?: unknown;
  lease_ms?: unknown;
  reason?: unknown;
}

export interface TaskClaimCoordinatorOptions {
  /** Send one frame on the body's current relay socket. */
  send: (frame: string) => void;
  /** How long to wait for the relay's answer to a claim. Default 15 s. */
  grantTimeoutMs?: number;
  /** Diagnostic hook (rejections, timeouts, a failed run). */
  onEvent?: (event: TaskClaimEvent) => void;
}

export type TaskClaimEvent =
  | { kind: "rejected"; taskId: string; reason: string }
  | { kind: "grant_timeout"; taskId: string }
  | { kind: "run_failed"; taskId: string; error: string };

/** Default wait for the relay's answer to a claim. */
export const TASK_CLAIM_GRANT_TIMEOUT_MS = 15_000;

type Claim =
  | { phase: "claiming"; run: () => Promise<void>; timer: ReturnType<typeof setTimeout> }
  | { phase: "running"; renew: ReturnType<typeof setInterval> | null };

export class TaskClaimCoordinator {
  private readonly claims = new Map<string, Claim>();
  private send: (frame: string) => void;
  private readonly grantTimeoutMs: number;
  private readonly onEvent: ((event: TaskClaimEvent) => void) | undefined;

  constructor(opts: TaskClaimCoordinatorOptions) {
    this.send = opts.send;
    this.grantTimeoutMs = opts.grantTimeoutMs ?? TASK_CLAIM_GRANT_TIMEOUT_MS;
    this.onEvent = opts.onEvent;
  }

  /** Point the coordinator at a replacement socket (renewals follow it). */
  setSend(send: (frame: string) => void): void {
    this.send = send;
  }

  /** Whether a task is being claimed or run by this body. */
  holds(taskId: string): boolean {
    return this.claims.has(taskId);
  }

  /** Tasks this body is claiming or running. */
  get held(): number {
    return this.claims.size;
  }

  /** Tasks this body is running (granted, not yet finished). */
  get running(): number {
    let n = 0;
    for (const c of this.claims.values()) if (c.phase === "running") n++;
    return n;
  }

  /**
   * Claim a presented task; `run` executes it only once the relay grants the
   * claim. Returns `"duplicate"` (and does nothing) for a task this body is
   * already claiming or running.
   */
  offer(taskId: string, run: () => Promise<void>): "claiming" | "duplicate" {
    if (this.claims.has(taskId)) return "duplicate";
    const timer = setTimeout(() => {
      const c = this.claims.get(taskId);
      if (c?.phase !== "claiming") return;
      this.claims.delete(taskId);
      this.onEvent?.({ kind: "grant_timeout", taskId });
    }, this.grantTimeoutMs);
    this.claims.set(taskId, { phase: "claiming", run, timer });
    this.sendSafe({ type: "task_claim", task_id: taskId, lease: true });
    return "claiming";
  }

  /**
   * Feed a relay frame. Returns true when it was the answer to a claim this
   * body is making (consumed), false otherwise.
   */
  handleFrame(frame: TaskClaimFrame): boolean {
    if (frame.type !== "task_claimed" && frame.type !== "task_claim_rejected") return false;
    if (typeof frame.task_id !== "string") return false;
    const taskId = frame.task_id;
    const claim = this.claims.get(taskId);
    if (claim?.phase !== "claiming") return false;
    clearTimeout(claim.timer);
    if (frame.type === "task_claim_rejected") {
      this.claims.delete(taskId);
      this.onEvent?.({
        kind: "rejected",
        taskId,
        reason: typeof frame.reason === "string" ? frame.reason : "rejected",
      });
      return true;
    }
    const leaseMs = typeof frame.lease_ms === "number" && frame.lease_ms > 0 ? frame.lease_ms : 0;
    const renew =
      leaseMs > 0
        ? setInterval(
            () => this.sendSafe({ type: "task_claim_renew", task_id: taskId }),
            Math.max(10, Math.floor(leaseMs / 3)),
          )
        : null;
    this.claims.set(taskId, { phase: "running", renew });
    void this.execute(taskId, claim.run);
    return true;
  }

  /** Stop every timer and forget every claim (the body stops serving). */
  dispose(): void {
    for (const c of this.claims.values()) {
      if (c.phase === "claiming") clearTimeout(c.timer);
      else if (c.renew != null) clearInterval(c.renew);
    }
    this.claims.clear();
  }

  private async execute(taskId: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err: unknown) {
      this.onEvent?.({
        kind: "run_failed",
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      const c = this.claims.get(taskId);
      if (c?.phase === "running" && c.renew != null) clearInterval(c.renew);
      this.claims.delete(taskId);
    }
  }

  private sendSafe(frame: Record<string, unknown>): void {
    try {
      this.send(JSON.stringify(frame));
    } catch {
      // A closed socket: the claim's grant timeout, or the relay's lease
      // (which marks a lost claimer's task undetermined), settles it.
    }
  }
}
