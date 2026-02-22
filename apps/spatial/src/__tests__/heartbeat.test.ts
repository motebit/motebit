import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AmbientHeartbeat } from "../heartbeat";

// ---------------------------------------------------------------------------
// Mock runtime — minimal surface for generateCompletion()
// ---------------------------------------------------------------------------

function createMockRuntime(response = "Hello there.") {
  return {
    generateCompletion: vi.fn().mockResolvedValue(response),
  } as unknown as import("@motebit/runtime").MotebitRuntime;
}

// ---------------------------------------------------------------------------
// Construction & lifecycle
// ---------------------------------------------------------------------------

describe("AmbientHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("constructs with defaults", () => {
    const hb = new AmbientHeartbeat();
    expect(hb).toBeDefined();
  });

  it("does not start when disabled", async () => {
    const rt = createMockRuntime();
    const hb = new AmbientHeartbeat({ enabled: false });
    hb.setRuntime(rt);
    hb.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(rt.generateCompletion).not.toHaveBeenCalled();
  });

  it("stop() clears the tick timer", async () => {
    const rt = createMockRuntime();
    const utterances: string[] = [];
    const hb = new AmbientHeartbeat({}, {
      onProactiveUtterance: (text) => utterances.push(text),
      getPresenceState: () => "ambient",
    });
    hb.setRuntime(rt);
    hb.start();
    hb.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(rt.generateCompletion).not.toHaveBeenCalled();
    expect(utterances).toHaveLength(0);
  });

  it("start() is idempotent", () => {
    const hb = new AmbientHeartbeat();
    hb.setRuntime(createMockRuntime());
    hb.start();
    hb.start(); // Should not throw or double-schedule
    hb.stop();
  });
});

// ---------------------------------------------------------------------------
// Tick behavior — presence gating
// ---------------------------------------------------------------------------

describe("heartbeat tick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls generateCompletion on tick when ambient", async () => {
    const rt = createMockRuntime("A gentle thought.");
    const utterances: string[] = [];

    const hb = new AmbientHeartbeat({}, {
      onProactiveUtterance: (text) => utterances.push(text),
      getPresenceState: () => "ambient",
    });
    hb.setRuntime(rt);
    hb.start();

    await vi.advanceTimersByTimeAsync(60_000);
    hb.stop();

    expect(rt.generateCompletion).toHaveBeenCalledOnce();
    expect(utterances).toEqual(["A gentle thought."]);
  });

  it("fires when presence is attentive", async () => {
    const rt = createMockRuntime("I noticed you.");
    const utterances: string[] = [];

    const hb = new AmbientHeartbeat({}, {
      onProactiveUtterance: (text) => utterances.push(text),
      getPresenceState: () => "attentive",
    });
    hb.setRuntime(rt);
    hb.start();

    await vi.advanceTimersByTimeAsync(60_000);
    hb.stop();

    expect(rt.generateCompletion).toHaveBeenCalledOnce();
    expect(utterances).toEqual(["I noticed you."]);
  });

  it("does not fire when presence is engaged", async () => {
    const rt = createMockRuntime("Should not speak.");
    const hb = new AmbientHeartbeat({}, {
      getPresenceState: () => "engaged",
    });
    hb.setRuntime(rt);
    hb.start();

    await vi.advanceTimersByTimeAsync(60_000);
    hb.stop();

    expect(rt.generateCompletion).not.toHaveBeenCalled();
  });

  it("does not fire when presence is speaking", async () => {
    const rt = createMockRuntime("Nope.");
    const hb = new AmbientHeartbeat({}, {
      getPresenceState: () => "speaking",
    });
    hb.setRuntime(rt);
    hb.start();

    await vi.advanceTimersByTimeAsync(60_000);
    hb.stop();

    expect(rt.generateCompletion).not.toHaveBeenCalled();
  });

  it("does not fire when presence is processing", async () => {
    const rt = createMockRuntime("Nope.");
    const hb = new AmbientHeartbeat({}, {
      getPresenceState: () => "processing",
    });
    hb.setRuntime(rt);
    hb.start();

    await vi.advanceTimersByTimeAsync(60_000);
    hb.stop();

    expect(rt.generateCompletion).not.toHaveBeenCalled();
  });

  it("does not fire when presence is dormant", async () => {
    const rt = createMockRuntime("Nope.");
    const hb = new AmbientHeartbeat({}, {
      getPresenceState: () => "dormant",
    });
    hb.setRuntime(rt);
    hb.start();

    await vi.advanceTimersByTimeAsync(60_000);
    hb.stop();

    expect(rt.generateCompletion).not.toHaveBeenCalled();
  });

  it("defaults to ambient when no getPresenceState callback", async () => {
    const rt = createMockRuntime("Default ambient.");
    const utterances: string[] = [];

    const hb = new AmbientHeartbeat({}, {
      onProactiveUtterance: (text) => utterances.push(text),
    });
    hb.setRuntime(rt);
    hb.start();

    await vi.advanceTimersByTimeAsync(60_000);
    hb.stop();

    expect(rt.generateCompletion).toHaveBeenCalledOnce();
    expect(utterances).toEqual(["Default ambient."]);
  });
});

// ---------------------------------------------------------------------------
// [silence] handling
// ---------------------------------------------------------------------------

describe("heartbeat silence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not emit utterance for [silence]", async () => {
    const rt = createMockRuntime("[silence]");
    const utterances: string[] = [];

    const hb = new AmbientHeartbeat({}, {
      onProactiveUtterance: (text) => utterances.push(text),
      getPresenceState: () => "ambient",
    });
    hb.setRuntime(rt);
    hb.start();

    await vi.advanceTimersByTimeAsync(60_000);
    hb.stop();

    expect(rt.generateCompletion).toHaveBeenCalledOnce();
    expect(utterances).toHaveLength(0);
  });

  it("does not emit utterance for empty/whitespace response", async () => {
    const rt = createMockRuntime("   ");
    const utterances: string[] = [];

    const hb = new AmbientHeartbeat({}, {
      onProactiveUtterance: (text) => utterances.push(text),
      getPresenceState: () => "ambient",
    });
    hb.setRuntime(rt);
    hb.start();

    await vi.advanceTimersByTimeAsync(60_000);
    hb.stop();

    expect(utterances).toHaveLength(0);
  });

  it("does not emit utterance for [silence] with trailing text", async () => {
    const rt = createMockRuntime("[silence] I have nothing to say.");
    const utterances: string[] = [];

    const hb = new AmbientHeartbeat({}, {
      onProactiveUtterance: (text) => utterances.push(text),
      getPresenceState: () => "ambient",
    });
    hb.setRuntime(rt);
    hb.start();

    await vi.advanceTimersByTimeAsync(60_000);
    hb.stop();

    expect(utterances).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe("heartbeat rate limiting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("enforces 5-minute minimum between utterances", async () => {
    const rt = createMockRuntime("Thought.");
    const utterances: string[] = [];

    const hb = new AmbientHeartbeat({}, {
      onProactiveUtterance: (text) => utterances.push(text),
      getPresenceState: () => "ambient",
    });
    hb.setRuntime(rt);
    hb.start();

    // First tick at 60s — should fire
    await vi.advanceTimersByTimeAsync(60_000);
    expect(utterances).toHaveLength(1);

    // Second tick at 120s — rate limited (< 5 min since last)
    await vi.advanceTimersByTimeAsync(60_000);
    expect(utterances).toHaveLength(1);
    expect(rt.generateCompletion).toHaveBeenCalledTimes(1);

    // Third tick at 180s — still rate limited
    await vi.advanceTimersByTimeAsync(60_000);
    expect(utterances).toHaveLength(1);

    // Advance to 360s total (6 min) — past the 5-min window from first utterance at 60s
    await vi.advanceTimersByTimeAsync(180_000);
    expect(utterances).toHaveLength(2);

    hb.stop();
  });
});

// ---------------------------------------------------------------------------
// Error resilience
// ---------------------------------------------------------------------------

describe("heartbeat error handling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("survives generateCompletion failure and keeps running", async () => {
    const rt = createMockRuntime("ok");
    (rt.generateCompletion as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Network error"));

    const utterances: string[] = [];
    const hb = new AmbientHeartbeat({}, {
      onProactiveUtterance: (text) => utterances.push(text),
      getPresenceState: () => "ambient",
    });
    hb.setRuntime(rt);
    hb.start();

    // First tick — fails silently
    await vi.advanceTimersByTimeAsync(60_000);
    expect(utterances).toHaveLength(0);
    expect(rt.generateCompletion).toHaveBeenCalledTimes(1);

    // Failed tick did not set lastUtteranceTime, but rate limit is
    // based on successful utterances. Next tick should try again.
    // However, we're within 5-min window of... nothing (no successful utterance).
    // Second tick at 120s — should succeed since no prior utterance
    await vi.advanceTimersByTimeAsync(60_000);
    expect(utterances).toHaveLength(1);
    expect(utterances[0]).toBe("ok");

    hb.stop();
  });

  it("does not tick without runtime", async () => {
    const utterances: string[] = [];
    const hb = new AmbientHeartbeat({}, {
      onProactiveUtterance: (text) => utterances.push(text),
      getPresenceState: () => "ambient",
    });
    // No setRuntime() call
    hb.start();

    await vi.advanceTimersByTimeAsync(120_000);
    hb.stop();

    expect(utterances).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// updateConfig
// ---------------------------------------------------------------------------

describe("heartbeat updateConfig", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("disabling stops the timer", async () => {
    const rt = createMockRuntime("Hello.");
    const utterances: string[] = [];

    const hb = new AmbientHeartbeat({}, {
      onProactiveUtterance: (text) => utterances.push(text),
      getPresenceState: () => "ambient",
    });
    hb.setRuntime(rt);
    hb.start();

    hb.updateConfig({ enabled: false });

    await vi.advanceTimersByTimeAsync(120_000);

    expect(utterances).toHaveLength(0);
    expect(rt.generateCompletion).not.toHaveBeenCalled();
  });

  it("re-enabling restarts the timer", async () => {
    const rt = createMockRuntime("Back again.");
    const utterances: string[] = [];

    const hb = new AmbientHeartbeat({ enabled: false }, {
      onProactiveUtterance: (text) => utterances.push(text),
      getPresenceState: () => "ambient",
    });
    hb.setRuntime(rt);
    hb.start(); // No-op because disabled

    await vi.advanceTimersByTimeAsync(120_000);
    expect(utterances).toHaveLength(0);

    // Re-enable
    hb.updateConfig({ enabled: true });
    await vi.advanceTimersByTimeAsync(60_000);
    hb.stop();

    expect(utterances).toHaveLength(1);
  });

  it("truncates overly long responses", async () => {
    const longText = "a".repeat(500);
    const rt = createMockRuntime(longText);
    const utterances: string[] = [];

    const hb = new AmbientHeartbeat({}, {
      onProactiveUtterance: (text) => utterances.push(text),
      getPresenceState: () => "ambient",
    });
    hb.setRuntime(rt);
    hb.start();

    await vi.advanceTimersByTimeAsync(60_000);
    hb.stop();

    expect(utterances).toHaveLength(1);
    // MAX_PROACTIVE_TOKENS (80) * 5 = 400, plus "..."
    expect(utterances[0]!.length).toBe(403);
    expect(utterances[0]!.endsWith("...")).toBe(true);
  });
});
