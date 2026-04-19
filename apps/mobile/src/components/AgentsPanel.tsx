import React, { useEffect, useMemo, useRef, useState } from "react";
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
import {
  createAgentsController,
  type AgentFreshness,
  type AgentRecord,
  type AgentsFetchAdapter,
  type AgentsState,
  type AgentsTab,
  type DiscoveredAgent,
} from "@motebit/panels";

const FRESHNESS_COLORS: Record<AgentFreshness, string> = {
  awake: "#4ade80",
  recently_seen: "#facc15",
  dormant: "#94a3b8",
  cold: "#64748b",
};

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

function createMobileAgentsAdapter(app: MobileApp): AgentsFetchAdapter {
  return {
    get syncUrl() {
      // Mobile's syncUrl is async (AsyncStorage), but the Agents panel only
      // uses the adapter's fetch indirectly via listTrustedAgents/discoverAgents
      // which themselves route through the sync controller. The getter exists
      // for interface parity with other panels; return null to signal "use the
      // app's own fetchers".
      return null;
    },
    get motebitId() {
      return app.motebitId !== "mobile-local" ? app.motebitId : null;
    },
    listTrustedAgents: async () => {
      return (await app.listTrustedAgents()) as AgentRecord[];
    },
    discoverAgents: async () => {
      return (await app.discoverAgents()) as DiscoveredAgent[];
    },
  };
}

export function AgentsPanel({ visible, app, onClose }: AgentsPanelProps): React.ReactElement {
  const colors = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const ctrlRef = useRef<ReturnType<typeof createAgentsController> | null>(null);

  const [state, setState] = useState<AgentsState>(() => ({
    activeTab: "known",
    known: [],
    discovered: [],
    sort: "recent",
    capabilityFilter: "",
    loading: false,
    error: null,
  }));

  useEffect(() => {
    const adapter = createMobileAgentsAdapter(app);
    const ctrl = createAgentsController(adapter);
    ctrlRef.current = ctrl;
    const unsubscribe = ctrl.subscribe(setState);
    return () => {
      unsubscribe();
      ctrl.dispose();
      ctrlRef.current = null;
    };
  }, [app]);

  // Refresh the active tab when the modal opens or when the user switches tabs.
  useEffect(() => {
    if (!visible) return;
    const ctrl = ctrlRef.current;
    if (!ctrl) return;
    if (state.activeTab === "known") void ctrl.refreshKnown();
    else void ctrl.refreshDiscover();
  }, [visible, state.activeTab]);

  const onSetTab = (tab: AgentsTab): void => ctrlRef.current?.setActiveTab(tab);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerTitle}>Agents</Text>
          </View>
          <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
            <Text style={styles.closeBtn}>Done</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.tabBar}>
          <TouchableOpacity
            style={[styles.tab, state.activeTab === "known" && styles.tabActive]}
            onPress={() => onSetTab("known")}
            activeOpacity={0.7}
          >
            <Text style={[styles.tabText, state.activeTab === "known" && styles.tabTextActive]}>
              Known
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, state.activeTab === "discover" && styles.tabActive]}
            onPress={() => onSetTab("discover")}
            activeOpacity={0.7}
          >
            <Text style={[styles.tabText, state.activeTab === "discover" && styles.tabTextActive]}>
              Discover
            </Text>
          </TouchableOpacity>
        </View>

        {state.loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="small" color={colors.accent} />
          </View>
        ) : state.activeTab === "known" ? (
          <FlatList
            data={state.known}
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
        ) : (
          <FlatList
            data={ctrlRef.current?.discoveredView() ?? state.discovered}
            keyExtractor={(item) => item.motebit_id}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            renderItem={({ item }) => {
              const trustColor = TRUST_COLORS[item.trust_level ?? "unknown"] ?? "#616161";
              const priceByCapability = new Map<
                string,
                { unit_cost: number; currency: string; per: string }
              >();
              if (Array.isArray(item.pricing)) {
                for (const p of item.pricing) {
                  priceByCapability.set(p.capability, {
                    unit_cost: p.unit_cost,
                    currency: p.currency,
                    per: p.per,
                  });
                }
              }
              const interactionSuffix =
                typeof item.interaction_count === "number" && item.interaction_count > 0
                  ? ` · ${item.interaction_count} interaction${item.interaction_count === 1 ? "" : "s"}`
                  : "";
              return (
                <View style={styles.agentItem}>
                  <View style={styles.agentHeader}>
                    <Text style={styles.agentId}>{truncateId(item.motebit_id)}</Text>
                    {item.trust_level && (
                      <View style={[styles.trustBadge, { borderColor: trustColor }]}>
                        <Text style={[styles.trustText, { color: trustColor }]}>
                          {item.trust_level}
                          {interactionSuffix}
                        </Text>
                      </View>
                    )}
                  </View>
                  {item.capabilities.length > 0 && (
                    <View style={styles.capsRow}>
                      {item.capabilities.map((cap) => {
                        const price = priceByCapability.get(cap);
                        const priced = price != null && price.unit_cost > 0;
                        return (
                          <View key={cap} style={[styles.capTag, priced && styles.capTagPriced]}>
                            <Text style={[styles.capText, priced && styles.capTextPriced]}>
                              {priced
                                ? `${cap} · $${price.unit_cost.toFixed(2)}/${price.per}`
                                : cap}
                            </Text>
                          </View>
                        );
                      })}
                    </View>
                  )}
                  {typeof item.last_seen_at === "number" && item.last_seen_at > 0 && (
                    <View style={styles.seenRow}>
                      {item.freshness && (
                        <View
                          style={[
                            styles.freshnessDot,
                            { backgroundColor: FRESHNESS_COLORS[item.freshness] },
                          ]}
                        />
                      )}
                      <Text style={styles.seenText}>seen {formatTimeAgo(item.last_seen_at)}</Text>
                    </View>
                  )}
                </View>
              );
            }}
            ListEmptyComponent={
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyText}>No agents on the network yet.</Text>
                <Text style={styles.emptySubtext}>Connect to a relay to discover agents.</Text>
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
    container: { flex: 1, backgroundColor: c.bgPrimary },
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
    headerLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
    headerTitle: { color: c.textPrimary, fontSize: 17, fontWeight: "600" },
    closeBtn: { color: c.accent, fontSize: 16, fontWeight: "600" },
    tabBar: {
      flexDirection: "row",
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderPrimary,
      paddingHorizontal: 16,
    },
    tab: {
      paddingVertical: 10,
      paddingHorizontal: 16,
      borderBottomWidth: 2,
      borderBottomColor: "transparent",
    },
    tabActive: { borderBottomColor: c.textPrimary },
    tabText: { fontSize: 13, color: c.textMuted },
    tabTextActive: { color: c.textPrimary, fontWeight: "600" },
    loadingContainer: { flex: 1, justifyContent: "center", alignItems: "center" },
    list: { flex: 1 },
    listContent: { padding: 16 },
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
    trustText: { fontSize: 11, fontWeight: "700" },
    capsRow: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 4 },
    capTag: {
      backgroundColor: "rgba(126,184,218,0.1)",
      borderRadius: 3,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    capTagPriced: {
      backgroundColor: "rgba(163,122,255,0.15)",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: "rgba(163,122,255,0.45)",
    },
    capText: {
      fontSize: 10,
      color: c.textMuted,
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    },
    capTextPriced: { color: c.textPrimary },
    statsRow: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginBottom: 4 },
    statText: { color: c.textMuted, fontSize: 11 },
    seenText: { color: c.textMuted, fontSize: 10 },
    seenRow: { flexDirection: "row", alignItems: "center" },
    freshnessDot: { width: 6, height: 6, borderRadius: 3, marginRight: 4 },
    emptyContainer: { paddingVertical: 40, alignItems: "center" },
    emptyText: { color: c.textMuted, fontSize: 14 },
    emptySubtext: { color: c.textMuted, fontSize: 12, marginTop: 4, opacity: 0.7 },
  });
}
