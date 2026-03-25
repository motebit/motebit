// ---------------------------------------------------------------------------
// StreamingTTSQueue — buffer → clause boundary → queue → sequential drain
// ---------------------------------------------------------------------------

/**
 * Accumulates streaming text deltas, detects clause/sentence boundaries,
 * and drains through a speaker function one clause at a time.
 *
 * Platform-agnostic: actual speech is delegated to the `speak` callback.
 * UI side effects (mic state, animation, audio flags) stay in surface code
 * via the optional `onDrainStart` / `onDrainEnd` hooks.
 */
export class StreamingTTSQueue {
  private buffer = "";
  private queue: string[] = [];
  private _draining = false;

  /**
   * @param speak  Called with each clause. Must resolve when speech completes
   *               (or is cancelled). The queue drains sequentially.
   * @param onDrainStart  Fires once when the first clause begins speaking.
   * @param onDrainEnd    Fires once when the last clause finishes and the queue is empty.
   */
  constructor(
    private readonly speak: (text: string) => Promise<void>,
    private readonly onDrainStart?: () => void,
    private readonly onDrainEnd?: () => void,
  ) {}

  /** True while the queue is actively speaking. */
  get draining(): boolean {
    return this._draining;
  }

  /** Feed a text delta from the stream. Speaks when a clause boundary is detected. */
  push(delta: string): void {
    this.buffer += delta;

    // First utterance: clause boundary (,;:) with min 12 chars for natural start.
    // Subsequent: sentence boundary (.!?) for smooth cadence.
    const pattern = this._draining
      ? /^([\s\S]*?[.!?])\s+([\s\S]*)$/
      : /^([\s\S]{12,}?[.!?:;,])\s+([\s\S]*)$/;
    const match = this.buffer.match(pattern);
    if (match) {
      const clause = match[1]!.trim();
      this.buffer = match[2]!;
      if (clause) {
        this.queue.push(clause);
        if (!this._draining) this.drain();
      }
    }
  }

  /** Flush remaining buffer (call at end of stream). */
  flush(): void {
    const remaining = this.buffer.trim();
    this.buffer = "";
    if (remaining) {
      this.queue.push(remaining);
      if (!this._draining) this.drain();
    }
  }

  /** Cancel: clear buffer + queue. Caller is responsible for cancelling speech. */
  cancel(): void {
    this.buffer = "";
    this.queue = [];
    this._draining = false;
  }

  private drain(): void {
    if (this.queue.length === 0) {
      this._draining = false;
      this.onDrainEnd?.();
      return;
    }
    if (!this._draining) {
      this._draining = true;
      this.onDrainStart?.();
    }
    const text = this.queue.shift()!;
    this.speak(text)
      .then(() => this.drain())
      .catch(() => this.drain());
  }
}
