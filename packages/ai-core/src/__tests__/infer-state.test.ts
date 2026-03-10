import { describe, it, expect } from "vitest";
import { inferStateFromText } from "../infer-state";
import type { MotebitState } from "@motebit/sdk";
import { TrustMode, BatteryMode } from "@motebit/sdk";

function defaultState(): MotebitState {
  return {
    attention: 0,
    processing: 0,
    confidence: 0.5,
    affect_valence: 0,
    affect_arousal: 0,
    social_distance: 0.5,
    curiosity: 0,
    trust_mode: TrustMode.Guarded,
    battery_mode: BatteryMode.Normal,
  };
}

describe("inferStateFromText", () => {
  it("positive text nudges affect_valence up", () => {
    const result = inferStateFromText("I'm so happy and glad to help you today!", defaultState());
    expect(result.affect_valence).toBe(0.15);
  });

  it("negative text nudges affect_valence down", () => {
    const result = inferStateFromText(
      "I'm sorry to hear that, it sounds really difficult.",
      defaultState(),
    );
    expect(result.affect_valence).toBe(-0.15);
  });

  it("mixed positive and negative text does not nudge valence", () => {
    const result = inferStateFromText(
      "I'm happy you shared, but sorry it was so difficult.",
      defaultState(),
    );
    expect(result.affect_valence).toBeUndefined();
  });

  it("question marks nudge curiosity up", () => {
    const result = inferStateFromText("What do you think? Would that work?", defaultState());
    expect(result.curiosity).toBe(0.2);
  });

  it("single question mark nudges curiosity by 0.1", () => {
    const result = inferStateFromText("What do you think about that?", defaultState());
    expect(result.curiosity).toBe(0.1);
  });

  it("curiosity nudge caps at 0.2", () => {
    const result = inferStateFromText("Really? Why? How? When? Where?", defaultState());
    expect(result.curiosity).toBe(0.2);
  });

  it("long response nudges attention up", () => {
    const longText = "A".repeat(201);
    const result = inferStateFromText(longText, defaultState());
    expect(result.attention).toBe(0.1);
  });

  it("short response nudges attention down", () => {
    const state = defaultState();
    state.attention = 0.5;
    const result = inferStateFromText("OK.", state);
    expect(result.attention).toBe(0.4);
  });

  it("attention does not go below 0", () => {
    const state = defaultState();
    state.attention = 0;
    const result = inferStateFromText("OK.", state);
    expect(result.attention).toBe(0);
  });

  it("hedging words nudge confidence down", () => {
    const result = inferStateFromText(
      "Maybe that could work, I think it might be fine.",
      defaultState(),
    );
    expect(result.confidence).toBe(0.4);
  });

  it("definitive words nudge confidence up", () => {
    const result = inferStateFromText(
      "That is absolutely the right approach, definitely.",
      defaultState(),
    );
    expect(result.confidence).toBe(0.6);
  });

  it("mixed hedging and definitive does not nudge confidence", () => {
    const result = inferStateFromText(
      "Maybe, but I'm absolutely certain about this part.",
      defaultState(),
    );
    expect(result.confidence).toBeUndefined();
  });

  it("informal markers nudge social_distance down", () => {
    const result = inferStateFromText("That's awesome! Let me think...", defaultState());
    // exclamation (-0.05) + ellipsis (-0.05) = -0.10
    expect(result.social_distance).toBe(0.4);
  });

  it("neutral text returns empty object", () => {
    // 50-200 chars, no keywords, no question marks, no informal markers
    const neutral =
      "The process involves several sequential steps that produce the desired output for the system.";
    const result = inferStateFromText(neutral, defaultState());
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("nudges respect upper bounds", () => {
    const state = defaultState();
    state.affect_valence = 0.95;
    state.curiosity = 0.95;
    state.confidence = 0.95;
    const result = inferStateFromText(
      "I'm so happy! What do you think? That is definitely right.",
      state,
    );
    expect(result.affect_valence).toBeLessThanOrEqual(1);
    expect(result.curiosity).toBeLessThanOrEqual(1);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it("nudges respect lower bounds", () => {
    const state = defaultState();
    state.affect_valence = -0.95;
    state.confidence = 0.05;
    const result = inferStateFromText(
      "I'm sorry, this is unfortunately quite difficult. I think maybe we should reconsider.",
      state,
    );
    expect(result.affect_valence).toBeGreaterThanOrEqual(-1);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });

  it("mixed signals combine correctly across fields", () => {
    const text =
      "I'm really happy about this! What do you think? " +
      "It definitely seems like the right path, and I'd love to explore further... " +
      "The implications are quite fascinating and worth investigating in detail across multiple dimensions.";
    const result = inferStateFromText(text, defaultState());

    // positive → valence up
    expect(result.affect_valence).toBe(0.15);
    // question mark → curiosity up
    expect(result.curiosity).toBe(0.1);
    // "definitely" → confidence up
    expect(result.confidence).toBe(0.6);
    // long text → attention up
    expect(result.attention).toBe(0.1);
    // !, ... → social_distance down
    expect(result.social_distance).toBe(0.4);
  });
});
