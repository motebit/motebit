/**
 * Settings modal — thin orchestrator over the 5 tab components in
 * `./settings/`. The modal owns the draft state, API-key buffers, and
 * the save handler; each tab is a pure presentation component with a
 * prop-shaped interface.
 *
 * The modal is intentionally a barrel: it imports every tab and wires
 * shared state to their props. Each tab lives in its own file for
 * testability and so the prop shape stays explicit. Sub-modules:
 *
 *   - `./settings/settings-shared.tsx`  — types, constants, PolicySummary,
 *                                         deriveInteriorColor, stylesheet factory
 *   - `./settings/AppearanceTab.tsx`    — color presets + custom sliders + theme
 *   - `./settings/IntelligenceTab.tsx`  — provider mode + BYOK + on-device + voice
 *                                         (includes the inner OnDeviceSection)
 *   - `./settings/GovernanceTab.tsx`    — operator mode + approval preset + memory
 *   - `./settings/IdentityTab.tsx`      — ID display + copy + rotate key + export
 *   - `./settings/ToolsTab.tsx`         — MCP server list + add form
 *
 * This file stays as `SettingsModal.tsx` for import-stability — every
 * App.tsx reference keeps working unchanged. `deriveInteriorColor` is
 * re-exported for App.tsx's live-preview path.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Alert,
  Clipboard,
  Appearance,
} from "react-native";
import * as SecureStore from "expo-secure-store";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system";
import type { MobileApp, MobileSettings, MobileAIConfig } from "../mobile-app";
import { SECURE_STORE_KEYS } from "../storage-keys";
import { APPROVAL_PRESET_CONFIGS } from "../mobile-app";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_GOOGLE_MODEL,
  DEFAULT_OLLAMA_MODEL,
} from "@motebit/sdk";
import { BillingPanel } from "./BillingPanel";
import {
  TABS,
  AppearanceTab,
  IntelligenceTab,
  GovernanceTab,
  IdentityTab,
  ToolsTab,
  deriveInteriorColor,
  useSettingsStyles,
  type Tab,
} from "./settings";

// Re-export deriveInteriorColor so App.tsx keeps working — the live
// preview path imports it from this file and we don't want to touch
// App.tsx for something this mechanical.
export { deriveInteriorColor } from "./settings";

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
  const styles = useSettingsStyles();
  const [tab, setTab] = useState<Tab>("appearance");
  const [draft, setDraft] = useState<MobileSettings>(settings);
  const [apiKey, setApiKey] = useState("");
  const [googleKey, setGoogleKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [elevenLabsKey, setElevenLabsKey] = useState("");
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
    void SecureStore.getItemAsync(SECURE_STORE_KEYS.elevenLabsVoiceKey).then((k) => {
      if (k != null && k !== "") setElevenLabsKey(k);
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
    if (elevenLabsKey) {
      await SecureStore.setItemAsync(SECURE_STORE_KEYS.elevenLabsVoiceKey, elevenLabsKey);
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
    app.setInteriorColor(draft.appearance.colorPreset);

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
  }, [draft, apiKey, googleKey, openaiKey, elevenLabsKey, app, settings, onSave]);

  const identity = useMemo(() => app.getIdentityInfo(), [app]);

  // Settings = identity. The Solana address is identity (the address *is* the
  // Ed25519 public key, base58-encoded). Live balance lives in the Sovereign
  // panel Budget tab; this keeps Settings calm — no RPC on every modal open.
  const runtime = app.getRuntime();
  const solanaAddress = runtime?.getSolanaAddress() ?? null;

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
              selected={draft.appearance.colorPreset}
              onSelect={(preset) => {
                updateDraft({ appearance: { ...draft.appearance, colorPreset: preset } });
                // Live preview
                if (preset === "custom") {
                  const color = deriveInteriorColor(
                    draft.appearance.customHue ?? 220,
                    draft.appearance.customSaturation ?? 0.7,
                  );
                  app.setInteriorColorDirect(color);
                } else {
                  app.setInteriorColor(preset);
                }
              }}
              theme={draft.appearance.theme ?? "dark"}
              onThemeChange={(t) => {
                updateDraft({ appearance: { ...draft.appearance, theme: t } });
                // Live preview — switch 3D environment
                const effective = t === "system" ? (Appearance.getColorScheme() ?? "dark") : t;
                if (effective === "dark") {
                  app.setDarkEnvironment();
                } else {
                  app.setLightEnvironment();
                }
              }}
              customHue={draft.appearance.customHue ?? 220}
              customSaturation={draft.appearance.customSaturation ?? 0.7}
              onCustomColorChange={(hue, sat) => {
                updateDraft({
                  appearance: { ...draft.appearance, customHue: hue, customSaturation: sat },
                });
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
                voice={draft.voice}
                openaiKey={openaiKey}
                elevenLabsKey={elevenLabsKey}
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
                onChangeVoice={(patch) => updateDraft({ voice: { ...draft.voice, ...patch } })}
                onChangeOpenaiKey={setOpenaiKey}
                onChangeElevenLabsKey={setElevenLabsKey}
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
              solanaAddress={solanaAddress}
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
