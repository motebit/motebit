import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { STTProvider } from "../stt.js";
import { DeepgramSTTProvider } from "../deepgram-stt.js";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

let lastSocket: MockWebSocket | null = null;

function trackLastSocket(ws: MockWebSocket): void {
  lastSocket = ws;
}

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  // Instance state mirrors the static codes so code that reads
  // `ws.readyState` sees the right values.
  CONNECTING = 0;
  OPEN = 1;
  CLOSING = 2;
  CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  send = vi.fn();
  close = vi.fn((code?: number) => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: code ?? 1000, reason: "", wasClean: true } as CloseEvent);
  });

  constructor(
    public readonly url: string,
    public readonly protocols?: string | string[],
  ) {
    trackLastSocket(this);
  }

  // Test helpers.
  _open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }
  _message(data: string | ArrayBuffer): void {
    this.onmessage?.({ data } as unknown as MessageEvent);
  }
  _serverClose(code = 4001): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason: "", wasClean: false } as CloseEvent);
  }
}

function installWebSocketMock(): void {
  lastSocket = null;
  Object.defineProperty(globalThis, "WebSocket", {
    value: MockWebSocket,
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Mock AudioContext / Web Audio API
// ---------------------------------------------------------------------------

class MockAudioNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockSourceNode extends MockAudioNode {}

class MockScriptProcessor extends MockAudioNode {
  onaudioprocess:
    | ((ev: { inputBuffer: { getChannelData: (c: number) => Float32Array } }) => void)
    | null = null;
}

class MockGainNode extends MockAudioNode {
  gain = { value: 1 };
}

let lastWorkletNode: MockAudioWorkletNode | null = null;

function trackLastWorkletNode(node: MockAudioWorkletNode): void {
  lastWorkletNode = node;
}

class MockAudioWorkletNode extends MockAudioNode {
  port = {
    onmessage: null as ((ev: MessageEvent) => void) | null,
    postMessage: vi.fn(),
  };
  constructor(_ctx: MockAudioContext, _name: string, _options?: unknown) {
    super();
    trackLastWorkletNode(this);
  }
}

let lastScriptNode: MockScriptProcessor | null = null;

class MockAudioContext {
  sampleRate = 48000;
  destination = new MockAudioNode();
  audioWorklet = {
    addModule: vi.fn(async (_url: string) => {}),
  };
  close = vi.fn(async () => {});
  createMediaStreamSource = vi.fn(() => new MockSourceNode());
  createScriptProcessor = vi.fn(() => {
    const node = new MockScriptProcessor();
    lastScriptNode = node;
    return node;
  });
  createGain = vi.fn(() => new MockGainNode());
}

function installAudioContextMock(options?: { disableWorklet?: boolean }): void {
  lastWorkletNode = null;
  lastScriptNode = null;
  class Ctor extends MockAudioContext {
    constructor() {
      super();
      if (options?.disableWorklet) {
        // Simulate an older browser with no AudioWorklet — provider should
        // fall back to ScriptProcessorNode.
        (this as unknown as { audioWorklet: unknown }).audioWorklet = undefined;
      }
    }
  }
  Object.defineProperty(globalThis, "AudioContext", {
    value: Ctor,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    value: MockAudioWorkletNode,
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Mock getUserMedia + ancillary browser APIs
// ---------------------------------------------------------------------------

class MockMediaStreamTrack {
  stop = vi.fn();
}
class MockMediaStream {
  private _tracks: MockMediaStreamTrack[];
  constructor() {
    this._tracks = [new MockMediaStreamTrack()];
  }
  getTracks(): MockMediaStreamTrack[] {
    return this._tracks;
  }
}

function installGetUserMediaMock(options?: { denied?: boolean; errorName?: string }): void {
  const fn = vi.fn(async () => {
    if (options?.denied) {
      const err = new Error("Permission denied");
      err.name = options.errorName ?? "NotAllowedError";
      throw err;
    }
    return new MockMediaStream();
  });
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia: fn } },
    writable: true,
    configurable: true,
  });
}

function installBlobAndUrlMock(): void {
  // jsdom doesn't guarantee these, and happy-dom/node envs may lack them.
  if (typeof globalThis.Blob === "undefined") {
    Object.defineProperty(globalThis, "Blob", {
      value: class {
        constructor(
          public readonly parts: unknown[],
          public readonly options?: unknown,
        ) {}
      },
      writable: true,
      configurable: true,
    });
  }
  Object.defineProperty(globalThis, "URL", {
    value: {
      createObjectURL: vi.fn(() => "blob:mock"),
      revokeObjectURL: vi.fn(),
    },
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DeepgramSTTProvider", () => {
  beforeEach(() => {
    installWebSocketMock();
    installAudioContextMock();
    installGetUserMediaMock();
    installBlobAndUrlMock();
  });

  afterEach(() => {
    lastSocket = null;
    lastWorkletNode = null;
    lastScriptNode = null;
  });

  // -------------------------------------------------------------------------
  // Interface conformance
  // -------------------------------------------------------------------------

  it("implements STTProvider interface", () => {
    const provider: STTProvider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    expect(typeof provider.start).toBe("function");
    expect(typeof provider.stop).toBe("function");
    expect(typeof provider.listening).toBe("boolean");
  });

  it("listening is false initially", () => {
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    expect(provider.listening).toBe(false);
  });

  it("listening flips to true on start()", () => {
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    provider.start();
    expect(provider.listening).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Socket URL + auth
  // -------------------------------------------------------------------------

  it("builds socket URL with model, language, encoding, sample rate, interim_results", () => {
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test", language: "fr-FR" });
    provider.start({ interimResults: true });

    expect(lastSocket).not.toBeNull();
    const url = lastSocket!.url;
    expect(url).toContain("wss://api.deepgram.com/v1/listen?");
    expect(url).toContain("model=nova-2");
    expect(url).toContain("language=fr-FR");
    expect(url).toContain("encoding=linear16");
    expect(url).toContain("sample_rate=16000");
    expect(url).toContain("interim_results=true");
    expect(url).toContain("smart_format=true");
  });

  it("overrides language from start() options over constructor default", () => {
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test", language: "en-US" });
    provider.start({ language: "es-ES" });
    expect(lastSocket!.url).toContain("language=es-ES");
  });

  it("interim_results=false when requested", () => {
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    provider.start({ interimResults: false });
    expect(lastSocket!.url).toContain("interim_results=false");
  });

  it("omits smart_format when disabled", () => {
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test", smartFormat: false });
    provider.start();
    expect(lastSocket!.url).not.toContain("smart_format");
  });

  it("passes the api key via the [token, apiKey] subprotocol", () => {
    const provider = new DeepgramSTTProvider({ apiKey: "dg-secret-key" });
    provider.start();
    expect(lastSocket!.protocols).toEqual(["token", "dg-secret-key"]);
  });

  // -------------------------------------------------------------------------
  // onResult forwarding
  // -------------------------------------------------------------------------

  it("forwards interim transcripts with isFinal=false", async () => {
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    const results: Array<{ t: string; final: boolean }> = [];
    provider.onResult = (t, final) => results.push({ t, final });
    provider.start();
    lastSocket!._open();
    await Promise.resolve();

    lastSocket!._message(
      JSON.stringify({
        channel: { alternatives: [{ transcript: "hello" }] },
        is_final: false,
      }),
    );
    expect(results).toEqual([{ t: "hello", final: false }]);
  });

  it("forwards final transcripts with isFinal=true", async () => {
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    const results: Array<{ t: string; final: boolean }> = [];
    provider.onResult = (t, final) => results.push({ t, final });
    provider.start();
    lastSocket!._open();
    await Promise.resolve();

    lastSocket!._message(
      JSON.stringify({
        channel: { alternatives: [{ transcript: "hello there" }] },
        is_final: true,
      }),
    );
    expect(results).toEqual([{ t: "hello there", final: true }]);
  });

  it("ignores frames with empty transcript", async () => {
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    const results: string[] = [];
    provider.onResult = (t) => results.push(t);
    provider.start();
    lastSocket!._open();
    await Promise.resolve();

    lastSocket!._message(
      JSON.stringify({ channel: { alternatives: [{ transcript: "" }] }, is_final: true }),
    );
    expect(results).toEqual([]);
  });

  it("ignores non-JSON text frames", async () => {
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    provider.onResult = vi.fn();
    provider.onError = vi.fn();
    provider.start();
    lastSocket!._open();
    await Promise.resolve();

    lastSocket!._message("not-json");
    expect(provider.onResult).not.toHaveBeenCalled();
    expect(provider.onError).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // continuous=false → closes after first final
  // -------------------------------------------------------------------------

  it("closes socket after first final when continuous=false", async () => {
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    provider.start({ continuous: false });
    lastSocket!._open();
    await Promise.resolve();
    expect(provider.listening).toBe(true);

    lastSocket!._message(
      JSON.stringify({
        channel: { alternatives: [{ transcript: "done" }] },
        is_final: true,
      }),
    );
    expect(lastSocket!.close).toHaveBeenCalled();
    expect(provider.listening).toBe(false);
  });

  it("stays open across multiple finals when continuous=true", async () => {
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    provider.start({ continuous: true });
    lastSocket!._open();
    await Promise.resolve();

    lastSocket!._message(
      JSON.stringify({
        channel: { alternatives: [{ transcript: "one" }] },
        is_final: true,
      }),
    );
    lastSocket!._message(
      JSON.stringify({
        channel: { alternatives: [{ transcript: "two" }] },
        is_final: true,
      }),
    );
    expect(lastSocket!.close).not.toHaveBeenCalled();
    expect(provider.listening).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Permission-denied → onError("not-allowed") matches WebSpeech vocabulary
  // -------------------------------------------------------------------------

  it('maps NotAllowedError to onError("not-allowed")', async () => {
    installGetUserMediaMock({ denied: true, errorName: "NotAllowedError" });
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    const errors: string[] = [];
    provider.onError = (e) => errors.push(e);
    provider.start();
    lastSocket!._open();
    // Let the async getUserMedia rejection settle.
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
    expect(errors).toContain("not-allowed");
  });

  it('maps SecurityError to onError("not-allowed")', async () => {
    installGetUserMediaMock({ denied: true, errorName: "SecurityError" });
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    const errors: string[] = [];
    provider.onError = (e) => errors.push(e);
    provider.start();
    lastSocket!._open();
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
    expect(errors).toContain("not-allowed");
  });

  it('maps NotFoundError to onError("service-not-allowed")', async () => {
    installGetUserMediaMock({ denied: true, errorName: "NotFoundError" });
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    const errors: string[] = [];
    provider.onError = (e) => errors.push(e);
    provider.start();
    lastSocket!._open();
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
    expect(errors).toContain("service-not-allowed");
  });

  // -------------------------------------------------------------------------
  // Socket errors → deepgram-<code>
  // -------------------------------------------------------------------------

  it('maps unclean close codes to onError("deepgram-<code>")', async () => {
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    const errors: string[] = [];
    provider.onError = (e) => errors.push(e);
    provider.start();
    lastSocket!._open();
    await Promise.resolve();

    lastSocket!._serverClose(4001);
    expect(errors).toContain("deepgram-4001");
  });

  it("does not emit onError on clean close after stop()", async () => {
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    const errors: string[] = [];
    provider.onError = (e) => errors.push(e);
    provider.start();
    lastSocket!._open();
    await Promise.resolve();

    provider.stop();
    // stop() triggers ws.close(1000, ...) which the mock replays as a
    // clean onclose. No error should be surfaced.
    expect(errors).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // stop() cleanup
  // -------------------------------------------------------------------------

  it("stop() closes the socket", async () => {
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    provider.start();
    lastSocket!._open();
    await Promise.resolve();

    provider.stop();
    expect(lastSocket!.close).toHaveBeenCalled();
    expect(provider.listening).toBe(false);
  });

  it("stop() releases mic stream tracks", async () => {
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    provider.start();
    lastSocket!._open();
    // Let the async getUserMedia + worklet setup settle.
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
    await Promise.resolve();

    // The internal stream isn't directly exposed — check that stop() fires
    // onEnd (which only happens after teardown) and that close was called.
    const endSpy = vi.fn();
    provider.onEnd = endSpy;
    provider.stop();
    expect(endSpy).toHaveBeenCalled();
    expect(lastSocket!.close).toHaveBeenCalled();
  });

  it("stop() when not listening is a no-op", () => {
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    expect(() => provider.stop()).not.toThrow();
    expect(provider.listening).toBe(false);
  });

  // -------------------------------------------------------------------------
  // start() idempotence
  // -------------------------------------------------------------------------

  it("start() while already listening is a no-op", () => {
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    provider.start();
    const firstSocket = lastSocket;
    provider.start();
    // Second call must not replace the socket.
    expect(lastSocket).toBe(firstSocket);
  });

  // -------------------------------------------------------------------------
  // AudioWorklet vs ScriptProcessor fallback
  // -------------------------------------------------------------------------

  it("uses AudioWorklet when available", async () => {
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    provider.start();
    lastSocket!._open();
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
    await Promise.resolve();
    expect(lastWorkletNode).not.toBeNull();
    expect(lastScriptNode).toBeNull();
  });

  it("falls back to ScriptProcessorNode when AudioWorklet is unavailable", async () => {
    installAudioContextMock({ disableWorklet: true });
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    provider.start();
    lastSocket!._open();
    await new Promise((r) => setTimeout(r, 0));
    await Promise.resolve();
    await Promise.resolve();
    expect(lastWorkletNode).toBeNull();
    expect(lastScriptNode).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // onEnd lifecycle
  // -------------------------------------------------------------------------

  it("fires onEnd when the socket closes", async () => {
    const provider = new DeepgramSTTProvider({ apiKey: "dg-test" });
    const endSpy = vi.fn();
    provider.onEnd = endSpy;
    provider.start();
    lastSocket!._open();
    await Promise.resolve();
    lastSocket!._serverClose(1000);
    expect(endSpy).toHaveBeenCalled();
  });
});
