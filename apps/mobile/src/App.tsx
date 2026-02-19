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

import React, { useCallback, useEffect, useRef, useState } from "react";
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
  Alert,
} from "react-native";
import { GLView } from "expo-gl";
import type { ExpoWebGLRenderingContext } from "expo-gl";
import * as SecureStore from "expo-secure-store";
import type { MotebitState, BehaviorCues } from "@motebit/sdk";
import type { StreamChunk } from "@motebit/runtime";
import { stripTags } from "@motebit/ai-core";
import { MobileApp, APPROVAL_PRESET_CONFIGS } from "./mobile-app";
import type { MobileSettings, MobileAIConfig } from "./mobile-app";
import { WelcomeOverlay } from "./components/WelcomeOverlay";
import { ApprovalCard } from "./components/ApprovalCard";
import { PinDialog } from "./components/PinDialog";
import type { PinMode } from "./components/PinDialog";
import { SettingsModal } from "./components/SettingsModal";

// === Types ===

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "approval";
  content: string;
  timestamp: number;
  // Approval-specific fields
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  approvalResolved?: boolean;
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
  const [_cues, setCues] = useState<BehaviorCues | null>(null);
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

  // Pairing state
  const [showPairing, setShowPairing] = useState(false);
  const [pairingMode, setPairingMode] = useState<"initiate" | "claim">("claim");
  const [pairingCode, setPairingCode] = useState("");
  const [pairingCodeInput, setPairingCodeInput] = useState("");
  const [pairingStatus, setPairingStatusText] = useState("");
  const [pairingId, setPairingId] = useState<string | null>(null);
  const [pairingClaimName, setPairingClaimName] = useState("");
  const pairingPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Track pending approval for streaming resume
  const pendingApprovalRef = useRef<string | null>(null);

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

      // 5. Start runtime
      a.start();
      subscribeToState(a);
      setInitialized(true);
    })();

    return () => {
      cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  const initializeAI = useCallback(async (a: MobileApp, s: MobileSettings) => {
    const apiKey = s.provider === "anthropic"
      ? (await SecureStore.getItemAsync("motebit_anthropic_api_key")) || undefined
      : undefined;

    a.initAI({ provider: s.provider, model: s.model, apiKey });

    // Apply governance
    const preset = APPROVAL_PRESET_CONFIGS[s.approvalPreset];
    if (preset) {
      a.updatePolicyConfig({
        requireApprovalAbove: preset.requireApprovalAbove,
        denyAbove: preset.denyAbove,
      });
    }
    a.updateMemoryGovernance({
      persistenceThreshold: s.persistenceThreshold,
      rejectSecrets: s.rejectSecrets,
      maxMemoriesPerTurn: s.maxMemoriesPerTurn,
    });

    // Apply color preset
    a.setInteriorColor(s.colorPreset);
  }, []);

  const subscribeToState = useCallback((a: MobileApp) => {
    a.subscribe((s) => {
      setState(s);
      setCues(a.getCues());
    });
  }, []);

  // === Welcome acceptance ===
  const handleWelcomeAccept = useCallback(async () => {
    setShowWelcome(false);
    const a = app.current;

    // Create new identity (keypair was already generated in bootstrap)
    await a.createNewIdentity();

    const s = settings || (await a.loadSettings());
    await initializeAI(a, s);
    a.start();
    subscribeToState(a);
    setInitialized(true);
  }, [settings, initializeAI, subscribeToState]);

  // === Welcome link existing ===
  const handleWelcomeLinkExisting = useCallback(() => {
    setShowWelcome(false);
    setPairingMode("claim");
    setPairingCodeInput("");
    setPairingStatusText("Enter the code from your other device");
    setShowPairing(true);
  }, []);

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

  // === Send message ===
  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    if (!text || isProcessing) return;

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
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      addSystemMessage(`[Error: ${errMsg}]`);
    } finally {
      setIsProcessing(false);
    }
  }, [inputText, isProcessing]);

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
              m.id === assistantId ? { ...m, content: stripTags(assistantContent) } : m,
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

    // Ensure final content is set
    if (assistantContent) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? { ...m, content: stripTags(assistantContent), timestamp: Date.now() }
            : m,
        ),
      );
    }
  }, []);

  // === Approval handler ===
  const handleApproval = useCallback(async (messageId: string, approved: boolean) => {
    // Mark card as resolved
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId ? { ...m, approvalResolved: true } : m,
      ),
    );

    const a = app.current;
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
  }, [consumeStream]);

  // === System messages ===
  const addSystemMessage = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "system", content, timestamp: Date.now() },
    ]);
  }, []);

  // === Settings save ===
  const handleSettingsSave = useCallback(async (newSettings: MobileSettings, aiConfig?: MobileAIConfig) => {
    const a = app.current;
    await a.saveSettings(newSettings);
    setSettings(newSettings);

    if (aiConfig) {
      const ok = a.initAI(aiConfig);
      if (!ok) {
        addSystemMessage("Failed to initialize AI — check API key");
      } else {
        a.start();
        subscribeToState(a);
      }
    }

    setShowSettings(false);
  }, [subscribeToState, addSystemMessage]);

  // === PIN handler ===
  const handlePinSubmit = useCallback(async (pin: string) => {
    const a = app.current;
    if (pinMode === "setup" || pinMode === "reset") {
      await a.setupOperatorPin(pin);
      const result = await a.setOperatorMode(true, pin);
      if (!result.success) {
        setPinError(result.error || "Failed");
        return;
      }
    } else {
      const result = await a.setOperatorMode(!a.isOperatorMode, pin);
      if (!result.success) {
        setPinError(result.error || "Incorrect PIN");
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
  }, [stopPairingPoll]);

  // Device A: initiate from settings
  const handleInitiatePairing = useCallback(async () => {
    const a = app.current;
    // TODO: pre-fill with (await a.loadSettings()).provider once settings UI exists
    // For now, prompt for sync URL
    Alert.prompt?.(
      "Sync Relay URL",
      "Enter your sync relay URL",
      async (url: string) => {
        if (!url) return;
        setPairingMode("initiate");
        setPairingStatusText("Generating code...");
        setShowSettings(false);
        setShowPairing(true);
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
                  setPairingClaimName(session.claiming_device_name || "Unknown device");
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
      },
    ) ?? Alert.alert("Not supported", "Pairing initiation requires Alert.prompt (iOS)");
  }, [stopPairingPoll]);

  // Device B: submit claim code
  const handlePairingClaimSubmit = useCallback(async () => {
    const code = pairingCodeInput.trim().toUpperCase();
    if (code.length !== 6) {
      setPairingStatusText("Code must be 6 characters");
      return;
    }

    const a = app.current;

    // Need sync URL
    const syncUrl = await new Promise<string>((resolve) => {
      Alert.prompt?.(
        "Sync Relay URL",
        "Enter the sync relay URL",
        (url: string) => resolve(url || ""),
      ) ?? resolve("");
    });

    if (!syncUrl) {
      setPairingStatusText("Sync relay URL required for pairing");
      return;
    }

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
            if (status.status === "approved" && status.device_id && status.motebit_id) {
              stopPairingPoll();
              await a.completePairing({
                motebitId: status.motebit_id,
                deviceId: status.device_id,
                deviceToken: status.device_token || "",
              });
              closePairingDialog();
              addSystemMessage("Linked to existing motebit");

              // Initialize AI and start
              const s = settings || (await a.loadSettings());
              await initializeAI(a, s);
              a.start();
              subscribeToState(a);
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
  }, [pairingCodeInput, settings, initializeAI, subscribeToState, stopPairingPoll, closePairingDialog, addSystemMessage]);

  // Device A: approve
  const handlePairingApprove = useCallback(async () => {
    if (!pairingId) return;
    const a = app.current;

    // Need sync URL — same issue
    const syncUrl = ""; // Would need to be stored from initiation
    setPairingStatusText("Approving...");
    try {
      // TODO: store syncUrl from initiation
      const result = await a.approvePairing(syncUrl, pairingId);
      closePairingDialog();
      addSystemMessage(`Device linked (${result.deviceId.slice(0, 8)}...)`);
    } catch (err: unknown) {
      setPairingStatusText(err instanceof Error ? err.message : String(err));
    }
  }, [pairingId, closePairingDialog, addSystemMessage]);

  // Device A: deny
  const handlePairingDeny = useCallback(async () => {
    if (!pairingId) return;
    const a = app.current;
    const syncUrl = "";
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

  // === Loading state ===
  if (!initialized && !showWelcome) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color="#607080" />
        <Text style={styles.loadingText}>Initializing Motebit...</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 20}
    >
      {/* 3D Rendering */}
      <View style={styles.glContainer}>
        <GLView style={styles.glView} onContextCreate={onGLContextCreate} />
        {state && (
          <View style={styles.stateOverlay}>
            <Text style={styles.stateText}>
              attn {state.attention.toFixed(2)} · conf {state.confidence.toFixed(2)} · val {state.affect_valence.toFixed(2)}
            </Text>
          </View>
        )}
        {/* Settings gear */}
        <TouchableOpacity
          style={styles.gearButton}
          onPress={() => setShowSettings(true)}
          activeOpacity={0.7}
        >
          <Text style={styles.gearText}>⚙</Text>
        </TouchableOpacity>
      </View>

      {/* Chat Messages */}
      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={(item) => item.id}
        style={styles.chatList}
        contentContainerStyle={styles.chatContent}
        renderItem={({ item }) => {
          if (item.role === "approval") {
            return (
              <ApprovalCard
                toolName={item.toolName || "unknown"}
                args={item.toolArgs || {}}
                onAllow={() => void handleApproval(item.id, true)}
                onDeny={() => void handleApproval(item.id, false)}
                disabled={item.approvalResolved}
              />
            );
          }
          if (item.role === "system") {
            return (
              <View style={styles.systemBubble}>
                <Text style={styles.systemText}>{item.content}</Text>
              </View>
            );
          }
          return (
            <View style={[styles.messageBubble, item.role === "user" ? styles.userBubble : styles.assistantBubble]}>
              <Text style={[styles.messageText, item.role === "user" ? styles.userText : styles.assistantText]}>
                {item.content}
              </Text>
            </View>
          );
        }}
      />

      {/* Input Bar */}
      <View style={styles.inputBar}>
        <TextInput
          style={styles.textInput}
          value={inputText}
          onChangeText={setInputText}
          placeholder="Talk to your motebit..."
          placeholderTextColor="#405060"
          returnKeyType="send"
          onSubmitEditing={() => void handleSend()}
          editable={!isProcessing}
        />
        <TouchableOpacity
          style={[styles.sendButton, isProcessing && styles.sendButtonDisabled]}
          onPress={() => void handleSend()}
          disabled={isProcessing}
        >
          {isProcessing ? (
            <ActivityIndicator size="small" color="#0a0a0a" />
          ) : (
            <Text style={styles.sendButtonText}>↑</Text>
          )}
        </TouchableOpacity>
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
          onSave={(s, ai) => void handleSettingsSave(s, ai)}
          onClose={() => setShowSettings(false)}
          onRequestPin={(mode) => {
            setPinMode(mode);
            setShowPin(true);
          }}
          onLinkDevice={() => void handleInitiatePairing()}
        />
      )}

      <PinDialog
        visible={showPin}
        mode={pinMode}
        onSubmit={handlePinSubmit}
        onCancel={() => { setShowPin(false); setPinError(""); }}
        error={pinError}
      />

      {/* Pairing Modal */}
      <Modal visible={showPairing} animationType="fade" transparent statusBarTranslucent>
        <View style={styles.pairingBackdrop}>
          <View style={styles.pairingCard}>
            <Text style={styles.pairingTitle}>
              {pairingMode === "initiate" ? "Link Another Device" : "Link Existing Motebit"}
            </Text>

            {pairingMode === "initiate" && pairingCode ? (
              <Text style={styles.pairingCodeDisplay}>{pairingCode}</Text>
            ) : null}

            {pairingMode === "claim" && !pairingId && (
              <TextInput
                style={styles.pairingInput}
                value={pairingCodeInput}
                onChangeText={(t) => setPairingCodeInput(t.toUpperCase().slice(0, 6))}
                placeholder="Enter code"
                placeholderTextColor="#405060"
                maxLength={6}
                autoCapitalize="characters"
                autoCorrect={false}
              />
            )}

            {pairingClaimName ? (
              <View style={styles.pairingClaimInfo}>
                <Text style={styles.pairingClaimText}>"{pairingClaimName}" wants to join</Text>
              </View>
            ) : null}

            <Text style={styles.pairingStatusText}>{pairingStatus}</Text>

            <View style={styles.pairingActions}>
              {pairingMode === "claim" && !pairingId && (
                <TouchableOpacity
                  style={styles.pairingSubmitBtn}
                  onPress={() => void handlePairingClaimSubmit()}
                  activeOpacity={0.7}
                >
                  <Text style={styles.pairingSubmitText}>Submit</Text>
                </TouchableOpacity>
              )}
              {pairingMode === "initiate" && pairingClaimName ? (
                <>
                  <TouchableOpacity
                    style={styles.pairingDenyBtn}
                    onPress={() => void handlePairingDeny()}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.pairingDenyText}>Deny</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.pairingApproveBtn}
                    onPress={() => void handlePairingApprove()}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.pairingApproveText}>Approve</Text>
                  </TouchableOpacity>
                </>
              ) : null}
              <TouchableOpacity
                style={styles.pairingCancelBtn}
                onPress={closePairingDialog}
                activeOpacity={0.7}
              >
                <Text style={styles.pairingCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

// === Styles ===

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0a0a0a",
  },
  loadingText: {
    color: "#607080",
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
    color: "#405060",
    fontSize: 10,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  gearButton: {
    position: "absolute",
    top: Platform.OS === "ios" ? 50 : 12,
    right: 12,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(15, 24, 32, 0.7)",
    justifyContent: "center",
    alignItems: "center",
  },
  gearText: {
    fontSize: 18,
    color: "#607080",
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
    backgroundColor: "#1a2a3a",
  },
  assistantBubble: {
    alignSelf: "flex-start",
    backgroundColor: "#0f1820",
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
    color: "#c0d0e0",
  },
  assistantText: {
    color: "#8098b0",
  },
  systemText: {
    color: "#405060",
    fontSize: 12,
    fontStyle: "italic",
    textAlign: "center",
  },

  // Input
  inputBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    paddingBottom: Platform.OS === "ios" ? 28 : 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#1a2030",
    backgroundColor: "#0a0a0a",
  },
  textInput: {
    flex: 1,
    height: 40,
    borderRadius: 20,
    paddingHorizontal: 16,
    backgroundColor: "#0f1820",
    color: "#c0d0e0",
    fontSize: 15,
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#2a4060",
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 8,
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
  sendButtonText: {
    color: "#c0d0e0",
    fontSize: 18,
    fontWeight: "600",
  },

  // Pairing
  pairingBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.85)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 32,
  },
  pairingCard: {
    backgroundColor: "#0f1820",
    borderRadius: 20,
    padding: 24,
    width: "100%",
    maxWidth: 320,
    alignItems: "center",
    gap: 14,
  },
  pairingTitle: {
    color: "#c0d0e0",
    fontSize: 17,
    fontWeight: "600",
  },
  pairingCodeDisplay: {
    color: "#4080c0",
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: 6,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    paddingVertical: 8,
  },
  pairingInput: {
    width: "100%",
    backgroundColor: "#0a1018",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: "#c0d0e0",
    fontSize: 20,
    letterSpacing: 6,
    textAlign: "center",
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  pairingClaimInfo: {
    backgroundColor: "rgba(64, 128, 192, 0.1)",
    borderRadius: 8,
    padding: 12,
    width: "100%",
  },
  pairingClaimText: {
    color: "#8098b0",
    fontSize: 14,
    textAlign: "center",
  },
  pairingStatusText: {
    color: "#506070",
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
    backgroundColor: "#2a4060",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  pairingSubmitText: { color: "#c0d0e0", fontSize: 15, fontWeight: "600" },
  pairingApproveBtn: {
    flex: 1,
    backgroundColor: "#2a4060",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  pairingApproveText: { color: "#c0d0e0", fontSize: 15, fontWeight: "600" },
  pairingDenyBtn: {
    flex: 1,
    backgroundColor: "#1a2030",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  pairingDenyText: { color: "#607080", fontSize: 15, fontWeight: "600" },
  pairingCancelBtn: {
    flex: 1,
    backgroundColor: "#1a2030",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  pairingCancelText: { color: "#607080", fontSize: 15 },
});
