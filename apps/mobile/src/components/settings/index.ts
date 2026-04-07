/**
 * Barrel for the mobile settings tab components. The main
 * `SettingsModal` (one directory up) imports everything from here so
 * new tabs only require editing the module list.
 */

export { AppearanceTab } from "./AppearanceTab";
export { IntelligenceTab } from "./IntelligenceTab";
export { GovernanceTab } from "./GovernanceTab";
export { IdentityTab } from "./IdentityTab";
export { ToolsTab } from "./ToolsTab";
export {
  TABS,
  PRESET_COLORS,
  THEME_OPTIONS,
  TTS_VOICE_OPTIONS,
  RISK_LABELS,
  PolicySummary,
  deriveInteriorColor,
  useSettingsStyles,
  createSettingsStyles,
  type Tab,
  type ThemePreference,
  type ProviderType,
  type LocalBackend,
} from "./settings-shared";
