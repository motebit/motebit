import { MicVAD } from "@ricky0123/vad-web";
import {
  WebSpeechTTSProvider,
  WebSpeechSTTProvider,
  ElevenLabsTTSProvider,
  FallbackTTSProvider,
  StreamingTTSQueue,
  computeSpeechEnergy,
  createWaveformState,
  renderVoiceWaveform,
  waveformColorFromSoul,
} from "@motebit/voice";
import type { TTSProvider, WaveformState } from "@motebit/voice";
import { stripTags } from "@motebit/ai-core";
import type { InteriorColor, InvokeFn } from "../index";
import { TauriTTSProvider } from "../tauri-tts";
import { ELEVENLABS_API_KEY_SLOT } from "./keyring-keys";
import type { DesktopContext, MicState } from "../types";
import { addMessage } from "./chat";

// === TTS Providers ===

const webSpeechTts = new WebSpeechTTSProvider(["Samantha", "Karen", "Daniel", "Alex"]);
let ttsProvider: TTSProvider = webSpeechTts;
const sttProvider = new WebSpeechSTTProvider();
let ttsVoice = "alloy";

/**
 * Rebuild the active TTS chain. Synchronous to match the existing API, but
 * kicks off an async keyring read for the ElevenLabs BYOK key — the provider
 * reference is swapped in place once the key is known. Chain order:
 *
 *   1. ElevenLabs (L0, direct API) — if `elevenlabs_api_key` is in keyring
 *   2. Tauri OpenAI TTS — if an `invoke` handle is available (desktop only)
 *   3. Web Speech — always present as the terminal fallback
 *
 * `FallbackTTSProvider` steps down the chain only on transport/API failures,
 * so users who set a quota-exhausted ElevenLabs key still get audio through
 * the OpenAI adapter rather than falling silent.
 */
function rebuildTtsProvider(invoke?: InvokeFn): void {
  // Immediate (synchronous) chain — lands first so the caller has a working
  // provider even if the keyring read is slow or fails.
  const immediateChain: TTSProvider[] = [];
  if (invoke) immediateChain.push(new TauriTTSProvider(invoke, { voice: ttsVoice }));
  immediateChain.push(webSpeechTts);
  ttsProvider =
    immediateChain.length === 1 ? immediateChain[0]! : new FallbackTTSProvider(immediateChain);

  if (!invoke) return;

  // Async swap-in of the full chain once the ElevenLabs key is known.
  void (async () => {
    let elevenLabsKey: string | null = null;
    try {
      elevenLabsKey = await invoke<string | null>("keyring_get", {
        key: ELEVENLABS_API_KEY_SLOT,
      });
    } catch {
      // Keyring unavailable — fall through with the immediate chain.
    }
    if (elevenLabsKey == null || elevenLabsKey === "") return;

    // Desktop's `ttsVoice` preference uses OpenAI voice names — don't forward
    // it to ElevenLabs (which would 404 on "alloy" / "nova"). The L0 provider
    // defaults to "Rachel" internally. Passing a raw ElevenLabs voice_id is
    // supported by the provider shape when the surface surfaces it later.
    const chain: TTSProvider[] = [
      new ElevenLabsTTSProvider({ apiKey: elevenLabsKey }),
      new TauriTTSProvider(invoke, { voice: ttsVoice }),
      webSpeechTts,
    ];
    ttsProvider = new FallbackTTSProvider(chain);
  })();
}

// === Voice State ===

let micState: MicState = "off";
let audioContext: AudioContext | null = null;
let analyserNode: AnalyserNode | null = null;
let micStream: MediaStream | null = null;
let waveformAnimationId = 0;
let ambientAnimationId = 0;
let voiceFinalTranscript = "";
let voiceInterimTranscript = "";
// Shared waveform state — the renderer owns smoothing + noise-floor EMA.
const waveformState: WaveformState = createWaveformState();

let sttAvailable = true;
let sttErrorShown = false;

let mediaRecorder: MediaRecorder | null = null;
let mediaRecorderChunks: Blob[] = [];

let voiceAutoSend = true;
let voiceResponseEnabled = true;

let ttsSpeaking = false;
let ttsPulseAnimationId = 0;

let noiseFloor = 0;

let sileroVad: MicVAD | null = null;
let sileroVadFailed = false;

let fallbackSpeechConfidence = 0;
let fallbackSpeechOnsetTime = 0;
const VAD_ONSET_MS = 300;
const VAD_CONFIDENCE_THRESHOLD = 0.55;

let speechActiveInVoice = false;
let silenceOnsetTime = 0;
const SILENCE_DURATION_MS = 1200;
const SPEECH_RMS_THRESHOLD = 0.02;

// Cooldown after TTS to prevent mic picking up speaker output
let ttsCooldownUntil = 0;
const TTS_COOLDOWN_MS = 800;

let waveformColor = { r: 153, g: 163, b: 230 };
let micErrorShown = false;

// === DOM Refs ===

const micBtn = document.getElementById("mic-btn") as HTMLButtonElement;
const voiceWaveform = document.getElementById("voice-waveform") as HTMLCanvasElement;
const voiceTranscript = document.getElementById("voice-transcript") as HTMLSpanElement;
const inputBarWrapper = document.getElementById("input-bar-wrapper") as HTMLDivElement;
const chatInput = document.getElementById("chat-input") as HTMLInputElement;

// === Voice API ===

export interface VoiceAPI {
  getMicState(): MicState;
  toggleVoice(): void;
  stopVoice(transfer: boolean, toAmbient: boolean): void;
  stopAmbient(): void;
  speakAssistantResponse(text: string): void;
  pushTTSChunk(delta: string): void;
  flushTTS(): void;
  cancelStreamingTTS(): void;
  cancelTTS(): void;
  updateVoiceGlowColor(): void;
  rebuildTtsProvider(invoke?: InvokeFn): void;
  sizeWaveformCanvas(): void;
  getVoiceAutoSend(): boolean;
  setVoiceAutoSend(v: boolean): void;
  getVoiceResponseEnabled(): boolean;
  setVoiceResponseEnabled(v: boolean): void;
  getTtsVoice(): string;
  setTtsVoice(v: string): void;
  releaseAudioResources(): void;
}

export interface VoiceCallbacks {
  onTranscriptReady(): Promise<void>;
  getActiveColor(): InteriorColor | null;
}

export function initVoice(ctx: DesktopContext, callbacks: VoiceCallbacks): VoiceAPI {
  function updateVoiceGlowColor(): void {
    const color = callbacks.getActiveColor();
    if (!color) return;
    const glow = color.glow;

    const r = Math.round(glow[0] * 255);
    const green = Math.round(glow[1] * 255);
    const b = Math.round(glow[2] * 255);
    inputBarWrapper.style.setProperty("--voice-glow-color", `rgba(${r},${green},${b},0.55)`);

    waveformColor = waveformColorFromSoul(glow);
  }

  function permissionHint(target: "microphone" | "speech"): string {
    const ua = navigator.userAgent;
    if (/Macintosh|Mac OS X/i.test(ua)) {
      const pane = target === "microphone" ? "Microphone" : "Speech Recognition";
      return `open macOS System Settings > Privacy & Security > ${pane}`;
    }
    if (/Windows/i.test(ua)) {
      const pane = target === "microphone" ? "Microphone" : "Speech";
      return `open Windows Settings > Privacy > ${pane}`;
    }
    return `check your OS privacy settings for ${target} access`;
  }

  async function ensureAudioPipeline(): Promise<boolean> {
    if (audioContext && analyserNode && micStream) return true;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (!micErrorShown) {
        micErrorShown = true;
        addMessage(
          "system",
          `Microphone access denied — ${permissionHint("microphone")}, then grant access to Motebit.`,
        );
      }
      return false;
    }
    micStream = stream;

    const acx = new AudioContext();
    const source = acx.createMediaStreamSource(stream);
    const analyser = acx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.4;
    source.connect(analyser);
    audioContext = acx;
    analyserNode = analyser;
    return true;
  }

  function releaseAudioResources(): void {
    if (audioContext) {
      void audioContext.close();
      audioContext = null;
      analyserNode = null;
    }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    fallbackSpeechConfidence = 0;
    fallbackSpeechOnsetTime = 0;
    speechActiveInVoice = false;
    silenceOnsetTime = 0;
  }

  async function initSileroVad(): Promise<void> {
    if (sileroVad || sileroVadFailed) return;
    if (!audioContext || !micStream) return;

    const acx = audioContext;
    const stream = micStream;

    try {
      sileroVad = await MicVAD.new({
        audioContext: acx,
        getStream: () => Promise.resolve(stream),
        pauseStream: () => Promise.resolve(),
        resumeStream: () => Promise.resolve(micStream!),
        positiveSpeechThreshold: 0.5,
        negativeSpeechThreshold: 0.35,
        minSpeechMs: 100,
        startOnLoad: false,
        model: "v5",
        baseAssetPath: "/",
        onnxWASMBasePath: "/",
        onSpeechStart: () => {
          if (micState === "ambient" && performance.now() > ttsCooldownUntil) {
            void startVoice();
          }
        },
        onSpeechEnd: () => {},
        onVADMisfire: () => {},
      });
    } catch (err: unknown) {
      sileroVadFailed = true;
      // eslint-disable-next-line no-console
      console.warn(
        "Silero VAD failed to load, falling back to energy heuristic:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  function toggleVoice(): void {
    if (micState === "off") {
      void enterAmbient();
    } else if (micState === "ambient") {
      stopAmbient();
    } else if (micState === "voice") {
      stopVoice(true, false);
    } else if (micState === "speaking") {
      cancelTTS();
      void startVoice();
    } else if (micState === "transcribing") {
      voiceTranscript.textContent = "";
      voiceTranscript.style.display = "";
      inputBarWrapper.classList.remove("listening");
      micBtn.classList.remove("active");
      micBtn.classList.add("ambient");
      micState = "ambient";
      fallbackSpeechConfidence = 0;
      fallbackSpeechOnsetTime = 0;
      if (sileroVad) void sileroVad.start();
      startAmbientLoop();
    }
  }

  async function enterAmbient(): Promise<void> {
    if (!(await ensureAudioPipeline())) return;
    micState = "ambient";
    micBtn.classList.add("ambient");
    micBtn.classList.remove("active");
    fallbackSpeechConfidence = 0;
    fallbackSpeechOnsetTime = 0;
    updateVoiceGlowColor();
    await initSileroVad();
    if (sileroVad) {
      await sileroVad.start();
    }
    startAmbientLoop();
  }

  async function startVoice(): Promise<void> {
    cancelTTS();
    stopAmbientLoop();
    if (sileroVad) void sileroVad.pause();
    ctx.app.setAudioReactivity(null);

    fallbackSpeechConfidence = 0;
    fallbackSpeechOnsetTime = 0;
    speechActiveInVoice = false;
    silenceOnsetTime = 0;

    if (!(await ensureAudioPipeline())) return;

    if (sttAvailable) {
      sttProvider.onResult = (transcript: string, isFinal: boolean) => {
        if (isFinal) {
          voiceFinalTranscript += transcript;
          voiceInterimTranscript = "";
        } else {
          voiceInterimTranscript = transcript;
        }
        // No transcript overlay — the waveform is the feedback
      };

      sttProvider.onError = (error: string) => {
        if (error === "no-speech" || error === "aborted") return;
        if (
          error === "not-allowed" ||
          error === "service-not-allowed" ||
          error === "Microphone permission denied" ||
          error === "SpeechRecognition API not available"
        ) {
          sttAvailable = false;
          if (!sttErrorShown) {
            sttErrorShown = true;
            addMessage(
              "system",
              `Speech recognition needs permission — ${permissionHint("speech")}. Using Whisper fallback.`,
            );
          }
          return;
        }
        addMessage("system", `Voice error: ${error}`);
        stopVoice(false, false);
      };

      sttProvider.onEnd = () => {};

      try {
        sttProvider.start({ continuous: true, interimResults: true, language: "en-US" });
      } catch {
        sttAvailable = false;
      }
    }

    mediaRecorderChunks = [];
    if (micStream) {
      try {
        const mr = new MediaRecorder(micStream, { mimeType: "audio/webm;codecs=opus" });
        mr.ondataavailable = (e) => {
          if (e.data.size > 0) mediaRecorderChunks.push(e.data);
        };
        mr.start(250);
        mediaRecorder = mr;
      } catch {
        // MediaRecorder not available
      }
    }

    micState = "voice";
    voiceFinalTranscript = "";
    voiceInterimTranscript = "";
    voiceTranscript.textContent = "";
    inputBarWrapper.classList.add("listening");
    micBtn.classList.add("active");
    micBtn.classList.remove("ambient");
    updateVoiceGlowColor();

    sizeWaveformCanvas();
    startWaveformLoop();
  }

  function stopVoice(transfer: boolean, toAmbient: boolean): void {
    speechActiveInVoice = false;
    silenceOnsetTime = 0;

    if (sttProvider.listening) {
      sttProvider.stop();
    }

    const recorderWasActive = mediaRecorder?.state === "recording";
    if (mediaRecorder) {
      try {
        mediaRecorder.stop();
      } catch {
        /* */
      }
      mediaRecorder = null;
    }

    if (waveformAnimationId) {
      cancelAnimationFrame(waveformAnimationId);
      waveformAnimationId = 0;
    }
    const ctx2d = voiceWaveform.getContext("2d");
    if (ctx2d) ctx2d.clearRect(0, 0, voiceWaveform.width, voiceWaveform.height);

    const webSpeechText = (voiceFinalTranscript + voiceInterimTranscript).trim();
    voiceFinalTranscript = "";
    voiceInterimTranscript = "";

    if (transfer && webSpeechText && sttAvailable) {
      finishVoiceTranscript(webSpeechText, toAmbient);
    } else if (transfer && recorderWasActive && mediaRecorderChunks.length > 0) {
      micState = "transcribing";
      inputBarWrapper.classList.remove("listening");
      micBtn.classList.remove("active");
      micBtn.classList.add("ambient");
      voiceTranscript.textContent = "";
      voiceTranscript.style.display = "";
      void transcribeWithWhisper(toAmbient);
    } else {
      finishVoiceTranscript("", toAmbient);
    }
  }

  async function transcribeWithWhisper(toAmbient: boolean): Promise<void> {
    try {
      const blob = new Blob(mediaRecorderChunks, { type: "audio/webm;codecs=opus" });
      mediaRecorderChunks = [];

      const arrayBuf = await blob.arrayBuffer();
      const bytes = new Uint8Array(arrayBuf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]!);
      }
      const audioBase64 = btoa(binary);

      const config = ctx.getConfig();
      if (config?.isTauri !== true || config.invoke == null) {
        addMessage("system", "Whisper transcription requires the desktop app (Tauri)");
        finishVoiceTranscript("", toAmbient);
        return;
      }

      let whisperApiKey: string | undefined;
      try {
        const keyVal = await config.invoke<string | null>("keyring_get", {
          key: "whisper_api_key",
        });
        whisperApiKey = keyVal ?? undefined;
      } catch {
        // No key available
      }

      const transcript = await config.invoke<string>("transcribe_audio", {
        audioBase64,
        apiKey: whisperApiKey ?? null,
      });

      finishVoiceTranscript(transcript.trim(), toAmbient);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addMessage("system", msg);
      finishVoiceTranscript("", toAmbient);
    }
  }

  function finishVoiceTranscript(text: string, toAmbient: boolean): void {
    inputBarWrapper.classList.remove("listening");
    micBtn.classList.remove("active");
    voiceTranscript.textContent = "";
    voiceTranscript.style.display = "";

    if (text) {
      chatInput.value = text;
    }

    if (toAmbient) {
      micState = "ambient";
      micBtn.classList.add("ambient");
      if (sileroVad) void sileroVad.start();
      startAmbientLoop();
    } else {
      micState = "off";
      micBtn.classList.remove("ambient");
      releaseAudioResources();
      ctx.app.setAudioReactivity(null);
    }

    chatInput.focus();

    if (voiceAutoSend && text) {
      void callbacks.onTranscriptReady();
    }
  }

  function stopAmbient(): void {
    stopAmbientLoop();
    if (sileroVad) {
      void sileroVad.destroy();
      sileroVad = null;
    }
    releaseAudioResources();
    ctx.app.setAudioReactivity(null);
    micState = "off";
    micBtn.classList.remove("ambient");
    fallbackSpeechConfidence = 0;
    fallbackSpeechOnsetTime = 0;
  }

  function stopAmbientLoop(): void {
    if (ambientAnimationId) {
      cancelAnimationFrame(ambientAnimationId);
      ambientAnimationId = 0;
    }
  }

  function startAmbientLoop(): void {
    if (!analyserNode) return;

    const timeDomain = new Uint8Array(analyserNode.frequencyBinCount);
    const freqDomain = new Uint8Array(analyserNode.frequencyBinCount);
    let smoothedRms = 0;
    let smoothedLow = 0;
    let smoothedMid = 0;
    let smoothedHigh = 0;
    let smoothedFlatness = 0;

    const analyze = (): void => {
      if (micState !== "ambient" || !analyserNode) return;

      analyserNode.getByteTimeDomainData(timeDomain);
      analyserNode.getByteFrequencyData(freqDomain);

      let sumSq = 0;
      for (let j = 0; j < timeDomain.length; j++) {
        const v = timeDomain[j]! / 128.0 - 1.0;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / timeDomain.length);
      smoothedRms += (rms > smoothedRms ? 0.3 : 0.04) * (rms - smoothedRms);

      noiseFloor += (rms > noiseFloor ? 0.003 : 0.05) * (rms - noiseFloor);

      const binCount = freqDomain.length;
      const lowEnd = Math.max(1, Math.floor(binCount * 0.06));
      const midEnd = Math.max(2, Math.floor(binCount * 0.25));
      let lowE = 0,
        midE = 0,
        highE = 0;
      for (let j = 0; j < binCount; j++) {
        const v = freqDomain[j]! / 255;
        if (j < lowEnd) lowE += v;
        else if (j < midEnd) midE += v;
        else highE += v;
      }
      lowE /= lowEnd;
      midE /= midEnd - lowEnd;
      highE /= binCount - midEnd;

      smoothedLow += (lowE > smoothedLow ? 0.3 : 0.04) * (lowE - smoothedLow);
      smoothedMid += (midE > smoothedMid ? 0.3 : 0.04) * (midE - smoothedMid);
      smoothedHigh += (highE > smoothedHigh ? 0.25 : 0.03) * (highE - smoothedHigh);

      let logSum = 0;
      let linSum = 0;
      for (let j = lowEnd; j < midEnd; j++) {
        const v = freqDomain[j]! / 255 + 1e-10;
        logSum += Math.log(v);
        linSum += v;
      }
      const flatBins = midEnd - lowEnd;
      const rawFlatness = linSum > 1e-8 ? Math.exp(logSum / flatBins) / (linSum / flatBins) : 0;
      smoothedFlatness += 0.08 * (rawFlatness - smoothedFlatness);

      const gatedRms = Math.max(0, smoothedRms - noiseFloor);
      const gate = smoothedRms > 0.001 ? gatedRms / smoothedRms : 0;

      const flat2 = smoothedFlatness * smoothedFlatness;
      const damping = Math.max(0.15, 1 - flat2 * 0.9);
      const shimmer = 1 + (1 - smoothedFlatness) * 0.6;

      ctx.app.setAudioReactivity({
        rms: gatedRms * damping,
        low: smoothedLow * gate * damping,
        mid: smoothedMid * gate * damping,
        high: smoothedHigh * gate * damping * shimmer,
      });

      if (sileroVadFailed && performance.now() > ttsCooldownUntil) {
        const isSpeechLike = smoothedFlatness < 0.65 && gatedRms > 0.02 && smoothedMid > 0.08;

        if (isSpeechLike) {
          fallbackSpeechConfidence += 0.08 * (1 - fallbackSpeechConfidence);
          if (fallbackSpeechConfidence > VAD_CONFIDENCE_THRESHOLD) {
            if (fallbackSpeechOnsetTime === 0) {
              fallbackSpeechOnsetTime = performance.now();
            } else if (performance.now() - fallbackSpeechOnsetTime > VAD_ONSET_MS) {
              fallbackSpeechConfidence = 0;
              fallbackSpeechOnsetTime = 0;
              void startVoice();
              return;
            }
          }
        } else {
          fallbackSpeechConfidence *= 0.9;
          if (fallbackSpeechConfidence < 0.2) {
            fallbackSpeechOnsetTime = 0;
          }
        }
      }

      ambientAnimationId = requestAnimationFrame(analyze);
    };

    ambientAnimationId = requestAnimationFrame(analyze);
  }

  // === TTS ===

  function speakText(text: string): void {
    if (!voiceResponseEnabled || !text.trim()) return;

    ttsProvider.cancel();
    ttsSpeaking = true;
    micState = "speaking";
    micBtn.classList.remove("active");
    micBtn.classList.add("ambient");
    startTTSPulse();

    ttsProvider
      .speak(text)
      .then(() => {
        if (!ttsSpeaking) return;
        ttsSpeaking = false;
        stopTTSPulse();
        if (micStream && audioContext && analyserNode) {
          // Cooldown: wait before re-entering ambient to avoid picking up speaker echo
          ttsCooldownUntil = performance.now() + TTS_COOLDOWN_MS;
          micState = "ambient";
          micBtn.classList.add("ambient");
          setTimeout(() => {
            if (micState === "ambient") {
              if (sileroVad) void sileroVad.start();
              startAmbientLoop();
            }
          }, TTS_COOLDOWN_MS);
        } else {
          micState = "off";
          micBtn.classList.remove("ambient");
        }
      })
      .catch(() => {
        if (!ttsSpeaking) return;
        ttsSpeaking = false;
        stopTTSPulse();
        if (micState === "speaking") {
          micState = micStream ? "ambient" : "off";
          if (micState === "ambient") {
            ttsCooldownUntil = performance.now() + TTS_COOLDOWN_MS;
            setTimeout(() => {
              if (micState === "ambient") {
                if (sileroVad) void sileroVad.start();
                startAmbientLoop();
              }
            }, TTS_COOLDOWN_MS);
          }
        }
      });
  }

  function cancelTTS(): void {
    if (ttsSpeaking) {
      ttsProvider.cancel();
      ttsSpeaking = false;
      stopTTSPulse();
    }
  }

  function startTTSPulse(): void {
    stopTTSPulse();
    const startTime = performance.now();
    const pulse = (now: number): void => {
      if (!ttsSpeaking) return;
      const bands = computeSpeechEnergy((now - startTime) / 1000);
      ctx.app.setAudioReactivity(bands);
      ttsPulseAnimationId = requestAnimationFrame(pulse);
    };
    ttsPulseAnimationId = requestAnimationFrame(pulse);
  }

  function stopTTSPulse(): void {
    if (ttsPulseAnimationId) {
      cancelAnimationFrame(ttsPulseAnimationId);
      ttsPulseAnimationId = 0;
    }
    if (!ttsSpeaking) {
      ctx.app.setAudioReactivity(null);
    }
  }

  // --- Streaming TTS — speak sentences as they arrive during streaming ---

  const streamingQueue = new StreamingTTSQueue(
    (text) => ttsProvider.speak(text),
    () => {
      // Drain started — enter speaking state
      ttsSpeaking = true;
      micState = "speaking";
      micBtn.classList.remove("active");
      micBtn.classList.add("ambient");
      startTTSPulse();
    },
    () => {
      // Drain ended — return to ambient or off
      ttsSpeaking = false;
      stopTTSPulse();
      if (micStream && audioContext && analyserNode) {
        ttsCooldownUntil = performance.now() + TTS_COOLDOWN_MS;
        micState = "ambient";
        micBtn.classList.add("ambient");
        setTimeout(() => {
          if (micState === "ambient") {
            if (sileroVad) void sileroVad.start();
            startAmbientLoop();
          }
        }, TTS_COOLDOWN_MS);
      } else {
        micState = "off";
        micBtn.classList.remove("ambient");
      }
    },
  );

  function pushTTSChunk(delta: string): void {
    if (!voiceResponseEnabled) return;
    streamingQueue.push(delta);
  }

  function flushTTS(): void {
    if (!voiceResponseEnabled) return;
    streamingQueue.flush();
  }

  function cancelStreamingTTS(): void {
    streamingQueue.cancel();
    ttsProvider.cancel();
    ttsSpeaking = false;
    stopTTSPulse();
  }

  function speakAssistantResponse(text: string): void {
    if (!voiceResponseEnabled) return;
    const clean = stripTags(text).trim();
    if (clean) speakText(clean);
  }

  function sizeWaveformCanvas(): void {
    const rect = inputBarWrapper.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    voiceWaveform.width = rect.width * dpr;
    voiceWaveform.height = rect.height * dpr;
    voiceWaveform.style.width = rect.width + "px";
    voiceWaveform.style.height = rect.height + "px";
  }

  function startWaveformLoop(): void {
    const ctx2d = voiceWaveform.getContext("2d");
    if (!ctx2d || !analyserNode) return;

    const draw = (timestamp: number): void => {
      if (micState !== "voice" || !analyserNode) return;

      const t = timestamp / 1000;
      const frame = renderVoiceWaveform(ctx2d, analyserNode, waveformState, waveformColor, t);
      ctx.app.setAudioReactivity(frame.bands);

      // Silence detection — desktop-specific auto-stop. `gatedRms` comes
      // from the shared analysis (noise-floor-subtracted RMS); the onset
      // timer is local to this surface's UX.
      if (frame.gatedRms > 0.03) {
        speechActiveInVoice = true;
        silenceOnsetTime = 0;
      } else if (speechActiveInVoice && frame.gatedRms < SPEECH_RMS_THRESHOLD) {
        if (silenceOnsetTime === 0) {
          silenceOnsetTime = performance.now();
        } else if (performance.now() - silenceOnsetTime > SILENCE_DURATION_MS) {
          speechActiveInVoice = false;
          silenceOnsetTime = 0;
          stopVoice(true, true);
          return;
        }
      }

      waveformAnimationId = requestAnimationFrame(draw);
    };

    waveformAnimationId = requestAnimationFrame(draw);
  }

  return {
    getMicState() {
      return micState;
    },
    toggleVoice,
    stopVoice,
    stopAmbient,
    speakAssistantResponse,
    pushTTSChunk,
    flushTTS,
    cancelStreamingTTS,
    cancelTTS,
    updateVoiceGlowColor,
    rebuildTtsProvider,
    sizeWaveformCanvas,
    getVoiceAutoSend() {
      return voiceAutoSend;
    },
    setVoiceAutoSend(v: boolean) {
      voiceAutoSend = v;
    },
    getVoiceResponseEnabled() {
      return voiceResponseEnabled;
    },
    setVoiceResponseEnabled(v: boolean) {
      voiceResponseEnabled = v;
    },
    getTtsVoice() {
      return ttsVoice;
    },
    setTtsVoice(v: string) {
      ttsVoice = v;
    },
    releaseAudioResources,
  };
}
