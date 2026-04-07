import { describe, it, expect } from "vitest";
import { DEFAULT_VOICE_CONFIG, migrateVoiceConfig } from "../voice-config.js";

describe("migrateVoiceConfig", () => {
  it("returns a fresh default when input is null", () => {
    const result = migrateVoiceConfig(null);
    expect(result).toEqual(DEFAULT_VOICE_CONFIG);
    // fresh copy, not the frozen default reference
    expect(result).not.toBe(DEFAULT_VOICE_CONFIG);
  });

  it("returns a fresh default when input is undefined", () => {
    expect(migrateVoiceConfig(undefined)).toEqual(DEFAULT_VOICE_CONFIG);
  });

  it("returns a fresh default when input is a primitive", () => {
    expect(migrateVoiceConfig("not an object")).toEqual(DEFAULT_VOICE_CONFIG);
    expect(migrateVoiceConfig(42)).toEqual(DEFAULT_VOICE_CONFIG);
    expect(migrateVoiceConfig(true)).toEqual(DEFAULT_VOICE_CONFIG);
  });

  it("normalizes the canonical shape as-is", () => {
    const input = {
      enabled: true,
      autoSend: false,
      speakResponses: true,
      ttsVoice: "nova",
      neuralVad: false,
    };
    expect(migrateVoiceConfig(input)).toEqual(input);
  });

  it("migrates the web legacy shape {ttsVoice, autoSend, voiceResponse}", () => {
    const result = migrateVoiceConfig({
      ttsVoice: "echo",
      autoSend: false,
      voiceResponse: false,
    });
    expect(result.ttsVoice).toBe("echo");
    expect(result.autoSend).toBe(false);
    expect(result.speakResponses).toBe(false);
    // `enabled` and `neuralVad` absent → defaults
    expect(result.enabled).toBe(DEFAULT_VOICE_CONFIG.enabled);
  });

  it("migrates the mobile legacy shape with voiceEnabled + voiceAutoSend + voiceResponseEnabled + neuralVadEnabled", () => {
    const result = migrateVoiceConfig({
      voiceEnabled: true,
      voiceAutoSend: true,
      voiceResponseEnabled: true,
      neuralVadEnabled: false,
      ttsVoice: "fable",
    });
    expect(result).toEqual({
      enabled: true,
      autoSend: true,
      speakResponses: true,
      ttsVoice: "fable",
      neuralVad: false,
    });
  });

  it("migrates the desktop legacy shape {ttsVoice, voiceAutoSend, voiceResponseEnabled}", () => {
    const result = migrateVoiceConfig({
      ttsVoice: "onyx",
      voiceAutoSend: false,
      voiceResponseEnabled: true,
    });
    expect(result.ttsVoice).toBe("onyx");
    expect(result.autoSend).toBe(false);
    expect(result.speakResponses).toBe(true);
  });

  it("prefers the canonical key when both canonical and legacy keys are present", () => {
    const result = migrateVoiceConfig({
      enabled: true,
      voiceEnabled: false,
      speakResponses: true,
      voiceResponseEnabled: false,
    });
    expect(result.enabled).toBe(true);
    expect(result.speakResponses).toBe(true);
  });

  it("falls back to default when a field has the wrong type", () => {
    const result = migrateVoiceConfig({
      enabled: "yes" as unknown, // wrong type
      ttsVoice: 42 as unknown, // wrong type
    });
    expect(result.enabled).toBe(DEFAULT_VOICE_CONFIG.enabled);
    expect(result.ttsVoice).toBe(DEFAULT_VOICE_CONFIG.ttsVoice);
  });

  it("leaves neuralVad undefined when not provided (opt-in)", () => {
    const result = migrateVoiceConfig({ enabled: true });
    expect(result.neuralVad).toBeUndefined();
  });

  it("ignores unknown keys", () => {
    const result = migrateVoiceConfig({
      enabled: true,
      foo: "bar",
      baz: [1, 2, 3],
    });
    expect(result).not.toHaveProperty("foo");
    expect(result).not.toHaveProperty("baz");
  });
});
