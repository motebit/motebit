/**
 * `useVoice` — React hook that owns the voice state machine (5 states),
 * TTS/STT providers, audio monitor with VAD, and the streaming TTS
 * queue for the mobile App.
 *
 * Extracted from `App.tsx` as Target 10 of the mobile extraction plan.
 *
 * ### State machine (5 states)
 *
 *   off → ambient         — mic listening, creature breathes, VAD armed
 *   ambient → voice       — VAD triggered or manual tap, STT recording
 *   voice → transcribing  — recording stopped, Whisper API call
 *   transcribing → ambient — result received, auto-send, return to listening
 *   speaking → ambient    — TTS finished or cancelled
 *   Any → off             — explicit stop
 *
 * ### Owned refs
 *
 *   - `ttsRef`            — active TTS provider (OpenAI or system fallback)
 *   - `sttRef`            — active STT provider (Whisper via expo-av)
 *   - `audioMonitorRef`   — AudioMonitor instance with VAD armed
 *   - `ttsPulseRef`       — pulse interval handle for creature glow
 *   - `ttsQueueRef`       — StreamingTTSQueue for incremental TTS playback
 *   - `vadTriggeredRef`   — flag: ambient→voice was VAD-driven
 *   - `prevMicStateForVADRef` — VAD edge detection for ambient→voice
 *
 * ### Returned API
 *
 *   - `micState`, `audioLevel`   — for VoiceIndicator rendering
 *   - `handleMicPress`           — mic button state machine
 *   - `initVoice`                — re-init providers (on first load + settings save)
 *   - `pushTTSChunk`, `flushTTS`, `cancelStreamingTTS` — streaming TTS control
 *   - `isTTSDraining`            — read by WebView render loop
 *   - `dispose`                  — cleanup for init-effect return
 *
 * ### Deps
 *
 * Voice needs to reach into the app (setAudioReactivity), the settings
 * state (voice.neuralVad, voice.ttsVoice, voice.speakResponses,
 * voice.enabled), the chat surface (addSystemMessage, setInputText),
 * and the banner (for the "Voice input requires an OpenAI API key"
 * warning). All injected via the deps object.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import * as SecureStore from "expo-secure-store";
import type { TTSProvider, STTProvider } from "@motebit/voice";
import { FallbackTTSProvider, StreamingTTSQueue } from "@motebit/voice";
import { ExpoSpeechTTSProvider } from "./adapters/expo-speech-tts";
import { OpenAITTSProvider } from "./adapters/openai-tts";
import { ExpoAVSTTProvider } from "./adapters/expo-av-stt";
import { AudioMonitor } from "./adapters/audio-monitor";
import { SECURE_STORE_KEYS } from "./storage-keys";
import type { MobileApp } from "./mobile-app";

export type MicState = "off" | "ambient" | "voice" | "transcribing" | "speaking";

interface VoiceSettingsSlice {
  neuralVad?: boolean;
  ttsVoice?: string;
  speakResponses?: boolean;
  enabled?: boolean;
}

export interface UseVoiceDeps {
  app: MobileApp;
  voiceSettings: VoiceSettingsSlice | undefined;
  addSystemMessage: (content: string) => void;
  setInputText: (text: string) => void;
  showBanner: (message: string, actionLabel?: string, onAction?: () => void) => void;
  setShowSettings: (show: boolean) => void;
}

export interface UseVoiceResult {
  micState: MicState;
  audioLevel: number;
  setMicState: (state: MicState) => void;
  handleMicPress: () => void;
  initVoice: (voiceSettings?: { ttsVoice?: string }) => Promise<void>;
  pushTTSChunk: (delta: string) => void;
  flushTTS: () => void;
  cancelStreamingTTS: () => void;
  /** Read by the WebView render loop to tell the creature to pulse. */
  isTTSDraining: () => boolean;
  /** Cleanup helper — call from the init-effect return. */
  dispose: () => void;
}

export function useVoice(deps: UseVoiceDeps): UseVoiceResult {
  const { app, voiceSettings, addSystemMessage, setInputText, showBanner, setShowSettings } = deps;

  const [micState, setMicState] = useState<MicState>("off");
  const [audioLevel, setAudioLevel] = useState(0);

  const ttsRef = useRef<TTSProvider | null>(null);
  const sttRef = useRef<STTProvider | null>(null);
  const audioMonitorRef = useRef<AudioMonitor | null>(null);
  const ttsPulseRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ttsQueueRef = useRef<StreamingTTSQueue | null>(null);
  const vadTriggeredRef = useRef(false);

  const initVoice = useCallback(
    async (override?: { ttsVoice?: string }) => {
      const openaiKey = await SecureStore.getItemAsync(SECURE_STORE_KEYS.openaiVoiceKey);
      const voice = override?.ttsVoice ?? voiceSettings?.ttsVoice ?? "alloy";

      // Build TTS chain: OpenAI (if key available) → system TTS fallback
      const systemTts = new ExpoSpeechTTSProvider();
      if (openaiKey != null && openaiKey !== "") {
        const openaiTts = new OpenAITTSProvider({ apiKey: openaiKey, voice });
        ttsRef.current = new FallbackTTSProvider([openaiTts, systemTts]);
      } else {
        ttsRef.current = systemTts;
      }
      // Wire streaming queue to the active TTS provider
      ttsQueueRef.current = new StreamingTTSQueue(
        (text) => ttsRef.current?.speak(text) ?? Promise.resolve(),
      );

      // STT needs an OpenAI API key for Whisper. Always re-create on
      // initVoice so the settings-save path picks up a fresh key.
      if (openaiKey != null && openaiKey !== "") {
        sttRef.current = new ExpoAVSTTProvider({ apiKey: openaiKey });
      } else {
        sttRef.current = null;
      }
    },
    [voiceSettings?.ttsVoice],
  );

  const startAmbientMonitor = useCallback(() => {
    if (audioMonitorRef.current?.isRunning === true) return;
    const monitor = new AudioMonitor();
    monitor.neuralVadEnabled = voiceSettings?.neuralVad ?? true;
    monitor.onAudio = (energy) => {
      app.setAudioReactivity(energy ?? null);
      setAudioLevel(energy?.rms ?? 0);
    };
    monitor.onSpeechStart = () => {
      // VAD triggered — transition ambient → voice
      vadTriggeredRef.current = true;
      setMicState("voice");
    };
    audioMonitorRef.current = monitor;
    void monitor.start();
  }, [voiceSettings?.neuralVad, app]);

  const stopAudioMonitor = useCallback(() => {
    if (audioMonitorRef.current) {
      void audioMonitorRef.current.stop();
      audioMonitorRef.current = null;
    }
    app.setAudioReactivity(null);
    setAudioLevel(0);
  }, [app]);

  const startVoiceRecording = useCallback(() => {
    const stt = sttRef.current;
    if (!stt) {
      showBanner("Voice input requires an OpenAI API key", "Settings", () => setShowSettings(true));
      setMicState("ambient");
      return;
    }

    // Stop ambient monitor before starting STT recording
    stopAudioMonitor();

    stt.onResult = (transcript: string, isFinal: boolean) => {
      if (isFinal && transcript.trim()) {
        setInputText(transcript.trim());
        // Return to ambient after transcription completes
        setMicState("ambient");
      }
    };
    stt.onError = (error: string) => {
      addSystemMessage(`Mic error: ${error}`);
      setMicState("ambient");
    };
    stt.onEnd = () => {
      // Transition handled by onResult or onError
    };

    stt.start({ language: "en-US" });
  }, [addSystemMessage, stopAudioMonitor, setInputText, showBanner, setShowSettings]);

  // Auto-start STT when VAD triggers voice state
  const prevMicStateForVADRef = useRef<MicState>("off");
  useEffect(() => {
    if (
      prevMicStateForVADRef.current === "ambient" &&
      micState === "voice" &&
      vadTriggeredRef.current
    ) {
      vadTriggeredRef.current = false;
      startVoiceRecording();
    }
    prevMicStateForVADRef.current = micState;
  }, [micState, startVoiceRecording]);

  // Auto-restart ambient monitor when returning from transcribing/speaking
  useEffect(() => {
    if (micState === "ambient" && audioMonitorRef.current?.isRunning !== true) {
      startAmbientMonitor();
    }
  }, [micState, startAmbientMonitor]);

  const handleMicPress = useCallback(() => {
    switch (micState) {
      case "off": {
        // off → ambient: start listening with VAD
        setMicState("ambient");
        startAmbientMonitor();
        break;
      }
      case "ambient": {
        // ambient → off: stop listening
        stopAudioMonitor();
        setMicState("off");
        break;
      }
      case "voice": {
        // voice → transcribing: stop recording, send to Whisper
        setMicState("transcribing");
        sttRef.current?.stop();
        break;
      }
      case "speaking": {
        // speaking → ambient: cancel TTS, return to ambient
        ttsRef.current?.cancel();
        if (ttsPulseRef.current) {
          clearInterval(ttsPulseRef.current);
          ttsPulseRef.current = null;
        }
        app.setAudioReactivity(null);
        setMicState("ambient");
        break;
      }
      // transcribing: button disabled, no action
    }
  }, [micState, startAmbientMonitor, stopAudioMonitor, app]);

  const pushTTSChunk = useCallback(
    (delta: string) => {
      if (voiceSettings?.speakResponses !== true || voiceSettings.enabled !== true) return;
      ttsQueueRef.current?.push(delta);
    },
    [voiceSettings?.speakResponses, voiceSettings?.enabled],
  );

  const flushTTS = useCallback(() => {
    ttsQueueRef.current?.flush();
  }, []);

  const cancelStreamingTTS = useCallback(() => {
    ttsQueueRef.current?.cancel();
    ttsRef.current?.cancel();
  }, []);

  const isTTSDraining = useCallback(() => {
    return ttsQueueRef.current?.draining ?? false;
  }, []);

  const dispose = useCallback(() => {
    if (audioMonitorRef.current) void audioMonitorRef.current.stop();
    if (ttsPulseRef.current) clearInterval(ttsPulseRef.current);
    ttsRef.current?.cancel();
    sttRef.current?.stop();
  }, []);

  return {
    micState,
    audioLevel,
    setMicState,
    handleMicPress,
    initVoice,
    pushTTSChunk,
    flushTTS,
    cancelStreamingTTS,
    isTTSDraining,
    dispose,
  };
}
