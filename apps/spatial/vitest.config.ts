import { defineMotebitTest } from "../../vitest.shared.js";

// Spatial is a WebXR AR/VR surface. The sibling modules (providers,
// sync-controller, mcp-manager, voice-commands) are fully testable in
// node and covered ≥90%. Files excluded below are browser-only: they
// construct WebXRThreeJSAdapter, bind DOM elements, or drive WebGL /
// gesture-recognition pipelines that require a headless browser with
// WebGL. Their small non-browser surface (color utilities) is exercised
// via color-utils.test.ts.
export default defineMotebitTest({
  coverageExclude: [
    "src/webllm-worker.ts", // web worker entry, runs in browser context
    "src/app.ts", // DOM entry point: binds canvas, buttons, WebXR session
    "src/spatial-app.ts", // SpatialApp kernel: constructs WebXRThreeJSAdapter at class construction
  ],
  // Floor thresholds anchored to the first post-extraction measured
  // baseline (sibling modules all ≥90%, aggregate above 85% statements).
  // Branch threshold is pulled down only because the residual voice
  // pipeline + encrypted-keystore paths are defensive fallbacks.
  thresholds: { statements: 85, branches: 88, functions: 82, lines: 85 },
  // The spatial HUD test exercises a tiny DOM binding; vitest-environment
  // defaults to node, so scope jsdom per-file with the /** @vitest-environment jsdom */
  // directive in those tests. No global environment switch — keep the
  // non-DOM modules fast.
  extra: {
    environmentMatchGlobs: [["src/__tests__/hud.test.ts", "jsdom"]],
  },
});
