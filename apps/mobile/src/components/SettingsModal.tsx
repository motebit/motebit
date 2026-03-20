import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Switch,
  StyleSheet,
  Platform,
  Alert,
  Clipboard,
  Linking,
  Appearance,
} from "react-native";
import * as SecureStore from "expo-secure-store";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system";
import type { MobileApp, MobileSettings, MobileAIConfig } from "../mobile-app";
import type { InteriorColor } from "@motebit/runtime";
import { COLOR_PRESETS, APPROVAL_PRESET_CONFIGS } from "../mobile-app";
import { useTheme, type ThemeColors } from "../theme";
import type { Goal, GoalMode } from "../adapters/expo-sqlite";
import { hexPublicKeyToDidKey } from "@motebit/crypto";

// === Pure Color Math (copied from desktop color-picker.ts) ===

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  return [r + m, g + m, b + m];
}

export function deriveInteriorColor(hue: number, saturation: number): InteriorColor {
  const tintL = 0.92 - saturation * 0.12;
  const tintS = saturation * 0.9;
  const tint = hslToRgb(hue, tintS, tintL);

  const glowL = 0.72 - saturation * 0.17;
  const glowS = saturation * 0.8 + 0.2;
  const glow = hslToRgb(hue, glowS, glowL);

  return { tint, glow };
}

type Tab = "appearance" | "intelligence" | "governance" | "goals" | "sync" | "tools" | "identity";

const TABS: { key: Tab; label: string }[] = [
  { key: "appearance", label: "Appearance" },
  { key: "intelligence", label: "Intelligence" },
  { key: "governance", label: "Governance" },
  { key: "goals", label: "Goals" },
  { key: "sync", label: "Sync" },
  { key: "tools", label: "Tools" },
  { key: "identity", label: "Identity" },
];

const INTERVAL_OPTIONS: { label: string; ms: number }[] = [
  { label: "Hourly", ms: 3_600_000 },
  { label: "Daily", ms: 86_400_000 },
  { label: "Weekly", ms: 604_800_000 },
];

function formatInterval(ms: number): string {
  if (ms <= 3_600_000) return "Hourly";
  if (ms <= 86_400_000) return "Daily";
  if (ms <= 604_800_000) return "Weekly";
  return `${Math.round(ms / 86_400_000)}d`;
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// Hex colors for preview circles (same 7 as desktop, moonlight first)
const PRESET_COLORS: Record<string, string> = {
  moonlight: "#f0f0ff",
  amber: "#ffda99",
  rose: "#ffd0e0",
  violet: "#d0b8ff",
  cyan: "#b8f0ff",
  ember: "#ffb8a0",
  sage: "#c0f0c8",
};

interface SettingsModalProps {
  visible: boolean;
  app: MobileApp;
  settings: MobileSettings;
  syncStatus?: "idle" | "syncing" | "error" | "offline";
  lastSyncTime?: number;
  mcpServers?: Array<{
    name: string;
    url: string;
    connected: boolean;
    toolCount: number;
    trusted: boolean;
    motebit: boolean;
    motebitPublicKey?: string;
  }>;
  onAddMcpServer?: (
    url: string,
    name: string,
    trusted?: boolean,
    motebit?: boolean,
  ) => Promise<void>;
  onRemoveMcpServer?: (name: string) => Promise<void>;
  onToggleMcpTrust?: (name: string, trusted: boolean) => Promise<void>;
  onSave: (settings: MobileSettings, aiConfig?: MobileAIConfig) => void;
  onClose: () => void;
  onRequestPin: (mode: "setup" | "verify" | "reset") => void;
  onLinkDevice?: () => void;
  onSyncNow?: () => void;
  onDisconnectSync?: () => void;
  customHue?: number;
  customSaturation?: number;
  onCustomColorChange?: (hue: number, saturation: number) => void;
}

export function SettingsModal({
  visible,
  app,
  settings,
  syncStatus,
  lastSyncTime,
  mcpServers,
  onAddMcpServer,
  onRemoveMcpServer,
  onToggleMcpTrust,
  onSave,
  onClose,
  onRequestPin,
  onLinkDevice,
  onSyncNow,
  onDisconnectSync,
  onCustomColorChange,
}: SettingsModalProps): React.ReactElement {
  const colors = useTheme();
  const styles = useMemo(() => createSettingsStyles(colors), [colors]);
  const [tab, setTab] = useState<Tab>("appearance");
  const [draft, setDraft] = useState<MobileSettings>(settings);
  const [apiKey, setApiKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");

  // Sync draft when settings change or modal opens
  useEffect(() => {
    setDraft(settings);
    // Load stored API keys
    if (settings.provider === "openai") {
      void SecureStore.getItemAsync("motebit_openai_provider_key").then((k) => {
        if (k != null && k !== "") setApiKey(k);
      });
    } else {
      void SecureStore.getItemAsync("motebit_anthropic_api_key").then((k) => {
        if (k != null && k !== "") setApiKey(k);
      });
    }
    void SecureStore.getItemAsync("motebit_openai_api_key").then((k) => {
      if (k != null && k !== "") setOpenaiKey(k);
    });
  }, [settings, visible]);

  const updateDraft = useCallback((patch: Partial<MobileSettings>) => {
    setDraft((d) => ({ ...d, ...patch }));
  }, []);

  const handleSave = useCallback(async () => {
    // Store API keys securely (not in AsyncStorage)
    if ((draft.provider === "anthropic" || draft.provider === "hybrid") && apiKey) {
      await SecureStore.setItemAsync("motebit_anthropic_api_key", apiKey);
    }
    if (draft.provider === "openai" && apiKey) {
      await SecureStore.setItemAsync("motebit_openai_provider_key", apiKey);
    }
    if (openaiKey) {
      await SecureStore.setItemAsync("motebit_openai_api_key", openaiKey);
    }

    // Apply governance settings to runtime (include current operator mode to preserve it)
    app.updatePolicyConfig({
      requireApprovalAbove: APPROVAL_PRESET_CONFIGS[draft.approvalPreset]?.requireApprovalAbove,
      denyAbove: APPROVAL_PRESET_CONFIGS[draft.approvalPreset]?.denyAbove,
      operatorMode: app.isOperatorMode,
      budget: { maxCallsPerTurn: draft.budgetMaxCalls },
    });
    app.updateMemoryGovernance({
      persistenceThreshold: draft.persistenceThreshold,
      rejectSecrets: draft.rejectSecrets,
      maxMemoriesPerTurn: draft.maxMemoriesPerTurn,
    });

    // Apply color preset
    app.setInteriorColor(draft.colorPreset);

    // Build AI config if provider, model, or endpoint changed
    let aiConfig: MobileAIConfig | undefined;
    if (
      draft.provider !== settings.provider ||
      draft.model !== settings.model ||
      draft.ollamaEndpoint !== settings.ollamaEndpoint ||
      draft.maxTokens !== settings.maxTokens
    ) {
      aiConfig = {
        provider: draft.provider,
        model: draft.model,
        apiKey:
          draft.provider === "anthropic" || draft.provider === "hybrid"
            ? apiKey
            : draft.provider === "openai"
              ? apiKey
              : undefined,
        ollamaEndpoint:
          draft.provider === "ollama" || draft.provider === "hybrid"
            ? draft.ollamaEndpoint
            : undefined,
        maxTokens: draft.maxTokens,
      };
    }

    onSave(draft, aiConfig);
  }, [draft, apiKey, openaiKey, app, settings, onSave]);

  const identity = app.getIdentityInfo();

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
            <Text style={styles.cancelBtn}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Settings</Text>
          <TouchableOpacity onPress={() => void handleSave()} activeOpacity={0.7}>
            <Text style={styles.saveBtn}>Save</Text>
          </TouchableOpacity>
        </View>

        {/* Tabs */}
        <View style={styles.tabBar}>
          {TABS.map((t) => (
            <TouchableOpacity
              key={t.key}
              style={[styles.tab, tab === t.key && styles.tabActive]}
              onPress={() => setTab(t.key)}
              activeOpacity={0.7}
            >
              <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
          {tab === "appearance" && (
            <AppearanceTab
              selected={draft.colorPreset}
              onSelect={(preset) => {
                updateDraft({ colorPreset: preset });
                // Live preview
                if (preset === "custom") {
                  const color = deriveInteriorColor(draft.customHue, draft.customSaturation);
                  app.setInteriorColorDirect(color);
                } else {
                  app.setInteriorColor(preset);
                }
              }}
              theme={draft.theme}
              onThemeChange={(t) => {
                updateDraft({ theme: t });
                // Live preview — switch 3D environment
                const effective = t === "system" ? (Appearance.getColorScheme() ?? "dark") : t;
                if (effective === "dark") {
                  app.setDarkEnvironment();
                } else {
                  app.setLightEnvironment();
                }
              }}
              customHue={draft.customHue}
              customSaturation={draft.customSaturation}
              onCustomColorChange={(hue, sat) => {
                updateDraft({ customHue: hue, customSaturation: sat });
                const color = deriveInteriorColor(hue, sat);
                app.setInteriorColorDirect(color);
                onCustomColorChange?.(hue, sat);
              }}
            />
          )}
          {tab === "intelligence" && (
            <IntelligenceTab
              provider={draft.provider}
              model={draft.model}
              apiKey={apiKey}
              ollamaEndpoint={draft.ollamaEndpoint}
              voiceEnabled={draft.voiceEnabled}
              voiceResponseEnabled={draft.voiceResponseEnabled}
              voiceAutoSend={draft.voiceAutoSend}
              ttsVoice={draft.ttsVoice}
              openaiKey={openaiKey}
              neuralVadEnabled={draft.neuralVadEnabled}
              onChangeProvider={(p) =>
                updateDraft({
                  provider: p,
                  model:
                    p === "ollama"
                      ? "llama3.2"
                      : p === "openai"
                        ? "gpt-4o"
                        : "claude-sonnet-4-20250514",
                })
              }
              onChangeModel={(m) => updateDraft({ model: m })}
              onChangeApiKey={setApiKey}
              onChangeOllamaEndpoint={(e) => updateDraft({ ollamaEndpoint: e })}
              onChangeVoiceEnabled={(v) => updateDraft({ voiceEnabled: v })}
              onChangeVoiceResponseEnabled={(v) => updateDraft({ voiceResponseEnabled: v })}
              onChangeVoiceAutoSend={(v) => updateDraft({ voiceAutoSend: v })}
              onChangeTtsVoice={(v) => updateDraft({ ttsVoice: v })}
              onChangeOpenaiKey={setOpenaiKey}
              onChangeNeuralVadEnabled={(v) => updateDraft({ neuralVadEnabled: v })}
              maxTokens={draft.maxTokens}
              onChangeMaxTokens={(v) => updateDraft({ maxTokens: v })}
            />
          )}
          {tab === "governance" && (
            <GovernanceTab
              draft={draft}
              isOperatorMode={app.isOperatorMode}
              onUpdate={updateDraft}
              onRequestPin={onRequestPin}
            />
          )}
          {tab === "goals" && <GoalsTab app={app} />}
          {tab === "sync" && (
            <SyncTab
              syncStatus={syncStatus ?? "offline"}
              lastSyncTime={lastSyncTime ?? 0}
              app={app}
              onSyncNow={onSyncNow}
              onDisconnect={onDisconnectSync}
            />
          )}
          {tab === "tools" && (
            <ToolsTab
              servers={mcpServers ?? []}
              onAdd={onAddMcpServer}
              onRemove={onRemoveMcpServer}
              onToggleTrust={onToggleMcpTrust}
            />
          )}
          {tab === "identity" && (
            <IdentityTab
              motebitId={identity.motebitId}
              deviceId={identity.deviceId}
              publicKey={identity.publicKey}
              onExport={() => {
                void (async () => {
                  try {
                    const jsonData = await app.exportAllData();
                    const canShare = await Sharing.isAvailableAsync();
                    if (canShare) {
                      const filePath = `${FileSystem.cacheDirectory}motebit-export-${Date.now()}.json`;
                      await FileSystem.writeAsStringAsync(filePath, jsonData);
                      await Sharing.shareAsync(filePath, { mimeType: "application/json" });
                    } else {
                      Clipboard.setString(jsonData);
                      Alert.alert("Exported", "Data copied to clipboard.");
                    }
                  } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    Alert.alert("Export Failed", msg);
                  }
                })();
              }}
              onLinkDevice={onLinkDevice}
              onRotateKey={() => {
                Alert.alert(
                  "Rotate Key",
                  "Generate a new keypair with a signed succession record? The old key will sign over authority to the new key.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Rotate",
                      style: "destructive",
                      onPress: () => {
                        void (async () => {
                          try {
                            const result = await app.rotateKey("manual rotation from mobile");
                            Alert.alert(
                              "Key Rotated",
                              `New public key: ${result.newPublicKey.slice(0, 16)}...`,
                            );
                          } catch (err: unknown) {
                            const msg = err instanceof Error ? err.message : String(err);
                            Alert.alert("Key Rotation Failed", msg);
                          }
                        })();
                      },
                    },
                  ],
                );
              }}
            />
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

// === Appearance Tab ===

type ThemePreference = "light" | "dark" | "system";
const THEME_OPTIONS: { key: ThemePreference; label: string }[] = [
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
  { key: "system", label: "System" },
];

function AppearanceTab({
  selected,
  onSelect,
  theme,
  onThemeChange,
  customHue,
  customSaturation,
  onCustomColorChange,
}: {
  selected: string;
  onSelect: (p: string) => void;
  theme: ThemePreference;
  onThemeChange: (t: ThemePreference) => void;
  customHue: number;
  customSaturation: number;
  onCustomColorChange: (hue: number, saturation: number) => void;
}) {
  const colors = useTheme();
  const styles = useMemo(() => createSettingsStyles(colors), [colors]);
  const presets = Object.keys(COLOR_PRESETS);

  // Preview color for custom swatch and live circle
  const customPreview = React.useMemo(() => {
    const glow = deriveInteriorColor(customHue, customSaturation).glow;
    const r = Math.round(glow[0] * 255);
    const g = Math.round(glow[1] * 255);
    const b = Math.round(glow[2] * 255);
    return `rgb(${r},${g},${b})`;
  }, [customHue, customSaturation]);

  // Slider touch handler — tracks horizontal position on a View
  const handleSliderTouch = React.useCallback(
    (
      e: { nativeEvent: { locationX: number } },
      layoutWidth: number,
      onUpdate: (fraction: number) => void,
    ) => {
      if (layoutWidth <= 0) return;
      const fraction = Math.max(0, Math.min(1, e.nativeEvent.locationX / layoutWidth));
      onUpdate(fraction);
    },
    [],
  );

  const [hueWidth, setHueWidth] = React.useState(0);
  const [satWidth, setSatWidth] = React.useState(0);

  return (
    <View>
      <Text style={styles.sectionTitle}>Theme</Text>
      <View style={styles.themeToggleGroup}>
        {THEME_OPTIONS.map((opt) => (
          <TouchableOpacity
            key={opt.key}
            style={[styles.themeOption, theme === opt.key && styles.themeOptionSelected]}
            onPress={() => onThemeChange(opt.key)}
            activeOpacity={0.7}
          >
            <Text
              style={[styles.themeOptionText, theme === opt.key && styles.themeOptionTextSelected]}
            >
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Color Preset</Text>
      <View style={styles.presetGrid}>
        {presets.map((name) => (
          <TouchableOpacity
            key={name}
            style={[
              styles.presetCircle,
              { backgroundColor: PRESET_COLORS[name] ?? "#888" },
              selected === name && styles.presetSelected,
            ]}
            onPress={() => onSelect(name)}
            activeOpacity={0.7}
          >
            {selected === name && <View style={styles.presetCheck} />}
          </TouchableOpacity>
        ))}
        {/* Custom swatch */}
        <TouchableOpacity
          style={[
            styles.presetCircle,
            { backgroundColor: customPreview },
            selected === "custom" && styles.presetSelected,
          ]}
          onPress={() => onSelect("custom")}
          activeOpacity={0.7}
        >
          {selected === "custom" && <View style={styles.presetCheck} />}
        </TouchableOpacity>
      </View>
      <Text style={styles.presetLabel}>{selected}</Text>

      {/* Custom color sliders */}
      {selected === "custom" && (
        <View style={styles.customPickerContainer}>
          {/* Live preview circle */}
          <View style={[styles.customPreviewCircle, { backgroundColor: customPreview }]} />

          {/* Hue slider */}
          <Text style={styles.customSliderLabel}>Hue</Text>
          <View
            style={styles.customSliderTrack}
            onLayout={(e) => setHueWidth(e.nativeEvent.layout.width)}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderGrant={(e) =>
              handleSliderTouch(e, hueWidth, (f) =>
                onCustomColorChange(Math.round(f * 360), customSaturation),
              )
            }
            onResponderMove={(e) =>
              handleSliderTouch(e, hueWidth, (f) =>
                onCustomColorChange(Math.round(f * 360), customSaturation),
              )
            }
          >
            {/* Hue gradient background — multiple color stops */}
            <View
              style={[
                StyleSheet.absoluteFill,
                {
                  borderRadius: 6,
                  flexDirection: "row",
                  overflow: "hidden",
                },
              ]}
            >
              {[0, 60, 120, 180, 240, 300, 360].map((h, i, arr) => {
                if (i === arr.length - 1) return null;
                return (
                  <View
                    key={h}
                    style={{
                      flex: 1,
                      backgroundColor: `hsl(${h + 30}, 85%, 60%)`,
                    }}
                  />
                );
              })}
            </View>
            {/* Thumb */}
            <View
              style={[
                styles.customSliderThumb,
                {
                  left: `${(customHue / 360) * 100}%`,
                  backgroundColor: `hsl(${customHue}, 85%, 60%)`,
                },
              ]}
            />
          </View>

          {/* Saturation slider */}
          <Text style={styles.customSliderLabel}>Saturation</Text>
          <View
            style={[
              styles.customSliderTrack,
              {
                backgroundColor: `hsl(${customHue}, 0%, 90%)`,
              },
            ]}
            onLayout={(e) => setSatWidth(e.nativeEvent.layout.width)}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderGrant={(e) =>
              handleSliderTouch(e, satWidth, (f) => onCustomColorChange(customHue, f))
            }
            onResponderMove={(e) =>
              handleSliderTouch(e, satWidth, (f) => onCustomColorChange(customHue, f))
            }
          >
            {/* Saturation gradient overlay */}
            <View
              style={[
                StyleSheet.absoluteFill,
                {
                  borderRadius: 6,
                  flexDirection: "row",
                  overflow: "hidden",
                },
              ]}
            >
              <View style={{ flex: 1, backgroundColor: `hsl(${customHue}, 0%, 90%)` }} />
              <View style={{ flex: 1, backgroundColor: `hsl(${customHue}, 50%, 75%)` }} />
              <View style={{ flex: 1, backgroundColor: `hsl(${customHue}, 100%, 60%)` }} />
            </View>
            {/* Thumb */}
            <View
              style={[
                styles.customSliderThumb,
                {
                  left: `${customSaturation * 100}%`,
                  backgroundColor: `hsl(${customHue}, ${Math.round(customSaturation * 100)}%, 70%)`,
                },
              ]}
            />
          </View>
        </View>
      )}
    </View>
  );
}

// === Intelligence Tab ===

const TTS_VOICE_OPTIONS = [
  { key: "alloy", label: "Alloy" },
  { key: "echo", label: "Echo" },
  { key: "fable", label: "Fable" },
  { key: "onyx", label: "Onyx" },
  { key: "nova", label: "Nova" },
  { key: "shimmer", label: "Shimmer" },
];

function IntelligenceTab({
  provider,
  model,
  apiKey,
  ollamaEndpoint,
  voiceEnabled,
  voiceResponseEnabled,
  voiceAutoSend,
  ttsVoice,
  openaiKey,
  neuralVadEnabled,
  maxTokens,
  onChangeProvider,
  onChangeModel,
  onChangeApiKey,
  onChangeOllamaEndpoint,
  onChangeVoiceEnabled,
  onChangeVoiceResponseEnabled,
  onChangeVoiceAutoSend,
  onChangeTtsVoice,
  onChangeOpenaiKey,
  onChangeNeuralVadEnabled,
  onChangeMaxTokens,
}: {
  provider: "ollama" | "anthropic" | "openai" | "hybrid" | "proxy";
  model: string;
  apiKey: string;
  ollamaEndpoint: string;
  voiceEnabled: boolean;
  voiceResponseEnabled: boolean;
  voiceAutoSend: boolean;
  ttsVoice: string;
  openaiKey: string;
  neuralVadEnabled: boolean;
  maxTokens: number;
  onChangeProvider: (p: "ollama" | "anthropic" | "openai" | "hybrid" | "proxy") => void;
  onChangeModel: (m: string) => void;
  onChangeApiKey: (k: string) => void;
  onChangeOllamaEndpoint: (e: string) => void;
  onChangeVoiceEnabled: (v: boolean) => void;
  onChangeVoiceResponseEnabled: (v: boolean) => void;
  onChangeVoiceAutoSend: (v: boolean) => void;
  onChangeTtsVoice: (v: string) => void;
  onChangeOpenaiKey: (k: string) => void;
  onChangeNeuralVadEnabled: (v: boolean) => void;
  onChangeMaxTokens: (v: number) => void;
}) {
  const colors = useTheme();
  const styles = useMemo(() => createSettingsStyles(colors), [colors]);
  return (
    <View>
      <Text style={styles.sectionTitle}>Provider</Text>
      <View style={styles.radioGroup}>
        <TouchableOpacity
          style={[styles.radioItem, provider === "ollama" && styles.radioActive]}
          onPress={() => onChangeProvider("ollama")}
          activeOpacity={0.7}
        >
          <Text style={[styles.radioText, provider === "ollama" && styles.radioTextActive]}>
            Ollama (Local)
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.radioItem, provider === "anthropic" && styles.radioActive]}
          onPress={() => onChangeProvider("anthropic")}
          activeOpacity={0.7}
        >
          <Text style={[styles.radioText, provider === "anthropic" && styles.radioTextActive]}>
            Anthropic (Cloud)
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.radioItem, provider === "openai" && styles.radioActive]}
          onPress={() => onChangeProvider("openai")}
          activeOpacity={0.7}
        >
          <Text style={[styles.radioText, provider === "openai" && styles.radioTextActive]}>
            OpenAI (Cloud)
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.radioItem, provider === "hybrid" && styles.radioActive]}
          onPress={() => onChangeProvider("hybrid")}
          activeOpacity={0.7}
        >
          <Text style={[styles.radioText, provider === "hybrid" && styles.radioTextActive]}>
            Hybrid (Cloud + Ollama fallback)
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.radioItem, provider === "proxy" && styles.radioActive]}
          onPress={() => onChangeProvider("proxy")}
          activeOpacity={0.7}
        >
          <Text style={[styles.radioText, provider === "proxy" && styles.radioTextActive]}>
            Motebit (free)
          </Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionTitle}>Model</Text>
      <TextInput
        style={styles.textField}
        value={model}
        onChangeText={onChangeModel}
        placeholder="Model name"
        placeholderTextColor={colors.inputPlaceholder}
      />

      {(provider === "ollama" || provider === "hybrid") && (
        <>
          <Text style={styles.sectionTitle}>Ollama Endpoint</Text>
          <TextInput
            style={styles.textField}
            value={ollamaEndpoint}
            onChangeText={onChangeOllamaEndpoint}
            placeholder="http://localhost:11434"
            placeholderTextColor={colors.inputPlaceholder}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </>
      )}

      {(provider === "anthropic" || provider === "hybrid") && (
        <>
          <Text style={styles.sectionTitle}>Anthropic API Key</Text>
          <TextInput
            style={styles.textField}
            value={apiKey}
            onChangeText={onChangeApiKey}
            placeholder="sk-ant-..."
            placeholderTextColor={colors.inputPlaceholder}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
        </>
      )}

      {provider === "openai" && (
        <>
          <Text style={styles.sectionTitle}>OpenAI API Key</Text>
          <TextInput
            style={styles.textField}
            value={apiKey}
            onChangeText={onChangeApiKey}
            placeholder="sk-..."
            placeholderTextColor={colors.inputPlaceholder}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
        </>
      )}

      <Text style={styles.sectionTitle}>Response Length</Text>
      <View style={styles.radioGroup}>
        {(
          [
            { label: "Short (1k)", value: 1024 },
            { label: "Normal (4k)", value: 4096 },
            { label: "Long (8k)", value: 8192 },
            { label: "Max (16k)", value: 16384 },
          ] as const
        ).map((opt) => (
          <TouchableOpacity
            key={opt.value}
            style={[styles.radioItem, maxTokens === opt.value && styles.radioActive]}
            onPress={() => onChangeMaxTokens(opt.value)}
            activeOpacity={0.7}
          >
            <Text style={[styles.radioText, maxTokens === opt.value && styles.radioTextActive]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Voice</Text>
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>Voice mode</Text>
        <Switch
          value={voiceEnabled}
          onValueChange={onChangeVoiceEnabled}
          trackColor={{ false: colors.buttonSecondaryBg, true: colors.accentSoft }}
          thumbColor={voiceEnabled ? colors.textPrimary : colors.textMuted}
        />
      </View>
      <Text style={styles.voiceHint}>Enable mic button for voice input and spoken responses</Text>

      {voiceEnabled && (
        <>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Speak responses</Text>
            <Switch
              value={voiceResponseEnabled}
              onValueChange={onChangeVoiceResponseEnabled}
              trackColor={{ false: colors.buttonSecondaryBg, true: colors.accentSoft }}
              thumbColor={voiceResponseEnabled ? colors.textPrimary : colors.textMuted}
            />
          </View>
          <Text style={styles.voiceHint}>Read assistant replies aloud via TTS</Text>

          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Auto-send transcript</Text>
            <Switch
              value={voiceAutoSend}
              onValueChange={onChangeVoiceAutoSend}
              trackColor={{ false: colors.buttonSecondaryBg, true: colors.accentSoft }}
              thumbColor={voiceAutoSend ? colors.textPrimary : colors.textMuted}
            />
          </View>
          <Text style={styles.voiceHint}>
            Send voice transcript immediately, or drop into input for review
          </Text>

          {Platform.OS === "ios" && (
            <>
              <View style={styles.switchRow}>
                <Text style={styles.switchLabel}>Neural VAD (Silero)</Text>
                <Switch
                  value={neuralVadEnabled}
                  onValueChange={onChangeNeuralVadEnabled}
                  trackColor={{ false: colors.buttonSecondaryBg, true: colors.accentSoft }}
                  thumbColor={neuralVadEnabled ? colors.textPrimary : colors.textMuted}
                />
              </View>
              <Text style={styles.voiceHint}>
                Use Silero neural network to confirm speech before triggering. Reduces false
                triggers from ambient noise.
              </Text>
            </>
          )}

          <Text style={styles.sectionTitle}>TTS Voice</Text>
          <View style={styles.voiceGrid}>
            {TTS_VOICE_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.key}
                style={[styles.voiceChip, ttsVoice === opt.key && styles.voiceChipActive]}
                onPress={() => onChangeTtsVoice(opt.key)}
                activeOpacity={0.7}
              >
                <Text
                  style={[styles.voiceChipText, ttsVoice === opt.key && styles.voiceChipTextActive]}
                >
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.voiceHint}>
            OpenAI TTS voice (requires API key below). Falls back to system TTS.
          </Text>
        </>
      )}

      <Text style={styles.sectionTitle}>OpenAI API Key</Text>
      <TextInput
        style={styles.textField}
        value={openaiKey}
        onChangeText={onChangeOpenaiKey}
        placeholder="sk-..."
        placeholderTextColor={colors.inputPlaceholder}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Text style={styles.voiceHint}>
        Used for Whisper STT (voice input) and OpenAI TTS (spoken responses).
      </Text>
    </View>
  );
}

// === Governance Tab ===

function GovernanceTab({
  draft,
  isOperatorMode,
  onUpdate,
  onRequestPin,
}: {
  draft: MobileSettings;
  isOperatorMode: boolean;
  onUpdate: (patch: Partial<MobileSettings>) => void;
  onRequestPin: (mode: "setup" | "verify" | "reset") => void;
}) {
  const colors = useTheme();
  const styles = useMemo(() => createSettingsStyles(colors), [colors]);
  return (
    <View>
      <Text style={styles.sectionTitle}>Operator Mode</Text>
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>{isOperatorMode ? "Active" : "Inactive"}</Text>
        <TouchableOpacity
          style={styles.pinButton}
          onPress={() => onRequestPin(isOperatorMode ? "verify" : "setup")}
          activeOpacity={0.7}
        >
          <Text style={styles.pinButtonText}>{isOperatorMode ? "Disable" : "Enable"}</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionTitle}>Tool Approval</Text>
      <View style={styles.radioGroup}>
        {Object.entries(APPROVAL_PRESET_CONFIGS).map(([key, config]) => (
          <TouchableOpacity
            key={key}
            style={[styles.radioItem, draft.approvalPreset === key && styles.radioActive]}
            onPress={() => onUpdate({ approvalPreset: key })}
            activeOpacity={0.7}
          >
            <Text
              style={[styles.radioText, draft.approvalPreset === key && styles.radioTextActive]}
            >
              {config.label}
            </Text>
            <Text style={styles.radioDesc}>{config.description}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Memory</Text>
      <View style={styles.fieldRow}>
        <Text style={styles.fieldLabel}>Persistence threshold</Text>
        <TextInput
          style={styles.numberField}
          value={String(draft.persistenceThreshold)}
          onChangeText={(v) => {
            const n = parseFloat(v);
            if (!isNaN(n) && n >= 0 && n <= 1) onUpdate({ persistenceThreshold: n });
          }}
          keyboardType="decimal-pad"
          placeholderTextColor={colors.inputPlaceholder}
        />
      </View>

      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>Reject secrets</Text>
        <Switch
          value={draft.rejectSecrets}
          onValueChange={(v) => onUpdate({ rejectSecrets: v })}
          trackColor={{ false: colors.buttonSecondaryBg, true: colors.accentSoft }}
          thumbColor={draft.rejectSecrets ? colors.textPrimary : colors.textMuted}
        />
      </View>

      <View style={styles.fieldRow}>
        <Text style={styles.fieldLabel}>Max tool calls / turn</Text>
        <TextInput
          style={styles.numberField}
          value={String(draft.budgetMaxCalls)}
          onChangeText={(v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) onUpdate({ budgetMaxCalls: n });
          }}
          keyboardType="number-pad"
          placeholderTextColor={colors.inputPlaceholder}
        />
      </View>
    </View>
  );
}

// === Sync Tab ===

function SyncTab({
  syncStatus,
  lastSyncTime,
  app,
  onSyncNow,
  onDisconnect,
}: {
  syncStatus: "idle" | "syncing" | "error" | "offline";
  lastSyncTime: number;
  app: MobileApp;
  onSyncNow?: () => void;
  onDisconnect?: () => void;
}) {
  const colors = useTheme();
  const styles = useMemo(() => createSettingsStyles(colors), [colors]);
  const [syncUrl, setSyncUrl] = useState<string | null>(null);

  useEffect(() => {
    void app.getSyncUrl().then(setSyncUrl);
  }, [app]);

  const statusLabel =
    syncStatus === "idle"
      ? "Connected"
      : syncStatus === "syncing"
        ? "Syncing..."
        : syncStatus === "error"
          ? "Error"
          : "Not connected";

  const statusColor =
    syncStatus === "idle"
      ? colors.statusSuccess
      : syncStatus === "syncing"
        ? colors.accent
        : syncStatus === "error"
          ? colors.statusError
          : colors.textMuted;

  return (
    <View>
      <Text style={styles.sectionTitle}>Status</Text>
      <View style={styles.syncStatusRow}>
        <View style={[styles.syncStatusDot, { backgroundColor: statusColor }]} />
        <Text style={[styles.syncStatusLabel, { color: statusColor }]}>{statusLabel}</Text>
      </View>

      {lastSyncTime > 0 && (
        <Text style={styles.syncLastTime}>Last synced: {formatTimeAgo(lastSyncTime)}</Text>
      )}

      {syncUrl != null && syncUrl !== "" && (
        <>
          <Text style={styles.sectionTitle}>Relay</Text>
          <Text style={styles.monoValue} numberOfLines={1}>
            {syncUrl}
          </Text>
        </>
      )}

      {syncUrl != null && syncUrl !== "" && onSyncNow != null && (
        <TouchableOpacity
          style={[styles.syncActionButton, syncStatus === "syncing" && styles.syncActionDisabled]}
          onPress={onSyncNow}
          disabled={syncStatus === "syncing"}
          activeOpacity={0.7}
        >
          <Text style={styles.syncActionText}>Sync Now</Text>
        </TouchableOpacity>
      )}

      {syncUrl != null && syncUrl !== "" && onDisconnect != null && (
        <TouchableOpacity
          style={styles.syncDisconnectButton}
          onPress={() => {
            Alert.alert(
              "Disconnect Sync",
              "Stop syncing and remove relay connection? Your local data will be preserved.",
              [
                { text: "Cancel", style: "cancel" },
                { text: "Disconnect", style: "destructive", onPress: onDisconnect },
              ],
            );
          }}
          activeOpacity={0.7}
        >
          <Text style={styles.syncDisconnectText}>Disconnect from Relay</Text>
        </TouchableOpacity>
      )}

      {(syncUrl == null || syncUrl === "") && (
        <Text style={styles.syncHint}>
          Link another device from the Identity tab to set up sync, or pair from your desktop app.
        </Text>
      )}
    </View>
  );
}

// === Identity Tab ===

function IdentityTab({
  motebitId,
  deviceId,
  publicKey,
  onExport,
  onLinkDevice,
  onRotateKey,
}: {
  motebitId: string;
  deviceId: string;
  publicKey: string;
  onExport: () => void;
  onLinkDevice?: () => void;
  onRotateKey?: () => void;
}) {
  const colors = useTheme();
  const styles = useMemo(() => createSettingsStyles(colors), [colors]);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  let did = "";
  try {
    if (publicKey) did = hexPublicKeyToDidKey(publicKey);
  } catch {
    // Non-fatal
  }

  const copyToClipboard = (field: string, value: string) => {
    Clipboard.setString(value);
    setCopiedField(field);
    setTimeout(() => {
      setCopiedField((current) => (current === field ? null : current));
    }, 1500);
  };

  return (
    <View>
      <Text style={styles.sectionTitle}>Motebit ID</Text>
      <TouchableOpacity
        onPress={() => copyToClipboard("motebitId", motebitId)}
        style={styles.identityFieldRow}
      >
        <Text style={[styles.monoValue, styles.identityFieldValue]} numberOfLines={1}>
          {motebitId}
        </Text>
        <Text
          style={[
            styles.identityCopyLabel,
            copiedField === "motebitId" && styles.identityCopiedLabel,
          ]}
        >
          {copiedField === "motebitId" ? "Copied!" : "Copy"}
        </Text>
      </TouchableOpacity>

      {did ? (
        <>
          <Text style={styles.sectionTitle}>DID</Text>
          <TouchableOpacity
            onPress={() => copyToClipboard("did", did)}
            style={styles.identityFieldRow}
          >
            <Text style={[styles.monoValue, styles.identityFieldValue]} numberOfLines={2}>
              {did}
            </Text>
            <Text
              style={[
                styles.identityCopyLabel,
                copiedField === "did" && styles.identityCopiedLabel,
              ]}
            >
              {copiedField === "did" ? "Copied!" : "Copy"}
            </Text>
          </TouchableOpacity>
        </>
      ) : null}

      <Text style={styles.sectionTitle}>Device ID</Text>
      <TouchableOpacity
        onPress={() => copyToClipboard("deviceId", deviceId)}
        style={styles.identityFieldRow}
      >
        <Text style={[styles.monoValue, styles.identityFieldValue]} numberOfLines={1}>
          {deviceId}
        </Text>
        <Text
          style={[
            styles.identityCopyLabel,
            copiedField === "deviceId" && styles.identityCopiedLabel,
          ]}
        >
          {copiedField === "deviceId" ? "Copied!" : "Copy"}
        </Text>
      </TouchableOpacity>

      <Text style={styles.sectionTitle}>Public Key</Text>
      <TouchableOpacity
        onPress={() => copyToClipboard("publicKey", publicKey)}
        style={styles.identityFieldRow}
      >
        <Text style={[styles.monoValue, styles.identityFieldValue]} numberOfLines={2}>
          {publicKey || "(not generated)"}
        </Text>
        <Text
          style={[
            styles.identityCopyLabel,
            copiedField === "publicKey" && styles.identityCopiedLabel,
          ]}
        >
          {copiedField === "publicKey" ? "Copied!" : "Copy"}
        </Text>
      </TouchableOpacity>

      {onRotateKey && (
        <TouchableOpacity style={styles.rotateKeyButton} onPress={onRotateKey} activeOpacity={0.7}>
          <Text style={styles.rotateKeyText}>Rotate Key</Text>
        </TouchableOpacity>
      )}

      {onLinkDevice && (
        <TouchableOpacity
          style={styles.linkDeviceButton}
          onPress={onLinkDevice}
          activeOpacity={0.7}
        >
          <Text style={styles.linkDeviceText}>Link Another Device</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity
        style={styles.docsButton}
        onPress={() => void Linking.openURL("https://docs.motebit.com")}
        activeOpacity={0.7}
      >
        <Text style={styles.docsText}>Documentation</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.exportButton} onPress={onExport} activeOpacity={0.7}>
        <Text style={styles.exportText}>Export All Data</Text>
      </TouchableOpacity>
    </View>
  );
}

// === Goals Tab ===

function GoalsTab({ app }: { app: MobileApp }) {
  const colors = useTheme();
  const styles = useMemo(() => createSettingsStyles(colors), [colors]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [newPrompt, setNewPrompt] = useState("");
  const [newIntervalIdx, setNewIntervalIdx] = useState(0);
  const [newMode, setNewMode] = useState<GoalMode>("recurring");

  const goalStore = app.getGoalStore();
  const identity = app.getIdentityInfo();

  const refreshGoals = useCallback(() => {
    if (!goalStore) return;
    setGoals(goalStore.listGoals(identity.motebitId));
  }, [goalStore, identity.motebitId]);

  useEffect(() => {
    refreshGoals();
  }, [refreshGoals]);

  const handleAdd = useCallback(() => {
    const prompt = newPrompt.trim();
    if (!prompt || !goalStore) return;
    const interval = INTERVAL_OPTIONS[newIntervalIdx];
    if (!interval) return;
    goalStore.addGoal(identity.motebitId, prompt, interval.ms, newMode);
    setNewPrompt("");
    refreshGoals();
  }, [newPrompt, newIntervalIdx, newMode, goalStore, identity.motebitId, refreshGoals]);

  const handleToggle = useCallback(
    (goalId: string, enabled: boolean) => {
      if (!goalStore) return;
      goalStore.toggleGoal(goalId, enabled);
      refreshGoals();
    },
    [goalStore, refreshGoals],
  );

  const handleRemove = useCallback(
    (goalId: string) => {
      Alert.alert("Remove Goal", "Are you sure you want to delete this goal?", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            if (!goalStore) return;
            goalStore.removeGoal(goalId);
            refreshGoals();
          },
        },
      ]);
    },
    [goalStore, refreshGoals],
  );

  if (!goalStore) {
    return (
      <View>
        <Text style={styles.sectionTitle}>Goals</Text>
        <Text style={styles.goalEmptyText}>
          Goal store not available. Bootstrap identity first.
        </Text>
      </View>
    );
  }

  return (
    <View>
      <Text style={styles.sectionTitle}>Active Goals</Text>
      {goals.length === 0 ? (
        <Text style={styles.goalEmptyText}>No goals yet. Add one below.</Text>
      ) : (
        goals.map((goal) => (
          <View key={goal.goal_id} style={styles.goalRow}>
            <View style={styles.goalInfo}>
              <Text style={styles.goalPrompt} numberOfLines={2}>
                {goal.prompt}
              </Text>
              <View style={styles.goalMeta}>
                <Text style={styles.goalMetaText}>{formatInterval(goal.interval_ms)}</Text>
                <Text style={styles.goalMetaText}>{goal.mode}</Text>
                <Text
                  style={[
                    styles.goalMetaText,
                    goal.status === "paused" && styles.goalMetaWarning,
                    goal.status === "failed" && styles.goalMetaWarning,
                  ]}
                >
                  {goal.status}
                </Text>
                {goal.last_run_at != null ? (
                  <Text style={styles.goalMetaText}>ran {formatTimeAgo(goal.last_run_at)}</Text>
                ) : null}
                {goal.consecutive_failures > 0 ? (
                  <Text style={styles.goalMetaWarning}>
                    {goal.consecutive_failures}/{goal.max_retries} failures
                  </Text>
                ) : null}
              </View>
            </View>
            <View style={styles.goalActions}>
              <Switch
                value={goal.enabled}
                onValueChange={(v) => handleToggle(goal.goal_id, v)}
                trackColor={{ false: colors.buttonSecondaryBg, true: colors.accentSoft }}
                thumbColor={goal.enabled ? colors.textPrimary : colors.textMuted}
              />
              <TouchableOpacity
                onPress={() => handleRemove(goal.goal_id)}
                activeOpacity={0.7}
                style={styles.goalDeleteBtn}
              >
                <Text style={styles.goalDeleteText}>X</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))
      )}

      <Text style={styles.sectionTitle}>Add Goal</Text>
      <TextInput
        style={styles.textField}
        value={newPrompt}
        onChangeText={setNewPrompt}
        placeholder="What should the goal do?"
        placeholderTextColor={colors.inputPlaceholder}
        multiline
        numberOfLines={3}
      />

      <Text style={[styles.sectionTitle, { marginTop: 14 }]}>Interval</Text>
      <View style={styles.radioGroup}>
        {INTERVAL_OPTIONS.map((opt, idx) => (
          <TouchableOpacity
            key={opt.label}
            style={[styles.radioItem, newIntervalIdx === idx && styles.radioActive]}
            onPress={() => setNewIntervalIdx(idx)}
            activeOpacity={0.7}
          >
            <Text style={[styles.radioText, newIntervalIdx === idx && styles.radioTextActive]}>
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={[styles.sectionTitle, { marginTop: 14 }]}>Mode</Text>
      <View style={styles.radioGroup}>
        <TouchableOpacity
          style={[styles.radioItem, newMode === "recurring" && styles.radioActive]}
          onPress={() => setNewMode("recurring")}
          activeOpacity={0.7}
        >
          <Text style={[styles.radioText, newMode === "recurring" && styles.radioTextActive]}>
            Recurring
          </Text>
          <Text style={styles.radioDesc}>Runs on every interval</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.radioItem, newMode === "once" && styles.radioActive]}
          onPress={() => setNewMode("once")}
          activeOpacity={0.7}
        >
          <Text style={[styles.radioText, newMode === "once" && styles.radioTextActive]}>Once</Text>
          <Text style={styles.radioDesc}>Runs once, then completes</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={[styles.goalAddBtn, !newPrompt.trim() && styles.goalAddBtnDisabled]}
        onPress={handleAdd}
        disabled={!newPrompt.trim()}
        activeOpacity={0.7}
      >
        <Text style={styles.goalAddBtnText}>Add Goal</Text>
      </TouchableOpacity>
    </View>
  );
}

// === Tools Tab ===

function ToolsTab({
  servers,
  onAdd,
  onRemove,
  onToggleTrust,
}: {
  servers: Array<{
    name: string;
    url: string;
    connected: boolean;
    toolCount: number;
    trusted: boolean;
    motebit: boolean;
    motebitPublicKey?: string;
  }>;
  onAdd?: (url: string, name: string, trusted?: boolean, motebit?: boolean) => Promise<void>;
  onRemove?: (name: string) => Promise<void>;
  onToggleTrust?: (name: string, trusted: boolean) => Promise<void>;
}) {
  const colors = useTheme();
  const styles = useMemo(() => createSettingsStyles(colors), [colors]);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newTrusted, setNewTrusted] = useState(false);
  const [newMotebit, setNewMotebit] = useState(false);
  const [adding, setAdding] = useState(false);

  const handleConnect = useCallback(async () => {
    const name = newName.trim();
    const url = newUrl.trim();
    if (!name || !url || !onAdd) return;

    try {
      new URL(url);
    } catch {
      Alert.alert("Invalid URL", "Please enter a valid server URL.");
      return;
    }

    setAdding(true);
    try {
      await onAdd(url, name, newTrusted, newMotebit);
      setNewName("");
      setNewUrl("");
      setNewTrusted(false);
      setNewMotebit(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert("Connection Failed", msg);
    } finally {
      setAdding(false);
    }
  }, [newName, newUrl, onAdd]);

  const handleRemove = useCallback(
    (name: string) => {
      Alert.alert("Remove Server", `Disconnect and remove "${name}"?`, [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => void onRemove?.(name),
        },
      ]);
    },
    [onRemove],
  );

  return (
    <View>
      <Text style={styles.sectionTitle}>MCP Servers</Text>
      {servers.length === 0 ? (
        <Text style={styles.toolsEmptyText}>
          No MCP servers connected. Add an HTTP MCP server to extend your motebit's capabilities.
        </Text>
      ) : (
        servers.map((server) => (
          <View key={server.name} style={styles.toolsServerRow}>
            <View style={styles.toolsServerInfo}>
              <View style={styles.toolsServerHeader}>
                <View
                  style={[
                    styles.toolsStatusDot,
                    {
                      backgroundColor: server.connected ? colors.statusSuccess : colors.statusError,
                    },
                  ]}
                />
                <Text style={styles.toolsServerName}>{server.name}</Text>
                {server.toolCount > 0 && (
                  <View style={styles.toolsCountBadge}>
                    <Text style={styles.toolsCountText}>{server.toolCount}</Text>
                  </View>
                )}
                {server.trusted && (
                  <View style={styles.toolsTrustBadge}>
                    <Text style={styles.toolsTrustText}>trusted</Text>
                  </View>
                )}
              </View>
              <Text style={styles.toolsServerUrl} numberOfLines={1}>
                {server.url}
              </Text>
              <View style={styles.toolsTrustRow}>
                <Text style={styles.toolsTrustLabel}>Auto-approve tools</Text>
                <Switch
                  value={server.trusted}
                  onValueChange={(v) => void onToggleTrust?.(server.name, v)}
                  trackColor={{ false: colors.buttonSecondaryBg, true: colors.accentSoft }}
                  thumbColor={server.trusted ? colors.textPrimary : colors.textMuted}
                />
              </View>
              {server.motebit && (
                <View style={styles.toolsTrustRow}>
                  <Text style={styles.toolsTrustLabel}>Motebit</Text>
                  <Text style={[styles.toolsTrustLabel, { opacity: 0.7 }]}>Yes</Text>
                </View>
              )}
              {server.motebit && server.motebitPublicKey ? (
                <View style={styles.toolsTrustRow}>
                  <Text style={styles.toolsTrustLabel}>Pinned Public Key</Text>
                  <Text style={[styles.toolsTrustLabel, { opacity: 0.7 }]} numberOfLines={1}>
                    {server.motebitPublicKey.slice(0, 16)}...
                  </Text>
                </View>
              ) : null}
            </View>
            <TouchableOpacity
              onPress={() => handleRemove(server.name)}
              activeOpacity={0.7}
              style={styles.toolsRemoveBtn}
            >
              <Text style={styles.toolsRemoveText}>X</Text>
            </TouchableOpacity>
          </View>
        ))
      )}

      <Text style={styles.sectionTitle}>Add Server</Text>
      <TextInput
        style={styles.textField}
        value={newName}
        onChangeText={setNewName}
        placeholder="Server name"
        placeholderTextColor={colors.inputPlaceholder}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View style={{ height: 8 }} />
      <TextInput
        style={styles.textField}
        value={newUrl}
        onChangeText={setNewUrl}
        placeholder="https://example.com/mcp"
        placeholderTextColor={colors.inputPlaceholder}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <View style={styles.toolsTrustRow}>
        <Text style={styles.toolsTrustLabel}>Trusted (auto-approve all tools)</Text>
        <Switch
          value={newTrusted}
          onValueChange={setNewTrusted}
          trackColor={{ false: colors.buttonSecondaryBg, true: colors.accentSoft }}
          thumbColor={newTrusted ? colors.textPrimary : colors.textMuted}
        />
      </View>
      <View style={styles.toolsTrustRow}>
        <Text style={styles.toolsTrustLabel}>Motebit</Text>
        <Switch
          value={newMotebit}
          onValueChange={setNewMotebit}
          trackColor={{ false: colors.buttonSecondaryBg, true: colors.accentSoft }}
          thumbColor={newMotebit ? colors.textPrimary : colors.textMuted}
        />
      </View>

      <TouchableOpacity
        style={[
          styles.toolsConnectBtn,
          (!newName.trim() || !newUrl.trim() || adding) && styles.toolsConnectBtnDisabled,
        ]}
        onPress={() => void handleConnect()}
        disabled={!newName.trim() || !newUrl.trim() || adding}
        activeOpacity={0.7}
      >
        <Text style={styles.toolsConnectText}>{adding ? "Connecting..." : "Connect"}</Text>
      </TouchableOpacity>

      <Text style={styles.toolsNote}>
        Mobile supports HTTP MCP servers only. Stdio servers require the desktop or CLI app.
        {"\n"}Untrusted servers require approval for each tool call.
      </Text>
    </View>
  );
}

// === Styles ===

function createSettingsStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bgPrimary },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingTop: Platform.OS === "ios" ? 56 : 16,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderPrimary,
    },
    cancelBtn: { color: c.textMuted, fontSize: 16 },
    headerTitle: { color: c.textPrimary, fontSize: 17, fontWeight: "600" },
    saveBtn: { color: c.accent, fontSize: 16, fontWeight: "600" },

    tabBar: { flexDirection: "row", paddingHorizontal: 12, paddingTop: 12, gap: 4 },
    tab: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center" },
    tabActive: { backgroundColor: c.buttonSecondaryBg },
    tabText: { color: c.textMuted, fontSize: 12, fontWeight: "600" },
    tabTextActive: { color: c.textPrimary },

    body: { flex: 1 },
    bodyContent: { padding: 20 },

    sectionTitle: {
      color: c.textMuted,
      fontSize: 12,
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginTop: 20,
      marginBottom: 10,
    },

    // Theme toggle
    themeToggleGroup: { flexDirection: "row", gap: 8, marginBottom: 20 },
    themeOption: {
      flex: 1,
      paddingVertical: 10,
      borderRadius: 8,
      backgroundColor: c.bgTertiary,
      alignItems: "center",
    },
    themeOptionSelected: {
      backgroundColor: c.borderLight,
      borderWidth: 1,
      borderColor: c.accentSoft,
    },
    themeOptionText: { color: c.textMuted, fontSize: 13, fontWeight: "500" },
    themeOptionTextSelected: { color: c.textSecondary },

    // Appearance
    presetGrid: { flexDirection: "row", flexWrap: "wrap", gap: 14, justifyContent: "center" },
    presetCircle: {
      width: 52,
      height: 52,
      borderRadius: 26,
      borderWidth: 2,
      borderColor: "transparent",
      justifyContent: "center",
      alignItems: "center",
    },
    presetSelected: { borderColor: c.accent },
    presetCheck: { width: 14, height: 14, borderRadius: 7, backgroundColor: c.accent },
    presetLabel: {
      color: c.textMuted,
      fontSize: 14,
      textAlign: "center",
      marginTop: 12,
      textTransform: "capitalize",
    },

    // Custom color picker
    customPickerContainer: { marginTop: 16, alignItems: "center", gap: 12 },
    customPreviewCircle: {
      width: 48,
      height: 48,
      borderRadius: 24,
      borderWidth: 2,
      borderColor: c.accent,
      marginBottom: 4,
    },
    customSliderLabel: {
      color: c.textMuted,
      fontSize: 11,
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: 0.5,
      alignSelf: "flex-start",
    },
    customSliderTrack: {
      width: "100%",
      height: 28,
      borderRadius: 6,
      backgroundColor: c.borderPrimary,
      justifyContent: "center",
      position: "relative",
    },
    customSliderThumb: {
      position: "absolute",
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 2,
      borderColor: "#fff",
      top: 4,
      marginLeft: -10,
    },

    // Radio
    radioGroup: { gap: 8 },
    radioItem: {
      backgroundColor: c.bgSecondary,
      borderRadius: 10,
      padding: 14,
      borderWidth: 1,
      borderColor: c.borderPrimary,
    },
    radioActive: { borderColor: c.accent, backgroundColor: c.accentSoft },
    radioText: { color: c.textSecondary, fontSize: 15, fontWeight: "600" },
    radioTextActive: { color: c.textPrimary },
    radioDesc: { color: c.textMuted, fontSize: 12, marginTop: 2 },
    voiceHint: { color: c.textGhost, fontSize: 11, marginTop: 4, marginBottom: 4 },
    voiceGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    voiceChip: {
      backgroundColor: c.bgSecondary,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: c.borderPrimary,
    },
    voiceChipActive: { borderColor: c.accent, backgroundColor: c.accentSoft },
    voiceChipText: { color: c.textMuted, fontSize: 13, fontWeight: "600" },
    voiceChipTextActive: { color: c.textPrimary },

    // Fields
    textField: {
      backgroundColor: c.inputBg,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      color: c.inputText,
      fontSize: 15,
    },
    fieldRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginVertical: 6,
    },
    fieldLabel: { color: c.textSecondary, fontSize: 14 },
    numberField: {
      backgroundColor: c.inputBg,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      color: c.inputText,
      fontSize: 15,
      width: 70,
      textAlign: "center",
    },

    // Switch
    switchRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginVertical: 8,
    },
    switchLabel: { color: c.textSecondary, fontSize: 14 },

    // Pin
    pinButton: {
      backgroundColor: c.buttonSecondaryBg,
      borderRadius: 8,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    pinButtonText: { color: c.accent, fontSize: 14, fontWeight: "600" },

    // Identity
    monoValue: {
      color: c.textSecondary,
      fontSize: 13,
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
      backgroundColor: c.bgSecondary,
      borderRadius: 8,
      padding: 12,
      overflow: "hidden",
    },
    hint: { color: c.textGhost, fontSize: 11, textAlign: "center", marginTop: 8 },
    linkDeviceButton: {
      backgroundColor: c.borderLight,
      borderRadius: 10,
      paddingVertical: 14,
      marginTop: 20,
      alignItems: "center",
      borderWidth: 1,
      borderColor: c.accentSoft,
    },
    linkDeviceText: { color: c.accent, fontSize: 15, fontWeight: "600" },
    identityFieldRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    identityFieldValue: { flex: 1 },
    identityCopyLabel: {
      color: c.textMuted,
      fontSize: 12,
      fontWeight: "600",
      minWidth: 46,
      textAlign: "center",
    },
    identityCopiedLabel: { color: c.statusSuccess },
    rotateKeyButton: {
      backgroundColor: c.buttonSecondaryBg,
      borderRadius: 10,
      paddingVertical: 14,
      marginTop: 20,
      alignItems: "center",
      borderWidth: 1,
      borderColor: c.statusWarning,
    },
    rotateKeyText: { color: c.statusWarning, fontSize: 15, fontWeight: "600" as const },
    docsButton: {
      backgroundColor: c.borderLight,
      borderRadius: 10,
      paddingVertical: 14,
      marginTop: 12,
      alignItems: "center",
      borderWidth: 1,
      borderColor: c.accentSoft,
    },
    docsText: { color: c.textMuted, fontSize: 15, fontWeight: "600" },
    exportButton: {
      backgroundColor: c.buttonSecondaryBg,
      borderRadius: 10,
      paddingVertical: 14,
      marginTop: 12,
      alignItems: "center",
    },
    exportText: { color: c.accent, fontSize: 15, fontWeight: "600" },

    // Sync
    syncStatusRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
    syncStatusDot: { width: 8, height: 8, borderRadius: 4 },
    syncStatusLabel: { fontSize: 15, fontWeight: "600" },
    syncLastTime: { color: c.textMuted, fontSize: 12, marginBottom: 8 },
    syncActionButton: {
      backgroundColor: c.buttonPrimaryBg,
      borderRadius: 10,
      paddingVertical: 14,
      marginTop: 16,
      alignItems: "center",
    },
    syncActionDisabled: { opacity: 0.5 },
    syncActionText: { color: c.buttonPrimaryText, fontSize: 15, fontWeight: "600" },
    syncDisconnectButton: {
      backgroundColor: c.buttonSecondaryBg,
      borderRadius: 10,
      paddingVertical: 14,
      marginTop: 12,
      alignItems: "center",
      borderWidth: 1,
      borderColor: `${c.statusError}40`,
    },
    syncDisconnectText: { color: c.statusWarning, fontSize: 15, fontWeight: "600" },
    syncHint: {
      color: c.textGhost,
      fontSize: 13,
      fontStyle: "italic",
      textAlign: "center",
      marginTop: 20,
    },

    // Goals
    goalEmptyText: {
      color: c.textMuted,
      fontSize: 13,
      fontStyle: "italic",
      textAlign: "center",
      marginVertical: 12,
    },
    goalRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.bgSecondary,
      borderRadius: 10,
      padding: 12,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: c.borderPrimary,
    },
    goalInfo: { flex: 1, marginRight: 10 },
    goalPrompt: { color: c.textPrimary, fontSize: 14, marginBottom: 4 },
    goalMeta: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    goalMetaText: { color: c.textMuted, fontSize: 11 },
    goalMetaWarning: { color: c.statusWarning, fontSize: 11, fontWeight: "600" },
    goalActions: { flexDirection: "row", alignItems: "center", gap: 8 },
    goalDeleteBtn: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: `${c.statusError}1a`,
      justifyContent: "center",
      alignItems: "center",
    },
    goalDeleteText: { color: c.statusError, fontSize: 12, fontWeight: "700" },
    goalAddBtn: {
      backgroundColor: c.buttonPrimaryBg,
      borderRadius: 10,
      paddingVertical: 14,
      marginTop: 16,
      alignItems: "center",
    },
    goalAddBtnDisabled: { opacity: 0.4 },
    goalAddBtnText: { color: c.buttonPrimaryText, fontSize: 15, fontWeight: "600" },

    // Tools
    toolsEmptyText: {
      color: c.textMuted,
      fontSize: 13,
      fontStyle: "italic",
      textAlign: "center",
      marginVertical: 12,
    },
    toolsServerRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.bgSecondary,
      borderRadius: 10,
      padding: 12,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: c.borderPrimary,
    },
    toolsServerInfo: { flex: 1, marginRight: 10 },
    toolsServerHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
    toolsStatusDot: { width: 8, height: 8, borderRadius: 4 },
    toolsServerName: { color: c.textPrimary, fontSize: 14, fontWeight: "600" },
    toolsCountBadge: {
      backgroundColor: c.borderLight,
      borderRadius: 10,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    toolsCountText: { color: c.textMuted, fontSize: 11, fontWeight: "600" },
    toolsServerUrl: {
      color: c.textMuted,
      fontSize: 12,
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    },
    toolsRemoveBtn: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: `${c.statusError}1a`,
      justifyContent: "center",
      alignItems: "center",
    },
    toolsRemoveText: { color: c.statusError, fontSize: 12, fontWeight: "700" },
    toolsConnectBtn: {
      backgroundColor: c.buttonPrimaryBg,
      borderRadius: 10,
      paddingVertical: 14,
      marginTop: 12,
      alignItems: "center",
    },
    toolsConnectBtnDisabled: { opacity: 0.4 },
    toolsConnectText: { color: c.buttonPrimaryText, fontSize: 15, fontWeight: "600" },
    toolsTrustBadge: {
      backgroundColor: c.borderLight,
      borderRadius: 10,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    toolsTrustText: { color: c.statusSuccess, fontSize: 10, fontWeight: "600" },
    toolsTrustRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginTop: 8,
    },
    toolsTrustLabel: { color: c.textMuted, fontSize: 12 },
    toolsNote: {
      color: c.textGhost,
      fontSize: 11,
      fontStyle: "italic",
      textAlign: "center",
      marginTop: 16,
    },
  });
}
