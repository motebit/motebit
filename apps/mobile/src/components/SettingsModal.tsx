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
import type { Goal, GoalMode } from "../adapters/expo-sqlite";

type Tab = "appearance" | "intelligence" | "governance" | "goals" | "sync" | "identity";

const TABS: { key: Tab; label: string }[] = [
  { key: "appearance", label: "Appearance" },
  { key: "intelligence", label: "Intelligence" },
  { key: "governance", label: "Governance" },
  { key: "goals", label: "Goals" },
  { key: "sync", label: "Sync" },
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
  syncStatus?: "idle" | "syncing" | "error" | "offline";
  lastSyncTime?: number;
  onSave: (settings: MobileSettings, aiConfig?: MobileAIConfig) => void;
  onClose: () => void;
  onRequestPin: (mode: "setup" | "verify" | "reset") => void;
  onLinkDevice?: () => void;
  onSyncNow?: () => void;
  onDisconnectSync?: () => void;
}

export function SettingsModal({
  visible,
  app,
  settings,
  syncStatus,
  lastSyncTime,
  onSave,
  onClose,
  onRequestPin,
  onLinkDevice,
  onSyncNow,
  onDisconnectSync,
}: SettingsModalProps): React.ReactElement {
  const [tab, setTab] = useState<Tab>("appearance");
  const [draft, setDraft] = useState<MobileSettings>(settings);
  const [apiKey, setApiKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");

  // Sync draft when settings change or modal opens
  useEffect(() => {
    setDraft(settings);
    // Load stored API keys
    void SecureStore.getItemAsync("motebit_anthropic_api_key").then((k) => {
      if (k) setApiKey(k);
    });
    void SecureStore.getItemAsync("motebit_openai_api_key").then((k) => {
      if (k) setOpenaiKey(k);
    });
  }, [settings, visible]);

  const updateDraft = useCallback((patch: Partial<MobileSettings>) => {
    setDraft((d) => ({ ...d, ...patch }));
  }, []);

  const handleSave = useCallback(async () => {
    // Store API keys securely (not in AsyncStorage)
    if (draft.provider === "anthropic" && apiKey) {
      await SecureStore.setItemAsync("motebit_anthropic_api_key", apiKey);
    }
    if (openaiKey) {
      await SecureStore.setItemAsync("motebit_openai_api_key", openaiKey);
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

    // Build AI config if provider, model, or endpoint changed
    let aiConfig: MobileAIConfig | undefined;
    if (draft.provider !== settings.provider || draft.model !== settings.model || draft.ollamaEndpoint !== settings.ollamaEndpoint) {
      aiConfig = {
        provider: draft.provider,
        model: draft.model,
        apiKey: draft.provider === "anthropic" ? apiKey : undefined,
        ollamaEndpoint: draft.provider === "ollama" ? draft.ollamaEndpoint : undefined,
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
                app.setInteriorColor(preset);
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
              openaiKey={openaiKey}
              onChangeProvider={(p) => updateDraft({ provider: p, model: p === "ollama" ? "llama3.2" : "claude-sonnet-4-20250514" })}
              onChangeModel={(m) => updateDraft({ model: m })}
              onChangeApiKey={setApiKey}
              onChangeOllamaEndpoint={(e) => updateDraft({ ollamaEndpoint: e })}
              onChangeVoiceEnabled={(v) => updateDraft({ voiceEnabled: v })}
              onChangeOpenaiKey={setOpenaiKey}
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
          {tab === "goals" && (
            <GoalsTab app={app} />
          )}
          {tab === "sync" && (
            <SyncTab
              syncStatus={syncStatus ?? "offline"}
              lastSyncTime={lastSyncTime ?? 0}
              app={app}
              onSyncNow={onSyncNow}
              onDisconnect={onDisconnectSync}
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
  ollamaEndpoint,
  voiceEnabled,
  openaiKey,
  onChangeProvider,
  onChangeModel,
  onChangeApiKey,
  onChangeOllamaEndpoint,
  onChangeVoiceEnabled,
  onChangeOpenaiKey,
}: {
  provider: "ollama" | "anthropic";
  model: string;
  apiKey: string;
  ollamaEndpoint: string;
  voiceEnabled: boolean;
  openaiKey: string;
  onChangeProvider: (p: "ollama" | "anthropic") => void;
  onChangeModel: (m: string) => void;
  onChangeApiKey: (k: string) => void;
  onChangeOllamaEndpoint: (e: string) => void;
  onChangeVoiceEnabled: (v: boolean) => void;
  onChangeOpenaiKey: (k: string) => void;
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

      {provider === "ollama" && (
        <>
          <Text style={styles.sectionTitle}>Endpoint URL</Text>
          <TextInput
            style={styles.textField}
            value={ollamaEndpoint}
            onChangeText={onChangeOllamaEndpoint}
            placeholder="http://localhost:11434"
            placeholderTextColor="#405060"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </>
      )}

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

      <Text style={styles.sectionTitle}>Voice</Text>
      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>Voice responses</Text>
        <Switch
          value={voiceEnabled}
          onValueChange={onChangeVoiceEnabled}
          trackColor={{ false: "#1a2030", true: "#2a4060" }}
          thumbColor={voiceEnabled ? "#c0d0e0" : "#607080"}
        />
      </View>
      <Text style={styles.voiceHint}>Speak assistant replies aloud using system TTS</Text>

      <Text style={styles.sectionTitle}>OpenAI API Key (Whisper STT)</Text>
      <TextInput
        style={styles.textField}
        value={openaiKey}
        onChangeText={onChangeOpenaiKey}
        placeholder="sk-..."
        placeholderTextColor="#405060"
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Text style={styles.voiceHint}>Required for voice input (mic button). Uses Whisper API for transcription.</Text>
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
  const [syncUrl, setSyncUrl] = useState<string | null>(null);

  useEffect(() => {
    void app.getSyncUrl().then(setSyncUrl);
  }, [app]);

  const statusLabel = syncStatus === "idle" ? "Connected"
    : syncStatus === "syncing" ? "Syncing..."
    : syncStatus === "error" ? "Error"
    : "Not connected";

  const statusColor = syncStatus === "idle" ? "#4ade80"
    : syncStatus === "syncing" ? "#4080c0"
    : syncStatus === "error" ? "#c04040"
    : "#506070";

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

      {syncUrl && (
        <>
          <Text style={styles.sectionTitle}>Relay</Text>
          <Text style={styles.monoValue} numberOfLines={1}>{syncUrl}</Text>
        </>
      )}

      {syncUrl && onSyncNow && (
        <TouchableOpacity
          style={[styles.syncActionButton, syncStatus === "syncing" && styles.syncActionDisabled]}
          onPress={onSyncNow}
          disabled={syncStatus === "syncing"}
          activeOpacity={0.7}
        >
          <Text style={styles.syncActionText}>Sync Now</Text>
        </TouchableOpacity>
      )}

      {syncUrl && onDisconnect && (
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

      {!syncUrl && (
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

// === Goals Tab ===

function GoalsTab({ app }: { app: MobileApp }) {
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

  const handleToggle = useCallback((goalId: string, enabled: boolean) => {
    if (!goalStore) return;
    goalStore.toggleGoal(goalId, enabled);
    refreshGoals();
  }, [goalStore, refreshGoals]);

  const handleRemove = useCallback((goalId: string) => {
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
  }, [goalStore, refreshGoals]);

  if (!goalStore) {
    return (
      <View>
        <Text style={styles.sectionTitle}>Goals</Text>
        <Text style={styles.goalEmptyText}>Goal store not available. Bootstrap identity first.</Text>
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
              <Text style={styles.goalPrompt} numberOfLines={2}>{goal.prompt}</Text>
              <View style={styles.goalMeta}>
                <Text style={styles.goalMetaText}>{formatInterval(goal.interval_ms)}</Text>
                <Text style={styles.goalMetaText}>{goal.mode}</Text>
                <Text style={[
                  styles.goalMetaText,
                  goal.status === "paused" && styles.goalMetaWarning,
                  goal.status === "failed" && styles.goalMetaWarning,
                ]}>
                  {goal.status}
                </Text>
                {goal.last_run_at ? (
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
                trackColor={{ false: "#1a2030", true: "#2a4060" }}
                thumbColor={goal.enabled ? "#c0d0e0" : "#607080"}
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
        placeholderTextColor="#405060"
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
          <Text style={[styles.radioText, newMode === "recurring" && styles.radioTextActive]}>Recurring</Text>
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
  voiceHint: { color: "#405060", fontSize: 11, marginTop: 4, marginBottom: 4 },

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

  // Sync
  syncStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  syncStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  syncStatusLabel: {
    fontSize: 15,
    fontWeight: "600",
  },
  syncLastTime: {
    color: "#506070",
    fontSize: 12,
    marginBottom: 8,
  },
  syncActionButton: {
    backgroundColor: "#2a4060",
    borderRadius: 10,
    paddingVertical: 14,
    marginTop: 16,
    alignItems: "center",
  },
  syncActionDisabled: {
    opacity: 0.5,
  },
  syncActionText: {
    color: "#c0d0e0",
    fontSize: 15,
    fontWeight: "600",
  },
  syncDisconnectButton: {
    backgroundColor: "#1a2030",
    borderRadius: 10,
    paddingVertical: 14,
    marginTop: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#2a1518",
  },
  syncDisconnectText: {
    color: "#c07040",
    fontSize: 15,
    fontWeight: "600",
  },
  syncHint: {
    color: "#405060",
    fontSize: 13,
    fontStyle: "italic",
    textAlign: "center",
    marginTop: 20,
  },

  // Goals
  goalEmptyText: {
    color: "#506070",
    fontSize: 13,
    fontStyle: "italic",
    textAlign: "center",
    marginVertical: 12,
  },
  goalRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0f1820",
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "#1a2030",
  },
  goalInfo: {
    flex: 1,
    marginRight: 10,
  },
  goalPrompt: {
    color: "#c0d0e0",
    fontSize: 14,
    marginBottom: 4,
  },
  goalMeta: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  goalMetaText: {
    color: "#506070",
    fontSize: 11,
  },
  goalMetaWarning: {
    color: "#c07040",
    fontSize: 11,
    fontWeight: "600",
  },
  goalActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  goalDeleteBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#2a1518",
    justifyContent: "center",
    alignItems: "center",
  },
  goalDeleteText: {
    color: "#d04050",
    fontSize: 12,
    fontWeight: "700",
  },
  goalAddBtn: {
    backgroundColor: "#2a4060",
    borderRadius: 10,
    paddingVertical: 14,
    marginTop: 16,
    alignItems: "center",
  },
  goalAddBtnDisabled: {
    opacity: 0.4,
  },
  goalAddBtnText: {
    color: "#c0d0e0",
    fontSize: 15,
    fontWeight: "600",
  },
});
