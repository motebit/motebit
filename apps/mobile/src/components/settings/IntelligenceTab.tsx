/**
 * Intelligence tab — provider mode picker (three-mode:
 * motebit-cloud / byok / on-device), model input, BYOK vendor picker,
 * on-device backend picker (Apple FM / MLX / local server), voice
 * settings (TTS enable, speak responses, auto-send, neural VAD, TTS
 * voice, OpenAI API key).
 *
 * Extracted from SettingsModal.tsx. The inner `OnDeviceSection`
 * component is co-located because it's only used here — it handles
 * device capability detection and MLX model download/delete.
 */

import React, { useCallback, useEffect, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, Switch, Platform, Alert } from "react-native";
import type { VoiceConfig } from "@motebit/sdk";
import { useTheme } from "../../theme";
import {
  TTS_VOICE_OPTIONS,
  type ProviderType,
  type LocalBackend,
  useSettingsStyles,
} from "./settings-shared";

// === On-Device Section (capability detection + MLX model manager) ===

function OnDeviceSection({
  localBackend,
  onChangeBackend,
}: {
  localBackend: LocalBackend;
  onChangeBackend: (b: LocalBackend) => void;
}): React.ReactElement {
  const colors = useTheme();
  const styles = useSettingsStyles();
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
        const mod = await import("../../../modules/expo-local-inference");
        const caps = mod.default.getCapabilities();
        setCapabilities(caps);
        // Check if MLX model is already downloaded
        const { getDownloadedModels } = await import("../../adapters/mlx-model-manager");
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
      const { downloadModel } = await import("../../adapters/mlx-model-manager");
      await downloadModel(undefined, (p) => setDownloadProgress(p));
      setMlxStatus("ready");
    } catch {
      setMlxStatus("none");
      Alert.alert("Download failed", "Could not download the model. Check your connection.");
    }
  }, []);

  const handleDeleteModel = useCallback(async () => {
    try {
      const { deleteModel, DEFAULT_MLX_MODEL } = await import("../../adapters/mlx-model-manager");
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

export interface IntelligenceTabProps {
  provider: ProviderType;
  model: string;
  apiKey: string;
  googleKey: string;
  localServerEndpoint: string;
  localBackend: LocalBackend;
  /** Canonical voice config from `@motebit/sdk`. */
  voice: VoiceConfig;
  openaiKey: string;
  onChangeProvider: (p: ProviderType) => void;
  onChangeModel: (m: string) => void;
  onChangeApiKey: (k: string) => void;
  onChangeGoogleKey: (k: string) => void;
  onChangeLocalServerEndpoint: (e: string) => void;
  onChangeLocalBackend: (b: LocalBackend) => void;
  /** Patch-style update for the nested `voice` config. */
  onChangeVoice: (patch: Partial<VoiceConfig>) => void;
  onChangeOpenaiKey: (k: string) => void;
}

export function IntelligenceTab({
  provider,
  model,
  apiKey,
  googleKey,
  localServerEndpoint,
  localBackend,
  voice,
  openaiKey,
  onChangeProvider,
  onChangeModel,
  onChangeApiKey,
  onChangeGoogleKey,
  onChangeLocalServerEndpoint,
  onChangeLocalBackend,
  onChangeVoice,
  onChangeOpenaiKey,
}: IntelligenceTabProps): React.ReactElement {
  const colors = useTheme();
  const styles = useSettingsStyles();

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
          value={voice.enabled}
          onValueChange={(v) => onChangeVoice({ enabled: v })}
          trackColor={{ false: colors.buttonSecondaryBg, true: colors.accentSoft }}
          thumbColor={voice.enabled ? colors.textPrimary : colors.textMuted}
        />
      </View>
      <Text style={styles.voiceHint}>Enable mic button for voice input and spoken responses</Text>

      {voice.enabled && (
        <>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Speak responses</Text>
            <Switch
              value={voice.speakResponses}
              onValueChange={(v) => onChangeVoice({ speakResponses: v })}
              trackColor={{ false: colors.buttonSecondaryBg, true: colors.accentSoft }}
              thumbColor={voice.speakResponses ? colors.textPrimary : colors.textMuted}
            />
          </View>
          <Text style={styles.voiceHint}>Read assistant replies aloud via TTS</Text>

          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Auto-send transcript</Text>
            <Switch
              value={voice.autoSend}
              onValueChange={(v) => onChangeVoice({ autoSend: v })}
              trackColor={{ false: colors.buttonSecondaryBg, true: colors.accentSoft }}
              thumbColor={voice.autoSend ? colors.textPrimary : colors.textMuted}
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
                  value={voice.neuralVad ?? true}
                  onValueChange={(v) => onChangeVoice({ neuralVad: v })}
                  trackColor={{ false: colors.buttonSecondaryBg, true: colors.accentSoft }}
                  thumbColor={(voice.neuralVad ?? true) ? colors.textPrimary : colors.textMuted}
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
                style={[styles.voiceChip, voice.ttsVoice === opt.key && styles.voiceChipActive]}
                onPress={() => onChangeVoice({ ttsVoice: opt.key })}
                activeOpacity={0.7}
              >
                <Text
                  style={[
                    styles.voiceChipText,
                    voice.ttsVoice === opt.key && styles.voiceChipTextActive,
                  ]}
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
