import { defineMotebitTest } from "../../vitest.shared.js";

// Floor thresholds anchored to the 2026-04-12 baseline after adapter-mock
// tests landed: statements 78.60%, branches 73.33%, functions 87.65%,
// lines 78.60%.
//
// creature.ts and artifacts.ts are now fully covered — Three.js CPU-side
// objects (Scene/Group/Mesh/Material) run in Node, and the two
// WebGL-bound primitives (PMREMGenerator, CSS2DRenderer) are mocked at
// the module boundary. The whole animation pipeline, blink state
// machine, environment presets, artifact lifecycle, and FIFO eviction
// are exercised end-to-end.
//
// The residual uncovered surface is ThreeJSAdapter.init/dispose and
// WebXRThreeJSAdapter.init/dispose — the code paths that construct
// `new THREE.WebGLRenderer({ canvas })`, request an XR session, and
// drive OrbitControls. These require a live WebGL context (or a full
// GL shim like jsdom + gl-shim + WebXR polyfill) to exercise honestly;
// mocking THREE.WebGLRenderer at this depth produces tautological tests
// that pass but verify nothing. Those paths remain covered by the
// existing headless lifecycle tests (`init(null)` → render → dispose),
// which exercise every non-WebGL method on each adapter.
export default defineMotebitTest({
  thresholds: { statements: 78, branches: 73, functions: 87, lines: 78 },
});
