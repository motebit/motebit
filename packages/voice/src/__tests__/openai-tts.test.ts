import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TTSProvider } from "../tts.js";
import { OpenAITTSProvider, TTS_VOICES } from "../openai-tts.js";

// ---------------------------------------------------------------------------
// Mock AudioContext & Web Audio API
// ---------------------------------------------------------------------------

/** Captured source node from the mock AudioContext. */
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
    // Simulate immediate playback completion.
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

/** Last request body sent to fetch. */
let lastFetchBody: Record<string, unknown> | null = null;
let lastFetchHeaders: Record<string, string> | null = null;
let lastFetchUrl: string | null = null;

function installFetchMock(options?: {
  status?: number;
  body?: string;
}): void {
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

    // Return a small ArrayBuffer simulating MP3 data.
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

describe("OpenAITTSProvider", () => {
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
    const provider: TTSProvider = new OpenAITTSProvider({ apiKey: "sk-test" });
    expect(typeof provider.speak).toBe("function");
    expect(typeof provider.cancel).toBe("function");
    expect(typeof provider.speaking).toBe("boolean");
  });

  it("speaking is false initially", () => {
    const provider = new OpenAITTSProvider({ apiKey: "sk-test" });
    expect(provider.speaking).toBe(false);
  });

  // -------------------------------------------------------------------------
  // API call format
  // -------------------------------------------------------------------------

  it("sends correct API request with default options", async () => {
    const provider = new OpenAITTSProvider({ apiKey: "sk-test-key" });
    await provider.speak("Hello world");

    expect(lastFetchUrl).toBe("https://api.openai.com/v1/audio/speech");
    expect(lastFetchHeaders?.["Authorization"]).toBe("Bearer sk-test-key");
    expect(lastFetchHeaders?.["Content-Type"]).toBe("application/json");
    expect(lastFetchBody).toEqual({
      model: "tts-1",
      voice: "alloy",
      input: "Hello world",
      response_format: "mp3",
    });
  });

  it("uses custom voice and model from config", async () => {
    const provider = new OpenAITTSProvider({
      apiKey: "sk-custom",
      voice: "nova",
      model: "tts-1-hd",
    });
    await provider.speak("Custom voice");

    expect(lastFetchBody?.voice).toBe("nova");
    expect(lastFetchBody?.model).toBe("tts-1-hd");
  });

  it("uses custom base URL", async () => {
    const provider = new OpenAITTSProvider({
      apiKey: "sk-proxy",
      baseUrl: "https://proxy.example.com",
    });
    await provider.speak("Proxied");

    expect(lastFetchUrl).toBe("https://proxy.example.com/v1/audio/speech");
  });

  // -------------------------------------------------------------------------
  // Playback lifecycle
  // -------------------------------------------------------------------------

  it("resolves speak() when playback ends", async () => {
    const provider = new OpenAITTSProvider({ apiKey: "sk-test" });
    await provider.speak("test");
    expect(provider.speaking).toBe(false);
  });

  it("sets speaking to true during playback", async () => {
    // Use a source node that does not auto-complete.
    const ctx = new MockAudioContext();
    ctx.createBufferSource = vi.fn(() => {
      const node = new MockBufferSourceNode();
      // Override start so it does NOT fire onended.
      node.start = vi.fn();
      lastSourceNode = node;
      return node;
    });

    const provider = new OpenAITTSProvider({
      apiKey: "sk-test",
      audioContext: ctx as unknown as AudioContext,
    });

    // Start speak in background — it will block on the playback promise.
    const speakPromise = provider.speak("test");

    // Wait a tick for the fetch + decode to complete.
    await new Promise((r) => setTimeout(r, 10));
    expect(provider.speaking).toBe(true);

    // Simulate playback end.
    lastSourceNode?.onended?.();
    await speakPromise;
    expect(provider.speaking).toBe(false);
  });

  it("connects source node to destination and calls start(0)", async () => {
    const ctx = new MockAudioContext();
    const provider = new OpenAITTSProvider({
      apiKey: "sk-test",
      audioContext: ctx as unknown as AudioContext,
    });
    await provider.speak("test");

    expect(ctx.createBufferSource).toHaveBeenCalled();
    expect(lastSourceNode?.connect).toHaveBeenCalledWith(ctx.destination);
    expect(lastSourceNode?.start).toHaveBeenCalledWith(0);
  });

  it("decodes the fetched ArrayBuffer via AudioContext", async () => {
    const ctx = new MockAudioContext();
    const provider = new OpenAITTSProvider({
      apiKey: "sk-test",
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
    const provider = new OpenAITTSProvider({
      apiKey: "sk-test",
      audioContext: ctx as unknown as AudioContext,
    });
    await provider.speak("injected context");

    // Should have used the injected context.
    expect(ctx.decodeAudioData).toHaveBeenCalled();
  });

  it("creates AudioContext lazily when none injected", async () => {
    const provider = new OpenAITTSProvider({ apiKey: "sk-test" });
    await provider.speak("lazy context");

    // The global MockAudioContext should have been instantiated.
    // If it wasn't, decodeAudioData would not have been callable.
    expect(provider.speaking).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it("throws on non-200 API response", async () => {
    installFetchMock({ status: 429, body: "Rate limited" });

    const provider = new OpenAITTSProvider({ apiKey: "sk-test" });
    await expect(provider.speak("fail")).rejects.toThrow("OpenAI TTS error: 429");
    expect(provider.speaking).toBe(false);
  });

  it("includes response body in error message", async () => {
    installFetchMock({ status: 401, body: "Invalid API key" });

    const provider = new OpenAITTSProvider({ apiKey: "sk-bad" });
    await expect(provider.speak("auth fail")).rejects.toThrow(
      "OpenAI TTS error: 401 — Invalid API key",
    );
  });

  it("throws on decodeAudioData failure", async () => {
    const ctx = new MockAudioContext();
    ctx.decodeAudioData = vi.fn(async () => {
      throw new Error("Unable to decode audio data");
    });

    const provider = new OpenAITTSProvider({
      apiKey: "sk-test",
      audioContext: ctx as unknown as AudioContext,
    });
    await expect(provider.speak("bad audio")).rejects.toThrow(
      "Unable to decode audio data",
    );
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

    const provider = new OpenAITTSProvider({ apiKey: "sk-test" });
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
      // Don't auto-complete.
      node.start = vi.fn();
      lastSourceNode = node;
      return node;
    });

    const provider = new OpenAITTSProvider({
      apiKey: "sk-test",
      audioContext: ctx as unknown as AudioContext,
    });

    const speakPromise = provider.speak("cancel me");
    await new Promise((r) => setTimeout(r, 10));

    provider.cancel();
    expect(provider.speaking).toBe(false);

    // The source node should have been stopped.
    expect(lastSourceNode?.stop).toHaveBeenCalled();

    // Resolve the lingering promise by firing onended on the (now-stopped) node.
    // In practice, stop() fires onended, but our mock doesn't auto-fire it.
    // The promise may already be resolved by cancel's early exit in the next tick.
    // We just ensure no unhandled rejection.
    try {
      await speakPromise;
    } catch {
      // Cancel may cause the promise to resolve or reject — both are fine.
    }
  });

  it("cancel() before playback starts resolves speak() early", async () => {
    // Use a slow fetch so we can cancel before audio plays.
    Object.defineProperty(globalThis, "fetch", {
      value: vi.fn(async () => {
        // Simulate slow response.
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

    const provider = new OpenAITTSProvider({ apiKey: "sk-test" });
    const speakPromise = provider.speak("cancel early");

    // Cancel immediately.
    provider.cancel();
    expect(provider.speaking).toBe(false);

    await speakPromise;
    expect(provider.speaking).toBe(false);
  });

  it("cancel() is idempotent — no error on double cancel", () => {
    const provider = new OpenAITTSProvider({ apiKey: "sk-test" });
    provider.cancel();
    provider.cancel();
    expect(provider.speaking).toBe(false);
  });

  // -------------------------------------------------------------------------
  // TTS_VOICES export
  // -------------------------------------------------------------------------

  it("exports the list of available voices", () => {
    expect(TTS_VOICES).toEqual([
      "alloy",
      "echo",
      "fable",
      "onyx",
      "nova",
      "shimmer",
    ]);
  });
});
