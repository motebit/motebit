/**
 * VoiceIndicator — ambient amplitude bar displayed above the input bar
 * during voice states (ambient/voice/speaking).
 *
 * Shows a pulsing horizontal bar whose width tracks the current audio
 * energy level, color-coded by mic state:
 *   - ambient: green-tinted (listening)
 *   - voice: red-tinted (recording)
 *   - speaking: blue-tinted (TTS playback)
 *   - transcribing: pulsing neutral (processing)
 */

import React, { useEffect, useRef } from "react";
import { View, Animated, StyleSheet } from "react-native";

type MicState = "off" | "ambient" | "voice" | "transcribing" | "speaking";

interface VoiceIndicatorProps {
  micState: MicState;
  /** Current audio energy level 0-1 (from AudioMonitor rms or TTS pulse). */
  audioLevel: number;
}

const STATE_COLORS: Record<MicState, string> = {
  off: "transparent",
  ambient: "#2a5040",
  voice: "#8a3030",
  transcribing: "#405060",
  speaking: "#3040708a",
};

export function VoiceIndicator({ micState, audioLevel }: VoiceIndicatorProps): React.ReactElement | null {
  const widthAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(0.3)).current;
  const pulseRef = useRef<Animated.CompositeAnimation | null>(null);

  // Animate width to track audio level
  useEffect(() => {
    Animated.timing(widthAnim, {
      toValue: Math.min(1, audioLevel * 8), // Scale up for visibility
      duration: 50,
      useNativeDriver: false,
    }).start();
  }, [audioLevel, widthAnim]);

  // Pulse animation during transcribing
  useEffect(() => {
    if (micState === "transcribing") {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 0.8, duration: 600, useNativeDriver: false }),
          Animated.timing(pulseAnim, { toValue: 0.3, duration: 600, useNativeDriver: false }),
        ]),
      );
      pulseRef.current = pulse;
      pulse.start();
    } else {
      pulseRef.current?.stop();
      pulseAnim.setValue(0.3);
    }
    return () => { pulseRef.current?.stop(); };
  }, [micState, pulseAnim]);

  if (micState === "off") return null;

  const barColor = STATE_COLORS[micState];
  const barWidth = micState === "transcribing"
    ? pulseAnim.interpolate({ inputRange: [0, 1], outputRange: ["30%", "100%"] })
    : widthAnim.interpolate({ inputRange: [0, 1], outputRange: ["5%", "100%"] });

  return (
    <View style={styles.container}>
      <Animated.View
        style={[
          styles.bar,
          {
            backgroundColor: barColor,
            width: barWidth,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 3,
    backgroundColor: "#0a0a0a",
    overflow: "hidden",
  },
  bar: {
    height: 3,
    borderRadius: 1.5,
    alignSelf: "center",
  },
});
