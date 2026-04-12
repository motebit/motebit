import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture each speak() call so we can trigger onDone / onError / onStopped
interface SpeakCall {
  text: string;
  options: {
    rate?: number;
    pitch?: number;
    volume?: number;
    voice?: string;
    onDone?: () => void;
    onError?: (err: { message: string }) => void;
    onStopped?: () => void;
  };
}
const hoisted = vi.hoisted(() => ({
  speakCalls: [] as SpeakCall[],
  stopSpy: vi.fn(),
}));
const speakCalls = hoisted.speakCalls;
const stopSpy = hoisted.stopSpy;

vi.mock("expo-speech", () => ({
  speak: vi.fn((text: string, options: SpeakCall["options"]) => {
    hoisted.speakCalls.push({ text, options });
  }),
  stop: hoisted.stopSpy,
}));

import { ExpoSpeechTTSProvider } from "../adapters/expo-speech-tts";

beforeEach(() => {
  speakCalls.length = 0;
  stopSpy.mockClear();
});

describe("ExpoSpeechTTSProvider", () => {
  it("starts not speaking", () => {
    const tts = new ExpoSpeechTTSProvider();
    expect(tts.speaking).toBe(false);
  });

  it("resolves on onDone and marks not speaking", async () => {
    const tts = new ExpoSpeechTTSProvider();
    const p = tts.speak("hello", { rate: 1.1, pitch: 1.2, volume: 0.8, voice: "v1" });
    expect(tts.speaking).toBe(true);
    // Trigger onDone
    speakCalls[0]?.options.onDone?.();
    await p;
    expect(tts.speaking).toBe(false);
    expect(speakCalls[0]?.text).toBe("hello");
    expect(speakCalls[0]?.options.rate).toBe(1.1);
  });

  it("resolves on onStopped", async () => {
    const tts = new ExpoSpeechTTSProvider();
    const p = tts.speak("bye");
    speakCalls[0]?.options.onStopped?.();
    await p;
    expect(tts.speaking).toBe(false);
  });

  it("rejects on onError", async () => {
    const tts = new ExpoSpeechTTSProvider();
    const p = tts.speak("oops");
    speakCalls[0]?.options.onError?.({ message: "broken" });
    await expect(p).rejects.toThrow(/broken/);
    expect(tts.speaking).toBe(false);
  });

  it("cancel calls Speech.stop and clears speaking", () => {
    const tts = new ExpoSpeechTTSProvider();
    void tts.speak("something");
    tts.cancel();
    expect(stopSpy).toHaveBeenCalled();
    expect(tts.speaking).toBe(false);
  });

  it("uses default rate/pitch/volume if not provided", async () => {
    const tts = new ExpoSpeechTTSProvider();
    const p = tts.speak("default");
    speakCalls[0]?.options.onDone?.();
    await p;
    expect(speakCalls[0]?.options.rate).toBe(1.0);
    expect(speakCalls[0]?.options.pitch).toBe(1.0);
    expect(speakCalls[0]?.options.volume).toBe(0.9);
  });
});
