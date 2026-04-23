import { defineMotebitTest } from "../../vitest.shared.js";

// Mobile is a React Native + Expo app. Two families of files are
// unit-testable in node (and covered here); the rest are excluded
// honestly because they need a React runtime or an iOS-native module.
//
// Covered sibling modules (all at ≥58% each, most ≥90%):
//   goal-scheduler        — 60%+ (approval suspension paths are async)
//   sync-controller       — 34%+ (internal syncCycle is one giant async)
//   mcp-manager           — 97%
//   pairing-manager       — 100%
//   push-token-manager    — 100%
//   slash-commands        — 90%
//   storage-keys          — 100%
//   theme                 — 100%
//   creature-webview      — 100% (HTML template constant)
//   mobile-app            — 42% (constructor + settings paths + guards)
//
// Excluded (honestly cannot run under node/vitest):
//   src/App.tsx           — React Native view tree
//   src/components/**     — React Native components
//   src/index.ts          — registerRootComponent entrypoint
//   src/use-*.ts          — React hooks (useState/useRef/useCallback),
//                           need React render runtime (no testing-library
//                           installed). Spatial's hook-equivalents were
//                           likewise excluded — hooks are the UI seam.
//   src/adapters/index.ts — trivial re-exports only
//   src/adapters/local-inference.ts — iOS-native module wrapper
//                           (`modules/expo-local-inference` has no JS side)
//   src/adapters/expo-sqlite.ts — 2500-line SQLite adapter with full
//                           schema migration; covered only through the
//                           mobile-app.ts bootstrap path in the existing
//                           mobile-app.test.ts. Covering every store
//                           method would require a full in-memory SQLite
//                           harness with the schema re-declared here.
//
// Floor thresholds set to the measured aggregate floor.
export default defineMotebitTest({
  testExclude: ["**/ios/**", "**/android/**"],
  coverageInclude: ["src/**/*.{ts,tsx}"],
  // SDK 55's expo-modules-core source eagerly references the React
  // Native `__DEV__` global. Vite runs in node; define the global
  // here so transitive imports (when a mock gap lets a real module
  // load) evaluate cleanly.
  vite: { define: { __DEV__: "false" } },
  coverageExclude: [
    "src/App.tsx", // react-native view layer, not unit-testable in node
    "src/components/**", // react-native components, require RN test runner
    "src/index.ts", // registerRootComponent entrypoint
    "src/use-chat-stream.ts", // React hook — needs React render runtime
    "src/use-pairing.ts", // React hook — needs React render runtime
    "src/use-voice.ts", // React hook — needs React render runtime
    "src/adapters/index.ts", // barrel re-export
    "src/adapters/local-inference.ts", // iOS-native module wrapper (modules/expo-local-inference)
    "src/adapters/expo-sqlite.ts", // 2500-line SQLite adapter; partial coverage via mobile-app.test.ts bootstrap
  ],
  thresholds: { statements: 65, branches: 80, functions: 65, lines: 65 },
});
