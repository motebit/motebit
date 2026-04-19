import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ActivityIndicator,
  Alert,
} from "react-native";
import type { MobileApp } from "../mobile-app";
import { useTheme, type ThemeColors } from "../theme";
import {
  createSovereignController,
  type CredentialEntry,
  type SovereignFetchAdapter,
  type SovereignFetchInit,
  type SovereignState,
  type SovereignTab,
} from "@motebit/panels";

const TYPE_COLORS: Record<string, string> = {
  reputation: "#4caf50",
  trust: "#ff9800",
  gradient: "#2196f3",
  capability: "#9c27b0",
};

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function resolveIssuer(cred: CredentialEntry["credential"]): string {
  const issuerRaw = cred["issuer"];
  if (issuerRaw == null) return "unknown";
  if (typeof issuerRaw === "string") {
    return issuerRaw.length > 28 ? issuerRaw.slice(0, 28) + "..." : issuerRaw;
  }
  const id =
    typeof issuerRaw === "object" && "id" in issuerRaw
      ? String((issuerRaw as Record<string, unknown>).id ?? "unknown")
      : "unknown";
  return id.length > 28 ? id.slice(0, 28) + "..." : id;
}

interface SovereignPanelProps {
  visible: boolean;
  app: MobileApp;
  onClose: () => void;
}

// Mobile's sync URL comes from AsyncStorage (async). The adapter's `syncUrl`
// getter is synchronous, so we cache the URL in a ref and prime it in the
// effect before calling refresh().
function createMobileAdapter(
  app: MobileApp,
  syncUrlRef: React.MutableRefObject<string | null>,
): SovereignFetchAdapter {
  return {
    get syncUrl() {
      return syncUrlRef.current;
    },
    get motebitId() {
      return app.motebitId !== "mobile-local" ? app.motebitId : null;
    },
    async fetch(path: string, init?: SovereignFetchInit) {
      const syncUrl = syncUrlRef.current;
      if (!syncUrl) throw new Error("No relay URL configured");
      const token = await app.createSyncToken();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      return fetch(`${syncUrl}${path}`, {
        method: init?.method ?? "GET",
        headers,
        body: init?.body != null ? JSON.stringify(init.body) : undefined,
      });
    },
    getSolanaAddress: () => app.getRuntime()?.getSolanaAddress?.() ?? null,
    getSolanaBalanceMicro: async () => {
      const runtime = app.getRuntime();
      const micro = await runtime?.getSolanaBalance?.();
      return micro != null ? Number(micro) : null;
    },
    getLocalCredentials: () => app.getLocalCredentials() as CredentialEntry[],
  };
}

export function SovereignPanel({ visible, app, onClose }: SovereignPanelProps): React.ReactElement {
  const colors = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [activeTab, setActiveTab] = useState<SovereignTab>("credentials");
  const [expandedGoalId, setExpandedGoalId] = useState<string | null>(null);
  const [sweepEditValue, setSweepEditValue] = useState<string | null>(null);

  const syncUrlRef = useRef<string | null>(null);
  const ctrlRef = useRef<ReturnType<typeof createSovereignController> | null>(null);

  // Initial state — the controller's emitted state replaces this as soon as
  // subscribe fires.
  const [state, setState] = useState<SovereignState>(() => ({
    activeTab: "credentials",
    credentials: [],
    revokedIds: new Set<string>(),
    balance: null,
    budget: null,
    sovereignAddress: null,
    sovereignBalanceUsdc: null,
    goals: [],
    ledgerDetails: new Map(),
    succession: null,
    presentation: null,
    verifyResult: null,
    loading: false,
    error: null,
  }));

  // One controller per SovereignPanel instance. Created on first open; torn
  // down on unmount.
  useEffect(() => {
    const adapter = createMobileAdapter(app, syncUrlRef);
    const ctrl = createSovereignController(adapter);
    ctrlRef.current = ctrl;
    const unsubscribe = ctrl.subscribe(setState);
    return () => {
      unsubscribe();
      ctrl.dispose();
      ctrlRef.current = null;
    };
  }, [app]);

  // Prime sync URL + refresh when the modal opens.
  useEffect(() => {
    if (!visible) return;
    void (async () => {
      syncUrlRef.current = await app.getSyncUrl();
      await ctrlRef.current?.refresh();
    })();
  }, [visible, app]);

  const commitSweepFromUi = useCallback(
    async (thresholdMicro: number | null, addressOverride: string | undefined) => {
      const ctrl = ctrlRef.current;
      if (!ctrl) return;
      const before = ctrl.getState().error;
      await ctrl.commitSweep(thresholdMicro, addressOverride);
      const s = ctrl.getState();
      if (s.error && s.error !== before) {
        Alert.alert("Sweep update failed", s.error);
      }
      setSweepEditValue(null);
    },
    [],
  );

  const loadGoalDetail = useCallback(async (goalId: string) => {
    await ctrlRef.current?.loadLedgerDetail(goalId);
  }, []);

  // Count by type for the badge row
  const typeCounts: Record<string, number> = {};
  for (const c of state.credentials) {
    typeCounts[c.credential_type] = (typeCounts[c.credential_type] ?? 0) + 1;
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerTitle}>Sovereign</Text>
          </View>
          <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
            <Text style={styles.closeBtn}>Done</Text>
          </TouchableOpacity>
        </View>
        <View style={styles.tabBar}>
          {(["credentials", "ledger", "budget", "succession"] as SovereignTab[]).map((tab) => (
            <TouchableOpacity
              key={tab}
              style={[styles.tab, activeTab === tab && styles.tabActive]}
              onPress={() => setActiveTab(tab)}
              activeOpacity={0.7}
            >
              <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {state.loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="small" color={colors.accent} />
          </View>
        ) : activeTab === "credentials" ? (
          <FlatList
            data={state.credentials}
            keyExtractor={(item) => item.credential_id}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            ListHeaderComponent={
              Object.keys(typeCounts).length > 0 ? (
                <View style={styles.badgeRow}>
                  {Object.entries(typeCounts).map(([type, count]) => {
                    const color = TYPE_COLORS[type] ?? "#616161";
                    return (
                      <View key={type} style={[styles.typeBadge, { borderColor: color }]}>
                        <Text style={[styles.typeBadgeText, { color }]}>
                          {type}: {count}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              ) : null
            }
            renderItem={({ item }) => {
              const color = TYPE_COLORS[item.credential_type] ?? "#616161";
              const issuer = resolveIssuer(item.credential);
              const subjectField = item.credential["credentialSubject"];
              const rawSubjectId =
                typeof subjectField === "object" && subjectField != null
                  ? (subjectField as Record<string, unknown>)["id"]
                  : undefined;
              const subject =
                typeof rawSubjectId === "string" && rawSubjectId.length > 0
                  ? rawSubjectId.slice(0, 28) + "..."
                  : undefined;
              const isRevoked = state.revokedIds.has(item.credential_id);
              return (
                <View style={[styles.credentialItem, isRevoked ? { opacity: 0.5 } : undefined]}>
                  <View style={styles.credentialHeader}>
                    <Text style={styles.credentialId}>{item.credential_id.slice(0, 12)}...</Text>
                    {isRevoked && (
                      <View style={[styles.credentialTypeBadge, { borderColor: "#f44336" }]}>
                        <Text style={[styles.credentialTypeText, { color: "#f44336" }]}>
                          REVOKED
                        </Text>
                      </View>
                    )}
                    <View style={[styles.credentialTypeBadge, { borderColor: color }]}>
                      <Text style={[styles.credentialTypeText, { color }]}>
                        {item.credential_type}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.credentialMeta}>issuer: {issuer}</Text>
                  {subject ? <Text style={styles.credentialMeta}>subject: {subject}</Text> : null}
                  <Text style={styles.credentialMeta}>{formatTimeAgo(item.issued_at)}</Text>
                </View>
              );
            }}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyText}>No credentials yet.</Text>
              </View>
            }
          />
        ) : activeTab === "ledger" ? (
          <FlatList
            data={state.goals}
            keyExtractor={(item) => item.goal_id}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            renderItem={({ item: goal }) => {
              const isExpanded = expandedGoalId === goal.goal_id;
              const manifest = state.ledgerDetails.get(goal.goal_id);
              return (
                <View>
                  <TouchableOpacity
                    style={styles.ledgerItem}
                    onPress={() => {
                      setExpandedGoalId(isExpanded ? null : goal.goal_id);
                      if (!isExpanded && !manifest) void loadGoalDetail(goal.goal_id);
                    }}
                    activeOpacity={0.7}
                  >
                    <View style={styles.ledgerHeader}>
                      <Text style={styles.ledgerPrompt} numberOfLines={1}>
                        {goal.prompt}
                      </Text>
                      <View
                        style={[
                          styles.ledgerStatusBadge,
                          {
                            borderColor:
                              goal.status === "completed"
                                ? colors.statusSuccess
                                : goal.status === "failed"
                                  ? colors.statusError
                                  : colors.statusWarning,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.ledgerStatusText,
                            {
                              color:
                                goal.status === "completed"
                                  ? colors.statusSuccess
                                  : goal.status === "failed"
                                    ? colors.statusError
                                    : colors.statusWarning,
                            },
                          ]}
                        >
                          {goal.status}
                        </Text>
                      </View>
                    </View>
                    {manifest?.content_hash && (
                      <Text style={styles.credentialMeta}>
                        hash: {manifest.content_hash.slice(0, 16)}...
                      </Text>
                    )}
                  </TouchableOpacity>
                  {isExpanded && manifest?.timeline && manifest.timeline.length > 0 && (
                    <View style={styles.ledgerSteps}>
                      {manifest.timeline.map((event, idx) => (
                        <View key={idx} style={styles.ledgerStep}>
                          <Text style={styles.ledgerStepText}>
                            {event.description ?? event.type}
                          </Text>
                          <Text style={styles.credentialMeta}>
                            {event.type}
                            {event.timestamp != null ? ` — ${formatTimeAgo(event.timestamp)}` : ""}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              );
            }}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyText}>No completed goals yet.</Text>
              </View>
            }
          />
        ) : activeTab === "budget" ? (
          <FlatList
            data={state.budget?.allocations ?? []}
            keyExtractor={(item) => item.allocation_id}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            ListHeaderComponent={
              <BudgetHeader
                state={state}
                styles={styles}
                colors={colors}
                sweepEditValue={sweepEditValue}
                setSweepEditValue={setSweepEditValue}
                commitSweepFromUi={commitSweepFromUi}
              />
            }
            renderItem={({ item: a }) => (
              <View style={styles.allocationItem}>
                <Text style={styles.allocationId}>{a.allocation_id.slice(0, 10)}...</Text>
                <Text
                  style={[
                    styles.allocationStatus,
                    {
                      color:
                        a.settlement_status === "settled"
                          ? colors.statusSuccess
                          : colors.statusWarning,
                    },
                  ]}
                >
                  {a.status} ({a.amount_locked})
                </Text>
              </View>
            )}
            ListEmptyComponent={
              state.balance == null && state.budget == null ? (
                <View style={styles.emptyContainer}>
                  <Text style={styles.emptyText}>No budget data yet.</Text>
                </View>
              ) : null
            }
          />
        ) : (
          <FlatList
            data={state.succession?.chain ?? []}
            keyExtractor={(_, idx) => String(idx)}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            renderItem={({ item: record }) => (
              <View style={styles.successionItem}>
                <View style={styles.successionRow}>
                  <Text style={styles.successionLabel}>from</Text>
                  <Text style={styles.successionKey}>{record.old_public_key.slice(0, 16)}...</Text>
                </View>
                <View style={styles.successionRow}>
                  <Text style={styles.successionLabel}>to</Text>
                  <Text style={styles.successionKey}>{record.new_public_key.slice(0, 16)}...</Text>
                </View>
                {record.reason && (
                  <Text style={styles.credentialMeta}>reason: {record.reason}</Text>
                )}
                <Text style={styles.credentialMeta}>{formatTimeAgo(record.timestamp)}</Text>
              </View>
            )}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyText}>No key rotations.</Text>
              </View>
            }
          />
        )}
      </View>
    </Modal>
  );
}

// Extracted to keep the FlatList ListHeaderComponent inline expression short.
// Renders the two-balance block (sovereign reserve + operating) with the
// sweep inline editor and the budget metric row.
function BudgetHeader(props: {
  state: SovereignState;
  styles: ReturnType<typeof createStyles>;
  colors: ThemeColors;
  sweepEditValue: string | null;
  setSweepEditValue: (v: string | null) => void;
  commitSweepFromUi: (
    thresholdMicro: number | null,
    addressOverride: string | undefined,
  ) => Promise<void>;
}): React.ReactElement {
  const { state, styles, colors, sweepEditValue, setSweepEditValue, commitSweepFromUi } = props;
  const { balance, budget, sovereignAddress, sovereignBalanceUsdc } = state;

  const effectiveAddress = balance?.settlement_address ?? sovereignAddress;
  const thresholdDollars = balance?.sweep_threshold ?? null;
  const editing = sweepEditValue !== null;

  return (
    <>
      <View style={styles.budgetSection}>
        <Text style={styles.balanceLabel}>Sovereign reserve</Text>
        <View style={styles.balanceRow}>
          <Text style={styles.balanceAmount}>
            {sovereignBalanceUsdc != null
              ? sovereignBalanceUsdc.toFixed(2)
              : sovereignAddress
                ? "…"
                : "—"}
          </Text>
          <Text style={styles.balanceCurrency}>{sovereignAddress ? "USDC" : ""}</Text>
        </View>
        <Text style={styles.balanceNote}>
          {sovereignAddress ? "onchain USDC, yours" : "no wallet configured"}
        </Text>
      </View>
      {balance != null && (
        <View style={styles.budgetSection}>
          <Text style={styles.balanceLabel}>Operating balance</Text>
          <View style={styles.balanceRow}>
            <Text style={styles.balanceAmount}>{balance.balance.toFixed(2)}</Text>
            <Text style={styles.balanceCurrency}>{balance.currency ?? "USD"}</Text>
          </View>
          <Text style={styles.balanceNote}>
            relay ledger, instant settlement
            {balance.dispute_window_hold != null && balance.dispute_window_hold > 0
              ? ` · on hold ${balance.dispute_window_hold.toFixed(2)}`
              : ""}
          </Text>
          {effectiveAddress != null &&
            (editing ? (
              <View style={styles.sweepEditorRow}>
                <Text style={styles.sweepEditorPrefix}>Auto-sweep above $</Text>
                <TextInput
                  style={styles.sweepEditorInput}
                  value={sweepEditValue ?? ""}
                  onChangeText={setSweepEditValue}
                  keyboardType="decimal-pad"
                  placeholder="50"
                  autoFocus
                  onSubmitEditing={() => {
                    const n = Number(sweepEditValue);
                    if (!Number.isFinite(n) || n < 0) {
                      Alert.alert("Invalid threshold", "Must be non-negative number");
                      return;
                    }
                    const needsAddress = balance.settlement_address !== effectiveAddress;
                    void commitSweepFromUi(
                      Math.round(n * 1_000_000),
                      needsAddress ? effectiveAddress : undefined,
                    );
                  }}
                />
                <TouchableOpacity
                  onPress={() => setSweepEditValue(null)}
                  style={styles.sweepEditorCancel}
                >
                  <Text style={styles.sweepEditorCancelText}>cancel</Text>
                </TouchableOpacity>
              </View>
            ) : thresholdDollars != null ? (
              <View style={styles.sweepReadoutRow}>
                <Text style={styles.sweepReadout}>
                  Auto-sweep above ${thresholdDollars.toFixed(2)} → your sovereign wallet
                </Text>
                <TouchableOpacity
                  onPress={() => setSweepEditValue(String(thresholdDollars))}
                  style={styles.sweepActionBtn}
                >
                  <Text style={styles.sweepActionText}>edit</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => void commitSweepFromUi(null, undefined)}
                  style={styles.sweepActionBtn}
                >
                  <Text style={styles.sweepActionText}>disable</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity onPress={() => setSweepEditValue("")} style={styles.sweepCta}>
                <Text style={styles.sweepCtaText}>+ Set auto-sweep threshold</Text>
              </TouchableOpacity>
            ))}
          {balance.transactions.length > 0 && (
            <>
              <Text style={[styles.sectionTitle, { marginTop: 8, marginBottom: 4 }]}>
                Recent Transactions
              </Text>
              {balance.transactions.slice(0, 5).map((tx) => {
                const isCredit = tx.amount > 0;
                return (
                  <View key={tx.transaction_id} style={styles.allocationItem}>
                    <Text style={styles.allocationId}>
                      {tx.type}
                      {tx.description ? ` — ${tx.description}` : ""}
                    </Text>
                    <Text
                      style={[
                        styles.allocationStatus,
                        { color: isCredit ? colors.statusSuccess : colors.statusError },
                      ]}
                    >
                      {isCredit ? "+" : ""}
                      {tx.amount.toFixed(2)}
                    </Text>
                  </View>
                );
              })}
            </>
          )}
        </View>
      )}
      {budget != null && (
        <View style={styles.budgetSection}>
          <View style={styles.budgetRow}>
            <View style={styles.budgetCard}>
              <Text style={styles.budgetLabel}>Locked</Text>
              <Text style={styles.budgetValue}>{budget.total_locked}</Text>
            </View>
            <View style={styles.budgetCard}>
              <Text style={styles.budgetLabel}>Settled</Text>
              <Text style={styles.budgetValue}>{budget.total_settled}</Text>
            </View>
          </View>
        </View>
      )}
      {(budget?.allocations.length ?? 0) > 0 && (
        <Text style={styles.sectionTitle}>Allocations</Text>
      )}
    </>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.bgPrimary },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingTop: Platform.OS === "ios" ? 56 : 16,
      paddingBottom: 12,
    },
    tabBar: {
      flexDirection: "row",
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderPrimary,
      paddingHorizontal: 12,
    },
    tab: {
      paddingVertical: 8,
      paddingHorizontal: 12,
      borderBottomWidth: 2,
      borderBottomColor: "transparent",
    },
    tabActive: { borderBottomColor: c.textSecondary },
    tabText: { fontSize: 12, color: c.textGhost },
    tabTextActive: { color: c.textSecondary },
    headerLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
    headerTitle: { color: c.textPrimary, fontSize: 17, fontWeight: "600" },
    closeBtn: { color: c.accent, fontSize: 16, fontWeight: "600" },
    loadingContainer: { flex: 1, justifyContent: "center", alignItems: "center" },
    list: { flex: 1 },
    listContent: { padding: 16 },
    badgeRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 16 },
    typeBadge: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 2 },
    typeBadgeText: { fontSize: 12, fontWeight: "600" },
    sectionTitle: { color: c.textSecondary, fontSize: 13, fontWeight: "600", marginBottom: 8 },
    balanceRow: { flexDirection: "row", alignItems: "baseline", gap: 4, marginBottom: 2 },
    balanceAmount: { color: c.textPrimary, fontSize: 22, fontWeight: "700" },
    balanceCurrency: { color: c.textMuted, fontSize: 12 },
    balanceLabel: {
      color: c.textMuted,
      fontSize: 10,
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginBottom: 2,
    },
    balanceNote: { color: c.textMuted, fontSize: 10, marginTop: 2 },
    sweepReadout: {
      color: c.textMuted,
      fontSize: 10,
      fontStyle: "italic",
      marginTop: 6,
      marginBottom: 4,
      flex: 1,
    },
    sweepReadoutRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginTop: 6,
      marginBottom: 4,
    },
    sweepActionBtn: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 3,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.textMuted,
    },
    sweepActionText: { color: c.textMuted, fontSize: 10 },
    sweepCta: {
      alignSelf: "flex-start",
      paddingHorizontal: 8,
      paddingVertical: 3,
      marginTop: 6,
      marginBottom: 4,
      borderRadius: 3,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.textMuted,
      borderStyle: "dashed",
    },
    sweepCtaText: { color: c.textMuted, fontSize: 10, fontStyle: "italic" },
    sweepEditorRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      marginTop: 6,
      marginBottom: 4,
    },
    sweepEditorPrefix: { color: c.textMuted, fontSize: 10, fontStyle: "italic" },
    sweepEditorInput: {
      width: 64,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 3,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.textMuted,
      color: c.textPrimary,
      fontSize: 10,
    },
    sweepEditorCancel: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 3,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.textMuted,
    },
    sweepEditorCancelText: { color: c.textMuted, fontSize: 10 },
    budgetSection: { marginBottom: 8 },
    budgetRow: { flexDirection: "row", gap: 12, marginBottom: 8 },
    budgetCard: { backgroundColor: c.bgSecondary, borderRadius: 8, padding: 10, flex: 1 },
    budgetLabel: { color: c.textMuted, fontSize: 10 },
    budgetValue: { color: c.textPrimary, fontSize: 16, fontWeight: "700" },
    allocationItem: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingVertical: 4,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderLight,
    },
    allocationId: { color: c.textSecondary, fontSize: 11 },
    allocationStatus: { fontSize: 11, fontWeight: "600" },
    credentialItem: {
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderLight,
    },
    credentialHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 4,
    },
    credentialId: { color: c.textSecondary, fontSize: 12 },
    credentialTypeBadge: {
      borderWidth: 1,
      borderRadius: 3,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    credentialTypeText: { fontSize: 11, fontWeight: "700" },
    credentialMeta: { color: c.textMuted, fontSize: 11, marginTop: 1 },
    ledgerItem: {
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderLight,
    },
    ledgerHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: 8,
    },
    ledgerPrompt: { color: c.textPrimary, fontSize: 13, flex: 1 },
    ledgerStatusBadge: {
      borderWidth: 1,
      borderRadius: 3,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    ledgerStatusText: { fontSize: 10, fontWeight: "700" },
    ledgerSteps: { paddingLeft: 12, paddingTop: 4, paddingBottom: 4 },
    ledgerStep: {
      paddingVertical: 3,
      borderLeftWidth: 2,
      borderLeftColor: c.borderLight,
      paddingLeft: 8,
      marginBottom: 2,
    },
    ledgerStepText: { color: c.textSecondary, fontSize: 12 },
    successionItem: {
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderLight,
    },
    successionRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 2 },
    successionLabel: { color: c.textMuted, fontSize: 10, fontWeight: "600", width: 30 },
    successionKey: {
      color: c.textSecondary,
      fontSize: 11,
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    },
    emptyContainer: { paddingVertical: 40, alignItems: "center" },
    emptyText: { color: c.textMuted, fontSize: 14 },
  });
}
