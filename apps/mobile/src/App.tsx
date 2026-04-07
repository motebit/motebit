/**
 * @motebit/mobile — React Native app
 *
 * Thin platform shell around MobileApp (which wraps MotebitRuntime).
 * This file is React Native views + modals wired to MobileApp methods.
 *
 * Initialization flow:
 * 1. loadSettings → load saved settings from AsyncStorage
 * 2. bootstrap → create/load cryptographic identity (silent)
 * 3. initAI → connect AI provider
 * 4. Apply saved governance settings
 * 5. start → begin state tick loop
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Modal,
  Appearance,
} from "react-native";
import { WebView } from "react-native-webview";
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-member-access
const Feather = require("@expo/vector-icons/Feather").default as React.ComponentType<{
  name: string;
  size: number;
  color: string;
}>;

import * as SecureStore from "expo-secure-store";
import type { MotebitState, BehaviorCues } from "@motebit/sdk";
import type { StreamChunk } from "@motebit/runtime";
import { stripTags, stripPartialActionTag } from "@motebit/ai-core";
import type { TTSProvider, STTProvider } from "@motebit/voice";
import { FallbackTTSProvider, StreamingTTSQueue, computeSpeechEnergy } from "@motebit/voice";
import { ExpoSpeechTTSProvider } from "./adapters/expo-speech-tts";
import { OpenAITTSProvider } from "./adapters/openai-tts";
import { ExpoAVSTTProvider } from "./adapters/expo-av-stt";
import { AudioMonitor } from "./adapters/audio-monitor";
import { MobileApp, APPROVAL_PRESET_CONFIGS, COLOR_PRESETS, setBackgroundApp } from "./mobile-app";
import { SECURE_STORE_KEYS } from "./storage-keys";
import type {
  MobileSettings,
  MobileAIConfig,
  GoalCompleteEvent,
  GoalApprovalEvent,
} from "./mobile-app";
import { ApprovalCard } from "./components/ApprovalCard";
import { PinDialog } from "./components/PinDialog";
import type { PinMode } from "./components/PinDialog";
import { SettingsModal, deriveInteriorColor } from "./components/SettingsModal";
import { MemoryPanel } from "./components/MemoryPanel";
import { SovereignPanel } from "./components/SovereignPanel";
import { AgentsPanel } from "./components/AgentsPanel";
import { ConversationPanel } from "./components/ConversationPanel";
import { VoiceIndicator } from "./components/VoiceIndicator";
import { GoalsPanel } from "./components/GoalsPanel";
import { Toast } from "./components/Toast";
import { AnimatedBubble } from "./components/AnimatedBubble";
import { SlashAutocomplete } from "./components/SlashAutocomplete";
import { Banner } from "./components/Banner";
import { ThemeContext, resolveTheme, type ThemeColors } from "./theme";
import { runSlashCommand } from "./slash-commands";

// === Types ===

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "approval";
  content: string;
  timestamp: number;
  // Approval-specific fields
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  riskLevel?: number;
  approvalResolved?: boolean;
}

// === App singleton ===

let appInstance: MobileApp | null = null;
function getApp(): MobileApp {
  if (!appInstance) {
    appInstance = new MobileApp();
    setBackgroundApp(appInstance);
  }
  return appInstance;
}

// === Main App Component ===

export default function App(): React.ReactElement {
  const app = useRef<MobileApp>(getApp());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [state, setState] = useState<MotebitState | null>(null);
  const [, setCues] = useState<BehaviorCues | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [glStage, setGlStage] = useState("webview");
  const [settings, setSettings] = useState<MobileSettings | null>(null);
  const animFrameRef = useRef<number>(0);
  const renderLoopTokenRef = useRef(0);
  const webViewRef = useRef<WebView>(null);
  const flatListRef = useRef<FlatList>(null);

  // Modal state
  const [showSettings, setShowSettings] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const [pinMode, setPinMode] = useState<PinMode>("setup");
  const [pinError, setPinError] = useState("");

  // Memory, conversation & goals panel state
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [showConversationPanel, setShowConversationPanel] = useState(false);
  const [showGoalsPanel, setShowGoalsPanel] = useState(false);
  const [showCredentialsPanel, setShowCredentialsPanel] = useState(false);
  const [showAgentsPanel, setShowAgentsPanel] = useState(false);

  // Pairing state
  const [showPairing, setShowPairing] = useState(false);
  const [pairingMode, setPairingMode] = useState<"initiate" | "claim">("claim");
  const [pairingCode, setPairingCode] = useState("");
  const [pairingCodeInput, setPairingCodeInput] = useState("");
  const [pairingStatus, setPairingStatusText] = useState("");
  const [pairingId, setPairingId] = useState<string | null>(null);
  const [pairingClaimName, setPairingClaimName] = useState("");
  const [pairingSyncUrlInput, setPairingSyncUrlInput] = useState("");
  const pairingPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Toast state
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
  }, []);
  const dismissToast = useCallback(() => {
    setToastMessage(null);
  }, []);

  // Banner state (persistent errors with optional action)
  const [banner, setBanner] = useState<{
    message: string;
    actionLabel?: string;
    onAction?: () => void;
  } | null>(null);
  const showBanner = useCallback((message: string, actionLabel?: string, onAction?: () => void) => {
    setBanner({ message, actionLabel, onAction });
  }, []);
  const dismissBanner = useCallback(() => {
    setBanner(null);
  }, []);

  // Voice state — 5-state machine:
  //   off → ambient (mic listening, creature breathes, VAD armed)
  //   ambient → voice (VAD triggered or manual tap, STT recording)
  //   voice → transcribing (recording stopped, Whisper API call)
  //   transcribing → ambient (result received, auto-send, return to listening)
  //   speaking → ambient (TTS finished or cancelled)
  //   Any → off (explicit stop)
  const [micState, setMicState] = useState<
    "off" | "ambient" | "voice" | "transcribing" | "speaking"
  >("off");
  const ttsRef = useRef<TTSProvider | null>(null);
  const sttRef = useRef<STTProvider | null>(null);
  const audioMonitorRef = useRef<AudioMonitor | null>(null);
  const ttsPulseRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Streaming TTS queue (shared state machine from @motebit/voice)
  const ttsQueueRef = useRef<StreamingTTSQueue | null>(null);
  // Track whether voice was auto-triggered by VAD (vs manual tap from ambient)
  const vadTriggeredRef = useRef(false);
  // Audio level for VoiceIndicator visualization
  const [audioLevel, setAudioLevel] = useState(0);

  // Sync state
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "error" | "offline">("offline");
  const [_lastSyncTime, setLastSyncTime] = useState(0);
  const pairingSyncUrlRef = useRef("");

  // MCP state
  const [mcpServers, setMcpServers] = useState<
    Array<{
      name: string;
      url: string;
      connected: boolean;
      toolCount: number;
      trusted: boolean;
      motebit: boolean;
      motebitPublicKey?: string;
    }>
  >([]);

  // Model indicator
  const [currentModel, setCurrentModel] = useState<string | null>(null);

  // Goal scheduler state
  const [goalRunning, setGoalRunning] = useState(false);

  // Derive theme colors from settings
  const themeColors = useMemo<ThemeColors>(
    () => resolveTheme(settings?.appearance.theme ?? "dark"),
    [settings?.appearance.theme],
  );

  // Listen for system appearance changes to re-resolve "system" theme
  useEffect(() => {
    if (settings?.appearance.theme !== "system") return undefined;
    const sub = Appearance.addChangeListener(() => {
      // Force re-render by updating settings reference
      setSettings((prev) => (prev ? { ...prev } : prev));
    });
    return () => sub.remove();
  }, [settings?.appearance.theme]);

  // Derive voice glow color from creature preset
  const activeGlow = useMemo((): [number, number, number] | undefined => {
    const preset = COLOR_PRESETS[settings?.appearance.colorPreset ?? "moonlight"];
    return preset?.glow;
  }, [settings?.appearance.colorPreset]);

  // Dynamic mic button background from glow color
  const micButtonActiveStyle = useMemo(() => {
    if (!activeGlow) return undefined;
    const r = Math.round(activeGlow[0] * 60);
    const g = Math.round(activeGlow[1] * 60);
    const b = Math.round(activeGlow[2] * 60);
    return { backgroundColor: `rgb(${r},${g},${b})` };
  }, [activeGlow]);

  // Track pending approval for streaming resume
  const pendingApprovalRef = useRef<string | null>(null);
  // Track whether a pending approval is from a goal (vs. chat)
  const pendingGoalApprovalRef = useRef<boolean>(false);

  const stopRenderLoop = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = 0;
    }
    renderLoopTokenRef.current += 1;
  }, []);

  // === Initialization ===
  useEffect(() => {
    void (async () => {
      try {
        const a = app.current;

        // 1. Load settings
        const loaded = await a.loadSettings();
        setSettings(loaded);

        // 2. Bootstrap identity (silent — creature is already present)
        await a.bootstrap();

        // 3. Init AI with saved settings
        await initializeAI(a, loaded);
        setCurrentModel(a.currentModel);

        // 5. Init voice providers
        await initVoice();

        // 6. Start runtime
        a.start();
        subscribeToState(a);

        // 7. Start goal scheduler
        startGoals(a);

        // 8. Wire MCP tool change callback and load initial state
        a.onToolsChanged(refreshMcpServers);
        refreshMcpServers();

        // 9. Auto-start sync if relay URL persisted
        const syncUrl = await a.getSyncUrl();
        if (syncUrl != null && syncUrl !== "") {
          a.onSyncStatus((status, lastSync) => {
            setSyncStatus(status);
            setLastSyncTime(lastSync);
          });
          void a.startSync(syncUrl);
        }

        // 10. Restore persisted conversation history into chat UI
        restoreConversation(a);

        setInitialized(true);
      } catch (err) {
        // Init-failure diagnostics: surface the error to Metro / device logs so
        // the user can report it. The no-console rule is suppressed deliberately
        // here because (a) this is a one-shot init failure path, not hot code,
        // and (b) there's no logger adapter wired up before init completes.
        // eslint-disable-next-line no-console -- init-failure diagnostics
        console.error("[motebit] Init failed:", err instanceof Error ? err.message : String(err));
        // eslint-disable-next-line no-console -- init-failure diagnostics
        console.error("[motebit] Stack:", err instanceof Error ? err.stack : "");
        // Still mark initialized so the user sees the UI and can report the error
        setInitialized(true);
      }
    })();

    return () => {
      stopRenderLoop();
      app.current.stopGoalScheduler();
      app.current.stopSync();
      app.current.stop();
      app.current.disposeProxySession();
      if (audioMonitorRef.current) void audioMonitorRef.current.stop();
      if (ttsPulseRef.current) clearInterval(ttsPulseRef.current);
      ttsRef.current?.cancel();
      sttRef.current?.stop();
    };
  }, [stopRenderLoop]);

  // Initialize voice providers — TTS chain: OpenAI TTS → expo-speech fallback
  const initVoice = useCallback(
    async (voiceSettings?: { ttsVoice?: string }) => {
      const openaiKey = await SecureStore.getItemAsync(SECURE_STORE_KEYS.openaiVoiceKey);
      const voice = voiceSettings?.ttsVoice ?? settings?.voice.ttsVoice ?? "alloy";

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

      if (!sttRef.current) {
        // STT needs an OpenAI API key for Whisper
        if (openaiKey != null && openaiKey !== "") {
          sttRef.current = new ExpoAVSTTProvider({ apiKey: openaiKey });
        }
      }
    },
    [settings?.voice.ttsVoice],
  );

  const applyThemeEnvironment = useCallback((a: MobileApp, theme: "light" | "dark" | "system") => {
    const effective = theme === "system" ? (Appearance.getColorScheme() ?? "dark") : theme;
    if (effective === "dark") {
      a.setDarkEnvironment();
    } else {
      a.setLightEnvironment();
    }
  }, []);

  const initializeAI = useCallback(
    async (a: MobileApp, s: MobileSettings) => {
      // Capture operator mode before re-init (initAI creates a new runtime/PolicyGate
      // that resets to default operatorMode: false)
      const wasOperatorMode = a.isOperatorMode;

      // Pull the per-vendor API key from secure storage based on the active provider.
      let apiKey: string | undefined;
      if (s.provider === "anthropic") {
        apiKey = (await SecureStore.getItemAsync(SECURE_STORE_KEYS.anthropicApiKey)) ?? undefined;
      } else if (s.provider === "openai") {
        apiKey = (await SecureStore.getItemAsync(SECURE_STORE_KEYS.openaiChatKey)) ?? undefined;
      } else if (s.provider === "google") {
        apiKey = (await SecureStore.getItemAsync(SECURE_STORE_KEYS.googleApiKey)) ?? undefined;
      }

      await a.initAI({
        provider: s.provider,
        localBackend: s.localBackend,
        model: s.model,
        apiKey,
        localServerEndpoint:
          s.provider === "local-server" ||
          (s.provider === "on-device" && s.localBackend === "local-server")
            ? s.localServerEndpoint
            : undefined,
      });

      // Apply governance (restore operator mode captured before re-init)
      const preset = APPROVAL_PRESET_CONFIGS[s.approvalPreset];
      if (preset) {
        a.updatePolicyConfig({
          requireApprovalAbove: preset.requireApprovalAbove,
          denyAbove: preset.denyAbove,
          operatorMode: wasOperatorMode,
          budget: { maxCallsPerTurn: s.maxCallsPerTurn },
        });
      }
      a.updateMemoryGovernance({
        persistenceThreshold: s.persistenceThreshold,
        rejectSecrets: s.rejectSecrets,
        maxMemoriesPerTurn: s.maxMemoriesPerTurn,
      });

      // Apply color preset and theme environment
      if (s.appearance.colorPreset === "custom") {
        a.setInteriorColorDirect(
          deriveInteriorColor(s.appearance.customHue ?? 220, s.appearance.customSaturation ?? 0.7),
        );
      } else {
        a.setInteriorColor(s.appearance.colorPreset);
      }
      applyThemeEnvironment(a, s.appearance.theme ?? "dark");
    },
    [applyThemeEnvironment],
  );

  const subscribeToState = useCallback((a: MobileApp) => {
    a.subscribe((s) => {
      setState(s);
      setCues(a.getCues());
    });
  }, []);

  /** Wire goal scheduler callbacks and start scheduling. */
  const startGoals = useCallback((a: MobileApp) => {
    a.onGoalStatus((executing) => {
      setGoalRunning(executing);
    });

    a.onGoalComplete((event: GoalCompleteEvent) => {
      const content =
        event.status === "completed" && event.summary != null && event.summary !== ""
          ? `Goal completed: ${event.summary}`
          : event.status === "failed" && event.error != null && event.error !== ""
            ? `Goal failed: ${event.error}`
            : null;
      if (content != null) {
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "system" as const, content, timestamp: Date.now() },
        ]);
      }
    });

    a.onGoalApproval((event: GoalApprovalEvent) => {
      const approvalId = crypto.randomUUID();
      pendingApprovalRef.current = approvalId;
      pendingGoalApprovalRef.current = true;
      setMessages((prev) => [
        ...prev,
        {
          id: approvalId,
          role: "approval" as const,
          content: `Goal: ${event.goalPrompt}`,
          timestamp: Date.now(),
          toolName: event.toolName,
          toolArgs: event.args,
          approvalResolved: false,
        },
      ]);
    });

    a.startGoalScheduler();
  }, []);

  /** Restore persisted conversation history into chat messages for display. */
  const restoreConversation = useCallback((a: MobileApp) => {
    const history = a.getConversationHistory();
    if (history.length === 0) return;

    const restored: ChatMessage[] = history.map((msg) => ({
      id: crypto.randomUUID(),
      role: msg.role as "user" | "assistant",
      content: msg.content,
      timestamp: Date.now(),
    }));
    setMessages(restored);
  }, []);

  // === Conversation handlers ===
  const handleLoadConversation = useCallback((id: string) => {
    const a = app.current;
    const history = a.loadConversationById(id);
    const restored: ChatMessage[] = history.map((msg) => ({
      id: crypto.randomUUID(),
      role: msg.role as "user" | "assistant",
      content: msg.content,
      timestamp: Date.now(),
    }));
    setMessages(restored);
    setShowConversationPanel(false);
  }, []);

  const handleNewConversation = useCallback(() => {
    app.current.startNewConversation();
    setMessages([]);
    setShowConversationPanel(false);
  }, []);

  // === System message helper (used by voice + goals) ===
  const addSystemMessage = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "system", content, timestamp: Date.now() },
    ]);
  }, []);

  // === MCP handlers ===
  const refreshMcpServers = useCallback(() => {
    setMcpServers(app.current.getMcpServers());
  }, []);

  const handleAddMcpServer = useCallback(
    async (url: string, name: string, trusted?: boolean, motebit?: boolean) => {
      try {
        await app.current.addMcpServer({
          name,
          transport: "http",
          url,
          trusted: trusted ?? false,
          motebit: motebit ?? false,
        });
        refreshMcpServers();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        addSystemMessage(`MCP error: ${msg}`);
      }
    },
    [refreshMcpServers, addSystemMessage],
  );

  const handleRemoveMcpServer = useCallback(
    async (name: string) => {
      try {
        await app.current.removeMcpServer(name);
        refreshMcpServers();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        addSystemMessage(`MCP error: ${msg}`);
      }
    },
    [refreshMcpServers, addSystemMessage],
  );

  const handleToggleMcpTrust = useCallback(
    async (name: string, trusted: boolean) => {
      try {
        await app.current.setMcpServerTrust(name, trusted);
        refreshMcpServers();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        addSystemMessage(`MCP error: ${msg}`);
      }
    },
    [refreshMcpServers, addSystemMessage],
  );

  // === WebView creature renderer ===
  const onWebViewMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      const data = event.nativeEvent.data;
      const renderer = app.current.getRenderer();
      renderer.onWebViewMessage(data);

      if (data === "ready") {
        setGlStage("rendering");
        // Start render loop — drives behavior engine, sends cues to WebView
        stopRenderLoop();
        const renderToken = renderLoopTokenRef.current;
        const a = app.current;
        void a.init(null); // No-op for WebView adapter

        let lastTime = 0;
        const animate = (time: number): void => {
          if (renderToken !== renderLoopTokenRef.current) return;
          const dt = lastTime ? (time - lastTime) / 1000 : 0.016;
          lastTime = time;

          const runtime = a.getRuntime();
          const isSpeaking = ttsQueueRef.current?.draining ?? false;
          if (runtime) {
            runtime.behavior.setSpeaking(isSpeaking);
          }
          if (isSpeaking) {
            const bands = computeSpeechEnergy(time / 1000);
            a.setAudioReactivity(bands);
          }

          try {
            a.renderFrame(dt, time / 1000);
          } catch {
            // Render errors handled inside adapter
          }
          animFrameRef.current = requestAnimationFrame(animate);
        };
        animFrameRef.current = requestAnimationFrame(animate);
      }
    },
    [stopRenderLoop],
  );

  // Wire WebView ref to adapter when it mounts
  const handleWebViewRef = useCallback((ref: WebView | null) => {
    (webViewRef as React.MutableRefObject<WebView | null>).current = ref;
    app.current.getRenderer().setWebViewRef(ref);
  }, []);

  // === Audio monitor helpers ===

  /** Start ambient listening — AudioMonitor with VAD that auto-triggers voice recording. */
  const startAmbientMonitor = useCallback(() => {
    if (audioMonitorRef.current?.isRunning === true) return;
    const monitor = new AudioMonitor();
    monitor.neuralVadEnabled = settings?.voice.neuralVad ?? true;
    monitor.onAudio = (energy) => {
      app.current.setAudioReactivity(energy ?? null);
      setAudioLevel(energy?.rms ?? 0);
    };
    monitor.onSpeechStart = () => {
      // VAD triggered — transition ambient → voice
      vadTriggeredRef.current = true;
      setMicState("voice");
    };
    audioMonitorRef.current = monitor;
    void monitor.start();
  }, [settings?.voice.neuralVad]);

  const stopAudioMonitor = useCallback(() => {
    if (audioMonitorRef.current) {
      void audioMonitorRef.current.stop();
      audioMonitorRef.current = null;
    }
    app.current.setAudioReactivity(null);
    setAudioLevel(0);
  }, []);

  /** Start STT recording (stops AudioMonitor first — expo-av single-recording constraint on iOS). */
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
  }, [addSystemMessage, stopAudioMonitor]);

  // Auto-start STT when VAD triggers voice state
  const prevMicStateForVADRef = useRef(micState);
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

  // === Mic button handler — 5-state machine ===
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
        app.current.setAudioReactivity(null);
        setMicState("ambient");
        break;
      }
      // transcribing: button disabled, no action
    }
  }, [micState, startAmbientMonitor, stopAudioMonitor]);

  // === Slash commands ===
  // Implementation lives in ./slash-commands.ts. This wrapper binds the
  // deps closure (state setters + app ref) so the slash-commands module
  // stays pure functional and independent of React.
  const handleSlashCommand = useCallback(
    (command: string, args: string) => {
      runSlashCommand(command, args, {
        app: app.current,
        addSystemMessage,
        showToast,
        setMessages,
        setCurrentModel,
        setShowConversationPanel,
        setShowMemoryPanel,
        setShowGoalsPanel,
        setShowSettings,
      });
    },
    [addSystemMessage, showToast],
  );

  // === Send message ===
  // --- Streaming TTS helpers ---
  const pushTTSChunk = useCallback(
    (delta: string) => {
      if (!settings?.voice.speakResponses || !settings?.voice.enabled || !ttsQueueRef.current)
        return;
      ttsQueueRef.current.push(delta);
    },
    [settings?.voice.speakResponses, settings?.voice.enabled],
  );

  const flushTTS = useCallback(() => {
    ttsQueueRef.current?.flush();
  }, []);

  const cancelStreamingTTS = useCallback(() => {
    ttsQueueRef.current?.cancel();
    ttsRef.current?.cancel();
  }, []);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || isProcessing) return;
    cancelStreamingTTS();

    // Slash command detection
    if (text.startsWith("/")) {
      setInputText("");
      const spaceIdx = text.indexOf(" ");
      const command = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
      const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();
      handleSlashCommand(command, args);
      return;
    }

    const a = app.current;
    setInputText("");
    setIsProcessing(true);

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      await consumeStream(a.sendMessageStreaming(text));
      // Auto-title after streaming completes
      a.autoTitle();
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      addSystemMessage(`[Error: ${errMsg}]`);
    } finally {
      setIsProcessing(false);
    }
  }, [inputText, isProcessing, handleSlashCommand]);

  // Auto-send when inputText is filled by voice transcription (if voiceAutoSend enabled)
  const prevMicStateRef = useRef(micState);
  useEffect(() => {
    // Detect transition from transcribing→ambient with text in the input (voice result arrived)
    if (prevMicStateRef.current === "transcribing" && micState === "ambient" && inputText.trim()) {
      if (settings?.voice.autoSend !== false) {
        void handleSend();
      }
      // If auto-send disabled, text stays in input for user review
    }
    prevMicStateRef.current = micState;
  }, [micState, inputText, handleSend, settings?.voice.autoSend]);

  // === Stream consumer ===
  const consumeStream = useCallback(
    async (stream: AsyncGenerator<StreamChunk>) => {
      let assistantContent = "";
      const assistantId = crypto.randomUUID();

      // Add placeholder
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: "...", timestamp: Date.now() },
      ]);

      for await (const chunk of stream) {
        switch (chunk.type) {
          case "text":
            assistantContent += chunk.text;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: stripPartialActionTag(assistantContent) }
                  : m,
              ),
            );
            pushTTSChunk(chunk.text);
            break;

          case "tool_status":
            if (chunk.status === "calling") {
              addSystemMessage(`Calling ${chunk.name}...`);
            }
            break;

          case "approval_request": {
            const approvalId = crypto.randomUUID();
            pendingApprovalRef.current = approvalId;
            setMessages((prev) => [
              ...prev,
              {
                id: approvalId,
                role: "approval",
                content: "",
                timestamp: Date.now(),
                toolName: chunk.name,
                toolArgs: chunk.args,
                riskLevel: chunk.risk_level,
                approvalResolved: false,
              },
            ]);
            // Stream pauses here — will resume via handleApproval
            return;
          }

          case "delegation_start":
            addSystemMessage(`Delegating to ${chunk.server}...`);
            break;

          case "delegation_complete": {
            const status =
              chunk.receipt != null && chunk.receipt.status === "failed" ? "\u2717" : "\u2713";
            const toolInfo =
              chunk.receipt != null
                ? ` (${chunk.receipt.tools_used.length} tool${chunk.receipt.tools_used.length !== 1 ? "s" : ""})`
                : "";
            addSystemMessage(`Delegated to ${chunk.server} ${status}${toolInfo}`);
            break;
          }

          case "injection_warning":
            addSystemMessage(`Warning: injection patterns detected in ${chunk.tool_name}`);
            break;

          case "result":
            // Final update
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: stripTags(assistantContent) || "...", timestamp: Date.now() }
                  : m,
              ),
            );
            break;
        }
      }

      // Ensure final content is set and speak via TTS if voice enabled
      if (assistantContent) {
        const finalText = stripTags(assistantContent);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: finalText, timestamp: Date.now() } : m,
          ),
        );

        // TTS — flush remaining streamed speech
        flushTTS();
      }
    },
    [settings?.voice.enabled, micState, pushTTSChunk, flushTTS],
  );

  // === Approval handler ===
  const handleApproval = useCallback(
    async (messageId: string, approved: boolean) => {
      // Mark card as resolved
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, approvalResolved: true } : m)),
      );

      const a = app.current;
      const isGoalApproval = pendingGoalApprovalRef.current;

      if (isGoalApproval) {
        // Goal approval: stream the continuation via resumeGoalAfterApproval
        pendingGoalApprovalRef.current = false;
        try {
          await consumeStream(a.resumeGoalAfterApproval(approved));
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          addSystemMessage(`[Goal error: ${errMsg}]`);
        } finally {
          pendingApprovalRef.current = null;
        }
      } else {
        // Regular chat approval
        setIsProcessing(true);
        try {
          await consumeStream(a.resolveApprovalVote(approved, a.motebitId));
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          addSystemMessage(`[Error: ${errMsg}]`);
        } finally {
          setIsProcessing(false);
          pendingApprovalRef.current = null;
        }
      }
    },
    [consumeStream],
  );

  // === Settings save ===
  const handleSettingsSave = useCallback(
    async (newSettings: MobileSettings, aiConfig?: MobileAIConfig) => {
      const a = app.current;
      // Capture operator mode before potential re-init (initAI creates new runtime)
      const wasOperatorMode = a.isOperatorMode;

      await a.saveSettings(newSettings);
      setSettings(newSettings);

      if (aiConfig) {
        const ok = await a.initAI(aiConfig);
        if (!ok) {
          showBanner("Failed to initialize AI — check API key", "Settings", () =>
            setShowSettings(true),
          );
        } else {
          a.start();
          subscribeToState(a);
          setCurrentModel(a.currentModel);
        }

        // Re-apply governance to the new runtime (initAI resets PolicyGate to defaults).
        // SettingsModal.handleSave already applied these to the old runtime, but the
        // new runtime needs them too.
        const preset = APPROVAL_PRESET_CONFIGS[newSettings.approvalPreset];
        if (preset) {
          a.updatePolicyConfig({
            requireApprovalAbove: preset.requireApprovalAbove,
            denyAbove: preset.denyAbove,
            operatorMode: wasOperatorMode,
            budget: { maxCallsPerTurn: newSettings.maxCallsPerTurn },
          });
        }
        a.updateMemoryGovernance({
          persistenceThreshold: newSettings.persistenceThreshold,
          rejectSecrets: newSettings.rejectSecrets,
          maxMemoriesPerTurn: newSettings.maxMemoriesPerTurn,
        });
        if (newSettings.appearance.colorPreset === "custom") {
          a.setInteriorColorDirect(
            deriveInteriorColor(
              newSettings.appearance.customHue ?? 220,
              newSettings.appearance.customSaturation ?? 0.7,
            ),
          );
        } else {
          a.setInteriorColor(newSettings.appearance.colorPreset);
        }
      }

      // Re-init voice providers (user may have added/changed OpenAI key or TTS voice)
      sttRef.current = null;
      await initVoice({ ttsVoice: newSettings.voice.ttsVoice });

      setShowSettings(false);
    },
    [subscribeToState, addSystemMessage, initVoice],
  );

  // === PIN handler ===

  /**
   * When the user taps "Enable" operator mode, we first probe setOperatorMode(true)
   * without a PIN to detect the correct flow:
   * - needsSetup → show setup dialog
   * - "PIN required" error → show verify dialog
   * - success → no keyring / dev mode, just enable
   * This matches the desktop pattern and avoids overwriting an existing PIN.
   */
  const handleRequestPin = useCallback(async (mode: "setup" | "verify" | "reset") => {
    const a = app.current;

    if (mode === "reset") {
      setPinMode("reset");
      setShowPin(true);
      return;
    }

    // Disabling operator mode: always verify
    if (a.isOperatorMode) {
      setPinMode("verify");
      setShowPin(true);
      return;
    }

    // Enabling: probe to detect correct flow
    const probe = await a.setOperatorMode(true);
    if (probe.success) {
      // No keyring / dev mode — enabled directly, no PIN needed
      return;
    }
    if (probe.needsSetup === true) {
      setPinMode("setup");
    } else {
      setPinMode("verify");
    }
    setShowPin(true);
  }, []);

  const handlePinSubmit = useCallback(
    async (pin: string) => {
      const a = app.current;
      if (pinMode === "setup" || pinMode === "reset") {
        await a.setupOperatorPin(pin);
        const result = await a.setOperatorMode(true, pin);
        if (!result.success) {
          setPinError(result.error ?? "Failed");
          return;
        }
      } else {
        const result = await a.setOperatorMode(!a.isOperatorMode, pin);
        if (!result.success) {
          setPinError(result.error ?? "Incorrect PIN");
          return;
        }
      }
      setShowPin(false);
      setPinError("");
    },
    [pinMode],
  );

  // === Pairing helpers ===

  const stopPairingPoll = useCallback(() => {
    if (pairingPollRef.current) {
      clearInterval(pairingPollRef.current);
      pairingPollRef.current = null;
    }
  }, []);

  const closePairingDialog = useCallback(() => {
    stopPairingPoll();
    setShowPairing(false);
    setPairingId(null);
    setPairingCode("");
    setPairingCodeInput("");
    setPairingClaimName("");
    setPairingSyncUrlInput("");
  }, [stopPairingPoll]);

  // Device A: initiate from settings — show pairing modal with sync URL input
  const handleInitiatePairing = useCallback(() => {
    setPairingMode("initiate");
    setPairingSyncUrlInput("");
    setPairingStatusText("Enter your sync relay URL");
    setShowSettings(false);
    setShowPairing(true);
  }, []);

  // Device A: after entering sync URL, generate pairing code
  const handleInitiateConnect = useCallback(async () => {
    const url = pairingSyncUrlInput.trim();
    if (!url) {
      setPairingStatusText("Sync relay URL required");
      return;
    }
    const a = app.current;
    pairingSyncUrlRef.current = url;
    setPairingStatusText("Generating code...");
    try {
      const { pairingCode: code, pairingId: pid } = await a.initiatePairing(url);
      setPairingCode(code);
      setPairingId(pid);
      setPairingStatusText("Enter this code on the other device");

      // Poll for claim
      pairingPollRef.current = setInterval(() => {
        void (async () => {
          try {
            const session = await a.getPairingSession(url, pid);
            if (session.status === "claimed") {
              stopPairingPoll();
              setPairingClaimName(session.claiming_device_name ?? "Unknown device");
              setPairingStatusText(`"${session.claiming_device_name}" wants to join`);
            }
          } catch {
            // Non-fatal
          }
        })();
      }, 2000);
    } catch (err: unknown) {
      setPairingStatusText(err instanceof Error ? err.message : String(err));
    }
  }, [pairingSyncUrlInput, stopPairingPoll]);

  // Device B: submit claim code
  const handlePairingClaimSubmit = useCallback(async () => {
    const code = pairingCodeInput.trim().toUpperCase();
    if (code.length !== 6) {
      setPairingStatusText("Code must be 6 characters");
      return;
    }

    const a = app.current;

    const syncUrl = pairingSyncUrlInput.trim();
    if (!syncUrl) {
      setPairingStatusText("Sync relay URL required");
      return;
    }

    pairingSyncUrlRef.current = syncUrl;
    setPairingStatusText("Claiming...");
    try {
      const { pairingId: pid } = await a.claimPairing(syncUrl, code);
      setPairingId(pid);
      setPairingStatusText("Waiting for approval...");

      // Poll for approval
      pairingPollRef.current = setInterval(() => {
        void (async () => {
          try {
            const status = await a.pollPairingStatus(syncUrl, pid);
            if (
              status.status === "approved" &&
              status.device_id != null &&
              status.device_id !== "" &&
              status.motebit_id != null &&
              status.motebit_id !== ""
            ) {
              stopPairingPoll();
              await a.completePairing(
                {
                  motebitId: status.motebit_id,
                  deviceId: status.device_id,
                },
                syncUrl,
              );
              closePairingDialog();
              addSystemMessage("Linked to existing motebit");

              // Initialize AI and start
              const s = settings || (await a.loadSettings());
              await initializeAI(a, s);
              a.start();
              subscribeToState(a);

              // Start sync
              a.onSyncStatus((st, lastSync) => {
                setSyncStatus(st);
                setLastSyncTime(lastSync);
              });
              void a.startSync(syncUrl);

              setInitialized(true);
            } else if (status.status === "denied") {
              stopPairingPoll();
              setPairingStatusText("Pairing was denied by the other device");
            }
          } catch {
            // Non-fatal
          }
        })();
      }, 2000);
    } catch (err: unknown) {
      setPairingStatusText(err instanceof Error ? err.message : String(err));
    }
  }, [
    pairingCodeInput,
    pairingSyncUrlInput,
    settings,
    initializeAI,
    subscribeToState,
    stopPairingPoll,
    closePairingDialog,
    addSystemMessage,
  ]);

  // Device A: approve
  const handlePairingApprove = useCallback(async () => {
    if (pairingId == null || pairingId === "") return;
    const a = app.current;

    const syncUrl = pairingSyncUrlRef.current;
    setPairingStatusText("Approving...");
    try {
      const result = await a.approvePairing(syncUrl, pairingId);
      closePairingDialog();
      addSystemMessage(`Device linked (${result.deviceId.slice(0, 8)}...)`);
    } catch (err: unknown) {
      setPairingStatusText(err instanceof Error ? err.message : String(err));
    }
  }, [pairingId, closePairingDialog, addSystemMessage]);

  // Device A: deny
  const handlePairingDeny = useCallback(async () => {
    if (pairingId == null || pairingId === "") return;
    const a = app.current;
    const syncUrl = pairingSyncUrlRef.current;
    try {
      await a.denyPairing(syncUrl, pairingId);
      closePairingDialog();
      addSystemMessage("Pairing denied");
    } catch (err: unknown) {
      setPairingStatusText(err instanceof Error ? err.message : String(err));
    }
  }, [pairingId, closePairingDialog, addSystemMessage]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => stopPairingPoll();
  }, [stopPairingPoll]);

  // === Scroll to bottom ===
  useEffect(() => {
    if (flatListRef.current && messages.length > 0) {
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages.length]);

  // Dynamic styles keyed on theme colors
  const ds = useMemo(() => createDynamicStyles(themeColors), [themeColors]);

  // === Loading state ===
  if (!initialized) {
    return (
      <ThemeContext.Provider value={themeColors}>
        <View style={[ds.container, { justifyContent: "center", alignItems: "center" }]}>
          <ActivityIndicator size="large" color={themeColors.textMuted} />
          <Text style={ds.loadingText}>Initializing Motebit...</Text>
        </View>
      </ThemeContext.Provider>
    );
  }

  return (
    <ThemeContext.Provider value={themeColors}>
      <KeyboardAvoidingView
        style={ds.container}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 20}
      >
        {/* 3D Rendering — WebView with full WebGL2 (same engine as Safari) */}
        <View style={ds.glContainer}>
          <WebView
            ref={handleWebViewRef}
            source={{ html: app.current.getRenderer().getHTML() }}
            style={ds.glView}
            scrollEnabled={false}
            bounces={false}
            overScrollMode="never"
            javaScriptEnabled={true}
            originWhitelist={["*"]}
            onMessage={onWebViewMessage}
            allowsInlineMediaPlayback={true}
          />
          {state && (
            <View style={ds.stateOverlay}>
              <Text style={ds.stateText}>
                attn {state.attention.toFixed(2)} · conf {state.confidence.toFixed(2)} · val{" "}
                {state.affect_valence.toFixed(2)}
                {app.current.governanceStatus.governed ? " · gov" : ""}
                {micState !== "off" ? ` · ${micState}` : ""}
                {` · gl ${glStage}`}
              </Text>
            </View>
          )}
          {/* Left buttons: Conversations, Memory, Sovereign */}
          <View style={ds.topLeftButtons}>
            <TouchableOpacity
              style={ds.overlayButton}
              onPress={() => setShowConversationPanel(true)}
              activeOpacity={0.7}
            >
              <Feather name="message-square" size={18} color={themeColors.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity
              style={ds.overlayButton}
              onPress={() => setShowMemoryPanel(true)}
              activeOpacity={0.7}
            >
              <Feather name="sun" size={18} color={themeColors.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity
              style={ds.overlayButton}
              onPress={() => setShowCredentialsPanel(true)}
              activeOpacity={0.7}
            >
              <Feather name="lock" size={18} color={themeColors.textMuted} />
            </TouchableOpacity>
          </View>
          {/* Center: sync status */}
          <TouchableOpacity
            style={ds.syncButton}
            onPress={() => {
              if (syncStatus === "offline") {
                setShowSettings(true);
              } else if (syncStatus === "idle") {
                showToast("Synced with relay");
              } else if (syncStatus === "syncing") {
                showToast("Syncing…");
              } else if (syncStatus === "error") {
                showToast("Sync error — check relay in Settings");
              }
            }}
            activeOpacity={0.7}
          >
            <Feather
              name={syncStatus === "error" ? "cloud-off" : "cloud"}
              size={16}
              color={
                syncStatus === "idle"
                  ? "#4ade80"
                  : syncStatus === "syncing"
                    ? "#6366f1"
                    : syncStatus === "error"
                      ? "#f87171"
                      : themeColors.textGhost
              }
            />
          </TouchableOpacity>
          {/* Right buttons: Goals, Agents, Settings */}
          <View style={ds.topRightButtons}>
            <TouchableOpacity
              style={ds.overlayButton}
              onPress={() => setShowGoalsPanel(true)}
              activeOpacity={0.7}
            >
              <Feather name="target" size={18} color={themeColors.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity
              style={ds.overlayButton}
              onPress={() => setShowAgentsPanel(true)}
              activeOpacity={0.7}
            >
              <Feather name="users" size={18} color={themeColors.textMuted} />
            </TouchableOpacity>
            <TouchableOpacity
              style={ds.overlayButton}
              onPress={() => setShowSettings(true)}
              activeOpacity={0.7}
            >
              <Feather name="settings" size={18} color={themeColors.textMuted} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Goal status indicator */}
        {goalRunning && (
          <View style={ds.goalIndicator}>
            <ActivityIndicator size="small" color={themeColors.accent} />
            <Text style={ds.goalIndicatorText}>Running goal...</Text>
          </View>
        )}

        {/* Persistent error banner */}
        {banner != null && (
          <Banner
            message={banner.message}
            actionLabel={banner.actionLabel}
            onAction={banner.onAction}
            onDismiss={dismissBanner}
          />
        )}

        {/* Chat Messages */}
        <FlatList<ChatMessage>
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.id}
          style={ds.chatList}
          contentContainerStyle={ds.chatContent}
          renderItem={({ item }: { item: ChatMessage }) => {
            if (item.role === "approval") {
              return (
                <ApprovalCard
                  toolName={item.toolName ?? "unknown"}
                  args={item.toolArgs || {}}
                  riskLevel={item.riskLevel}
                  onAllow={() => void handleApproval(item.id, true)}
                  onDeny={() => void handleApproval(item.id, false)}
                  disabled={item.approvalResolved}
                />
              );
            }
            if (item.role === "system") {
              return (
                <AnimatedBubble style={ds.systemBubble}>
                  <Text style={ds.systemText}>{item.content}</Text>
                </AnimatedBubble>
              );
            }
            return (
              <AnimatedBubble
                style={[
                  ds.messageBubble,
                  item.role === "user" ? ds.userBubble : ds.assistantBubble,
                ]}
              >
                <Text
                  style={[ds.messageText, item.role === "user" ? ds.userText : ds.assistantText]}
                >
                  {item.content}
                </Text>
              </AnimatedBubble>
            );
          }}
        />

        {/* Voice amplitude indicator */}
        <VoiceIndicator micState={micState} audioLevel={audioLevel} glowColor={activeGlow} />

        {/* Slash command autocomplete */}
        <SlashAutocomplete
          inputText={inputText}
          onSelect={(cmd) => {
            setInputText("");
            handleSlashCommand(cmd, "");
          }}
        />

        {/* Model indicator */}
        {currentModel ? <Text style={ds.modelIndicator}>{currentModel}</Text> : null}

        {/* Input Bar */}
        <View style={ds.inputBar}>
          <TextInput
            style={ds.textInput}
            value={inputText}
            onChangeText={setInputText}
            placeholder="Talk to your motebit..."
            placeholderTextColor={themeColors.inputPlaceholder}
            returnKeyType="send"
            onSubmitEditing={() => void handleSend()}
            editable={!isProcessing && (micState === "off" || micState === "ambient")}
          />
          {/* Mic button — show when input is empty and not processing */}
          {!inputText.trim() && !isProcessing ? (
            <TouchableOpacity
              style={[
                ds.micButton,
                micState !== "off" && micButtonActiveStyle,
                micState === "voice" && ds.micButtonRecording,
                micState === "transcribing" && ds.sendButtonDisabled,
              ]}
              onPress={() => void handleMicPress()}
              disabled={micState === "transcribing"}
              activeOpacity={0.7}
            >
              {micState === "transcribing" ? (
                <ActivityIndicator size="small" color={themeColors.textPrimary} />
              ) : (
                <View
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 7,
                    backgroundColor:
                      micState === "off"
                        ? "transparent"
                        : micState === "voice"
                          ? themeColors.accent
                          : themeColors.accent + "99",
                    borderWidth: micState === "off" ? 2 : 0,
                    borderColor: themeColors.textMuted,
                  }}
                />
              )}
            </TouchableOpacity>
          ) : null}
          {/* Send button — show when input has text or processing */}
          {inputText.trim() || isProcessing ? (
            <TouchableOpacity
              style={[ds.sendButton, isProcessing && ds.sendButtonDisabled]}
              onPress={() => void handleSend()}
              disabled={isProcessing}
            >
              {isProcessing ? (
                <ActivityIndicator size="small" color={themeColors.bgPrimary} />
              ) : (
                <Text style={ds.sendButtonText}>↑</Text>
              )}
            </TouchableOpacity>
          ) : null}
        </View>

        {/* Modals */}
        {settings && (
          <SettingsModal
            visible={showSettings}
            app={app.current}
            settings={settings}
            mcpServers={mcpServers}
            onAddMcpServer={handleAddMcpServer}
            onRemoveMcpServer={handleRemoveMcpServer}
            onToggleMcpTrust={handleToggleMcpTrust}
            onSave={(s, ai) => void handleSettingsSave(s, ai)}
            onClose={() => setShowSettings(false)}
            customHue={settings.appearance.customHue ?? 220}
            customSaturation={settings.appearance.customSaturation ?? 0.7}
            onRequestPin={(mode) => void handleRequestPin(mode)}
            onLinkDevice={() => void handleInitiatePairing()}
          />
        )}

        <PinDialog
          visible={showPin}
          mode={pinMode}
          onSubmit={handlePinSubmit}
          onCancel={() => {
            setShowPin(false);
            setPinError("");
          }}
          error={pinError}
        />

        <MemoryPanel
          visible={showMemoryPanel}
          app={app.current}
          onClose={() => setShowMemoryPanel(false)}
        />

        <ConversationPanel
          visible={showConversationPanel}
          app={app.current}
          currentConversationId={app.current.currentConversationId}
          onLoad={handleLoadConversation}
          onNew={handleNewConversation}
          onClose={() => setShowConversationPanel(false)}
        />

        <GoalsPanel
          visible={showGoalsPanel}
          app={app.current}
          onClose={() => setShowGoalsPanel(false)}
        />

        <SovereignPanel
          visible={showCredentialsPanel}
          app={app.current}
          onClose={() => setShowCredentialsPanel(false)}
        />

        <AgentsPanel
          visible={showAgentsPanel}
          app={app.current}
          onClose={() => setShowAgentsPanel(false)}
        />

        {/* Pairing Modal */}
        <Modal visible={showPairing} animationType="fade" transparent statusBarTranslucent>
          <View style={ds.pairingBackdrop}>
            <View style={ds.pairingCard}>
              <Text style={ds.pairingTitle}>
                {pairingMode === "initiate" ? "Link Another Device" : "Link Existing Motebit"}
              </Text>

              {/* Sync URL input — shown before code generation (initiate) or submission (claim) */}
              {((pairingMode === "initiate" && (pairingCode == null || pairingCode === "")) ||
                (pairingMode === "claim" && (pairingId == null || pairingId === ""))) && (
                <TextInput
                  style={ds.pairingSyncUrlInput}
                  value={pairingSyncUrlInput}
                  onChangeText={setPairingSyncUrlInput}
                  placeholder="Sync relay URL"
                  placeholderTextColor={themeColors.inputPlaceholder}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                />
              )}

              {pairingMode === "initiate" && pairingCode != null && pairingCode !== "" ? (
                <Text style={ds.pairingCodeDisplay}>{pairingCode}</Text>
              ) : null}

              {pairingMode === "claim" && (pairingId == null || pairingId === "") && (
                <TextInput
                  style={ds.pairingInput}
                  value={pairingCodeInput}
                  onChangeText={(t) => setPairingCodeInput(t.toUpperCase().slice(0, 6))}
                  placeholder="Enter code"
                  placeholderTextColor={themeColors.inputPlaceholder}
                  maxLength={6}
                  autoCapitalize="characters"
                  autoCorrect={false}
                />
              )}

              {pairingClaimName ? (
                <View style={ds.pairingClaimInfo}>
                  <Text style={ds.pairingClaimText}>"{pairingClaimName}" wants to join</Text>
                </View>
              ) : null}

              <Text style={ds.pairingStatusText}>{pairingStatus}</Text>

              <View style={ds.pairingActions}>
                {pairingMode === "initiate" && !pairingCode && (
                  <TouchableOpacity
                    style={ds.pairingSubmitBtn}
                    onPress={() => void handleInitiateConnect()}
                    activeOpacity={0.7}
                  >
                    <Text style={ds.pairingSubmitText}>Connect</Text>
                  </TouchableOpacity>
                )}
                {pairingMode === "claim" && (pairingId == null || pairingId === "") && (
                  <TouchableOpacity
                    style={ds.pairingSubmitBtn}
                    onPress={() => void handlePairingClaimSubmit()}
                    activeOpacity={0.7}
                  >
                    <Text style={ds.pairingSubmitText}>Submit</Text>
                  </TouchableOpacity>
                )}
                {pairingMode === "initiate" && pairingClaimName ? (
                  <>
                    <TouchableOpacity
                      style={ds.pairingDenyBtn}
                      onPress={() => void handlePairingDeny()}
                      activeOpacity={0.7}
                    >
                      <Text style={ds.pairingDenyText}>Deny</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={ds.pairingApproveBtn}
                      onPress={() => void handlePairingApprove()}
                      activeOpacity={0.7}
                    >
                      <Text style={ds.pairingApproveText}>Approve</Text>
                    </TouchableOpacity>
                  </>
                ) : null}
                <TouchableOpacity
                  style={ds.pairingCancelBtn}
                  onPress={closePairingDialog}
                  activeOpacity={0.7}
                >
                  <Text style={ds.pairingCancelText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
        <Toast message={toastMessage} onDismiss={dismissToast} />
      </KeyboardAvoidingView>
    </ThemeContext.Provider>
  );
}

// === Styles ===

function createDynamicStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.bgPrimary,
    },
    loadingText: {
      color: c.textMuted,
      fontSize: 14,
      marginTop: 16,
      textAlign: "center",
    },

    // GL View
    glContainer: {
      flex: 3,
      position: "relative",
    },
    glView: {
      flex: 1,
    },
    stateOverlay: {
      position: "absolute",
      bottom: 8,
      left: 12,
      right: 12,
    },
    stateText: {
      color: c.textGhost,
      fontSize: 10,
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    },
    topLeftButtons: {
      position: "absolute",
      top: Platform.OS === "ios" ? 50 : 12,
      left: 12,
      flexDirection: "row",
      gap: 8,
    },
    topRightButtons: {
      position: "absolute",
      top: Platform.OS === "ios" ? 50 : 12,
      right: 12,
      flexDirection: "row",
      gap: 8,
    },
    overlayButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: c.overlayButtonBg,
      justifyContent: "center",
      alignItems: "center",
    },
    syncButton: {
      position: "absolute",
      top: Platform.OS === "ios" ? 53 : 15,
      left: "50%",
      marginLeft: -14,
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: c.overlayButtonBg,
      justifyContent: "center",
      alignItems: "center",
    },

    // Goal indicator
    goalIndicator: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 6,
      gap: 8,
      backgroundColor: c.bgGlass,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderPrimary,
    },
    goalIndicatorText: {
      color: c.accent,
      fontSize: 12,
      fontWeight: "600",
    },

    // Chat
    chatList: {
      flex: 1,
    },
    chatContent: {
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    messageBubble: {
      maxWidth: "80%",
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: 16,
      marginVertical: 3,
    },
    userBubble: {
      alignSelf: "flex-end",
      backgroundColor: c.userBubbleBg,
    },
    assistantBubble: {
      alignSelf: "flex-start",
      backgroundColor: c.assistantBubbleBg,
    },
    systemBubble: {
      alignSelf: "center",
      backgroundColor: "transparent",
      paddingVertical: 4,
      paddingHorizontal: 12,
      marginVertical: 2,
    },
    messageText: {
      fontSize: 15,
      lineHeight: 21,
    },
    userText: {
      color: c.userBubbleText,
    },
    assistantText: {
      color: c.assistantBubbleText,
    },
    systemText: {
      color: c.systemText,
      fontSize: 12,
      fontStyle: "italic",
      textAlign: "center",
    },

    // Model indicator
    modelIndicator: {
      fontSize: 10,
      fontWeight: "500",
      color: c.textMuted,
      textAlign: "center",
      letterSpacing: 0.5,
      paddingVertical: 2,
    },

    // Input
    inputBar: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 12,
      paddingVertical: 8,
      paddingBottom: Platform.OS === "ios" ? 28 : 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.borderPrimary,
      backgroundColor: c.bgPrimary,
    },
    textInput: {
      flex: 1,
      height: 40,
      borderRadius: 20,
      paddingHorizontal: 16,
      backgroundColor: c.inputBg,
      color: c.inputText,
      fontSize: 15,
    },
    sendButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: c.buttonPrimaryBg,
      justifyContent: "center",
      alignItems: "center",
      marginLeft: 8,
    },
    sendButtonDisabled: {
      opacity: 0.5,
    },
    sendButtonText: {
      color: c.buttonPrimaryText,
      fontSize: 18,
      fontWeight: "600",
    },
    micButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: c.borderLight,
      justifyContent: "center",
      alignItems: "center",
      marginLeft: 8,
    },
    micButtonRecording: {
      backgroundColor: c.errorBannerBg,
    },
    micButtonText: {
      color: c.textPrimary,
      fontSize: 16,
    },

    // Pairing
    pairingBackdrop: {
      flex: 1,
      backgroundColor: c.overlayBg,
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: 32,
    },
    pairingCard: {
      backgroundColor: c.bgSecondary,
      borderRadius: 20,
      padding: 24,
      width: "100%",
      maxWidth: 320,
      alignItems: "center",
      gap: 14,
    },
    pairingTitle: {
      color: c.textPrimary,
      fontSize: 17,
      fontWeight: "600",
    },
    pairingCodeDisplay: {
      color: c.accent,
      fontSize: 28,
      fontWeight: "700",
      letterSpacing: 6,
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
      paddingVertical: 8,
    },
    pairingInput: {
      width: "100%",
      backgroundColor: c.bgTertiary,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      color: c.textPrimary,
      fontSize: 20,
      letterSpacing: 6,
      textAlign: "center",
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    },
    pairingSyncUrlInput: {
      width: "100%",
      backgroundColor: c.bgTertiary,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      color: c.textPrimary,
      fontSize: 14,
    },
    pairingClaimInfo: {
      backgroundColor: c.accentSoft,
      borderRadius: 8,
      padding: 12,
      width: "100%",
    },
    pairingClaimText: {
      color: c.textSecondary,
      fontSize: 14,
      textAlign: "center",
    },
    pairingStatusText: {
      color: c.textMuted,
      fontSize: 12,
      textAlign: "center",
    },
    pairingActions: {
      flexDirection: "row",
      gap: 8,
      width: "100%",
    },
    pairingSubmitBtn: {
      flex: 1,
      backgroundColor: c.buttonPrimaryBg,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: "center",
    },
    pairingSubmitText: { color: c.buttonPrimaryText, fontSize: 15, fontWeight: "600" },
    pairingApproveBtn: {
      flex: 1,
      backgroundColor: c.buttonPrimaryBg,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: "center",
    },
    pairingApproveText: { color: c.buttonPrimaryText, fontSize: 15, fontWeight: "600" },
    pairingDenyBtn: {
      flex: 1,
      backgroundColor: c.buttonSecondaryBg,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: "center",
    },
    pairingDenyText: { color: c.buttonSecondaryText, fontSize: 15, fontWeight: "600" },
    pairingCancelBtn: {
      flex: 1,
      backgroundColor: c.buttonSecondaryBg,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: "center",
    },
    pairingCancelText: { color: c.buttonSecondaryText, fontSize: 15 },
  });
}
