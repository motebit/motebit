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
import { SensitivityLevel, EventType } from "@motebit/sdk";
import type { MobileApp } from "../mobile-app";
import { useTheme, type ThemeColors } from "../theme";
import {
  createMemoryController,
  classifyCertainty,
  resolveFeltMemory,
  resolveFeltConsolidation,
  feltHeadline,
  feltMutationLine,
  feltVerifiedAssurance,
  feltAssuranceGlyph,
  feltReceiptScope,
  type FeltMemoryNode,
  type FeltConsolidationRecord,
  type FeltCoverageAdapter,
  type MemoryFetchAdapter,
  type MemoryState,
} from "@motebit/panels";

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
      // Privacy-layer choke point — returns the signed mutable_pruning
      // cert so `lastDeletionCert` can render the receipt in the panel.
      return await app.deleteMemory(nodeId);
    },
    // Mobile doesn't expose pin today; no-op keeps the interface satisfied.
    pinMemory: async () => {},
    getDecayedConfidence: (node) => app.getDecayedConfidence(node as never),
  };
}

/**
 * Load the consolidation felt record (felt-interior §2/§4) — "what the interior
 * has been learning." `resolveFeltConsolidation` is the canonical boundary: it
 * projects + verifies internally and returns only render-safe records. Mobile
 * holds the owner's signing key, so it supplies the verified-coverage adapter
 * (same dynamic-crypto pattern as desktop/web) — detail is shown ⟺ verified.
 * With no public key (pre-bootstrap), every record degrades to receipt-only.
 */
async function loadFeltConsolidation(app: MobileApp): Promise<FeltConsolidationRecord[]> {
  const events = await app.queryEvents({
    event_types: [
      EventType.ConsolidationCycleRun,
      EventType.ConsolidationReceiptSigned,
      EventType.ConsolidationReceiptsAnchored,
      EventType.MemoryFormed,
      EventType.MemoryConsolidated,
    ],
  });
  let adapter: FeltCoverageAdapter | undefined;
  const pubHex = app.publicKey;
  if (pubHex !== "") {
    const {
      verifyConsolidationMutationManifest,
      consolidationReceiptDigest,
      consolidationContentDigest,
      hexToBytes,
    } = await import("@motebit/encryption");
    const ownerKey = hexToBytes(pubHex);
    adapter = {
      verifyManifest: (m) => verifyConsolidationMutationManifest(m, ownerKey),
      receiptDigest: (r) => consolidationReceiptDigest(r),
      contentDigest: (c) => consolidationContentDigest(c),
    };
  }
  return resolveFeltConsolidation(events, adapter);
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

  // The consolidation felt record (felt-interior §2/§4) — "what I've been
  // learning," the ACTS to the memory record's standing mass. Fetched on open;
  // verified against the owner's own key. Mobile's first consolidation surface.
  const [feltConsolidation, setFeltConsolidation] = useState<FeltConsolidationRecord[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void (async () => {
      try {
        const records = await loadFeltConsolidation(app);
        if (!cancelled) setFeltConsolidation(records);
      } catch {
        // Fail-soft: the resting record is additive. Leave it empty (honest by
        // absence) rather than disturbing the memory list.
        if (!cancelled) setFeltConsolidation([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, app]);

  const toggleCycle = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const filtered = ctrlRef.current?.filteredView() ?? state.memories;

  // The memory resting record (felt-interior §5) — derived from the WHOLE graph
  // (state.memories), not the filtered search view: "what the interior holds, at
  // rest." A calm summary, never a chart or score.
  const feltMemory =
    state.memories.length > 0
      ? resolveFeltMemory(state.memories as unknown as FeltMemoryNode[])
      : null;
  const feltShapeLine = feltMemory
    ? [
        ...feltMemory.shape.map((s) => `${s.count} ${s.kind}`),
        ...(feltMemory.fading > 0 ? [`${feltMemory.fading} fading`] : []),
      ].join(" · ")
    : "";

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

        {feltMemory != null ? (
          <View style={styles.feltMemory}>
            <Text style={styles.feltMemoryHeadline}>{feltMemory.headline}</Text>
            {feltShapeLine !== "" ? (
              <Text style={styles.feltMemoryShape}>{feltShapeLine}</Text>
            ) : null}
          </View>
        ) : null}

        {feltConsolidation.length > 0 ? (
          <View style={styles.feltCons}>
            <Text style={styles.feltConsHeader}>Recently learned</Text>
            {feltConsolidation.slice(0, 4).map((rec) => {
              const key = `${rec.cycleId}-${rec.finishedAt}`;
              const glyph = feltAssuranceGlyph(rec.assurance);
              const verified = rec.evidence.status === "verified";
              const open = expanded.has(key);
              return (
                <View key={key} style={styles.feltConsRow}>
                  <TouchableOpacity
                    activeOpacity={verified ? 0.6 : 1}
                    onPress={verified ? () => toggleCycle(key) : undefined}
                    accessibilityLabel={feltReceiptScope(rec.assurance, rec.evidence.status)}
                  >
                    <View style={styles.feltConsHeadRow}>
                      <Text style={styles.feltConsHeadline}>{feltHeadline(rec)}</Text>
                      {glyph !== "" ? <Text style={styles.feltConsGlyph}>{glyph}</Text> : null}
                      <Text style={styles.feltConsTime}>{formatTimeAgo(rec.finishedAt)}</Text>
                    </View>
                  </TouchableOpacity>
                  {rec.evidence.status === "verified" && open ? (
                    <View style={styles.feltConsDetail}>
                      {rec.evidence.mutations.map((m) => (
                        <Text key={m.nodeId} style={styles.feltConsLine}>
                          {feltMutationLine(m)}
                        </Text>
                      ))}
                      <Text style={styles.feltConsNote}>{feltVerifiedAssurance().label}</Text>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : null}

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
              const certainty = classifyCertainty(decayed);
              // Certainty label mirrors the Layer-1 memory index the
              // agent sees (spec/memory-delta-v1.md §5.8). When motebit
              // promotes a memory to "absolute", the user sees the
              // same label here.
              const certaintyStyle =
                certainty === "absolute"
                  ? styles.certaintyAbsolute
                  : certainty === "confident"
                    ? styles.certaintyConfident
                    : styles.certaintyTentative;
              return (
                <View style={styles.memoryItem}>
                  <View style={styles.memoryContent}>
                    <Text style={styles.memoryText} numberOfLines={3}>
                      {item.content}
                    </Text>
                    <View style={styles.metaRow}>
                      {item.sensitivity !== String(SensitivityLevel.None) && (
                        <View style={styles.sensitivityBadge}>
                          <Text style={styles.sensitivityText}>{item.sensitivity}</Text>
                        </View>
                      )}
                      <Text style={[styles.metaText, certaintyStyle]}>
                        {certainty} · {Math.round(decayed * 100)}%
                      </Text>
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
    feltMemory: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderPrimary,
      gap: 4,
    },
    feltMemoryHeadline: { color: c.textPrimary, fontSize: 14, lineHeight: 19 },
    feltMemoryShape: { color: c.textMuted, fontSize: 12 },
    feltCons: {
      paddingHorizontal: 16,
      paddingTop: 10,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderPrimary,
      gap: 6,
    },
    feltConsHeader: {
      color: c.textMuted,
      fontSize: 11,
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: 0.4,
    },
    feltConsRow: { gap: 4 },
    feltConsHeadRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
    feltConsHeadline: { color: c.textSecondary, fontSize: 13, flexShrink: 1 },
    feltConsGlyph: { color: c.textMuted, fontSize: 12 },
    feltConsTime: { color: c.textMuted, fontSize: 11, marginLeft: "auto" },
    feltConsDetail: { paddingLeft: 10, gap: 2, marginTop: 2 },
    feltConsLine: { color: c.textMuted, fontSize: 12, lineHeight: 17 },
    feltConsNote: { color: c.accent, fontSize: 11, fontWeight: "500", marginTop: 2 },
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
    // Certainty badge — Memory Trinity §5.8 tentative → confident → absolute
    certaintyAbsolute: { color: c.accent, fontWeight: "500", textTransform: "lowercase" },
    certaintyConfident: { color: c.textMuted, textTransform: "lowercase" },
    certaintyTentative: {
      color: c.textMuted,
      fontStyle: "italic",
      opacity: 0.75,
      textTransform: "lowercase",
    },
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
