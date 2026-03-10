import React, { useMemo } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTheme, type ThemeColors } from "../theme";

interface BannerProps {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
}

export function Banner({
  message,
  actionLabel,
  onAction,
  onDismiss,
}: BannerProps): React.ReactElement {
  const colors = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <View style={styles.container}>
      <Text style={styles.message} numberOfLines={2}>
        {message}
      </Text>
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

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: c.errorBannerBg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.errorBannerBorder,
      paddingHorizontal: 14,
      paddingVertical: 10,
      gap: 10,
    },
    message: {
      flex: 1,
      color: c.errorBannerText,
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
      backgroundColor: c.buttonPrimaryBg,
      borderRadius: 6,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    actionText: {
      color: c.buttonPrimaryText,
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
      color: c.textMuted,
      fontSize: 12,
    },
  });
}
