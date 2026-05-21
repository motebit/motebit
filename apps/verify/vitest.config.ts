import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  // main.ts is DOM wiring and render.ts builds DOM nodes — both are exercised
  // in the browser, not unit-tested. The display LOGIC lives in labels.ts and
  // the verification LOGIC lives in @motebit/state-export-client (both tested).
  coverageExclude: ["src/main.ts", "src/render.ts"],
  thresholds: { statements: 70, branches: 60, functions: 65, lines: 70 },
});
