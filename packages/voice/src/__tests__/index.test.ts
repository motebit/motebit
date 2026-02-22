import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TTSProvider, TTSOptions } from "../tts.js";
import type { STTProvider } from "../stt.js";
import { WebSpeechTTSProvider } from "../web-speech-tts.js";
import { WebSpeechSTTProvider } from "../web-speech-stt.js";
import { FallbackTTSProvider } from "../fallback-tts.js";

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

  it("sets permission denied on service-not-allowed error", () => {
    const provider = new WebSpeechSTTProvider();
    const onError = vi.fn();
    provider.onError = onError;
    provider.start();

    const recognition = (provider as unknown as { _recognition: MockRecognition })
      ._recognition;
    recognition.onerror?.({ error: "service-not-allowed" });
    expect(onError).toHaveBeenCalledWith("service-not-allowed");

    // Subsequent start should fail immediately
    provider.stop();
    provider.start();
    expect(onError).toHaveBeenCalledWith("Microphone permission denied");
  });

  it("start() is no-op if already listening", () => {
    const provider = new WebSpeechSTTProvider();
    provider.start();
    expect(provider.listening).toBe(true);

    // Second start should not throw or change state
    provider.start();
    expect(provider.listening).toBe(true);
  });

  it("fires onResult with transcript and isFinal flag", () => {
    const provider = new WebSpeechSTTProvider();
    const onResult = vi.fn();
    provider.onResult = onResult;
    provider.start({ interimResults: true });

    const recognition = (provider as unknown as { _recognition: MockRecognition })
      ._recognition;

    // Simulate interim result
    recognition.onresult?.({
      results: {
        length: 1,
        0: { 0: { transcript: "hello" }, isFinal: false, length: 1 },
      },
    } as unknown as SpeechRecognitionEvent);

    expect(onResult).toHaveBeenCalledWith("hello", false);

    // Simulate final result
    recognition.onresult?.({
      results: {
        length: 1,
        0: { 0: { transcript: "hello world" }, isFinal: true, length: 1 },
      },
    } as unknown as SpeechRecognitionEvent);

    expect(onResult).toHaveBeenCalledWith("hello world", true);
  });

  it("auto-restarts in continuous mode after recognition ends", () => {
    const provider = new WebSpeechSTTProvider();
    provider.start({ continuous: true });
    expect(provider.listening).toBe(true);

    // Simulate recognition ending (not manual stop)
    const recognition = (provider as unknown as { _recognition: MockRecognition })
      ._recognition;
    recognition.onend?.();

    // Should have restarted — listening should be true again
    expect(provider.listening).toBe(true);
  });

  it("does not auto-restart after permission denied in continuous mode", () => {
    const provider = new WebSpeechSTTProvider();
    const onEnd = vi.fn();
    provider.onEnd = onEnd;
    provider.start({ continuous: true });

    const recognition = (provider as unknown as { _recognition: MockRecognition })
      ._recognition;

    // Simulate permission denied
    recognition.onerror?.({ error: "not-allowed" });
    // Simulate recognition ending
    recognition.onend?.();

    expect(provider.listening).toBe(false);
    expect(onEnd).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// FallbackTTSProvider
// ---------------------------------------------------------------------------

describe("FallbackTTSProvider", () => {
  function makeMockProvider(options?: {
    speakFail?: Error;
    speakDelay?: number;
  }): TTSProvider {
    let _speaking = false;
    return {
      speak: vi.fn(async () => {
        if (options?.speakFail) throw options.speakFail;
        _speaking = true;
        if (options?.speakDelay) {
          await new Promise((r) => setTimeout(r, options.speakDelay));
        }
        _speaking = false;
      }),
      cancel: vi.fn(() => {
        _speaking = false;
      }),
      get speaking() {
        return _speaking;
      },
    };
  }

  it("implements TTSProvider interface", () => {
    const provider: TTSProvider = new FallbackTTSProvider([]);
    expect(typeof provider.speak).toBe("function");
    expect(typeof provider.cancel).toBe("function");
    expect(typeof provider.speaking).toBe("boolean");
  });

  it("speaking is false when no active provider", () => {
    const provider = new FallbackTTSProvider([]);
    expect(provider.speaking).toBe(false);
  });

  it("uses first provider when it succeeds", async () => {
    const p1 = makeMockProvider();
    const p2 = makeMockProvider();
    const provider = new FallbackTTSProvider([p1, p2]);

    await provider.speak("hello");

    expect(p1.speak).toHaveBeenCalledWith("hello", undefined);
    expect(p2.speak).not.toHaveBeenCalled();
  });

  it("passes options to the active provider", async () => {
    const p1 = makeMockProvider();
    const opts: TTSOptions = { rate: 1.5, pitch: 0.8 };
    const provider = new FallbackTTSProvider([p1]);

    await provider.speak("test", opts);

    expect(p1.speak).toHaveBeenCalledWith("test", opts);
  });

  it("falls back to second provider when first fails", async () => {
    const p1 = makeMockProvider({ speakFail: new Error("p1 failed") });
    const p2 = makeMockProvider();
    const provider = new FallbackTTSProvider([p1, p2]);

    await provider.speak("fallback");

    expect(p1.speak).toHaveBeenCalled();
    expect(p2.speak).toHaveBeenCalledWith("fallback", undefined);
  });

  it("falls back to third provider when first two fail", async () => {
    const p1 = makeMockProvider({ speakFail: new Error("p1 failed") });
    const p2 = makeMockProvider({ speakFail: new Error("p2 failed") });
    const p3 = makeMockProvider();
    const provider = new FallbackTTSProvider([p1, p2, p3]);

    await provider.speak("deep fallback");

    expect(p1.speak).toHaveBeenCalled();
    expect(p2.speak).toHaveBeenCalled();
    expect(p3.speak).toHaveBeenCalledWith("deep fallback", undefined);
  });

  it("throws last error when all providers fail", async () => {
    const p1 = makeMockProvider({ speakFail: new Error("p1 failed") });
    const p2 = makeMockProvider({ speakFail: new Error("p2 failed") });
    const provider = new FallbackTTSProvider([p1, p2]);

    await expect(provider.speak("fail")).rejects.toThrow("p2 failed");
  });

  it("resolves without error for empty provider list", async () => {
    const provider = new FallbackTTSProvider([]);
    // No providers, no lastError — should resolve silently
    await provider.speak("nothing");
  });

  it("cancel() cancels the active provider", async () => {
    const cancelFn = vi.fn();
    const holder: { resolve: (() => void) | null } = { resolve: null };
    const p1: TTSProvider = {
      speak: vi.fn(() => new Promise<void>((r) => { holder.resolve = r; })),
      cancel: cancelFn,
      get speaking() { return true; },
    };
    const provider = new FallbackTTSProvider([p1]);

    // Start speaking (will hang until resolved)
    const speakPromise = provider.speak("cancel me");
    provider.cancel();

    expect(cancelFn).toHaveBeenCalled();

    // Resolve the hung promise to clean up
    holder.resolve?.();
    await speakPromise;
  });

  it("cancel() is safe when no active provider", () => {
    const provider = new FallbackTTSProvider([]);
    expect(() => provider.cancel()).not.toThrow();
  });

  it("cancel() nulls the active provider reference", () => {
    const p1 = makeMockProvider();
    const provider = new FallbackTTSProvider([p1]);

    // Set active provider by inspecting internals
    (provider as unknown as { _activeProvider: TTSProvider | null })._activeProvider = p1;
    provider.cancel();
    expect(
      (provider as unknown as { _activeProvider: TTSProvider | null })._activeProvider,
    ).toBeNull();
  });

  it("wraps non-Error throws in Error", async () => {
    const p1: TTSProvider = {
      speak: vi.fn(async () => { throw "string error"; }),
      cancel: vi.fn(),
      get speaking() { return false; },
    };
    const provider = new FallbackTTSProvider([p1]);

    await expect(provider.speak("fail")).rejects.toThrow("string error");
  });
});
