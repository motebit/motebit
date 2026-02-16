import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import type { MotebitState } from "@motebit/sdk";
import { TrustMode, BatteryMode } from "@motebit/sdk";

const DEFAULT_STATE: MotebitState = {
  attention: 0,
  processing: 0,
  confidence: 0.5,
  affect_valence: 0,
  affect_arousal: 0,
  social_distance: 0.5,
  curiosity: 0,
  trust_mode: TrustMode.Guarded,
  battery_mode: BatteryMode.Normal,
};

export function App(): React.ReactElement {
  const [state, setState] = useState<MotebitState>(DEFAULT_STATE);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    // Initialize:
    // 1. Load identity from SecureStore (keychain)
    // 2. Open SQLite database
    // 3. Start StateVectorEngine
    // 4. Start BehaviorEngine
    // 5. Initialize Three.js renderer via expo-gl
    // 6. Start background sync
    setInitialized(true);
  }, []);

  if (!initialized) {
    return (
      <View style={styles.container}>
        <Text style={styles.text}>Initializing Motebit...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.text}>Motebit</Text>
      <Text style={styles.subtext}>
        attention: {state.attention.toFixed(2)} | confidence: {state.confidence.toFixed(2)}
      </Text>
      {/* In production: GLView for Three.js rendering */}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#0a0a0a",
  },
  text: {
    color: "#e0e8f0",
    fontSize: 24,
    fontWeight: "300",
  },
  subtext: {
    color: "#607080",
    fontSize: 12,
    marginTop: 8,
    fontFamily: "monospace",
  },
});
