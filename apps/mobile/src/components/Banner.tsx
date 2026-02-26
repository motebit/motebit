import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";

interface BannerProps {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
}

export function Banner({ message, actionLabel, onAction, onDismiss }: BannerProps): React.ReactElement {
  return (
    <View style={styles.container}>
      <Text style={styles.message} numberOfLines={2}>{message}</Text>
      <View style={styles.actions}>
        {actionLabel != null && onAction != null && (
          <TouchableOpacity style={styles.actionButton} onPress={onAction} activeOpacity={0.7}>
            <Text style={styles.actionText}>{actionLabel}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.dismissButton} onPress={onDismiss} activeOpacity={0.7}>
          <Text style={styles.dismissText}>{"\u2715"}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(40, 20, 20, 0.95)",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#4a2020",
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 10,
  },
  message: {
    flex: 1,
    color: "#c08080",
    fontSize: 13,
    fontWeight: "500",
    lineHeight: 18,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  actionButton: {
    backgroundColor: "#2a4060",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  actionText: {
    color: "#a0b8d0",
    fontSize: 12,
    fontWeight: "600",
  },
  dismissButton: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.05)",
    justifyContent: "center",
    alignItems: "center",
  },
  dismissText: {
    color: "#607080",
    fontSize: 12,
  },
});
