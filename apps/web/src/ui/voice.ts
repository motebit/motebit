import type { ChatAPI } from "./chat";
import { setStreamingTTSEnabled } from "./chat";
import type { WebContext } from "../types";

// === Web Speech API Types ===

interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

declare const webkitSpeechRecognition: { new (): SpeechRecognition } | undefined;

// === DOM Refs ===

const micBtn = document.getElementById("mic-btn") as HTMLButtonElement | null;
const inputBarWrapper = document.getElementById("input-bar-wrapper") as HTMLDivElement | null;
const voiceTranscript = document.getElementById("voice-transcript") as HTMLSpanElement | null;
const voiceWaveform = document.getElementById("voice-waveform") as HTMLCanvasElement | null;

// === Audio State ===

let audioContext: AudioContext | null = null;
let analyserNode: AnalyserNode | null = null;
let micStream: MediaStream | null = null;
let waveformAnimationId = 0;
let noiseFloor = 0;
const waveformSmoothed = new Float32Array(64);
let waveformColor = { r: 203, g: 225, b: 255 };

// === Voice API ===

export interface VoiceAPI {
  updateVoiceGlowColor(): void;
  /** Re-enter listening after TTS finishes (continuous conversation loop). */
  resumeListening(): void;
  /** End the voice session entirely (mic button toggle off). */
  endSession(): void;
}

export interface VoiceCallbacks {
  onPresenceToggle(active: boolean): void;
}

// === Voice Init ===

export function initVoice(
  ctx: WebContext,
  chatAPI: ChatAPI,
  voiceCallbacks?: VoiceCallbacks,
): VoiceAPI {
  if (!micBtn || !inputBarWrapper) {
    return { updateVoiceGlowColor() {}, resumeListening() {}, endSession() {} };
  }

  // Check for Web Speech API support
  const SpeechRecognitionCtor =
    typeof window !== "undefined" && "SpeechRecognition" in window
      ? (window as unknown as Record<string, { new (): SpeechRecognition }>)["SpeechRecognition"]
      : typeof webkitSpeechRecognition !== "undefined"
        ? webkitSpeechRecognition
        : null;

  if (!SpeechRecognitionCtor) {
    micBtn.style.display = "none";
    return { updateVoiceGlowColor() {}, resumeListening() {}, endSession() {} };
  }

  // Show presence circle — it's both the voice indicator and the voice input trigger
  micBtn.style.display = "flex";
  inputBarWrapper.classList.add("has-mic");

  let recognition: SpeechRecognition | null = null;
  let isListening = false;

  // === Audio Pipeline ===

  async function ensureAudioPipeline(): Promise<boolean> {
    if (audioContext && analyserNode && micStream) return true;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
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

  function releaseAudioPipeline(): void {
    if (audioContext) {
      void audioContext.close();
      audioContext = null;
      analyserNode = null;
    }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
  }

  // === Waveform Color from Soul Color ===

  function updateVoiceGlowColor(): void {
    const color = ctx.app.getInteriorColor();
    if (!color) return;
    const glow = color.glow;

    const r = Math.round(glow[0] * 255);
    const g = Math.round(glow[1] * 255);
    const b = Math.round(glow[2] * 255);
    inputBarWrapper!.style.setProperty("--voice-glow-color", `rgba(${r},${g},${b},0.55)`);

    const maxG = Math.max(glow[0], glow[1], glow[2], 0.01);
    const satPow = 1.3;
    waveformColor = {
      r: Math.min(255, Math.round((glow[0] / maxG) ** (1 / satPow) * glow[0] * 300)),
      g: Math.min(255, Math.round((glow[1] / maxG) ** (1 / satPow) * glow[1] * 300)),
      b: Math.min(255, Math.round((glow[2] / maxG) ** (1 / satPow) * glow[2] * 300)),
    };
  }

  // === Waveform Canvas ===

  function sizeWaveformCanvas(): void {
    if (!voiceWaveform || !inputBarWrapper) return;
    const rect = inputBarWrapper.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    voiceWaveform.width = rect.width * dpr;
    voiceWaveform.height = rect.height * dpr;
    voiceWaveform.style.width = rect.width + "px";
    voiceWaveform.style.height = rect.height + "px";
  }

  function startWaveformLoop(): void {
    if (!voiceWaveform || !analyserNode) return;
    const ctx2d = voiceWaveform.getContext("2d");
    if (!ctx2d) return;

    const timeDomain = new Uint8Array(analyserNode.frequencyBinCount);
    const freqDomain = new Uint8Array(analyserNode.frequencyBinCount);
    let smoothedRms = 0;
    let smoothedLow = 0;
    let smoothedMid = 0;
    let smoothedHigh = 0;
    let smoothedFlatness = 0;

    // Attenuation envelope — fades edges to zero
    const att = (x: number): number => {
      const d = 2 * x - 1;
      const d2 = d * d;
      return 1 - d2 * d2 * d2;
    };

    // 4 overlapping wave layers per desktop
    const waves = [
      { tf: 0.7, sf: 6.5, amp: 0.4, alpha: 0.1, lw: 16, band: 0 },
      { tf: 1.1, sf: 9.3, amp: 0.32, alpha: 0.28, lw: 4.5, band: 1 },
      { tf: 1.5, sf: 13.1, amp: 0.25, alpha: 0.5, lw: 2.5, band: 1 },
      { tf: 2.1, sf: 17.4, amp: 0.15, alpha: 0.88, lw: 1.5, band: 2 },
    ];

    const N = 64;
    const waveY = new Float32Array(N);

    const draw = (timestamp: number): void => {
      if (!isListening || !analyserNode) return;

      const t = timestamp / 1000;
      const w = voiceWaveform.width;
      const h = voiceWaveform.height;
      const dpr = window.devicePixelRatio || 1;

      ctx2d.clearRect(0, 0, w, h);

      analyserNode.getByteTimeDomainData(timeDomain);
      analyserNode.getByteFrequencyData(freqDomain);

      // RMS
      let sumSq = 0;
      for (let j = 0; j < timeDomain.length; j++) {
        const v = timeDomain[j]! / 128.0 - 1.0;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / timeDomain.length);
      smoothedRms += (rms > smoothedRms ? 0.4 : 0.06) * (rms - smoothedRms);

      noiseFloor += (rms > noiseFloor ? 0.003 : 0.05) * (rms - noiseFloor);

      // Frequency bands
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

      smoothedLow += (lowE > smoothedLow ? 0.35 : 0.05) * (lowE - smoothedLow);
      smoothedMid += (midE > smoothedMid ? 0.35 : 0.05) * (midE - smoothedMid);
      smoothedHigh += (highE > smoothedHigh ? 0.3 : 0.04) * (highE - smoothedHigh);
      const bands = [smoothedLow, smoothedMid, smoothedHigh];

      // Spectral flatness
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

      // Drive creature audio reactivity
      ctx.app.setAudioReactivity({
        rms: gatedRms * damping,
        low: smoothedLow * gate * damping,
        mid: smoothedMid * gate * damping,
        high: smoothedHigh * gate * damping * shimmer,
      });

      // Draw waveform
      const pad = 24 * dpr;
      const drawW = w - pad * 2;
      const midY = h / 2;

      const voiceGain = Math.min(smoothedRms * 10, 1.8);
      const amplitude = h * (0.22 + voiceGain * 0.18);
      const sampleDecay = 0.08 + voiceGain * 0.15;

      for (let i = 0; i < N; i++) {
        const bufIdx = Math.floor((i / N) * timeDomain.length);
        const raw = timeDomain[bufIdx]! / 128.0 - 1.0;
        const target = raw * (1 + voiceGain * 5);
        waveformSmoothed[i] = waveformSmoothed[i]! + (target - waveformSmoothed[i]!) * sampleDecay;
      }

      const { r: cr, g: cg, b: cb } = waveformColor;

      ctx2d.lineCap = "round";
      ctx2d.lineJoin = "round";
      const stepX = drawW / (N - 1);

      const spread = voiceGain * 0.7;

      for (const wave of waves) {
        const bandVal = bands[wave.band] ?? 0;
        const bandBoost = 1 + bandVal * 3.5;

        for (let i = 0; i < N; i++) {
          const pos = i / (N - 1);
          const a = att(pos);

          const organic =
            Math.sin(t * wave.tf + pos * wave.sf) * wave.amp +
            Math.sin(t * wave.tf * 1.73 + pos * wave.sf * 1.61) * wave.amp * 0.5;

          const val = (waveformSmoothed[i]! + organic * (0.5 + spread)) * bandBoost * a;
          waveY[i] = midY + val * amplitude;
        }

        ctx2d.beginPath();
        ctx2d.moveTo(pad, waveY[0]!);
        for (let i = 1; i < N - 1; i++) {
          const x = pad + i * stepX;
          const nx = pad + (i + 1) * stepX;
          ctx2d.quadraticCurveTo(x, waveY[i]!, (x + nx) / 2, (waveY[i]! + waveY[i + 1]!) / 2);
        }
        ctx2d.lineTo(pad + drawW, waveY[N - 1]!);

        ctx2d.strokeStyle = `rgba(${cr},${cg},${cb},${wave.alpha})`;
        ctx2d.lineWidth = wave.lw * dpr;
        ctx2d.stroke();
      }

      waveformAnimationId = requestAnimationFrame(draw);
    };

    waveformAnimationId = requestAnimationFrame(draw);
  }

  function stopWaveformLoop(): void {
    if (waveformAnimationId) {
      cancelAnimationFrame(waveformAnimationId);
      waveformAnimationId = 0;
    }
    if (voiceWaveform) {
      const ctx2d = voiceWaveform.getContext("2d");
      if (ctx2d) ctx2d.clearRect(0, 0, voiceWaveform.width, voiceWaveform.height);
    }
  }

  // === Listening ===

  async function startListening(): Promise<void> {
    if (isListening) return;

    const hasAudio = await ensureAudioPipeline();

    recognition = new SpeechRecognitionCtor!();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";

    recognition.onstart = () => {
      isListening = true;
      micBtn!.classList.add("active");
      inputBarWrapper!.classList.add("listening");
      if (voiceTranscript) {
        voiceTranscript.textContent = "";
        voiceTranscript.classList.remove("has-text");
      }
      if (hasAudio) {
        updateVoiceGlowColor();
        sizeWaveformCanvas();
        startWaveformLoop();
      }
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]!;
        if (result.isFinal) {
          final += result[0]!.transcript;
        }
      }

      if (final) {
        pauseListening();
        void chatAPI.handleVoiceSend(final.trim());
      }
    };

    recognition.onerror = () => {
      pauseListening();
      // Re-enter listening if session is still active
      if (inSession) void startListening();
    };

    recognition.onend = () => {
      // recognition.onend fires after onresult or onerror — only restart
      // if we paused (not if a final result was already captured)
      if (isListening) pauseListening();
    };

    recognition.start();
  }

  /** Pause listening between turns — keep audio pipeline and session visuals alive. */
  function pauseListening(): void {
    if (!isListening) return;
    isListening = false;
    // Keep micBtn active and inputBarWrapper in session state — don't remove visual classes.
    // The bar stays glowing throughout the voice session.
    if (voiceTranscript) {
      voiceTranscript.textContent = "";
      voiceTranscript.classList.remove("has-text");
    }
    stopWaveformLoop();

    if (recognition) {
      try {
        recognition.abort();
      } catch {
        /* ignore */
      }
      recognition = null;
    }
    // Audio pipeline stays alive — no pop, ready to resume
  }

  /** End the voice session — release everything. */
  function endSession(): void {
    pauseListening();
    setStreamingTTSEnabled(false); // Stop any in-progress TTS speech
    micBtn!.classList.remove("active");
    inputBarWrapper!.classList.remove("listening");
    ctx.app.setAudioReactivity(null);
    releaseAudioPipeline();
    inSession = false;
  }

  let inSession = false;

  micBtn.addEventListener("click", () => {
    if (inSession) {
      endSession();
      voiceCallbacks?.onPresenceToggle(false);
    } else {
      inSession = true;
      void startListening();
      voiceCallbacks?.onPresenceToggle(true);
    }
  });

  return {
    updateVoiceGlowColor,
    resumeListening() {
      if (inSession) void startListening();
    },
    endSession,
  };
}
