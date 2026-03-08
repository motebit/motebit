/**
 * @motebit/mobile — React Native app
 *
 * Thin platform shell around MobileApp (which wraps MotebitRuntime).
 * This file is React Native views + modals wired to MobileApp methods.
 *
 * Initialization flow:
 * 1. loadSettings → load saved settings from AsyncStorage
 * 2. bootstrap → check/create cryptographic identity
 * 3. If first launch → WelcomeOverlay → wait for acceptance
 * 4. initAI → connect AI provider
 * 5. Apply saved governance settings
 * 6. start → begin state tick loop
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
import { GLView } from "expo-gl";
import type { ExpoWebGLRenderingContext } from "expo-gl";
import * as SecureStore from "expo-secure-store";
import type { MotebitState, BehaviorCues } from "@motebit/sdk";
import type { StreamChunk } from "@motebit/runtime";
import { stripTags, stripPartialActionTag } from "@motebit/ai-core";
import type { TTSProvider, STTProvider } from "@motebit/voice";
import { FallbackTTSProvider } from "@motebit/voice";
import { ExpoSpeechTTSProvider } from "./adapters/expo-speech-tts";
import { OpenAITTSProvider } from "./adapters/openai-tts";
import { ExpoAVSTTProvider } from "./adapters/expo-av-stt";
import { AudioMonitor } from "./adapters/audio-monitor";
import { MobileApp, APPROVAL_PRESET_CONFIGS, COLOR_PRESETS } from "./mobile-app";
import type { MobileSettings, MobileAIConfig, GoalCompleteEvent, GoalApprovalEvent } from "./mobile-app";
import { WelcomeOverlay } from "./components/WelcomeOverlay";
import { ApprovalCard } from "./components/ApprovalCard";
import { PinDialog } from "./components/PinDialog";
import type { PinMode } from "./components/PinDialog";
import { SettingsModal, deriveInteriorColor } from "./components/SettingsModal";
import { MemoryPanel } from "./components/MemoryPanel";
import { ConversationPanel } from "./components/ConversationPanel";
import { VoiceIndicator } from "./components/VoiceIndicator";
import { GoalsPanel } from "./components/GoalsPanel";
import { Toast } from "./components/Toast";
import { AnimatedBubble } from "./components/AnimatedBubble";
import { SlashAutocomplete } from "./components/SlashAutocomplete";
import { Banner } from "./components/Banner";
import { ThemeContext, resolveTheme, type ThemeColors } from "./theme";

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

function formatSyncTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

// === App singleton ===

let appInstance: MobileApp | null = null;
function getApp(): MobileApp {
  if (!appInstance) appInstance = new MobileApp();
  return appInstance;
}

// === Main App Component ===

export function App(): React.ReactElement {
  const app = useRef<MobileApp>(getApp());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [state, setState] = useState<MotebitState | null>(null);
  const [, setCues] = useState<BehaviorCues | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [settings, setSettings] = useState<MobileSettings | null>(null);
  const animFrameRef = useRef<number>(0);
  const flatListRef = useRef<FlatList>(null);

  // Modal state
  const [showWelcome, setShowWelcome] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const [pinMode, setPinMode] = useState<PinMode>("setup");
  const [pinError, setPinError] = useState("");

  // Memory, conversation & goals panel state
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);
  const [showConversationPanel, setShowConversationPanel] = useState(false);
  const [showGoalsPanel, setShowGoalsPanel] = useState(false);

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
  const showToast = useCallback((msg: string) => { setToastMessage(msg); }, []);
  const dismissToast = useCallback(() => { setToastMessage(null); }, []);

  // Banner state (persistent errors with optional action)
  const [banner, setBanner] = useState<{ message: string; actionLabel?: string; onAction?: () => void } | null>(null);
  const showBanner = useCallback((message: string, actionLabel?: string, onAction?: () => void) => {
    setBanner({ message, actionLabel, onAction });
  }, []);
  const dismissBanner = useCallback(() => { setBanner(null); }, []);

  // Voice state — 5-state machine:
  //   off → ambient (mic listening, creature breathes, VAD armed)
  //   ambient → voice (VAD triggered or manual tap, STT recording)
  //   voice → transcribing (recording stopped, Whisper API call)
  //   transcribing → ambient (result received, auto-send, return to listening)
  //   speaking → ambient (TTS finished or cancelled)
  //   Any → off (explicit stop)
  const [micState, setMicState] = useState<"off" | "ambient" | "voice" | "transcribing" | "speaking">("off");
  const ttsRef = useRef<TTSProvider | null>(null);
  const sttRef = useRef<STTProvider | null>(null);
  const audioMonitorRef = useRef<AudioMonitor | null>(null);
  const ttsPulseRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Track whether voice was auto-triggered by VAD (vs manual tap from ambient)
  const vadTriggeredRef = useRef(false);
  // Audio level for VoiceIndicator visualization
  const [audioLevel, setAudioLevel] = useState(0);

  // Sync state
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "error" | "offline">("offline");
  const [lastSyncTime, setLastSyncTime] = useState(0);
  const pairingSyncUrlRef = useRef("");

  // MCP state
  const [mcpServers, setMcpServers] = useState<Array<{ name: string; url: string; connected: boolean; toolCount: number; trusted: boolean; motebit: boolean; motebitPublicKey?: string }>>([]);

  // Model indicator
  const [currentModel, setCurrentModel] = useState<string | null>(null);

  // Goal scheduler state
  const [goalRunning, setGoalRunning] = useState(false);

  // Derive theme colors from settings
  const themeColors = useMemo<ThemeColors>(
    () => resolveTheme(settings?.theme ?? "dark"),
    [settings?.theme],
  );

  // Listen for system appearance changes to re-resolve "system" theme
  useEffect(() => {
    if (settings?.theme !== "system") return undefined;
    const sub = Appearance.addChangeListener(() => {
      // Force re-render by updating settings reference
      setSettings((prev) => prev ? { ...prev } : prev);
    });
    return () => sub.remove();
  }, [settings?.theme]);

  // Derive voice glow color from creature preset
  const activeGlow = useMemo((): [number, number, number] | undefined => {
    const preset = COLOR_PRESETS[settings?.colorPreset ?? "moonlight"];
    return preset?.glow;
  }, [settings?.colorPreset]);

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

  // Orbit control touch tracking
  const lastTouchRef = useRef<{ x: number; y: number } | null>(null);
  const lastPinchDistRef = useRef<number>(0);
  const lastTapTimeRef = useRef<number>(0);

  // === Initialization ===
  useEffect(() => {
    void (async () => {
      const a = app.current;

      // 1. Load settings
      const loaded = await a.loadSettings();
      setSettings(loaded);

      // 2. Bootstrap identity
      const { isFirstLaunch } = await a.bootstrap();

      if (isFirstLaunch) {
        // 3. Show welcome overlay, wait for acceptance
        setShowWelcome(true);
        return; // Will continue after acceptance
      }

      // 4. Init AI with saved settings
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
    })();

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      app.current.stopGoalScheduler();
      app.current.stopSync();
      if (audioMonitorRef.current) void audioMonitorRef.current.stop();
      if (ttsPulseRef.current) clearInterval(ttsPulseRef.current);
      ttsRef.current?.cancel();
      sttRef.current?.stop();
    };
  }, []);

  // Initialize voice providers — TTS chain: OpenAI TTS → expo-speech fallback
  const initVoice = useCallback(async (voiceSettings?: { ttsVoice?: string }) => {
    const openaiKey = await SecureStore.getItemAsync("motebit_openai_api_key");
    const voice = voiceSettings?.ttsVoice ?? settings?.ttsVoice ?? "alloy";

    // Build TTS chain: OpenAI (if key available) → system TTS fallback
    const systemTts = new ExpoSpeechTTSProvider();
    if (openaiKey != null && openaiKey !== "") {
      const openaiTts = new OpenAITTSProvider({ apiKey: openaiKey, voice });
      ttsRef.current = new FallbackTTSProvider([openaiTts, systemTts]);
    } else {
      ttsRef.current = systemTts;
    }

    if (!sttRef.current) {
      // STT needs an OpenAI API key for Whisper
      if (openaiKey != null && openaiKey !== "") {
        sttRef.current = new ExpoAVSTTProvider({ apiKey: openaiKey });
      }
    }
  }, [settings?.ttsVoice]);

  const applyThemeEnvironment = useCallback((a: MobileApp, theme: "light" | "dark" | "system") => {
    const effective = theme === "system" ? (Appearance.getColorScheme() ?? "dark") : theme;
    if (effective === "dark") {
      a.setDarkEnvironment();
    } else {
      a.setLightEnvironment();
    }
  }, []);

  const initializeAI = useCallback(async (a: MobileApp, s: MobileSettings) => {
    // Capture operator mode before re-init (initAI creates a new runtime/PolicyGate
    // that resets to default operatorMode: false)
    const wasOperatorMode = a.isOperatorMode;

    const apiKey = (s.provider === "anthropic" || s.provider === "hybrid")
      ? (await SecureStore.getItemAsync("motebit_anthropic_api_key")) ?? undefined
      : undefined;

    await a.initAI({
      provider: s.provider,
      model: s.model,
      apiKey,
      ollamaEndpoint: (s.provider === "ollama" || s.provider === "hybrid") ? s.ollamaEndpoint : undefined,
    });

    // Apply governance (restore operator mode captured before re-init)
    const preset = APPROVAL_PRESET_CONFIGS[s.approvalPreset];
    if (preset) {
      a.updatePolicyConfig({
        requireApprovalAbove: preset.requireApprovalAbove,
        denyAbove: preset.denyAbove,
        operatorMode: wasOperatorMode,
        budget: { maxCallsPerTurn: s.budgetMaxCalls },
      });
    }
    a.updateMemoryGovernance({
      persistenceThreshold: s.persistenceThreshold,
      rejectSecrets: s.rejectSecrets,
      maxMemoriesPerTurn: s.maxMemoriesPerTurn,
    });

    // Apply color preset and theme environment
    if (s.colorPreset === "custom") {
      a.setInteriorColorDirect(deriveInteriorColor(s.customHue, s.customSaturation));
    } else {
      a.setInteriorColor(s.colorPreset);
    }
    applyThemeEnvironment(a, s.theme);
  }, [applyThemeEnvironment]);

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
      const content = event.status === "completed" && (event.summary != null && event.summary !== "")
        ? `Goal completed: ${event.summary}`
        : event.status === "failed" && (event.error != null && event.error !== "")
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

  // === Welcome acceptance ===
  const handleWelcomeAccept = useCallback(async () => {
    setShowWelcome(false);
    const a = app.current;

    // Identity already exists from bootstrap — just init AI and start
    const s = settings || (await a.loadSettings());
    await initializeAI(a, s);
    setCurrentModel(a.currentModel);
    await initVoice();
    a.start();
    subscribeToState(a);
    startGoals(a);
    // No conversation to restore on first launch, but call for consistency
    restoreConversation(a);
    setInitialized(true);
  }, [settings, initializeAI, initVoice, subscribeToState, startGoals, restoreConversation]);

  // === Welcome link existing ===
  const handleWelcomeLinkExisting = useCallback(() => {
    setShowWelcome(false);
    setPairingMode("claim");
    setPairingCodeInput("");
    setPairingStatusText("Enter the code from your other device");
    setShowPairing(true);
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

  const handleAddMcpServer = useCallback(async (url: string, name: string, trusted?: boolean, motebit?: boolean) => {
    try {
      await app.current.addMcpServer({ name, transport: "http", url, trusted: trusted ?? false, motebit: motebit ?? false });
      refreshMcpServers();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addSystemMessage(`MCP error: ${msg}`);
    }
  }, [refreshMcpServers, addSystemMessage]);

  const handleRemoveMcpServer = useCallback(async (name: string) => {
    try {
      await app.current.removeMcpServer(name);
      refreshMcpServers();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addSystemMessage(`MCP error: ${msg}`);
    }
  }, [refreshMcpServers, addSystemMessage]);

  const handleToggleMcpTrust = useCallback(async (name: string, trusted: boolean) => {
    try {
      await app.current.setMcpServerTrust(name, trusted);
      refreshMcpServers();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addSystemMessage(`MCP error: ${msg}`);
    }
  }, [refreshMcpServers, addSystemMessage]);

  // === GL context ===
  const onGLContextCreate = useCallback(async (gl: ExpoWebGLRenderingContext) => {
    const a = app.current;
    await a.init(gl);

    let lastTime = 0;
    const animate = (time: number): void => {
      const dt = lastTime ? (time - lastTime) / 1000 : 0.016;
      lastTime = time;
      a.renderFrame(dt, time / 1000);
      animFrameRef.current = requestAnimationFrame(animate);
    };
    animFrameRef.current = requestAnimationFrame(animate);
  }, []);

  // === Orbit gesture handlers ===

  const handleGLResponderGrant = useCallback((e: { nativeEvent: { touches: Array<{ pageX: number; pageY: number }> } }) => {
    app.current.handleOrbitTouchStart();
    const { touches } = e.nativeEvent;
    const t0 = touches[0];
    const t1 = touches[1];
    if (touches.length === 1 && t0) {
      lastTouchRef.current = { x: t0.pageX, y: t0.pageY };
    } else if (touches.length === 2 && t0 && t1) {
      const dx = t1.pageX - t0.pageX;
      const dy = t1.pageY - t0.pageY;
      lastPinchDistRef.current = Math.sqrt(dx * dx + dy * dy);
      lastTouchRef.current = null;
    }
  }, []);

  const handleGLResponderMove = useCallback((e: { nativeEvent: { touches: Array<{ pageX: number; pageY: number }> } }) => {
    const { touches } = e.nativeEvent;
    const t0 = touches[0];
    const t1 = touches[1];
    if (touches.length === 1 && t0 && lastTouchRef.current) {
      const dx = t0.pageX - lastTouchRef.current.x;
      const dy = t0.pageY - lastTouchRef.current.y;
      app.current.handleOrbitPan(dx, dy);
      lastTouchRef.current = { x: t0.pageX, y: t0.pageY };
    } else if (touches.length === 2 && t0 && t1 && lastPinchDistRef.current > 0) {
      const dx = t1.pageX - t0.pageX;
      const dy = t1.pageY - t0.pageY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 0) {
        app.current.handleOrbitPinch(dist / lastPinchDistRef.current);
        lastPinchDistRef.current = dist;
      }
    }
  }, []);

  const handleGLResponderRelease = useCallback(() => {
    app.current.handleOrbitTouchEnd();
    const now = Date.now();
    if (lastTouchRef.current && now - lastTapTimeRef.current < 300) {
      app.current.handleOrbitDoubleTap();
    }
    lastTapTimeRef.current = now;
    lastTouchRef.current = null;
    lastPinchDistRef.current = 0;
  }, []);

  // === Audio monitor helpers ===

  /** Start ambient listening — AudioMonitor with VAD that auto-triggers voice recording. */
  const startAmbientMonitor = useCallback(() => {
    if (audioMonitorRef.current?.isRunning === true) return;
    const monitor = new AudioMonitor();
    monitor.neuralVadEnabled = settings?.neuralVadEnabled ?? true;
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
  }, [settings?.neuralVadEnabled]);

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
    if (prevMicStateForVADRef.current === "ambient" && micState === "voice" && vadTriggeredRef.current) {
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
  const handleSlashCommand = useCallback((command: string, args: string) => {
    const a = app.current;
    switch (command) {
      case "model":
        if (!args) {
          addSystemMessage(`Current model: ${a.currentModel ?? "none"}`);
        } else {
          try {
            a.setModel(args);
            setCurrentModel(args);
            showToast(`Model switched to: ${args}`);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            addSystemMessage(`Error: ${msg}`);
          }
        }
        break;
      case "conversations":
        setShowConversationPanel(true);
        break;
      case "new":
        a.startNewConversation();
        setMessages([]);
        showToast("New conversation started");
        break;
      case "memories":
        setShowMemoryPanel(true);
        break;
      case "sync":
        void a.syncNow().then((result) => {
          showToast(
            `Synced: ${result.events_pushed + result.conversations_pushed} pushed, ` +
            `${result.events_pulled + result.conversations_pulled} pulled`,
          );
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          addSystemMessage(`Sync failed: ${msg}`);
        });
        break;
      case "export":
        void a.exportAllData().then((data) => {
          addSystemMessage(`Exported data:\n${data}`);
        });
        break;
      case "settings":
        setShowSettings(true);
        break;
      case "summarize":
        void (async () => {
          try {
            const summary = await a.summarizeConversation();
            if (summary != null && summary !== "") {
              addSystemMessage(`Summary:\n${summary}`);
            } else {
              addSystemMessage("No conversation to summarize (need at least 2 messages).");
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            addSystemMessage(`Summarization failed: ${msg}`);
          }
        })();
        break;
      case "state": {
        const st = a.getState();
        if (st) {
          const lines = Object.entries(st)
            .map(([k, v]) => `${k}: ${typeof v === "number" ? (v as number).toFixed(2) : String(v)}`)
            .join("\n");
          addSystemMessage(`State vector:\n${lines}`);
        } else {
          addSystemMessage("State not available (runtime not initialized)");
        }
        break;
      }
      case "forget":
        if (!args) {
          addSystemMessage("Usage: /forget <nodeId>");
        } else {
          void a.deleteMemory(args).then(() => {
            showToast(`Memory ${args} deleted`);
          }).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            addSystemMessage(`Error: ${msg}`);
          });
        }
        break;
      case "clear":
        a.startNewConversation();
        setMessages([]);
        break;
      case "tools": {
        const mcpServers = a.getMcpServers();
        const serverCount = mcpServers.length;
        let toolCount = 0;
        const serverLines: string[] = [];
        for (const srv of mcpServers) {
          toolCount += srv.toolCount;
          serverLines.push(`  ${srv.name}: ${srv.toolCount} tools${srv.trusted ? " (trusted)" : ""}`);
        }
        addSystemMessage(
          `Tools: ${toolCount} from ${serverCount} MCP server${serverCount !== 1 ? "s" : ""}\n` +
          (serverLines.length > 0 ? serverLines.join("\n") : "  No MCP servers connected"),
        );
        break;
      }
      case "operator":
        showToast(a.isOperatorMode ? "Operator mode: ON" : "Operator mode: OFF");
        break;
      case "help":
        addSystemMessage(
          "Available commands:\n" +
          "/model — show current model\n" +
          "/model <name> — switch model\n" +
          "/conversations — browse past conversations\n" +
          "/new — start a new conversation\n" +
          "/memories — browse memories\n" +
          "/state — show current state vector\n" +
          "/forget <nodeId> — delete a memory\n" +
          "/clear — clear conversation\n" +
          "/tools — list registered tools\n" +
          "/operator — show operator mode status\n" +
          "/summarize — summarize current conversation\n" +
          "/sync — sync with relay\n" +
          "/export — export all data\n" +
          "/settings — open settings\n" +
          "/help — show this message",
        );
        break;
      default:
        addSystemMessage(`Unknown command: /${command}`);
    }
  }, [addSystemMessage]);

  // === Send message ===
  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || isProcessing) return;

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
      a.generateTitleInBackground();
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
      if (settings?.voiceAutoSend !== false) {
        void handleSend();
      }
      // If auto-send disabled, text stays in input for user review
    }
    prevMicStateRef.current = micState;
  }, [micState, inputText, handleSend, settings?.voiceAutoSend]);

  // === Stream consumer ===
  const consumeStream = useCallback(async (stream: AsyncGenerator<StreamChunk>) => {
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
              m.id === assistantId ? { ...m, content: stripPartialActionTag(assistantContent) } : m,
            ),
          );
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
          m.id === assistantId
            ? { ...m, content: finalText, timestamp: Date.now() }
            : m,
        ),
      );

      // TTS — speak the response if voice is active and response is enabled
      const voiceActive = micState !== "off";
      const responseEnabled = settings?.voiceResponseEnabled !== false;
      if (voiceActive && responseEnabled && settings?.voiceEnabled === true && ttsRef.current != null && (finalText != null && finalText !== "")) {
        setMicState("speaking");
        // Stop ambient monitor during TTS (avoid feedback)
        if (audioMonitorRef.current?.isRunning === true) {
          void audioMonitorRef.current.stop();
        }

        // Start TTS pulse — synthesized wave so creature breathes during speech
        const startTime = Date.now();
        ttsPulseRef.current = setInterval(() => {
          const elapsed = (Date.now() - startTime) / 1000;
          const base = 0.06;
          const wave = Math.sin(elapsed * 4.5) * 0.04;
          const rms = base + wave;
          app.current.setAudioReactivity({
            rms,
            low: base * 0.8 + wave * 0.5,
            mid: base * 1.2 + wave,
            high: base * 0.4 + Math.sin(elapsed * 11.3) * 0.03,
          });
          setAudioLevel(rms);
        }, 33);

        try {
          await ttsRef.current.speak(finalText);
        } catch {
          // Non-fatal — TTS failure should not block the UI
        } finally {
          // Stop TTS pulse
          if (ttsPulseRef.current != null) {
            clearInterval(ttsPulseRef.current);
            ttsPulseRef.current = null;
          }
          app.current.setAudioReactivity(null);
          setAudioLevel(0);
          // Return to ambient — creature keeps listening
          setMicState("ambient");
        }
      }
    }
  }, [settings?.voiceEnabled, micState]);

  // === Approval handler ===
  const handleApproval = useCallback(async (messageId: string, approved: boolean) => {
    // Mark card as resolved
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId ? { ...m, approvalResolved: true } : m,
      ),
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
        await consumeStream(a.resumeAfterApproval(approved));
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        addSystemMessage(`[Error: ${errMsg}]`);
      } finally {
        setIsProcessing(false);
        pendingApprovalRef.current = null;
      }
    }
  }, [consumeStream]);

  // === Settings save ===
  const handleSettingsSave = useCallback(async (newSettings: MobileSettings, aiConfig?: MobileAIConfig) => {
    const a = app.current;
    // Capture operator mode before potential re-init (initAI creates new runtime)
    const wasOperatorMode = a.isOperatorMode;

    await a.saveSettings(newSettings);
    setSettings(newSettings);

    if (aiConfig) {
      const ok = await a.initAI(aiConfig);
      if (!ok) {
        showBanner("Failed to initialize AI — check API key", "Settings", () => setShowSettings(true));
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
          budget: { maxCallsPerTurn: newSettings.budgetMaxCalls },
        });
      }
      a.updateMemoryGovernance({
        persistenceThreshold: newSettings.persistenceThreshold,
        rejectSecrets: newSettings.rejectSecrets,
        maxMemoriesPerTurn: newSettings.maxMemoriesPerTurn,
      });
      if (newSettings.colorPreset === "custom") {
        a.setInteriorColorDirect(deriveInteriorColor(newSettings.customHue, newSettings.customSaturation));
      } else {
        a.setInteriorColor(newSettings.colorPreset);
      }
    }

    // Re-init voice providers (user may have added/changed OpenAI key or TTS voice)
    sttRef.current = null;
    await initVoice({ ttsVoice: newSettings.ttsVoice });

    setShowSettings(false);
  }, [subscribeToState, addSystemMessage, initVoice]);

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

  const handlePinSubmit = useCallback(async (pin: string) => {
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
  }, [pinMode]);

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
            if (status.status === "approved" && (status.device_id != null && status.device_id !== "") && (status.motebit_id != null && status.motebit_id !== "")) {
              stopPairingPoll();
              await a.completePairing({
                motebitId: status.motebit_id,
                deviceId: status.device_id,
                deviceToken: status.device_token ?? "",
              }, syncUrl);
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
  }, [pairingCodeInput, pairingSyncUrlInput, settings, initializeAI, subscribeToState, stopPairingPoll, closePairingDialog, addSystemMessage]);

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
  if (!initialized && !showWelcome) {
    return (
      <ThemeContext.Provider value={themeColors}>
        <View style={ds.container}>
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
      {/* 3D Rendering — touch responder for orbit controls */}
      <View
        style={ds.glContainer}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={handleGLResponderGrant}
        onResponderMove={handleGLResponderMove}
        onResponderRelease={handleGLResponderRelease}
      >
        {/* eslint-disable-next-line @typescript-eslint/no-misused-promises */}
        <GLView style={ds.glView} onContextCreate={onGLContextCreate} />
        {state && (
          <View style={ds.stateOverlay}>
            <Text style={ds.stateText}>
              attn {state.attention.toFixed(2)} · conf {state.confidence.toFixed(2)} · val {state.affect_valence.toFixed(2)}
              {app.current.governanceStatus.governed ? " · gov" : ""}
              {micState !== "off" ? ` · ${micState}` : ""}
            </Text>
          </View>
        )}
        {/* Top-left buttons: conversations + memories */}
        <View style={ds.topLeftButtons}>
          <TouchableOpacity
            style={ds.overlayButton}
            onPress={() => setShowConversationPanel(true)}
            activeOpacity={0.7}
          >
            <Text style={ds.overlayButtonText}>{"\u2630"}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={ds.overlayButton}
            onPress={() => setShowMemoryPanel(true)}
            activeOpacity={0.7}
          >
            <Text style={ds.overlayButtonText}>{"\u25CF"}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={ds.overlayButton}
            onPress={() => setShowGoalsPanel(true)}
            activeOpacity={0.7}
          >
            <Text style={ds.overlayButtonText}>{"\u25C9"}</Text>
          </TouchableOpacity>
        </View>
        {/* Settings gear */}
        <TouchableOpacity
          style={ds.gearButton}
          onPress={() => setShowSettings(true)}
          activeOpacity={0.7}
        >
          <Text style={ds.gearText}>⚙</Text>
        </TouchableOpacity>
      </View>

      {/* Sync status indicator */}
      {syncStatus !== "offline" && (
        <View style={ds.syncIndicator}>
          <View style={[
            ds.syncDot,
            syncStatus === "idle" && ds.syncDotIdle,
            syncStatus === "syncing" && ds.syncDotSyncing,
            syncStatus === "error" && ds.syncDotError,
          ]} />
          <Text style={ds.syncIndicatorText}>
            {syncStatus === "syncing" ? "Syncing..." :
             syncStatus === "error" ? "Sync error" :
             lastSyncTime > 0 ? `Synced ${formatSyncTime(lastSyncTime)}` : "Connected"}
          </Text>
        </View>
      )}

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
            <AnimatedBubble style={[ds.messageBubble, item.role === "user" ? ds.userBubble : ds.assistantBubble]}>
              <Text style={[ds.messageText, item.role === "user" ? ds.userText : ds.assistantText]}>
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
      {currentModel ? (
        <Text style={ds.modelIndicator}>{currentModel}</Text>
      ) : null}

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
              <Text style={ds.micButtonText}>
                {micState === "off" ? "\u{1F399}" :
                 micState === "ambient" ? "\u{1F399}" :
                 micState === "voice" ? "\u25A0" :
                 micState === "speaking" ? "\u23F9" :
                 "\u{1F399}"}
              </Text>
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
      <WelcomeOverlay
        visible={showWelcome}
        onAccept={() => void handleWelcomeAccept()}
        onLinkExisting={handleWelcomeLinkExisting}
      />

      {settings && (
        <SettingsModal
          visible={showSettings}
          app={app.current}
          settings={settings}
          syncStatus={syncStatus}
          lastSyncTime={lastSyncTime}
          mcpServers={mcpServers}
          onAddMcpServer={handleAddMcpServer}
          onRemoveMcpServer={handleRemoveMcpServer}
          onToggleMcpTrust={handleToggleMcpTrust}
          onSave={(s, ai) => void handleSettingsSave(s, ai)}
          onClose={() => setShowSettings(false)}
          customHue={settings.customHue}
          customSaturation={settings.customSaturation}
          onRequestPin={(mode) => void handleRequestPin(mode)}
          onLinkDevice={() => void handleInitiatePairing()}
          onSyncNow={() => {
            void app.current.syncNow().then((result) => {
              addSystemMessage(
                `Sync: ${result.events_pushed} events pushed, ${result.events_pulled} pulled, ` +
                `${result.conversations_pushed} convs pushed, ${result.conversations_pulled} pulled`,
              );
            }).catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              addSystemMessage(`Sync failed: ${msg}`);
            });
          }}
          onDisconnectSync={() => {
            void app.current.disconnectSync().then(() => {
              setSyncStatus("offline");
              addSystemMessage("Disconnected from sync relay");
            });
          }}
        />
      )}

      <PinDialog
        visible={showPin}
        mode={pinMode}
        onSubmit={handlePinSubmit}
        onCancel={() => { setShowPin(false); setPinError(""); }}
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

      {/* Pairing Modal */}
      <Modal visible={showPairing} animationType="fade" transparent statusBarTranslucent>
        <View style={ds.pairingBackdrop}>
          <View style={ds.pairingCard}>
            <Text style={ds.pairingTitle}>
              {pairingMode === "initiate" ? "Link Another Device" : "Link Existing Motebit"}
            </Text>

            {/* Sync URL input — shown before code generation (initiate) or submission (claim) */}
            {((pairingMode === "initiate" && (pairingCode == null || pairingCode === "")) || (pairingMode === "claim" && (pairingId == null || pairingId === ""))) && (
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

            {pairingMode === "initiate" && (pairingCode != null && pairingCode !== "") ? (
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
      height: 240,
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
    overlayButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: c.overlayButtonBg,
      justifyContent: "center",
      alignItems: "center",
    },
    overlayButtonText: {
      fontSize: 16,
      color: c.textMuted,
    },
    gearButton: {
      position: "absolute",
      top: Platform.OS === "ios" ? 50 : 12,
      right: 12,
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: c.overlayButtonBg,
      justifyContent: "center",
      alignItems: "center",
    },
    gearText: {
      fontSize: 18,
      color: c.textMuted,
    },

    // Sync indicator
    syncIndicator: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: 4,
      gap: 6,
      backgroundColor: c.bgGlass,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderPrimary,
    },
    syncDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
    },
    syncDotIdle: {
      backgroundColor: c.statusSuccess,
    },
    syncDotSyncing: {
      backgroundColor: c.accent,
    },
    syncDotError: {
      backgroundColor: c.statusError,
    },
    syncIndicatorText: {
      color: c.textMuted,
      fontSize: 11,
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
