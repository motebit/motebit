import type { ChatAPI } from "./chat";
import { setStreamingTTSEnabled } from "./chat";
import type { WebContext } from "../types";
import type { STTProvider } from "@motebit/voice";
import { WebSpeechSTTProvider, DeepgramSTTProvider } from "@motebit/voice";
import { getSTTKey } from "../storage";

// === STT Provider Selection ===
//
// The presence session delegates speech recognition to an STTProvider. The
// choice is made once at module load from persisted BYOK keys:
//
//   - If `motebit-stt-key-deepgram` is set → DeepgramSTTProvider (websocket
//     streaming, cross-browser, multi-language, robust to silence).
//   - Otherwise → WebSpeechSTTProvider (browser built-in; default).
//
// Swapping providers requires a page reload. A mid-session hot-swap would
// need to tear down audio graphs and reconnect sockets while the keeper
// held open, which adds complexity that this pass does not warrant —
// settings UI (owned by another agent) can nudge users to reload.

function createSTTProvider(): STTProvider {
  const deepgramKey = (() => {
    try {
      return getSTTKey("deepgram");
    } catch {
      return null;
    }
  })();
  if (deepgramKey != null && deepgramKey !== "") {
    return new DeepgramSTTProvider({ apiKey: deepgramKey });
  }
  // WebSpeech is the default. If the browser has no SpeechRecognition, the
  // provider surfaces onError("SpeechRecognition API not available") when
  // start() is called — startSession catches that and ends the session.
  return new WebSpeechSTTProvider();
}

// === DOM Refs ===

const micBtn = document.getElementById("mic-btn") as HTMLButtonElement | null;
const inputBarWrapper = document.getElementById("input-bar-wrapper") as HTMLDivElement | null;
const voiceTranscript = document.getElementById("voice-transcript") as HTMLSpanElement | null;
const voiceWaveform = document.getElementById("voice-waveform") as HTMLCanvasElement | null;

// === Audio State ===
// Owned by the session: acquired on startSession, released on endSession.

let audioContext: AudioContext | null = null;
let analyserNode: AnalyserNode | null = null;
let micStream: MediaStream | null = null;
let waveformAnimationId = 0;
let noiseFloor = 0;
const waveformSmoothed = new Float32Array(64);
let waveformColor = { r: 203, g: 225, b: 255 };

// === Session State ===
// Presence mode is tenacious: click-on holds it open, click-off releases it.
// Nothing between can tear the session down.
//
//   inSession        — user clicked on, has not clicked off yet. Source of truth.
//   suspended        — TTS owns the audio floor. Recognition is paused and
//                      audio reactivity yields to the speech-energy driver.
//   ttsHasTakenFloor — setTtsSpeaking(true) has fired since the last final
//                      transcript. Used by the safety timer to distinguish
//                      "TTS never played" from "TTS already played and ended".
//   stt              — the current STTProvider child. Bounded by start()/stop()
//                      calls; the provider's own onEnd drives keeper respawn
//                      while inSession && !suspended.

let inSession = false;
let suspended = false;
let ttsHasTakenFloor = false;
let stt: STTProvider | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;

// === Voice API ===

export interface VoiceAPI {
  updateVoiceGlowColor(): void;
  /** Bridge from main.ts syncTTS — notifies when TTS starts/stops playing. */
  setTtsSpeaking(speaking: boolean): void;
  /** End the voice session entirely. Idempotent. */
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
    return { updateVoiceGlowColor() {}, setTtsSpeaking() {}, endSession() {} };
  }

  // Gate the mic button on whether *any* STT path exists. For the default
  // WebSpeech provider that means the browser ships SpeechRecognition; for
  // Deepgram that means a persisted API key. If neither condition holds,
  // the button stays hidden.
  const hasWebSpeech =
    (typeof window !== "undefined" && "SpeechRecognition" in window) ||
    (typeof window !== "undefined" && "webkitSpeechRecognition" in window);
  const hasDeepgramKey = (() => {
    try {
      const key = getSTTKey("deepgram");
      return key != null && key !== "";
    } catch {
      return false;
    }
  })();
  if (!hasWebSpeech && !hasDeepgramKey) {
    micBtn.style.display = "none";
    return { updateVoiceGlowColor() {}, setTtsSpeaking() {}, endSession() {} };
  }

  micBtn.style.display = "flex";
  inputBarWrapper.classList.add("has-mic");

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
      // The loop lives for the entire session — not per recognition cycle.
      if (!inSession || !analyserNode) return;

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

      // Drive creature reactivity from mic only while we own the floor. During
      // TTS (suspended), main.ts's syncTTS drives reactivity from synthesized
      // speech energy — don't fight it.
      if (!suspended) {
        ctx.app.setAudioReactivity({
          rms: gatedRms * damping,
          low: smoothedLow * gate * damping,
          mid: smoothedMid * gate * damping,
          high: smoothedHigh * gate * damping * shimmer,
        });
      }

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

  // === Recognition Keeper ===
  // STT providers (WebSpeech, Deepgram) are short-lived by design — WebSpeech
  // stops itself on silence/onend, and even Deepgram's socket can drop on
  // transport flakes. The session owns a keeper that respawns the provider on
  // every onEnd until the user explicitly ends the session (or TTS takes the
  // floor). All provider-specific behavior is hidden behind STTProvider.

  function spawnRecognition(): void {
    if (!inSession || suspended || stt) return;

    const provider = createSTTProvider();

    // interimResults=true keeps WebSpeech's onresult flowing and unlocks
    // Deepgram's partial-hypothesis frames. continuous=false matches the
    // burst-per-utterance pattern: we stop after the first final result
    // and respawn via onEnd.
    const options = {
      language: navigator.language || "en-US",
      continuous: false,
      interimResults: true,
    };

    provider.onResult = (transcript: string, isFinal: boolean) => {
      if (!isFinal) return;
      const final = transcript.trim();
      if (!final) return;

      // Final captured — suspend auto-restart and hand off to chat. TTS will
      // take the floor via setTtsSpeaking(true) and release it when the
      // utterance ends, at which point the keeper respawns. The safety timer
      // covers the degenerate case where TTS never plays at all (empty
      // response, provider error, TTS disabled mid-flight).
      suspended = true;
      ttsHasTakenFloor = false;

      void chatAPI.handleVoiceSend(final).finally(() => {
        setTimeout(() => {
          if (inSession && suspended && !ttsHasTakenFloor) {
            suspended = false;
            spawnRecognition();
          }
        }, 1500);
      });
    };

    provider.onError = (code: string) => {
      // Permission-class errors kill the session; transient errors fall
      // through to onEnd and get restarted like any other cycle. The
      // vocabulary ("not-allowed" / "service-not-allowed") is shared by
      // WebSpeech and Deepgram so the keeper stays adapter-agnostic.
      if (code === "not-allowed" || code === "service-not-allowed") {
        endSession();
        voiceCallbacks?.onPresenceToggle(false);
      }
    };

    provider.onEnd = () => {
      stt = null;
      if (inSession && !suspended) scheduleRecognitionRestart();
    };

    try {
      provider.start(options);
      stt = provider;
    } catch {
      // Provider refused to start (e.g. socket open threw synchronously).
      // Back off and retry.
      scheduleRecognitionRestart(300);
    }
  }

  function scheduleRecognitionRestart(delayMs = 150): void {
    if (restartTimer != null) return;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      spawnRecognition();
    }, delayMs);
  }

  function killRecognition(): void {
    if (restartTimer != null) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (stt) {
      try {
        stt.stop();
      } catch {
        /* ignore */
      }
      // Clear callbacks so any in-flight onEnd doesn't respawn under us.
      stt.onResult = null;
      stt.onError = null;
      stt.onEnd = null;
      stt = null;
    }
  }

  // === Session Lifecycle ===

  const onResize = (): void => {
    if (inSession) sizeWaveformCanvas();
  };

  async function startSession(): Promise<void> {
    if (inSession) return;
    inSession = true;

    const ok = await ensureAudioPipeline();
    // The user may have clicked off (or permission denied) during the await.
    if (!inSession) {
      releaseAudioPipeline();
      return;
    }
    if (!ok) {
      inSession = false;
      voiceCallbacks?.onPresenceToggle(false);
      return;
    }

    micBtn!.classList.add("active");
    inputBarWrapper!.classList.add("listening");
    updateVoiceGlowColor();
    sizeWaveformCanvas();
    startWaveformLoop();
    window.addEventListener("resize", onResize);
    spawnRecognition();
  }

  function endSession(): void {
    if (!inSession) return;
    inSession = false;
    suspended = false;
    ttsHasTakenFloor = false;
    killRecognition();
    stopWaveformLoop();
    window.removeEventListener("resize", onResize);
    micBtn!.classList.remove("active");
    inputBarWrapper!.classList.remove("listening");
    if (voiceTranscript) {
      voiceTranscript.textContent = "";
      voiceTranscript.classList.remove("has-text");
    }
    setStreamingTTSEnabled(false);
    ctx.app.setAudioReactivity(null);
    releaseAudioPipeline();
  }

  function setTtsSpeaking(speaking: boolean): void {
    if (speaking) {
      suspended = true;
      ttsHasTakenFloor = true;
      killRecognition();
    } else {
      suspended = false;
      ttsHasTakenFloor = false;
      if (inSession) spawnRecognition();
    }
  }

  // === Button Wiring ===

  micBtn.addEventListener("click", () => {
    if (inSession) {
      endSession();
      voiceCallbacks?.onPresenceToggle(false);
    } else {
      voiceCallbacks?.onPresenceToggle(true);
      void startSession();
    }
  });

  return {
    updateVoiceGlowColor,
    setTtsSpeaking,
    endSession,
  };
}
