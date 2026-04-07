import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: [
        "src/__tests__/**",
        "src/**/*.d.ts",
        "src/webllm-worker.ts", // web worker entry, runs in browser context
      ],
      // Floor thresholds anchored to the first measured baseline with
      // webllm-worker excluded: statements 30.09%, branches 85.96%,
      // functions 39.28%, lines 30.09%. Spatial is a WebXR AR/VR surface;
      // most uncovered code is the Three.js adapter path and the ambient
      // heartbeat / gesture recognition glue that requires a headless
      // browser with WebGL to exercise. The recent extraction split
      // spatial-app.ts into 4 sibling modules (providers, sync-controller,
      // mcp-manager, voice-commands) that ARE directly testable — raise
      // these thresholds as each gains tests.
      thresholds: { statements: 30, branches: 85, functions: 39, lines: 30 },
    },
  },
});
