import React, { useMemo } from "react";
import { Modal, View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTheme, type ThemeColors } from "../theme";

interface WelcomeOverlayProps {
  visible: boolean;
  onAccept: () => void;
  onLinkExisting?: () => void;
}

export function WelcomeOverlay({ visible, onAccept, onLinkExisting }: WelcomeOverlayProps): React.ReactElement {
  const colors = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <Modal visible={visible} animationType="fade" transparent statusBarTranslucent>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Your Motebit</Text>
          <Text style={styles.body}>
            A motebit is a sovereign AI companion. It generates a cryptographic
            identity that belongs to you — stored in your device's secure
            keychain, never on a server.
          </Text>
          <Text style={styles.body}>
            Your private key stays on this device. Your intelligence provider is
            pluggable. The body is yours.
          </Text>
          <TouchableOpacity style={styles.button} onPress={onAccept} activeOpacity={0.8}>
            <Text style={styles.buttonText}>Create My Mote</Text>
          </TouchableOpacity>
          {onLinkExisting && (
            <TouchableOpacity style={styles.linkButton} onPress={onLinkExisting} activeOpacity={0.7}>
              <Text style={styles.linkText}>I have an existing motebit</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: c.overlayBg,
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: 32,
    },
    card: {
      backgroundColor: c.bgSecondary,
      borderRadius: 20,
      padding: 28,
      width: "100%",
      maxWidth: 340,
    },
    title: {
      color: c.textPrimary,
      fontSize: 22,
      fontWeight: "700",
      textAlign: "center",
      marginBottom: 16,
    },
    body: {
      color: c.textMuted,
      fontSize: 14,
      lineHeight: 21,
      textAlign: "center",
      marginBottom: 12,
    },
    button: {
      backgroundColor: c.buttonPrimaryBg,
      borderRadius: 12,
      paddingVertical: 14,
      marginTop: 8,
      alignItems: "center",
    },
    buttonText: {
      color: c.buttonPrimaryText,
      fontSize: 16,
      fontWeight: "600",
    },
    linkButton: {
      paddingVertical: 10,
      alignItems: "center",
    },
    linkText: {
      color: c.textMuted,
      fontSize: 13,
      textDecorationLine: "underline",
    },
  });
}
