import { defineMotebitTest } from "../../vitest.shared.js";

export default defineMotebitTest({
  extra: { setupFiles: ["./src/__tests__/setup.ts"] },
  thresholds: { statements: 70, branches: 60, functions: 65, lines: 70 },
});
