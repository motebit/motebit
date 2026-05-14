import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { useTheme, type ThemeColors } from "../theme";
import {
  createGoalsController,
  type GoalsFetchAdapter,
  type GoalsState,
  type GoalMode,
  type ScheduledGoal,
} from "@motebit/panels";

const INTERVAL_OPTIONS: { label: string; ms: number }[] = [
  { label: "Hourly", ms: 3_600_000 },
  { label: "Daily", ms: 86_400_000 },
  { label: "Weekly", ms: 604_800_000 },
];

// v1 axis of the bounded-commitment envelope per
// docs/doctrine/panel-temporal-registers.md §"Bounded commitment is
// multi-dimensional." `null` = no cap. The chip label is named for
// what the user sees ("No cap"), not the numeric value.
const BUDGET_OPTIONS: { label: string; tokens: number | null }[] = [
  { label: "10k", tokens: 10_000 },
  { label: "50k", tokens: 50_000 },
  { label: "200k", tokens: 200_000 },
  { label: "No cap", tokens: null },
];

function formatInterval(ms: number): string {
  if (ms <= 3_600_000) return "Hourly";
  if (ms <= 86_400_000) return "Daily";
  if (ms <= 604_800_000) return "Weekly";
  return `${Math.round(ms / 86_400_000)}d`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
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

function createMobileGoalsAdapter(app: MobileApp): GoalsFetchAdapter {
  const identity = app.getIdentityInfo();
  // Mobile's GoalStore is synchronous; the adapter wraps each method in a
  // resolved promise to match the async controller contract without adding
  // `async` ceremony that would trip @typescript-eslint/require-await.
  return {
    listGoals: () => {
      const store = app.getGoalStore();
      if (!store) return Promise.resolve([]);
      // Project the persistence-shaped Goal into the panel's
      // ScheduledGoal shape, summing spent_tokens per goal so the
      // budget envelope renders without a second query.
      //
      // Phase 2 of the goal-results arc (`docs/doctrine/goal-results.md`
      // §"The three categories"): the latest outcome's `summary`
      // becomes `last_response_preview` (card-meta) and its
      // `response_full` becomes `last_response_full` (the artifact,
      // available for the longer card-detail preview today and the
      // signed `ContentArtifactManifest` path in the Phase-3 sibling
      // commit). Latest-outcome semantic — a failed fire's NULL
      // summary projects as absent so the most-recent visible signal
      // stays honest.
      const goals = store.listGoals(identity.motebitId).map((g): ScheduledGoal => {
        const spent = store.getSpentTokens(g.goal_id);
        const latest = store.getLatestOutcome(g.goal_id);
        return {
          ...(g as unknown as ScheduledGoal),
          budget_tokens: g.budget_tokens,
          spent_tokens: spent,
          last_response_preview: latest?.summary ?? null,
          last_response_full: latest?.response_full ?? null,
        };
      });
      return Promise.resolve(goals);
    },
    addGoal: (input) => {
      const store = app.getGoalStore();
      if (store)
        store.addGoal(
          identity.motebitId,
          input.prompt,
          input.interval_ms,
          input.mode,
          input.budget_tokens ?? null,
        );
      return Promise.resolve();
    },
    setEnabled: (goalId, enabled) => {
      const store = app.getGoalStore();
      if (store) store.toggleGoal(goalId, enabled);
      return Promise.resolve();
    },
    setBudgetTokens: (goalId, budgetTokens) => {
      const store = app.getGoalStore();
      if (store) store.setBudgetTokens(goalId, budgetTokens);
      return Promise.resolve();
    },
    removeGoal: (goalId) => {
      const store = app.getGoalStore();
      if (store) store.removeGoal(goalId);
      return Promise.resolve();
    },
  };
}

export function GoalsPanel({ visible, app, onClose }: GoalsPanelProps): React.ReactElement {
  const colors = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [newPrompt, setNewPrompt] = useState("");
  const [newIntervalIdx, setNewIntervalIdx] = useState(0);
  const [newMode, setNewMode] = useState<GoalMode>("recurring");
  // Defaults: 50k tokens (idx 1) matches web + desktop defaults so the
  // commitment envelope is sized identically across surfaces.
  const [newBudgetIdx, setNewBudgetIdx] = useState(1);

  const ctrlRef = useRef<ReturnType<typeof createGoalsController> | null>(null);
  const [state, setState] = useState<GoalsState>(() => ({
    goals: [],
    loading: false,
    error: null,
  }));

  useEffect(() => {
    const ctrl = createGoalsController(createMobileGoalsAdapter(app));
    ctrlRef.current = ctrl;
    const unsubscribe = ctrl.subscribe(setState);
    return () => {
      unsubscribe();
      ctrl.dispose();
      ctrlRef.current = null;
    };
  }, [app]);

  useEffect(() => {
    if (!visible) return;
    void ctrlRef.current?.refresh();
  }, [visible]);

  const goalStore = app.getGoalStore();

  const handleAdd = (): void => {
    const prompt = newPrompt.trim();
    if (!prompt) return;
    const interval = INTERVAL_OPTIONS[newIntervalIdx];
    if (!interval) return;
    const budget = BUDGET_OPTIONS[newBudgetIdx];
    void ctrlRef.current
      ?.addGoal({
        prompt,
        interval_ms: interval.ms,
        mode: newMode,
        budget_tokens: budget?.tokens ?? null,
      })
      .then(() => setNewPrompt(""));
  };

  const handleRaiseCap = (goal: ScheduledGoal): void => {
    const cap = goal.budget_tokens;
    if (cap == null) return;
    void ctrlRef.current?.setBudgetTokens?.(goal.goal_id, cap * 2);
  };

  const handleRemove = (goalId: string): void => {
    Alert.alert("Remove Goal", "Are you sure you want to delete this goal?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => void ctrlRef.current?.removeGoal(goalId),
      },
    ]);
  };

  const renderGoal = ({ item: goal }: { item: ScheduledGoal }): React.ReactElement => {
    const cap = goal.budget_tokens;
    const spent = goal.spent_tokens ?? 0;
    const exhausted = goal.status === "budget_exhausted";
    const ratio = cap != null && cap > 0 ? Math.min(spent / cap, 1.2) : 0;
    const fillPct = Math.min(ratio * 100, 100);
    const fillColor =
      ratio >= 1 ? colors.statusError : ratio >= 0.8 ? "#f59e0b" : colors.accentSoft;

    return (
      <View style={styles.goalRow}>
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
                (goal.status === "paused" ||
                  goal.status === "failed" ||
                  goal.status === "budget_exhausted") &&
                  styles.goalMetaWarning,
              ]}
            >
              {goal.status}
            </Text>
            {goal.last_run_at != null ? (
              <Text style={styles.goalMetaText}>ran {formatTimeAgo(goal.last_run_at)}</Text>
            ) : null}
            {goal.consecutive_failures != null && goal.consecutive_failures > 0 ? (
              <Text style={styles.goalMetaWarning}>
                {goal.consecutive_failures}/{goal.max_retries ?? "?"} failures
              </Text>
            ) : null}
          </View>
          {/* Budget envelope — runtime-register commitment cap.
              Axis-native unit is the headline ("12k / 50k tokens"),
              never cost. Doctrine: panel-temporal-registers.md
              §"Bounded commitment is multi-dimensional." */}
          {cap != null ? (
            <View style={styles.budgetEnvelope}>
              <Text
                style={[styles.budgetLabel, exhausted && styles.budgetLabelExhausted]}
                numberOfLines={1}
              >
                {exhausted
                  ? "Token budget exhausted"
                  : `${formatTokens(spent)} / ${formatTokens(cap)} tokens`}
              </Text>
              <View style={styles.budgetBar}>
                <View
                  style={[styles.budgetFill, { width: `${fillPct}%`, backgroundColor: fillColor }]}
                />
              </View>
              {exhausted ? (
                <TouchableOpacity
                  style={styles.raiseCapBtn}
                  onPress={() => handleRaiseCap(goal)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.raiseCapText}>Raise to {formatTokens(cap * 2)}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          ) : null}
        </View>
        <View style={styles.goalActions}>
          <Switch
            value={goal.enabled ?? goal.status === "active"}
            onValueChange={(v) => void ctrlRef.current?.setEnabled(goal.goal_id, v)}
            trackColor={{ false: colors.buttonSecondaryBg, true: colors.accentSoft }}
            thumbColor={
              (goal.enabled ?? goal.status === "active") ? colors.textPrimary : colors.textMuted
            }
            disabled={exhausted}
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
    );
  };

  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent>
      <View style={styles.backdrop}>
        <View style={styles.panel}>
          <View style={styles.header}>
            <Text style={styles.title}>Goals</Text>
            <View style={styles.headerRight}>
              <Text style={styles.countBadge}>{state.goals.length}</Text>
              <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
                <Text style={styles.closeButton}>Done</Text>
              </TouchableOpacity>
            </View>
          </View>

          {state.goals.length === 0 ? (
            <Text style={styles.emptyText}>
              {goalStore
                ? "Commit motebit to a goal · describe one below"
                : "Goal store not available."}
            </Text>
          ) : (
            <FlatList
              data={state.goals}
              keyExtractor={(g) => g.goal_id}
              renderItem={renderGoal}
              style={styles.list}
              contentContainerStyle={styles.listContent}
            />
          )}

          {goalStore && (
            <View style={styles.addForm}>
              <TextInput
                style={styles.promptInput}
                value={newPrompt}
                onChangeText={setNewPrompt}
                placeholder="What should the goal do?"
                placeholderTextColor={colors.inputPlaceholder}
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
                    <Text
                      style={[styles.chipText, newIntervalIdx === idx && styles.chipTextActive]}
                    >
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
              {/* Token-budget chips — runtime register's commitment cap
                  declared at create time, not buried in settings.
                  Doctrine: panel-temporal-registers.md §"Bounded
                  commitment is multi-dimensional." */}
              <View style={styles.optionsRow}>
                <Text style={styles.budgetFieldLabel}>Budget</Text>
                {BUDGET_OPTIONS.map((opt, idx) => (
                  <TouchableOpacity
                    key={opt.label}
                    style={[styles.chip, newBudgetIdx === idx && styles.chipActive]}
                    onPress={() => setNewBudgetIdx(idx)}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.chipText, newBudgetIdx === idx && styles.chipTextActive]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TouchableOpacity
                style={[styles.addButton, !newPrompt.trim() && styles.addButtonDisabled]}
                onPress={handleAdd}
                disabled={!newPrompt.trim()}
                activeOpacity={0.7}
              >
                <Text style={styles.addButtonText}>Commit goal</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: c.overlayBg, justifyContent: "flex-end" },
    panel: {
      backgroundColor: c.bgPrimary,
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
      borderBottomColor: c.borderPrimary,
    },
    title: { color: c.textPrimary, fontSize: 18, fontWeight: "600" },
    headerRight: { flexDirection: "row", alignItems: "center", gap: 12 },
    countBadge: {
      color: c.textMuted,
      fontSize: 13,
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    },
    closeButton: { color: c.accent, fontSize: 16, fontWeight: "600" },
    emptyText: {
      color: c.textMuted,
      fontSize: 13,
      fontStyle: "italic",
      textAlign: "center",
      marginVertical: 24,
    },
    list: { flexGrow: 0 },
    listContent: { paddingHorizontal: 16, paddingVertical: 8 },
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
    addForm: {
      paddingHorizontal: 16,
      paddingTop: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.borderPrimary,
    },
    promptInput: {
      backgroundColor: c.inputBg,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      color: c.inputText,
      fontSize: 14,
      borderWidth: 1,
      borderColor: c.borderInput,
      minHeight: 48,
    },
    optionsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
    chip: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 8,
      backgroundColor: c.bgSecondary,
      borderWidth: 1,
      borderColor: c.borderPrimary,
    },
    chipActive: { borderColor: c.accent, backgroundColor: c.accentSoft },
    chipText: { color: c.textSecondary, fontSize: 13, fontWeight: "600" },
    chipTextActive: { color: c.textPrimary },
    addButton: {
      backgroundColor: c.buttonPrimaryBg,
      borderRadius: 10,
      paddingVertical: 14,
      marginTop: 12,
      alignItems: "center",
    },
    addButtonDisabled: { opacity: 0.4 },
    addButtonText: { color: c.buttonPrimaryText, fontSize: 15, fontWeight: "600" },
    // Budget envelope render — axis-native unit headline + thin
    // progress bar + raise-cap CTA on exhaustion. Mirrors the web +
    // desktop visual rhythm.
    budgetEnvelope: { marginTop: 8 },
    budgetLabel: {
      color: c.textMuted,
      fontSize: 11,
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
      marginBottom: 4,
    },
    budgetLabelExhausted: { color: c.statusError },
    budgetBar: {
      height: 3,
      borderRadius: 2,
      backgroundColor: c.bgSecondary,
      overflow: "hidden",
    },
    budgetFill: { height: "100%", borderRadius: 2 },
    raiseCapBtn: {
      marginTop: 8,
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: 8,
      backgroundColor: c.accentSoft,
      alignSelf: "flex-start",
    },
    raiseCapText: { color: c.buttonPrimaryText, fontSize: 12, fontWeight: "600" },
    budgetFieldLabel: {
      color: c.textMuted,
      fontSize: 11,
      letterSpacing: 0.5,
      fontWeight: "600",
      textTransform: "uppercase",
      alignSelf: "center",
      marginRight: 4,
    },
  });
}
