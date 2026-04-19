import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Platform,
  Alert,
} from "react-native";
import { SensitivityLevel } from "@motebit/sdk";
import type { MobileApp } from "../mobile-app";
import { useTheme, type ThemeColors } from "../theme";
import { createMemoryController, type MemoryFetchAdapter, type MemoryState } from "@motebit/panels";

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

interface MemoryPanelProps {
  visible: boolean;
  app: MobileApp;
  onClose: () => void;
}

function createMobileMemoryAdapter(app: MobileApp): MemoryFetchAdapter {
  return {
    listMemories: () => app.listMemories(),
    deleteMemory: async (nodeId) => {
      // Mobile's app.deleteMemory currently returns void; the panel
      // surfaces "deleted" silently, so `null` is correct — the runtime
      // produces a certificate, we just don't plumb it back today.
      await app.deleteMemory(nodeId);
      return null;
    },
    // Mobile doesn't expose pin today; no-op keeps the interface satisfied.
    pinMemory: async () => {},
    getDecayedConfidence: (node) => app.getDecayedConfidence(node as never),
  };
}

export function MemoryPanel({ visible, app, onClose }: MemoryPanelProps): React.ReactElement {
  const colors = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const ctrlRef = useRef<ReturnType<typeof createMemoryController> | null>(null);

  const [state, setState] = useState<MemoryState>(() => ({
    memories: [],
    search: "",
    auditFlags: new Map(),
    loading: false,
    error: null,
    lastDeletionCert: null,
  }));

  useEffect(() => {
    const ctrl = createMemoryController(createMobileMemoryAdapter(app));
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

  const filtered = ctrlRef.current?.filteredView() ?? state.memories;

  const handleDelete = (nodeId: string): void => {
    Alert.alert("Delete Memory", "This memory will be permanently removed.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => void ctrlRef.current?.deleteMemory(nodeId),
      },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerTitle}>Memories</Text>
            <View style={styles.countBadge}>
              <Text style={styles.countText}>{filtered.length}</Text>
            </View>
          </View>
          <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
            <Text style={styles.closeBtn}>Done</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.searchBar}>
          <TextInput
            style={styles.searchInput}
            value={state.search}
            onChangeText={(q) => ctrlRef.current?.setSearch(q)}
            placeholder="Search memories..."
            placeholderTextColor={colors.inputPlaceholder}
            autoCorrect={false}
          />
        </View>

        {filtered.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>
              {state.memories.length === 0 ? "No memories yet." : "No matching memories."}
            </Text>
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(item) => item.node_id}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            renderItem={({ item }) => {
              const decayed = ctrlRef.current?.getDecayedConfidence(item) ?? item.confidence;
              return (
                <View style={styles.memoryItem}>
                  <View style={styles.memoryContent}>
                    <Text style={styles.memoryText} numberOfLines={3}>
                      {item.content}
                    </Text>
                    <View style={styles.metaRow}>
                      {item.sensitivity !== SensitivityLevel.None && (
                        <View style={styles.sensitivityBadge}>
                          <Text style={styles.sensitivityText}>{item.sensitivity}</Text>
                        </View>
                      )}
                      <Text style={styles.metaText}>{Math.round(decayed * 100)}%</Text>
                      <Text style={styles.metaText}>
                        {Math.round(item.half_life / 86_400_000)}d half
                        {item.half_life > 30 * 86_400_000 ? " \u2191" : ""}
                      </Text>
                      <Text style={styles.metaText}>{formatTimeAgo(item.created_at)}</Text>
                    </View>
                  </View>
                  <TouchableOpacity
                    style={styles.deleteBtn}
                    onPress={() => handleDelete(item.node_id)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.deleteText}>X</Text>
                  </TouchableOpacity>
                </View>
              );
            }}
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
    countBadge: {
      backgroundColor: c.borderLight,
      borderRadius: 10,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    countText: { color: c.textMuted, fontSize: 12, fontWeight: "600" },
    closeBtn: { color: c.accent, fontSize: 16, fontWeight: "600" },
    searchBar: { paddingHorizontal: 16, paddingVertical: 10 },
    searchInput: {
      backgroundColor: c.inputBg,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      color: c.inputText,
      fontSize: 15,
    },
    list: { flex: 1 },
    listContent: { paddingHorizontal: 16, paddingBottom: 40 },
    emptyContainer: { flex: 1, justifyContent: "center", alignItems: "center" },
    emptyText: { color: c.textMuted, fontSize: 14, fontStyle: "italic" },
    memoryItem: {
      flexDirection: "row",
      alignItems: "flex-start",
      backgroundColor: c.bgSecondary,
      borderRadius: 10,
      padding: 12,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: c.borderPrimary,
    },
    memoryContent: { flex: 1, marginRight: 10 },
    memoryText: { color: c.textPrimary, fontSize: 14, lineHeight: 20, marginBottom: 6 },
    metaRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
    sensitivityBadge: {
      backgroundColor: `${c.statusWarning}15`,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    sensitivityText: {
      color: c.statusWarning,
      fontSize: 10,
      fontWeight: "600",
      textTransform: "uppercase",
    },
    metaText: { color: c.textMuted, fontSize: 11 },
    deleteBtn: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: `${c.statusError}1a`,
      justifyContent: "center",
      alignItems: "center",
    },
    deleteText: { color: c.statusError, fontSize: 12, fontWeight: "700" },
  });
}
