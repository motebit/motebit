import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { STTProvider } from "../stt.js";
import { InworldSTTProvider } from "../inworld-stt.js";

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

  constructor(public readonly url: string) {
    trackLastSocket(this);
  }

  _open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }
  _message(data: string): void {
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
// Mock Audio graph
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
let workletAddModuleFails = false;

class MockAudioContext {
  sampleRate = 48000;
  destination = new MockAudioNode();
  audioWorklet = {
    addModule: vi.fn(async (_url: string) => {
      if (workletAddModuleFails) throw new Error("addModule failed");
    }),
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

function installAudioMocks(): void {
  lastWorkletNode = null;
  lastScriptNode = null;
  workletAddModuleFails = false;

  Object.defineProperty(globalThis, "AudioContext", {
    value: MockAudioContext,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(globalThis, "AudioWorkletNode", {
    value: MockAudioWorkletNode,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(globalThis, "URL", {
    value: { createObjectURL: vi.fn(() => "blob:mock") },
    writable: true,
    configurable: true,
  });

  Object.defineProperty(globalThis, "Blob", {
    value: class {
      constructor(
        public readonly _parts: BlobPart[],
        public readonly _opts?: BlobPropertyBag,
      ) {}
    },
    writable: true,
    configurable: true,
  });
}

function installMicMock(options?: { fail?: boolean; errorName?: string }): void {
  const fail = options?.fail ?? false;
  const errorName = options?.errorName ?? "NotAllowedError";
  Object.defineProperty(globalThis, "navigator", {
    value: {
      mediaDevices: {
        getUserMedia: vi.fn(async () => {
          if (fail) {
            const err = new Error("denied");
            err.name = errorName;
            throw err;
          }
          return {
            getTracks: () => [{ stop: vi.fn() }],
          };
        }),
      },
    },
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InworldSTTProvider", () => {
  beforeEach(() => {
    installWebSocketMock();
    installAudioMocks();
    installMicMock();
  });
  afterEach(() => {
    lastSocket = null;
    lastWorkletNode = null;
    lastScriptNode = null;
  });

  // ---- Interface ----

  it("implements STTProvider interface", () => {
    const p: STTProvider = new InworldSTTProvider({ apiKey: "iw-test" });
    expect(typeof p.start).toBe("function");
    expect(typeof p.stop).toBe("function");
    expect(p.listening).toBe(false);
  });

  // ---- URL construction ----

  it("opens ws to canonical streamBidirectional path with auth in query", () => {
    const p = new InworldSTTProvider({ apiKey: "secret-key" });
    p.start();
    const url = lastSocket?.url ?? "";
    expect(url.startsWith("wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional")).toBe(true);
    expect(url).toContain("authorization=");
    // Basic <key> URL-encoded — the space encodes to %20
    expect(decodeURIComponent(url.split("authorization=")[1] ?? "")).toBe("Basic secret-key");
  });

  it("respects custom baseUrl", () => {
    const p = new InworldSTTProvider({ apiKey: "k", baseUrl: "wss://eu.example.com" });
    p.start();
    expect(
      lastSocket?.url.startsWith("wss://eu.example.com/stt/v1/transcribe:streamBidirectional"),
    ).toBe(true);
  });

  // ---- Config message ----

  it("sends transcribe_config as the first frame on socket open", () => {
    const p = new InworldSTTProvider({ apiKey: "k" });
    p.start();
    lastSocket?._open();
    expect(lastSocket?.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(lastSocket?.send.mock.calls[0]![0] as string) as {
      transcribe_config: Record<string, unknown>;
    };
    expect(sent.transcribe_config.modelId).toBe("assemblyai/universal-streaming-multilingual");
    expect(sent.transcribe_config.audioEncoding).toBe("LINEAR16");
    expect(sent.transcribe_config.sampleRateHertz).toBe(16000);
    expect(sent.transcribe_config.language).toBe("en-US");
  });

  it("config respects per-start language override", () => {
    const p = new InworldSTTProvider({ apiKey: "k", language: "en-US" });
    p.start({ language: "es-ES" });
    lastSocket?._open();
    const sent = JSON.parse(lastSocket?.send.mock.calls[0]![0] as string) as {
      transcribe_config: { language: string };
    };
    expect(sent.transcribe_config.language).toBe("es-ES");
  });

  it("uses configured default model", () => {
    const p = new InworldSTTProvider({ apiKey: "k", model: "custom/streaming" });
    p.start();
    lastSocket?._open();
    const sent = JSON.parse(lastSocket?.send.mock.calls[0]![0] as string) as {
      transcribe_config: { modelId: string };
    };
    expect(sent.transcribe_config.modelId).toBe("custom/streaming");
  });

  // ---- Result frames ----

  it("fires onResult with non-final transcript", async () => {
    const onResult = vi.fn();
    const p = new InworldSTTProvider({ apiKey: "k" });
    p.onResult = onResult;
    p.start();
    lastSocket?._open();
    await new Promise((r) => setTimeout(r, 0));
    lastSocket?._message(
      JSON.stringify({
        result: { transcription: { transcript: "hello", isFinal: false } },
      }),
    );
    expect(onResult).toHaveBeenCalledWith("hello", false);
  });

  it("fires onResult with final transcript and continues when continuous=true", async () => {
    const onResult = vi.fn();
    const p = new InworldSTTProvider({ apiKey: "k" });
    p.onResult = onResult;
    p.start({ continuous: true });
    lastSocket?._open();
    await new Promise((r) => setTimeout(r, 0));
    lastSocket?._message(
      JSON.stringify({
        result: { transcription: { transcript: "done.", isFinal: true } },
      }),
    );
    expect(onResult).toHaveBeenCalledWith("done.", true);
    expect(p.listening).toBe(true);
  });

  it("tears down on final transcript when continuous=false", async () => {
    const onEnd = vi.fn();
    const p = new InworldSTTProvider({ apiKey: "k" });
    p.onEnd = onEnd;
    p.start({ continuous: false });
    lastSocket?._open();
    await new Promise((r) => setTimeout(r, 0));
    lastSocket?._message(
      JSON.stringify({
        result: { transcription: { transcript: "stop.", isFinal: true } },
      }),
    );
    expect(p.listening).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("ignores empty transcripts", async () => {
    const onResult = vi.fn();
    const p = new InworldSTTProvider({ apiKey: "k" });
    p.onResult = onResult;
    p.start();
    lastSocket?._open();
    await new Promise((r) => setTimeout(r, 0));
    lastSocket?._message(
      JSON.stringify({ result: { transcription: { transcript: "", isFinal: false } } }),
    );
    expect(onResult).not.toHaveBeenCalled();
  });

  it("ignores non-string message payloads", () => {
    const onResult = vi.fn();
    const p = new InworldSTTProvider({ apiKey: "k" });
    p.onResult = onResult;
    p.start();
    lastSocket?._open();
    lastSocket?.onmessage?.({ data: new ArrayBuffer(8) } as unknown as MessageEvent);
    expect(onResult).not.toHaveBeenCalled();
  });

  it("ignores malformed JSON frames", () => {
    const onResult = vi.fn();
    const p = new InworldSTTProvider({ apiKey: "k" });
    p.onResult = onResult;
    p.start();
    lastSocket?._open();
    lastSocket?._message("{not json");
    expect(onResult).not.toHaveBeenCalled();
  });

  // ---- start() idempotence ----

  it("start() while listening is a no-op", () => {
    const p = new InworldSTTProvider({ apiKey: "k" });
    p.start();
    const first = lastSocket;
    p.start();
    expect(lastSocket).toBe(first);
  });

  // ---- WebSocket constructor failure ----

  it("emits error when WebSocket constructor throws", () => {
    const onError = vi.fn();
    const onEnd = vi.fn();
    Object.defineProperty(globalThis, "WebSocket", {
      value: function FailingWebSocket() {
        throw new Error("ws-construct-failed");
      },
      writable: true,
      configurable: true,
    });
    const p = new InworldSTTProvider({ apiKey: "k" });
    p.onError = onError;
    p.onEnd = onEnd;
    p.start();
    expect(onError).toHaveBeenCalled();
    const arg = onError.mock.calls[0]![0] as string;
    expect(arg.startsWith("inworld-socket-open-failed:")).toBe(true);
    expect(p.listening).toBe(false);
  });

  // ---- Mic errors ----

  it("emits 'not-allowed' when permission denied", async () => {
    installMicMock({ fail: true, errorName: "NotAllowedError" });
    const onError = vi.fn();
    const p = new InworldSTTProvider({ apiKey: "k" });
    p.onError = onError;
    p.start();
    lastSocket?._open();
    await new Promise((r) => setTimeout(r, 5));
    expect(onError).toHaveBeenCalledWith("not-allowed");
  });

  it("emits 'service-not-allowed' on NotFoundError", async () => {
    installMicMock({ fail: true, errorName: "NotFoundError" });
    const onError = vi.fn();
    const p = new InworldSTTProvider({ apiKey: "k" });
    p.onError = onError;
    p.start();
    lastSocket?._open();
    await new Promise((r) => setTimeout(r, 5));
    expect(onError).toHaveBeenCalledWith("service-not-allowed");
  });

  it("emits inworld-mic-error: prefix for unknown mic error name", async () => {
    installMicMock({ fail: true, errorName: "RandomError" });
    const onError = vi.fn();
    const p = new InworldSTTProvider({ apiKey: "k" });
    p.onError = onError;
    p.start();
    lastSocket?._open();
    await new Promise((r) => setTimeout(r, 5));
    const errArg = onError.mock.calls.find((c) => (c[0] as string).startsWith("inworld-mic-error"));
    expect(errArg).toBeDefined();
  });

  // ---- Worklet path ----

  it("attaches AudioWorklet when available and forwards encoded chunks", async () => {
    const p = new InworldSTTProvider({ apiKey: "k" });
    p.start();
    lastSocket?._open();
    await new Promise((r) => setTimeout(r, 5));
    expect(lastWorkletNode).not.toBeNull();
    // Simulate the worklet posting a PCM16 buffer back.
    const pcm = new Int16Array([1000, -1000, 0, 0]);
    lastWorkletNode?.port.onmessage?.({ data: pcm.buffer } as unknown as MessageEvent);
    // send was called for config + audio_chunk
    const audioFrame = lastSocket?.send.mock.calls.find((c) =>
      (c[0] as string).includes("audio_chunk"),
    );
    expect(audioFrame).toBeDefined();
    const frame = JSON.parse(audioFrame![0] as string) as {
      audio_chunk: { content: string };
    };
    expect(typeof frame.audio_chunk.content).toBe("string");
    expect(frame.audio_chunk.content.length).toBeGreaterThan(0);
  });

  it("falls back to ScriptProcessor when worklet addModule throws", async () => {
    workletAddModuleFails = true;
    const p = new InworldSTTProvider({ apiKey: "k" });
    p.start();
    lastSocket?._open();
    await new Promise((r) => setTimeout(r, 5));
    expect(lastScriptNode).not.toBeNull();
  });

  it("ScriptProcessor path encodes float samples as PCM16 and forwards", async () => {
    workletAddModuleFails = true;
    const p = new InworldSTTProvider({ apiKey: "k" });
    p.start();
    lastSocket?._open();
    await new Promise((r) => setTimeout(r, 5));
    const float = new Float32Array([0.5, -0.5, 1.5, -1.5]);
    lastScriptNode?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => float },
    } as unknown as { inputBuffer: { getChannelData: (c: number) => Float32Array } });
    const audioFrame = lastSocket?.send.mock.calls.find((c) =>
      (c[0] as string).includes("audio_chunk"),
    );
    expect(audioFrame).toBeDefined();
  });

  // ---- stop() / close ----

  it("stop() sends close_stream then closes socket", async () => {
    const onEnd = vi.fn();
    const p = new InworldSTTProvider({ apiKey: "k" });
    p.onEnd = onEnd;
    p.start();
    lastSocket?._open();
    await new Promise((r) => setTimeout(r, 5));
    const beforeStopCalls = lastSocket?.send.mock.calls.length ?? 0;
    p.stop();
    const closeFrame = lastSocket?.send.mock.calls
      .slice(beforeStopCalls)
      .find((c) => (c[0] as string).includes("close_stream"));
    expect(closeFrame).toBeDefined();
    expect(p.listening).toBe(false);
    expect(onEnd).toHaveBeenCalled();
  });

  it("stop() while not listening is a no-op", () => {
    const p = new InworldSTTProvider({ apiKey: "k" });
    p.stop();
    expect(p.listening).toBe(false);
  });

  it("server-side close with non-1000 code emits inworld-<code>", () => {
    const onError = vi.fn();
    const p = new InworldSTTProvider({ apiKey: "k" });
    p.onError = onError;
    p.start();
    lastSocket?._open();
    lastSocket?._serverClose(4408);
    expect(onError).toHaveBeenCalledWith("inworld-4408");
    expect(p.listening).toBe(false);
  });

  it("server close with code 1000 does not emit error", () => {
    const onError = vi.fn();
    const p = new InworldSTTProvider({ apiKey: "k" });
    p.onError = onError;
    p.start();
    lastSocket?._open();
    lastSocket?._serverClose(1000);
    expect(onError).not.toHaveBeenCalled();
  });

  it("ws.onerror triggers onError('inworld-socket-error')", () => {
    const onError = vi.fn();
    const p = new InworldSTTProvider({ apiKey: "k" });
    p.onError = onError;
    p.start();
    lastSocket?.onerror?.(new Event("error"));
    expect(onError).toHaveBeenCalledWith("inworld-socket-error");
  });

  it("does not send audio frames before config is sent", async () => {
    workletAddModuleFails = true;
    const p = new InworldSTTProvider({ apiKey: "k" });
    p.start();
    // Don't open the socket — skip the config send and direct-fire script processor.
    // _attachMicrophone bails when readyState !== OPEN, so this exercises the
    // pre-open guard. Just verify no audio_chunk frames left the socket.
    await new Promise((r) => setTimeout(r, 5));
    const audioFrames =
      lastSocket?.send.mock.calls.filter((c) => (c[0] as string).includes("audio_chunk")) ?? [];
    expect(audioFrames.length).toBe(0);
  });
});
