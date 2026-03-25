import { describe, it, expect, vi } from "vitest";
import { StreamingTTSQueue } from "../streaming-tts-queue.js";

function createQueue(opts?: { onDrainStart?: () => void; onDrainEnd?: () => void }) {
  const spoken: string[] = [];
  const speak = vi.fn((text: string) => {
    spoken.push(text);
    return Promise.resolve();
  });
  const queue = new StreamingTTSQueue(speak, opts?.onDrainStart, opts?.onDrainEnd);
  return { queue, speak, spoken };
}

describe("StreamingTTSQueue", () => {
  it("does not speak until clause boundary with min length", async () => {
    const { queue, spoken } = createQueue();
    queue.push("Hi there");
    await new Promise((r) => setTimeout(r, 10));
    expect(spoken).toHaveLength(0);
  });

  it("speaks on first clause boundary (12+ chars then punctuation)", async () => {
    const { queue, spoken } = createQueue();
    // "Let me think about this," = 24 chars with comma, then space + more text
    queue.push("Let me think about this, and then respond.");
    await vi.waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0]).toBe("Let me think about this,");
  });

  it("uses sentence boundary for subsequent utterances", async () => {
    const { queue, spoken } = createQueue();
    // First push: triggers clause boundary (comma after 12+ chars)
    queue.push("Let me think about this, and I believe so. ");
    await vi.waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0]).toBe("Let me think about this,");
    // Now draining — subsequent pushes use sentence boundary (.!?)
    queue.push("Yes indeed. ");
    queue.push("Final words");
    queue.flush();
    await vi.waitFor(() => expect(spoken.length).toBeGreaterThanOrEqual(3));
    expect(spoken[1]).toBe("and I believe so.");
  });

  it("flush drains remaining buffer", async () => {
    const { queue, spoken } = createQueue();
    queue.push("Short text");
    queue.flush();
    await vi.waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0]).toBe("Short text");
  });

  it("cancel clears buffer and queue", async () => {
    const { queue, spoken } = createQueue();
    queue.push("Hello there, ");
    queue.cancel();
    queue.flush();
    // After cancel + flush of empty buffer, nothing should be spoken
    await new Promise((r) => setTimeout(r, 10));
    expect(spoken).toHaveLength(0);
  });

  it("draining is true while speaking", async () => {
    let resolveSpeak!: () => void;
    const speak = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolveSpeak = r;
        }),
    );
    const queue = new StreamingTTSQueue(speak);
    expect(queue.draining).toBe(false);
    // Flush forces drain regardless of clause detection
    queue.push("Some text to speak");
    queue.flush();
    await vi.waitFor(() => expect(speak).toHaveBeenCalledTimes(1));
    expect(queue.draining).toBe(true);
    resolveSpeak();
    await vi.waitFor(() => expect(queue.draining).toBe(false));
  });

  it("fires onDrainStart and onDrainEnd callbacks", async () => {
    const onDrainStart = vi.fn();
    const onDrainEnd = vi.fn();
    const { queue } = createQueue({ onDrainStart, onDrainEnd });
    queue.push("Some text to speak");
    queue.flush();
    await vi.waitFor(() => expect(onDrainEnd).toHaveBeenCalledTimes(1));
    expect(onDrainStart).toHaveBeenCalledTimes(1);
    expect(onDrainStart.mock.invocationCallOrder[0]).toBeLessThan(
      onDrainEnd.mock.invocationCallOrder[0]!,
    );
  });

  it("continues draining after speak error", async () => {
    const spoken: string[] = [];
    let callCount = 0;
    const speak = vi.fn((text: string) => {
      spoken.push(text);
      callCount++;
      if (callCount === 1) return Promise.reject(new Error("fail"));
      return Promise.resolve();
    });
    const queue = new StreamingTTSQueue(speak);
    // Push two sentences then flush remaining
    queue.push("Let me think about this, sure thing. The end");
    queue.flush();
    await vi.waitFor(() => expect(spoken.length).toBeGreaterThanOrEqual(2));
  });

  it("handles incremental deltas across multiple pushes", async () => {
    const { queue, spoken } = createQueue();
    queue.push("Let me ");
    queue.push("think about ");
    queue.push("this, and ");
    queue.push("respond.");
    await vi.waitFor(() => expect(spoken).toHaveLength(1));
    expect(spoken[0]).toBe("Let me think about this,");
  });
});
