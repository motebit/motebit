import React from "react";
import { Modal, View, Text, TouchableOpacity, StyleSheet } from "react-native";

interface WelcomeOverlayProps {
  visible: boolean;
  onAccept: () => void;
  onLinkExisting?: () => void;
}

export function WelcomeOverlay({ visible, onAccept, onLinkExisting }: WelcomeOverlayProps): React.ReactElement {
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

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.85)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 32,
  },
  card: {
    backgroundColor: "#0f1820",
    borderRadius: 20,
    padding: 28,
    width: "100%",
    maxWidth: 340,
  },
  title: {
    color: "#c0d0e0",
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 16,
  },
  body: {
    color: "#607080",
    fontSize: 14,
    lineHeight: 21,
    textAlign: "center",
    marginBottom: 12,
  },
  button: {
    backgroundColor: "#2a4060",
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 8,
    alignItems: "center",
  },
  buttonText: {
    color: "#c0d0e0",
    fontSize: 16,
    fontWeight: "600",
  },
  linkButton: {
    paddingVertical: 10,
    alignItems: "center",
  },
  linkText: {
    color: "#506070",
    fontSize: 13,
    textDecorationLine: "underline",
  },
});
