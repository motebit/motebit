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
import type { MobileApp, MobileSettings, MobileAIConfig, MobileLocalBackend } from "../mobile-app";
import { SECURE_STORE_KEYS } from "../storage-keys";
import type { InteriorColor } from "@motebit/runtime";
import { COLOR_PRESETS, APPROVAL_PRESET_CONFIGS } from "../mobile-app";
import { useTheme, type ThemeColors } from "../theme";
import { hexPublicKeyToDidKey } from "@motebit/crypto";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_GOOGLE_MODEL,
  DEFAULT_OLLAMA_MODEL,
} from "@motebit/sdk";
import { BillingPanel } from "./BillingPanel";

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

type Tab = "appearance" | "intelligence" | "governance" | "identity" | "billing";

const TABS: { key: Tab; label: string }[] = [
  { key: "appearance", label: "Appearance" },
  { key: "intelligence", label: "Intelligence" },
  { key: "governance", label: "Governance" },
  { key: "identity", label: "Identity" },
  { key: "billing", label: "Billing" },
];

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
  customHue?: number;
  customSaturation?: number;
  onCustomColorChange?: (hue: number, saturation: number) => void;
}

const RISK_LABELS: Record<number, string> = {
  0: "R0 Read",
  1: "R1 Draft",
  2: "R2 Write",
  3: "R3 Execute",
  4: "R4 Money",
};

function PolicySummary({
  preset,
  isOperatorMode,
}: {
  preset: string;
  isOperatorMode: boolean;
}): React.ReactElement {
  const themeColors = useTheme();
  const config = APPROVAL_PRESET_CONFIGS[preset] ?? APPROVAL_PRESET_CONFIGS.balanced!;
  const autoAllow =
    config.requireApprovalAbove === 0
      ? "Nothing"
      : `Up to ${RISK_LABELS[config.requireApprovalAbove - 1] ?? `R${config.requireApprovalAbove - 1}`}`;
  const requireApproval = `${RISK_LABELS[config.requireApprovalAbove] ?? `R${config.requireApprovalAbove}`}+`;
  const deny = `Above ${RISK_LABELS[config.denyAbove - 1] ?? `R${config.denyAbove - 1}`}`;
  return (
    <View
      style={{
        padding: 10,
        borderRadius: 8,
        backgroundColor: themeColors.bgSecondary,
        marginTop: 8,
      }}
    >
      <Text style={{ fontSize: 11, color: themeColors.textMuted, lineHeight: 18 }}>
        Auto-allow: {autoAllow}
        {"\n"}
        Require approval: {requireApproval}
        {"\n"}
        Deny: {deny}
        {"\n"}
        Operator mode: {isOperatorMode ? "on" : "off"}
      </Text>
    </View>
  );
}

export function SettingsModal({
  visible,
  app,
  settings,
  mcpServers,
  onAddMcpServer,
  onRemoveMcpServer,
  onToggleMcpTrust,
  onSave,
  onClose,
  onRequestPin,
  onLinkDevice,
  onCustomColorChange,
}: SettingsModalProps): React.ReactElement {
  const colors = useTheme();
  const styles = useMemo(() => createSettingsStyles(colors), [colors]);
  const [tab, setTab] = useState<Tab>("appearance");
  const [draft, setDraft] = useState<MobileSettings>(settings);
  const [apiKey, setApiKey] = useState("");
  const [googleKey, setGoogleKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [billingRelayUrl, setBillingRelayUrl] = useState<string | null>(null);

  // Fetch relay URL for billing panel
  useEffect(() => {
    void app.getSyncUrl().then(setBillingRelayUrl);
  }, [app, visible]);

  // Sync draft when settings change or modal opens
  useEffect(() => {
    setDraft(settings);
    // Load stored API keys
    if (settings.provider === "openai") {
      void SecureStore.getItemAsync(SECURE_STORE_KEYS.openaiChatKey).then((k) => {
        if (k != null && k !== "") setApiKey(k);
      });
    } else if (settings.provider === "google") {
      void SecureStore.getItemAsync(SECURE_STORE_KEYS.googleApiKey).then((k) => {
        if (k != null && k !== "") setGoogleKey(k);
      });
    } else {
      void SecureStore.getItemAsync(SECURE_STORE_KEYS.anthropicApiKey).then((k) => {
        if (k != null && k !== "") setApiKey(k);
      });
    }
    // Pre-load google key independently so the Google section shows the stored value
    // even when the active provider is something else.
    void SecureStore.getItemAsync(SECURE_STORE_KEYS.googleApiKey).then((k) => {
      if (k != null && k !== "") setGoogleKey(k);
    });
    void SecureStore.getItemAsync(SECURE_STORE_KEYS.openaiVoiceKey).then((k) => {
      if (k != null && k !== "") setOpenaiKey(k);
    });
  }, [settings, visible]);

  const updateDraft = useCallback((patch: Partial<MobileSettings>) => {
    setDraft((d) => ({ ...d, ...patch }));
  }, []);

  const handleSave = useCallback(async () => {
    // Store API keys securely (not in AsyncStorage)
    if (draft.provider === "anthropic" && apiKey) {
      await SecureStore.setItemAsync(SECURE_STORE_KEYS.anthropicApiKey, apiKey);
    }
    if (draft.provider === "openai" && apiKey) {
      await SecureStore.setItemAsync(SECURE_STORE_KEYS.openaiChatKey, apiKey);
    }
    if (draft.provider === "google" && googleKey) {
      await SecureStore.setItemAsync(SECURE_STORE_KEYS.googleApiKey, googleKey);
    }
    if (openaiKey) {
      await SecureStore.setItemAsync(SECURE_STORE_KEYS.openaiVoiceKey, openaiKey);
    }

    // Apply governance settings to runtime (include current operator mode to preserve it)
    app.updatePolicyConfig({
      requireApprovalAbove: APPROVAL_PRESET_CONFIGS[draft.approvalPreset]?.requireApprovalAbove,
      denyAbove: APPROVAL_PRESET_CONFIGS[draft.approvalPreset]?.denyAbove,
      operatorMode: app.isOperatorMode,
      budget: { maxCallsPerTurn: draft.maxCallsPerTurn },
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
      draft.localServerEndpoint !== settings.localServerEndpoint ||
      draft.maxTokens !== settings.maxTokens
    ) {
      aiConfig = {
        provider: draft.provider,
        localBackend: draft.localBackend,
        model: draft.model,
        apiKey:
          draft.provider === "anthropic"
            ? apiKey
            : draft.provider === "openai"
              ? apiKey
              : draft.provider === "google"
                ? googleKey
                : undefined,
        localServerEndpoint:
          draft.provider === "local-server" ||
          (draft.provider === "on-device" && draft.localBackend === "local-server")
            ? draft.localServerEndpoint
            : undefined,
        maxTokens: draft.maxTokens,
      };
    }

    onSave(draft, aiConfig);
  }, [draft, apiKey, googleKey, openaiKey, app, settings, onSave]);

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
          {tab === "billing" && (
            <BillingPanel
              motebitId={identity.motebitId}
              relayUrl={billingRelayUrl}
              balanceUsd={0}
            />
          )}
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
            <>
              <IntelligenceTab
                provider={draft.provider}
                model={draft.model}
                apiKey={apiKey}
                googleKey={googleKey}
                localServerEndpoint={draft.localServerEndpoint}
                localBackend={draft.localBackend ?? "apple-fm"}
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
                      p === "on-device"
                        ? "on-device"
                        : p === "local-server"
                          ? DEFAULT_OLLAMA_MODEL
                          : p === "openai"
                            ? DEFAULT_OPENAI_MODEL
                            : p === "google"
                              ? DEFAULT_GOOGLE_MODEL
                              : DEFAULT_ANTHROPIC_MODEL,
                  })
                }
                onChangeModel={(m) => updateDraft({ model: m })}
                onChangeApiKey={setApiKey}
                onChangeGoogleKey={setGoogleKey}
                onChangeLocalServerEndpoint={(e) => updateDraft({ localServerEndpoint: e })}
                onChangeLocalBackend={(b) => updateDraft({ localBackend: b })}
                onChangeVoiceEnabled={(v) => updateDraft({ voiceEnabled: v })}
                onChangeVoiceResponseEnabled={(v) => updateDraft({ voiceResponseEnabled: v })}
                onChangeVoiceAutoSend={(v) => updateDraft({ voiceAutoSend: v })}
                onChangeTtsVoice={(v) => updateDraft({ ttsVoice: v })}
                onChangeOpenaiKey={setOpenaiKey}
                onChangeNeuralVadEnabled={(v) => updateDraft({ neuralVadEnabled: v })}
              />
              <ToolsTab
                servers={mcpServers ?? []}
                onAdd={onAddMcpServer}
                onRemove={onRemoveMcpServer}
                onToggleTrust={onToggleMcpTrust}
              />
            </>
          )}
          {tab === "governance" && (
            <GovernanceTab
              draft={draft}
              isOperatorMode={app.isOperatorMode}
              onUpdate={updateDraft}
              onRequestPin={onRequestPin}
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
              onExportIdentity={() => {
                void (async () => {
                  try {
                    const mdContent = await app.exportIdentity();
                    if (mdContent == null) {
                      Alert.alert("Export Failed", "Identity not available for export.");
                      return;
                    }
                    const canShare = await Sharing.isAvailableAsync();
                    if (canShare) {
                      const filePath = `${FileSystem.cacheDirectory}motebit.md`;
                      await FileSystem.writeAsStringAsync(filePath, mdContent);
                      await Sharing.shareAsync(filePath, { mimeType: "text/markdown" });
                    } else {
                      Clipboard.setString(mdContent);
                      Alert.alert("Exported", "Identity file copied to clipboard.");
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

// === On-Device Section ===

// Re-export the canonical type name under a shorter local alias so the
// existing prop shapes don't have to be renamed. Source of truth lives in
// mobile-app.ts so the three-mode wire format and the UI agree.
type LocalBackend = MobileLocalBackend;

function OnDeviceSection({
  localBackend,
  onChangeBackend,
}: {
  localBackend: LocalBackend;
  onChangeBackend: (b: LocalBackend) => void;
}) {
  const colors = useTheme();
  const styles = useMemo(() => createSettingsStyles(colors), [colors]);
  const [capabilities, setCapabilities] = useState<{
    appleFM: boolean;
    mlx: boolean;
    deviceMemoryGB: number;
  } | null>(null);
  const [mlxStatus, setMlxStatus] = useState<"none" | "downloading" | "ready">("none");
  const [downloadProgress, setDownloadProgress] = useState(0);

  useEffect(() => {
    void (async () => {
      try {
        const mod = await import("../../modules/expo-local-inference");
        const caps = mod.default.getCapabilities();
        setCapabilities(caps);
        // Check if MLX model is already downloaded
        const { getDownloadedModels } = await import("../adapters/mlx-model-manager");
        const models = await getDownloadedModels();
        if (models.length > 0) setMlxStatus("ready");
      } catch {
        // Native module not available (dev build needed)
      }
    })();
  }, []);

  const handleDownloadModel = useCallback(async () => {
    setMlxStatus("downloading");
    setDownloadProgress(0);
    try {
      const { downloadModel } = await import("../adapters/mlx-model-manager");
      await downloadModel(undefined, (p) => setDownloadProgress(p));
      setMlxStatus("ready");
    } catch {
      setMlxStatus("none");
      Alert.alert("Download failed", "Could not download the model. Check your connection.");
    }
  }, []);

  const handleDeleteModel = useCallback(async () => {
    try {
      const { deleteModel, DEFAULT_MLX_MODEL } = await import("../adapters/mlx-model-manager");
      await deleteModel(DEFAULT_MLX_MODEL);
      setMlxStatus("none");
      setDownloadProgress(0);
    } catch {
      // Ignore delete errors
    }
  }, []);

  if (capabilities == null) {
    return (
      <View style={{ marginTop: 12 }}>
        <Text style={styles.radioDesc}>Checking device capabilities...</Text>
      </View>
    );
  }

  return (
    <View style={{ marginTop: 12, gap: 12 }}>
      {capabilities.appleFM && (
        <TouchableOpacity
          style={[styles.radioItem, localBackend === "apple-fm" && styles.radioActive]}
          onPress={() => onChangeBackend("apple-fm")}
          activeOpacity={0.7}
        >
          <Text style={[styles.radioText, localBackend === "apple-fm" && styles.radioTextActive]}>
            Apple Intelligence
          </Text>
          <Text style={styles.radioDesc}>Built-in. No download needed. Runs on Neural Engine.</Text>
        </TouchableOpacity>
      )}

      {capabilities.mlx && (
        <TouchableOpacity
          style={[styles.radioItem, localBackend === "mlx" && styles.radioActive]}
          onPress={() => onChangeBackend("mlx")}
          activeOpacity={0.7}
        >
          <Text style={[styles.radioText, localBackend === "mlx" && styles.radioTextActive]}>
            Custom Model (MLX)
          </Text>
          <Text style={styles.radioDesc}>
            Llama 3.2 1B. Your model, your device, fully sovereign.
          </Text>
        </TouchableOpacity>
      )}

      {localBackend === "mlx" && (
        <View style={{ marginTop: 4, gap: 8 }}>
          {mlxStatus === "none" && (
            <TouchableOpacity
              style={[styles.radioItem, { borderColor: colors.accent }]}
              onPress={() => void handleDownloadModel()}
              activeOpacity={0.7}
            >
              <Text style={[styles.radioText, { color: colors.accent }]}>
                Download Model (~800 MB)
              </Text>
            </TouchableOpacity>
          )}

          {mlxStatus === "downloading" && (
            <View style={styles.radioItem}>
              <Text style={styles.radioText}>
                Downloading... {Math.round(downloadProgress * 100)}%
              </Text>
              <View
                style={{
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: colors.borderPrimary,
                  marginTop: 8,
                  overflow: "hidden",
                }}
              >
                <View
                  style={{
                    height: 4,
                    borderRadius: 2,
                    backgroundColor: colors.accent,
                    width: `${Math.round(downloadProgress * 100)}%`,
                  }}
                />
              </View>
            </View>
          )}

          {mlxStatus === "ready" && (
            <View
              style={[
                styles.radioItem,
                { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
              ]}
            >
              <Text style={styles.radioText}>Model ready</Text>
              <TouchableOpacity onPress={() => void handleDeleteModel()}>
                <Text style={{ color: colors.textMuted, fontSize: 13 }}>Delete</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      {/* Local server — LAN / user-hosted Ollama or LM Studio. Always available. */}
      <TouchableOpacity
        style={[styles.radioItem, localBackend === "local-server" && styles.radioActive]}
        onPress={() => onChangeBackend("local-server")}
        activeOpacity={0.7}
      >
        <Text style={[styles.radioText, localBackend === "local-server" && styles.radioTextActive]}>
          Local Server
        </Text>
        <Text style={styles.radioDesc}>
          Ollama, LM Studio, llama.cpp, or any OpenAI-compatible server on your LAN.
        </Text>
      </TouchableOpacity>

      {!capabilities.appleFM && !capabilities.mlx && (
        <Text style={styles.radioDesc}>
          Apple Intelligence requires iOS 26, MLX requires 3GB+ RAM. Local Server works anywhere.
        </Text>
      )}

      {capabilities.appleFM && !capabilities.mlx && (
        <Text style={styles.radioDesc}>
          {capabilities.deviceMemoryGB}GB RAM. Apple Intelligence available.
        </Text>
      )}
    </View>
  );
}

// === Intelligence Tab ===

type ProviderType = "local-server" | "anthropic" | "openai" | "google" | "proxy" | "on-device";

function IntelligenceTab({
  provider,
  model,
  apiKey,
  googleKey,
  localServerEndpoint,
  localBackend,
  voiceEnabled,
  voiceResponseEnabled,
  voiceAutoSend,
  ttsVoice,
  openaiKey,
  neuralVadEnabled,
  onChangeProvider,
  onChangeModel,
  onChangeApiKey,
  onChangeGoogleKey,
  onChangeLocalServerEndpoint,
  onChangeLocalBackend,
  onChangeVoiceEnabled,
  onChangeVoiceResponseEnabled,
  onChangeVoiceAutoSend,
  onChangeTtsVoice,
  onChangeOpenaiKey,
  onChangeNeuralVadEnabled,
}: {
  provider: ProviderType;
  model: string;
  apiKey: string;
  googleKey: string;
  localServerEndpoint: string;
  localBackend: LocalBackend;
  voiceEnabled: boolean;
  voiceResponseEnabled: boolean;
  voiceAutoSend: boolean;
  ttsVoice: string;
  openaiKey: string;
  neuralVadEnabled: boolean;
  onChangeProvider: (p: ProviderType) => void;
  onChangeModel: (m: string) => void;
  onChangeApiKey: (k: string) => void;
  onChangeGoogleKey: (k: string) => void;
  onChangeLocalServerEndpoint: (e: string) => void;
  onChangeLocalBackend: (b: LocalBackend) => void;
  onChangeVoiceEnabled: (v: boolean) => void;
  onChangeVoiceResponseEnabled: (v: boolean) => void;
  onChangeVoiceAutoSend: (v: boolean) => void;
  onChangeTtsVoice: (v: string) => void;
  onChangeOpenaiKey: (k: string) => void;
  onChangeNeuralVadEnabled: (v: boolean) => void;
}) {
  const colors = useTheme();
  const styles = useMemo(() => createSettingsStyles(colors), [colors]);

  // Derive the top-level mode from the flat provider. The three modes are
  // orthogonal to subscription tier — BYOK is always accessible, even to
  // Motebit Cloud subscribers who want to use a model we don't offer.
  // See feedback_sovereignty_orthogonal.
  const uiMode: "motebit-cloud" | "byok" | "on-device" =
    provider === "proxy"
      ? "motebit-cloud"
      : provider === "anthropic" || provider === "openai" || provider === "google"
        ? "byok"
        : "on-device"; // "local-server" and "on-device" both land here

  // The active BYOK vendor mirrors the flat provider when in byok mode.
  const activeByokVendor: "anthropic" | "openai" | "google" =
    provider === "openai" || provider === "google" || provider === "anthropic"
      ? provider
      : "anthropic";

  function selectMode(mode: "motebit-cloud" | "byok" | "on-device"): void {
    if (mode === "motebit-cloud") {
      if (provider !== "proxy") {
        onChangeProvider("proxy");
      }
    } else if (mode === "byok") {
      // Keep the current vendor if they're already in byok; otherwise default
      // to anthropic so the key input has a concrete target.
      if (provider !== "anthropic" && provider !== "openai" && provider !== "google") {
        onChangeProvider("anthropic");
      }
    } else {
      // on-device — snap to the canonical shape regardless of legacy
      // "local-server" or "ollama" historical values.
      onChangeProvider("on-device");
    }
  }

  return (
    <View>
      <Text style={styles.sectionTitle}>Provider</Text>
      {/* Three top-level modes, equal visual weight. BYOK is never hidden. */}
      <View style={styles.radioGroup}>
        <TouchableOpacity
          style={[styles.radioItem, uiMode === "motebit-cloud" && styles.radioActive]}
          onPress={() => selectMode("motebit-cloud")}
          activeOpacity={0.7}
        >
          <Text style={[styles.radioText, uiMode === "motebit-cloud" && styles.radioTextActive]}>
            Motebit Cloud
          </Text>
          <Text style={styles.radioDesc}>
            The product — subscription-backed inference, no API key required.
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.radioItem, uiMode === "byok" && styles.radioActive]}
          onPress={() => selectMode("byok")}
          activeOpacity={0.7}
        >
          <Text style={[styles.radioText, uiMode === "byok" && styles.radioTextActive]}>
            API Key
          </Text>
          <Text style={styles.radioDesc}>Bring your own key for Anthropic, OpenAI, or Google.</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.radioItem, uiMode === "on-device" && styles.radioActive]}
          onPress={() => selectMode("on-device")}
          activeOpacity={0.7}
        >
          <Text style={[styles.radioText, uiMode === "on-device" && styles.radioTextActive]}>
            On-Device
          </Text>
          <Text style={styles.radioDesc}>Runs entirely on your phone or a server on your LAN.</Text>
        </TouchableOpacity>
      </View>

      {/* === Motebit Cloud mode === */}
      {uiMode === "motebit-cloud" && (
        <View style={{ marginTop: 12 }}>
          <Text style={styles.sectionTitle}>Model</Text>
          <TextInput
            style={styles.textField}
            value={model}
            onChangeText={onChangeModel}
            placeholder="Model name"
            placeholderTextColor={colors.inputPlaceholder}
          />
        </View>
      )}

      {/* === BYOK mode === */}
      {uiMode === "byok" && (
        <View style={{ marginTop: 12 }}>
          <Text style={styles.sectionTitle}>Vendor</Text>
          <View style={styles.radioGroup}>
            <TouchableOpacity
              style={[styles.radioItem, activeByokVendor === "anthropic" && styles.radioActive]}
              onPress={() => onChangeProvider("anthropic")}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.radioText,
                  activeByokVendor === "anthropic" && styles.radioTextActive,
                ]}
              >
                Anthropic
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.radioItem, activeByokVendor === "openai" && styles.radioActive]}
              onPress={() => onChangeProvider("openai")}
              activeOpacity={0.7}
            >
              <Text
                style={[styles.radioText, activeByokVendor === "openai" && styles.radioTextActive]}
              >
                OpenAI
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.radioItem, activeByokVendor === "google" && styles.radioActive]}
              onPress={() => onChangeProvider("google")}
              activeOpacity={0.7}
            >
              <Text
                style={[styles.radioText, activeByokVendor === "google" && styles.radioTextActive]}
              >
                Google
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

          {activeByokVendor === "anthropic" && (
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
          {activeByokVendor === "openai" && (
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
          {activeByokVendor === "google" && (
            <>
              <Text style={styles.sectionTitle}>Google API Key</Text>
              <TextInput
                style={styles.textField}
                value={googleKey}
                onChangeText={onChangeGoogleKey}
                placeholder="AIza..."
                placeholderTextColor={colors.inputPlaceholder}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
            </>
          )}
        </View>
      )}

      {/* === On-Device mode === */}
      {uiMode === "on-device" && (
        <View style={{ marginTop: 12 }}>
          <OnDeviceSection localBackend={localBackend} onChangeBackend={onChangeLocalBackend} />
          {localBackend === "local-server" && (
            <>
              <Text style={styles.sectionTitle}>Server Endpoint</Text>
              <TextInput
                style={styles.textField}
                value={localServerEndpoint}
                onChangeText={onChangeLocalServerEndpoint}
                placeholder="http://localhost:11434"
                placeholderTextColor={colors.inputPlaceholder}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
              <Text style={styles.sectionTitle}>Model</Text>
              <TextInput
                style={styles.textField}
                value={model}
                onChangeText={onChangeModel}
                placeholder="Model name"
                placeholderTextColor={colors.inputPlaceholder}
              />
            </>
          )}
        </View>
      )}

      {/* Response length removed: the creature reads the room. */}

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
      <PolicySummary preset={draft.approvalPreset} isOperatorMode={isOperatorMode} />

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
          value={String(draft.maxCallsPerTurn)}
          onChangeText={(v) => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) onUpdate({ maxCallsPerTurn: n });
          }}
          keyboardType="number-pad"
          placeholderTextColor={colors.inputPlaceholder}
        />
      </View>
    </View>
  );
}

// === Identity Tab ===

function IdentityTab({
  motebitId,
  deviceId,
  publicKey,
  onExport,
  onExportIdentity,
  onLinkDevice,
  onRotateKey,
}: {
  motebitId: string;
  deviceId: string;
  publicKey: string;
  onExport: () => void;
  onExportIdentity?: () => void;
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

      {onExportIdentity && (
        <TouchableOpacity
          style={styles.exportButton}
          onPress={onExportIdentity}
          activeOpacity={0.7}
        >
          <Text style={styles.exportText}>Export Identity</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity style={styles.exportButton} onPress={onExport} activeOpacity={0.7}>
        <Text style={styles.exportText}>Export All Data</Text>
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
