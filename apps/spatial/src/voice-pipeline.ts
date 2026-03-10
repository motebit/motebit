/**
 * SpatialVoicePipeline — ambient voice interface for the spatial creature.
 *
 * Replaces the original VoiceInterface with @motebit/voice adapters:
 * - STT: WebSpeechSTTProvider (continuous, auto-restart)
 * - TTS: FallbackTTSProvider chaining OpenAI TTS → Web Speech TTS
 * - VAD: Silero VAD v5 (@ricky0123/vad-web) with energy heuristic fallback
 * - Audio analysis: AnalyserNode feeding AudioReactivity into render engine
 *
 * The pipeline manages microphone lifecycle, VAD-gated STT activation,
 * ambient audio analysis (creature body language), and TTS playback.
 */

import { stripTags } from "@motebit/ai-core";
import {
  WebSpeechSTTProvider,
  WebSpeechTTSProvider,
  OpenAITTSProvider,
  FallbackTTSProvider,
  type STTProvider,
  type TTSProvider,
  type OpenAITTSVoice,
} from "@motebit/voice";
import type { AudioReactivity } from "@motebit/render-engine";

// === Types ===

export type PipelineState =
  | "off" // Microphone not initialized
  | "ambient" // Listening for VAD onset, feeding audio analysis
  | "listening" // VAD triggered, STT active
  | "processing" // Transcript sent to AI
  | "speaking"; // TTS playing

export interface VoicePipelineConfig {
  /** OpenAI API key for high-quality TTS (optional — falls back to Web Speech). */
  openaiApiKey?: string;
  /** OpenAI TTS voice. Default: "nova". */
  openaiVoice?: OpenAITTSVoice;
  /** VAD sensitivity: 0 (least sensitive) to 1 (most sensitive). Default: 0.5. */
  vadSensitivity?: number;
}

export interface VoicePipelineCallbacks {
  /** Called with final transcript text. */
  onTranscript?: (text: string) => void;
  /** Called when pipeline state changes. */
  onStateChange?: (state: PipelineState) => void;
  /** Called each analysis frame with audio energy for render engine. */
  onAudioReactivity?: (energy: AudioReactivity) => void;
}

// === Constants ===

const FFT_SIZE = 256;
const SMOOTHING_CONSTANT = 0.4;

// VAD energy heuristic (fallback when Silero unavailable)
const VAD_ONSET_MS = 300;
const VAD_CONFIDENCE_THRESHOLD = 0.55;
const SILENCE_DURATION_MS = 1500;
const SPEECH_RMS_THRESHOLD = 0.015;

// === Pipeline ===

export class SpatialVoicePipeline {
  private _state: PipelineState = "off";
  private callbacks: VoicePipelineCallbacks = {};
  private config: Required<VoicePipelineConfig>;

  // Audio infrastructure
  private audioContext: AudioContext | null = null;
  private analyserNode: AnalyserNode | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;

  // STT + TTS
  private stt: STTProvider | null = null;
  private tts: TTSProvider | null = null;

  // VAD state
  private vadInstance: { destroy: () => void; pause: () => void; start: () => void } | null = null;
  private sileroFailed = false;

  // Energy heuristic state (fallback VAD)
  private noiseFloor = 0;
  private smoothedRms = 0;
  private smoothedLow = 0;
  private smoothedMid = 0;
  private smoothedHigh = 0;
  private smoothedFlatness = 0;
  private fallbackSpeechConfidence = 0;
  private fallbackSpeechOnsetTime = 0;
  private lastSpeechTime = 0;

  // Animation loop
  private analysisAnimId = 0;

  // Reusable typed arrays (allocated once)
  private timeDomain: Uint8Array<ArrayBuffer> | null = null;
  private freqDomain: Uint8Array<ArrayBuffer> | null = null;

  constructor(config?: VoicePipelineConfig, callbacks?: VoicePipelineCallbacks) {
    this.config = {
      openaiApiKey: config?.openaiApiKey ?? "",
      openaiVoice: config?.openaiVoice ?? "nova",
      vadSensitivity: config?.vadSensitivity ?? 0.5,
    };
    if (callbacks) this.callbacks = callbacks;
  }

  get state(): PipelineState {
    return this._state;
  }

  get isSpeaking(): boolean {
    return this._state === "speaking";
  }

  get isListening(): boolean {
    return this._state === "listening" || this._state === "ambient";
  }

  // === Lifecycle ===

  /**
   * Initialize microphone, audio analysis, VAD, STT, and TTS.
   * Returns false if microphone access is denied.
   */
  async start(): Promise<boolean> {
    if (this._state !== "off") return true;

    // 1. Get microphone
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      return false;
    }

    // 2. Audio context + analyser
    this.audioContext = new AudioContext();
    this.analyserNode = this.audioContext.createAnalyser();
    this.analyserNode.fftSize = FFT_SIZE;
    this.analyserNode.smoothingTimeConstant = SMOOTHING_CONSTANT;

    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.sourceNode.connect(this.analyserNode);

    this.timeDomain = new Uint8Array(this.analyserNode.frequencyBinCount);
    this.freqDomain = new Uint8Array(this.analyserNode.frequencyBinCount);

    // 3. Initialize STT
    this.stt = new WebSpeechSTTProvider();
    this.stt.onResult = (transcript: string, isFinal: boolean) => {
      if (isFinal && transcript.trim()) {
        this.callbacks.onTranscript?.(transcript.trim());
      }
    };
    this.stt.onEnd = () => {
      // STT ended — if we were listening, return to ambient
      if (this._state === "listening") {
        this.transitionTo("ambient");
      }
    };

    // 4. Initialize TTS
    this.tts = this.buildTTSChain();

    // 5. Try Silero VAD
    await this.initVAD();

    // 6. Start ambient analysis loop
    this.transitionTo("ambient");
    this.startAnalysisLoop();

    return true;
  }

  /** Stop everything and release resources. */
  stop(): void {
    this.stopAnalysisLoop();

    if (this.stt?.listening === true) {
      this.stt.stop();
    }

    this.tts?.cancel();

    if (this.vadInstance) {
      try {
        this.vadInstance.destroy();
      } catch {
        /* ignore */
      }
      this.vadInstance = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }

    if (this.audioContext) {
      void this.audioContext.close();
      this.audioContext = null;
    }

    this.analyserNode = null;
    this.timeDomain = null;
    this.freqDomain = null;

    this.transitionTo("off");
  }

  // === TTS ===

  /**
   * Speak text aloud. Strips motebit tags first.
   * Transitions to "speaking" state, then back to "ambient".
   */
  async speak(text: string): Promise<void> {
    if (!this.tts) return;

    const clean = stripTags(text);
    if (!clean.trim()) return;

    // Pause STT while speaking to avoid feedback loop
    if (this.stt?.listening === true) {
      this.stt.stop();
    }

    this.transitionTo("speaking");

    try {
      await this.tts.speak(clean);
    } catch (err: unknown) {
      // eslint-disable-next-line no-console
      console.warn("[voice-pipeline] TTS error:", err instanceof Error ? err.message : String(err));
    } finally {
      this.transitionTo("ambient");
    }
  }

  /** Cancel ongoing speech. */
  cancelSpeech(): void {
    this.tts?.cancel();
    if (this._state === "speaking") {
      this.transitionTo("ambient");
    }
  }

  // === Processing state ===

  /** Signal that a transcript has been sent to the AI for processing. */
  markProcessing(): void {
    this.transitionTo("processing");
  }

  /** Signal that AI processing is complete (call speak() or markIdle()). */
  markIdle(): void {
    if (this._state === "processing") {
      this.transitionTo("ambient");
    }
  }

  // === Configuration ===

  /** Update TTS configuration (e.g. after settings change). */
  updateConfig(config: Partial<VoicePipelineConfig>): void {
    if (config.openaiApiKey !== undefined) this.config.openaiApiKey = config.openaiApiKey;
    if (config.openaiVoice !== undefined) this.config.openaiVoice = config.openaiVoice;
    if (config.vadSensitivity !== undefined) this.config.vadSensitivity = config.vadSensitivity;

    // Rebuild TTS chain if API key changed
    if (config.openaiApiKey !== undefined) {
      this.tts = this.buildTTSChain();
    }
  }

  /** Update callbacks. */
  setCallbacks(callbacks: Partial<VoicePipelineCallbacks>): void {
    if (callbacks.onTranscript !== undefined) this.callbacks.onTranscript = callbacks.onTranscript;
    if (callbacks.onStateChange !== undefined)
      this.callbacks.onStateChange = callbacks.onStateChange;
    if (callbacks.onAudioReactivity !== undefined)
      this.callbacks.onAudioReactivity = callbacks.onAudioReactivity;
  }

  // === Internals: TTS chain ===

  private buildTTSChain(): TTSProvider {
    const providers: TTSProvider[] = [];

    if (this.config.openaiApiKey) {
      providers.push(
        new OpenAITTSProvider({
          apiKey: this.config.openaiApiKey,
          voice: this.config.openaiVoice,
          audioContext: this.audioContext ?? undefined,
        }),
      );
    }

    providers.push(new WebSpeechTTSProvider());

    return providers.length === 1 ? providers[0]! : new FallbackTTSProvider(providers);
  }

  // === Internals: VAD ===

  private async initVAD(): Promise<void> {
    try {
      // Dynamic import — @ricky0123/vad-web is optional
      const vadModule = await import("@ricky0123/vad-web");
      const MicVAD = vadModule.MicVAD;

      if (MicVAD == null || !this.mediaStream) {
        this.sileroFailed = true;
        return;
      }

      // MicVAD uses a static factory method .new()
      const vad = await MicVAD.new({
        stream: this.mediaStream,
        positiveSpeechThreshold: 0.6 - this.config.vadSensitivity * 0.3,
        negativeSpeechThreshold: 0.3 - this.config.vadSensitivity * 0.1,
        onSpeechStart: () => this.onVADSpeechStart(),
        onSpeechEnd: () => this.onVADSpeechEnd(),
      });

      vad.start();
      this.vadInstance = vad;
    } catch {
      this.sileroFailed = true;
    }
  }

  private onVADSpeechStart(): void {
    if (this._state !== "ambient") return;
    this.lastSpeechTime = performance.now();
    this.startSTT();
  }

  private onVADSpeechEnd(): void {
    if (this._state === "listening") {
      // Give STT a moment to finalize, then return to ambient
      setTimeout(() => {
        if (this._state === "listening" && this.stt) {
          this.stt.stop();
          this.transitionTo("ambient");
        }
      }, 500);
    }
  }

  private startSTT(): void {
    if (!this.stt || this.stt.listening) return;
    this.transitionTo("listening");
    this.stt.start({ continuous: true, interimResults: false, language: "en-US" });
  }

  // === Internals: Audio Analysis Loop ===

  private startAnalysisLoop(): void {
    if (this.analysisAnimId) return;

    const analyze = (): void => {
      if (this._state === "off" || !this.analyserNode || !this.timeDomain || !this.freqDomain)
        return;

      this.analyserNode.getByteTimeDomainData(this.timeDomain);
      this.analyserNode.getByteFrequencyData(this.freqDomain);

      // RMS energy
      let sumSq = 0;
      for (let j = 0; j < this.timeDomain.length; j++) {
        const v = this.timeDomain[j]! / 128.0 - 1.0;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / this.timeDomain.length);
      this.smoothedRms += (rms > this.smoothedRms ? 0.3 : 0.04) * (rms - this.smoothedRms);

      // Noise floor tracking
      this.noiseFloor += (rms > this.noiseFloor ? 0.003 : 0.05) * (rms - this.noiseFloor);

      // Frequency band analysis
      const binCount = this.freqDomain.length;
      const lowEnd = Math.max(1, Math.floor(binCount * 0.06));
      const midEnd = Math.max(2, Math.floor(binCount * 0.25));
      let lowE = 0,
        midE = 0,
        highE = 0;
      for (let j = 0; j < binCount; j++) {
        const v = this.freqDomain[j]! / 255;
        if (j < lowEnd) lowE += v;
        else if (j < midEnd) midE += v;
        else highE += v;
      }
      lowE /= lowEnd;
      midE /= midEnd - lowEnd;
      highE /= binCount - midEnd;

      this.smoothedLow += (lowE > this.smoothedLow ? 0.3 : 0.04) * (lowE - this.smoothedLow);
      this.smoothedMid += (midE > this.smoothedMid ? 0.3 : 0.04) * (midE - this.smoothedMid);
      this.smoothedHigh += (highE > this.smoothedHigh ? 0.25 : 0.03) * (highE - this.smoothedHigh);

      // Spectral flatness (for fallback VAD)
      let logSum = 0;
      let linSum = 0;
      for (let j = lowEnd; j < midEnd; j++) {
        const v = this.freqDomain[j]! / 255 + 1e-10;
        logSum += Math.log(v);
        linSum += v;
      }
      const flatBins = midEnd - lowEnd;
      const rawFlatness = linSum > 1e-8 ? Math.exp(logSum / flatBins) / (linSum / flatBins) : 0;
      this.smoothedFlatness += 0.08 * (rawFlatness - this.smoothedFlatness);

      // Noise-gated energy
      const gatedRms = Math.max(0, this.smoothedRms - this.noiseFloor);
      const gate = this.smoothedRms > 0.001 ? gatedRms / this.smoothedRms : 0;

      // Spectral shaping for audio reactivity
      const flat2 = this.smoothedFlatness * this.smoothedFlatness;
      const damping = Math.max(0.15, 1 - flat2 * 0.9);
      const shimmer = 1 + (1 - this.smoothedFlatness) * 0.6;

      // Feed audio reactivity to render engine
      this.callbacks.onAudioReactivity?.({
        rms: gatedRms * damping,
        low: this.smoothedLow * gate * damping,
        mid: this.smoothedMid * gate * damping,
        high: this.smoothedHigh * gate * damping * shimmer,
      });

      // Fallback VAD (energy heuristic) when Silero is unavailable
      if (this.sileroFailed && this._state === "ambient") {
        this.runFallbackVAD(gatedRms);
      }

      // Silence detection — return to ambient if no speech for SILENCE_DURATION_MS
      if (this._state === "listening" && gatedRms < SPEECH_RMS_THRESHOLD) {
        if (performance.now() - this.lastSpeechTime > SILENCE_DURATION_MS) {
          if (this.stt?.listening === true) this.stt.stop();
          this.transitionTo("ambient");
        }
      } else if (this._state === "listening" && gatedRms >= SPEECH_RMS_THRESHOLD) {
        this.lastSpeechTime = performance.now();
      }

      this.analysisAnimId = requestAnimationFrame(analyze);
    };

    this.analysisAnimId = requestAnimationFrame(analyze);
  }

  private stopAnalysisLoop(): void {
    if (this.analysisAnimId) {
      cancelAnimationFrame(this.analysisAnimId);
      this.analysisAnimId = 0;
    }
  }

  /**
   * Fallback VAD: detect speech via spectral flatness + RMS energy + mid-band prominence.
   * Ported from apps/desktop/src/ui/voice.ts:527-551.
   */
  private runFallbackVAD(gatedRms: number): void {
    const sensitivity = this.config.vadSensitivity;
    const rmsThreshold = 0.02 * (1.1 - sensitivity);
    const midThreshold = 0.08 * (1.1 - sensitivity);

    const isSpeechLike =
      this.smoothedFlatness < 0.65 && gatedRms > rmsThreshold && this.smoothedMid > midThreshold;

    if (isSpeechLike) {
      this.fallbackSpeechConfidence += 0.08 * (1 - this.fallbackSpeechConfidence);
      if (this.fallbackSpeechConfidence > VAD_CONFIDENCE_THRESHOLD) {
        if (this.fallbackSpeechOnsetTime === 0) {
          this.fallbackSpeechOnsetTime = performance.now();
        } else if (performance.now() - this.fallbackSpeechOnsetTime > VAD_ONSET_MS) {
          this.fallbackSpeechConfidence = 0;
          this.fallbackSpeechOnsetTime = 0;
          this.lastSpeechTime = performance.now();
          this.startSTT();
        }
      }
    } else {
      this.fallbackSpeechConfidence *= 0.9;
      if (this.fallbackSpeechConfidence < 0.2) {
        this.fallbackSpeechOnsetTime = 0;
      }
    }
  }

  // === State transitions ===

  private transitionTo(state: PipelineState): void {
    if (this._state === state) return;
    this._state = state;
    this.callbacks.onStateChange?.(state);
  }

  // === Static ===

  /** Check if voice pipeline can run in this browser. */
  static isSupported(): boolean {
    return !!(
      typeof window !== "undefined" &&
      typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function" &&
      (typeof AudioContext !== "undefined" ||
        typeof (window as unknown as Record<string, unknown>).webkitAudioContext !== "undefined")
    );
  }
}
