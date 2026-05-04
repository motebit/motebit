/**
 * Appearance tab — color preset grid, custom HSL sliders, theme toggle.
 *
 * Pure presentation component: takes the current selection + custom
 * hue/saturation as props, emits changes via callbacks. Live preview
 * of the droplet color is the caller's responsibility.
 */

import React, { useMemo } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { COLOR_PRESETS } from "../../mobile-app";
import {
  PRESET_COLORS,
  THEME_OPTIONS,
  type ThemePreference,
  deriveInteriorColor,
  useSettingsStyles,
} from "./settings-shared";

export interface AppearanceTabProps {
  selected: string;
  onSelect: (p: string) => void;
  theme: ThemePreference;
  onThemeChange: (t: ThemePreference) => void;
  customHue: number;
  customSaturation: number;
  onCustomColorChange: (hue: number, saturation: number) => void;
}

export function AppearanceTab({
  selected,
  onSelect,
  theme,
  onThemeChange,
  customHue,
  customSaturation,
  onCustomColorChange,
}: AppearanceTabProps): React.ReactElement {
  const styles = useSettingsStyles();
  const presets = Object.keys(COLOR_PRESETS);

  // Preview color for custom swatch and live circle
  const customPreview = useMemo(() => {
    const glow = deriveInteriorColor(customHue, customSaturation).glow;
    const r = Math.round(glow[0] * 255);
    const g = Math.round(glow[1] * 255);
    const b = Math.round(glow[2] * 255);
    return `rgb(${r},${g},${b})`;
  }, [customHue, customSaturation]);

  // Slider touch handler — tracks horizontal position on a View
  const handleSliderTouch = React.useCallback(
    (
      e: { nativeEvent: { locationX: number } },
      layoutWidth: number,
      onUpdate: (fraction: number) => void,
    ) => {
      if (layoutWidth <= 0) return;
      const fraction = Math.max(0, Math.min(1, e.nativeEvent.locationX / layoutWidth));
      onUpdate(fraction);
    },
    [],
  );

  const [hueWidth, setHueWidth] = React.useState(0);
  const [satWidth, setSatWidth] = React.useState(0);

  return (
    <View>
      <Text style={styles.sectionTitle}>Theme</Text>
      <View style={styles.themeToggleGroup}>
        {THEME_OPTIONS.map((opt) => (
          <TouchableOpacity
            key={opt.key}
            style={[styles.themeOption, theme === opt.key && styles.themeOptionSelected]}
            onPress={() => onThemeChange(opt.key)}
            activeOpacity={0.7}
          >
            <Text
              style={[styles.themeOptionText, theme === opt.key && styles.themeOptionTextSelected]}
            >
              {opt.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.sectionTitle}>Soul Color</Text>
      <View style={styles.presetGrid}>
        {presets.map((name) => (
          <TouchableOpacity
            key={name}
            style={[
              styles.presetCircle,
              { backgroundColor: PRESET_COLORS[name] ?? "#888" },
              selected === name && styles.presetSelected,
            ]}
            onPress={() => onSelect(name)}
            activeOpacity={0.7}
          >
            {selected === name && <View style={styles.presetCheck} />}
          </TouchableOpacity>
        ))}
        {/* Custom swatch */}
        <TouchableOpacity
          style={[
            styles.presetCircle,
            { backgroundColor: customPreview },
            selected === "custom" && styles.presetSelected,
          ]}
          onPress={() => onSelect("custom")}
          activeOpacity={0.7}
        >
          {selected === "custom" && <View style={styles.presetCheck} />}
        </TouchableOpacity>
      </View>
      <Text style={styles.presetLabel}>{selected}</Text>

      {/* Custom color sliders */}
      {selected === "custom" && (
        <View style={styles.customPickerContainer}>
          {/* Live preview circle */}
          <View style={[styles.customPreviewCircle, { backgroundColor: customPreview }]} />

          {/* Hue slider */}
          <Text style={styles.customSliderLabel}>Hue</Text>
          <View
            style={styles.customSliderTrack}
            onLayout={(e) => setHueWidth(e.nativeEvent.layout.width)}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderGrant={(e) =>
              handleSliderTouch(e, hueWidth, (f) =>
                onCustomColorChange(Math.round(f * 360), customSaturation),
              )
            }
            onResponderMove={(e) =>
              handleSliderTouch(e, hueWidth, (f) =>
                onCustomColorChange(Math.round(f * 360), customSaturation),
              )
            }
          >
            {/* Hue gradient background — multiple color stops */}
            <View
              style={[
                StyleSheet.absoluteFill,
                {
                  borderRadius: 6,
                  flexDirection: "row",
                  overflow: "hidden",
                },
              ]}
            >
              {[0, 60, 120, 180, 240, 300, 360].map((h, i, arr) => {
                if (i === arr.length - 1) return null;
                return (
                  <View
                    key={h}
                    style={{
                      flex: 1,
                      backgroundColor: `hsl(${h + 30}, 85%, 60%)`,
                    }}
                  />
                );
              })}
            </View>
            {/* Thumb */}
            <View
              style={[
                styles.customSliderThumb,
                {
                  left: `${(customHue / 360) * 100}%`,
                  backgroundColor: `hsl(${customHue}, 85%, 60%)`,
                },
              ]}
            />
          </View>

          {/* Saturation slider */}
          <Text style={styles.customSliderLabel}>Saturation</Text>
          <View
            style={[
              styles.customSliderTrack,
              {
                backgroundColor: `hsl(${customHue}, 0%, 90%)`,
              },
            ]}
            onLayout={(e) => setSatWidth(e.nativeEvent.layout.width)}
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderGrant={(e) =>
              handleSliderTouch(e, satWidth, (f) => onCustomColorChange(customHue, f))
            }
            onResponderMove={(e) =>
              handleSliderTouch(e, satWidth, (f) => onCustomColorChange(customHue, f))
            }
          >
            {/* Saturation gradient overlay */}
            <View
              style={[
                StyleSheet.absoluteFill,
                {
                  borderRadius: 6,
                  flexDirection: "row",
                  overflow: "hidden",
                },
              ]}
            >
              <View style={{ flex: 1, backgroundColor: `hsl(${customHue}, 0%, 90%)` }} />
              <View style={{ flex: 1, backgroundColor: `hsl(${customHue}, 50%, 75%)` }} />
              <View style={{ flex: 1, backgroundColor: `hsl(${customHue}, 100%, 60%)` }} />
            </View>
            {/* Thumb */}
            <View
              style={[
                styles.customSliderThumb,
                {
                  left: `${customSaturation * 100}%`,
                  backgroundColor: `hsl(${customHue}, ${Math.round(customSaturation * 100)}%, 70%)`,
                },
              ]}
            />
          </View>
        </View>
      )}
    </View>
  );
}
