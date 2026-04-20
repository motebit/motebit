/**
 * Presence — the operational mode of the motebit, separate from its
 * affective state vector.
 *
 * State machine:
 *
 *   idle        — waiting for the next user message or idle tick.
 *                 `lastTickAt` records when the runtime last ran a cycle
 *                 (null until the first tick). Surfaces render the
 *                 baseline creature.
 *   tending     — running a consolidation cycle. `phase` tracks the
 *                 current phase; `cycleId` ties together the
 *                 `consolidation_cycle_run` event the cycle emits.
 *                 Surfaces render a subtle indicator (slower breath,
 *                 dimmer eye glow) so the user knows the motebit is
 *                 occupied with its own interior.
 *   responsive  — actively processing a user turn. Surfaces render the
 *                 standard speaking/attention cues. The cycle MUST NOT
 *                 start in this mode; if a cycle is already in flight,
 *                 it sees the transition on its next abort checkpoint
 *                 and yields.
 *
 * The controller is the single owner of presence transitions. It mirrors
 * `StateVectorEngine.subscribe()` so surfaces adopt the same observer
 * pattern they already know.
 *
 * Watchdog: once `enterTending` is called, a watchdog timer is armed.
 * If `exitTending` is not called within the budget (default 4 phases ×
 * 15s × 2 safety factor = 120s), the watchdog forces presence back to
 * idle and invokes the `onWatchdogFired` callback so the runtime can
 * emit a `presence_recovered` event. This is the safety net for an
 * awaited promise that ignores its abort signal.
 */

import type { Phase } from "./consolidation-cycle.js";

export type Presence =
  | { readonly mode: "idle"; readonly lastTickAt: number | null }
  | {
      readonly mode: "tending";
      readonly phase: Phase;
      readonly startedAt: number;
      readonly cycleId: string;
    }
  | { readonly mode: "responsive" };

export type PresenceSubscriber = (presence: Presence) => void;

export interface PresenceControllerOptions {
  /** Forces presence back to idle if exitTending isn't called by then.
   *  Default: 4 × 15_000 × 2 = 120_000 ms. */
  watchdogTimeoutMs?: number;
  /** Invoked when the watchdog fires. Caller emits an audit event. */
  onWatchdogFired?: (cycleId: string, phase: Phase) => void;
  /** Override Date.now for tests. */
  now?: () => number;
}

const DEFAULT_WATCHDOG_MS = 4 * 15_000 * 2;

export class PresenceController {
  private state: Presence = { mode: "idle", lastTickAt: null };
  private readonly subscribers: Set<PresenceSubscriber> = new Set();
  private watchdog: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: PresenceControllerOptions = {}) {}

  get(): Presence {
    return this.state;
  }

  subscribe(subscriber: PresenceSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  enterTending(cycleId: string, phase: Phase): void {
    const now = this.now();
    this.armWatchdog(cycleId, phase);
    this.transition({ mode: "tending", phase, startedAt: now, cycleId });
  }

  /** Update the current phase without restarting the watchdog clock —
   *  the timeout covers the whole cycle, not each phase. */
  advancePhase(phase: Phase): void {
    const cur = this.state;
    if (cur.mode !== "tending") return;
    this.transition({
      mode: "tending",
      phase,
      startedAt: cur.startedAt,
      cycleId: cur.cycleId,
    });
  }

  /** Idempotent — calling when not currently tending is a no-op (other
   *  than clearing the watchdog if armed). Lets the cycle's finally
   *  block fire without coordination after the user-message handler has
   *  already transitioned to responsive/idle. */
  exitTending(): void {
    this.clearWatchdog();
    if (this.state.mode !== "tending") return;
    this.transition({ mode: "idle", lastTickAt: this.now() });
  }

  enterResponsive(): void {
    // Don't clear the watchdog: a cycle may still be unwinding and will
    // call exitTending in its finally block. The watchdog is the safety
    // net for the case where finally never fires.
    this.transition({ mode: "responsive" });
  }

  /** Called after a responsive turn finishes and the runtime returns to
   *  passive idle. */
  enterIdle(): void {
    this.transition({ mode: "idle", lastTickAt: this.now() });
  }

  /** True iff the cycle is allowed to start. The cycle's re-entry guard. */
  canStartCycle(): boolean {
    return this.state.mode === "idle";
  }

  /** Test helper. */
  isWatchdogArmed(): boolean {
    return this.watchdog !== null;
  }

  private transition(next: Presence): void {
    this.state = next;
    // Snapshot subscribers — a subscriber that unsubscribes itself
    // during the callback would otherwise mutate the live Set.
    const snapshot = [...this.subscribers];
    for (const sub of snapshot) {
      try {
        sub(next);
      } catch {
        // Subscriber errors never stop a presence transition.
      }
    }
  }

  private armWatchdog(cycleId: string, phase: Phase): void {
    this.clearWatchdog();
    const timeoutMs = this.opts.watchdogTimeoutMs ?? DEFAULT_WATCHDOG_MS;
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      this.opts.onWatchdogFired?.(cycleId, phase);
      this.transition({ mode: "idle", lastTickAt: this.now() });
    }, timeoutMs);
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }
}
