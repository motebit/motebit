// ---------------------------------------------------------------------------
// InworldSTTProvider — streaming STT over Inworld's WebSocket API
// ---------------------------------------------------------------------------
//
// Platform-agnostic STTProvider that streams 16-kHz PCM16 audio from the
// browser microphone to Inworld's `wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional`
// endpoint and emits interim + final transcripts to the STTProvider
// callback surface.
//
// Differs from `DeepgramSTTProvider` in five concrete ways (verified
// against Inworld docs fetched 2026-05-03):
//
//   1. Auth via URL query parameter (`?authorization=Basic%20<key>`)
//      because browsers can't set custom headers on WebSocket
//      connections, and Inworld doesn't use subprotocols like Deepgram.
//   2. Initial config message required as the first frame:
//      `{ transcribe_config: { modelId, audioEncoding, sampleRateHertz, ... } }`.
//   3. Audio chunks are JSON-wrapped base64, NOT raw binary frames:
//      `{ audio_chunk: { content: "<base64>" } }`. More bandwidth than
//      raw binary, but Inworld's protocol mandates this shape.
//   4. Response shape differs: `{ result: { transcription: { transcript, isFinal } } }`
//      instead of Deepgram's channel/alternatives nesting.
//   5. Graceful close requires `{ close_stream: {} }` before the socket
//      ws.close().
//
// Audio capture pipeline (mic → AudioContext → PCM16 16 kHz mono via
// AudioWorklet, with ScriptProcessor fallback) is identical to
// `DeepgramSTTProvider`. Error vocabulary mirrors WebSpeech / Deepgram
// so the surface keeper's fatal-error check stays source of truth.

import type { STTProvider, STTOptions } from "./stt.js";

/**
 * Configuration for the Inworld STT adapter.
 */
export interface InworldSTTConfig {
  /** Inworld API key. Same key used by `InworldTTSProvider`. */
  apiKey: string;
  /**
   * Inworld model id. Default routes to AssemblyAI's universal-streaming
   * multilingual model under Inworld's multi-provider STT API.
   */
  model?: string;
  /** BCP-47 language tag. Defaults to `"en-US"`. */
  language?: string;
  /** Base URL. Defaults to `"wss://api.inworld.ai"`. */
  baseUrl?: string;
}

const TARGET_SAMPLE_RATE = 16000;

/** Shape of an Inworld STT response frame. */
interface InworldResultFrame {
  result?: {
    transcription?: {
      transcript?: string;
      isFinal?: boolean;
    };
  };
}

/**
 * Streaming STTProvider backed by Inworld's multi-provider STT API.
 *
 * Lifecycle:
 *   1. `start()` opens the socket (auth via query string), sends the
 *      `transcribe_config` first message, then requests mic access and
 *      starts streaming JSON-wrapped base64 PCM16 chunks.
 *   2. Incoming JSON frames fire `onResult(transcript, isFinal)`.
 *   3. `stop()` sends `close_stream`, tears down the socket, mic, and
 *      audio graph.
 */
export class InworldSTTProvider implements STTProvider {
  private _listening = false;
  private _ws: WebSocket | null = null;
  private _stream: MediaStream | null = null;
  private _audioContext: AudioContext | null = null;
  private _sourceNode: MediaStreamAudioSourceNode | null = null;
  private _workletNode: AudioWorkletNode | null = null;
  private _scriptNode: ScriptProcessorNode | null = null;
  private _stopping = false;
  private _continuous = true;
  private _configSent = false;

  private readonly apiKey: string;
  private readonly model: string;
  private readonly language: string;
  private readonly baseUrl: string;

  onResult: ((transcript: string, isFinal: boolean) => void) | null = null;
  onError: ((error: string) => void) | null = null;
  onEnd: (() => void) | null = null;

  constructor(config: InworldSTTConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "assemblyai/universal-streaming-multilingual";
    this.language = config.language ?? "en-US";
    this.baseUrl = config.baseUrl ?? "wss://api.inworld.ai";
  }

  get listening(): boolean {
    return this._listening;
  }

  start(options?: STTOptions): void {
    if (this._listening) return;

    this._listening = true;
    this._stopping = false;
    this._configSent = false;
    this._continuous = options?.continuous ?? true;

    const language = options?.language ?? this.language;
    const url = this._buildUrl();

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err: unknown) {
      this._listening = false;
      this.onError?.(
        `inworld-socket-open-failed:${err instanceof Error ? err.message : String(err)}`,
      );
      this.onEnd?.();
      return;
    }
    // Inworld returns text JSON frames — set explicitly even though the
    // default works, mirrors the DG style.
    ws.binaryType = "arraybuffer";
    this._ws = ws;

    ws.onopen = () => {
      // Inworld requires a config message as the first frame before any
      // audio chunks. Send it synchronously, then attach the mic.
      this._sendConfig(language);
      void this._attachMicrophone();
    };

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      let frame: InworldResultFrame;
      try {
        frame = JSON.parse(event.data) as InworldResultFrame;
      } catch {
        return;
      }
      const tx = frame.result?.transcription;
      const transcript = tx?.transcript;
      if (transcript == null || transcript === "") return;
      const isFinal = tx?.isFinal === true;
      this.onResult?.(transcript, isFinal);

      if (isFinal && !this._continuous) {
        this._teardown();
      }
    };

    ws.onerror = () => {
      this.onError?.("inworld-socket-error");
    };

    ws.onclose = (event: CloseEvent) => {
      if (!this._stopping && event.code !== 1000 && event.code !== 1005) {
        this.onError?.(`inworld-${event.code}`);
      }
      this._teardown();
    };
  }

  stop(): void {
    if (!this._listening) return;
    this._stopping = true;
    // Send the explicit close_stream message Inworld expects before
    // tearing down the socket. Best-effort — if the socket already
    // dropped, _teardown still runs.
    this._sendCloseStream();
    this._teardown();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private _buildUrl(): string {
    // Auth lives in the query string because browsers can't set custom
    // headers on WebSocket connections. URL-encode the entire
    // `Basic <apiKey>` value so the space and any special chars in the
    // key don't break the URL.
    const auth = encodeURIComponent(`Basic ${this.apiKey}`);
    return `${this.baseUrl}/stt/v1/transcribe:streamBidirectional?authorization=${auth}`;
  }

  private _sendConfig(language: string): void {
    const ws = this._ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(
        JSON.stringify({
          transcribe_config: {
            modelId: this.model,
            audioEncoding: "LINEAR16",
            sampleRateHertz: TARGET_SAMPLE_RATE,
            numberOfChannels: 1,
            language,
          },
        }),
      );
      this._configSent = true;
    } catch {
      // Socket may have closed between readyState check and send. onclose
      // handles cleanup.
    }
  }

  private _sendCloseStream(): void {
    const ws = this._ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ close_stream: {} }));
    } catch {
      /* ignore */
    }
  }

  private async _attachMicrophone(): Promise<void> {
    if (this._stopping || !this._ws || this._ws.readyState !== WebSocket.OPEN) return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err: unknown) {
      const name = err instanceof Error ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        this.onError?.("not-allowed");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        this.onError?.("service-not-allowed");
      } else {
        this.onError?.(`inworld-mic-error:${name || String(err)}`);
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

    this._attachScriptProcessor(ctx, source, ratio);
  }

  private async _tryAttachWorklet(
    ctx: AudioContext,
    source: MediaStreamAudioSourceNode,
    ratio: number,
  ): Promise<boolean> {
    const worklet = (ctx as AudioContext & { audioWorklet?: AudioWorklet }).audioWorklet;
    if (worklet == null || typeof worklet.addModule !== "function") return false;

    // Same inline PCM16 worklet shape as DeepgramSTTProvider — no runtime
    // file deps. Different processor name to avoid collision when both
    // providers exist in the same page.
    const workletSource = `
      class InworldPcmProcessor extends AudioWorkletProcessor {
        constructor(options) {
          super();
          this._ratio = (options && options.processorOptions && options.processorOptions.ratio) || 1;
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
      registerProcessor("inworld-pcm-processor", InworldPcmProcessor);
    `;

    try {
      const blob = new Blob([workletSource], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      await worklet.addModule(url);
      const node = new AudioWorkletNode(ctx, "inworld-pcm-processor", {
        processorOptions: { ratio },
      });
      node.port.onmessage = (event: MessageEvent) => {
        const buf = event.data as ArrayBuffer;
        this._sendAudio(buf);
      };
      source.connect(node);
      this._workletNode = node;
      return true;
    } catch {
      return false;
    }
  }

  private _attachScriptProcessor(
    ctx: AudioContext,
    source: MediaStreamAudioSourceNode,
    ratio: number,
  ): void {
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
    const mute = ctx.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(ctx.destination);
    this._scriptNode = node;
  }

  private _sendAudio(buffer: ArrayBuffer): void {
    const ws = this._ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!this._configSent) return;
    try {
      // Inworld expects JSON-wrapped base64 audio chunks, NOT raw binary
      // frames. Encode the PCM16 buffer as base64.
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        const slice = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, Array.from(slice));
      }
      const base64 = btoa(binary);
      ws.send(JSON.stringify({ audio_chunk: { content: base64 } }));
    } catch {
      /* socket race — onclose handles cleanup */
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
        if (
          this._ws.readyState === WebSocket.OPEN ||
          this._ws.readyState === WebSocket.CONNECTING
        ) {
          this._ws.close(1000);
        }
      } catch {
        /* ignore */
      }
      this._ws = null;
    }
    this._configSent = false;
    if (wasListening) this.onEnd?.();
  }
}
