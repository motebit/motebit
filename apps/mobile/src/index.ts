/**
 * @motebit/mobile — Expo + React Native app
 *
 * Architecture:
 * - expo-gl for Three.js rendering
 * - expo-sqlite for local event log + memory storage
 * - expo-secure-store for identity persistence (keychain)
 * - Background sync via expo-background-fetch
 */

export { App } from "./App";
