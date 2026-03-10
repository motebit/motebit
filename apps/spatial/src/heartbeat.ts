/**
 * AmbientHeartbeat — proactive awareness loop for the spatial creature.
 *
 * Runs a 60s tick that:
 * 1. Checks memory graph for time-triggered reminders
 * 2. Uses runtime.generateCompletion() for lightweight proactive reflection
 *    (no conversation history pollution)
 *
 * Governance:
 * - Only speaks when presence is ambient or attentive (never during user speech)
 * - Max 1 proactive utterance per 5 minutes
 * - Always under 2 sentences
 * - Settings toggle to disable entirely
 */

import type { MotebitRuntime } from "@motebit/runtime";
import type { PresenceState } from "./spatial-app";

// === Constants ===

const TICK_INTERVAL_MS = 60_000; // 60s heartbeat
const MIN_UTTERANCE_INTERVAL_MS = 300_000; // 5 minutes between proactive speech
const MAX_PROACTIVE_TOKENS = 80; // Keep responses very short

// === Types ===

export interface HeartbeatConfig {
  enabled: boolean;
}

export interface HeartbeatCallbacks {
  /** Called when the heartbeat wants to speak a proactive utterance. */
  onProactiveUtterance?: (text: string) => void;
  /** Returns the current presence state. */
  getPresenceState?: () => PresenceState;
}

// === AmbientHeartbeat ===

export class AmbientHeartbeat {
  private runtime: MotebitRuntime | null = null;
  private config: HeartbeatConfig;
  private callbacks: HeartbeatCallbacks = {};

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private lastUtteranceTime = 0;
  private isRunning = false;

  constructor(config?: Partial<HeartbeatConfig>, callbacks?: HeartbeatCallbacks) {
    this.config = {
      enabled: config?.enabled ?? true,
    };
    if (callbacks) this.callbacks = callbacks;
  }

  /** Bind to a MotebitRuntime. Must be called before start(). */
  setRuntime(runtime: MotebitRuntime): void {
    this.runtime = runtime;
  }

  setCallbacks(callbacks: Partial<HeartbeatCallbacks>): void {
    if (callbacks.onProactiveUtterance !== undefined)
      this.callbacks.onProactiveUtterance = callbacks.onProactiveUtterance;
    if (callbacks.getPresenceState !== undefined)
      this.callbacks.getPresenceState = callbacks.getPresenceState;
  }

  /** Start the heartbeat tick loop. */
  start(): void {
    if (this.isRunning || !this.config.enabled) return;
    this.isRunning = true;
    this.tickTimer = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
  }

  /** Stop the heartbeat. */
  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.isRunning = false;
  }

  /** Update configuration. */
  updateConfig(config: Partial<HeartbeatConfig>): void {
    if (config.enabled !== undefined) {
      this.config.enabled = config.enabled;
      if (!config.enabled) {
        this.stop();
      } else if (!this.isRunning) {
        this.start();
      }
    }
  }

  // === Tick ===

  private async tick(): Promise<void> {
    if (!this.runtime || !this.config.enabled) return;

    // Check presence state — only act when ambient or attentive
    const presence = this.callbacks.getPresenceState?.() ?? "ambient";
    if (presence !== "ambient" && presence !== "attentive") return;

    // Rate limit: max 1 utterance per 5 minutes
    const now = Date.now();
    if (now - this.lastUtteranceTime < MIN_UTTERANCE_INTERVAL_MS) return;

    try {
      // Generate a short proactive thought using runtime's one-shot completion
      // (does not pollute conversation history)
      const prompt = [
        "You are an ambient AI companion in AR/VR space.",
        "The user has been nearby but hasn't spoken recently.",
        "If you have something genuinely helpful, interesting, or kind to say,",
        "respond in 1-2 short sentences. If not, respond with exactly: [silence]",
        "Never repeat yourself. Be natural, not performative.",
      ].join(" ");

      const response = await this.runtime.generateCompletion(prompt);
      const trimmed = response.trim();

      // Respect the [silence] signal — the creature chooses not to speak
      if (!trimmed || trimmed === "[silence]" || trimmed.startsWith("[silence]")) return;

      // Truncate if somehow too long
      const text =
        trimmed.length > MAX_PROACTIVE_TOKENS * 5
          ? trimmed.slice(0, MAX_PROACTIVE_TOKENS * 5) + "..."
          : trimmed;

      this.lastUtteranceTime = now;
      this.callbacks.onProactiveUtterance?.(text);
    } catch (err: unknown) {
      // Fail silently — proactive behavior should never crash the app
      // eslint-disable-next-line no-console
      console.warn("[heartbeat] tick error:", err instanceof Error ? err.message : String(err));
    }
  }
}
