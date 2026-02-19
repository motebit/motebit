import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TTSProvider } from "../tts.js";
import type { STTProvider } from "../stt.js";
import { WebSpeechTTSProvider } from "../web-speech-tts.js";
import { WebSpeechSTTProvider } from "../web-speech-stt.js";

// ---------------------------------------------------------------------------
// Browser API mocks
// ---------------------------------------------------------------------------

/**
 * Minimal SpeechSynthesisUtterance mock.
 * Captures property assignments and fires lifecycle callbacks.
 */
class MockUtterance {
  text: string;
  voice: SpeechSynthesisVoice | null = null;
  rate = 1;
  pitch = 1;
  volume = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

function makeMockVoice(
  name: string,
  lang: string,
): SpeechSynthesisVoice {
  return {
    name,
    lang,
    voiceURI: name,
    localService: true,
    default: false,
  };
}

const mockVoices: SpeechSynthesisVoice[] = [
  makeMockVoice("Alex", "en-US"),
  makeMockVoice("Samantha", "en-US"),
  makeMockVoice("Thomas", "fr-FR"),
];

/** Last utterance passed to `speechSynthesis.speak()`. */
let lastUtterance: MockUtterance | null = null;

function installSpeechSynthesisMock(): void {
  lastUtterance = null;

  const synthesis = {
    getVoices: () => mockVoices,
    speak: (u: MockUtterance) => {
      lastUtterance = u;
      // Simulate async start then immediate end.
      u.onstart?.();
      u.onend?.();
    },
    cancel: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  Object.defineProperty(globalThis, "speechSynthesis", {
    value: synthesis,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    value: MockUtterance,
    writable: true,
    configurable: true,
  });
}

/** Minimal SpeechRecognition mock. */
class MockRecognition {
  lang = "en-US";
  continuous = false;
  interimResults = false;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => {
    this.onend?.();
  });
  abort = vi.fn();
}

function installSpeechRecognitionMock(): void {
  Object.defineProperty(globalThis, "window", {
    value: globalThis,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(globalThis, "SpeechRecognition", {
    value: MockRecognition,
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

describe("WebSpeechTTSProvider", () => {
  beforeEach(() => {
    installSpeechSynthesisMock();
  });

  it("implements TTSProvider interface", () => {
    const provider: TTSProvider = new WebSpeechTTSProvider();
    expect(typeof provider.speak).toBe("function");
    expect(typeof provider.cancel).toBe("function");
    expect(typeof provider.speaking).toBe("boolean");
  });

  it("resolves speak() when utterance ends", async () => {
    const provider = new WebSpeechTTSProvider();
    await provider.speak("hello world");
    // If we get here, the promise resolved.
    expect(provider.speaking).toBe(false);
  });

  it("selects preferred voice when available", async () => {
    const provider = new WebSpeechTTSProvider(["Samantha", "Karen"]);
    await provider.speak("test");
    expect(lastUtterance?.voice?.name).toBe("Samantha");
  });

  it("falls back to English voice when preferred not found", async () => {
    const provider = new WebSpeechTTSProvider(["NonExistent"]);
    await provider.speak("test");
    // Should pick first English voice.
    expect(lastUtterance?.voice?.lang.startsWith("en")).toBe(true);
  });

  it("applies rate/pitch/volume options", async () => {
    const provider = new WebSpeechTTSProvider();
    await provider.speak("test", { rate: 1.5, pitch: 0.8, volume: 0.5 });
    expect(lastUtterance?.rate).toBe(1.5);
    expect(lastUtterance?.pitch).toBe(0.8);
    expect(lastUtterance?.volume).toBe(0.5);
  });

  it("cancel() calls speechSynthesis.cancel()", () => {
    const provider = new WebSpeechTTSProvider();
    provider.cancel();
    expect(speechSynthesis.cancel).toHaveBeenCalled();
    expect(provider.speaking).toBe(false);
  });

  it("rejects speak() on utterance error", async () => {
    // Override mock to fire onerror instead of onend.
    (
      speechSynthesis as unknown as { speak: (u: MockUtterance) => void }
    ).speak = (u: MockUtterance) => {
      lastUtterance = u;
      u.onstart?.();
      u.onerror?.({ error: "synthesis-failed" });
    };

    const provider = new WebSpeechTTSProvider();
    await expect(provider.speak("fail")).rejects.toThrow("TTS error");
  });

  it("resolves speak() on cancel error (not a real error)", async () => {
    (
      speechSynthesis as unknown as { speak: (u: MockUtterance) => void }
    ).speak = (u: MockUtterance) => {
      lastUtterance = u;
      u.onstart?.();
      u.onerror?.({ error: "canceled" });
    };

    const provider = new WebSpeechTTSProvider();
    // Should resolve, not reject.
    await provider.speak("cancelled");
    expect(provider.speaking).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// STT
// ---------------------------------------------------------------------------

describe("WebSpeechSTTProvider", () => {
  beforeEach(() => {
    installSpeechRecognitionMock();
  });

  it("implements STTProvider interface", () => {
    const provider: STTProvider = new WebSpeechSTTProvider();
    expect(typeof provider.start).toBe("function");
    expect(typeof provider.stop).toBe("function");
    expect(typeof provider.listening).toBe("boolean");
    expect(provider.onResult).toBeNull();
    expect(provider.onError).toBeNull();
    expect(provider.onEnd).toBeNull();
  });

  it("start() sets listening to true", () => {
    const provider = new WebSpeechSTTProvider();
    provider.start();
    expect(provider.listening).toBe(true);
  });

  it("stop() sets listening to false and fires onEnd", () => {
    const provider = new WebSpeechSTTProvider();
    const onEnd = vi.fn();
    provider.onEnd = onEnd;
    provider.start();
    provider.stop();
    expect(provider.listening).toBe(false);
    expect(onEnd).toHaveBeenCalled();
  });

  it("fires onError for missing API", () => {
    // Remove SpeechRecognition from global scope.
    Object.defineProperty(globalThis, "SpeechRecognition", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, "window", {
      value: {},
      writable: true,
      configurable: true,
    });

    const provider = new WebSpeechSTTProvider();
    const onError = vi.fn();
    provider.onError = onError;
    provider.start();
    expect(onError).toHaveBeenCalledWith("SpeechRecognition API not available");
    expect(provider.listening).toBe(false);
  });

  it("sets permission denied flag on not-allowed error", () => {
    const provider = new WebSpeechSTTProvider();
    const onError = vi.fn();
    provider.onError = onError;
    provider.start();

    // Simulate error from the recognition instance.
    // The mock recognition's onerror should have been wired by start().
    // We access the internal recognition via the last MockRecognition instance.
    // Since start() creates a new MockRecognition, grab it:
    const recognition = (provider as unknown as { _recognition: MockRecognition })
      ._recognition;
    recognition.onerror?.({ error: "not-allowed" });

    expect(onError).toHaveBeenCalledWith("not-allowed");

    // Now subsequent start() should fail immediately.
    const onError2 = vi.fn();
    provider.onError = onError2;
    provider.stop();
    provider.start();
    expect(onError2).toHaveBeenCalledWith("Microphone permission denied");
  });

  it("does not restart when stopped manually in continuous mode", () => {
    const provider = new WebSpeechSTTProvider();
    provider.start({ continuous: true });
    expect(provider.listening).toBe(true);

    provider.stop();
    expect(provider.listening).toBe(false);
  });
});
