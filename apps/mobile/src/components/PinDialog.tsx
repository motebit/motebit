import React, { useState } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from "react-native";

export type PinMode = "setup" | "verify" | "reset";

interface PinDialogProps {
  visible: boolean;
  mode: PinMode;
  onSubmit: (pin: string) => Promise<void>;
  onCancel: () => void;
  error?: string;
}

const TITLES: Record<PinMode, string> = {
  setup: "Set Operator PIN",
  verify: "Enter Operator PIN",
  reset: "Reset Operator PIN",
};

const DESCRIPTIONS: Record<PinMode, string> = {
  setup: "Choose a 4-6 digit PIN to protect operator mode.",
  verify: "Enter your PIN to enable operator mode.",
  reset: "Enter a new 4-6 digit PIN.",
};

export function PinDialog({ visible, mode, onSubmit, onCancel, error }: PinDialogProps): React.ReactElement {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState("");

  const needsConfirm = mode === "setup" || mode === "reset";
  const validPin = /^\d{4,6}$/.test(pin);
  const canSubmit = validPin && (!needsConfirm || pin === confirm) && !loading;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    if (needsConfirm && pin !== confirm) {
      setLocalError("PINs don't match");
      return;
    }
    setLocalError("");
    setLoading(true);
    try {
      await onSubmit(pin);
      setPin("");
      setConfirm("");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setLocalError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    setPin("");
    setConfirm("");
    setLocalError("");
    onCancel();
  };

  const displayError = error || localError;

  return (
    <Modal visible={visible} animationType="fade" transparent statusBarTranslucent>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>{TITLES[mode]}</Text>
          <Text style={styles.description}>{DESCRIPTIONS[mode]}</Text>

          <TextInput
            style={styles.input}
            value={pin}
            onChangeText={setPin}
            placeholder="PIN"
            placeholderTextColor="#405060"
            keyboardType="number-pad"
            secureTextEntry
            maxLength={6}
            autoFocus
          />

          {needsConfirm && (
            <TextInput
              style={styles.input}
              value={confirm}
              onChangeText={setConfirm}
              placeholder="Confirm PIN"
              placeholderTextColor="#405060"
              keyboardType="number-pad"
              secureTextEntry
              maxLength={6}
            />
          )}

          {displayError ? <Text style={styles.error}>{displayError}</Text> : null}

          <View style={styles.buttonRow}>
            <TouchableOpacity style={styles.cancelButton} onPress={handleCancel} activeOpacity={0.7}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.submitButton, !canSubmit && styles.disabled]}
              onPress={() => void handleSubmit()}
              disabled={!canSubmit}
              activeOpacity={0.7}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#c0d0e0" />
              ) : (
                <Text style={styles.submitText}>
                  {mode === "verify" ? "Unlock" : "Set PIN"}
                </Text>
              )}
            </TouchableOpacity>
          </View>
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
    padding: 24,
    width: "100%",
    maxWidth: 320,
  },
  title: {
    color: "#c0d0e0",
    fontSize: 18,
    fontWeight: "700",
    textAlign: "center",
    marginBottom: 8,
  },
  description: {
    color: "#607080",
    fontSize: 13,
    textAlign: "center",
    marginBottom: 18,
  },
  input: {
    backgroundColor: "#0a0e14",
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    color: "#c0d0e0",
    fontSize: 20,
    textAlign: "center",
    letterSpacing: 8,
    marginBottom: 12,
  },
  error: {
    color: "#d04050",
    fontSize: 12,
    textAlign: "center",
    marginBottom: 8,
  },
  buttonRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: "#1a2030",
    alignItems: "center",
  },
  cancelText: {
    color: "#607080",
    fontSize: 15,
    fontWeight: "600",
  },
  submitButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: "#2a4060",
    alignItems: "center",
  },
  submitText: {
    color: "#c0d0e0",
    fontSize: 15,
    fontWeight: "600",
  },
  disabled: {
    opacity: 0.4,
  },
});
