import { defineMotebitTest } from "../../vitest.shared.js";

// Floor thresholds anchored to the first measured baseline with
// the React Native view layer excluded: statements 25.92%,
// branches 67.75%, functions 24.81%, lines 25.92%. Mobile is a
// React Native app — App.tsx + components/ are native views that
// don't run under jsdom. The recent extraction split mobile-app.ts
// into 8 purpose-built sibling modules (goal-scheduler,
// sync-controller, mcp-manager, pairing-manager, push-token-manager,
// plus 3 hooks) that ARE directly testable — raise these
// thresholds as each gains unit tests with mocked deps.
export default defineMotebitTest({
  testExclude: ["**/ios/**", "**/android/**"],
  coverageInclude: ["src/**/*.{ts,tsx}"],
  coverageExclude: [
    "src/App.tsx", // react-native view layer, not unit-testable in node
    "src/components/**", // react-native components, require RN test runner
  ],
  thresholds: { statements: 25, branches: 67, functions: 24, lines: 25 },
});
