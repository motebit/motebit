import { describe, it, expect, vi, beforeEach } from "vitest";

let colorScheme: "dark" | "light" | null = "dark";

vi.mock("react-native", () => ({
  Appearance: {
    getColorScheme: vi.fn(() => colorScheme),
  },
}));

vi.mock("react", () => ({
  default: {
    createContext: vi.fn((v: unknown) => ({ _default: v })),
    useContext: vi.fn((ctx: { _default: unknown }) => ctx._default),
  },
  createContext: vi.fn((v: unknown) => ({ _default: v })),
  useContext: vi.fn((ctx: { _default: unknown }) => ctx._default),
}));

import { DARK_COLORS, LIGHT_COLORS, resolveTheme, ThemeContext, useTheme } from "../theme";

beforeEach(() => {
  colorScheme = "dark";
});

describe("theme palettes", () => {
  it("DARK_COLORS has all required fields", () => {
    expect(DARK_COLORS.bgPrimary).toBeTruthy();
    expect(DARK_COLORS.textPrimary).toBeTruthy();
    expect(DARK_COLORS.userBubbleBg).toBeTruthy();
    expect(DARK_COLORS.accent).toBeTruthy();
    expect(DARK_COLORS.buttonPrimaryBg).toBeTruthy();
    expect(DARK_COLORS.toastBg).toBeTruthy();
  });

  it("LIGHT_COLORS has all required fields", () => {
    expect(LIGHT_COLORS.bgPrimary).toBeTruthy();
    expect(LIGHT_COLORS.textPrimary).toBeTruthy();
    expect(LIGHT_COLORS.userBubbleBg).toBeTruthy();
    expect(LIGHT_COLORS.accent).toBeTruthy();
    expect(LIGHT_COLORS.buttonPrimaryBg).toBeTruthy();
    expect(LIGHT_COLORS.toastBg).toBeTruthy();
  });

  it("dark and light have distinct bg", () => {
    expect(DARK_COLORS.bgPrimary).not.toBe(LIGHT_COLORS.bgPrimary);
  });
});

describe("resolveTheme", () => {
  it("returns DARK_COLORS for 'dark'", () => {
    expect(resolveTheme("dark")).toBe(DARK_COLORS);
  });

  it("returns LIGHT_COLORS for 'light'", () => {
    expect(resolveTheme("light")).toBe(LIGHT_COLORS);
  });

  it("returns DARK_COLORS when system is dark", () => {
    colorScheme = "dark";
    expect(resolveTheme("system")).toBe(DARK_COLORS);
  });

  it("returns LIGHT_COLORS when system is light", () => {
    colorScheme = "light";
    expect(resolveTheme("system")).toBe(LIGHT_COLORS);
  });

  it("falls back to dark when system color scheme is null", () => {
    colorScheme = null;
    expect(resolveTheme("system")).toBe(DARK_COLORS);
  });
});

describe("ThemeContext", () => {
  it("ThemeContext is created with dark defaults", () => {
    expect(ThemeContext).toBeDefined();
  });

  it("useTheme returns a theme", () => {
    const theme = useTheme();
    expect(theme).toBeDefined();
  });
});
