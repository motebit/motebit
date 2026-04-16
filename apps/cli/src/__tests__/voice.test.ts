/**
 * VoiceController — opt-in lifecycle and provider dispatch.
 *
 * These tests exercise the controller's opt-in state machine and the
 * provider dispatch. They do NOT exercise real audio playback —
 * `spawn`/`afplay`/`say` are CLI-integration shapes; covering them here
 * would be fragile and OS-dependent. The controller's contract is what
 * `/voice` and `/say` depend on.
 */

import { describe, it, expect, vi } from "vitest";
import type { TTSProvider } from "@motebit/voice";

import { VoiceController } from "../voice.js";

function makeMockProvider(): TTSProvider & { speakCalls: string[] } {
  const speakCalls: string[] = [];
  let speaking = false;
  return {
    speakCalls,
    get speaking() {
      return speaking;
    },
    async speak(text: string) {
      speaking = true;
      speakCalls.push(text);
      speaking = false;
    },
    cancel() {
      speaking = false;
    },
  };
}

describe("VoiceController", () => {
  it("starts disabled by default (off is the safe default)", () => {
    const vc = new VoiceController({ provider: makeMockProvider() });
    expect(vc.enabled).toBe(false);
  });

  it("speakIfEnabled is a no-op when disabled", async () => {
    const provider = makeMockProvider();
    const vc = new VoiceController({ provider });
    const result = await vc.speakIfEnabled("hello world");
    expect(result.spoke).toBe(false);
    expect(provider.speakCalls).toEqual([]);
  });

  it("speakIfEnabled speaks when enabled", async () => {
    const provider = makeMockProvider();
    const vc = new VoiceController({ provider, enabled: true });
    const result = await vc.speakIfEnabled("hello world");
    expect(result.spoke).toBe(true);
    expect(provider.speakCalls).toEqual(["hello world"]);
  });

  it("enable()/disable() toggles state", () => {
    const vc = new VoiceController({ provider: makeMockProvider() });
    vc.enable();
    expect(vc.enabled).toBe(true);
    vc.disable();
    expect(vc.enabled).toBe(false);
  });

  it("speak() always speaks regardless of enabled flag — explicit /say path", async () => {
    const provider = makeMockProvider();
    const vc = new VoiceController({ provider, enabled: false });
    const result = await vc.speak("explicit");
    expect(result.spoke).toBe(true);
    expect(provider.speakCalls).toEqual(["explicit"]);
  });

  it("swallows provider errors and surfaces them to the caller", async () => {
    const provider: TTSProvider = {
      speaking: false,
      speak: vi.fn(() => Promise.reject(new Error("API key invalid"))),
      cancel: vi.fn(),
    };
    const vc = new VoiceController({ provider, enabled: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await vc.speakIfEnabled("fail me");
    expect(result.spoke).toBe(false);
    expect(result.error).toContain("API key invalid");
    warnSpy.mockRestore();
  });

  it("speak with empty text is a no-op", async () => {
    const provider = makeMockProvider();
    const vc = new VoiceController({ provider, enabled: true });
    const result = await vc.speak("   ");
    expect(result.spoke).toBe(false);
    expect(provider.speakCalls).toEqual([]);
  });

  it("disable() cancels ongoing playback", () => {
    const cancel = vi.fn();
    const provider: TTSProvider = {
      speaking: true,
      speak: vi.fn(() => Promise.resolve()),
      cancel,
    };
    const vc = new VoiceController({ provider, enabled: true });
    vc.disable();
    expect(cancel).toHaveBeenCalled();
  });
});
