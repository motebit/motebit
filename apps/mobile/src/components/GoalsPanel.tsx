import React, { useCallback, useEffect, useState } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  Switch,
  StyleSheet,
  Platform,
  Alert,
} from "react-native";
import type { MobileApp } from "../mobile-app";
import type { Goal, GoalMode } from "../adapters/expo-sqlite";

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

interface GoalsPanelProps {
  visible: boolean;
  app: MobileApp;
  onClose: () => void;
}

export function GoalsPanel({ visible, app, onClose }: GoalsPanelProps): React.ReactElement {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [newPrompt, setNewPrompt] = useState("");
  const [newIntervalIdx, setNewIntervalIdx] = useState(0);
  const [newMode, setNewMode] = useState<GoalMode>("recurring");

  const goalStore = app.getGoalStore();
  const identity = app.getIdentityInfo();

  const refresh = useCallback(() => {
    if (!goalStore) return;
    setGoals(goalStore.listGoals(identity.motebitId));
  }, [goalStore, identity.motebitId]);

  useEffect(() => {
    if (visible) refresh();
  }, [visible, refresh]);

  const handleAdd = useCallback(() => {
    const prompt = newPrompt.trim();
    if (!prompt || !goalStore) return;
    const interval = INTERVAL_OPTIONS[newIntervalIdx];
    if (!interval) return;
    goalStore.addGoal(identity.motebitId, prompt, interval.ms, newMode);
    setNewPrompt("");
    refresh();
  }, [newPrompt, newIntervalIdx, newMode, goalStore, identity.motebitId, refresh]);

  const handleToggle = useCallback((goalId: string, enabled: boolean) => {
    if (!goalStore) return;
    goalStore.toggleGoal(goalId, enabled);
    refresh();
  }, [goalStore, refresh]);

  const handleRemove = useCallback((goalId: string) => {
    Alert.alert("Remove Goal", "Are you sure you want to delete this goal?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          if (!goalStore) return;
          goalStore.removeGoal(goalId);
          refresh();
        },
      },
    ]);
  }, [goalStore, refresh]);

  const renderGoal = useCallback(({ item: goal }: { item: Goal }) => (
    <View style={styles.goalRow}>
      <View style={styles.goalInfo}>
        <Text style={styles.goalPrompt} numberOfLines={2}>{goal.prompt}</Text>
        <View style={styles.goalMeta}>
          <Text style={styles.goalMetaText}>{formatInterval(goal.interval_ms)}</Text>
          <Text style={styles.goalMetaText}>{goal.mode}</Text>
          <Text style={[
            styles.goalMetaText,
            (goal.status === "paused" || goal.status === "failed") && styles.goalMetaWarning,
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
  ), [handleToggle, handleRemove]);

  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent>
      <View style={styles.backdrop}>
        <View style={styles.panel}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>Goals</Text>
            <View style={styles.headerRight}>
              <Text style={styles.countBadge}>{goals.length}</Text>
              <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
                <Text style={styles.closeButton}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Goal list */}
          {goals.length === 0 ? (
            <Text style={styles.emptyText}>
              {goalStore ? "No goals yet. Add one below." : "Goal store not available."}
            </Text>
          ) : (
            <FlatList
              data={goals}
              keyExtractor={(g) => g.goal_id}
              renderItem={renderGoal}
              style={styles.list}
              contentContainerStyle={styles.listContent}
            />
          )}

          {/* Add form */}
          {goalStore && (
            <View style={styles.addForm}>
              <TextInput
                style={styles.promptInput}
                value={newPrompt}
                onChangeText={setNewPrompt}
                placeholder="What should the goal do?"
                placeholderTextColor="#405060"
                multiline
                numberOfLines={2}
              />
              <View style={styles.optionsRow}>
                {INTERVAL_OPTIONS.map((opt, idx) => (
                  <TouchableOpacity
                    key={opt.label}
                    style={[styles.chip, newIntervalIdx === idx && styles.chipActive]}
                    onPress={() => setNewIntervalIdx(idx)}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.chipText, newIntervalIdx === idx && styles.chipTextActive]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity
                  style={[styles.chip, newMode === "once" && styles.chipActive]}
                  onPress={() => setNewMode(newMode === "once" ? "recurring" : "once")}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.chipText, newMode === "once" && styles.chipTextActive]}>
                    {newMode === "once" ? "Once" : "Recurring"}
                  </Text>
                </TouchableOpacity>
              </View>
              <TouchableOpacity
                style={[styles.addButton, !newPrompt.trim() && styles.addButtonDisabled]}
                onPress={handleAdd}
                disabled={!newPrompt.trim()}
                activeOpacity={0.7}
              >
                <Text style={styles.addButtonText}>Add Goal</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.85)",
    justifyContent: "flex-end",
  },
  panel: {
    backgroundColor: "#0a0a0a",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: "80%",
    paddingBottom: Platform.OS === "ios" ? 34 : 16,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#1a2030",
  },
  title: {
    color: "#c0d0e0",
    fontSize: 18,
    fontWeight: "600",
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  countBadge: {
    color: "#506070",
    fontSize: 13,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  closeButton: {
    color: "#4080c0",
    fontSize: 16,
    fontWeight: "600",
  },
  emptyText: {
    color: "#506070",
    fontSize: 13,
    fontStyle: "italic",
    textAlign: "center",
    marginVertical: 24,
  },
  list: {
    flexGrow: 0,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingVertical: 8,
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
  addForm: {
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#1a2030",
  },
  promptInput: {
    backgroundColor: "#0f1820",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: "#c0d0e0",
    fontSize: 14,
    borderWidth: 1,
    borderColor: "#1a2030",
    minHeight: 48,
  },
  optionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 10,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "#0f1820",
    borderWidth: 1,
    borderColor: "#1a2030",
  },
  chipActive: {
    borderColor: "#4080c0",
    backgroundColor: "#0f1a28",
  },
  chipText: {
    color: "#8098b0",
    fontSize: 13,
    fontWeight: "600",
  },
  chipTextActive: {
    color: "#c0d0e0",
  },
  addButton: {
    backgroundColor: "#2a4060",
    borderRadius: 10,
    paddingVertical: 14,
    marginTop: 12,
    alignItems: "center",
  },
  addButtonDisabled: {
    opacity: 0.4,
  },
  addButtonText: {
    color: "#c0d0e0",
    fontSize: 15,
    fontWeight: "600",
  },
});
