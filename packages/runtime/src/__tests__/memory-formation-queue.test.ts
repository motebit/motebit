/**
 * Memory-formation queue — single-lane Promise chain used by the
 * runtime to serialize background formation jobs after deferred turns.
 *
 * Pins:
 *   1. Jobs run in FIFO order — the invariant that makes graph-state
 *      ordering safe across deferred turns.
 *   2. A failing job does NOT poison the chain. The queue catches +
 *      logs, the next job runs anyway.
 *   3. `idle()` resolves only when every in-flight + pending job has
 *      finished. Awaiting `idle()` immediately after an `enqueue` must
 *      wait for that job to complete.
 *   4. `inFlight()` reports truth while a job is running; `depth()`
 *      reports the total pending count including any in-flight one.
 */
import { describe, expect, it, vi } from "vitest";
import { createMemoryFormationQueue } from "../memory-formation-queue.js";

describe("createMemoryFormationQueue", () => {
  it("runs jobs in FIFO order (single-lane)", async () => {
    const queue = createMemoryFormationQueue();
    const order: number[] = [];

    queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 15));
      order.push(1);
    });
    queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(2);
    });
    queue.enqueue(async () => {
      order.push(3);
    });

    await queue.idle();
    expect(order).toEqual([1, 2, 3]);
  });

  it("survives a throwing job — subsequent jobs still run", async () => {
    const warnings: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const queue = createMemoryFormationQueue({
      logger: { warn: (msg, ctx) => warnings.push({ msg, ctx }) },
    });
    const order: number[] = [];

    queue.enqueue(async () => {
      order.push(1);
    });
    queue.enqueue(async () => {
      throw new Error("job 2 blew up");
    });
    queue.enqueue(async () => {
      order.push(3);
    });

    await queue.idle();
    expect(order).toEqual([1, 3]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.ctx).toMatchObject({ error: "job 2 blew up" });
  });

  it("`idle()` resolves only after all currently-enqueued jobs complete", async () => {
    const queue = createMemoryFormationQueue();
    let jobFinished = false;
    queue.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 20));
      jobFinished = true;
    });

    await queue.idle();
    expect(jobFinished).toBe(true);
  });

  it("`inFlight()` + `depth()` track pending work", async () => {
    const queue = createMemoryFormationQueue();
    expect(queue.inFlight()).toBe(false);
    expect(queue.depth()).toBe(0);

    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => {
      release = r;
    });

    queue.enqueue(() => held);
    expect(queue.inFlight()).toBe(true);
    expect(queue.depth()).toBe(1);

    queue.enqueue(async () => {});
    expect(queue.depth()).toBe(2);

    release!();
    await queue.idle();
    expect(queue.inFlight()).toBe(false);
    expect(queue.depth()).toBe(0);
  });

  it("reopens cleanly after a drain — `idle()` then `enqueue` then `idle()` again", async () => {
    const queue = createMemoryFormationQueue();
    const order: number[] = [];

    queue.enqueue(async () => {
      order.push(1);
    });
    await queue.idle();
    expect(order).toEqual([1]);

    queue.enqueue(async () => {
      order.push(2);
    });
    await queue.idle();
    expect(order).toEqual([1, 2]);
  });

  it("uses console.warn when no logger is provided — no crash", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const queue = createMemoryFormationQueue();

    queue.enqueue(async () => {
      throw new Error("fallback-logged");
    });
    await queue.idle();

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
