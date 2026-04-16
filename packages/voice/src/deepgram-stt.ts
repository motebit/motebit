// ---------------------------------------------------------------------------
// DeepgramSTTProvider — streaming STT over Deepgram's WebSocket API
// ---------------------------------------------------------------------------
//
// Platform-agnostic STTProvider that streams 16-kHz PCM16 audio from the
// browser microphone to Deepgram's `wss://api.deepgram.com/v1/listen`
// endpoint and emits interim + final transcripts to the STTProvider
// callback surface.
//
// Transport:
//   - WebSocket with `["token", apiKey]` subprotocols (canonical browser
//     auth pattern — Deepgram accepts the second protocol token as bearer).
//   - Binary frames are raw PCM16 little-endian at 16 kHz, mono.
//   - JSON text frames carry transcript results.
//
// Audio capture: `navigator.mediaDevices.getUserMedia({ audio: true })` →
// `AudioContext` @ 16 kHz target → worklet (preferred) or ScriptProcessor
// fallback → downsample if the device sample rate doesn't match → PCM16
// encode → `ws.send(pcmBuffer)`.
//
// Error vocabulary mirrors WebSpeechSTTProvider's so the web keeper's
// fatal-error check (`not-allowed` / `service-not-allowed`) stays source
// of truth across adapters.

import type { STTProvider, STTOptions } from "./stt.js";

/**
 * Configuration for the Deepgram STT adapter.
 */
export interface DeepgramSTTConfig {
  /** Deepgram API key. Should come from a secure store, never hardcoded. */
  apiKey: string;
  /** Deepgram model id. Defaults to `"nova-2"`. */
  model?: string;
  /** BCP-47 language tag. Defaults to `"en-US"`. */
  language?: string;
  /** Whether to request smart formatting. Defaults to `true`. */
  smartFormat?: boolean;
  /** Base URL for the listen socket. Defaults to `"wss://api.deepgram.com"`. */
  baseUrl?: string;
}

/**
 * Target sample rate sent to Deepgram. Deepgram accepts many rates; 16 kHz
 * is the standard for streaming speech and matches nova-2's training data.
 */
const TARGET_SAMPLE_RATE = 16000;

/** Shape of a Deepgram listen-api JSON frame. */
interface DeepgramResultFrame {
  channel?: {
    alternatives?: Array<{ transcript?: string }>;
  };
  is_final?: boolean;
}

/**
 * Streaming STTProvider backed by Deepgram.
 *
 * Lifecycle:
 *   1. `start()` opens the socket, requests mic access, builds the audio
 *      graph, and starts streaming PCM16 frames as they arrive.
 *   2. Incoming JSON frames fire `onResult(transcript, isFinal)`.
 *   3. `stop()` tears down the socket, mic, and audio graph.
 *
 * Error mapping:
 *   - Permission errors surface as `"not-allowed"` / `"service-not-allowed"`
 *     (matches WebSpeechSTTProvider).
 *   - Socket auth/transport errors surface as `"deepgram-<code>"`.
 */
export class DeepgramSTTProvider implements STTProvider {
  private _listening = false;
  private _ws: WebSocket | null = null;
  private _stream: MediaStream | null = null;
  private _audioContext: AudioContext | null = null;
  private _sourceNode: MediaStreamAudioSourceNode | null = null;
  private _workletNode: AudioWorkletNode | null = null;
  private _scriptNode: ScriptProcessorNode | null = null;
  private _stopping = false;
  private _continuous = true;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly language: string;
  private readonly smartFormat: boolean;
  private readonly baseUrl: string;

  onResult: ((transcript: string, isFinal: boolean) => void) | null = null;
  onError: ((error: string) => void) | null = null;
  onEnd: (() => void) | null = null;

  constructor(config: DeepgramSTTConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "nova-2";
    this.language = config.language ?? "en-US";
    this.smartFormat = config.smartFormat ?? true;
    this.baseUrl = config.baseUrl ?? "wss://api.deepgram.com";
  }

  get listening(): boolean {
    return this._listening;
  }

  start(options?: STTOptions): void {
    if (this._listening) return;

    this._listening = true;
    this._stopping = false;
    this._continuous = options?.continuous ?? true;

    const language = options?.language ?? this.language;
    const interim = options?.interimResults ?? true;

    const url = this._buildUrl(language, interim);

    let ws: WebSocket;
    try {
      // The `["token", apiKey]` subprotocol is Deepgram's canonical browser
      // auth — the server accepts the second entry as the bearer token.
      ws = new WebSocket(url, ["token", this.apiKey]);
    } catch (err: unknown) {
      this._listening = false;
      this.onError?.(
        `deepgram-socket-open-failed:${err instanceof Error ? err.message : String(err)}`,
      );
      this.onEnd?.();
      return;
    }
    ws.binaryType = "arraybuffer";
    this._ws = ws;

    ws.onopen = () => {
      // Socket is up — now start the mic. If the socket dies before we get
      // here, onerror/onclose handles cleanup.
      void this._attachMicrophone();
    };

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let frame: DeepgramResultFrame;
      try {
        frame = JSON.parse(event.data) as DeepgramResultFrame;
      } catch {
        return;
      }
      const transcript = frame.channel?.alternatives?.[0]?.transcript;
      if (transcript == null || transcript === "") return;
      const isFinal = frame.is_final === true;
      this.onResult?.(transcript, isFinal);

      // Non-continuous mode: close the socket after the first final result
      // so the keeper can decide whether to respawn.
      if (isFinal && !this._continuous) {
        this._teardown();
      }
    };

    ws.onerror = () => {
      // Browsers don't expose close codes here — fall through to onclose
      // which has the authoritative code. Emit a generic error marker so
      // callers can distinguish socket failure from mic denial.
      this.onError?.("deepgram-socket-error");
    };

    ws.onclose = (event: CloseEvent) => {
      // 1000 / 1005 are clean; anything else is a transport/auth failure.
      if (!this._stopping && event.code !== 1000 && event.code !== 1005) {
        // 4001/4008 are Deepgram auth failures; everything else is a
        // generic socket problem. Either way we relay the code.
        this.onError?.(`deepgram-${event.code}`);
      }
      this._teardown();
    };
  }

  stop(): void {
    if (!this._listening) return;
    this._stopping = true;
    this._teardown();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private _buildUrl(language: string, interim: boolean): string {
    const params = new URLSearchParams({
      model: this.model,
      language,
      encoding: "linear16",
      sample_rate: String(TARGET_SAMPLE_RATE),
      interim_results: interim ? "true" : "false",
    });
    if (this.smartFormat) params.set("smart_format", "true");
    return `${this.baseUrl}/v1/listen?${params.toString()}`;
  }

  private async _attachMicrophone(): Promise<void> {
    // The socket may have closed while we were between onopen and the mic
    // request — bail early so we don't leak a stream.
    if (this._stopping || !this._ws || this._ws.readyState !== WebSocket.OPEN) return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err: unknown) {
      const name = err instanceof Error ? err.name : "";
      // Match WebSpeech error vocabulary so the web keeper's fatal-error
      // check stays source-of-truth across adapters.
      if (name === "NotAllowedError" || name === "SecurityError") {
        this.onError?.("not-allowed");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        this.onError?.("service-not-allowed");
      } else {
        this.onError?.(`deepgram-mic-error:${name || String(err)}`);
      }
      this._teardown();
      return;
    }
    if (this._stopping) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this._stream = stream;

    const ctx = new AudioContext();
    this._audioContext = ctx;
    const source = ctx.createMediaStreamSource(stream);
    this._sourceNode = source;

    const deviceRate = ctx.sampleRate;
    const ratio = deviceRate / TARGET_SAMPLE_RATE;

    const workletOk = await this._tryAttachWorklet(ctx, source, ratio);
    if (workletOk) return;

    // Fallback: ScriptProcessorNode. Deprecated but still universally
    // supported, and harmless for short-lived voice sessions.
    this._attachScriptProcessor(ctx, source, ratio);
  }

  private async _tryAttachWorklet(
    ctx: AudioContext,
    source: MediaStreamAudioSourceNode,
    ratio: number,
  ): Promise<boolean> {
    const worklet = (ctx as AudioContext & { audioWorklet?: AudioWorklet }).audioWorklet;
    if (worklet == null || typeof worklet.addModule !== "function") return false;

    // Inline the worklet source so the package has no runtime file deps —
    // callers just `new DeepgramSTTProvider(...)` and it works. The URL
    // blob lives for the lifetime of the module; we don't bother revoking
    // since mic sessions are short.
    const workletSource = `
      class DeepgramPcmProcessor extends AudioWorkletProcessor {
        constructor(options) {
          super();
          this._ratio = (options && options.processorOptions && options.processorOptions.ratio) || 1;
          this._acc = 0;
        }
        process(inputs) {
          const input = inputs[0];
          if (!input || !input[0]) return true;
          const channel = input[0];
          const outLen = Math.floor(channel.length / this._ratio);
          if (outLen <= 0) return true;
          const out = new Int16Array(outLen);
          for (let i = 0; i < outLen; i++) {
            const srcIdx = Math.floor(i * this._ratio);
            let s = channel[srcIdx];
            if (s > 1) s = 1; else if (s < -1) s = -1;
            out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          this.port.postMessage(out.buffer, [out.buffer]);
          return true;
        }
      }
      registerProcessor("deepgram-pcm-processor", DeepgramPcmProcessor);
    `;

    try {
      const blob = new Blob([workletSource], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      await worklet.addModule(url);
      const node = new AudioWorkletNode(ctx, "deepgram-pcm-processor", {
        processorOptions: { ratio },
      });
      node.port.onmessage = (event: MessageEvent) => {
        const buf = event.data as ArrayBuffer;
        this._sendAudio(buf);
      };
      source.connect(node);
      // Worklets don't need to reach the destination to run, but connecting
      // via a muted gain keeps Chrome from garbage-collecting the graph.
      this._workletNode = node;
      return true;
    } catch {
      // Fall back to script processor.
      return false;
    }
  }

  private _attachScriptProcessor(
    ctx: AudioContext,
    source: MediaStreamAudioSourceNode,
    ratio: number,
  ): void {
    // 4096-sample buffer at 48 kHz = ~85 ms, well under Deepgram's
    // end-of-turn heuristic. `createScriptProcessor` is deprecated but
    // still present in every shipping browser.
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (event: AudioProcessingEvent) => {
      const input = event.inputBuffer.getChannelData(0);
      const outLen = Math.floor(input.length / ratio);
      const out = new Int16Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const srcIdx = Math.floor(i * ratio);
        let s = input[srcIdx] ?? 0;
        if (s > 1) s = 1;
        else if (s < -1) s = -1;
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this._sendAudio(out.buffer);
    };
    source.connect(node);
    // ScriptProcessor must reach the destination or `onaudioprocess` won't
    // fire. Route through a zero-gain node so the mic isn't echoed.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(ctx.destination);
    this._scriptNode = node;
  }

  private _sendAudio(buffer: ArrayBuffer): void {
    const ws = this._ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(buffer);
    } catch {
      // Send can throw if the socket closes between the readyState check
      // and the call. Onclose will clean up.
    }
  }

  private _teardown(): void {
    const wasListening = this._listening;
    this._listening = false;

    if (this._workletNode) {
      try {
        this._workletNode.port.onmessage = null;
        this._workletNode.disconnect();
      } catch {
        /* ignore */
      }
      this._workletNode = null;
    }
    if (this._scriptNode) {
      try {
        this._scriptNode.onaudioprocess = null;
        this._scriptNode.disconnect();
      } catch {
        /* ignore */
      }
      this._scriptNode = null;
    }
    if (this._sourceNode) {
      try {
        this._sourceNode.disconnect();
      } catch {
        /* ignore */
      }
      this._sourceNode = null;
    }
    if (this._audioContext) {
      void this._audioContext.close().catch(() => {
        /* ignore */
      });
      this._audioContext = null;
    }
    if (this._stream) {
      this._stream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      });
      this._stream = null;
    }
    if (this._ws) {
      try {
        // A graceful close only matters once — guard so we don't re-enter
        // this branch from our own onclose handler.
        if (
          this._ws.readyState === WebSocket.OPEN ||
          this._ws.readyState === WebSocket.CONNECTING
        ) {
          this._ws.close(1000, "client-stop");
        }
      } catch {
        /* ignore */
      }
      this._ws = null;
    }
    if (wasListening) {
      this.onEnd?.();
    }
  }
}
