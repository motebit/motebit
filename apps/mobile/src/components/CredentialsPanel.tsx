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

interface CredentialsPanelProps {
  visible: boolean;
  app: MobileApp;
  onClose: () => void;
}

export function CredentialsPanel({
  visible,
  app,
  onClose,
}: CredentialsPanelProps): React.ReactElement {
  const colors = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [credentials, setCredentials] = useState<CredentialEntry[]>([]);
  const [budgetSummary, setBudgetSummary] = useState<BudgetSummary | null>(null);
  const [budgetAllocations, setBudgetAllocations] = useState<BudgetAllocation[]>([]);
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
        const key = `${String((c.credential as Record<string, unknown>).issuer ?? "")}:${c.credential_type}:${c.issued_at}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(c);
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
            <Text style={styles.headerTitle}>Credentials</Text>
            <View style={styles.countBadge}>
              <Text style={styles.countText}>{credentials.length}</Text>
            </View>
          </View>
          <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
            <Text style={styles.closeBtn}>Done</Text>
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="small" color={colors.accent} />
          </View>
        ) : (
          <FlatList
            data={credentials}
            keyExtractor={(item) => item.credential_id}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            ListHeaderComponent={
              <>
                {/* Type badges */}
                {Object.keys(typeCounts).length > 0 && (
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
                )}

                {/* Budget summary */}
                {budgetSummary != null && (
                  <View style={styles.budgetSection}>
                    <Text style={styles.sectionTitle}>Budget</Text>
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
                    {budgetAllocations.length > 0 && (
                      <>
                        {budgetAllocations.slice(0, 10).map((a) => (
                          <View key={a.allocation_id} style={styles.allocationItem}>
                            <Text style={styles.allocationId}>
                              {a.allocation_id.slice(0, 10)}...
                            </Text>
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
                        ))}
                      </>
                    )}
                  </View>
                )}

                {credentials.length > 0 && (
                  <Text style={[styles.sectionTitle, { marginTop: 16 }]}>All Credentials</Text>
                )}
              </>
            }
            renderItem={({ item }) => {
              const color = TYPE_COLORS[item.credential_type] ?? "#616161";
              const issuer = resolveIssuer(item.credential);
              return (
                <View style={styles.credentialItem}>
                  <View style={styles.credentialHeader}>
                    <Text style={styles.credentialId}>{item.credential_id.slice(0, 12)}...</Text>
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
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderPrimary,
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
