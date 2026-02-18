import React, { useCallback, useEffect, useState } from "react";
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
} from "react-native";
import * as SecureStore from "expo-secure-store";
import type { MobileApp, MobileSettings, MobileAIConfig } from "../mobile-app";
import { COLOR_PRESETS, APPROVAL_PRESET_CONFIGS } from "../mobile-app";

type Tab = "appearance" | "intelligence" | "governance" | "identity";

const TABS: { key: Tab; label: string }[] = [
  { key: "appearance", label: "Appearance" },
  { key: "intelligence", label: "Intelligence" },
  { key: "governance", label: "Governance" },
  { key: "identity", label: "Identity" },
];

// Hex colors for preview circles
const PRESET_COLORS: Record<string, string> = {
  borosilicate: "#e0e8ff",
  amber:        "#ffda99",
  rose:         "#ffd0e0",
  violet:       "#d0b8ff",
  cyan:         "#b8f0ff",
  ember:        "#ffb8a0",
  sage:         "#c0f0c8",
  moonlight:    "#f0f0ff",
};

interface SettingsModalProps {
  visible: boolean;
  app: MobileApp;
  settings: MobileSettings;
  onSave: (settings: MobileSettings, aiConfig?: MobileAIConfig) => void;
  onClose: () => void;
  onRequestPin: (mode: "setup" | "verify" | "reset") => void;
  onLinkDevice?: () => void;
}

export function SettingsModal({
  visible,
  app,
  settings,
  onSave,
  onClose,
  onRequestPin,
  onLinkDevice,
}: SettingsModalProps): React.ReactElement {
  const [tab, setTab] = useState<Tab>("appearance");
  const [draft, setDraft] = useState<MobileSettings>(settings);
  const [apiKey, setApiKey] = useState("");

  // Sync draft when settings change or modal opens
  useEffect(() => {
    setDraft(settings);
    // Load stored API key
    void SecureStore.getItemAsync("motebit_anthropic_api_key").then((k) => {
      if (k) setApiKey(k);
    });
  }, [settings, visible]);

  const updateDraft = useCallback((patch: Partial<MobileSettings>) => {
    setDraft((d) => ({ ...d, ...patch }));
  }, []);

  const handleSave = useCallback(async () => {
    // Store API key securely (not in AsyncStorage)
    if (draft.provider === "anthropic" && apiKey) {
      await SecureStore.setItemAsync("motebit_anthropic_api_key", apiKey);
    }

    // Apply governance settings to runtime
    app.updatePolicyConfig({
      requireApprovalAbove: APPROVAL_PRESET_CONFIGS[draft.approvalPreset]?.requireApprovalAbove as number | undefined,
      denyAbove: APPROVAL_PRESET_CONFIGS[draft.approvalPreset]?.denyAbove as number | undefined,
    });
    app.updateMemoryGovernance({
      persistenceThreshold: draft.persistenceThreshold,
      rejectSecrets: draft.rejectSecrets,
      maxMemoriesPerTurn: draft.maxMemoriesPerTurn,
    });

    // Apply color preset
    app.setInteriorColor(draft.colorPreset);

    // Build AI config if provider or model changed
    let aiConfig: MobileAIConfig | undefined;
    if (draft.provider !== settings.provider || draft.model !== settings.model) {
      aiConfig = {
        provider: draft.provider,
        model: draft.model,
        apiKey: draft.provider === "anthropic" ? apiKey : undefined,
      };
    }

    onSave(draft, aiConfig);
  }, [draft, apiKey, app, settings, onSave]);

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
                app.setInteriorColor(preset);
              }}
            />
          )}
          {tab === "intelligence" && (
            <IntelligenceTab
              provider={draft.provider}
              model={draft.model}
              apiKey={apiKey}
              onChangeProvider={(p) => updateDraft({ provider: p, model: p === "ollama" ? "llama3.2" : "claude-sonnet-4-20250514" })}
              onChangeModel={(m) => updateDraft({ model: m })}
              onChangeApiKey={setApiKey}
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
          {tab === "identity" && (
            <IdentityTab
              motebitId={identity.motebitId}
              deviceId={identity.deviceId}
              publicKey={identity.publicKey}
              onExport={() => void app.exportAllData().then((d) => Alert.alert("Export", d))}
              onLinkDevice={onLinkDevice}
            />
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

// === Appearance Tab ===

function AppearanceTab({ selected, onSelect }: { selected: string; onSelect: (p: string) => void }) {
  const presets = Object.keys(COLOR_PRESETS);
  return (
    <View>
      <Text style={styles.sectionTitle}>Color Preset</Text>
      <View style={styles.presetGrid}>
        {presets.map((name) => (
          <TouchableOpacity
            key={name}
            style={[
              styles.presetCircle,
              { backgroundColor: PRESET_COLORS[name] || "#888" },
              selected === name && styles.presetSelected,
            ]}
            onPress={() => onSelect(name)}
            activeOpacity={0.7}
          >
            {selected === name && <View style={styles.presetCheck} />}
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.presetLabel}>{selected}</Text>
    </View>
  );
}

// === Intelligence Tab ===

function IntelligenceTab({
  provider,
  model,
  apiKey,
  onChangeProvider,
  onChangeModel,
  onChangeApiKey,
}: {
  provider: "ollama" | "anthropic";
  model: string;
  apiKey: string;
  onChangeProvider: (p: "ollama" | "anthropic") => void;
  onChangeModel: (m: string) => void;
  onChangeApiKey: (k: string) => void;
}) {
  return (
    <View>
      <Text style={styles.sectionTitle}>Provider</Text>
      <View style={styles.radioGroup}>
        <TouchableOpacity
          style={[styles.radioItem, provider === "ollama" && styles.radioActive]}
          onPress={() => onChangeProvider("ollama")}
          activeOpacity={0.7}
        >
          <Text style={[styles.radioText, provider === "ollama" && styles.radioTextActive]}>Ollama (Local)</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.radioItem, provider === "anthropic" && styles.radioActive]}
          onPress={() => onChangeProvider("anthropic")}
          activeOpacity={0.7}
        >
          <Text style={[styles.radioText, provider === "anthropic" && styles.radioTextActive]}>Anthropic (Cloud)</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionTitle}>Model</Text>
      <TextInput
        style={styles.textField}
        value={model}
        onChangeText={onChangeModel}
        placeholder="Model name"
        placeholderTextColor="#405060"
      />

      {provider === "anthropic" && (
        <>
          <Text style={styles.sectionTitle}>API Key</Text>
          <TextInput
            style={styles.textField}
            value={apiKey}
            onChangeText={onChangeApiKey}
            placeholder="sk-ant-..."
            placeholderTextColor="#405060"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
        </>
      )}
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
            <Text style={[styles.radioText, draft.approvalPreset === key && styles.radioTextActive]}>
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
          placeholderTextColor="#405060"
        />
      </View>

      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>Reject secrets</Text>
        <Switch
          value={draft.rejectSecrets}
          onValueChange={(v) => onUpdate({ rejectSecrets: v })}
          trackColor={{ false: "#1a2030", true: "#2a4060" }}
          thumbColor={draft.rejectSecrets ? "#c0d0e0" : "#607080"}
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
          placeholderTextColor="#405060"
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
  onLinkDevice,
}: {
  motebitId: string;
  deviceId: string;
  publicKey: string;
  onExport: () => void;
  onLinkDevice?: () => void;
}) {
  const copyToClipboard = (value: string) => {
    Clipboard.setString(value);
    Alert.alert("Copied", "Value copied to clipboard");
  };

  return (
    <View>
      <Text style={styles.sectionTitle}>Motebit ID</Text>
      <TouchableOpacity onPress={() => copyToClipboard(motebitId)}>
        <Text style={styles.monoValue} numberOfLines={1}>{motebitId}</Text>
      </TouchableOpacity>

      <Text style={styles.sectionTitle}>Device ID</Text>
      <TouchableOpacity onPress={() => copyToClipboard(deviceId)}>
        <Text style={styles.monoValue} numberOfLines={1}>{deviceId}</Text>
      </TouchableOpacity>

      <Text style={styles.sectionTitle}>Public Key</Text>
      <TouchableOpacity onPress={() => copyToClipboard(publicKey)}>
        <Text style={styles.monoValue} numberOfLines={2}>{publicKey || "(not generated)"}</Text>
      </TouchableOpacity>

      <Text style={styles.hint}>Tap any field to copy to clipboard.</Text>

      {onLinkDevice && (
        <TouchableOpacity style={styles.linkDeviceButton} onPress={onLinkDevice} activeOpacity={0.7}>
          <Text style={styles.linkDeviceText}>Link Another Device</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity style={styles.exportButton} onPress={onExport} activeOpacity={0.7}>
        <Text style={styles.exportText}>Export All Data</Text>
      </TouchableOpacity>
    </View>
  );
}

// === Styles ===

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0a0a0a",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: Platform.OS === "ios" ? 56 : 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#1a2030",
  },
  cancelBtn: { color: "#607080", fontSize: 16 },
  headerTitle: { color: "#c0d0e0", fontSize: 17, fontWeight: "600" },
  saveBtn: { color: "#4080c0", fontSize: 16, fontWeight: "600" },

  tabBar: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingTop: 12,
    gap: 4,
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: "center",
  },
  tabActive: {
    backgroundColor: "#1a2030",
  },
  tabText: {
    color: "#506070",
    fontSize: 12,
    fontWeight: "600",
  },
  tabTextActive: {
    color: "#c0d0e0",
  },

  body: { flex: 1 },
  bodyContent: { padding: 20 },

  sectionTitle: {
    color: "#607080",
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 20,
    marginBottom: 10,
  },

  // Appearance
  presetGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 14,
    justifyContent: "center",
  },
  presetCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 2,
    borderColor: "transparent",
    justifyContent: "center",
    alignItems: "center",
  },
  presetSelected: {
    borderColor: "#4080c0",
  },
  presetCheck: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "#4080c0",
  },
  presetLabel: {
    color: "#607080",
    fontSize: 14,
    textAlign: "center",
    marginTop: 12,
    textTransform: "capitalize",
  },

  // Radio
  radioGroup: { gap: 8 },
  radioItem: {
    backgroundColor: "#0f1820",
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: "#1a2030",
  },
  radioActive: {
    borderColor: "#4080c0",
    backgroundColor: "#0f1a28",
  },
  radioText: { color: "#8098b0", fontSize: 15, fontWeight: "600" },
  radioTextActive: { color: "#c0d0e0" },
  radioDesc: { color: "#506070", fontSize: 12, marginTop: 2 },

  // Fields
  textField: {
    backgroundColor: "#0f1820",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: "#c0d0e0",
    fontSize: 15,
  },
  fieldRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginVertical: 6,
  },
  fieldLabel: { color: "#8098b0", fontSize: 14 },
  numberField: {
    backgroundColor: "#0f1820",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: "#c0d0e0",
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
  switchLabel: { color: "#8098b0", fontSize: 14 },

  // Pin
  pinButton: {
    backgroundColor: "#1a2030",
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  pinButtonText: { color: "#4080c0", fontSize: 14, fontWeight: "600" },

  // Identity
  monoValue: {
    color: "#8098b0",
    fontSize: 13,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    backgroundColor: "#0f1820",
    borderRadius: 8,
    padding: 12,
    overflow: "hidden",
  },
  hint: {
    color: "#405060",
    fontSize: 11,
    textAlign: "center",
    marginTop: 8,
  },
  linkDeviceButton: {
    backgroundColor: "#1a2838",
    borderRadius: 10,
    paddingVertical: 14,
    marginTop: 20,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#2a4060",
  },
  linkDeviceText: { color: "#4080c0", fontSize: 15, fontWeight: "600" },
  exportButton: {
    backgroundColor: "#1a2030",
    borderRadius: 10,
    paddingVertical: 14,
    marginTop: 12,
    alignItems: "center",
  },
  exportText: { color: "#4080c0", fontSize: 15, fontWeight: "600" },
});
