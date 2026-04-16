import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TTSProvider } from "../tts.js";
import { ElevenLabsTTSProvider, ELEVENLABS_VOICES } from "../elevenlabs-tts.js";

// ---------------------------------------------------------------------------
// Mock AudioContext & Web Audio API
// ---------------------------------------------------------------------------

let lastSourceNode: MockBufferSourceNode | null = null;

class MockAudioBuffer {
  readonly duration = 1.5;
  readonly length = 44100;
  readonly sampleRate = 44100;
  readonly numberOfChannels = 1;
}

class MockBufferSourceNode {
  buffer: MockAudioBuffer | null = null;
  onended: (() => void) | null = null;
  connect = vi.fn();
  start = vi.fn(() => {
    setTimeout(() => this.onended?.(), 0);
  });
  stop = vi.fn();
}

class MockAudioContext {
  destination = {};
  decodeAudioData = vi.fn(async (_buf: ArrayBuffer) => new MockAudioBuffer());
  createBufferSource = vi.fn(() => {
    const node = new MockBufferSourceNode();
    lastSourceNode = node;
    return node;
  });
}

function installAudioContextMock(): void {
  lastSourceNode = null;
  Object.defineProperty(globalThis, "AudioContext", {
    value: MockAudioContext,
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

let lastFetchBody: Record<string, unknown> | null = null;
let lastFetchHeaders: Record<string, string> | null = null;
let lastFetchUrl: string | null = null;

function installFetchMock(options?: { status?: number; body?: string }): void {
  const status = options?.status ?? 200;
  const body = options?.body ?? "";

  lastFetchBody = null;
  lastFetchHeaders = null;
  lastFetchUrl = null;

  const mockFetch = vi.fn(async (url: string, init: RequestInit) => {
    lastFetchUrl = url;
    lastFetchHeaders = init.headers as Record<string, string>;
    lastFetchBody = JSON.parse(init.body as string) as Record<string, unknown>;

    if (status !== 200) {
      return {
        ok: false,
        status,
        text: async () => body,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }

    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(100),
    };
  });

  Object.defineProperty(globalThis, "fetch", {
    value: mockFetch,
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ElevenLabsTTSProvider", () => {
  beforeEach(() => {
    installAudioContextMock();
    installFetchMock();
  });

  afterEach(() => {
    lastSourceNode = null;
    lastFetchBody = null;
    lastFetchHeaders = null;
    lastFetchUrl = null;
  });

  // -------------------------------------------------------------------------
  // Interface conformance
  // -------------------------------------------------------------------------

  it("implements TTSProvider interface", () => {
    const provider: TTSProvider = new ElevenLabsTTSProvider({ apiKey: "xi-test" });
    expect(typeof provider.speak).toBe("function");
    expect(typeof provider.cancel).toBe("function");
    expect(typeof provider.speaking).toBe("boolean");
  });

  it("speaking is false initially", () => {
    const provider = new ElevenLabsTTSProvider({ apiKey: "xi-test" });
    expect(provider.speaking).toBe(false);
  });

  // -------------------------------------------------------------------------
  // API call format
  // -------------------------------------------------------------------------

  it("sends correct API request with default options", async () => {
    const provider = new ElevenLabsTTSProvider({ apiKey: "xi-test-key" });
    await provider.speak("Hello world");

    expect(lastFetchUrl).toBe(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICES.Rachel}`,
    );
    expect(lastFetchHeaders?.["xi-api-key"]).toBe("xi-test-key");
    expect(lastFetchHeaders?.["Content-Type"]).toBe("application/json");
    expect(lastFetchHeaders?.["Accept"]).toBe("audio/mpeg");
    expect(lastFetchBody).toEqual({
      text: "Hello world",
      model_id: "eleven_flash_v2_5",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        use_speaker_boost: true,
      },
    });
  });

  it("maps curated voice name to voice_id", async () => {
    const provider = new ElevenLabsTTSProvider({ apiKey: "xi-test", voice: "Adam" });
    await provider.speak("test");
    expect(lastFetchUrl).toBe(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICES.Adam}`,
    );
  });

  it("accepts raw voice_id for custom voices", async () => {
    const provider = new ElevenLabsTTSProvider({
      apiKey: "xi-test",
      voice: "customVoiceId123",
    });
    await provider.speak("test");
    expect(lastFetchUrl).toBe("https://api.elevenlabs.io/v1/text-to-speech/customVoiceId123");
  });

  it("uses custom model from config", async () => {
    const provider = new ElevenLabsTTSProvider({
      apiKey: "xi-test",
      model: "eleven_turbo_v2_5",
    });
    await provider.speak("test");
    expect(lastFetchBody?.model_id).toBe("eleven_turbo_v2_5");
  });

  it("forwards voice_settings overrides", async () => {
    const provider = new ElevenLabsTTSProvider({
      apiKey: "xi-test",
      stability: 0.2,
      similarityBoost: 0.9,
      speakerBoost: false,
    });
    await provider.speak("test");
    expect(lastFetchBody?.voice_settings).toEqual({
      stability: 0.2,
      similarity_boost: 0.9,
      use_speaker_boost: false,
    });
  });

  it("uses custom base URL", async () => {
    const provider = new ElevenLabsTTSProvider({
      apiKey: "xi-test",
      baseUrl: "https://proxy.example.com",
    });
    await provider.speak("test");
    expect(lastFetchUrl).toBe(
      `https://proxy.example.com/v1/text-to-speech/${ELEVENLABS_VOICES.Rachel}`,
    );
  });

  // -------------------------------------------------------------------------
  // Playback lifecycle
  // -------------------------------------------------------------------------

  it("resolves speak() when playback ends", async () => {
    const provider = new ElevenLabsTTSProvider({ apiKey: "xi-test" });
    await provider.speak("test");
    expect(provider.speaking).toBe(false);
  });

  it("sets speaking to true during playback", async () => {
    const ctx = new MockAudioContext();
    ctx.createBufferSource = vi.fn(() => {
      const node = new MockBufferSourceNode();
      node.start = vi.fn();
      lastSourceNode = node;
      return node;
    });

    const provider = new ElevenLabsTTSProvider({
      apiKey: "xi-test",
      audioContext: ctx as unknown as AudioContext,
    });

    const speakPromise = provider.speak("test");
    await new Promise((r) => setTimeout(r, 10));
    expect(provider.speaking).toBe(true);

    lastSourceNode?.onended?.();
    await speakPromise;
    expect(provider.speaking).toBe(false);
  });

  it("connects source node to destination and calls start(0)", async () => {
    const ctx = new MockAudioContext();
    const provider = new ElevenLabsTTSProvider({
      apiKey: "xi-test",
      audioContext: ctx as unknown as AudioContext,
    });
    await provider.speak("test");

    expect(ctx.createBufferSource).toHaveBeenCalled();
    expect(lastSourceNode?.connect).toHaveBeenCalledWith(ctx.destination);
    expect(lastSourceNode?.start).toHaveBeenCalledWith(0);
  });

  it("decodes the fetched ArrayBuffer via AudioContext", async () => {
    const ctx = new MockAudioContext();
    const provider = new ElevenLabsTTSProvider({
      apiKey: "xi-test",
      audioContext: ctx as unknown as AudioContext,
    });
    await provider.speak("decode test");

    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(1);
    const arg = ctx.decodeAudioData.mock.calls[0]![0];
    expect(arg).toBeInstanceOf(ArrayBuffer);
  });

  // -------------------------------------------------------------------------
  // AudioContext injection
  // -------------------------------------------------------------------------

  it("uses injected AudioContext instead of creating one", async () => {
    const ctx = new MockAudioContext();
    const provider = new ElevenLabsTTSProvider({
      apiKey: "xi-test",
      audioContext: ctx as unknown as AudioContext,
    });
    await provider.speak("injected context");
    expect(ctx.decodeAudioData).toHaveBeenCalled();
  });

  it("creates AudioContext lazily when none injected", async () => {
    const provider = new ElevenLabsTTSProvider({ apiKey: "xi-test" });
    await provider.speak("lazy context");
    expect(provider.speaking).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it("throws on non-200 API response", async () => {
    installFetchMock({ status: 429, body: "Rate limited" });
    const provider = new ElevenLabsTTSProvider({ apiKey: "xi-test" });
    await expect(provider.speak("fail")).rejects.toThrow("ElevenLabs TTS error: 429");
    expect(provider.speaking).toBe(false);
  });

  it("includes response body in error message", async () => {
    installFetchMock({ status: 401, body: "Invalid API key" });
    const provider = new ElevenLabsTTSProvider({ apiKey: "xi-bad" });
    await expect(provider.speak("auth fail")).rejects.toThrow(
      "ElevenLabs TTS error: 401 — Invalid API key",
    );
  });

  it("throws on decodeAudioData failure", async () => {
    const ctx = new MockAudioContext();
    ctx.decodeAudioData = vi.fn(async () => {
      throw new Error("Unable to decode audio data");
    });
    const provider = new ElevenLabsTTSProvider({
      apiKey: "xi-test",
      audioContext: ctx as unknown as AudioContext,
    });
    await expect(provider.speak("bad audio")).rejects.toThrow("Unable to decode audio data");
    expect(provider.speaking).toBe(false);
  });

  it("resets speaking to false on fetch network error", async () => {
    Object.defineProperty(globalThis, "fetch", {
      value: vi.fn(async () => {
        throw new Error("Network error");
      }),
      writable: true,
      configurable: true,
    });
    const provider = new ElevenLabsTTSProvider({ apiKey: "xi-test" });
    await expect(provider.speak("offline")).rejects.toThrow("Network error");
    expect(provider.speaking).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Cancel
  // -------------------------------------------------------------------------

  it("cancel() stops the source node and resets state", async () => {
    const ctx = new MockAudioContext();
    ctx.createBufferSource = vi.fn(() => {
      const node = new MockBufferSourceNode();
      node.start = vi.fn();
      lastSourceNode = node;
      return node;
    });
    const provider = new ElevenLabsTTSProvider({
      apiKey: "xi-test",
      audioContext: ctx as unknown as AudioContext,
    });

    const speakPromise = provider.speak("cancel me");
    await new Promise((r) => setTimeout(r, 10));

    provider.cancel();
    expect(provider.speaking).toBe(false);
    expect(lastSourceNode?.stop).toHaveBeenCalled();

    try {
      await speakPromise;
    } catch {
      // Cancel resolves or rejects — either is fine.
    }
  });

  it("cancel() before playback starts resolves speak() early", async () => {
    Object.defineProperty(globalThis, "fetch", {
      value: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(100),
        };
      }),
      writable: true,
      configurable: true,
    });
    const provider = new ElevenLabsTTSProvider({ apiKey: "xi-test" });
    const speakPromise = provider.speak("cancel early");
    provider.cancel();
    expect(provider.speaking).toBe(false);
    await speakPromise;
    expect(provider.speaking).toBe(false);
  });

  it("cancel() is idempotent — no error on double cancel", () => {
    const provider = new ElevenLabsTTSProvider({ apiKey: "xi-test" });
    provider.cancel();
    provider.cancel();
    expect(provider.speaking).toBe(false);
  });

  // -------------------------------------------------------------------------
  // ELEVENLABS_VOICES export
  // -------------------------------------------------------------------------

  it("exports the curated voice map", () => {
    expect(Object.keys(ELEVENLABS_VOICES)).toEqual([
      "Rachel",
      "Adam",
      "Charlotte",
      "George",
      "Sarah",
      "Liam",
      "Matilda",
      "Daniel",
    ]);
    // Every value should be a non-empty ID string.
    for (const id of Object.values(ELEVENLABS_VOICES)) {
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    }
  });
});
