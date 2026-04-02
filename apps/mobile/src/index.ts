/**
 * @motebit/mobile — Expo + React Native app
 *
 * Architecture:
 * - MobileApp wraps MotebitRuntime with Expo-specific adapters
 * - WebView for Three.js rendering via WebViewGLAdapter (full WebGL2)
 * - expo-sqlite for persistent storage
 * - expo-secure-store for keychain access via SecureStoreAdapter
 * - AsyncStorage for non-secret settings persistence
 */

export { default as App } from "./App";
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
  WebViewGLAdapter,
  SecureStoreAdapter,
} from "./adapters";
