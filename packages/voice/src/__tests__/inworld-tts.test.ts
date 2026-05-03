import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TTSProvider } from "../tts.js";
import { InworldTTSProvider, INWORLD_TTS_MODELS } from "../inworld-tts.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let lastSourceNode: MockBufferSourceNode | null = null;

class MockAudioBuffer {
  readonly duration = 1;
  readonly length = 24000;
  readonly sampleRate = 24000;
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

let lastFetchUrl: string | null = null;
let lastFetchHeaders: Record<string, string> | null = null;
let lastFetchBody: Record<string, unknown> | null = null;

function installFetchMock(options?: {
  status?: number;
  text?: string;
  json?: Record<string, unknown> | null;
}): void {
  const status = options?.status ?? 200;
  const text = options?.text ?? "";
  // base64 of "fake-mp3-bytes" — not a real MP3 but enough to exercise the
  // base64 → ArrayBuffer decoding path; the mock decodeAudioData accepts
  // any ArrayBuffer regardless of contents.
  const json = options?.json ?? { audioContent: btoa("fake-mp3-bytes") };
  lastFetchUrl = null;
  lastFetchHeaders = null;
  lastFetchBody = null;

  Object.defineProperty(globalThis, "fetch", {
    value: vi.fn(async (url: string, init: RequestInit) => {
      lastFetchUrl = url;
      lastFetchHeaders = init.headers as Record<string, string>;
      lastFetchBody = JSON.parse(init.body as string) as Record<string, unknown>;
      if (status !== 200) {
        return { ok: false, status, text: async () => text, json: async () => json };
      }
      return {
        ok: true,
        status: 200,
        json: async () => json,
      };
    }),
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InworldTTSProvider", () => {
  beforeEach(() => {
    installAudioContextMock();
    installFetchMock();
  });
  afterEach(() => {
    lastSourceNode = null;
    lastFetchUrl = null;
    lastFetchHeaders = null;
    lastFetchBody = null;
  });

  it("implements TTSProvider interface", () => {
    const p: TTSProvider = new InworldTTSProvider({ apiKey: "iw-test" });
    expect(typeof p.speak).toBe("function");
    expect(typeof p.cancel).toBe("function");
    expect(p.speaking).toBe(false);
  });

  it("POSTs to /tts/v1/voice with Basic auth + JSON body", async () => {
    const p = new InworldTTSProvider({ apiKey: "iw-test-key" });
    await p.speak("Hello world");
    expect(lastFetchUrl).toBe("https://api.inworld.ai/tts/v1/voice");
    expect(lastFetchHeaders?.Authorization).toBe("Basic iw-test-key");
    expect(lastFetchHeaders?.["Content-Type"]).toBe("application/json");
    expect(lastFetchBody?.text).toBe("Hello world");
    expect(lastFetchBody?.voiceId).toBe("Dennis");
    expect(lastFetchBody?.modelId).toBe("inworld-tts-1.5-max");
    expect((lastFetchBody?.audioConfig as Record<string, unknown>).audioEncoding).toBe("MP3");
    expect((lastFetchBody?.audioConfig as Record<string, unknown>).sampleRateHertz).toBe(24000);
    expect((lastFetchBody?.audioConfig as Record<string, unknown>).speakingRate).toBe(1.0);
    expect(lastFetchBody?.temperature).toBe(1.0);
  });

  it("uses configured voice + model + speakingRate + temperature", async () => {
    const p = new InworldTTSProvider({
      apiKey: "iw",
      voice: "Sophia",
      model: "inworld-tts-1.5-mini",
      speakingRate: 1.2,
      temperature: 0.5,
    });
    await p.speak("test");
    expect(lastFetchBody?.voiceId).toBe("Sophia");
    expect(lastFetchBody?.modelId).toBe("inworld-tts-1.5-mini");
    expect((lastFetchBody?.audioConfig as Record<string, unknown>).speakingRate).toBe(1.2);
    expect(lastFetchBody?.temperature).toBe(0.5);
  });

  it("uses custom baseUrl", async () => {
    const p = new InworldTTSProvider({ apiKey: "iw", baseUrl: "https://proxy.example.com" });
    await p.speak("test");
    expect(lastFetchUrl).toBe("https://proxy.example.com/tts/v1/voice");
  });

  it("decodes base64 audioContent and resolves on playback end", async () => {
    const ctx = new MockAudioContext();
    const p = new InworldTTSProvider({
      apiKey: "iw",
      audioContext: ctx as unknown as AudioContext,
    });
    await p.speak("test");
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(p.speaking).toBe(false);
  });

  it("connects source to destination and starts playback", async () => {
    const ctx = new MockAudioContext();
    const p = new InworldTTSProvider({
      apiKey: "iw",
      audioContext: ctx as unknown as AudioContext,
    });
    await p.speak("test");
    expect(lastSourceNode?.connect).toHaveBeenCalledWith(ctx.destination);
    expect(lastSourceNode?.start).toHaveBeenCalledWith(0);
  });

  it("creates AudioContext lazily when none injected", async () => {
    const p = new InworldTTSProvider({ apiKey: "iw" });
    await p.speak("test");
    expect(p.speaking).toBe(false);
  });

  it("throws on non-2xx response with body", async () => {
    installFetchMock({ status: 401, text: "Bad credentials" });
    const p = new InworldTTSProvider({ apiKey: "iw-bad" });
    await expect(p.speak("fail")).rejects.toThrow("Inworld TTS error: 401 — Bad credentials");
    expect(p.speaking).toBe(false);
  });

  it("throws on non-2xx response with empty body", async () => {
    installFetchMock({ status: 503, text: "" });
    const p = new InworldTTSProvider({ apiKey: "iw" });
    await expect(p.speak("fail")).rejects.toThrow("Inworld TTS error: 503");
  });

  it("throws when audioContent is missing", async () => {
    installFetchMock({ json: { usage: {} } });
    const p = new InworldTTSProvider({ apiKey: "iw" });
    await expect(p.speak("test")).rejects.toThrow("Inworld TTS returned empty audioContent");
    expect(p.speaking).toBe(false);
  });

  it("throws when audioContent is empty string", async () => {
    installFetchMock({ json: { audioContent: "" } });
    const p = new InworldTTSProvider({ apiKey: "iw" });
    await expect(p.speak("test")).rejects.toThrow("Inworld TTS returned empty audioContent");
  });

  it("resets speaking on fetch network error", async () => {
    Object.defineProperty(globalThis, "fetch", {
      value: vi.fn(async () => {
        throw new Error("Network error");
      }),
      writable: true,
      configurable: true,
    });
    const p = new InworldTTSProvider({ apiKey: "iw" });
    await expect(p.speak("offline")).rejects.toThrow("Network error");
    expect(p.speaking).toBe(false);
  });

  it("resets speaking on decodeAudioData error", async () => {
    const ctx = new MockAudioContext();
    ctx.decodeAudioData = vi.fn(async () => {
      throw new Error("Unable to decode audio data");
    });
    const p = new InworldTTSProvider({
      apiKey: "iw",
      audioContext: ctx as unknown as AudioContext,
    });
    await expect(p.speak("bad audio")).rejects.toThrow("Unable to decode audio data");
    expect(p.speaking).toBe(false);
  });

  it("cancel() during playback stops source node", async () => {
    const ctx = new MockAudioContext();
    ctx.createBufferSource = vi.fn(() => {
      const node = new MockBufferSourceNode();
      node.start = vi.fn();
      lastSourceNode = node;
      return node;
    });
    const p = new InworldTTSProvider({
      apiKey: "iw",
      audioContext: ctx as unknown as AudioContext,
    });
    const promise = p.speak("cancel me");
    await new Promise((r) => setTimeout(r, 10));
    p.cancel();
    expect(p.speaking).toBe(false);
    expect(lastSourceNode?.stop).toHaveBeenCalled();
    try {
      await promise;
    } catch {
      // cancel either resolves or rejects — both fine
    }
  });

  it("cancel() before fetch resolves silences playback", async () => {
    Object.defineProperty(globalThis, "fetch", {
      value: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { ok: true, status: 200, json: async () => ({ audioContent: btoa("x") }) };
      }),
      writable: true,
      configurable: true,
    });
    const p = new InworldTTSProvider({ apiKey: "iw" });
    const promise = p.speak("cancel early");
    p.cancel();
    expect(p.speaking).toBe(false);
    await promise;
  });

  it("cancel() is idempotent", () => {
    const p = new InworldTTSProvider({ apiKey: "iw" });
    p.cancel();
    p.cancel();
    expect(p.speaking).toBe(false);
  });

  it("exports the canonical model list", () => {
    expect(INWORLD_TTS_MODELS).toContain("inworld-tts-1.5-max");
    expect(INWORLD_TTS_MODELS).toContain("inworld-tts-1.5-mini");
    expect(INWORLD_TTS_MODELS.length).toBeGreaterThanOrEqual(4);
  });
});
