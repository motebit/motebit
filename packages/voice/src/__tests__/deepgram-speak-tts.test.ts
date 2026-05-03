import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TTSProvider } from "../tts.js";
import { DeepgramSpeakTTSProvider, DEEPGRAM_VOICES } from "../deepgram-speak-tts.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let lastSourceNode: MockBufferSourceNode | null = null;

class MockAudioBuffer {
  readonly duration = 1;
  readonly length = 22050;
  readonly sampleRate = 22050;
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

function installFetchMock(options?: { status?: number; body?: string }): void {
  const status = options?.status ?? 200;
  const body = options?.body ?? "";
  lastFetchUrl = null;
  lastFetchHeaders = null;
  lastFetchBody = null;

  Object.defineProperty(globalThis, "fetch", {
    value: vi.fn(async (url: string, init: RequestInit) => {
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
        arrayBuffer: async () => new ArrayBuffer(64),
      };
    }),
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DeepgramSpeakTTSProvider", () => {
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
    const p: TTSProvider = new DeepgramSpeakTTSProvider({ apiKey: "dg-test" });
    expect(typeof p.speak).toBe("function");
    expect(typeof p.cancel).toBe("function");
    expect(p.speaking).toBe(false);
  });

  it("POSTs to /v1/speak with default voice + Token auth + JSON body", async () => {
    const p = new DeepgramSpeakTTSProvider({ apiKey: "dg-test-key" });
    await p.speak("Hello world");
    expect(lastFetchUrl).toBe("https://api.deepgram.com/v1/speak?model=aura-asteria-en");
    expect(lastFetchHeaders?.Authorization).toBe("Token dg-test-key");
    expect(lastFetchHeaders?.["Content-Type"]).toBe("application/json");
    expect(lastFetchBody).toEqual({ text: "Hello world" });
  });

  it("uses configured voice", async () => {
    const p = new DeepgramSpeakTTSProvider({ apiKey: "dg", voice: "aura-luna-en" });
    await p.speak("test");
    expect(lastFetchUrl).toBe("https://api.deepgram.com/v1/speak?model=aura-luna-en");
  });

  it("URL-encodes voice id", async () => {
    const p = new DeepgramSpeakTTSProvider({ apiKey: "dg", voice: "voice with spaces" });
    await p.speak("test");
    expect(lastFetchUrl).toBe("https://api.deepgram.com/v1/speak?model=voice%20with%20spaces");
  });

  it("uses custom baseUrl", async () => {
    const p = new DeepgramSpeakTTSProvider({
      apiKey: "dg",
      baseUrl: "https://proxy.example.com",
    });
    await p.speak("test");
    expect(lastFetchUrl).toBe("https://proxy.example.com/v1/speak?model=aura-asteria-en");
  });

  it("resolves speak() once playback ends", async () => {
    const p = new DeepgramSpeakTTSProvider({ apiKey: "dg" });
    await p.speak("test");
    expect(p.speaking).toBe(false);
  });

  it("uses injected AudioContext", async () => {
    const ctx = new MockAudioContext();
    const p = new DeepgramSpeakTTSProvider({
      apiKey: "dg",
      audioContext: ctx as unknown as AudioContext,
    });
    await p.speak("test");
    expect(ctx.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
  });

  it("creates AudioContext lazily when none injected", async () => {
    const p = new DeepgramSpeakTTSProvider({ apiKey: "dg" });
    await p.speak("test");
    expect(p.speaking).toBe(false);
  });

  it("connects source to destination and calls start(0)", async () => {
    const ctx = new MockAudioContext();
    const p = new DeepgramSpeakTTSProvider({
      apiKey: "dg",
      audioContext: ctx as unknown as AudioContext,
    });
    await p.speak("test");
    expect(lastSourceNode?.connect).toHaveBeenCalledWith(ctx.destination);
    expect(lastSourceNode?.start).toHaveBeenCalledWith(0);
  });

  it("throws on non-2xx response with body", async () => {
    installFetchMock({ status: 401, body: "Unauthorized" });
    const p = new DeepgramSpeakTTSProvider({ apiKey: "dg-bad" });
    await expect(p.speak("fail")).rejects.toThrow("Deepgram TTS error: 401 — Unauthorized");
    expect(p.speaking).toBe(false);
  });

  it("throws on non-2xx response with empty body", async () => {
    installFetchMock({ status: 500, body: "" });
    const p = new DeepgramSpeakTTSProvider({ apiKey: "dg" });
    await expect(p.speak("fail")).rejects.toThrow("Deepgram TTS error: 500");
  });

  it("resets speaking on fetch network error", async () => {
    Object.defineProperty(globalThis, "fetch", {
      value: vi.fn(async () => {
        throw new Error("Network error");
      }),
      writable: true,
      configurable: true,
    });
    const p = new DeepgramSpeakTTSProvider({ apiKey: "dg" });
    await expect(p.speak("offline")).rejects.toThrow("Network error");
    expect(p.speaking).toBe(false);
  });

  it("resets speaking on decodeAudioData error", async () => {
    const ctx = new MockAudioContext();
    ctx.decodeAudioData = vi.fn(async () => {
      throw new Error("Unable to decode audio data");
    });
    const p = new DeepgramSpeakTTSProvider({
      apiKey: "dg",
      audioContext: ctx as unknown as AudioContext,
    });
    await expect(p.speak("bad audio")).rejects.toThrow("Unable to decode audio data");
    expect(p.speaking).toBe(false);
  });

  it("cancel() before fetch resolves stops state", async () => {
    Object.defineProperty(globalThis, "fetch", {
      value: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) };
      }),
      writable: true,
      configurable: true,
    });
    const p = new DeepgramSpeakTTSProvider({ apiKey: "dg" });
    const promise = p.speak("cancel early");
    p.cancel();
    expect(p.speaking).toBe(false);
    await promise;
  });

  it("cancel() during playback stops source node", async () => {
    const ctx = new MockAudioContext();
    ctx.createBufferSource = vi.fn(() => {
      const node = new MockBufferSourceNode();
      node.start = vi.fn();
      lastSourceNode = node;
      return node;
    });
    const p = new DeepgramSpeakTTSProvider({
      apiKey: "dg",
      audioContext: ctx as unknown as AudioContext,
    });
    const promise = p.speak("cancel mid");
    await new Promise((r) => setTimeout(r, 10));
    p.cancel();
    expect(p.speaking).toBe(false);
    expect(lastSourceNode?.stop).toHaveBeenCalled();
    try {
      await promise;
    } catch {
      // cancel resolves or rejects — either is fine
    }
  });

  it("cancel() is idempotent", () => {
    const p = new DeepgramSpeakTTSProvider({ apiKey: "dg" });
    p.cancel();
    p.cancel();
    expect(p.speaking).toBe(false);
  });

  it("exports the curated voice list", () => {
    expect(DEEPGRAM_VOICES).toContain("aura-asteria-en");
    expect(DEEPGRAM_VOICES.length).toBeGreaterThan(5);
    for (const v of DEEPGRAM_VOICES) expect(typeof v).toBe("string");
  });
});
