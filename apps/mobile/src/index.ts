/**
 * @motebit/mobile — Expo + React Native app
 *
 * Architecture:
 * - MobileApp wraps MotebitRuntime with Expo-specific adapters
 * - expo-gl for Three.js rendering via ExpoGLAdapter
 * - expo-sqlite for persistent storage via ExpoSqliteAdapter
 * - expo-secure-store for keychain access via SecureStoreAdapter
 * - AsyncStorage for non-secret settings persistence
 */

export { App } from "./App";
export { MobileApp, COLOR_PRESETS, APPROVAL_PRESET_CONFIGS } from "./mobile-app";
export type {
  MobileSettings,
  MobileAIConfig,
  MobileBootstrapResult,
  ApprovalPresetConfig,
} from "./mobile-app";
export {
  createExpoStorage,
  ExpoSqliteConversationStore,
  ExpoGLAdapter,
  SecureStoreAdapter,
} from "./adapters";
