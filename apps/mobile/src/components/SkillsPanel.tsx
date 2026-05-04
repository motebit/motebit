/**
 * Mobile Skills panel — closes the cross-surface arc started 2026-05-04
 * (web + desktop dev-mode shipped earlier the same day; mobile is the
 * third real consumer of `RegistryBackedSkillsPanelAdapter` from
 * `@motebit/panels`).
 *
 * Two sections, installed-first:
 *   • Installed — `SkillRegistry.list()` over `ExpoSqliteSkillStorageAdapter`.
 *     Per-row Enable/Disable + Trust/Untrust + Remove. Tap row → detail.
 *   • Browse — public-read `/api/v1/skills/discover` from the configured
 *     relay. Per-row Install button fetches the bundle from
 *     `/api/v1/skills/:submitter/:name/:version` and routes through the
 *     controller's `installFromSource({ kind: "url" })`.
 *
 * Privilege boundary: install + envelope-bytes verification run in the
 * same JS context as the panel UI — same trade-off web + desktop-dev
 * carry. The `requestInstallConsent` callback opens a native Alert
 * (calm-software discipline: Cancel is the default action; only
 * medical/financial/secret tiers prompt). See
 * `packages/skills/CLAUDE.md` rule 5.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Modal,
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import {
  createSkillsController,
  filterSkillsView,
  RegistryBackedSkillsPanelAdapter,
  requiresInstallConsent,
  type RequestInstallConsentFn,
  type SkillBundleShape,
  type SkillSummary,
  type SkillsPanelState,
} from "@motebit/panels";
import type { SkillRegistryBundle, SkillRegistryEntry, SkillRegistryListing } from "@motebit/sdk";

import type { MobileApp } from "../mobile-app";
import { useTheme, type ThemeColors } from "../theme";

// ── UX constants ──────────────────────────────────────────────────────

const PROVENANCE_LABEL: Record<string, string> = {
  verified: "verified",
  trusted_unsigned: "trusted",
  unsigned: "unsigned",
  unverified: "unverified",
};

const SENSITIVITY_LABEL: Record<string, string> = {
  none: "",
  personal: "personal",
  medical: "medical",
  financial: "financial",
  secret: "secret",
};

function formatTimeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function shortSubmitter(did: string): string {
  if (did.length <= 24) return did;
  return `${did.slice(0, 14)}…${did.slice(-6)}`;
}

// ── Consent prompt — native Alert ─────────────────────────────────────
//
// React Native's Alert is the native iOS/Android dialog primitive. The
// shape matches the adapter's `requestInstallConsent` contract: returns
// a Promise<boolean>. Calm-software discipline: Cancel is the
// destructive-style action by convention (so users don't reflexively
// confirm); Install is the explicit positive choice.

const showConsentAlert: RequestInstallConsentFn = (request) =>
  new Promise<boolean>((resolve) => {
    Alert.alert(
      `Install ${request.skillName} v${request.skillVersion}?`,
      `This skill declares it works with ${request.sensitivity} data.\n\n` +
        `On this device, install and verification run in the same context as the panel UI. ` +
        `The selector still blocks auto-load of ${request.sensitivity}-tier skills against external AI providers; ` +
        `bytes will live in app-private SQLite storage.\n\n${request.description}`,
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Install", style: "default", onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });

// ── Component ─────────────────────────────────────────────────────────

interface SkillsPanelProps {
  visible: boolean;
  app: MobileApp;
  onClose: () => void;
}

export function SkillsPanel({ visible, app, onClose }: SkillsPanelProps): React.ReactElement {
  const colors = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const ctrlRef = useRef<ReturnType<typeof createSkillsController> | null>(null);

  const [state, setState] = useState<SkillsPanelState>(() => ({
    skills: [],
    search: "",
    selectedSkill: null,
    loading: false,
    detailLoading: false,
    error: null,
    lastInstall: null,
    lastRemoval: null,
  }));
  const [browseEntries, setBrowseEntries] = useState<SkillRegistryEntry[]>([]);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [installingName, setInstallingName] = useState<string | null>(null);

  // Construct the adapter + controller once per app instance; tear down
  // when the modal unmounts so a re-mount gets a fresh subscription.
  useEffect(() => {
    const registry = app.getSkillRegistry();
    if (registry === null) {
      ctrlRef.current = null;
      return;
    }
    const adapter = new RegistryBackedSkillsPanelAdapter(registry, {
      fetchBundle: async (url: string): Promise<SkillBundleShape> => {
        const resp = await fetch(url, { headers: { Accept: "application/json" } });
        if (!resp.ok) {
          throw new Error(`Relay returned ${resp.status}: ${resp.statusText}`);
        }
        return (await resp.json()) as SkillRegistryBundle;
      },
      requestInstallConsent: showConsentAlert,
    });
    const ctrl = createSkillsController(adapter);
    ctrlRef.current = ctrl;
    const unsubscribe = ctrl.subscribe(() => {
      setState({ ...ctrl.getState() });
    });
    return () => {
      unsubscribe();
      ctrl.dispose();
      ctrlRef.current = null;
    };
  }, [app]);

  // Refresh both sections when modal opens. `visible` is the only
  // dependency on purpose — refreshBrowse closes over `app.getSyncUrl()`
  // which is stable across mounts and the controller's refresh is
  // idempotent. Adding either to the dep list would cause the panel to
  // refresh on every render, defeating the open-time-only intent.
  useEffect(() => {
    if (!visible) return;
    const ctrl = ctrlRef.current;
    if (ctrl !== null) void ctrl.refresh();
    void refreshBrowse();
  }, [visible]);

  async function refreshBrowse(): Promise<void> {
    const syncUrl = await app.getSyncUrl();
    const relay = (syncUrl ?? DEFAULT_RELAY_URL).replace(/\/$/, "");
    let resp: Response;
    try {
      resp = await fetch(`${relay}/api/v1/skills/discover?limit=100`, {
        headers: { Accept: "application/json" },
      });
    } catch (err: unknown) {
      setBrowseEntries([]);
      setBrowseError(
        `Could not reach the relay (${relay}). ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (!resp.ok) {
      setBrowseEntries([]);
      setBrowseError(`Relay returned ${resp.status}: ${resp.statusText}`);
      return;
    }
    try {
      const listing = (await resp.json()) as SkillRegistryListing;
      setBrowseEntries(listing.entries);
      setBrowseError(null);
    } catch (err: unknown) {
      setBrowseEntries([]);
      setBrowseError(
        `Relay returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function handleInstall(entry: SkillRegistryEntry): Promise<void> {
    const ctrl = ctrlRef.current;
    if (ctrl === null) return;
    const syncUrl = await app.getSyncUrl();
    const relay = (syncUrl ?? DEFAULT_RELAY_URL).replace(/\/$/, "");
    const url = `${relay}/api/v1/skills/${encodeURIComponent(entry.submitter_motebit_id)}/${encodeURIComponent(entry.name)}/${encodeURIComponent(entry.version)}`;
    setInstallingName(entry.name);
    try {
      await ctrl.install({ kind: "url", url });
    } finally {
      setInstallingName(null);
    }
  }

  async function handleEnabledToggle(skill: SkillSummary): Promise<void> {
    const ctrl = ctrlRef.current;
    if (ctrl === null) return;
    if (skill.enabled) await ctrl.disableSkill(skill.name);
    else await ctrl.enableSkill(skill.name);
  }

  async function handleTrustToggle(skill: SkillSummary): Promise<void> {
    const ctrl = ctrlRef.current;
    if (ctrl === null) return;
    if (skill.trusted) await ctrl.untrustSkill(skill.name);
    else await ctrl.trustSkill(skill.name);
  }

  function handleRemove(skill: SkillSummary): void {
    const ctrl = ctrlRef.current;
    if (ctrl === null) return;
    Alert.alert(
      `Remove ${skill.name}?`,
      "The skill bundle is deleted from this device. The audit event records the removal.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void ctrl.removeSkill(skill.name);
          },
        },
      ],
    );
  }

  const installed = useMemo(() => filterSkillsView(state.skills, ""), [state.skills]);
  const registryUnavailable = ctrlRef.current === null && state.skills.length === 0;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.headerTitle}>Skills</Text>
            <Text style={styles.countBadge}>{installed.length}</Text>
          </View>
          <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
            <Text style={styles.closeBtn}>Done</Text>
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {registryUnavailable && (
            <Text style={styles.emptyText}>Skills storage is starting up…</Text>
          )}

          {/* Installed section */}
          <Text style={styles.sectionHeader}>INSTALLED</Text>
          {state.loading && installed.length === 0 ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={colors.textMuted} />
            </View>
          ) : installed.length === 0 ? (
            <Text style={styles.emptyText}>
              No skills installed yet. Browse and install one below.
            </Text>
          ) : (
            <FlatList
              data={installed}
              keyExtractor={(item) => item.name}
              scrollEnabled={false}
              renderItem={({ item }) => (
                <InstalledRow
                  skill={item}
                  styles={styles}
                  onToggleEnabled={() => handleEnabledToggle(item)}
                  onToggleTrusted={() => handleTrustToggle(item)}
                  onRemove={() => {
                    handleRemove(item);
                  }}
                />
              )}
            />
          )}

          {/* Browse section */}
          <Text style={styles.sectionHeader}>BROWSE</Text>
          {browseError !== null ? (
            <Text style={styles.emptyText}>{browseError}</Text>
          ) : browseEntries.length === 0 ? (
            <Text style={styles.emptyText}>No published skills on this relay yet.</Text>
          ) : (
            <FlatList
              data={browseEntries}
              keyExtractor={(item) => `${item.submitter_motebit_id}/${item.name}@${item.version}`}
              scrollEnabled={false}
              renderItem={({ item }) => (
                <BrowseRow
                  entry={item}
                  styles={styles}
                  installing={installingName === item.name}
                  needsConsent={requiresInstallConsent(item.sensitivity)}
                  onInstall={() => handleInstall(item)}
                />
              )}
            />
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

// ── Sub-components ────────────────────────────────────────────────────

const DEFAULT_RELAY_URL = "https://relay.motebit.com";

function InstalledRow({
  skill,
  styles,
  onToggleEnabled,
  onToggleTrusted,
  onRemove,
}: {
  skill: SkillSummary;
  styles: ReturnType<typeof createStyles>;
  onToggleEnabled: () => Promise<void>;
  onToggleTrusted: () => Promise<void>;
  onRemove: () => void;
}): React.ReactElement {
  const provLabel = PROVENANCE_LABEL[skill.provenance_status] ?? skill.provenance_status;
  const sensLabel = SENSITIVITY_LABEL[skill.sensitivity] ?? "";
  const installedAt = new Date(skill.installed_at).getTime();
  const showTrust = skill.provenance_status !== "verified";
  return (
    <View style={[styles.row, !skill.enabled && styles.rowDisabled]}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowName}>{skill.name}</Text>
        <Text style={styles.rowVersion}>v{skill.version}</Text>
        <View style={[styles.badge, badgeStyleForProvenance(styles, skill.provenance_status)]}>
          <Text
            style={[styles.badgeText, badgeTextStyleForProvenance(styles, skill.provenance_status)]}
          >
            {provLabel}
          </Text>
        </View>
        {sensLabel !== "" && (
          <View style={[styles.badge, styles.sensBadge]}>
            <Text style={[styles.badgeText, styles.sensBadgeText]}>{sensLabel}</Text>
          </View>
        )}
      </View>
      <Text style={styles.rowDescription}>{skill.description}</Text>
      <View style={styles.rowMeta}>
        {Number.isFinite(installedAt) && (
          <Text style={styles.metaText}>{formatTimeAgo(installedAt)}</Text>
        )}
        {skill.platforms !== undefined && skill.platforms.length > 0 && (
          <Text style={styles.metaText}>{skill.platforms.join(", ")}</Text>
        )}
      </View>
      <View style={styles.rowActions}>
        <TouchableOpacity
          style={styles.actionBtn}
          activeOpacity={0.7}
          onPress={() => {
            void onToggleEnabled();
          }}
        >
          <Text style={styles.actionText}>{skill.enabled ? "Disable" : "Enable"}</Text>
        </TouchableOpacity>
        {showTrust && (
          <TouchableOpacity
            style={styles.actionBtn}
            activeOpacity={0.7}
            onPress={() => {
              void onToggleTrusted();
            }}
          >
            <Text style={styles.actionText}>{skill.trusted ? "Untrust" : "Trust"}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={[styles.actionBtn, styles.actionBtnRemove]}
          activeOpacity={0.7}
          onPress={onRemove}
        >
          <Text style={[styles.actionText, styles.actionTextRemove]}>Remove</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function BrowseRow({
  entry,
  styles,
  installing,
  needsConsent,
  onInstall,
}: {
  entry: SkillRegistryEntry;
  styles: ReturnType<typeof createStyles>;
  installing: boolean;
  needsConsent: boolean;
  onInstall: () => Promise<void>;
}): React.ReactElement {
  const sensLabel = SENSITIVITY_LABEL[entry.sensitivity] ?? "";
  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <Text style={styles.rowName}>{entry.name}</Text>
        <Text style={styles.rowVersion}>v{entry.version}</Text>
        <View style={[styles.badge, styles.verifiedBadge]}>
          <Text style={[styles.badgeText, styles.verifiedBadgeText]}>
            {entry.featured ? "verified · featured" : "verified"}
          </Text>
        </View>
        {sensLabel !== "" && (
          <View style={[styles.badge, styles.sensBadge]}>
            <Text style={[styles.badgeText, styles.sensBadgeText]}>{sensLabel}</Text>
          </View>
        )}
      </View>
      <Text style={styles.rowDescription}>{entry.description}</Text>
      <View style={styles.rowMeta}>
        <Text style={styles.metaText}>{shortSubmitter(entry.submitter_motebit_id)}</Text>
        <Text style={styles.metaText}>{formatTimeAgo(entry.submitted_at)}</Text>
      </View>
      <View style={styles.rowActions}>
        <TouchableOpacity
          style={styles.actionBtn}
          activeOpacity={0.7}
          disabled={installing}
          onPress={() => {
            void onInstall();
          }}
        >
          <Text style={styles.actionText}>
            {installing ? "Installing…" : needsConsent ? "Install…" : "Install"}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────

function badgeStyleForProvenance(
  styles: ReturnType<typeof createStyles>,
  status: string,
): { backgroundColor: string; borderColor?: string } {
  switch (status) {
    case "verified":
      return styles.verifiedBadge;
    case "trusted_unsigned":
      return styles.trustedBadge;
    case "unverified":
      return styles.unverifiedBadge;
    default:
      return styles.unsignedBadge;
  }
}

function badgeTextStyleForProvenance(
  styles: ReturnType<typeof createStyles>,
  status: string,
): { color: string } {
  switch (status) {
    case "verified":
      return styles.verifiedBadgeText;
    case "trusted_unsigned":
      return styles.trustedBadgeText;
    case "unverified":
      return styles.unverifiedBadgeText;
    default:
      return styles.unsignedBadgeText;
  }
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
      color: c.textMuted,
      fontSize: 12,
      paddingHorizontal: 6,
      paddingVertical: 2,
      backgroundColor: c.bgSecondary,
      borderRadius: 8,
      overflow: "hidden",
    },
    closeBtn: { color: c.accent, fontSize: 16, fontWeight: "600" },
    scroll: { flex: 1 },
    scrollContent: { padding: 16 },
    sectionHeader: {
      fontSize: 10,
      letterSpacing: 1.4,
      color: c.textMuted,
      marginTop: 12,
      marginBottom: 8,
    },
    loadingRow: { paddingVertical: 32, alignItems: "center" },
    emptyText: {
      color: c.textMuted,
      fontSize: 12,
      paddingVertical: 16,
      paddingHorizontal: 4,
      lineHeight: 18,
    },
    row: {
      padding: 12,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.borderPrimary,
      marginBottom: 8,
      backgroundColor: c.bgSecondary,
    },
    rowDisabled: { opacity: 0.55 },
    rowHeader: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 6,
      marginBottom: 4,
    },
    rowName: { color: c.textPrimary, fontSize: 13, fontWeight: "600" },
    rowVersion: { color: c.textMuted, fontSize: 11 },
    rowDescription: { color: c.textSecondary, fontSize: 12, marginTop: 2 },
    rowMeta: { flexDirection: "row", gap: 10, marginTop: 6 },
    metaText: { color: c.textMuted, fontSize: 10 },
    rowActions: { flexDirection: "row", gap: 6, marginTop: 10, flexWrap: "wrap" },
    actionBtn: {
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 5,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.borderInput,
      backgroundColor: c.bgTertiary,
    },
    actionBtnRemove: {},
    actionText: { color: c.textSecondary, fontSize: 11 },
    actionTextRemove: { color: "#f87171" },
    badge: {
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 8,
    },
    badgeText: { fontSize: 10 },
    verifiedBadge: { backgroundColor: "rgba(74, 222, 128, 0.15)" },
    verifiedBadgeText: { color: "#22c55e" },
    trustedBadge: { backgroundColor: "rgba(245, 158, 11, 0.15)" },
    trustedBadgeText: { color: "#d97706" },
    unsignedBadge: { backgroundColor: c.bgTertiary },
    unsignedBadgeText: { color: c.textMuted },
    unverifiedBadge: { backgroundColor: "rgba(248, 113, 113, 0.15)" },
    unverifiedBadgeText: { color: "#f87171" },
    sensBadge: { backgroundColor: "rgba(168, 85, 247, 0.15)" },
    sensBadgeText: { color: "#a855f7" },
  });
}
