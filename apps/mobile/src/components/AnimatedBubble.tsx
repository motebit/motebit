import React, { useEffect, useRef } from "react";
import { Animated, type ViewStyle } from "react-native";

interface AnimatedBubbleProps {
  children: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
}

export function AnimatedBubble({ children, style }: AnimatedBubbleProps): React.ReactElement {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(6)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 250, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 250, useNativeDriver: true }),
    ]).start();
  }, [opacity, translateY]);

  return (
    <Animated.View style={[style, { opacity, transform: [{ translateY }] }]}>
      {children}
    </Animated.View>
  );
}
