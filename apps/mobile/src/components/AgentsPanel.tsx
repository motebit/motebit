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

interface AgentRecord {
  remote_motebit_id: string;
  trust_level: string;
  first_seen_at: number;
  last_seen_at: number;
  interaction_count: number;
  successful_tasks?: number;
  failed_tasks?: number;
  notes?: string;
}

const TRUST_COLORS: Record<string, string> = {
  unknown: "#616161",
  first_contact: "#ff9800",
  verified: "#2196f3",
  trusted: "#4caf50",
  blocked: "#f44336",
};

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function truncateId(id: string): string {
  if (id.length <= 16) return id;
  return id.slice(0, 8) + "..." + id.slice(-4);
}

interface AgentsPanelProps {
  visible: boolean;
  app: MobileApp;
  onClose: () => void;
}

export function AgentsPanel({ visible, app, onClose }: AgentsPanelProps): React.ReactElement {
  const colors = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const records = await app.listTrustedAgents();
      setAgents((records as AgentRecord[]).sort((a, b) => b.last_seen_at - a.last_seen_at));
    } catch {
      // Failed to load agents
    } finally {
      setLoading(false);
    }
  }, [app]);

  useEffect(() => {
    if (visible) {
      void refresh();
    }
  }, [visible, refresh]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerTitle}>Agents</Text>
            <View style={styles.countBadge}>
              <Text style={styles.countText}>{agents.length}</Text>
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
            data={agents}
            keyExtractor={(item) => item.remote_motebit_id}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            renderItem={({ item }) => {
              const trustColor = TRUST_COLORS[item.trust_level] ?? "#616161";
              const succeeded = item.successful_tasks ?? 0;
              const failed = item.failed_tasks ?? 0;
              return (
                <View style={styles.agentItem}>
                  <View style={styles.agentHeader}>
                    <Text style={styles.agentId}>{truncateId(item.remote_motebit_id)}</Text>
                    <View style={[styles.trustBadge, { borderColor: trustColor }]}>
                      <Text style={[styles.trustText, { color: trustColor }]}>
                        {item.trust_level}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.statsRow}>
                    <Text style={styles.statText}>{succeeded} succeeded</Text>
                    {failed > 0 && (
                      <Text style={[styles.statText, { color: colors.statusError }]}>
                        {failed} failed
                      </Text>
                    )}
                    <Text style={styles.statText}>{item.interaction_count} interactions</Text>
                  </View>
                  <Text style={styles.seenText}>last seen {formatTimeAgo(item.last_seen_at)}</Text>
                </View>
              );
            }}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyText}>No known agents yet.</Text>
                <Text style={styles.emptySubtext}>
                  Agents appear here after delegation or discovery.
                </Text>
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
    agentItem: {
      backgroundColor: c.bgSecondary,
      borderRadius: 10,
      padding: 12,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: c.borderPrimary,
    },
    agentHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 6,
    },
    agentId: {
      color: c.textPrimary,
      fontSize: 13,
      fontWeight: "600",
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    },
    trustBadge: {
      borderWidth: 1,
      borderRadius: 3,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    trustText: {
      fontSize: 11,
      fontWeight: "700",
    },
    statsRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 12,
      marginBottom: 4,
    },
    statText: {
      color: c.textMuted,
      fontSize: 11,
    },
    seenText: {
      color: c.textMuted,
      fontSize: 10,
    },
    emptyContainer: {
      paddingVertical: 40,
      alignItems: "center",
    },
    emptyText: {
      color: c.textMuted,
      fontSize: 14,
    },
    emptySubtext: {
      color: c.textMuted,
      fontSize: 12,
      marginTop: 4,
      opacity: 0.7,
    },
  });
}
