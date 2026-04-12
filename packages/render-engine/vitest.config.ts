import { defineMotebitTest } from "../../vitest.shared.js";

// Floor thresholds anchored to the first measured baseline
// (statements 29.21%, branches 46.60%, functions 68.18%, lines 29.21%).
// render-engine is the Three.js / WebGL / WebXR adapter layer — most
// uncovered code is GPU-side material / mesh construction that
// requires a real (or mocked) WebGL context to exercise. The pure
// geometry + behavior-mapping logic IS covered by the existing unit
// tests. Raising the floor requires either a jsdom+gl-shim or a
// headless-browser test runner.
export default defineMotebitTest({
  thresholds: { statements: 29, branches: 46, functions: 68, lines: 29 },
});
