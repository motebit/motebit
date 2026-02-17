import { describe, it, expect } from "vitest";
import { buildSystemPrompt, derivePersonalityNote, formatBodyAwareness } from "../prompt";
import { TrustMode, BatteryMode } from "@motebit/sdk";
import type { ContextPack, MotebitState, BehaviorCues } from "@motebit/sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDefaultState(overrides: Partial<MotebitState> = {}): MotebitState {
  return {
    attention: 0.5,
    processing: 0.3,
    confidence: 0.7,
    affect_valence: 0.0,
    affect_arousal: 0.1,
    social_distance: 0.4,
    curiosity: 0.5,
    trust_mode: TrustMode.Guarded,
    battery_mode: BatteryMode.Normal,
    ...overrides,
  };
}

function makeContextPack(overrides: Partial<ContextPack> = {}): ContextPack {
  return {
    recent_events: [],
    relevant_memories: [],
    current_state: makeDefaultState(),
    user_message: "Hello!",
    ...overrides,
  };
}

function makeDefaultCues(overrides: Partial<BehaviorCues> = {}): BehaviorCues {
  return {
    hover_distance: 0.4,
    drift_amplitude: 0.02,
    glow_intensity: 0.3,
    eye_dilation: 0.3,
    smile_curvature: 0.0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// derivePersonalityNote
// ---------------------------------------------------------------------------

describe("derivePersonalityNote", () => {
  it("returns empty string for neutral state", () => {
    const state = makeDefaultState();
    expect(derivePersonalityNote(state)).toBe("");
  });

  it("returns subdued note for negative valence", () => {
    const state = makeDefaultState({ affect_valence: -0.5 });
    expect(derivePersonalityNote(state)).toContain("subdued");
  });

  it("returns bright note for positive valence", () => {
    const state = makeDefaultState({ affect_valence: 0.7 });
    expect(derivePersonalityNote(state)).toContain("bright");
  });

  it("returns curiosity note for high curiosity", () => {
    const state = makeDefaultState({ curiosity: 0.9 });
    expect(derivePersonalityNote(state)).toContain("questions");
  });

  it("returns uncertain note for low confidence", () => {
    const state = makeDefaultState({ confidence: 0.2 });
    expect(derivePersonalityNote(state)).toContain("uncertain");
  });

  it("returns familiar note for low social_distance", () => {
    const state = makeDefaultState({ social_distance: 0.1 });
    expect(derivePersonalityNote(state)).toContain("familiar");
  });

  it("returns conserving note for critical battery", () => {
    const state = makeDefaultState({ battery_mode: BatteryMode.Critical });
    expect(derivePersonalityNote(state)).toContain("conserving");
  });

  it("caps at 2 notes max", () => {
    const state = makeDefaultState({
      affect_valence: -0.5,
      curiosity: 0.9,
      confidence: 0.1,
      social_distance: 0.1,
    });
    const note = derivePersonalityNote(state);
    // Count sentences (each note ends with a period followed by space or end)
    const sentences = note.split(". ").filter(Boolean);
    expect(sentences.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// formatBodyAwareness
// ---------------------------------------------------------------------------

describe("formatBodyAwareness", () => {
  it("returns empty string for calm default cues", () => {
    const cues = makeDefaultCues();
    expect(formatBodyAwareness(cues)).toBe("");
  });

  it("describes close hover distance", () => {
    const cues = makeDefaultCues({ hover_distance: 0.1 });
    expect(formatBodyAwareness(cues)).toContain("very close");
  });

  it("describes distant hover", () => {
    const cues = makeDefaultCues({ hover_distance: 0.8 });
    expect(formatBodyAwareness(cues)).toContain("distance");
  });

  it("describes bright glow", () => {
    const cues = makeDefaultCues({ glow_intensity: 0.8 });
    expect(formatBodyAwareness(cues)).toContain("glowing brightly");
  });

  it("describes dim glow", () => {
    const cues = makeDefaultCues({ glow_intensity: 0.1 });
    expect(formatBodyAwareness(cues)).toContain("dimly");
  });

  it("describes wide eyes", () => {
    const cues = makeDefaultCues({ eye_dilation: 0.8 });
    expect(formatBodyAwareness(cues)).toContain("eyes wide");
  });

  it("describes smile", () => {
    const cues = makeDefaultCues({ smile_curvature: 0.1 });
    expect(formatBodyAwareness(cues)).toContain("smiling gently");
  });

  it("describes frown", () => {
    const cues = makeDefaultCues({ smile_curvature: -0.08 });
    expect(formatBodyAwareness(cues)).toContain("downturned");
  });

  it("combines multiple descriptions", () => {
    const cues = makeDefaultCues({
      hover_distance: 0.1,
      glow_intensity: 0.8,
      smile_curvature: 0.1,
    });
    const result = formatBodyAwareness(cues);
    expect(result).toContain("[Body]");
    expect(result).toContain("very close");
    expect(result).toContain("glowing brightly");
    expect(result).toContain("smiling gently");
  });
});

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

describe("buildSystemPrompt", () => {
  it("includes all core sections", () => {
    const prompt = buildSystemPrompt(makeContextPack());
    expect(prompt).toContain("motebit");
    expect(prompt).toContain("[Your internal state");
    expect(prompt).toContain("<memory");
    expect(prompt).toContain("<state");
    expect(prompt).toContain("[State]");
  });

  it("uses custom name from config", () => {
    const prompt = buildSystemPrompt(makeContextPack(), { name: "Pebble" });
    expect(prompt).toContain("Your name is Pebble");
    expect(prompt).not.toContain("Your name is Motebit");
  });

  it("includes personality_notes when configured", () => {
    const prompt = buildSystemPrompt(makeContextPack(), {
      personality_notes: "You have a fondness for wordplay.",
    });
    expect(prompt).toContain("You have a fondness for wordplay.");
  });

  it("omits body awareness when no cues provided", () => {
    const prompt = buildSystemPrompt(makeContextPack());
    expect(prompt).not.toContain("[Body]");
  });

  it("includes body awareness when cues are provided", () => {
    const pack = makeContextPack({
      behavior_cues: makeDefaultCues({ hover_distance: 0.1, glow_intensity: 0.8 }),
    });
    const prompt = buildSystemPrompt(pack);
    expect(prompt).toContain("[Body]");
    expect(prompt).toContain("very close");
  });

  it("includes personality modulation for emotional states", () => {
    const pack = makeContextPack({
      current_state: makeDefaultState({ affect_valence: -0.5 }),
    });
    const prompt = buildSystemPrompt(pack);
    expect(prompt).toContain("subdued");
  });

  it("includes all 9 state fields in packed context", () => {
    const prompt = buildSystemPrompt(makeContextPack());
    expect(prompt).toContain("attention=");
    expect(prompt).toContain("processing=");
    expect(prompt).toContain("confidence=");
    expect(prompt).toContain("valence=");
    expect(prompt).toContain("arousal=");
    expect(prompt).toContain("social_distance=");
    expect(prompt).toContain("curiosity=");
    expect(prompt).toContain("trust=");
    expect(prompt).toContain("battery=");
  });
});
