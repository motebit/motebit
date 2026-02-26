import React, { useEffect, useMemo, useRef } from "react";
import { Animated, Text, StyleSheet } from "react-native";
import { useTheme, type ThemeColors } from "../theme";

interface ToastProps {
  message: string | null;
  duration?: number;
  onDismiss: () => void;
}

export function Toast({ message, duration = 3000, onDismiss }: ToastProps): React.ReactElement | null {
  const colors = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-20)).current;

  useEffect(() => {
    if (message) {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();

      const timer = setTimeout(() => {
        Animated.parallel([
          Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }),
          Animated.timing(translateY, { toValue: -20, duration: 200, useNativeDriver: true }),
        ]).start(() => onDismiss());
      }, duration);

      return () => clearTimeout(timer);
    } else {
      opacity.setValue(0);
      translateY.setValue(-20);
      return undefined;
    }
  }, [message, duration, onDismiss, opacity, translateY]);

  if (!message) return null;

  return (
    <Animated.View style={[styles.container, { opacity, transform: [{ translateY }] }]}>
      <Text style={styles.text}>{message}</Text>
    </Animated.View>
  );
}

function createStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      position: "absolute",
      top: 50,
      left: 24,
      right: 24,
      backgroundColor: c.toastBg,
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 10,
      alignItems: "center",
      zIndex: 100,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.toastBorder,
    },
    text: {
      color: c.toastText,
      fontSize: 13,
      fontWeight: "500",
      textAlign: "center",
    },
  });
}
