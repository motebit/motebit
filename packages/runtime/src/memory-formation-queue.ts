/**
 * Single-lane memory formation queue — the runtime-level Promise
 * chain that serializes background formation jobs after turns return.
 *
 * When the AI loop runs with `options.deferMemoryFormation === true`,
 * it yields a `memory_formation_deferred` chunk and skips the inline
 * formation pass. The runtime catches that chunk and calls
 * `enqueue(job)` here; the job runs after any prior in-flight job
 * completes. The user sees their response without waiting on the
 * embedding + consolidation + edge-linking work.
 *
 * Why single-lane (not parallel): consolidation decisions depend on
 * graph state. If two jobs ran concurrently, they might both decide
 * to form fresh nodes for the same fact because neither saw the
 * other's formation yet. Serializing preserves the same graph-state-
 * order invariant the inline `for (const candidate of candidates)`
 * loop has. The trade-off is that a backlog of N jobs takes roughly
 * N × single-job time to drain — acceptable because the user's
 * next turn blocks on `idle()` only if the queue is not drained,
 * and typical human-conversation cadence leaves several seconds
 * between turns for the queue to catch up.
 *
 * This class is pure orchestration — no knowledge of memory-graph
 * internals. The caller supplies jobs; the queue chains them.
 */

type Job = () => Promise<unknown>;

export interface MemoryFormationQueue {
  /** Chain `job` to run after the current tail. Returns nothing — the
   *  queue swallows per-job errors via the injected logger so one
   *  broken job does not poison the whole chain. Use `idle()` to
   *  await overall drainage from the caller's side. */
  enqueue(job: Job): void;
  /** Resolve when no jobs are pending. Safe to await multiple times;
   *  a fresh `enqueue` after `idle()` resolves reopens the queue. */
  idle(): Promise<void>;
  /** True while at least one job is in flight or pending. */
  inFlight(): boolean;
  /** Count of jobs currently in the queue (pending + in-flight). */
  depth(): number;
}

export interface MemoryFormationQueueDeps {
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

export function createMemoryFormationQueue(
  deps: MemoryFormationQueueDeps = {},
): MemoryFormationQueue {
  const warn = deps.logger?.warn.bind(deps.logger) ?? ((msg, ctx) => console.warn(msg, ctx));

  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;

  return {
    enqueue(job) {
      pending += 1;
      tail = tail.then(
        async () => {
          try {
            await job();
          } catch (err: unknown) {
            warn("memory formation queue: job failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          } finally {
            pending -= 1;
          }
        },
        // The .then error branch should never fire since `tail` itself
        // is always resolved (we caught inside the job wrapper), but
        // defense in depth: swallow any stray rejection so the chain
        // doesn't enter a rejected terminal state.
        () => {
          pending -= 1;
        },
      );
    },

    idle() {
      // Capture `tail` at call time so subsequent enqueues after the
      // await point don't extend the window the caller is waiting on.
      const snapshot = tail;
      return snapshot.then(
        () => undefined,
        () => undefined,
      );
    },

    inFlight() {
      return pending > 0;
    },

    depth() {
      return pending;
    },
  };
}
