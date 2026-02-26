/**
 * Mobile Theme System
 *
 * Provides dark and light color palettes for all mobile UI components.
 * Components use useTheme() to get the current palette and build
 * dynamic StyleSheets via useMemo keyed on the colors.
 */

import React from "react";
import { Appearance } from "react-native";

// === Theme Colors Interface ===

export interface ThemeColors {
  // Backgrounds
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  bgGlass: string;

  // Text
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textGhost: string;

  // Chat bubbles
  userBubbleBg: string;
  userBubbleText: string;
  assistantBubbleBg: string;
  assistantBubbleText: string;
  systemText: string;

  // Borders
  borderPrimary: string;
  borderLight: string;
  borderInput: string;

  // Accent
  accent: string;
  accentSoft: string;
  accentText: string;

  // Input
  inputBg: string;
  inputText: string;
  inputPlaceholder: string;

  // Overlays
  overlayBg: string;
  overlayButtonBg: string;

  // Status
  statusSuccess: string;
  statusError: string;
  statusWarning: string;

  // Interactive
  buttonPrimaryBg: string;
  buttonPrimaryText: string;
  buttonSecondaryBg: string;
  buttonSecondaryText: string;

  // Error banner
  errorBannerBg: string;
  errorBannerBorder: string;
  errorBannerText: string;

  // Toast
  toastBg: string;
  toastBorder: string;
  toastText: string;
}

// === Dark Colors (existing hardcoded values) ===

export const DARK_COLORS: ThemeColors = {
  bgPrimary: "#0a0a0a",
  bgSecondary: "#0f1820",
  bgTertiary: "#0a1018",
  bgGlass: "rgba(15, 24, 32, 0.7)",

  textPrimary: "#c0d0e0",
  textSecondary: "#8098b0",
  textMuted: "#607080",
  textGhost: "#405060",

  userBubbleBg: "#1a2a3a",
  userBubbleText: "#c0d0e0",
  assistantBubbleBg: "#0f1820",
  assistantBubbleText: "#8098b0",
  systemText: "#405060",

  borderPrimary: "#1a2030",
  borderLight: "#1a2838",
  borderInput: "#1a2030",

  accent: "#4080c0",
  accentSoft: "#2a4060",
  accentText: "#c0d0e0",

  inputBg: "#0f1820",
  inputText: "#c0d0e0",
  inputPlaceholder: "#405060",

  overlayBg: "rgba(0,0,0,0.85)",
  overlayButtonBg: "rgba(15, 24, 32, 0.7)",

  statusSuccess: "#4ade80",
  statusError: "#c04040",
  statusWarning: "#c07040",

  buttonPrimaryBg: "#2a4060",
  buttonPrimaryText: "#c0d0e0",
  buttonSecondaryBg: "#1a2030",
  buttonSecondaryText: "#607080",

  errorBannerBg: "rgba(40, 20, 20, 0.95)",
  errorBannerBorder: "#4a2020",
  errorBannerText: "#c08080",

  toastBg: "rgba(20, 30, 40, 0.92)",
  toastBorder: "#2a4060",
  toastText: "#a0b8d0",
};

// === Light Colors (warm beige matching desktop) ===

export const LIGHT_COLORS: ThemeColors = {
  bgPrimary: "#f5f0e8",
  bgSecondary: "#ffffff",
  bgTertiary: "#ede8e0",
  bgGlass: "rgba(255, 255, 255, 0.85)",

  textPrimary: "#1a1a2e",
  textSecondary: "#3a3a5c",
  textMuted: "#6b6b8a",
  textGhost: "#9090a8",

  userBubbleBg: "#6366f1",
  userBubbleText: "#ffffff",
  assistantBubbleBg: "#ffffff",
  assistantBubbleText: "#3a3a5c",
  systemText: "#8888a0",

  borderPrimary: "#ddd8d0",
  borderLight: "#e8e3db",
  borderInput: "#d0cbc3",

  accent: "#6366f1",
  accentSoft: "#eef0ff",
  accentText: "#ffffff",

  inputBg: "#ffffff",
  inputText: "#1a1a2e",
  inputPlaceholder: "#9090a8",

  overlayBg: "rgba(0,0,0,0.5)",
  overlayButtonBg: "rgba(255, 255, 255, 0.85)",

  statusSuccess: "#22c55e",
  statusError: "#dc2626",
  statusWarning: "#d97706",

  buttonPrimaryBg: "#6366f1",
  buttonPrimaryText: "#ffffff",
  buttonSecondaryBg: "#ede8e0",
  buttonSecondaryText: "#6b6b8a",

  errorBannerBg: "rgba(220, 38, 38, 0.1)",
  errorBannerBorder: "#fca5a5",
  errorBannerText: "#dc2626",

  toastBg: "rgba(255, 255, 255, 0.95)",
  toastBorder: "#d0cbc3",
  toastText: "#3a3a5c",
};

// === Theme Resolution ===

export function resolveTheme(setting: "light" | "dark" | "system"): ThemeColors {
  if (setting === "system") {
    return (Appearance.getColorScheme() ?? "dark") === "dark" ? DARK_COLORS : LIGHT_COLORS;
  }
  return setting === "dark" ? DARK_COLORS : LIGHT_COLORS;
}

// === Context ===

export const ThemeContext = React.createContext<ThemeColors>(DARK_COLORS);

export function useTheme(): ThemeColors {
  return React.useContext(ThemeContext);
}
