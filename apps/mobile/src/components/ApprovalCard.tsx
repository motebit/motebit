import React, { useMemo } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTheme, type ThemeColors } from "../theme";

// Mobile presentation for risk badges: fg/bg hex + user-visible short label.
// The *semantic* taxonomy lives in `@motebit/sdk`'s `RISK_LABELS` ("R0 Read"
// … "R4 Money"); this table carries the approval-card's presentation
// decisions (RN color pair + lowercase label) and is intentionally separate.
// Reconciling the two label vocabularies (lowercase "read" vs canonical
// "R0 Read") is a product UX call — out of scope for the gate-landing
// rename. The name change (RISK_LABELS → RISK_BADGES) is what stops the
// identifier from shadowing the SDK canonical.
const RISK_BADGES: Record<number, { label: string; color: string; bg: string }> = {
  0: { label: "read", color: "#60a0c0", bg: "#102030" },
  1: { label: "draft", color: "#80a060", bg: "#1a2810" },
  2: { label: "write", color: "#c0a040", bg: "#2a2010" },
  3: { label: "execute", color: "#c07040", bg: "#2a1810" },
  4: { label: "money", color: "#d04050", bg: "#2a1518" },
};

interface ApprovalCardProps {
  toolName: string;
  args: Record<string, unknown>;
  riskLevel?: number;
  onAllow: () => void;
  onDeny: () => void;
  disabled?: boolean;
}

export function ApprovalCard({
  toolName,
  args,
  riskLevel,
  onAllow,
  onDeny,
  disabled,
}: ApprovalCardProps): React.ReactElement {
  const colors = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // A tool name is not a decision. What makes a call consequential is
  // its arguments — the destination, the path, the amount — so they are
  // rendered per field rather than as a truncated JSON string. A 120-
  // character slice of `{"to":"…","amount":…}` routinely cut off before
  // the part that mattered, which made the card a prompt to trust the
  // name rather than a prompt to decide on the action.
  const argRows = useMemo(() => {
    const entries = Object.entries(args ?? {});
    return entries.map(([key, value]) => {
      const rendered =
        typeof value === "string"
          ? value
          : value === null || value === undefined
            ? String(value)
            : JSON.stringify(value);
      return {
        key,
        // Long values are elided in the MIDDLE: the head and the tail of
        // a path, an address, or a URL are what identify it, and cutting
        // only the tail hides exactly the distinguishing part.
        value:
          rendered.length > 160 ? `${rendered.slice(0, 90)} … ${rendered.slice(-50)}` : rendered,
      };
    });
  }, [args]);
  const risk = riskLevel != null ? RISK_BADGES[riskLevel] : undefined;

  return (
    <View style={styles.card}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>Tool Approval</Text>
        {risk != null && (
          <View style={[styles.riskBadge, { backgroundColor: risk.bg }]}>
            <Text style={[styles.riskText, { color: risk.color }]}>{risk.label}</Text>
          </View>
        )}
      </View>
      <Text style={styles.toolName}>{toolName}</Text>
      {argRows.length === 0 ? (
        <Text style={styles.args}>no arguments</Text>
      ) : (
        argRows.map((row) => (
          <View key={row.key} style={styles.argRow}>
            <Text style={styles.argKey}>{row.key}</Text>
            <Text style={styles.argValue} numberOfLines={4}>
              {row.value}
            </Text>
          </View>
        ))
      )}
      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.button, styles.denyButton, disabled === true && styles.disabled]}
          onPress={onDeny}
          disabled={disabled}
          activeOpacity={0.7}
        >
          <Text style={styles.denyText}>Deny</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, styles.allowButton, disabled === true && styles.disabled]}
          onPress={onAllow}
          disabled={disabled}
          activeOpacity={0.7}
        >
          <Text style={styles.allowText}>Allow</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    card: {
      backgroundColor: c.bgSecondary,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.accentSoft,
      padding: 14,
      marginVertical: 4,
      maxWidth: "90%",
      alignSelf: "flex-start",
    },
    argRow: {
      flexDirection: "row",
      gap: 8,
      marginTop: 4,
    },
    argKey: {
      color: c.textMuted,
      fontSize: 12,
      fontFamily: "Menlo",
      minWidth: 72,
    },
    argValue: {
      color: c.textSecondary,
      fontSize: 12,
      fontFamily: "Menlo",
      flexShrink: 1,
    },
    labelRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginBottom: 6,
    },
    label: {
      color: c.textMuted,
      fontSize: 11,
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    riskBadge: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: 4,
    },
    riskText: {
      fontSize: 10,
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: 0.3,
    },
    toolName: {
      color: c.textSecondary,
      fontSize: 15,
      fontWeight: "600",
      marginBottom: 4,
    },
    args: {
      color: c.textGhost,
      fontSize: 12,
      fontFamily: "monospace",
      marginBottom: 10,
    },
    buttonRow: {
      flexDirection: "row",
      gap: 10,
    },
    button: {
      flex: 1,
      paddingVertical: 10,
      borderRadius: 8,
      alignItems: "center",
    },
    denyButton: {
      backgroundColor: `${c.statusError}1a`,
    },
    allowButton: {
      backgroundColor: `${c.statusSuccess}1a`,
    },
    denyText: {
      color: c.statusError,
      fontSize: 14,
      fontWeight: "600",
    },
    allowText: {
      color: c.statusSuccess,
      fontSize: 14,
      fontWeight: "600",
    },
    disabled: {
      opacity: 0.4,
    },
  });
}
