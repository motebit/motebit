/**
 * Shared building blocks for the settings tab components.
 *
 * Extracted from the old monolithic `SettingsModal.tsx` (2,129 lines)
 * during Target 11 of the mobile extraction plan. Every tab imports
 * from here: the stylesheet factory, the tab-key + vendor + backend
 * types, the preset color swatches, the risk labels, the
 * `PolicySummary` helper, and the pure color math used by the
 * appearance picker.
 *
 * The stylesheet factory is the load-bearing member — every tab calls
 * `useMemo(() => createSettingsStyles(colors), [colors])` so there's
 * a single source of truth for the full settings visual language.
 * Keeping it in one module means adding a new tab only requires
 * importing from here; there's no per-tab style drift.
 */

import React, { useMemo } from "react";
import { View, Text, StyleSheet, Platform } from "react-native";
import type { InteriorColor } from "@motebit/runtime";
import type { MobileLocalBackend } from "../../mobile-app";
import { APPROVAL_PRESET_CONFIGS } from "../../mobile-app";
import { useTheme, type ThemeColors } from "../../theme";

// === Tab identity ===

export type Tab = "appearance" | "intelligence" | "governance" | "identity" | "billing";

export const TABS: { key: Tab; label: string }[] = [
  { key: "appearance", label: "Appearance" },
  { key: "intelligence", label: "Intelligence" },
  { key: "governance", label: "Governance" },
  { key: "identity", label: "Identity" },
  { key: "billing", label: "Billing" },
];

// === Appearance ===

export type ThemePreference = "light" | "dark" | "system";

export const THEME_OPTIONS: { key: ThemePreference; label: string }[] = [
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
  { key: "system", label: "System" },
];

/** Hex colors for preview circles (same 7 as desktop, moonlight first). */
export const PRESET_COLORS: Record<string, string> = {
  moonlight: "#f0f0ff",
  amber: "#ffda99",
  rose: "#ffd0e0",
  violet: "#d0b8ff",
  cyan: "#b8f0ff",
  ember: "#ffb8a0",
  sage: "#c0f0c8",
};

// === Intelligence ===

export type ProviderType =
  | "local-server"
  | "anthropic"
  | "openai"
  | "google"
  | "proxy"
  | "on-device";

/**
 * Re-export the canonical type name under a shorter local alias so the
 * tab prop shapes don't have to be renamed. Source of truth lives in
 * mobile-app.ts so the three-mode wire format and the UI agree.
 */
export type LocalBackend = MobileLocalBackend;

export const TTS_VOICE_OPTIONS = [
  { key: "alloy", label: "Alloy" },
  { key: "echo", label: "Echo" },
  { key: "fable", label: "Fable" },
  { key: "onyx", label: "Onyx" },
  { key: "nova", label: "Nova" },
  { key: "shimmer", label: "Shimmer" },
];

// === Governance ===

export const RISK_LABELS: Record<number, string> = {
  0: "R0 Read",
  1: "R1 Draft",
  2: "R2 Write",
  3: "R3 Execute",
  4: "R4 Money",
};

export function PolicySummary({
  preset,
  isOperatorMode,
}: {
  preset: string;
  isOperatorMode: boolean;
}): React.ReactElement {
  const themeColors = useTheme();
  const config = APPROVAL_PRESET_CONFIGS[preset] ?? APPROVAL_PRESET_CONFIGS.balanced!;
  const autoAllow =
    config.requireApprovalAbove === 0
      ? "Nothing"
      : `Up to ${RISK_LABELS[config.requireApprovalAbove - 1] ?? `R${config.requireApprovalAbove - 1}`}`;
  const requireApproval = `${RISK_LABELS[config.requireApprovalAbove] ?? `R${config.requireApprovalAbove}`}+`;
  const deny = `Above ${RISK_LABELS[config.denyAbove - 1] ?? `R${config.denyAbove - 1}`}`;
  return (
    <View
      style={{
        padding: 10,
        borderRadius: 8,
        backgroundColor: themeColors.bgSecondary,
        marginTop: 8,
      }}
    >
      <Text style={{ fontSize: 11, color: themeColors.textMuted, lineHeight: 18 }}>
        Auto-allow: {autoAllow}
        {"\n"}
        Require approval: {requireApproval}
        {"\n"}
        Deny: {deny}
        {"\n"}
        Operator mode: {isOperatorMode ? "on" : "off"}
      </Text>
    </View>
  );
}

// === Color math (copied from desktop color-picker.ts) ===

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  return [r + m, g + m, b + m];
}

export function deriveInteriorColor(hue: number, saturation: number): InteriorColor {
  const tintL = 0.92 - saturation * 0.12;
  const tintS = saturation * 0.9;
  const tint = hslToRgb(hue, tintS, tintL);

  const glowL = 0.72 - saturation * 0.17;
  const glowS = saturation * 0.8 + 0.2;
  const glow = hslToRgb(hue, glowS, glowL);

  return { tint, glow };
}

// === Shared stylesheet ===

/** Hook that memoizes the settings stylesheet against the current theme. */
export function useSettingsStyles(): ReturnType<typeof createSettingsStyles> {
  const colors = useTheme();
  return useMemo(() => createSettingsStyles(colors), [colors]);
}

export function createSettingsStyles(c: ThemeColors) {
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
    cancelBtn: { color: c.textMuted, fontSize: 16 },
    headerTitle: { color: c.textPrimary, fontSize: 17, fontWeight: "600" },
    saveBtn: { color: c.accent, fontSize: 16, fontWeight: "600" },

    tabBar: { flexDirection: "row", paddingHorizontal: 12, paddingTop: 12, gap: 4 },
    tab: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center" },
    tabActive: { backgroundColor: c.buttonSecondaryBg },
    tabText: { color: c.textMuted, fontSize: 12, fontWeight: "600" },
    tabTextActive: { color: c.textPrimary },

    body: { flex: 1 },
    bodyContent: { padding: 20 },

    sectionTitle: {
      color: c.textMuted,
      fontSize: 12,
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: 0.5,
      marginTop: 20,
      marginBottom: 10,
    },

    // Theme toggle
    themeToggleGroup: { flexDirection: "row", gap: 8, marginBottom: 20 },
    themeOption: {
      flex: 1,
      paddingVertical: 10,
      borderRadius: 8,
      backgroundColor: c.bgTertiary,
      alignItems: "center",
    },
    themeOptionSelected: {
      backgroundColor: c.borderLight,
      borderWidth: 1,
      borderColor: c.accentSoft,
    },
    themeOptionText: { color: c.textMuted, fontSize: 13, fontWeight: "500" },
    themeOptionTextSelected: { color: c.textSecondary },

    // Appearance
    presetGrid: { flexDirection: "row", flexWrap: "wrap", gap: 14, justifyContent: "center" },
    presetCircle: {
      width: 52,
      height: 52,
      borderRadius: 26,
      borderWidth: 2,
      borderColor: "transparent",
      justifyContent: "center",
      alignItems: "center",
    },
    presetSelected: { borderColor: c.accent },
    presetCheck: { width: 14, height: 14, borderRadius: 7, backgroundColor: c.accent },
    presetLabel: {
      color: c.textMuted,
      fontSize: 14,
      textAlign: "center",
      marginTop: 12,
      textTransform: "capitalize",
    },

    // Custom color picker
    customPickerContainer: { marginTop: 16, alignItems: "center", gap: 12 },
    customPreviewCircle: {
      width: 48,
      height: 48,
      borderRadius: 24,
      borderWidth: 2,
      borderColor: c.accent,
      marginBottom: 4,
    },
    customSliderLabel: {
      color: c.textMuted,
      fontSize: 11,
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: 0.5,
      alignSelf: "flex-start",
    },
    customSliderTrack: {
      width: "100%",
      height: 28,
      borderRadius: 6,
      backgroundColor: c.borderPrimary,
      justifyContent: "center",
      position: "relative",
    },
    customSliderThumb: {
      position: "absolute",
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 2,
      borderColor: "#fff",
      top: 4,
      marginLeft: -10,
    },

    // Radio
    radioGroup: { gap: 8 },
    radioItem: {
      backgroundColor: c.bgSecondary,
      borderRadius: 10,
      padding: 14,
      borderWidth: 1,
      borderColor: c.borderPrimary,
    },
    radioActive: { borderColor: c.accent, backgroundColor: c.accentSoft },
    radioText: { color: c.textSecondary, fontSize: 15, fontWeight: "600" },
    radioTextActive: { color: c.textPrimary },
    radioDesc: { color: c.textMuted, fontSize: 12, marginTop: 2 },
    voiceHint: { color: c.textGhost, fontSize: 11, marginTop: 4, marginBottom: 4 },
    voiceGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    voiceChip: {
      backgroundColor: c.bgSecondary,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: c.borderPrimary,
    },
    voiceChipActive: { borderColor: c.accent, backgroundColor: c.accentSoft },
    voiceChipText: { color: c.textMuted, fontSize: 13, fontWeight: "600" },
    voiceChipTextActive: { color: c.textPrimary },

    // Fields
    textField: {
      backgroundColor: c.inputBg,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      color: c.inputText,
      fontSize: 15,
    },
    fieldRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginVertical: 6,
    },
    fieldLabel: { color: c.textSecondary, fontSize: 14 },
    numberField: {
      backgroundColor: c.inputBg,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      color: c.inputText,
      fontSize: 15,
      width: 70,
      textAlign: "center",
    },

    // Switch
    switchRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginVertical: 8,
    },
    switchLabel: { color: c.textSecondary, fontSize: 14 },

    // Pin
    pinButton: {
      backgroundColor: c.buttonSecondaryBg,
      borderRadius: 8,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    pinButtonText: { color: c.accent, fontSize: 14, fontWeight: "600" },

    // Identity
    monoValue: {
      color: c.textSecondary,
      fontSize: 13,
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
      backgroundColor: c.bgSecondary,
      borderRadius: 8,
      padding: 12,
      overflow: "hidden",
    },
    hint: { color: c.textGhost, fontSize: 11, textAlign: "center", marginTop: 8 },
    linkDeviceButton: {
      backgroundColor: c.borderLight,
      borderRadius: 10,
      paddingVertical: 14,
      marginTop: 20,
      alignItems: "center",
      borderWidth: 1,
      borderColor: c.accentSoft,
    },
    linkDeviceText: { color: c.accent, fontSize: 15, fontWeight: "600" },
    identityFieldRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    identityFieldValue: { flex: 1 },
    identityCopyLabel: {
      color: c.textMuted,
      fontSize: 12,
      fontWeight: "600",
      minWidth: 46,
      textAlign: "center",
    },
    identityCopiedLabel: { color: c.statusSuccess },
    rotateKeyButton: {
      backgroundColor: c.buttonSecondaryBg,
      borderRadius: 10,
      paddingVertical: 14,
      marginTop: 20,
      alignItems: "center",
      borderWidth: 1,
      borderColor: c.statusWarning,
    },
    rotateKeyText: { color: c.statusWarning, fontSize: 15, fontWeight: "600" as const },
    docsButton: {
      backgroundColor: c.borderLight,
      borderRadius: 10,
      paddingVertical: 14,
      marginTop: 12,
      alignItems: "center",
      borderWidth: 1,
      borderColor: c.accentSoft,
    },
    docsText: { color: c.textMuted, fontSize: 15, fontWeight: "600" },
    exportButton: {
      backgroundColor: c.buttonSecondaryBg,
      borderRadius: 10,
      paddingVertical: 14,
      marginTop: 12,
      alignItems: "center",
    },
    exportText: { color: c.accent, fontSize: 15, fontWeight: "600" },

    // Sync
    syncStatusRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
    syncStatusDot: { width: 8, height: 8, borderRadius: 4 },
    syncStatusLabel: { fontSize: 15, fontWeight: "600" },
    syncLastTime: { color: c.textMuted, fontSize: 12, marginBottom: 8 },
    syncActionButton: {
      backgroundColor: c.buttonPrimaryBg,
      borderRadius: 10,
      paddingVertical: 14,
      marginTop: 16,
      alignItems: "center",
    },
    syncActionDisabled: { opacity: 0.5 },
    syncActionText: { color: c.buttonPrimaryText, fontSize: 15, fontWeight: "600" },
    syncDisconnectButton: {
      backgroundColor: c.buttonSecondaryBg,
      borderRadius: 10,
      paddingVertical: 14,
      marginTop: 12,
      alignItems: "center",
      borderWidth: 1,
      borderColor: `${c.statusError}40`,
    },
    syncDisconnectText: { color: c.statusWarning, fontSize: 15, fontWeight: "600" },
    syncHint: {
      color: c.textGhost,
      fontSize: 13,
      fontStyle: "italic",
      textAlign: "center",
      marginTop: 20,
    },

    // Goals
    goalEmptyText: {
      color: c.textMuted,
      fontSize: 13,
      fontStyle: "italic",
      textAlign: "center",
      marginVertical: 12,
    },
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
    goalAddBtn: {
      backgroundColor: c.buttonPrimaryBg,
      borderRadius: 10,
      paddingVertical: 14,
      marginTop: 16,
      alignItems: "center",
    },
    goalAddBtnDisabled: { opacity: 0.4 },
    goalAddBtnText: { color: c.buttonPrimaryText, fontSize: 15, fontWeight: "600" },

    // Tools
    toolsEmptyText: {
      color: c.textMuted,
      fontSize: 13,
      fontStyle: "italic",
      textAlign: "center",
      marginVertical: 12,
    },
    toolsServerRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.bgSecondary,
      borderRadius: 10,
      padding: 12,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: c.borderPrimary,
    },
    toolsServerInfo: { flex: 1, marginRight: 10 },
    toolsServerHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
    toolsStatusDot: { width: 8, height: 8, borderRadius: 4 },
    toolsServerName: { color: c.textPrimary, fontSize: 14, fontWeight: "600" },
    toolsCountBadge: {
      backgroundColor: c.borderLight,
      borderRadius: 10,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    toolsCountText: { color: c.textMuted, fontSize: 11, fontWeight: "600" },
    toolsServerUrl: {
      color: c.textMuted,
      fontSize: 12,
      fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    },
    toolsRemoveBtn: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: `${c.statusError}1a`,
      justifyContent: "center",
      alignItems: "center",
    },
    toolsRemoveText: { color: c.statusError, fontSize: 12, fontWeight: "700" },
    toolsConnectBtn: {
      backgroundColor: c.buttonPrimaryBg,
      borderRadius: 10,
      paddingVertical: 14,
      marginTop: 12,
      alignItems: "center",
    },
    toolsConnectBtnDisabled: { opacity: 0.4 },
    toolsConnectText: { color: c.buttonPrimaryText, fontSize: 15, fontWeight: "600" },
    toolsTrustBadge: {
      backgroundColor: c.borderLight,
      borderRadius: 10,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    toolsTrustText: { color: c.statusSuccess, fontSize: 10, fontWeight: "600" },
    toolsTrustRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginTop: 8,
    },
    toolsTrustLabel: { color: c.textMuted, fontSize: 12 },
    toolsNote: {
      color: c.textGhost,
      fontSize: 11,
      fontStyle: "italic",
      textAlign: "center",
      marginTop: 16,
    },
  });
}
