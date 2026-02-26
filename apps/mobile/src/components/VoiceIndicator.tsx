/**
 * VoiceIndicator — waveform visualization displayed above the input bar
 * during voice states (ambient/voice/speaking).
 *
 * Renders a series of vertical bars whose heights track audio energy
 * with organic wave motion, colored by the creature's soul color.
 * Matches the desktop/web waveform aesthetic in a React Native context.
 */

import React, { useEffect, useRef, useMemo, useState } from "react";
import { View, Animated, StyleSheet } from "react-native";

type MicState = "off" | "ambient" | "voice" | "transcribing" | "speaking";

const BAR_COUNT = 32;

interface VoiceIndicatorProps {
  micState: MicState;
  /** Current audio energy level 0-1 (from AudioMonitor rms or TTS pulse). */
  audioLevel: number;
  /** Creature glow color [r, g, b] 0-1 from the active color preset. */
  glowColor?: [number, number, number];
}

/** State-specific intensity multipliers — voice/speaking are brighter. */
const STATE_INTENSITY: Record<MicState, number> = {
  off: 0,
  ambient: 0.5,
  voice: 1.0,
  transcribing: 0.5,
  speaking: 0.7,
};

export function VoiceIndicator({ micState, audioLevel, glowColor }: VoiceIndicatorProps): React.ReactElement | null {
  const barAnims = useRef<Animated.Value[]>(
    Array.from({ length: BAR_COUNT }, () => new Animated.Value(0)),
  ).current;
  const pulseAnim = useRef(new Animated.Value(0.3)).current;
  const pulseRef = useRef<Animated.CompositeAnimation | null>(null);
  const [tick, setTick] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Drive organic wave animation at ~30fps when active
  useEffect(() => {
    if (micState === "off") {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
      return undefined;
    }
    tickRef.current = setInterval(() => setTick((t) => t + 1), 33);
    return () => {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [micState]);

  // Update bar heights based on audio level + organic wave motion
  useEffect(() => {
    if (micState === "off") return;

    const t = tick * 0.033; // seconds
    const intensity = STATE_INTENSITY[micState];
    const gain = Math.min(audioLevel * 8, 1.5) * intensity;

    const animations = barAnims.map((anim, i) => {
      const pos = i / (BAR_COUNT - 1);
      // Edge attenuation — bars at edges are shorter
      const edge = 1 - Math.pow(2 * pos - 1, 6);
      // Organic wave motion (matches desktop's wave frequencies)
      const wave1 = Math.sin(t * 1.1 + pos * 9.3) * 0.3;
      const wave2 = Math.sin(t * 1.5 + pos * 13.1) * 0.2;
      const wave3 = Math.sin(t * 2.1 + pos * 17.4) * 0.1;
      const organic = (wave1 + wave2 + wave3) * (0.3 + gain * 0.7);
      // Final height: base idle motion + audio-driven amplitude
      const height = Math.max(0.05, (0.08 + organic + gain * 0.5) * edge);
      return Animated.timing(anim, {
        toValue: Math.min(1, height),
        duration: 33,
        useNativeDriver: false,
      });
    });
    Animated.parallel(animations).start();
  }, [tick, audioLevel, micState, barAnims]);

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

  // Derive bar color from soul color + state intensity
  const barColor = useMemo(() => {
    if (!glowColor) return "rgba(153, 163, 230, 0.6)";
    const intensity = STATE_INTENSITY[micState];
    const maxG = Math.max(glowColor[0], glowColor[1], glowColor[2], 0.01);
    const satPow = 1.3;
    const r = Math.min(255, Math.round(((glowColor[0] / maxG) ** (1 / satPow)) * glowColor[0] * 300));
    const g = Math.min(255, Math.round(((glowColor[1] / maxG) ** (1 / satPow)) * glowColor[1] * 300));
    const b = Math.min(255, Math.round(((glowColor[2] / maxG) ** (1 / satPow)) * glowColor[2] * 300));
    return `rgba(${r},${g},${b},${(0.3 + intensity * 0.5).toFixed(2)})`;
  }, [glowColor, micState]);

  if (micState === "off") return null;

  return (
    <View style={styles.container}>
      {barAnims.map((anim, i) => (
        <Animated.View
          key={i}
          style={[
            styles.bar,
            {
              backgroundColor: barColor,
              height: anim.interpolate({
                inputRange: [0, 1],
                outputRange: [1, 24],
              }),
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
    paddingHorizontal: 16,
    backgroundColor: "#0a0a0a",
    overflow: "hidden",
  },
  bar: {
    flex: 1,
    borderRadius: 1,
    maxWidth: 6,
  },
});
