import type { MotebitState } from "@motebit/sdk";

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class CursorPresence {
  private state: Partial<MotebitState> = {
    attention: 0.1,
    curiosity: 0.1,
    social_distance: 0.7,
  };

  private mousePos = { x: 0.5, y: 0.5 };
  private prevPos = { x: 0.5, y: 0.5 };
  private velocity = 0;
  private inViewport = true;
  private lastMoveTime = Date.now();
  private interval: ReturnType<typeof setInterval> | null = null;

  // Entrance impulse state
  private entranceSpikeActive = false;
  private entranceSpikeStart = 0;
  private hasTriggeredEntrance = false;
  private lastLeaveTime = 0;
  private readonly idleThreshold = 3000;
  private readonly spikeDuration = 800;

  // Bound handlers for cleanup
  private onMove = (e: MouseEvent): void => {
    this.prevPos = { ...this.mousePos };
    this.mousePos = {
      x: e.clientX / window.innerWidth,
      y: e.clientY / window.innerHeight,
    };
    const dx = this.mousePos.x - this.prevPos.x;
    const dy = this.mousePos.y - this.prevPos.y;
    this.velocity = Math.sqrt(dx * dx + dy * dy);
    this.lastMoveTime = Date.now();
  };

  private onTouch = (e: TouchEvent): void => {
    if (e.touches.length === 0) return;
    const touch = e.touches[0]!;
    this.prevPos = { ...this.mousePos };
    this.mousePos = {
      x: touch.clientX / window.innerWidth,
      y: touch.clientY / window.innerHeight,
    };
    const dx = this.mousePos.x - this.prevPos.x;
    const dy = this.mousePos.y - this.prevPos.y;
    this.velocity = Math.sqrt(dx * dx + dy * dy);
    this.lastMoveTime = Date.now();
  };

  private onLeave = (): void => {
    this.inViewport = false;
    this.lastLeaveTime = Date.now();
  };

  private onEnter = (): void => {
    this.inViewport = true;
    const now = Date.now();
    const awayDuration = now - this.lastLeaveTime;

    // Fire entrance spike on first entrance or after idle threshold
    if (!this.hasTriggeredEntrance || awayDuration > this.idleThreshold) {
      this.entranceSpikeActive = true;
      this.entranceSpikeStart = now;
      this.hasTriggeredEntrance = true;
    }
  };

  start(): void {
    window.addEventListener("mousemove", this.onMove);
    document.addEventListener("mouseleave", this.onLeave);
    document.addEventListener("mouseenter", this.onEnter);
    window.addEventListener("touchmove", this.onTouch);

    this.interval = setInterval(() => {
      const alpha = 0.15;
      const idleMs = Date.now() - this.lastMoveTime;
      const idleDecay = Math.max(0, 1 - idleMs / 5000); // Decays over 5 seconds of idle

      // Compute entrance spike contribution
      let spike = 0;
      if (this.entranceSpikeActive) {
        const elapsed = Date.now() - this.entranceSpikeStart;
        if (elapsed < this.spikeDuration) {
          // Quadratic decay: (1 - t)^2
          const t = elapsed / this.spikeDuration;
          spike = (1 - t) * (1 - t);
        } else {
          this.entranceSpikeActive = false;
        }
      }

      if (!this.inViewport) {
        // Mouse left viewport — decay toward resting state
        this.state = {
          attention: lerp(this.state.attention ?? 0.1, 0.05, alpha),
          curiosity: lerp(this.state.curiosity ?? 0.1, 0.05, alpha),
          social_distance: lerp(this.state.social_distance ?? 0.7, 0.9, alpha),
        };
      } else {
        // Distance from viewport center (0 = center, ~0.7 = corner)
        const cx = this.mousePos.x - 0.5;
        const cy = this.mousePos.y - 0.5;
        const distFromCenter = Math.sqrt(cx * cx + cy * cy) / 0.707; // Normalize so corner = 1

        // Near center → high attention, low social_distance
        const targetAttention = Math.max(0.1, 1 - distFromCenter) * idleDecay;
        const targetSocialDistance = 0.3 + distFromCenter * 0.5 + (1 - idleDecay) * 0.2;

        // Velocity → curiosity
        const targetCuriosity = Math.min(1, this.velocity * 8) * idleDecay;

        // EMA smoothing
        this.state = {
          attention: Math.min(
            1,
            lerp(this.state.attention ?? 0.1, targetAttention, alpha) + 0.5 * spike,
          ),
          curiosity: Math.min(
            1,
            lerp(this.state.curiosity ?? 0.1, targetCuriosity, alpha) + 0.3 * spike,
          ),
          social_distance: Math.max(
            0,
            lerp(this.state.social_distance ?? 0.7, targetSocialDistance, alpha) - 0.3 * spike,
          ),
        };
      }

      // Decay velocity each tick
      this.velocity *= 0.85;
    }, 33); // ~30 fps
  }

  stop(): void {
    window.removeEventListener("mousemove", this.onMove);
    document.removeEventListener("mouseleave", this.onLeave);
    document.removeEventListener("mouseenter", this.onEnter);
    window.removeEventListener("touchmove", this.onTouch);

    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  getUpdates(): Partial<MotebitState> {
    return this.state;
  }
}
