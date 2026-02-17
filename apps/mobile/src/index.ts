/**
 * @motebit/mobile — Expo + React Native app
 *
 * Architecture:
 * - MotebitRuntime runs the full AI, state, memory stack locally
 * - expo-gl for Three.js rendering via ExpoGLAdapter
 * - expo-sqlite for persistent storage via ExpoSqliteAdapter
 * - expo-secure-store for keychain access via SecureStoreAdapter
 * - Background sync via sync-engine (WebSocket or HTTP fallback)
 */

export { App } from "./App";
export { createExpoStorage, ExpoGLAdapter, SecureStoreAdapter } from "./adapters";
