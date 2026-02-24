import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";

const RISK_LABELS: Record<number, { label: string; color: string; bg: string }> = {
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

export function ApprovalCard({ toolName, args, riskLevel, onAllow, onDeny, disabled }: ApprovalCardProps): React.ReactElement {
  const argsPreview = JSON.stringify(args).slice(0, 120);
  const risk = riskLevel != null ? RISK_LABELS[riskLevel] : undefined;

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
      <Text style={styles.args} numberOfLines={2}>{argsPreview}</Text>
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

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#111a24",
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#2a4060",
    padding: 14,
    marginVertical: 4,
    maxWidth: "90%",
    alignSelf: "flex-start",
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
  },
  label: {
    color: "#506070",
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
    color: "#8098b0",
    fontSize: 15,
    fontWeight: "600",
    marginBottom: 4,
  },
  args: {
    color: "#405060",
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
    backgroundColor: "#2a1518",
  },
  allowButton: {
    backgroundColor: "#142a1a",
  },
  denyText: {
    color: "#d04050",
    fontSize: 14,
    fontWeight: "600",
  },
  allowText: {
    color: "#40b060",
    fontSize: 14,
    fontWeight: "600",
  },
  disabled: {
    opacity: 0.4,
  },
});
