import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Modal,
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ActivityIndicator,
} from "react-native";
import type { MobileApp } from "../mobile-app";
import { useTheme, type ThemeColors } from "../theme";

interface CredentialEntry {
  credential_id: string;
  credential_type: string;
  credential: {
    issuer?: string | { id: string };
    credentialSubject?: Record<string, unknown>;
    issuanceDate?: string;
  };
  issued_at: number;
}

interface BudgetSummary {
  total_locked: number;
  total_settled: number;
}

interface BudgetAllocation {
  allocation_id: string;
  amount_locked: number;
  status: string;
  created_at: number;
  amount_settled?: number;
  settlement_status?: string;
}

interface AccountBalance {
  balance: number;
  currency: string;
  transactions: Array<{
    transaction_id: string;
    type: string;
    amount: number;
    balance_after: number;
    description?: string;
    created_at: number;
  }>;
}

interface LedgerEntry {
  goal_id: string;
  goal_prompt: string;
  status: string;
  steps: Array<{
    step_id: string;
    summary: string;
    status: string;
    started_at?: number;
    completed_at?: number;
  }>;
  manifest_hash?: string;
  signed_at?: number;
}

interface SuccessionRecord {
  old_public_key: string;
  new_public_key: string;
  reason?: string;
  rotated_at: number;
  old_signature: string;
  new_signature: string;
}

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
  if (cred.issuer == null) return "unknown";
  if (typeof cred.issuer === "string") {
    return cred.issuer.length > 28 ? cred.issuer.slice(0, 28) + "..." : cred.issuer;
  }
  const id = cred.issuer.id ?? "unknown";
  return id.length > 28 ? id.slice(0, 28) + "..." : id;
}

type SovereignTab = "credentials" | "ledger" | "budget" | "succession";

interface SovereignPanelProps {
  visible: boolean;
  app: MobileApp;
  onClose: () => void;
}

export function SovereignPanel({ visible, app, onClose }: SovereignPanelProps): React.ReactElement {
  const colors = useTheme();
  const [activeTab, setActiveTab] = useState<SovereignTab>("credentials");
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [credentials, setCredentials] = useState<CredentialEntry[]>([]);
  const [revokedIds, setRevokedIds] = useState<Set<string>>(new Set());
  const [budgetSummary, setBudgetSummary] = useState<BudgetSummary | null>(null);
  const [budgetAllocations, setBudgetAllocations] = useState<BudgetAllocation[]>([]);
  const [accountBalance, setAccountBalance] = useState<AccountBalance | null>(null);
  const [ledgerEntries, setLedgerEntries] = useState<LedgerEntry[]>([]);
  const [expandedGoalId, setExpandedGoalId] = useState<string | null>(null);
  const [successionChain, setSuccessionChain] = useState<SuccessionRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const syncUrl = await app.getSyncUrl();
      if (!syncUrl) return;
      const motebitId = app.motebitId;
      if (!motebitId) return;

      // Merge local peer-issued credentials with relay credentials
      const localCreds: CredentialEntry[] = app.getLocalCredentials();
      let relayCreds: CredentialEntry[] = [];
      if (syncUrl) {
        try {
          const credRes = await fetch(`${syncUrl}/api/v1/agents/${motebitId}/credentials`);
          if (credRes.ok) {
            const data = (await credRes.json()) as { credentials: CredentialEntry[] };
            relayCreds = data.credentials ?? [];
          }
        } catch {
          // Relay fetch failed — local credentials still display
        }
      }
      // Deduplicate by issuer + type + timestamp
      const seen = new Set<string>();
      const merged: CredentialEntry[] = [];
      for (const c of [...localCreds, ...relayCreds].sort((a, b) => b.issued_at - a.issued_at)) {
        const issuerVal = (c.credential as Record<string, unknown>).issuer;
        const issuerKey = typeof issuerVal === "string" ? issuerVal : "";
        const key = `${issuerKey}:${c.credential_type}:${c.issued_at}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(c);
        }
      }
      // Check revocation status via batch endpoint
      if (merged.length > 0) {
        try {
          const batchRes = await fetch(`${syncUrl}/api/v1/credentials/batch-status`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ credential_ids: merged.map((c) => c.credential_id) }),
          });
          if (batchRes.ok) {
            const batchData = (await batchRes.json()) as {
              results: Array<{ credential_id: string; revoked: boolean }>;
            };
            const revIds = new Set(
              batchData.results.filter((r) => r.revoked).map((r) => r.credential_id),
            );
            if (revIds.size > 0) {
              setRevokedIds(revIds);
            }
          }
        } catch {
          /* batch check failed — display without revocation status */
        }
      }

      setCredentials(merged);

      // Fetch budget
      try {
        const budgetRes = await fetch(`${syncUrl}/agent/${motebitId}/budget`);
        if (budgetRes.ok) {
          const data = (await budgetRes.json()) as {
            summary: BudgetSummary;
            allocations: BudgetAllocation[];
          };
          setBudgetSummary(data.summary);
          setBudgetAllocations(data.allocations ?? []);
        }
      } catch {
        // Budget fetch failed
      }

      // Fetch virtual account balance
      try {
        const balanceRes = await fetch(`${syncUrl}/api/v1/agents/${motebitId}/balance`);
        if (balanceRes.ok) {
          const data = (await balanceRes.json()) as AccountBalance;
          setAccountBalance(data);
        }
      } catch {
        // Balance fetch failed
      }

      // Fetch execution ledger entries
      try {
        const ledgerRes = await fetch(`${syncUrl}/agent/${motebitId}/ledger`);
        if (ledgerRes.ok) {
          const data = (await ledgerRes.json()) as { entries: LedgerEntry[] };
          setLedgerEntries(data.entries ?? []);
        }
      } catch {
        // Ledger fetch failed
      }

      // Fetch key succession chain
      try {
        const succRes = await fetch(`${syncUrl}/api/v1/agents/${motebitId}/succession`);
        if (succRes.ok) {
          const data = (await succRes.json()) as { chain: SuccessionRecord[] };
          setSuccessionChain(data.chain ?? []);
        }
      } catch {
        // Succession fetch failed
      }
    } finally {
      setLoading(false);
    }
  }, [app]);

  useEffect(() => {
    if (visible) {
      void refresh();
    }
  }, [visible, refresh]);

  // Count by type
  const typeCounts: Record<string, number> = {};
  for (const c of credentials) {
    typeCounts[c.credential_type] = (typeCounts[c.credential_type] ?? 0) + 1;
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerTitle}>Sovereign</Text>
          </View>
          <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
            <Text style={styles.closeBtn}>Done</Text>
          </TouchableOpacity>
        </View>
        {/* Tab bar — matches desktop: Credentials, Ledger, Budget, Succession */}
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

        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="small" color={colors.accent} />
          </View>
        ) : activeTab === "credentials" ? (
          <FlatList
            data={credentials}
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
              const isRevoked = revokedIds.has(item.credential_id);
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
            data={ledgerEntries}
            keyExtractor={(item) => item.goal_id}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            renderItem={({ item: entry }) => {
              const isExpanded = expandedGoalId === entry.goal_id;
              return (
                <View>
                  <TouchableOpacity
                    style={styles.ledgerItem}
                    onPress={() => setExpandedGoalId(isExpanded ? null : entry.goal_id)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.ledgerHeader}>
                      <Text style={styles.ledgerPrompt} numberOfLines={1}>
                        {entry.goal_prompt}
                      </Text>
                      <View
                        style={[
                          styles.ledgerStatusBadge,
                          {
                            borderColor:
                              entry.status === "completed"
                                ? colors.statusSuccess
                                : entry.status === "failed"
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
                                entry.status === "completed"
                                  ? colors.statusSuccess
                                  : entry.status === "failed"
                                    ? colors.statusError
                                    : colors.statusWarning,
                            },
                          ]}
                        >
                          {entry.status}
                        </Text>
                      </View>
                    </View>
                    {entry.manifest_hash && (
                      <Text style={styles.credentialMeta}>
                        hash: {entry.manifest_hash.slice(0, 16)}...
                      </Text>
                    )}
                  </TouchableOpacity>
                  {isExpanded && entry.steps.length > 0 && (
                    <View style={styles.ledgerSteps}>
                      {entry.steps.map((step) => (
                        <View key={step.step_id} style={styles.ledgerStep}>
                          <Text style={styles.ledgerStepText}>{step.summary}</Text>
                          <Text style={styles.credentialMeta}>
                            {step.status}
                            {step.completed_at ? ` — ${formatTimeAgo(step.completed_at)}` : ""}
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
            data={budgetAllocations}
            keyExtractor={(item) => item.allocation_id}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            ListHeaderComponent={
              <>
                {accountBalance != null && (
                  <View style={styles.budgetSection}>
                    <View style={styles.balanceRow}>
                      <Text style={styles.balanceAmount}>{accountBalance.balance.toFixed(2)}</Text>
                      <Text style={styles.balanceCurrency}>{accountBalance.currency ?? "USD"}</Text>
                    </View>
                    {accountBalance.transactions.length > 0 && (
                      <>
                        <Text style={[styles.sectionTitle, { marginTop: 8, marginBottom: 4 }]}>
                          Recent Transactions
                        </Text>
                        {accountBalance.transactions.slice(0, 5).map((tx) => {
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
                                  {
                                    color: isCredit ? colors.statusSuccess : colors.statusError,
                                  },
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
                {budgetSummary != null && (
                  <View style={styles.budgetSection}>
                    <View style={styles.budgetRow}>
                      <View style={styles.budgetCard}>
                        <Text style={styles.budgetLabel}>Locked</Text>
                        <Text style={styles.budgetValue}>{budgetSummary.total_locked}</Text>
                      </View>
                      <View style={styles.budgetCard}>
                        <Text style={styles.budgetLabel}>Settled</Text>
                        <Text style={styles.budgetValue}>{budgetSummary.total_settled}</Text>
                      </View>
                    </View>
                  </View>
                )}
                {budgetAllocations.length > 0 && (
                  <Text style={styles.sectionTitle}>Allocations</Text>
                )}
              </>
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
              accountBalance == null && budgetSummary == null ? (
                <View style={styles.emptyContainer}>
                  <Text style={styles.emptyText}>No budget data yet.</Text>
                </View>
              ) : null
            }
          />
        ) : (
          <FlatList
            data={successionChain}
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
                <Text style={styles.credentialMeta}>{formatTimeAgo(record.rotated_at)}</Text>
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

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.bgPrimary,
    },
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
    tabActive: {
      borderBottomColor: c.textSecondary,
    },
    tabText: {
      fontSize: 12,
      color: c.textGhost,
    },
    tabTextActive: {
      color: c.textSecondary,
    },
    headerLeft: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    headerTitle: {
      color: c.textPrimary,
      fontSize: 17,
      fontWeight: "600",
    },
    countBadge: {
      backgroundColor: c.borderLight,
      borderRadius: 10,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    countText: {
      color: c.textMuted,
      fontSize: 12,
      fontWeight: "600",
    },
    closeBtn: {
      color: c.accent,
      fontSize: 16,
      fontWeight: "600",
    },
    loadingContainer: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
    },
    list: {
      flex: 1,
    },
    listContent: {
      padding: 16,
    },
    badgeRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      marginBottom: 16,
    },
    typeBadge: {
      borderWidth: 1,
      borderRadius: 4,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    typeBadgeText: {
      fontSize: 12,
      fontWeight: "600",
    },
    sectionTitle: {
      color: c.textSecondary,
      fontSize: 13,
      fontWeight: "600",
      marginBottom: 8,
    },
    balanceRow: {
      flexDirection: "row",
      alignItems: "baseline",
      gap: 4,
      marginBottom: 4,
    },
    balanceAmount: {
      color: c.textPrimary,
      fontSize: 22,
      fontWeight: "700",
    },
    balanceCurrency: {
      color: c.textMuted,
      fontSize: 12,
    },
    budgetSection: {
      marginBottom: 8,
    },
    budgetRow: {
      flexDirection: "row",
      gap: 12,
      marginBottom: 8,
    },
    budgetCard: {
      backgroundColor: c.bgSecondary,
      borderRadius: 8,
      padding: 10,
      flex: 1,
    },
    budgetLabel: {
      color: c.textMuted,
      fontSize: 10,
    },
    budgetValue: {
      color: c.textPrimary,
      fontSize: 16,
      fontWeight: "700",
    },
    allocationItem: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingVertical: 4,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderLight,
    },
    allocationId: {
      color: c.textSecondary,
      fontSize: 11,
    },
    allocationStatus: {
      fontSize: 11,
      fontWeight: "600",
    },
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
    credentialId: {
      color: c.textSecondary,
      fontSize: 12,
    },
    credentialTypeBadge: {
      borderWidth: 1,
      borderRadius: 3,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    credentialTypeText: {
      fontSize: 11,
      fontWeight: "700",
    },
    credentialMeta: {
      color: c.textMuted,
      fontSize: 11,
      marginTop: 1,
    },
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
    ledgerPrompt: {
      color: c.textPrimary,
      fontSize: 13,
      flex: 1,
    },
    ledgerStatusBadge: {
      borderWidth: 1,
      borderRadius: 3,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    ledgerStatusText: {
      fontSize: 10,
      fontWeight: "700",
    },
    ledgerSteps: {
      paddingLeft: 12,
      paddingTop: 4,
      paddingBottom: 4,
    },
    ledgerStep: {
      paddingVertical: 3,
      borderLeftWidth: 2,
      borderLeftColor: c.borderLight,
      paddingLeft: 8,
      marginBottom: 2,
    },
    ledgerStepText: {
      color: c.textSecondary,
      fontSize: 12,
    },
    successionItem: {
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderLight,
    },
    successionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginBottom: 2,
    },
    successionLabel: {
      color: c.textMuted,
      fontSize: 10,
      fontWeight: "600",
      width: 30,
    },
    successionKey: {
      color: c.textSecondary,
      fontSize: 11,
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    },
    emptyContainer: {
      paddingVertical: 40,
      alignItems: "center",
    },
    emptyText: {
      color: c.textMuted,
      fontSize: 14,
    },
  });
}
