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
} from "react-native";
import {
  createActivityController,
  createRetentionController,
  createSelfTestController,
  selfTestBadgeLabel,
  summarizeRetentionCeilings,
  type ActivityFetchAdapter,
  type ActivityState,
  type ActivityKind,
  type ActivityEvent,
  type RetentionFetchAdapter,
  type RetentionState,
  type RetentionManifest,
  type SelfTestFetchAdapter,
  type SelfTestState,
  type TransparencyManifestSummary,
} from "@motebit/panels";
import { EventType } from "@motebit/sdk";
import { verifyRetentionManifest } from "@motebit/encryption";
import type { MobileApp } from "../mobile-app";
import { useTheme, type ThemeColors } from "../theme";

const DEFAULT_RELAY_URL = "https://relay.motebit.com";

const KIND_LABEL: Record<ActivityKind, string> = {
  deletion: "Deletions",
  consent: "Consents",
  export: "Exports",
  trust: "Trust",
  skill: "Skills",
  governance: "Governance",
  other: "Other",
};

const ACTION_LABEL: Record<string, string> = {
  delete_memory: "Deleted memory",
  delete_conversation: "Deleted conversation",
  flush_record: "Flushed record",
  set_sensitivity: "Changed sensitivity",
  export_all: "Exported data",
  delete_requested: "Requested deletion",
  export_requested: "Requested export",
  skill_loaded: "Loaded skill",
  sensitivity_gate_fired: "Blocked egress",
};

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

function shortenTarget(targetId: string | undefined): string {
  if (targetId === undefined || targetId === "") return "";
  if (targetId.length <= 14) return targetId;
  return `${targetId.slice(0, 8)}…${targetId.slice(-4)}`;
}

function hexToBytes(hex: string): Uint8Array {
  const len = hex.length / 2;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

interface ActivityPanelProps {
  visible: boolean;
  app: MobileApp;
  onClose: () => void;
}

function createMobileActivityAdapter(app: MobileApp): ActivityFetchAdapter {
  return {
    queryAudit: async ({ limit, after }) => {
      const runtime = app.getRuntime();
      if (runtime === null) return [];
      const opts: { limit?: number; after?: number } = {};
      if (limit !== undefined) opts.limit = limit;
      if (after !== undefined) opts.after = after;
      const rows = await runtime.auditLog.query(runtime.motebitId, opts);
      return rows.map((r) => ({
        audit_id: r.audit_id,
        motebit_id: r.motebit_id,
        timestamp: r.timestamp,
        action: r.action,
        target_type: r.target_type,
        target_id: r.target_id,
        details: r.details,
      }));
    },
    queryEvents: async ({ eventTypes, limit, after }) => {
      const runtime = app.getRuntime();
      if (runtime === null) return [];
      const filter: {
        motebit_id: string;
        limit?: number;
        after_timestamp?: number;
        event_types?: EventType[];
      } = {
        motebit_id: runtime.motebitId,
      };
      if (limit !== undefined) filter.limit = limit;
      if (after !== undefined) filter.after_timestamp = after;
      if (eventTypes !== undefined && eventTypes.length > 0) {
        filter.event_types = eventTypes as EventType[];
      }
      const rows = await runtime.events.query(filter);
      return rows.map((r) => ({
        event_id: r.event_id,
        motebit_id: r.motebit_id,
        timestamp: r.timestamp,
        event_type: r.event_type,
        payload: r.payload ?? {},
        tombstoned: r.tombstoned,
      }));
    },
  };
}

function createMobileRetentionAdapter(app: MobileApp): RetentionFetchAdapter {
  // Mobile's getSyncUrl() is async; resolve once per fetch so a relay
  // change between sessions is picked up on the next panel open.
  async function relayUrl(): Promise<string> {
    const configured = await app.getSyncUrl();
    return (configured ?? DEFAULT_RELAY_URL).replace(/\/$/, "");
  }
  return {
    fetchTransparency: async (): Promise<TransparencyManifestSummary | null> => {
      const url = `${await relayUrl()}/.well-known/motebit-transparency.json`;
      try {
        const resp = await fetch(url, { headers: { Accept: "application/json" } });
        if (!resp.ok) return null;
        const body = (await resp.json()) as {
          relay_id?: string;
          relay_public_key?: string;
        };
        if (typeof body.relay_id !== "string" || typeof body.relay_public_key !== "string") {
          return null;
        }
        return { relay_id: body.relay_id, relay_public_key: body.relay_public_key };
      } catch {
        return null;
      }
    },
    fetchRetentionManifest: async (): Promise<RetentionManifest | null> => {
      const url = `${await relayUrl()}/.well-known/motebit-retention.json`;
      try {
        const resp = await fetch(url, { headers: { Accept: "application/json" } });
        if (!resp.ok) return null;
        return (await resp.json()) as RetentionManifest;
      } catch {
        return null;
      }
    },
    verifyManifest: async (manifest, operatorPublicKeyHex) => {
      const keyBytes = hexToBytes(operatorPublicKeyHex);
      const result = await verifyRetentionManifest(
        manifest as Parameters<typeof verifyRetentionManifest>[0],
        keyBytes,
      );
      return { valid: result.valid, errors: result.errors };
    },
  };
}

const ALL_KINDS: ActivityKind[] = [
  "deletion",
  "consent",
  "export",
  "trust",
  "skill",
  "governance",
  "other",
];

export function ActivityPanel({ visible, app, onClose }: ActivityPanelProps): React.ReactElement {
  const colors = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const activityRef = useRef<ReturnType<typeof createActivityController> | null>(null);
  const retentionRef = useRef<ReturnType<typeof createRetentionController> | null>(null);
  const selfTestRef = useRef<ReturnType<typeof createSelfTestController> | null>(null);

  const [state, setState] = useState<ActivityState>(() => ({
    events: [],
    filter: { kinds: new Set(), search: "" },
    loading: false,
    error: null,
  }));
  const [retention, setRetention] = useState<RetentionState>(() => ({
    manifest: null,
    operatorId: null,
    operatorPublicKey: null,
    verification: "idle",
    errors: [],
    fetchedAt: null,
  }));
  const [selfTest, setSelfTest] = useState<SelfTestState>(() => ({
    status: "idle",
    summary: "",
    hint: null,
    httpStatus: null,
    taskId: null,
    lastRunAt: null,
  }));

  useEffect(() => {
    const ctrl = createActivityController(createMobileActivityAdapter(app));
    activityRef.current = ctrl;
    const unsubscribe = ctrl.subscribe(setState);
    const rctrl = createRetentionController(createMobileRetentionAdapter(app));
    retentionRef.current = rctrl;
    const runsub = rctrl.subscribe(setRetention);
    // Self-test controller — third leg of the sovereignty-visible
    // trifecta. The user clicks the button to fire `cmdSelfTest`
    // through the live relay; result lands in the badge below the
    // retention block.
    const stAdapter: SelfTestFetchAdapter = {
      runSelfTest: async () => {
        const r = await app.runSelfTestNow();
        return {
          status: r.status,
          summary: r.summary,
          hint: r.hint,
          httpStatus: r.httpStatus,
          taskId: r.taskId,
        };
      },
    };
    const stCtrl = createSelfTestController(stAdapter);
    selfTestRef.current = stCtrl;
    const stUnsub = stCtrl.subscribe(setSelfTest);
    return () => {
      unsubscribe();
      runsub();
      stUnsub();
      ctrl.dispose();
      rctrl.dispose();
      stCtrl.dispose();
      activityRef.current = null;
      retentionRef.current = null;
      selfTestRef.current = null;
    };
  }, [app]);

  useEffect(() => {
    if (!visible) return;
    void activityRef.current?.refresh();
    void retentionRef.current?.refresh();
    // Self-test does NOT auto-run on open — it submits a task to the
    // live relay; the user clicks the button when they want to verify.
  }, [visible]);

  const filtered = activityRef.current?.filteredView() ?? state.events;

  const handleToggleKind = (kind: ActivityKind): void => {
    activityRef.current?.toggleKind(kind);
  };

  const summary = retention.manifest !== null ? summarizeRetentionCeilings(retention.manifest) : [];
  const verificationLabel: Record<RetentionState["verification"], string> = {
    idle: "—",
    loading: "checking",
    verified: "verified",
    invalid: "invalid",
    unreachable: "unreachable",
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerTitle}>Activity</Text>
            <View style={styles.countBadge}>
              <Text style={styles.countText}>{filtered.length}</Text>
            </View>
          </View>
          <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
            <Text style={styles.closeBtn}>Done</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.retentionBlock}>
          <View style={styles.retentionHeader}>
            <Text style={styles.retentionOperator}>{retention.operatorId ?? "operator"}</Text>
            <View
              style={[
                styles.retentionStatus,
                retention.verification === "verified" && styles.retentionStatusVerified,
                retention.verification === "invalid" && styles.retentionStatusInvalid,
              ]}
            >
              <Text
                style={
                  retention.verification === "verified"
                    ? styles.retentionStatusTextActive
                    : styles.retentionStatusText
                }
              >
                {verificationLabel[retention.verification]}
              </Text>
            </View>
          </View>
          {summary.length > 0 ? (
            <View style={styles.retentionTable}>
              {summary.map((row) => (
                <View key={row.sensitivity} style={styles.retentionRow}>
                  <Text style={styles.retentionTier}>{row.sensitivity.toUpperCase()}</Text>
                  <Text style={styles.retentionDays}>
                    {row.days === null ? "no expiry" : `${row.days}d`}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
          {retention.errors.length > 0 && retention.verification !== "verified" ? (
            <Text style={styles.retentionError}>{retention.errors[0]}</Text>
          ) : null}

          <View style={styles.selfTestRow}>
            <TouchableOpacity
              style={[
                styles.selfTestBtn,
                selfTest.status === "running" && styles.selfTestBtnDisabled,
              ]}
              onPress={() => void selfTestRef.current?.run()}
              disabled={selfTest.status === "running"}
              activeOpacity={0.7}
            >
              <Text style={styles.selfTestBtnText}>Run security self-test</Text>
            </TouchableOpacity>
            <View
              style={[
                styles.retentionStatus,
                selfTest.status === "passed" && styles.retentionStatusVerified,
                (selfTest.status === "failed" ||
                  selfTest.status === "task_failed" ||
                  selfTest.status === "timeout") &&
                  styles.retentionStatusInvalid,
              ]}
            >
              <Text
                style={
                  selfTest.status === "passed" ||
                  selfTest.status === "failed" ||
                  selfTest.status === "task_failed" ||
                  selfTest.status === "timeout"
                    ? styles.retentionStatusTextActive
                    : styles.retentionStatusText
                }
              >
                {selfTestBadgeLabel(selfTest.status)}
              </Text>
            </View>
          </View>
          {selfTest.status !== "idle" && selfTest.status !== "passed" && selfTest.summary !== "" ? (
            <Text style={styles.retentionError}>{selfTest.summary}</Text>
          ) : null}
        </View>

        <View style={styles.searchBar}>
          <TextInput
            style={styles.searchInput}
            value={state.filter.search}
            onChangeText={(q) => activityRef.current?.setSearch(q)}
            placeholder="Search action, target..."
            placeholderTextColor={colors.inputPlaceholder}
            autoCorrect={false}
          />
        </View>

        <View style={styles.chipBar}>
          {ALL_KINDS.map((kind) => {
            const active = state.filter.kinds.has(kind);
            return (
              <TouchableOpacity
                key={kind}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => handleToggleKind(kind)}
                activeOpacity={0.7}
              >
                <Text style={active ? styles.chipTextActive : styles.chipText}>
                  {KIND_LABEL[kind]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {state.error !== null ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>Failed to load: {state.error}</Text>
          </View>
        ) : filtered.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyText}>
              {state.events.length === 0
                ? "No activity recorded yet."
                : "No activity matches your filter."}
            </Text>
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(item: ActivityEvent) => item.id}
            style={styles.list}
            contentContainerStyle={styles.listContent}
            renderItem={({ item }: { item: ActivityEvent }) => {
              const target = shortenTarget(item.target_id);
              const signed =
                item.signature !== null && item.signature !== undefined && item.signature !== "";
              return (
                <View style={styles.activityItem}>
                  <View style={styles.activityLine1}>
                    <Text style={styles.activityAction}>{actionLabel(item.action)}</Text>
                    {target !== "" ? <Text style={styles.activityTarget}>{target}</Text> : null}
                    {signed ? (
                      <View style={styles.signedBadge}>
                        <Text style={styles.signedText}>SIGNED</Text>
                      </View>
                    ) : null}
                    {item.source === "event_log" ? (
                      <View style={styles.intentBadge}>
                        <Text style={styles.intentText}>INTENT</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.activityTime}>{formatTimeAgo(item.at)}</Text>
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
    retentionBlock: {
      marginHorizontal: 16,
      marginTop: 12,
      padding: 10,
      borderRadius: 8,
      backgroundColor: c.inputBg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.borderLight,
    },
    retentionHeader: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
    retentionOperator: { color: c.textPrimary, fontSize: 12, fontWeight: "500" },
    retentionStatus: {
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 3,
      backgroundColor: c.borderLight,
    },
    retentionStatusVerified: { backgroundColor: c.accent },
    retentionStatusInvalid: { backgroundColor: "#c0392b" },
    retentionStatusText: {
      color: c.textMuted,
      fontSize: 9,
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    retentionStatusTextActive: {
      color: "#fff",
      fontSize: 9,
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    retentionTable: { gap: 2 },
    retentionRow: { flexDirection: "row", justifyContent: "space-between" },
    retentionTier: {
      color: c.textMuted,
      fontSize: 10,
      letterSpacing: 0.5,
      fontVariant: ["tabular-nums"],
    },
    retentionDays: { color: c.textSecondary, fontSize: 10, fontVariant: ["tabular-nums"] },
    retentionError: { color: c.textMuted, fontSize: 10, marginTop: 6 },
    selfTestRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginTop: 8,
      paddingTop: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.borderLight,
    },
    selfTestBtn: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.borderLight,
      backgroundColor: c.inputBg,
    },
    selfTestBtnDisabled: { opacity: 0.5 },
    selfTestBtnText: { color: c.textPrimary, fontSize: 11 },
    searchBar: { paddingHorizontal: 16, paddingVertical: 10 },
    searchInput: {
      backgroundColor: c.inputBg,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      color: c.inputText,
      fontSize: 15,
    },
    chipBar: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
      paddingHorizontal: 16,
      paddingBottom: 8,
    },
    chip: {
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.borderLight,
      backgroundColor: "transparent",
    },
    chipActive: { backgroundColor: c.accent, borderColor: c.accent },
    chipText: { color: c.textMuted, fontSize: 12 },
    chipTextActive: { color: "#fff", fontSize: 12 },
    list: { flex: 1 },
    listContent: { paddingHorizontal: 16, paddingBottom: 40 },
    emptyContainer: { flex: 1, justifyContent: "center", alignItems: "center" },
    emptyText: { color: c.textMuted, fontSize: 13, textAlign: "center", padding: 24 },
    activityItem: {
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.borderLight,
    },
    activityLine1: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
    activityAction: { color: c.textPrimary, fontSize: 13, fontWeight: "500" },
    activityTarget: {
      color: c.textMuted,
      fontSize: 11,
      backgroundColor: c.inputBg,
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 4,
    },
    signedBadge: {
      backgroundColor: c.accent,
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 3,
    },
    signedText: {
      color: "#fff",
      fontSize: 9,
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    intentBadge: {
      backgroundColor: c.borderLight,
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 3,
    },
    intentText: {
      color: c.textMuted,
      fontSize: 9,
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    activityTime: { color: c.textGhost, fontSize: 10, marginTop: 3 },
  });
}
