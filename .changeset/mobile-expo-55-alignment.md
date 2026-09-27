---
"@motebit/mobile": patch
---

The mobile app bundles for iOS and Android again (#844). A dependabot bump had moved `react-native` to 0.87.0 under Expo SDK 55, which expects 0.83.10; Metro's hermes-parser could not read RN 0.87's Flow syntax, so no build could be produced. `react-native`, `react`, `react-native-svg`, `react-native-webview`, `expo-document-picker` (it had fallen to SDK 54's 14.x line) and the expo modules are back on the SDK-55 versions (`expo install --fix`). Two older bundle blockers surfaced once the parser error was gone and are fixed in `metro.config.js`: relative `./x.js` imports of TypeScript sources now resolve, and `@xenova/transformers` (which uses `import.meta`, unsupported by Hermes, and needs onnxruntime) resolves to an empty module, so memory-graph's local-embedding path falls back as it already did. `pnpm check-mobile-expo-alignment` now holds the lockfile to the SDK's table, and dependabot no longer proposes moves off the SDK line.
